/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GuardCode, GuardError } from "../kernel/errors.js";

/**
 * Every reason the perps layer can refuse an intent.
 *
 * These are FINER-GRAINED than the kernel's `GuardCode`, not a replacement for
 * it: `PerpGuardError extends GuardError`, so `isGuardError()`, the kernel's
 * journal, and the existing Telegram error rendering all keep working unchanged
 * while the precise perp reason survives on `.perpCode`.
 */
export const PERP_GUARD_CODES = [
  "PERPS_DISABLED", // perps master arm is off
  "KILL_SWITCH", // global hard stop
  "WIND_DOWN_ONLY", // wind-down active: reduce-only intents only
  "INVALID_PERP_INTENT", // structural validation failed
  "MARKET_DENIED", // market denylisted / not allowlisted
  "MARKET_NOT_TRADEABLE", // venue reports halted / reduce-only / unknown status
  "COLLATERAL_MINT_DENIED", // collateral asset not permitted as perp margin
  "COLLATERAL_NOT_CAPPABLE", // collateral has no spend-cap bucket — cannot be capped, so refused
  "LEVERAGE_EXCEEDED", // above policy (or above the venue's own ceiling)
  "COLLATERAL_CAP_EXCEEDED", // per-position collateral cap (input leg)
  "NOTIONAL_CAP_EXCEEDED", // per-position notional cap (input leg)
  "PORTFOLIO_EXPOSURE_EXCEEDED", // total open perp notional cap (input leg)
  "POSITION_COUNT_EXCEEDED", // too many concurrent positions
  "EXPOSURE_UNKNOWN", // portfolio snapshot is stale/ambiguous — cannot bound the total
  "LIQUIDATION_TOO_CLOSE", // opens inside the minimum liquidation distance
  "LIQUIDATION_UNKNOWN", // no usable / self-contradictory liquidation estimate
  "FUNDING_RATE_UNSANE", // |funding| beyond the sanity bound (bad data or a market in crisis)
  "FUNDING_RATE_ADVERSE", // this side would pay more funding than policy allows
  "FUNDING_RATE_UNKNOWN", // no funding reading — refused rather than assumed zero
  "ORACLE_DIVERGENCE", // mark and oracle disagree beyond policy
  "SLIPPAGE_EXCEEDED", // above the perps slippage clamp
  "REDUCE_ONLY_VIOLATION", // reduce-only flag inconsistent with the intent kind
  "NO_POSITION", // reduce/close with nothing to reduce
  "POSITION_SIDE_MISMATCH", // reduce/close would flip the position instead of shrinking it
  "SIZE_EXCEEDS_POSITION", // reduce larger than the position it targets
  "ACCOUNT_NOT_INITIALIZED", // venue subaccount does not exist — must be created as its own step
  "ACCOUNT_CREATION_DISABLED", // account creation attempted while not explicitly allowed
] as const;

export type PerpGuardCode = (typeof PERP_GUARD_CODES)[number];

/**
 * How each perp reason surfaces to code that only knows the kernel's vocabulary.
 * Deliberately exhaustive (no default arm) so adding a code forces a decision here.
 */
const KERNEL_CODE: Readonly<Record<PerpGuardCode, GuardCode>> = {
  PERPS_DISABLED: "EXECUTION_DISABLED",
  KILL_SWITCH: "KILL_SWITCH",
  WIND_DOWN_ONLY: "EXECUTION_DISABLED",
  INVALID_PERP_INTENT: "INVALID_INTENT",
  MARKET_DENIED: "MINT_DENIED",
  MARKET_NOT_TRADEABLE: "INVALID_INTENT",
  COLLATERAL_MINT_DENIED: "MINT_DENIED",
  COLLATERAL_NOT_CAPPABLE: "INVALID_INTENT",
  LEVERAGE_EXCEEDED: "CAP_EXCEEDED",
  COLLATERAL_CAP_EXCEEDED: "CAP_EXCEEDED",
  NOTIONAL_CAP_EXCEEDED: "CAP_EXCEEDED",
  PORTFOLIO_EXPOSURE_EXCEEDED: "CAP_EXCEEDED",
  POSITION_COUNT_EXCEEDED: "CAP_EXCEEDED",
  EXPOSURE_UNKNOWN: "INVALID_INTENT",
  LIQUIDATION_TOO_CLOSE: "INVALID_INTENT",
  LIQUIDATION_UNKNOWN: "INVALID_INTENT",
  FUNDING_RATE_UNSANE: "INVALID_INTENT",
  FUNDING_RATE_ADVERSE: "INVALID_INTENT",
  FUNDING_RATE_UNKNOWN: "INVALID_INTENT",
  ORACLE_DIVERGENCE: "INVALID_INTENT",
  SLIPPAGE_EXCEEDED: "SLIPPAGE_EXCEEDED",
  REDUCE_ONLY_VIOLATION: "INVALID_INTENT",
  NO_POSITION: "INVALID_INTENT",
  POSITION_SIDE_MISMATCH: "INVALID_INTENT",
  SIZE_EXCEEDS_POSITION: "INVALID_INTENT",
  ACCOUNT_NOT_INITIALIZED: "INVALID_INTENT",
  ACCOUNT_CREATION_DISABLED: "EXECUTION_DISABLED",
};

export function kernelCodeFor(code: PerpGuardCode): GuardCode {
  return KERNEL_CODE[code];
}

export class PerpGuardError extends GuardError {
  readonly perpCode: PerpGuardCode;

  constructor(
    perpCode: PerpGuardCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(KERNEL_CODE[perpCode], message, { ...details, perpCode });
    this.name = "PerpGuardError";
    this.perpCode = perpCode;
  }
}

export function isPerpGuardError(error: unknown): error is PerpGuardError {
  return error instanceof PerpGuardError;
}

/** A venue-adapter failure that is NOT a policy refusal (RPC down, SDK missing, market unknown). */
export class PerpsVenueError extends Error {
  readonly venue: string;

  constructor(venue: string, message: string) {
    super(message);
    this.name = "PerpsVenueError";
    this.venue = venue;
  }
}
