import { describe, expect, it } from "vitest";
import { normalizeIntent } from "../src/intent.js";
import { evaluatePolicy } from "../src/policy.js";
import { AuditJournal } from "../src/audit.js";
import { pubkey } from "./signer-fixtures.js";

const IN = pubkey(1),
  OUT = pubkey(2);

describe("typed intent boundary", () => {
  it("normalizes a swap without accepting arbitrary instruction data", () => {
    const intent = normalizeIntent({
      kind: "swap",
      tokenIn: IN,
      tokenOut: OUT,
      amountIn: "100",
      maxSlippageBps: 100,
      expiresAt: 2000,
    });
    expect(intent.kind).toBe("swap");
    expect("instructions" in intent).toBe(false);
  });
  it("rejects unknown transaction fields", () => {
    expect(() =>
      normalizeIntent({
        kind: "swap",
        tokenIn: IN,
        tokenOut: OUT,
        amountIn: "100",
        maxSlippageBps: 100,
        expiresAt: 2000,
        instructions: [{ programId: OUT, data: "deadbeef" }],
      }),
    ).toThrow();
  });
  it("rejects anything that is not a base58 mint, case included", () => {
    for (const bad of [
      "0x0000000000000000000000000000000000000001",
      IN.toLowerCase() === IN ? IN.toUpperCase() : IN.toLowerCase(),
      `${IN}0`,
      "",
    ])
      expect(() =>
        normalizeIntent({
          kind: "swap",
          tokenIn: bad,
          tokenOut: OUT,
          amountIn: "100",
          maxSlippageBps: 100,
          expiresAt: 2000,
        }),
      ).toThrow();
  });
});

describe("deny-by-default policy", () => {
  const intent = {
    kind: "swap" as const,
    tokenIn: IN,
    tokenOut: OUT,
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
  it("refuses a mint that is not on the allowlist", () =>
    expect(
      evaluatePolicy(intent, {
        now: 1000,
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        allowedTokens: new Set([intent.tokenIn]),
      }).reasons,
    ).toEqual(["token_out_not_allowed"]));
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
