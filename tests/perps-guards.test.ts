/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { isGuardError } from "../src/kernel/errors.js";
import { USDC_MINT } from "../src/kernel/money.js";
import { isPerpGuardError, type PerpGuardCode } from "../src/perps/errors.js";
import { staleExposure } from "../src/perps/exposure.js";
import {
  evaluatePerpGuards,
  type PerpGuardContext,
  perpGuards,
  positionLiquidationDistanceBps,
} from "../src/perps/guards.js";
import type { PerpIntent } from "../src/perps/intent.js";
import { fakeMarket, usdc } from "../src/perps/testing/fake-venue.js";
import {
  BASELINE,
  testCtx,
  testExposure,
  testIntent,
  testPolicy,
  testPosition,
} from "../src/perps/testing/fixtures.js";

const NON_QUOTE_MINT = "BonkMint11111111111111111111111111111111111";

/** Assert BOTH guard paths agree: the throwing one and the collecting one. */
function refuses(
  intent: PerpIntent,
  ctx: PerpGuardContext,
  code: PerpGuardCode,
): void {
  let thrown: unknown;
  try {
    perpGuards(intent, ctx);
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown !== undefined,
    `expected a refusal with ${code}, but the guards passed`,
  );
  assert.ok(
    isPerpGuardError(thrown),
    `expected PerpGuardError, got ${String(thrown)}`,
  );
  assert.equal(thrown.perpCode, code);

  const verdict = evaluatePerpGuards(intent, ctx);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.violations.some((v) => v.code === code),
    `evaluatePerpGuards did not report ${code} (got ${verdict.violations.map((v) => v.code).join(", ")})`,
  );
}

function passes(intent: PerpIntent, ctx: PerpGuardContext): void {
  const verdict = evaluatePerpGuards(intent, ctx);
  assert.equal(
    verdict.ok,
    true,
    `expected a pass, got: ${verdict.violations.map((v) => `${v.code}: ${v.message}`).join(" | ")}`,
  );
  perpGuards(intent, ctx);
}

// ── baseline ─────────────────────────────────────────────────────────────────

test("the baseline 3× long passes every guard", () => {
  passes(testIntent(), testCtx());
});

// ── arm state ────────────────────────────────────────────────────────────────

test("kill switch refuses an open but not a close", () => {
  const ctx = testCtx({ killSwitch: true });
  refuses(testIntent(), ctx, "KILL_SWITCH");
  passes(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }),
    testCtx({ killSwitch: true, position: testPosition() }),
  );
});

test("execution disabled refuses unless this is a dry run", () => {
  refuses(testIntent(), testCtx({ executionEnabled: false }), "PERPS_DISABLED");
  passes(testIntent(), testCtx({ executionEnabled: false, dryRun: true }));
});

test("perps disabled refuses an open but still lets you get flat", () => {
  const ctx = testCtx({ policy: testPolicy({ perpsEnabled: false }) });
  refuses(testIntent(), ctx, "PERPS_DISABLED");
  passes(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }),
    testCtx({
      policy: testPolicy({ perpsEnabled: false }),
      position: testPosition(),
    }),
  );
});

test("wind-down mode is reduce-only: opens refused, closes allowed", () => {
  const policy = testPolicy({ windDownOnly: true });
  refuses(testIntent(), testCtx({ policy }), "WIND_DOWN_ONLY");
  refuses(
    testIntent({ kind: "perp_increase" }),
    testCtx({ policy, position: testPosition() }),
    "WIND_DOWN_ONLY",
  );
  passes(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }),
    testCtx({ policy, position: testPosition() }),
  );
  passes(
    testIntent({ kind: "perp_reduce", side: "short", collateral: usdc(0n) }),
    testCtx({ policy, position: testPosition() }),
  );
});

test("an uninitialised subaccount refuses everything — accounts are never created by a trade", () => {
  refuses(
    testIntent(),
    testCtx({ accountInitialized: false }),
    "ACCOUNT_NOT_INITIALIZED",
  );
});

// ── market admissibility ─────────────────────────────────────────────────────

test("market denylist and allowlist both refuse", () => {
  refuses(
    testIntent(),
    testCtx({ policy: testPolicy({ marketDenylist: ["SOL-PERP"] }) }),
    "MARKET_DENIED",
  );
  refuses(
    testIntent(),
    testCtx({ policy: testPolicy({ marketAllowlist: ["BTC-PERP"] }) }),
    "MARKET_DENIED",
  );
  passes(
    testIntent(),
    testCtx({ policy: testPolicy({ marketAllowlist: ["SOL-PERP"] }) }),
  );
});

test("a halted market refuses, and an unknown status is treated as unsafe", () => {
  refuses(
    testIntent({ market: fakeMarket({ status: "halted" }) }),
    testCtx(),
    "MARKET_NOT_TRADEABLE",
  );
  refuses(
    testIntent({ market: fakeMarket({ status: "unknown" }) }),
    testCtx(),
    "MARKET_NOT_TRADEABLE",
  );
});

test("a reduce-only market still permits a close", () => {
  const market = fakeMarket({ status: "reduce-only" });
  refuses(testIntent({ market }), testCtx(), "MARKET_NOT_TRADEABLE");
  passes(
    testIntent({
      market,
      kind: "perp_close",
      side: "short",
      collateral: usdc(0n),
    }),
    testCtx({ position: testPosition() }),
  );
});

// ── collateral (the input leg) ───────────────────────────────────────────────

test("a collateral mint outside the permitted set is refused", () => {
  refuses(
    testIntent(),
    testCtx({ policy: testPolicy({ allowedCollateralMints: [] }) }),
    "COLLATERAL_MINT_DENIED",
  );
  refuses(
    testIntent(),
    testCtx({
      policy: testPolicy({ allowedCollateralMints: [NON_QUOTE_MINT] }),
    }),
    "COLLATERAL_MINT_DENIED",
  );
});

test("collateral with no spend-cap bucket is refused rather than priced by an oracle", () => {
  const intent = testIntent({
    collateral: { mint: NON_QUOTE_MINT, amount: 50_000_000n, decimals: 6 },
    build: {
      notional: { mint: NON_QUOTE_MINT, amount: 150_000_000n, decimals: 6 },
    },
  });
  refuses(
    intent,
    testCtx({
      policy: testPolicy({ allowedCollateralMints: [NON_QUOTE_MINT] }),
    }),
    "COLLATERAL_NOT_CAPPABLE",
  );
});

// ── order shape ──────────────────────────────────────────────────────────────

test("slippage above the perps clamp is refused", () => {
  refuses(testIntent({ slippageBps: 500 }), testCtx(), "SLIPPAGE_EXCEEDED");
  passes(testIntent({ slippageBps: 100 }), testCtx());
});

// ── leverage + input-leg caps ────────────────────────────────────────────────

test("leverage above the policy cap is refused", () => {
  refuses(testIntent({ leverage: 5 }), testCtx(), "LEVERAGE_EXCEEDED");
  passes(testIntent({ leverage: 3 }), testCtx());
});

test("per-position collateral cap is enforced on the input leg", () => {
  const policy = testPolicy({
    capsUsdc: {
      maxCollateralPerPosition: 10_000_000n,
      maxNotionalPerPosition: 10_000_000_000n,
      maxPortfolioNotional: 10_000_000_000n,
    },
  });
  refuses(testIntent(), testCtx({ policy }), "COLLATERAL_CAP_EXCEEDED");
});

test("per-position notional cap is enforced", () => {
  const policy = testPolicy({
    capsUsdc: {
      maxCollateralPerPosition: 200_000_000n,
      maxNotionalPerPosition: 100_000_000n,
      maxPortfolioNotional: 10_000_000_000n,
    },
  });
  refuses(testIntent(), testCtx({ policy }), "NOTIONAL_CAP_EXCEEDED");
});

test("a venue under-reporting notional cannot slip the cap — it is re-derived from the input leg", () => {
  // Venue claims 1 USDC of notional; collateral × leverage says 150 USDC.
  const intent = testIntent({ build: { notional: usdc(1_000_000n) } });
  const policy = testPolicy({
    capsUsdc: {
      maxCollateralPerPosition: 200_000_000n,
      maxNotionalPerPosition: 100_000_000n,
      maxPortfolioNotional: 10_000_000_000n,
    },
  });
  refuses(intent, testCtx({ policy }), "NOTIONAL_CAP_EXCEEDED");
});

test("portfolio notional cap counts existing exposure", () => {
  const policy = testPolicy({
    capsUsdc: {
      maxCollateralPerPosition: 200_000_000n,
      maxNotionalPerPosition: 600_000_000n,
      maxPortfolioNotional: 200_000_000n,
    },
  });
  // 100 USDC already open + 150 USDC incoming > 200 USDC cap.
  const exposure = testExposure({
    openPositions: 1,
    notionalByBucket: { sol: 0n, usdc: 100_000_000n },
  });
  refuses(
    testIntent(),
    testCtx({ policy, exposure }),
    "PORTFOLIO_EXPOSURE_EXCEEDED",
  );

  // Same intent fits when nothing is open.
  passes(
    testIntent(),
    testCtx({
      policy: testPolicy({
        capsUsdc: { ...policy.capsUsdc, maxPortfolioNotional: 200_000_000n },
      }),
    }),
  );
});

test("a stale exposure snapshot refuses every open — an unknown total is an unbounded total", () => {
  refuses(
    testIntent(),
    testCtx({ exposure: staleExposure("rpc down") }),
    "EXPOSURE_UNKNOWN",
  );
});

test("the open-position count cap is enforced for new markets only", () => {
  const policy = testPolicy({ maxOpenPositions: 2 });
  const exposure = testExposure({ openPositions: 2 });
  refuses(
    testIntent(),
    testCtx({ policy, exposure }),
    "POSITION_COUNT_EXCEEDED",
  );

  // Increasing a market already held reuses the slot rather than taking a new one.
  passes(
    testIntent({ kind: "perp_increase" }),
    testCtx({ policy, exposure, position: testPosition() }),
  );
});

// ── risk of ruin ─────────────────────────────────────────────────────────────

test("opening inside the minimum liquidation distance is refused", () => {
  // Baseline sits 3000bps from liquidation; raise the floor above it.
  refuses(
    testIntent(),
    testCtx({ policy: testPolicy({ minLiquidationDistanceBps: 5_000 }) }),
    "LIQUIDATION_TOO_CLOSE",
  );
});

test("high leverage trips the liquidation floor even when the caps allow it", () => {
  const policy = testPolicy({
    maxLeverage: 25,
    capsUsdc: {
      maxCollateralPerPosition: 10_000_000_000n,
      maxNotionalPerPosition: 10_000_000_000n,
      maxPortfolioNotional: 10_000_000_000n,
    },
  });
  // 20× long: model liquidation is ~2% away, far inside the 2000bps floor.
  refuses(
    testIntent({
      leverage: 20,
      build: { estimatedLiquidationPrice: undefined },
    }),
    testCtx({ policy }),
    "LIQUIDATION_TOO_CLOSE",
  );
});

test("an unusable liquidation estimate is refused, never assumed safe", () => {
  // No venue estimate, and a maintenance ratio that puts the model on the wrong
  // side of entry (already-underwater) — neither source is usable.
  const intent = testIntent({
    perp: { venueLiquidationPrice: undefined, maintenanceMarginRatio: 0.5 },
  });
  refuses(intent, testCtx(), "LIQUIDATION_UNKNOWN");
});

test("mark/oracle divergence beyond policy is refused", () => {
  refuses(
    testIntent({ markPrice: 150, oraclePrice: 160 }),
    testCtx(),
    "ORACLE_DIVERGENCE",
  );
  passes(testIntent({ markPrice: 150, oraclePrice: 150.5 }), testCtx());
});

// ── funding ──────────────────────────────────────────────────────────────────

test("a missing funding reading is refused rather than assumed to be zero", () => {
  refuses(
    testIntent({ fundingBpsPerHour: null }),
    testCtx(),
    "FUNDING_RATE_UNKNOWN",
  );
});

test("funding beyond the sanity bound is refused in either direction", () => {
  refuses(
    testIntent({ fundingBpsPerHour: 50 }),
    testCtx(),
    "FUNDING_RATE_UNSANE",
  );
  refuses(
    testIntent({ fundingBpsPerHour: -50 }),
    testCtx(),
    "FUNDING_RATE_UNSANE",
  );
});

test("funding is checked directionally — paying is capped, receiving is free", () => {
  // Positive funding = longs pay. A long paying 3bps/h busts the 2bps/h budget.
  refuses(
    testIntent({ side: "long", fundingBpsPerHour: 3 }),
    testCtx(),
    "FUNDING_RATE_ADVERSE",
  );
  // The same market is fine for a short, which RECEIVES that funding.
  passes(testIntent({ side: "short", fundingBpsPerHour: 3 }), testCtx());
  // And the mirror image: a short paying 3bps/h is refused.
  refuses(
    testIntent({ side: "short", fundingBpsPerHour: -3 }),
    testCtx(),
    "FUNDING_RATE_ADVERSE",
  );
  passes(testIntent({ side: "long", fundingBpsPerHour: -3 }), testCtx());
});

test("funding and liquidation rules do not block a close", () => {
  const intent = testIntent({
    kind: "perp_close",
    side: "short",
    collateral: usdc(0n),
    fundingBpsPerHour: null,
    build: { estimatedLiquidationPrice: undefined },
  });
  passes(intent, testCtx({ position: testPosition() }));
});

// ── reduce-only consistency ──────────────────────────────────────────────────

test("reducing with no position is refused", () => {
  refuses(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }),
    testCtx({ position: undefined }),
    "NO_POSITION",
  );
});

test('a "close" that faces the same way as the position is refused as a disguised increase', () => {
  refuses(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }),
    testCtx({ position: testPosition({ side: "short" }) }),
    "POSITION_SIDE_MISMATCH",
  );
});

test("a reduce larger than the position is refused — that is a flip, not a reduction", () => {
  refuses(
    testIntent({ kind: "perp_reduce", side: "short", collateral: usdc(0n) }),
    testCtx({
      position: testPosition({ baseAmount: BASELINE.baseAmount / 2n }),
    }),
    "SIZE_EXCEEDS_POSITION",
  );
});

test("increasing requires an existing position on the same side", () => {
  refuses(
    testIntent({ kind: "perp_increase" }),
    testCtx({ position: undefined }),
    "NO_POSITION",
  );
  refuses(
    testIntent({ kind: "perp_increase", side: "long" }),
    testCtx({ position: testPosition({ side: "short" }) }),
    "POSITION_SIDE_MISMATCH",
  );
  passes(
    testIntent({ kind: "perp_increase", side: "long" }),
    testCtx({ position: testPosition({ side: "long" }) }),
  );
});

// ── structural validation ────────────────────────────────────────────────────

test("a reduceOnly flag inconsistent with the intent kind is a structural refusal", () => {
  refuses(
    testIntent({ perp: { reduceOnly: true } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({
      kind: "perp_close",
      side: "short",
      collateral: usdc(0n),
      perp: { reduceOnly: false },
    }),
    testCtx({ position: testPosition() }),
    "INVALID_PERP_INTENT",
  );
});

test("structural refusals cover zero size, inverted min-out and a mismatched collateral leg", () => {
  refuses(
    testIntent({ perp: { expectedBaseAmount: 0n } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({ perp: { minBaseAmount: BASELINE.baseAmount * 2n } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({ perp: { collateral: usdc(999n) } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({ perp: { entryPrice: 0 } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({ perp: { leverage: Number.NaN } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({ perp: { orderType: "limit", limitPrice: undefined } }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
  refuses(
    testIntent({
      perp: { notional: { mint: NON_QUOTE_MINT, amount: 1n, decimals: 6 } },
    }),
    testCtx(),
    "INVALID_PERP_INTENT",
  );
});

// ── properties ───────────────────────────────────────────────────────────────

test("every perp refusal is also a kernel GuardError, so existing handling still works", () => {
  try {
    perpGuards(testIntent(), testCtx({ killSwitch: true }));
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(isPerpGuardError(err));
    assert.ok(
      isGuardError(err),
      "PerpGuardError must satisfy the kernel error contract",
    );
    assert.equal(err.code, "KILL_SWITCH");
    assert.equal(err.details?.perpCode, "KILL_SWITCH");
  }
});

test("evaluatePerpGuards collects every violation at once", () => {
  const policy = testPolicy({
    maxLeverage: 1,
    maxSlippageBps: 10,
    marketDenylist: ["SOL-PERP"],
  });
  const verdict = evaluatePerpGuards(
    testIntent({ leverage: 3, slippageBps: 500 }),
    testCtx({ policy }),
  );
  assert.equal(verdict.ok, false);
  const codes = verdict.violations.map((v) => v.code);
  assert.ok(codes.includes("MARKET_DENIED"));
  assert.ok(codes.includes("SLIPPAGE_EXCEEDED"));
  assert.ok(codes.includes("LEVERAGE_EXCEEDED"));
  assert.ok(verdict.violations.length >= 3);
});

test("the guards are pure — they mutate neither the intent nor the context", () => {
  const intent = testIntent();
  const ctx = testCtx();
  const intentSnapshot = JSON.stringify(intent, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const ctxSnapshot = JSON.stringify(ctx, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );

  const first = evaluatePerpGuards(intent, ctx);
  const second = evaluatePerpGuards(intent, ctx);

  assert.deepEqual(first, second, "the guards must be deterministic");
  assert.equal(
    JSON.stringify(intent, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    intentSnapshot,
  );
  assert.equal(
    JSON.stringify(ctx, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ctxSnapshot,
  );
});

test("collateral of USDC maps to the usdc cap bucket, as the baseline assumes", () => {
  assert.equal(testIntent().perp.collateral.mint, USDC_MINT);
});

test("positionLiquidationDistanceBps reports live risk and returns undefined when unknown", () => {
  assert.equal(
    positionLiquidationDistanceBps(
      testPosition({ markPrice: 150, liquidationPrice: 105 }),
    ),
    3000,
  );
  assert.equal(
    positionLiquidationDistanceBps(
      testPosition({ liquidationPrice: undefined }),
    ),
    undefined,
  );
});
