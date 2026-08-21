/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { type QuoteBucket, quoteBucketFor } from "../kernel/money.js";
import type { PerpPosition } from "./types.js";

/**
 * Aggregate portfolio perp exposure, denominated per input-leg bucket.
 *
 * Pure and synchronous: the caller does the network read, this does the maths.
 * That split is what makes the portfolio cap unit-testable and keeps every guard
 * free of I/O.
 */
export interface PortfolioExposure {
  readonly openPositions: number;
  readonly notionalByBucket: Readonly<Record<QuoteBucket, bigint>>;
  readonly collateralByBucket: Readonly<Record<QuoteBucket, bigint>>;
  /**
   * Set when the exposure could not be established cleanly — the venue read
   * failed, or a position is denominated in something we cannot bucket. Guards
   * MUST refuse to open into a stale exposure snapshot: an unknown existing
   * exposure plus a new position is an unbounded total.
   */
  readonly stale: boolean;
  readonly staleReason: string | undefined;
  /** Positions whose collateral mint is not a recognised quote asset. */
  readonly unbucketed: number;
}

const ZERO: Readonly<Record<QuoteBucket, bigint>> = { sol: 0n, usdc: 0n };

/** An exposure snapshot that every opening guard will refuse. Use whenever a read fails. */
export function staleExposure(reason: string): PortfolioExposure {
  return {
    openPositions: 0,
    notionalByBucket: ZERO,
    collateralByBucket: ZERO,
    stale: true,
    staleReason: reason,
    unbucketed: 0,
  };
}

export function emptyExposure(): PortfolioExposure {
  return {
    openPositions: 0,
    notionalByBucket: ZERO,
    collateralByBucket: ZERO,
    stale: false,
    staleReason: undefined,
    unbucketed: 0,
  };
}

export function exposureFrom(
  positions: readonly PerpPosition[],
): PortfolioExposure {
  const notional: Record<QuoteBucket, bigint> = { sol: 0n, usdc: 0n };
  const collateral: Record<QuoteBucket, bigint> = { sol: 0n, usdc: 0n };
  let unbucketed = 0;

  for (const p of positions) {
    const bucket = quoteBucketFor(p.notional.mint);
    const collBucket = quoteBucketFor(p.collateral.mint);
    if (bucket === null || collBucket === null) {
      unbucketed += 1;
      continue;
    }
    // Absolute magnitude: a short's exposure is exposure, not negative exposure.
    notional[bucket] +=
      p.notional.amount < 0n ? -p.notional.amount : p.notional.amount;
    collateral[collBucket] +=
      p.collateral.amount < 0n ? -p.collateral.amount : p.collateral.amount;
  }

  return {
    openPositions: positions.length,
    notionalByBucket: notional,
    collateralByBucket: collateral,
    stale: unbucketed > 0,
    staleReason:
      unbucketed > 0
        ? `${unbucketed} position(s) use a collateral asset with no spend-cap bucket`
        : undefined,
    unbucketed,
  };
}

/** The position in `symbol`, if any. Case-insensitive on the canonical symbol. */
export function positionIn(
  positions: readonly PerpPosition[],
  symbol: string,
): PerpPosition | undefined {
  const want = symbol.trim().toUpperCase();
  return positions.find((p) => p.symbol.toUpperCase() === want);
}
