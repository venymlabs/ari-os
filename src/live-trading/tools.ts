import { z } from "zod";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import type { TradingOrchestrator } from "./index.js";
/** base58, 32 bytes — the alphabet excludes 0, O, I and l. */
const mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const input = z
  .object({
    inputMint: mint,
    outputMint: mint,
    amountIn: z.string().regex(/^[1-9][0-9]*$/),
    slippageBps: z.number().int().min(0).max(10_000),
    dryRun: z.boolean().default(true),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();
const output = z.object({ id: z.string(), state: z.string() }).passthrough();
export function registerTradingTools(
  r: ToolRegistry,
  trading: Pick<TradingOrchestrator, "quote" | "execute" | "status">,
) {
  for (const side of ["buy", "sell"] as const)
    r.register({
      name: `trade.${side}`,
      description: `Create a typed ${side} intent; never accepts a program, account list or instruction data`,
      inputSchema: input,
      outputSchema: output,
      capabilities: [TRADING_CAPABILITIES.ORDER_WRITE],
      effect: "trade",
      parallelSafe: false,
      execute: async (x) => {
        const q = await trading.quote({
          side,
          inputMint: x.inputMint,
          outputMint: x.outputMint,
          amountIn: BigInt(x.amountIn),
          slippageBps: x.slippageBps,
        });
        return trading.execute(q.id, {
          idempotencyKey: x.idempotencyKey,
          actor: "agent-tool",
          ...(x.dryRun === undefined ? {} : { dryRun: x.dryRun }),
        });
      },
    });
  r.register({
    name: "trade.status",
    description: "Read durable execution status",
    inputSchema: z.object({ id: z.string().uuid() }).strict(),
    outputSchema: output,
    capabilities: [TRADING_CAPABILITIES.PORTFOLIO_READ],
    effect: "read",
    parallelSafe: true,
    execute: (x) => trading.status(x.id),
  });
  return r;
}
