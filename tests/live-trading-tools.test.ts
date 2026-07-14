import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { registerTradingTools } from "../src/live-trading/tools.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
const A = "0x0000000000000000000000000000000000000001";
describe("typed trading agent tools", () => {
  it("exposes typed intents without target or calldata", async () => {
    const trading = {
      quote: vi.fn(async (x: any) => ({ id: "q", ...x })),
      execute: vi.fn(async () => ({ id: "e", state: "awaiting-approval" })),
      status: vi.fn(() => ({ id: "e", state: "finalized" })),
    };
    const r = registerTradingTools(new ToolRegistry(), trading as any);
    const schema = r.schemas({
      capabilities: [
        TRADING_CAPABILITIES.MARKET_DATA,
        TRADING_CAPABILITIES.ORDER_WRITE,
      ],
    });
    const buy = schema.find((x) => x.name === "trade.buy")!;
    expect(buy.inputSchema).not.toHaveProperty("properties.target");
    expect(buy.inputSchema).not.toHaveProperty("properties.calldata");
    expect(
      (
        await r.invoke(
          "trade.buy",
          {
            tokenIn: A,
            tokenOut: A,
            amountIn: "10",
            slippageBps: 10,
            dryRun: true,
            idempotencyKey: "k",
          },
          { capabilities: [TRADING_CAPABILITIES.ORDER_WRITE] },
        )
      ).ok,
    ).toBe(true);
    expect(trading.quote).toHaveBeenCalledWith(
      expect.objectContaining({ side: "buy", amountIn: 10n }),
    );
  });
});
