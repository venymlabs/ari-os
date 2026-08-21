/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { toBaseUnits } from "../src/kernel/money.js";
import {
  bondingCurveMarketCap,
  calculateFeeTier,
  type CurveReserves,
  CurveMathError,
  curveFeeBps,
  curveProgressPct,
  curveUiPrice,
  type FeeTier,
  quoteBuyForSolBudget,
  quoteSell,
  solCostForTokens,
  solForTokens,
  tokensForSol,
} from "../src/pools/pumpfun/math.js";

/** A standard pump.fun launch, at its seeded starting reserves. */
const FRESH: CurveReserves = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n, // 30 SOL
  realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
};

/** Mid-curve: ~30 SOL of real buys have gone through. */
const MID: CurveReserves = {
  virtualTokenReserves: 536_500_000_000_000n,
  virtualSolReserves: 60_000_000_000n,
  realTokenReserves: 256_600_000_000_000n,
  realSolReserves: 30_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
};

const ONE_SOL = toBaseUnits(1, 9);

// ── constant product ─────────────────────────────────────────────────────────

test("buying more SOL of a token yields more tokens, but at a worse rate each time", () => {
  const a = tokensForSol(MID, ONE_SOL);
  const b = tokensForSol(MID, 2n * ONE_SOL);
  const c = tokensForSol(MID, 4n * ONE_SOL);
  assert.ok(a < b && b < c, "monotonic");
  // Sub-linear: doubling the spend does not double the tokens.
  assert.ok(b < 2n * a, `2 SOL bought ${b}, twice 1 SOL is ${2n * a}`);
  assert.ok(c < 2n * b);
});

test("solCostForTokens inverts tokensForSol to within the on-chain rounding", () => {
  for (const budget of [ONE_SOL / 100n, ONE_SOL, 5n * ONE_SOL]) {
    const tokens = tokensForSol(MID, budget);
    const cost = solCostForTokens(MID, tokens);
    const delta = budget > cost ? budget - cost : cost - budget;
    assert.ok(
      delta <= 2n,
      `budget ${budget} vs recomputed cost ${cost} (delta ${delta})`,
    );
  }
});

test("tokensForSol is clamped to the real token reserves — the curve cannot sell what it lacks", () => {
  const nearlyEmpty: CurveReserves = { ...MID, realTokenReserves: 1_000n };
  assert.equal(tokensForSol(nearlyEmpty, 1_000n * ONE_SOL), 1_000n);
});

test("zero and negative inputs produce zero, not a throw", () => {
  assert.equal(tokensForSol(MID, 0n), 0n);
  assert.equal(tokensForSol(MID, -5n), 0n);
  assert.equal(solCostForTokens(MID, 0n), 0n);
  assert.equal(solForTokens(MID, 0n), 0n);
});

test("a token amount that would drain the virtual reserve is refused", () => {
  assert.throws(
    () => solCostForTokens(MID, MID.virtualTokenReserves),
    CurveMathError,
  );
  assert.throws(
    () => solCostForTokens(MID, MID.virtualTokenReserves + 1n),
    CurveMathError,
  );
});

test("empty virtual reserves are a hard error, never a division by zero", () => {
  const broken: CurveReserves = { ...MID, virtualTokenReserves: 0n };
  assert.throws(() => tokensForSol(broken, ONE_SOL), CurveMathError);
  assert.throws(
    () => solForTokens({ ...MID, virtualSolReserves: 0n }, 1_000n),
    CurveMathError,
  );
});

test("a round trip through the curve loses value to price impact, never gains", () => {
  const tokens = tokensForSol(MID, ONE_SOL);
  const back = solForTokens(MID, tokens);
  assert.ok(back < ONE_SOL, `bought for ${ONE_SOL}, sells back for ${back}`);
});

// ── fees ─────────────────────────────────────────────────────────────────────

test("curve fee is protocol + creator; the LP leg belongs to PumpSwap, not the curve", () => {
  assert.equal(
    curveFeeBps({ lpFeeBps: 20n, protocolFeeBps: 95n, creatorFeeBps: 5n }),
    100n,
  );
});

test("fee tiers pick the highest threshold at or below the market cap", () => {
  const fees = (n: bigint) => ({
    lpFeeBps: 0n,
    protocolFeeBps: n,
    creatorFeeBps: 0n,
  });
  const tiers: FeeTier[] = [
    { marketCapLamportsThreshold: 0n, fees: fees(100n) },
    { marketCapLamportsThreshold: 1_000n, fees: fees(80n) },
    { marketCapLamportsThreshold: 10_000n, fees: fees(50n) },
  ];
  assert.equal(calculateFeeTier(tiers, 0n).protocolFeeBps, 100n);
  assert.equal(calculateFeeTier(tiers, 999n).protocolFeeBps, 100n);
  assert.equal(calculateFeeTier(tiers, 1_000n).protocolFeeBps, 80n);
  assert.equal(calculateFeeTier(tiers, 9_999n).protocolFeeBps, 80n);
  assert.equal(calculateFeeTier(tiers, 1_000_000n).protocolFeeBps, 50n);
});

test("a market cap below the first threshold falls back to the first tier", () => {
  const tiers: FeeTier[] = [
    {
      marketCapLamportsThreshold: 500n,
      fees: { lpFeeBps: 0n, protocolFeeBps: 200n, creatorFeeBps: 0n },
    },
    {
      marketCapLamportsThreshold: 5_000n,
      fees: { lpFeeBps: 0n, protocolFeeBps: 50n, creatorFeeBps: 0n },
    },
  ];
  assert.equal(calculateFeeTier(tiers, 10n).protocolFeeBps, 200n);
  assert.throws(() => calculateFeeTier([], 1n), CurveMathError);
});

test("market cap uses virtual reserves against the full mint supply", () => {
  const mc = bondingCurveMarketCap({
    mintSupply: FRESH.tokenTotalSupply,
    virtualSolReserves: FRESH.virtualSolReserves,
    virtualTokenReserves: FRESH.virtualTokenReserves,
  });
  // 30 SOL × 1e15 / 1.073e15 ≈ 27.96 SOL
  assert.ok(mc > toBaseUnits(27, 9) && mc < toBaseUnits(29, 9), `mcap ${mc}`);
  assert.throws(
    () =>
      bondingCurveMarketCap({
        mintSupply: 1n,
        virtualSolReserves: 1n,
        virtualTokenReserves: 0n,
      }),
    CurveMathError,
  );
});

// ── buy quote ────────────────────────────────────────────────────────────────

test("a buy sized in SOL spends the whole budget including the fee", () => {
  const feeBps = 100n; // 1%
  const q = quoteBuyForSolBudget(MID, ONE_SOL, feeBps, 100);
  assert.ok(q.tokenAmount > 0n);
  assert.equal(q.totalLamports, q.solCostLamports + q.feeLamports);
  assert.ok(
    q.totalLamports <= ONE_SOL + 2n,
    `total ${q.totalLamports} exceeds the ${ONE_SOL} budget`,
  );
  assert.ok(
    q.totalLamports > (ONE_SOL * 99n) / 100n,
    "the budget should be nearly fully used",
  );
  assert.equal(q.feeLamports, (q.solCostLamports * feeBps) / 10_000n);
});

test("max_sol_cost sits above the quote and grows with the slippage bound", () => {
  const tight = quoteBuyForSolBudget(MID, ONE_SOL, 100n, 50);
  const loose = quoteBuyForSolBudget(MID, ONE_SOL, 100n, 500);
  assert.ok(tight.maxSolCostLamports >= tight.totalLamports);
  assert.ok(loose.maxSolCostLamports > tight.maxSolCostLamports);
  assert.equal(
    loose.maxSolCostLamports,
    (loose.totalLamports * 10_500n) / 10_000n,
  );
});

test("a higher fee buys fewer tokens for the same budget", () => {
  const cheap = quoteBuyForSolBudget(MID, ONE_SOL, 10n, 100);
  const dear = quoteBuyForSolBudget(MID, ONE_SOL, 500n, 100);
  assert.ok(dear.tokenAmount < cheap.tokenAmount);
});

test("price impact is positive and grows with size", () => {
  const small = quoteBuyForSolBudget(MID, ONE_SOL / 100n, 100n, 100);
  const large = quoteBuyForSolBudget(MID, 10n * ONE_SOL, 100n, 100);
  assert.ok(small.priceImpactPct >= 0);
  assert.ok(large.priceImpactPct > small.priceImpactPct);
});

test("buy quotes refuse bad inputs and completed curves", () => {
  assert.throws(() => quoteBuyForSolBudget(MID, 0n, 100n, 100), CurveMathError);
  assert.throws(
    () => quoteBuyForSolBudget(MID, ONE_SOL, -1n, 100),
    CurveMathError,
  );
  assert.throws(
    () => quoteBuyForSolBudget(MID, ONE_SOL, 100n, -5),
    CurveMathError,
  );
  assert.throws(
    () => quoteBuyForSolBudget(MID, ONE_SOL, 100n, Number.NaN),
    CurveMathError,
  );
  assert.throws(
    () => quoteBuyForSolBudget({ ...MID, complete: true }, ONE_SOL, 100n, 100),
    CurveMathError,
  );
  assert.throws(
    () => quoteBuyForSolBudget(MID, 1n, 100n, 100),
    CurveMathError,
    "dust budget buys no whole token unit",
  );
});

// ── sell quote ───────────────────────────────────────────────────────────────

test("a sell nets gross minus fee, and min_sol_output sits below the net", () => {
  const amount = 1_000_000_000n; // 1000 tokens at 6dp
  const q = quoteSell(MID, amount, 100n, 100);
  assert.equal(q.netSolLamports, q.grossSolLamports - q.feeLamports);
  assert.equal(q.feeLamports, (q.grossSolLamports * 100n) / 10_000n);
  assert.ok(q.minSolOutputLamports < q.netSolLamports);
  assert.equal(q.minSolOutputLamports, (q.netSolLamports * 9_900n) / 10_000n);
});

test("a wider slippage bound lowers min_sol_output, and 100% is refused", () => {
  const tight = quoteSell(MID, 1_000_000_000n, 100n, 10);
  const loose = quoteSell(MID, 1_000_000_000n, 100n, 1_000);
  assert.ok(loose.minSolOutputLamports < tight.minSolOutputLamports);
  assert.throws(() => quoteSell(MID, 1_000n, 100n, 10_000), CurveMathError);
});

test("sell quotes refuse bad inputs and completed curves", () => {
  assert.throws(() => quoteSell(MID, 0n, 100n, 100), CurveMathError);
  assert.throws(() => quoteSell(MID, 1_000n, -1n, 100), CurveMathError);
  assert.throws(
    () => quoteSell({ ...MID, complete: true }, 1_000n, 100n, 100),
    CurveMathError,
  );
});

// ── display ──────────────────────────────────────────────────────────────────

test("curve price is SOL per whole token and rises as the curve fills", () => {
  const fresh = curveUiPrice(FRESH, 6);
  const mid = curveUiPrice(MID, 6);
  assert.ok(mid > fresh, `${mid} should be above ${fresh}`);
  // 30 SOL / 1.073e15 base units, scaled for 6dp tokens → ~2.8e-8 SOL each.
  assert.ok(fresh > 1e-9 && fresh < 1e-6, `fresh price ${fresh}`);
  assert.equal(curveUiPrice({ ...MID, virtualTokenReserves: 0n }, 6), 0);
});

test("progress is measured against the launch’s initial real reserves and is clamped", () => {
  const initial = FRESH.realTokenReserves;
  assert.equal(curveProgressPct(FRESH, initial), 0);
  assert.ok(
    Math.abs(curveProgressPct(MID, initial) - 67.6) < 1,
    `${curveProgressPct(MID, initial)}`,
  );
  assert.equal(
    curveProgressPct({ ...MID, realTokenReserves: 0n }, initial),
    100,
  );
  assert.equal(
    curveProgressPct({ ...MID, realTokenReserves: initial * 2n }, initial),
    0,
    "clamped, never negative",
  );
  assert.equal(curveProgressPct(MID, 0n), 0);
});
