import { describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../src/chain.js";
import { normalizeIntent } from "../src/intent.js";
import { evaluatePolicy } from "../src/policy.js";
import { AuditJournal } from "../src/audit.js";

describe("chain configuration", () => {
  it("pins Robinhood testnet and never silently selects mainnet", () => {
    expect(robinhoodTestnet.id).toBe(46630);
    expect(robinhoodTestnet.testnet).toBe(true);
    expect(robinhoodTestnet.rpcUrls.default.http[0]).toBe(
      "https://rpc.testnet.chain.robinhood.com",
    );
  });
});

describe("typed intent boundary", () => {
  it("normalizes a swap without accepting arbitrary calldata", () => {
    const intent = normalizeIntent({
      kind: "swap",
      tokenIn: "0x0000000000000000000000000000000000000001",
      tokenOut: "0x0000000000000000000000000000000000000002",
      amountIn: "100",
      maxSlippageBps: 100,
      expiresAt: 2000,
    });
    expect(intent.kind).toBe("swap");
    expect("calldata" in intent).toBe(false);
  });
  it("rejects unknown transaction fields", () => {
    expect(() =>
      normalizeIntent({
        kind: "swap",
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenOut: "0x0000000000000000000000000000000000000002",
        amountIn: "100",
        maxSlippageBps: 100,
        expiresAt: 2000,
        calldata: "0xdeadbeef",
      }),
    ).toThrow();
  });
});

describe("deny-by-default policy", () => {
  const intent = {
    kind: "swap" as const,
    tokenIn: "0x0000000000000000000000000000000000000001" as const,
    tokenOut: "0x0000000000000000000000000000000000000002" as const,
    amountIn: 100n,
    maxSlippageBps: 100,
    expiresAt: 2000,
  };
  it("allows only explicitly constrained assets and amounts", () =>
    expect(
      evaluatePolicy(intent, {
        now: 1000,
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        allowedTokens: new Set([intent.tokenIn, intent.tokenOut]),
      }),
    ).toEqual({ allowed: true, reasons: [] }));
  it("rejects expired or excessive intents", () =>
    expect(
      evaluatePolicy(
        { ...intent, expiresAt: 999, amountIn: 101n },
        {
          now: 1000,
          maxAmountIn: 100n,
          maxSlippageBps: 100,
          allowedTokens: new Set([intent.tokenIn, intent.tokenOut]),
        },
      ).allowed,
    ).toBe(false));
});

describe("tamper-evident audit", () =>
  it("detects mutation", () => {
    const j = new AuditJournal();
    j.append("intent", { id: 1 });
    j.append("decision", { allowed: true });
    expect(j.verify()).toBe(true);
    j.unsafeEntriesForTest()[0]!.payload = { id: 2 };
    expect(j.verify()).toBe(false);
  }));
