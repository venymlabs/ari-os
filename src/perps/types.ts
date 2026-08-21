/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TokenAmount } from "../kernel/money.js";

/**
 * Venue-agnostic perp domain types.
 *
 * NOTHING from a venue SDK (Drift's `BN`, `PositionDirection`, `PerpMarketAccount`,
 * anchor types, …) may appear in this file or in `venue.ts`. An adapter translates
 * at its own boundary; the port stays clean so a second venue can be added without
 * touching the guards, the intent shape, or the tools.
 */

export type PerpSide = "long" | "short";
export type PerpOrderType = "market" | "limit";

export function oppositeSide(side: PerpSide): PerpSide {
  return side === "long" ? "short" : "long";
}

/** Venue-level market status. `unknown` is treated as unsafe by the guards (fail closed). */
export type PerpMarketStatus = "active" | "reduce-only" | "halted" | "unknown";

export interface PerpMarket {
  readonly venue: string;
  /** Canonical uppercase symbol, e.g. 'SOL-PERP'. This is the only market handle the guards know. */
  readonly symbol: string;
  /** Opaque venue handle (Drift market index). Never interpreted outside the adapter. */
  readonly venueMarketIndex: number;

  readonly baseSymbol: string;
  readonly baseDecimals: number;
  /** The settlement/collateral asset symbol, e.g. 'USDC'. */
  readonly quoteSymbol: string;
  readonly quoteDecimals: number;

  /** Smallest tradable base size and the size increment, in base units. */
  readonly minBaseAmount: bigint;
  readonly baseStep: bigint;

  /** Venue-imposed leverage ceiling (1 / initialMarginRatio). Policy may cap it lower, never higher. */
  readonly maxLeverage: number;
  /** Margin ratios as fractions in (0, 1), e.g. 0.05 and 0.03. */
  readonly initialMarginRatio: number;
  readonly maintenanceMarginRatio: number;

  readonly takerFeeBps: number;
  readonly status: PerpMarketStatus;
}

export interface PerpPrices {
  readonly symbol: string;
  readonly markPrice: number;
  readonly oraclePrice: number;
  readonly oracleSlot: number | undefined;
  readonly asOfMs: number;
}

/**
 * Funding, normalized to signed basis points per hour.
 * Positive = longs pay shorts (the long side is crowded).
 */
export interface FundingRate {
  readonly symbol: string;
  readonly bpsPerHour: number;
  readonly nextFundingMs: number | undefined;
  readonly asOfMs: number;
}

export interface PerpPosition {
  readonly venue: string;
  readonly symbol: string;
  readonly side: PerpSide;
  /** Absolute size in base units (never signed — the side carries the direction). */
  readonly baseAmount: bigint;
  readonly baseDecimals: number;

  readonly entryPrice: number;
  readonly markPrice: number;

  /**
   * Notional and posted collateral denominated in the COLLATERAL asset's base units.
   *
   * This is the whole trick, and it mirrors the swap path: exposure caps are
   * denominated in the input leg (what left the wallet), so no price oracle sits
   * in the safety path. A venue reports both of these natively in quote precision,
   * so reading them costs no extra oracle hop.
   */
  readonly notional: TokenAmount;
  readonly collateral: TokenAmount;

  /** Signed, in collateral base units. */
  readonly unrealizedPnl: bigint;
  readonly liquidationPrice: number | undefined;
  readonly leverage: number;
}

/**
 * Account/subaccount state on a venue. Discovery is a READ; creation is a separate,
 * separately-gated build step (see `PerpsVenue.buildInitializeAccount`). A trade
 * never creates an account as a side effect.
 */
export interface PerpAccountStatus {
  readonly venue: string;
  readonly owner: string;
  readonly subAccountId: number;
  /** The on-chain account exists. */
  readonly exists: boolean;
  /** It exists AND is usable for trading (Drift: user account + user stats initialized). */
  readonly initialized: boolean;
  readonly freeCollateral: TokenAmount | undefined;
  readonly totalCollateral: TokenAmount | undefined;
}

export interface LiquidationEstimate {
  readonly symbol: string;
  readonly side: PerpSide;
  /** undefined = the venue could not produce one. Callers must fail closed on this. */
  readonly liquidationPrice: number | undefined;
  /** The price the distance is measured from (mark at estimation time). */
  readonly referencePrice: number;
  readonly distanceBps: number | undefined;
  readonly source: "venue" | "model";
}
