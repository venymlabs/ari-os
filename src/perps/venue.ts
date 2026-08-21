/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TokenAmount } from "../kernel/money.js";
import type {
  FundingRate,
  LiquidationEstimate,
  PerpAccountStatus,
  PerpMarket,
  PerpOrderType,
  PerpPosition,
  PerpPrices,
  PerpSide,
} from "./types.js";

/**
 * The venue-agnostic perps port.
 *
 * A `PerpsVenue` READS venue state and BUILDS unsigned transactions. It has no
 * signer, no keypair, and no broadcast path — exactly like `JupiterClient` in
 * `JupiterClient` in `src/chains/solana`. Everything that could move value leaves this port as
 * an unsigned wire blob that `TradeGateway.execute()` re-validates from scratch.
 */

/** Where the blockhash lifecycle comes from. Keeps the venue free of an RPC/web3.js dependency. */
export interface BlockhashSource {
  latestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export interface PerpAccountRef {
  /** base58 owner pubkey (the on-machine wallet). */
  readonly owner: string;
  /** Venue subaccount index. Discovery is explicit; nothing is auto-created. */
  readonly subAccountId: number;
}

/** Everything a build needs that is NOT venue-specific. */
interface BaseBuildRequest {
  readonly account: PerpAccountRef;
  readonly market: PerpMarket;
  readonly orderType: PerpOrderType;
  /** Required for `limit`; ignored for `market`. */
  readonly limitPrice: number | undefined;
  readonly slippageBps: number;
  readonly priorityFeeLamports: number;
}

export interface OpenPositionRequest extends BaseBuildRequest {
  readonly side: PerpSide;
  /** What LEAVES the wallet as margin — the input leg the kernel caps on. */
  readonly collateral: TokenAmount;
  readonly leverage: number;
}

/** Increase or reduce an existing position by a base-size delta. */
export interface AdjustPositionRequest extends BaseBuildRequest {
  readonly direction: "increase" | "reduce";
  /** Absolute base-unit delta (never signed). */
  readonly baseAmountDelta: bigint;
  /** Additional margin for an increase; zero-amount for a reduce. */
  readonly collateral: TokenAmount;
}

export interface ClosePositionRequest extends BaseBuildRequest {
  /** 1..10000 — 10000 closes the whole position. */
  readonly fractionBps: number;
}

/**
 * The unsigned artifact a venue hands back. Deliberately shaped like
 * the kernel's `SwapBuild` so its blockhash/expiry lifecycle,
 * priority-fee ceiling, and persist-before-broadcast all apply unchanged.
 */
export interface VenueOrderBuild {
  readonly unsignedTxBase64: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly priorityFeeLamports: number;

  /** Expected and worst-case filled base size, in base units. The perps analogue of out/min-out. */
  readonly expectedBaseAmount: bigint;
  readonly minBaseAmount: bigint;

  readonly entryPrice: number;
  /** Notional in COLLATERAL base units — never USD floats in the safety path. */
  readonly notional: TokenAmount;
  /** undefined means the venue could not compute one; the guards then fail closed. */
  readonly estimatedLiquidationPrice: number | undefined;

  readonly venueWarnings: readonly string[];
}

export interface LiquidationQuery {
  readonly account: PerpAccountRef;
  readonly market: PerpMarket;
  readonly side: PerpSide;
  readonly baseAmount: bigint;
  readonly collateral: TokenAmount;
  readonly entryPrice: number;
}

export interface PerpsVenue {
  /** Stable venue id used in intents and journals, e.g. 'drift'. */
  readonly id: string;

  // ── reads ──
  listMarkets(): Promise<readonly PerpMarket[]>;
  getMarket(symbol: string): Promise<PerpMarket>;
  getPrices(symbol: string): Promise<PerpPrices>;
  getFundingRate(symbol: string): Promise<FundingRate>;
  getPositions(account: PerpAccountRef): Promise<readonly PerpPosition[]>;
  estimateLiquidationPrice(
    query: LiquidationQuery,
  ): Promise<LiquidationEstimate>;

  // ── account lifecycle (explicitly gated; never a side effect of a trade) ──
  getAccountStatus(account: PerpAccountRef): Promise<PerpAccountStatus>;
  /**
   * Build the account-initialisation transaction. Implementations MUST refuse
   * unless account creation was explicitly enabled on the adapter — it is its own
   * user-visible decision (it costs rent and creates on-chain state), never an
   * implicit step inside an order build.
   */
  buildInitializeAccount(account: PerpAccountRef): Promise<VenueOrderBuild>;

  // ── builds (unsigned; never signed, never broadcast) ──
  buildOpen(req: OpenPositionRequest): Promise<VenueOrderBuild>;
  buildAdjust(req: AdjustPositionRequest): Promise<VenueOrderBuild>;
  buildClose(req: ClosePositionRequest): Promise<VenueOrderBuild>;
}
