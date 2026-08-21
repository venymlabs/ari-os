import {
  ModelRouter,
  OpenAICompatibleTransport,
  type ModelCandidate,
  type ModelRequest as RouterRequest,
} from "../agent/models/index.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelRequest,
  ToolCall,
  ToolDispatcher,
  ToolDispatchResult,
} from "../agent/runtime/index.js";
import type { Capability } from "../agent/types.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import type { LlmConfig } from "../config/index.js";
export class RegistryDispatcher implements ToolDispatcher {
  constructor(
    private registry: ToolRegistry,
    private capabilities: readonly Capability[],
  ) {}
  classify(name: string) {
    const x = this.registry.classify(name);
    if (x.effect === "read") return { effect: "read" as const };
    if (x.effect === "trade") return { effect: "proposal" as const };
    return { effect: "write" as const };
  }
  async dispatch(
    call: ToolCall,
    ctx: { signal: AbortSignal },
  ): Promise<ToolDispatchResult> {
    const r = await this.registry.invoke(call.name, call.arguments, {
      capabilities: this.capabilities,
      invocationId: call.id,
      signal: ctx.signal,
    });
    if (r.ok)
      return { ok: true, toolCallId: call.id, name: call.name, data: r.data };
    return {
      ok: false,
      toolCallId: call.id,
      name: call.name,
      error: (r as Extract<typeof r, { ok: false }>).error,
    };
  }
}
export class ModelRouterProvider implements ModelProvider {
  readonly id: string;
  constructor(
    private router: Pick<ModelRouter, "complete">,
    private registry: ToolRegistry,
    private options: {
      capabilities: readonly Capability[];
      /**
       * What health and the operator console call this planner. Defaults to the
       * generic router name; a provider built from configuration names the
       * endpoint instead, so "which model is actually answering" is a readable
       * fact rather than an inference.
       */
      id?: string;
      /**
       * Ceiling on a single completion. Worth setting for a small self-hosted
       * model, where an unbounded reply is how a 4096-token window is spent on
       * one answer.
       */
      maxOutputTokens?: number;
    },
  ) {
    this.id = options.id ?? "model-router";
  }
  async complete(request: ModelRequest, signal: AbortSignal) {
    const messages = request.messages.map(toRouterMessage);
    const tools = this.registry
      .schemas({ capabilities: this.options.capabilities })
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    const r = await this.router.complete({
      messages,
      tools,
      signal,
      ...(this.options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: this.options.maxOutputTokens }),
    } as RouterRequest);
    return {
      message: {
        role: "assistant" as const,
        content: r.content,
        ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
      },
      usage: {
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      },
    };
  }
}
function toRouterMessage(m: AgentMessage) {
  return { ...m } as any;
}

/** The transport key the configured endpoint is registered under. */
const LLM_TRANSPORT = "openai-compatible";

/** How a configured endpoint is named in health, routing and the console. */
export function llmProviderId(llm: LlmConfig): string {
  return `${llm.provider}:${llm.model}`;
}

/**
 * Build the agent's model provider from configuration.
 *
 * One endpoint becomes one {@link ModelCandidate}, so the router's existing
 * behaviour is preserved rather than bypassed: the context/output check, the
 * cost ordering, the rate-limit health tracker and the fallback loop all still
 * run — over a list of one, which is what a self-hosted deployment has.
 *
 * The API key never leaves its {@link import("../kernel/secret.js").Secret}
 * except inside `resolve()`, which the transport calls per request and whose
 * result it puts straight into an `Authorization` header. Nothing here holds
 * the revealed string. When there is no key — the keyless local server — no
 * credential is passed and the transport sends no `Authorization` header at
 * all, rather than an empty bearer token a server could reject.
 *
 * `supportedTools` is the registry's tool set at composition time, which is
 * when every built-in, trading and venue tool has been registered. An
 * OpenAI-compatible endpoint with function calling supports whatever schema it
 * is handed, so this is a completeness statement about the registry rather
 * than a claim about the model — the router has no way to say "all". A tool
 * registered after composition is therefore outside the snapshot and routing
 * refuses the turn by name, which is visible rather than silently offering the
 * model a tool this candidate never declared.
 */
export function createModelProvider(
  llm: LlmConfig,
  registry: ToolRegistry,
  options: {
    capabilities: readonly Capability[];
    fetch?: typeof globalThis.fetch;
  },
): ModelProvider {
  const apiKey = llm.apiKey;
  const transport = new OpenAICompatibleTransport({
    baseUrl: llm.baseUrl,
    fetch: options.fetch ?? globalThis.fetch,
    ...(apiKey
      ? {
          credential: {
            id: llmProviderId(llm),
            resolve: async () => apiKey.reveal(),
          },
        }
      : {}),
    ...(llm.extraBody ? { extraBody: llm.extraBody } : {}),
  });
  const candidate: ModelCandidate = {
    id: llmProviderId(llm),
    provider: llm.provider,
    model: llm.model,
    transport: LLM_TRANSPORT,
    contextWindow: llm.contextWindow,
    supportedTools: registry
      .schemas({ capabilities: options.capabilities })
      .map((t) => t.name),
    inputCostPerMillion: llm.inputCostPerMillion,
    outputCostPerMillion: llm.outputCostPerMillion,
  };
  return new ModelRouterProvider(
    new ModelRouter([candidate], { [LLM_TRANSPORT]: transport }),
    registry,
    {
      id: llmProviderId(llm),
      capabilities: options.capabilities,
      maxOutputTokens: llm.maxOutputTokens,
    },
  );
}
