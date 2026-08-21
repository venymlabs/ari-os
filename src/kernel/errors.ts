/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Every reason the kernel can refuse or abort a value-moving action. */
export type GuardCode =
  | "EXECUTION_DISABLED" // executionEnabled is false (dry-run / not armed)
  | "KILL_SWITCH" // global/per-user hard stop engaged
  | "INVALID_INTENT" // intent failed structural validation
  | "MINT_NOT_PINNED" // untrusted-provenance mint without explicit user confirmation
  | "MINT_DENIED" // mint on the denylist / not on the allowlist
  | "TOKEN2022_UNSUPPORTED" // Token-2022 mint while allowToken2022 is false
  | "CAP_EXCEEDED" // input-leg spend cap would be exceeded
  | "INSUFFICIENT_BALANCE" // wallet cannot cover the input leg + fees
  | "SLIPPAGE_EXCEEDED" // requested slippage above maxSlippageBps
  | "PRIORITY_FEE_EXCEEDED" // priority fee above the configured ceiling
  | "PRIORITY_FEE_INVALID" // priority fee is negative / non-finite
  | "SIMULATION_FAILED" // preflight simulation errored
  | "MIN_OUT_MISMATCH" // route min-out inconsistent with the clamped slippage
  | "DUPLICATE_INTENT" // idempotency key already used
  | "BROADCAST_FAILED" // could not submit the signed tx
  | "CONFIRM_TIMEOUT" // blockhash expired before confirmation
  | "SETTLE_SHORTFALL"; // confirmed, but received less than the committed min-out

export class GuardError extends Error {
  readonly code: GuardCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: GuardCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GuardError";
    this.code = code;
    this.details = details;
  }
}

export function isGuardError(error: unknown): error is GuardError {
  return error instanceof GuardError;
}
