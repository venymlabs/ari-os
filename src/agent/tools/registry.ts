import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Capability, InvocationContext, ToolAuditEvent, ToolDefinition, ToolError, ToolResult } from "../types.js";

export interface RegistryOptions { audit?: (event: ToolAuditEvent) => void | Promise<void>; defaultTimeoutMs?: number }
export interface ToolFilter { toolset?: string; capabilities?: readonly Capability[] }
type ModelSchema = { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> };

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<unknown, unknown>>();
  readonly #toolsets = new Map<string, readonly string[]>();
  readonly #audit?: RegistryOptions["audit"];
  readonly #defaultTimeoutMs: number;
  #sequence = 0;
  constructor(options: RegistryOptions = {}) { this.#audit = options.audit; this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000; }
  register<I, O>(tool: ToolDefinition<I, O>): this { if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`); this.#tools.set(tool.name, tool as ToolDefinition<unknown, unknown>); return this; }
  defineToolset(name: string, tools: readonly string[]): this { for (const tool of tools) if (!this.#tools.has(tool)) throw new Error(`Unknown tool: ${tool}`); this.#toolsets.set(name, [...tools]); return this; }
  list(filter: ToolFilter = {}): ToolDefinition[] { return this.#list(filter, false); }
  listPrivileged(filter: Omit<ToolFilter, "capabilities"> = {}): ToolDefinition[] { return this.#list(filter, true); }
  #list(filter: ToolFilter, privileged: boolean): ToolDefinition[] {
    const names = filter.toolset ? new Set(this.#toolsets.get(filter.toolset) ?? []) : undefined;
    const capabilities = new Set(filter.capabilities ?? []);
    return [...this.#tools.values()].filter((tool) => (!names || names.has(tool.name)) && (privileged || (capabilities.size > 0 && tool.capabilities.every((cap) => capabilities.has(cap))))).sort((a, b) => a.name.localeCompare(b.name));
  }
  async available(filter: ToolFilter = {}): Promise<ToolDefinition[]> {
    const checks = await Promise.all(this.list(filter).map(async (tool) => { try { return { tool, available: (await tool.availability?.() ?? { available: true }).available }; } catch { return { tool, available: false }; } }));
    return checks.filter((x) => x.available).map((x) => x.tool);
  }
  schemas(filter: ToolFilter = {}): ModelSchema[] { return this.list(filter).map(toModelSchema); }
  schemasPrivileged(filter: Omit<ToolFilter, "capabilities"> = {}): ModelSchema[] { return this.listPrivileged(filter).map(toModelSchema); }
  classify(name: string) { const tool = this.#require(name); return { effect: tool.effect, parallelSafe: tool.parallelSafe }; }

  async invoke(name: string, input: unknown, context: InvocationContext): Promise<ToolResult> {
    const invocationId = context.invocationId ?? `tool-${++this.#sequence}`;
    const tool = this.#tools.get(name);
    const reject = async (code: ToolError["code"], message: string, details?: unknown, metadata?: ToolDefinition): Promise<ToolResult> => {
      const result = failure(name, invocationId, code, message, details);
      await this.#emit({ phase: "finish", invocationId, tool: name, effect: metadata?.effect ?? "admin", parallelSafe: metadata?.parallelSafe ?? false, ok: false, errorCode: code });
      return result;
    };
    if (!tool) return reject("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    if (!tool.capabilities.every((cap) => context.capabilities.includes(cap))) return reject("CAPABILITY_DENIED", "Required capability not granted", undefined, tool);
    let status;
    try { status = await tool.availability?.() ?? { available: true }; } catch (error) { return reject("UNAVAILABLE", errorMessage(error), undefined, tool); }
    if (!status.available) return reject("UNAVAILABLE", status.reason ?? "Tool unavailable", undefined, tool);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) return reject("INVALID_INPUT", "Input validation failed", parsed.error.flatten(), tool);
    const controller = new AbortController();
    let timeoutTriggered = false;
    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_, rejectPromise) => { rejectAbort = rejectPromise; });
    const abort = (timeout: boolean) => { timeoutTriggered ||= timeout; controller.abort(timeout ? new Error("Tool timed out") : context.signal?.reason); rejectAbort(controller.signal.reason); };
    const callerAborted = () => abort(false);
    context.signal?.addEventListener("abort", callerAborted, { once: true });
    const timeout = setTimeout(() => abort(true), tool.timeoutMs ?? this.#defaultTimeoutMs);
    await this.#emit({ phase: "start", invocationId, tool: name, effect: tool.effect, parallelSafe: tool.parallelSafe });
    let result: ToolResult;
    try {
      if (context.signal?.aborted) abort(false);
      const data = await Promise.race([Promise.resolve(tool.execute(parsed.data, { signal: controller.signal, invocationId, capabilities: new Set(context.capabilities) })), abortPromise]);
      const output = tool.outputSchema.safeParse(data);
      result = output.success ? { ok: true, invocationId, tool: name, data: output.data } : failure(name, invocationId, "INVALID_OUTPUT", "Output validation failed", output.error.flatten());
    } catch (error) {
      const code: ToolError["code"] = controller.signal.aborted ? (timeoutTriggered ? "TIMEOUT" : "CANCELLED") : "EXECUTION_ERROR";
      result = failure(name, invocationId, code, errorMessage(error));
    } finally { clearTimeout(timeout); context.signal?.removeEventListener("abort", callerAborted); }
    const finish: ToolAuditEvent = { phase: "finish", invocationId, tool: name, effect: tool.effect, parallelSafe: tool.parallelSafe, ok: result.ok };
    if (isFailure(result)) finish.errorCode = result.error.code;
    await this.#emit(finish);
    return result;
  }
  async invokeParallel(calls: readonly { name: string; input: unknown }[], context: InvocationContext): Promise<ToolResult[]> { for (const call of calls) if (!this.#require(call.name).parallelSafe) throw new Error(`Tool is not parallel-safe: ${call.name}`); return Promise.all(calls.map((call, index) => this.invoke(call.name, call.input, { ...context, ...(context.invocationId ? { invocationId: `${context.invocationId}:${index}` } : {}) }))); }
  #require(name: string) { const tool = this.#tools.get(name); if (!tool) throw new Error(`Unknown tool: ${name}`); return tool; }
  async #emit(event: ToolAuditEvent) { try { await this.#audit?.(event); } catch { /* observational */ } }
}

function failure(tool: string, invocationId: string, code: ToolError["code"], message: string, details?: unknown): ToolResult { return { ok: false, invocationId, tool, error: { code, message, ...(details === undefined ? {} : { details }) } }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isFailure(result: ToolResult): result is Extract<ToolResult, { ok: false }> { return !result.ok; }
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> { const convert = zodToJsonSchema as (schema: z.ZodTypeAny, options: { $refStrategy: "none" }) => unknown; return convert(schema, { $refStrategy: "none" }) as Record<string, unknown>; }
function toModelSchema(tool: ToolDefinition<unknown, unknown>): ModelSchema { return { name: tool.name, description: tool.description, inputSchema: jsonSchema(tool.inputSchema), outputSchema: jsonSchema(tool.outputSchema) }; }
