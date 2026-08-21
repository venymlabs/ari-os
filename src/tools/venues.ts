import type { ToolRegistry } from "../agent/tools/registry.js";
import type { PositionReader } from "../kernel/contracts.js";
import { createPerpsTools, PERPS_TOOL_NAMES } from "../perps/index.js";
import type { PerpsToolDeps } from "../perps/index.js";
import { positionReaderOver } from "../perps/settle.js";
import { makePoolsTools, POOL_TOOL_NAMES } from "../pools/index.js";
import type { PoolsDepsInput } from "../pools/index.js";
import type { IntentToolRuntime } from "./intent-bridge.js";
import { registerIntentTools } from "./intent-bridge.js";

/**
 * Mounting the venue-backed toolsets.
 *
 * Perps and pools tools are FACTORIES over their dependencies rather than
 * module-level constants, and stay that way here on purpose. A venue is a
 * composition-time singleton with live policy getters, a guard config and a
 * rebalance ledger hanging off it — none of that is per-invocation state, so
 * widening `ToolContext` to carry it would force every context construction
 * site in the codebase to know about perps even when perps are off, and would
 * still leave the policy getters homeless. The factory closes over exactly what
 * it needs and satisfies the unwidened `ToolContext` as-is.
 */

export interface VenueMounts {
  /** How each invocation gets its wallet, gateway and read-only services. */
  readonly runtime: IntentToolRuntime;
  /** Omit to leave perps unmounted; the five perps tools then do not exist. */
  readonly perps?: PerpsToolDeps;
  /** Omit to leave liquidity and bonding-curve tools unmounted. */
  readonly pools?: PoolsDepsInput;
}

/**
 * The {@link PositionReader} the trade gateway needs to verify a perp fill.
 *
 * This is not optional wiring. The gateway refuses a perp intent when no reader
 * is mounted (`SETTLE_UNVERIFIABLE`), because a perp fill cannot be read off a
 * token balance — so mounting the perps tools without also handing this to
 * `TradeGatewayImpl` yields tools that build intents the kernel will not
 * execute. Returns `undefined` when perps are not mounted at all.
 */
export function perpsPositionReader(
  mounts: Pick<VenueMounts, "perps">,
): PositionReader | undefined {
  return mounts.perps ? positionReaderOver([mounts.perps.venue]) : undefined;
}

/** Every tool name the venue mounts contribute, for wiring checks and prompt budgeting. */
export function venueToolNames(
  mounts: Pick<VenueMounts, "perps" | "pools">,
): readonly string[] {
  return [
    ...(mounts.perps ? PERPS_TOOL_NAMES : []),
    ...(mounts.pools ? POOL_TOOL_NAMES : []),
  ];
}

/**
 * Register the perps and pools toolsets on `registry`. Reads land before spends
 * so the model's tool listing shows the safe surface first.
 */
export function registerVenueTools(
  registry: ToolRegistry,
  mounts: VenueMounts,
): ToolRegistry {
  if (mounts.perps) {
    const toolset = createPerpsTools(mounts.perps);
    registerIntentTools(registry, toolset.reads, mounts.runtime);
    registerIntentTools(registry, toolset.proposals, mounts.runtime);
  }
  if (mounts.pools) {
    registerIntentTools(
      registry,
      makePoolsTools(mounts.pools).tools,
      mounts.runtime,
    );
  }
  return registry;
}
