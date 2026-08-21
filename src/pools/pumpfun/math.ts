/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PUMP_TOKEN_DECIMALS } from "./constants.js";

/**
 * pump.fun bonding-curve mathematics — pure `bigint`, no floats anywhere on the
 * value path.
 *
 * The curve is a constant product over **virtual** reserves. Virtual reserves are
 * seeded above zero so the very first buy has a finite price; the *real* reserves
 * are what can actually be withdrawn, and they are what a liquidity floor must be
 * measured against. The invariant is
 *
 *     k = virtualSolReserves · virtualTokenReserves
 *
 * and every quote below reproduces the on-chain integer arithmetic — including its
 * `+ 1` round-ups — rather than a float approximation of it. Matching the rounding
 * matters: an off-by-one in the wrong direction turns a `max_sol_cost` into a
 * failed transaction, or worse, a silently worse fill.
 */

export interface CurveReserves {
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly complete: boolean;
}

export class CurveMathError extends RangeError {}

function assertPositive(name: string, v: bigint): void {
  if (v <= 0n) throw new CurveMathError(`${name} must be positive, got ${v}`);
}

// ── fee tiers ────────────────────────────────────────────────────────────────

/** One `Fees` row from the pump fee program. */
export interface Fees {
  readonly lpFeeBps: bigint;
  readonly protocolFeeBps: bigint;
  readonly creatorFeeBps: bigint;
}

export interface FeeTier {
  readonly marketCapLamportsThreshold: bigint;
  readonly fees: Fees;
}

/**
 * Market cap in lamports, as the program computes it:
 * `virtualSolReserves · mintSupply / virtualTokenReserves`.
 */
export function bondingCurveMarketCap(args: {
  readonly mintSupply: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
}): bigint {
  assertPositive("virtualTokenReserves", args.virtualTokenReserves);
  return (
    (args.virtualSolReserves * args.mintSupply) / args.virtualTokenReserves
  );
}

/**
 * Pick the fee tier for a market cap. Mirrors `pump-fees-math::calculate_fee_tier`:
 * below the first threshold the first tier applies; otherwise the **highest**
 * threshold at or below the market cap wins.
 */
export function calculateFeeTier(
  feeTiers: readonly FeeTier[],
  marketCapLamports: bigint,
): Fees {
  const first = feeTiers[0];
  if (!first) throw new CurveMathError("fee tier table is empty");
  if (marketCapLamports < first.marketCapLamportsThreshold) return first.fees;
  for (let i = feeTiers.length - 1; i >= 0; i--) {
    const tier = feeTiers[i] as FeeTier;
    if (marketCapLamports >= tier.marketCapLamportsThreshold) return tier.fees;
  }
  return first.fees;
}

/**
 * Total bps a bonding-curve trade pays: protocol + creator. `lpFeeBps` belongs to
 * PumpSwap pools, which have LPs; a curve does not, so counting it here would
 * overstate a buy's cost and — worse — understate a sell's proceeds, weakening
 * `min_sol_output`. Kept explicit rather than folded in silently.
 */
export function curveFeeBps(fees: Fees): bigint {
  return fees.protocolFeeBps + fees.creatorFeeBps;
}

// ── quoting ──────────────────────────────────────────────────────────────────

/**
 * Tokens received for `solIn` lamports **before** fees, reproducing the on-chain
 * form `tokens = virtualToken − (k / (virtualSol + solIn) + 1)`, clamped to the
 * real token reserves (the curve cannot sell tokens it does not hold).
 */
export function tokensForSol(r: CurveReserves, solIn: bigint): bigint {
  assertPositive("virtualSolReserves", r.virtualSolReserves);
  assertPositive("virtualTokenReserves", r.virtualTokenReserves);
  if (solIn <= 0n) return 0n;
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const newSol = r.virtualSolReserves + solIn;
  const newTokens = k / newSol + 1n;
  const out =
    r.virtualTokenReserves > newTokens
      ? r.virtualTokenReserves - newTokens
      : 0n;
  return out < r.realTokenReserves ? out : r.realTokenReserves;
}

/**
 * Lamports the curve charges for exactly `tokenAmount` tokens, **before** fees:
 * `newVirtualSol = k / (virtualToken − amount) + 1`, cost = the delta. This is the
 * direction the program actually computes, because `buy` takes a token amount.
 */
export function solCostForTokens(
  r: CurveReserves,
  tokenAmount: bigint,
): bigint {
  assertPositive("virtualSolReserves", r.virtualSolReserves);
  assertPositive("virtualTokenReserves", r.virtualTokenReserves);
  if (tokenAmount <= 0n) return 0n;
  if (tokenAmount >= r.virtualTokenReserves) {
    throw new CurveMathError(
      "token amount would drain the virtual token reserve",
    );
  }
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const newSol = k / (r.virtualTokenReserves - tokenAmount) + 1n;
  return newSol - r.virtualSolReserves;
}

/** Lamports returned for selling `tokenAmount`, **before** fees. */
export function solForTokens(r: CurveReserves, tokenAmount: bigint): bigint {
  assertPositive("virtualSolReserves", r.virtualSolReserves);
  assertPositive("virtualTokenReserves", r.virtualTokenReserves);
  if (tokenAmount <= 0n) return 0n;
  return (
    (tokenAmount * r.virtualSolReserves) /
    (r.virtualTokenReserves + tokenAmount)
  );
}

export interface BuyQuote {
  /** Tokens the buy instruction will request (`amount`). */
  readonly tokenAmount: bigint;
  /** Curve cost before fees. */
  readonly solCostLamports: bigint;
  readonly feeLamports: bigint;
  /** Cost + fee, the honest all-in price at the quoted state. */
  readonly totalLamports: bigint;
  /** `max_sol_cost` — total with the slippage bound applied. */
  readonly maxSolCostLamports: bigint;
  readonly feeBps: bigint;
  /** Lamports per token base unit at the quoted state (pre-trade spot). */
  readonly spotPriceLamports: number;
  /** Percent the trade itself moves the curve price. */
  readonly priceImpactPct: number;
}

/**
 * Quote a buy sized by **SOL to spend** — the way a human and an LLM think about
 * it, and the way the kernel caps it (the input leg is what leaves the wallet).
 *
 * The instruction takes a token amount, so the budget is first stripped of the fee
 * that will be charged on top of the curve cost, then converted to tokens. The
 * resulting `maxSolCostLamports` is what the transaction commits to and is always
 * ≥ `totalLamports`.
 */
export function quoteBuyForSolBudget(
  r: CurveReserves,
  solBudgetLamports: bigint,
  feeBps: bigint,
  slippageBps: number,
): BuyQuote {
  if (solBudgetLamports <= 0n)
    throw new CurveMathError("sol budget must be positive");
  if (feeBps < 0n) throw new CurveMathError("feeBps must be non-negative");
  if (!Number.isFinite(slippageBps) || slippageBps < 0)
    throw new CurveMathError("slippageBps must be finite and non-negative");
  if (r.complete)
    throw new CurveMathError("curve has completed — it no longer accepts buys");

  // Budget includes the fee, so the curve leg is budget · 10_000 / (10_000 + feeBps).
  const curveBudget = (solBudgetLamports * 10_000n) / (10_000n + feeBps);
  const tokenAmount = tokensForSol(r, curveBudget);
  if (tokenAmount <= 0n)
    throw new CurveMathError("budget too small to buy a single token unit");

  const solCostLamports = solCostForTokens(r, tokenAmount);
  const feeLamports = (solCostLamports * feeBps) / 10_000n;
  const totalLamports = solCostLamports + feeLamports;
  const maxSolCostLamports =
    (totalLamports * BigInt(10_000 + Math.round(slippageBps))) / 10_000n;

  const spot = Number(r.virtualSolReserves) / Number(r.virtualTokenReserves);
  const effective = Number(solCostLamports) / Number(tokenAmount);
  const priceImpactPct = spot > 0 ? ((effective - spot) / spot) * 100 : 0;

  return {
    tokenAmount,
    solCostLamports,
    feeLamports,
    totalLamports,
    maxSolCostLamports,
    feeBps,
    spotPriceLamports: spot,
    priceImpactPct,
  };
}

export interface SellQuote {
  readonly tokenAmount: bigint;
  readonly grossSolLamports: bigint;
  readonly feeLamports: bigint;
  readonly netSolLamports: bigint;
  /** `min_sol_output` — net with the slippage bound applied. */
  readonly minSolOutputLamports: bigint;
  readonly feeBps: bigint;
  readonly spotPriceLamports: number;
  readonly priceImpactPct: number;
}

/** Quote a sell sized by token amount (the input leg for a sell is the token itself). */
export function quoteSell(
  r: CurveReserves,
  tokenAmount: bigint,
  feeBps: bigint,
  slippageBps: number,
): SellQuote {
  if (tokenAmount <= 0n)
    throw new CurveMathError("token amount must be positive");
  if (feeBps < 0n) throw new CurveMathError("feeBps must be non-negative");
  if (!Number.isFinite(slippageBps) || slippageBps < 0)
    throw new CurveMathError("slippageBps must be finite and non-negative");
  if (slippageBps >= 10_000)
    throw new CurveMathError("slippageBps must be below 100%");
  if (r.complete)
    throw new CurveMathError(
      "curve has completed — it no longer accepts sells",
    );

  const grossSolLamports = solForTokens(r, tokenAmount);
  const feeLamports = (grossSolLamports * feeBps) / 10_000n;
  const netSolLamports = grossSolLamports - feeLamports;
  const minSolOutputLamports =
    (netSolLamports * BigInt(10_000 - Math.round(slippageBps))) / 10_000n;

  const spot = Number(r.virtualSolReserves) / Number(r.virtualTokenReserves);
  const effective = Number(grossSolLamports) / Number(tokenAmount);
  const priceImpactPct = spot > 0 ? ((effective - spot) / spot) * 100 : 0;

  return {
    tokenAmount,
    grossSolLamports,
    feeLamports,
    netSolLamports,
    minSolOutputLamports,
    feeBps,
    spotPriceLamports: spot,
    priceImpactPct,
  };
}

// ── display helpers ──────────────────────────────────────────────────────────

/** UI price: SOL per whole token. Display only — never feed this to a cap. */
export function curveUiPrice(
  r: CurveReserves,
  tokenDecimals = PUMP_TOKEN_DECIMALS,
): number {
  if (r.virtualTokenReserves <= 0n) return 0;
  const lamportsPerBaseUnit =
    Number(r.virtualSolReserves) / Number(r.virtualTokenReserves);
  return lamportsPerBaseUnit * 10 ** (tokenDecimals - 9);
}

/**
 * How far the curve is toward migration, 0..100. Derived from real token reserves
 * consumed against the launch's initial real reserves, which the caller supplies
 * from the `Global` account (it is not stored on the curve).
 */
export function curveProgressPct(
  r: CurveReserves,
  initialRealTokenReserves: bigint,
): number {
  if (initialRealTokenReserves <= 0n) return 0;
  const sold = initialRealTokenReserves - r.realTokenReserves;
  const pct = (Number(sold) / Number(initialRealTokenReserves)) * 100;
  return Math.min(100, Math.max(0, pct));
}
