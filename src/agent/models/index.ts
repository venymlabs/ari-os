import { z } from "zod";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}
export interface ModelTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface ModelRequest {
  messages: readonly ModelMessage[];
  model?: string;
  tools?: readonly ModelTool[];
  requiredTools?: readonly string[];
  contextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface ModelResponse {
  id: string;
  provider: string;
  model: string;
  content: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  usage: ModelUsage;
}
export interface ModelTransport {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export interface CredentialReference {
  readonly id: string;
  resolve(): Promise<string>;
}
export interface ModelCandidate {
  id: string;
  provider: string;
  model: string;
  transport: string;
  contextWindow: number;
  supportedTools: readonly string[];
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export class RateLimitHealthTracker {
  private readonly blockedUntil = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  recordRateLimit(id: string, retryAt: number): void {
    this.blockedUntil.set(id, retryAt);
  }
  recordSuccess(id: string): void {
    this.blockedUntil.delete(id);
  }
  isHealthy(id: string): boolean {
    return (this.blockedUntil.get(id) ?? 0) <= this.now();
  }
}

export interface ErrorClassification {
  retryable: boolean;
  fallback: boolean;
  rateLimited: boolean;
}
function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
export function classifyModelError(error: unknown): ErrorClassification {
  if (isAbort(error))
    return { retryable: false, fallback: false, rateLimited: false };
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  if (status === 429)
    return { retryable: true, fallback: true, rateLimited: true };
  if (status !== undefined && ([408, 425].includes(status) || status >= 500))
    return { retryable: true, fallback: true, rateLimited: false };
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return { retryable: false, fallback: true, rateLimited: false };
  if (error instanceof TypeError)
    return { retryable: true, fallback: true, rateLimited: false };
  return { retryable: false, fallback: false, rateLimited: false };
}

interface RouterOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
}
export class ModelRouter {
  private readonly health: RateLimitHealthTracker;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly now: () => number;
  constructor(
    private readonly candidates: readonly ModelCandidate[],
    private readonly transports: Readonly<Record<string, ModelTransport>>,
    health?: RateLimitHealthTracker,
    options: RouterOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 0;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0)
      throw new Error("maxRetries must be a non-negative integer");
    const ids = new Set<string>();
    for (const candidate of candidates) {
      if (ids.has(candidate.id))
        throw new Error(`Duplicate model candidate ID: ${candidate.id}`);
      ids.add(candidate.id);
      if (
        !Number.isFinite(candidate.contextWindow) ||
        candidate.contextWindow <= 0
      )
        throw new Error(`Invalid context window for ${candidate.id}`);
      if (
        ![candidate.inputCostPerMillion, candidate.outputCostPerMillion].every(
          (v) => Number.isFinite(v) && v >= 0,
        )
      )
        throw new Error(`Invalid cost for ${candidate.id}`);
    }
    this.now = options.now ?? Date.now;
    this.health = health ?? new RateLimitHealthTracker(this.now);
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = options.jitter ?? Math.random;
  }
  eligible(request: ModelRequest): ModelCandidate[] {
    const tools =
      request.requiredTools ?? request.tools?.map((tool) => tool.name) ?? [];
    const input = request.contextTokens ?? 0,
      output = request.maxOutputTokens ?? 0;
    return this.candidates
      .filter(
        (candidate) =>
          candidate.contextWindow >= input + output &&
          tools.every((tool) => candidate.supportedTools.includes(tool)) &&
          this.health.isHealthy(candidate.id),
      )
      .sort(
        (a, b) =>
          a.inputCostPerMillion * input +
          a.outputCostPerMillion * output -
          (b.inputCostPerMillion * input + b.outputCostPerMillion * output),
      );
  }
  route(request: ModelRequest): ModelCandidate {
    const selected = this.eligible(request)[0];
    if (!selected)
      throw new Error(
        "No healthy model satisfies required tools and context/output requirements",
      );
    return selected;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw abortError(request.signal.reason);
    let lastError: unknown;
    for (const candidate of this.eligible(request)) {
      const transport = this.transports[candidate.transport];
      if (!transport) {
        lastError = new Error(
          `Model transport '${candidate.transport}' for '${candidate.id}' is not configured`,
        );
        continue;
      }
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (request.signal?.aborted) throw abortError(request.signal.reason);
        try {
          const response = await transport.complete({
            ...request,
            model: candidate.model,
          });
          this.health.recordSuccess(candidate.id);
          return {
            ...response,
            provider: candidate.provider,
            model: candidate.model,
          };
        } catch (error) {
          if (isAbort(error) || request.signal?.aborted) throw error;
          lastError = error;
          const classification = classifyModelError(error);
          if (classification.rateLimited) {
            const delay =
              error instanceof ModelHttpError &&
              error.retryAfterMs !== undefined
                ? error.retryAfterMs
                : 60_000;
            this.health.recordRateLimit(
              candidate.id,
              this.now() + Math.max(0, delay),
            );
            break;
          }
          if (!classification.retryable || attempt === this.maxRetries) break;
          await this.sleep(
            250 * 2 ** attempt + Math.floor(this.jitter() * 100),
          );
        }
      }
      if (!classifyModelError(lastError).fallback) throw lastError;
    }
    throw (
      lastError ?? new Error("No healthy model or model transport available")
    );
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
export class ModelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}
export interface OpenAICompatibleOptions {
  baseUrl: string;
  credential?: CredentialReference;
  fetch: typeof globalThis.fetch;
  defaultHeaders?: Readonly<Record<string, string>>;
  now?: () => number;
}

const responseSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        id: z.string().min(1),
                        type: z.literal("function"),
                        function: z
                          .object({
                            name: z.string().min(1),
                            arguments: z.string(),
                          })
                          .strict(),
                      })
                      .strict(),
                  )
                  .optional(),
              })
              .strict(),
            finish_reason: z.string(),
          })
          .strict(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .passthrough();

export class OpenAICompatibleTransport implements ModelTransport {
  constructor(private readonly options: OpenAICompatibleOptions) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.model) throw new Error("Model is required");
    if (request.signal?.aborted) throw abortError(request.signal.reason);
    const token = await this.options.credential?.resolve();
    if (request.signal?.aborted) throw abortError(request.signal.reason);
    const headers: Record<string, string> = { ...this.options.defaultHeaders };
    for (const key of Object.keys(headers))
      if (
        key.toLowerCase() === "content-type" ||
        key.toLowerCase() === "authorization"
      )
        delete headers[key];
    headers["content-type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const messages = request.messages.map(serializeMessage);
    const body = {
      model: request.model,
      messages,
      ...(request.tools
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.requiredTools?.length ? { tool_choice: "required" } : {}),
      ...(request.maxOutputTokens !== undefined
        ? { max_tokens: request.maxOutputTokens }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      stream: false,
    };
    const response = await this.options.fetch(
      `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    if (!response.ok)
      throw new ModelHttpError(
        sanitizeError(await response.text()),
        response.status,
        parseRetryAfter(
          response.headers.get("retry-after"),
          this.options.now?.() ?? Date.now(),
        ),
      );
    const data = responseSchema.parse(await response.json());
    const choice = data.choices[0]!;
    const seen = new Set<string>();
    const toolCalls = (choice.message.tool_calls ?? []).map((call) => {
      if (seen.has(call.id))
        throw new SyntaxError(`Duplicate tool call ID: ${call.id}`);
      seen.add(call.id);
      return {
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      };
    });
    return {
      id: data.id,
      provider: "openai-compatible",
      model: data.model,
      content: choice.message.content ?? "",
      toolCalls,
      finishReason: choice.finish_reason,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
    };
  }
}
function serializeMessage(message: ModelMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.name) base.name = message.name;
  if (message.role === "tool") {
    if (!message.toolCallId)
      throw new Error("Tool message requires toolCallId");
    base.tool_call_id = message.toolCallId;
  }
  if (message.role === "assistant" && message.toolCalls?.length)
    base.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  return base;
}
function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SyntaxError("Invalid tool call arguments JSON");
  }
}
function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
function sanitizeError(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1024);
}
