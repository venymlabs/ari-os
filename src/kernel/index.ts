/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

export * from "./contracts.js";
export { GuardError, isGuardError } from "./errors.js";
export type { GuardCode } from "./errors.js";
export { Secret, isSecret } from "./secret.js";
export {
  LAMPORTS_PER_SOL,
  SOL_DECIMALS,
  SOL_QUOTE_MINTS,
  USDC_DECIMALS,
  USDC_MINT,
  USDC_QUOTE_MINTS,
  USDT_MINT,
  WSOL_MINT,
  formatAmount,
  fromBaseUnits,
  quoteBucketFor,
  slippageBps,
  toBaseUnits,
} from "./money.js";
export type { QuoteBucket, TokenAmount } from "./money.js";
export {
  newId,
  newIdempotencyKey,
  newReservationId,
  newTradeId,
} from "./ids.js";
export { applyPolicyOverrides, defaultPolicy } from "./defaults.js";
export type { PolicyOverrides } from "./defaults.js";
export { ManualClock, systemClock } from "./clock.js";
export { LockHeldError, ProcessLock } from "./lock.js";
export { staticGuards } from "./policy-engine.js";
export type { GuardOptions } from "./policy-engine.js";
export { KernelStore } from "./store.js";
export type {
  NewTradeRow,
  ReserveArgs,
  ReserveDenyReason,
  ReserveOutcome,
  SpendCapsBaseUnits,
  TradeRow,
} from "./store.js";
export { TradeGatewayImpl } from "./trade-gateway.js";
export type { TradeGatewayDeps } from "./trade-gateway.js";
export { Reconciler } from "./reconciler.js";
export type { ReconcileSummary, ReconcilerDeps } from "./reconciler.js";
