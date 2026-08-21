/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { USDC_MINT } from "../../kernel/money.js";
import type { PerpMarket, PerpMarketStatus } from "../types.js";
import {
  absBigInt,
  BASE_DECIMALS,
  BASE_PRECISION,
  type Bn,
  bnToBigInt,
  bnToNumber,
  decodeMarketName,
  type DriftPerpMarketAccount,
  MARGIN_PRECISION,
  PRICE_PRECISION,
  QUOTE_DECIMALS,
} from "./sdk-types.js";

/**
 * Pure Drift→domain conversions.
 *
 * Kept out of `drift-venue.ts` on purpose: these are the parts with real
 * arithmetic in them, and being SDK-free functions of plain values they are
 * unit-tested directly. The adapter around them is then only plumbing.
 */

export const DRIFT_VENUE_ID = "drift";
/** Drift perps settle in USDC; quote precision is 1e6, i.e. USDC base units exactly. */
export const DRIFT_SETTLEMENT_MINT = USDC_MINT;

/**
 * Map Drift's market status enum to the domain status.
 * Anything unrecognised becomes 'unknown', which the guards refuse — a new
 * status variant appearing in a future SDK must not silently read as tradeable.
 */
export function driftMarketStatus(key: string | undefined): PerpMarketStatus {
  switch (key) {
    case "active":
      return "active";
    case "reduceOnly":
      return "reduce-only";
    case "initialized":
    case "paused":
    case "fillPaused":
    case "ammPaused":
    case "fundingPaused":
    case "withdrawPaused":
    case "settlement":
    case "delisted":
      return "halted";
    default:
      return "unknown";
  }
}

/**
 * Drift's hourly funding rate → signed basis points per hour.
 *
 * `amm.lastFundingRate` is stored in PRICE_PRECISION × FUNDING_RATE_BUFFER
 * (1e6 × 1e3 = 1e9). Dividing out the buffer leaves a PRICE_PRECISION quantity,
 * which divided by the PRICE_PRECISION oracle TWAP yields a dimensionless
 * hourly fraction; ×10 000 makes it bps.
 *
 *   bps/h = (lastFundingRate / 1e3) / oracleTwap × 10 000
 *
 * Worked check: SOL at $150 (twap = 150_000_000) with a 0.001%/h rate gives
 * lastFundingRate = 1_500_000 and this returns 0.1 bps/h. Pinned in the tests.
 *
 * Positive = longs pay shorts, matching `FundingRate.bpsPerHour`.
 *
 * If this conversion is mis-scaled against a future SDK, the result lands far
 * outside the guards' `maxFundingRateBpsPerHour` sanity bound and the intent is
 * refused. The failure mode is a refusal, not a bad fill.
 */
export function fundingBpsPerHour(
  lastFundingRate: bigint | undefined,
  oracleTwap: bigint | undefined,
): number | undefined {
  if (lastFundingRate === undefined || oracleTwap === undefined)
    return undefined;
  if (oracleTwap <= 0n) return undefined;
  const bps = (Number(lastFundingRate) / 1_000 / Number(oracleTwap)) * 10_000;
  return Number.isFinite(bps) ? bps : undefined;
}

/** Drift stores margin ratios in MARGIN_PRECISION (1e4); the domain wants a fraction. */
export function marginRatioToFraction(
  ratio: number | undefined,
): number | undefined {
  if (!Number.isInteger(ratio) || ratio === undefined || ratio < 0)
    return undefined;
  const f = ratio / Number(MARGIN_PRECISION);
  return Number.isFinite(f) && f >= 0 && f < 1 ? f : undefined;
}

export function maxLeverageFromInitialMargin(
  initialMarginFraction: number | undefined,
): number | undefined {
  if (initialMarginFraction === undefined || initialMarginFraction <= 0)
    return undefined;
  const l = 1 / initialMarginFraction;
  return Number.isFinite(l) && l > 0 ? l : undefined;
}

export interface DriftMarketConversion {
  readonly market: PerpMarket | undefined;
  readonly problem: string | undefined;
}

/**
 * Convert a Drift perp market account. Returns a `problem` string instead of a
 * market whenever a safety-relevant field is missing — the caller drops the
 * market rather than synthesising a default margin ratio.
 */
export function toPerpMarket(
  account: DriftPerpMarketAccount,
  takerFeeBps: number,
): DriftMarketConversion {
  const symbol = decodeMarketName(account.name);
  if (!symbol)
    return {
      market: undefined,
      problem: `market ${account.marketIndex} has no decodable name`,
    };

  const initial = marginRatioToFraction(account.marginRatioInitial);
  const maintenance = marginRatioToFraction(account.marginRatioMaintenance);
  if (initial === undefined || maintenance === undefined) {
    return { market: undefined, problem: `${symbol}: unusable margin ratios` };
  }
  const maxLeverage = maxLeverageFromInitialMargin(initial);
  if (maxLeverage === undefined)
    return {
      market: undefined,
      problem: `${symbol}: unusable initial margin ratio`,
    };

  const step =
    bnToBigInt(
      account.amm.orderStepSize ?? account.amm.baseAssetAmountStepSize,
    ) ?? 0n;
  const minSize = bnToBigInt(account.amm.minOrderSize) ?? step;

  return {
    market: {
      venue: DRIFT_VENUE_ID,
      symbol,
      venueMarketIndex: account.marketIndex,
      baseSymbol: symbol.replace(/-PERP$/, ""),
      baseDecimals: BASE_DECIMALS,
      quoteSymbol: "USDC",
      quoteDecimals: QUOTE_DECIMALS,
      minBaseAmount: minSize > 0n ? minSize : 0n,
      baseStep: step > 0n ? step : 1n,
      maxLeverage,
      initialMarginRatio: initial,
      maintenanceMarginRatio: maintenance,
      takerFeeBps,
      status: driftMarketStatus(anchorStatusKey(account)),
    },
    problem: undefined,
  };
}

function anchorStatusKey(account: DriftPerpMarketAccount): string | undefined {
  const status = account.status;
  if (!status || typeof status !== "object") return undefined;
  const keys = Object.keys(status);
  return keys.length > 0 ? keys[0] : undefined;
}

/** BASE_PRECISION size → domain base units (identical scale, but the intent is explicit). */
export function baseAmountToUnits(amount: Bn | undefined): bigint | undefined {
  return bnToBigInt(amount);
}

/** Absolute base size and the side implied by a signed Drift position. */
export function splitSignedBase(signed: bigint): {
  side: "long" | "short";
  magnitude: bigint;
} {
  return signed < 0n
    ? { side: "short", magnitude: -signed }
    : { side: "long", magnitude: signed };
}

/**
 * Notional in QUOTE (USDC) base units from a base-precision size and a
 * PRICE_PRECISION price — integer maths throughout, so this never drifts.
 *
 *   notional = |base| × price / BASE_PRECISION      (price already 1e6 = USDC scale)
 */
export function notionalQuoteUnits(
  baseUnits: bigint,
  pricePrecisionPrice: bigint,
): bigint {
  return (absBigInt(baseUnits) * pricePrecisionPrice) / BASE_PRECISION;
}

/** A PRICE_PRECISION BN → a plain price. Negative (Drift's "no liquidation price") becomes undefined. */
export function priceFrom(
  value: Bn | undefined,
  opts: { negativeMeans?: "undefined" | "zero" } = {},
): number | undefined {
  const raw = bnToBigInt(value);
  if (raw === undefined) return undefined;
  if (raw < 0n) return opts.negativeMeans === "zero" ? 0 : undefined;
  return bnToNumber(value, PRICE_PRECISION);
}
