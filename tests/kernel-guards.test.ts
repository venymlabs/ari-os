import { describe, expect, it } from "vitest";
import type { TradeIntent } from "../src/kernel/contracts.js";
import { defaultPolicy } from "../src/kernel/defaults.js";
import { isGuardError } from "../src/kernel/errors.js";
import { newIdempotencyKey, newTradeId } from "../src/kernel/ids.js";
import {
  formatAmount,
  fromBaseUnits,
  quoteBucketFor,
  slippageBps,
  toBaseUnits,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} from "../src/kernel/money.js";
import { staticGuards } from "../src/kernel/policy-engine.js";
import { Secret } from "../src/kernel/secret.js";

const BONK = "BonkMint11111111111111111111111111111111111";

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  const inputAmount = 500_000_000n; // 0.5 SOL
  const outAmount = 1_000_000n;
  return {
    kind: "swap",
    source: "swap_jupiter",
    input: { mint: WSOL_MINT, amount: inputAmount, decimals: 9 },
    output: { mint: BONK, decimals: 6 },
    inputProvenance: "user",
    outputProvenance: "user",
    unsignedTxBase64: "AQAB",
    recentBlockhash: "h",
    lastValidBlockHeight: 1000,
    landMode: "self-rpc",
    landHandle: undefined,
    priorityFeeLamports: 100_000,
    quote: {
      inAmount: inputAmount,
      outAmount,
      minOutAmount: outAmount - (outAmount * 50n) / 10_000n,
      priceImpactPct: 0.1,
      routeLabel: "Mock",
      slippageBps: 50,
      contextSlot: undefined,
    },
    summary: "s",
    ...over,
  };
}

const armed = { ...defaultPolicy(), executionEnabled: true };
const opts = { dryRun: false, confirmedByUser: false };

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return isGuardError(e) ? e.code : "NON_GUARD";
  }
}

describe("input-leg denomination", () => {
  it("maps only quote assets to a cap bucket, so a sell draws on nothing", () => {
    expect(quoteBucketFor(WSOL_MINT)).toBe("sol");
    expect(quoteBucketFor(USDC_MINT)).toBe("usdc");
    expect(quoteBucketFor(USDT_MINT)).toBe("usdc");
    expect(quoteBucketFor(BONK)).toBeNull();
  });
  it("parses base units without float drift and never accepts junk", () => {
    expect(toBaseUnits(1, 9)).toBe(1_000_000_000n);
    expect(toBaseUnits(0.5, 9)).toBe(500_000_000n);
    expect(toBaseUnits("1.234567", 6)).toBe(1_234_567n);
    expect(toBaseUnits(0.1, 9) + toBaseUnits(0.2, 9)).toBe(300_000_000n);
    for (const bad of ["-1", "1e3", "abc", ""])
      expect(() => toBaseUnits(bad, 9)).toThrow();
  });
  it("formats for display only", () => {
    expect(fromBaseUnits(1_500_000_000n, 9)).toBe(1.5);
    expect(formatAmount(1_000_000_000n, 9)).toBe("1");
  });
  it("measures shortfall in bps and clamps a non-positive expectation", () => {
    expect(slippageBps(10_000n, 9_950n)).toBe(50);
    expect(slippageBps(10_000n, 10_000n)).toBe(0);
    expect(slippageBps(0n, 5n)).toBe(0);
  });
});

describe("static guards", () => {
  it("passes a within-policy intent", () => {
    expect(() => staticGuards(armed, intent(), opts)).not.toThrow();
  });
  it("refuses a live trade while disarmed but allows the dry-run preview", () => {
    const disarmed = { ...armed, executionEnabled: false };
    expect(codeOf(() => staticGuards(disarmed, intent(), opts))).toBe(
      "EXECUTION_DISABLED",
    );
    expect(() =>
      staticGuards(disarmed, intent(), { ...opts, dryRun: true }),
    ).not.toThrow();
  });
  it("refuses everything once the kill switch is engaged, dry-run included", () => {
    const killed = { ...armed, killSwitch: true };
    expect(codeOf(() => staticGuards(killed, intent(), opts))).toBe(
      "KILL_SWITCH",
    );
    expect(
      codeOf(() => staticGuards(killed, intent(), { ...opts, dryRun: true })),
    ).toBe("KILL_SWITCH");
  });
  it("refuses a priority fee over the absolute lamport ceiling", () => {
    expect(
      codeOf(() =>
        staticGuards(armed, intent({ priorityFeeLamports: 6_000_000 }), opts),
      ),
    ).toBe("PRIORITY_FEE_EXCEEDED");
  });
  it("refuses a priority fee over the bps-of-notional ceiling", () => {
    // 50bps of 0.5 SOL = 2_500_000 lamports; 3_000_000 is under absolute, over bps.
    expect(
      codeOf(() =>
        staticGuards(armed, intent({ priorityFeeLamports: 3_000_000 }), opts),
      ),
    ).toBe("PRIORITY_FEE_EXCEEDED");
  });
  it("refuses a negative or non-finite priority fee", () => {
    for (const fee of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        codeOf(() =>
          staticGuards(armed, intent({ priorityFeeLamports: fee }), opts),
        ),
      ).toBe("PRIORITY_FEE_INVALID");
  });
  it("clamps slippage regardless of what the caller asked for", () => {
    expect(
      codeOf(() =>
        staticGuards(
          armed,
          intent({
            quote: { ...intent().quote, slippageBps: 250 },
          }),
          opts,
        ),
      ),
    ).toBe("SLIPPAGE_EXCEEDED");
  });
  it("refuses a route whose min-out contradicts the clamped slippage", () => {
    expect(
      codeOf(() =>
        staticGuards(
          armed,
          intent({
            quote: { ...intent().quote, minOutAmount: 500_000n },
          }),
          opts,
        ),
      ),
    ).toBe("MIN_OUT_MISMATCH");
  });
  it("refuses an untrusted mint without an explicit confirmation, and allows it with one", () => {
    expect(
      codeOf(() =>
        staticGuards(armed, intent({ outputProvenance: "untrusted" }), opts),
      ),
    ).toBe("MINT_NOT_PINNED");
    expect(() =>
      staticGuards(armed, intent({ outputProvenance: "untrusted" }), {
        ...opts,
        confirmedByUser: true,
      }),
    ).not.toThrow();
  });
  it("enforces the denylist and the allowlist on both legs", () => {
    expect(
      codeOf(() =>
        staticGuards({ ...armed, mintDenylist: [BONK] }, intent(), opts),
      ),
    ).toBe("MINT_DENIED");
    expect(
      codeOf(() =>
        staticGuards({ ...armed, mintAllowlist: [WSOL_MINT] }, intent(), opts),
      ),
    ).toBe("MINT_DENIED");
    expect(() =>
      staticGuards(
        { ...armed, mintAllowlist: [WSOL_MINT, BONK] },
        intent(),
        opts,
      ),
    ).not.toThrow();
  });
  it("refuses a structurally invalid intent", () => {
    expect(
      codeOf(() =>
        staticGuards(
          armed,
          intent({ input: { mint: WSOL_MINT, amount: 0n, decimals: 9 } }),
          opts,
        ),
      ),
    ).toBe("INVALID_INTENT");
    expect(
      codeOf(() => staticGuards(armed, intent({ unsignedTxBase64: "" }), opts)),
    ).toBe("INVALID_INTENT");
  });
});

describe("ids and secrets", () => {
  it("mints high-entropy idempotency keys that are never caller-derivable", () => {
    const keys = new Set(Array.from({ length: 256 }, newIdempotencyKey));
    expect(keys.size).toBe(256);
    for (const k of keys) expect(k.startsWith("idem_")).toBe(true);
    expect(newTradeId().startsWith("trd_")).toBe(true);
  });
  it("keeps a Secret out of logs, stringification and JSON by construction", () => {
    const s = new Secret("a".repeat(40), "llm-key");
    expect(String(s)).toBe("[redacted:llm-key]");
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted:llm-key]"}');
    expect(JSON.stringify(s)).not.toContain("aaaa");
    expect(s.reveal()).toBe("a".repeat(40));
    expect(s.last4).toBe("aaaa");
    expect(new Secret("short", "x").last4).toBeUndefined();
  });
});
