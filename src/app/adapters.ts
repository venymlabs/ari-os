import type {
  ModelRouter,
  ModelRequest as RouterRequest,
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
  readonly id = "model-router";
  constructor(
    private router: Pick<ModelRouter, "complete">,
    private registry: ToolRegistry,
    private options: { capabilities: readonly Capability[] },
  ) {}
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
