import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerTradingApi } from "../src/live-trading/api.js";
import { pubkey } from "./signer-fixtures.js";
const IN = pubkey(1),
  OUT = pubkey(2);
describe("trading API", () => {
  it("enforces quote/execute scopes and idempotency", async () => {
    const trading = {
      quote: vi.fn(async () => ({ id: "q" })),
      execute: vi.fn(async () => ({ id: "e", state: "awaiting-approval" })),
      status: vi.fn(() => ({ id: "e", state: "finalized" })),
    };
    const app = Fastify();
    registerTradingApi(app, {
      trading: trading as any,
      principal: (q: any) => ({
        subject: "u",
        scopes: String(q.headers["x-scopes"] ?? "").split(","),
      }),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/trading/quote",
          payload: {
            side: "buy",
            inputMint: IN,
            outputMint: OUT,
            amountIn: "1",
            slippageBps: 1,
          },
        })
      ).statusCode,
    ).toBe(403);
    const q = await app.inject({
      method: "POST",
      url: "/v1/trading/quote",
      headers: { "x-scopes": "trading:quote" },
      payload: {
        side: "buy",
        inputMint: IN,
        outputMint: OUT,
        amountIn: "1",
        slippageBps: 1,
      },
    });
    expect(q.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/trading/execute",
          headers: { "x-scopes": "trading:execute" },
          payload: { quoteId: "q", dryRun: true },
        })
      ).statusCode,
    ).toBe(400);
    const e = await app.inject({
      method: "POST",
      url: "/v1/trading/execute",
      headers: { "x-scopes": "trading:execute", "idempotency-key": "k" },
      payload: { quoteId: "q", dryRun: true },
    });
    expect(e.statusCode).toBe(202);
    expect(trading.execute).toHaveBeenCalledWith("q", {
      idempotencyKey: "k",
      actor: "u",
      dryRun: true,
    });
    await app.close();
  });
});
