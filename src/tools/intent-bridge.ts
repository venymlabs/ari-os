import { z } from "zod";
import type { ToolRegistry } from "../agent/tools/registry.js";
import type { Capability } from "../agent/types.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import type { IntentToolDefinition, ToolContext } from "../kernel/contracts.js";
import { movesValue } from "../kernel/contracts.js";
import { newIdempotencyKey } from "../kernel/ids.js";

/**
 * Adapt a kernel {@link IntentToolDefinition} onto the agent {@link ToolRegistry}.
 *
 * The two contracts differ in one way that matters. An intent tool has TWO
 * entry points — `simulate()` builds a real, executable intent and stops;
 * `execute()` hands that intent to `ctx.gateway.execute()` and does nothing
 * else — while the registry has one `execute`. So a value-moving tool is
 * registered as a pair: `<name>` spends and needs a write capability, and
 * `<name>.preview` builds the same intent, returns it for a quote card, and
 * cannot move anything. Read-only tools register once.
 *
 * Two things are deliberately NOT model-reachable:
 *
 *  - **`confirmedByUser`.** It means "a human pressed Confirm", so it comes from
 *    the runtime the composition root supplies, never from tool input. A model
 *    that could set it could clear the untrusted-mint gate by asking.
 *  - **`idempotencyKey`.** Server-generated per invocation. A model-chosen key
 *    is either a replay or a collision.
 */

const provenance = z.object({
  observedAt: z.number(),
  source: z.string(),
});
const envelope = z.object({ data: z.unknown(), provenance });

export interface IntentToolRuntime {
  /** Per-invocation context: wallet, gateway, read-only services. */
  context(): ToolContext | Promise<ToolContext>;
  /**
   * True iff a human has confirmed this specific invocation. Defaults to false
   * — an unwired approvals path means untrusted-provenance mints are refused,
   * not waved through.
   */
  confirmedByUser?: (
    toolName: string,
    config: unknown,
  ) => boolean | Promise<boolean>;
  /** Override only in tests; production wants a fresh server-generated key. */
  idempotencyKey?: () => string;
}

/** Which agent capability a tool needs, derived from what it declares it does. */
function capabilityFor(
  tool: IntentToolDefinition<unknown>,
  surface: "execute" | "preview",
): Capability {
  if (surface === "preview") return TRADING_CAPABILITIES.ORDER_SIMULATE;
  if (!movesValue(tool.capabilities)) {
    return tool.capabilities.includes("read_state")
      ? TRADING_CAPABILITIES.PORTFOLIO_READ
      : TRADING_CAPABILITIES.MARKET_DATA;
  }
  return tool.category === "perps"
    ? TRADING_CAPABILITIES.POSITION_WRITE
    : TRADING_CAPABILITIES.ORDER_WRITE;
}

function wrap(source: string, data: unknown) {
  return { data, provenance: { observedAt: Date.now(), source } };
}

/**
 * Register one intent tool (and its preview surface, if it moves value).
 * Returns the registry so calls chain like the built-in registrations do.
 */
export function registerIntentTool(
  registry: ToolRegistry,
  tool: IntentToolDefinition<unknown>,
  runtime: IntentToolRuntime,
): ToolRegistry {
  const spends = movesValue(tool.capabilities);

  registry.register({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.configSchema,
    outputSchema: envelope,
    capabilities: [capabilityFor(tool, "execute")],
    effect: spends ? "trade" : "read",
    parallelSafe: !spends && tool.execPolicy.idempotent,
    timeoutMs: tool.execPolicy.timeoutMs,
    execute: async (config: unknown) => {
      const ctx = await runtime.context();
      const outcome = await tool.execute(ctx, config, {
        idempotencyKey: (runtime.idempotencyKey ?? newIdempotencyKey)(),
        confirmedByUser:
          (await runtime.confirmedByUser?.(tool.name, config)) === true,
      });
      if (outcome.isError) throw new Error(outcome.text);
      return wrap(tool.name, { text: outcome.text, result: outcome.data });
    },
  });

  if (!spends) return registry;

  registry.register({
    name: `${tool.name}.preview`,
    description: `Preview ${tool.name} — builds the exact intent the kernel would receive, with the quote and every warning, and moves nothing.`,
    inputSchema: tool.configSchema,
    outputSchema: envelope,
    capabilities: [capabilityFor(tool, "preview")],
    effect: "read",
    parallelSafe: true,
    timeoutMs: tool.execPolicy.timeoutMs,
    execute: async (config: unknown) => {
      const ctx = await runtime.context();
      const preview = await tool.simulate(ctx, config);
      return wrap(`${tool.name}.preview`, preview);
    },
  });
  return registry;
}

export function registerIntentTools(
  registry: ToolRegistry,
  tools: readonly IntentToolDefinition<any>[],
  runtime: IntentToolRuntime,
): ToolRegistry {
  for (const tool of tools) registerIntentTool(registry, tool, runtime);
  return registry;
}
