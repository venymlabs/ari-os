/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refusal codes for the pools layer.
 *
 * These sit *in front of* the kernel, never instead of it. `TradeGateway.execute()`
 * still re-validates every intent this package produces from scratch; a pool guard
 * that passes buys you nothing at the metal. What these add is the handful of
 * checks the kernel cannot express today — LP position sizing, bonding-curve
 * liquidity floors, rug-heat, and rebalance economics — all of them **pure,
 * synchronous, and fail-closed**: a missing input is a rejection, never a pass.
 */
export type PoolGuardCode =
  // ── spend / sizing ──
  | "POOL_SPEND_CAP" // input-leg spend above the per-position cap
  | "POOL_POSITION_CAP" // LP notional above maxPositionQuote
  | "POOL_MAX_POSITIONS" // already at maxConcurrentPositions
  | "POOL_BASE_LEG_CAP" // the non-quote leg is too large a share of holdings
  // ── token safety ──
  | "POOL_MINT_AUTHORITY" // live mint authority and not allowlisted
  | "POOL_FREEZE_AUTHORITY" // live freeze authority and not allowlisted
  | "POOL_TOKEN2022" // Token-2022 leg while unsupported
  | "POOL_RUG_HEAT" // rug-heat at/above the hard rejection threshold
  | "POOL_LIQUIDITY_FLOOR" // pool/curve below the minimum-liquidity floor
  // ── execution shape ──
  | "POOL_SLIPPAGE" // requested slippage above the bound
  | "POOL_RANGE_INVALID" // bin/level range is malformed or too wide
  | "POOL_MIGRATED" // pump.fun curve already migrated — use the Jupiter path
  | "POOL_NOT_MIGRATED" // asked for the AMM path on a live curve
  | "POOL_UNSUPPORTED_CURVE" // curve needs an instruction variant we do not build
  | "POOL_EXTRA_SIGNER" // venue tx needs a signer the wallet cannot provide
  | "POOL_MULTI_TX" // venue produced >1 transaction; the intent contract is 1 tx
  // ── rebalance ──
  | "REBALANCE_TOO_SOON" // inside minIntervalMs
  | "REBALANCE_DAILY_CAP" // maxPerDay already spent
  | "REBALANCE_NOT_DRIFTED" // active level still inside the no-churn band
  | "REBALANCE_UNECONOMIC" // projected cost exceeds fees earned + IL recovered
  // ── plumbing ──
  | "POOL_SDK_MISSING" // the venue SDK is not installed in this deployment
  | "POOL_VENUE_ERROR"; // the venue adapter failed

export class PoolGuardError extends Error {
  readonly code: PoolGuardCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: PoolGuardCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PoolGuardError";
    this.code = code;
    this.details = details;
  }
}

export function isPoolGuardError(error: unknown): error is PoolGuardError {
  return error instanceof PoolGuardError;
}

/** A refusal reason carried as data (the pure guards return these; they do not throw). */
export interface Refusal {
  readonly code: PoolGuardCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function refuse(
  code: PoolGuardCode,
  message: string,
  details?: Record<string, unknown>,
): Refusal {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Turn a data-shaped refusal into the throwable form (used at the tool boundary). */
export function throwRefusal(r: Refusal): never {
  throw new PoolGuardError(r.code, r.message, r.details);
}
