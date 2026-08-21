import { z } from "zod";
import { ToolRegistry } from "../agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import type { VenueMounts } from "./venues.js";
import { registerVenueTools } from "./venues.js";
const provenance = z.object({
  observedAt: z.number(),
  source: z.string(),
  blockNumber: z.number().int().nonnegative().optional(),
  finalized: z.boolean().optional(),
});
const envelope = z.object({ data: z.unknown(), provenance });
type MarketDeps = {
  networks?: () => Promise<unknown>;
  search?: (q: string, n?: string) => Promise<unknown>;
  trending?: (n: string) => Promise<unknown>;
  newPairs?: (n: string) => Promise<unknown>;
  token?: (n: string, a: string) => Promise<unknown>;
  pair?: (n: string, a: string) => Promise<unknown>;
  ohlcv?: (n: string, p: string, x: string, l?: number) => Promise<unknown>;
  trades?: (n: string, p: string, l?: number) => Promise<unknown>;
  holders?: (n: string, t: string, l?: number) => Promise<unknown>;
};
export interface BuiltInDependencies {
  market?: MarketDeps;
  noxa?: {
    launches?: (limit: number) => Promise<unknown>;
    verify?: (address: string) => Promise<unknown>;
  };
  risk?: { analyze?: (input: unknown) => unknown };
  simulation?: { simulate?: (input: any) => Promise<unknown> };
  /**
   * Perps and liquidity venues. Omitted, those tools simply do not exist —
   * which is the correct default: an unmounted venue must not be reachable.
   * See `src/tools/venues.ts`, and note that mounting perps also requires
   * handing `perpsPositionReader(...)` to the trade gateway.
   */
  venues?: VenueMounts;
}
const wrap = (source: string, data: unknown) => ({
  data,
  provenance: { observedAt: Date.now(), source },
});
export function registerBuiltInTools(
  r: ToolRegistry,
  d: BuiltInDependencies = {},
) {
  const reg = (
    name: string,
    description: string,
    input: z.ZodTypeAny,
    fn: ((x: any) => Promise<unknown> | unknown) | undefined,
    effect: "read" | "trade" = "read",
    capability: string = TRADING_CAPABILITIES.MARKET_DATA,
  ) =>
    r.register({
      name,
      description,
      inputSchema: input,
      outputSchema: envelope,
      capabilities: [capability],
      effect,
      parallelSafe: effect === "read",
      timeoutMs: 10_000,
      availability: () =>
        fn
          ? { available: true }
          : { available: false, reason: `${name} backend is not configured` },
      execute: async (x) => {
        if (!fn) throw new Error(`${name} backend is not configured`);
        return wrap(name, await fn(x));
      },
    });
  reg(
    "market.networks",
    "List supported networks",
    z.object({}).strict(),
    d.market?.networks && (() => d.market!.networks!()),
  );
  reg(
    "market.search",
    "Search bounded market data",
    z.object({
      query: z.string().min(1).max(200),
      network: z.string().optional(),
    }),
    d.market?.search && ((x) => d.market!.search!(x.query, x.network)),
  );
  reg(
    "market.trending",
    "Discover market pairs",
    z.object({ network: z.string().min(1) }),
    d.market?.trending && ((x) => d.market!.trending!(x.network)),
  );
  reg(
    "market.new-pairs",
    "Discover market pairs",
    z.object({ network: z.string().min(1) }),
    d.market?.newPairs && ((x) => d.market!.newPairs!(x.network)),
  );
  reg(
    "market.token",
    "Read token",
    z.object({ network: z.string(), address: z.string().min(2) }),
    d.market?.token && ((x) => d.market!.token!(x.network, x.address)),
  );
  reg(
    "market.pair",
    "Read pair",
    z.object({ network: z.string(), address: z.string().min(2) }),
    d.market?.pair && ((x) => d.market!.pair!(x.network, x.address)),
  );
  reg(
    "market.ohlcv",
    "Read bounded OHLCV",
    z.object({
      network: z.string(),
      pair: z.string(),
      period: z.enum(["minute", "hour", "day"]),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    d.market?.ohlcv &&
      ((x) => d.market!.ohlcv!(x.network, x.pair, x.period, x.limit)),
  );
  reg(
    "market.trades",
    "Read bounded trades",
    z.object({
      network: z.string(),
      pair: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    d.market?.trades && ((x) => d.market!.trades!(x.network, x.pair, x.limit)),
  );
  reg(
    "market.holders",
    "Read bounded holders",
    z.object({
      network: z.string(),
      token: z.string(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    d.market?.holders &&
      ((x) => d.market!.holders!(x.network, x.token, x.limit)),
  );
  reg(
    "noxa.launches",
    "Read NOXA launches",
    z.object({ limit: z.number().int().min(1).max(100).default(50) }),
    d.noxa?.launches && ((x) => d.noxa!.launches!(x.limit)),
  );
  reg(
    "noxa.verify-token",
    "Verify NOXA token",
    z.object({ address: z.string().min(2) }),
    d.noxa?.verify && ((x) => d.noxa!.verify!(x.address)),
  );
  reg(
    "risk.analyze",
    "Risk analysis from configured evidence",
    z.unknown(),
    d.risk?.analyze && ((x) => d.risk!.analyze!(x)),
    "read",
    TRADING_CAPABILITIES.RISK_ANALYSIS,
  );
  reg(
    "simulation.transaction",
    "Simulate exact transaction",
    z.unknown(),
    d.simulation?.simulate && ((x) => d.simulation!.simulate!(x)),
    "trade",
    TRADING_CAPABILITIES.ORDER_SIMULATE,
  );
  if (d.venues) registerVenueTools(r, d.venues);
  return r;
}

export { registerIntentTool, registerIntentTools } from "./intent-bridge.js";
export type { IntentToolRuntime } from "./intent-bridge.js";
export {
  perpsPositionReader,
  registerVenueTools,
  venueToolNames,
} from "./venues.js";
export type { VenueMounts } from "./venues.js";
