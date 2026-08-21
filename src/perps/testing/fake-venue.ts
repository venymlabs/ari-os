/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type TokenAmount,
  USDC_DECIMALS,
  USDC_MINT,
} from "../../kernel/money.js";
import { PerpsVenueError } from "../errors.js";
import type {
  FundingRate,
  LiquidationEstimate,
  PerpAccountStatus,
  PerpMarket,
  PerpPosition,
  PerpPrices,
  PerpSide,
} from "../types.js";
import type {
  AdjustPositionRequest,
  ClosePositionRequest,
  LiquidationQuery,
  OpenPositionRequest,
  PerpAccountRef,
  PerpsVenue,
  VenueOrderBuild,
} from "../venue.js";

/**
 * An in-memory `PerpsVenue` for tests and for a network-free dry run.
 *
 * Every knob a test needs to drive a rejection path is a plain field, so the
 * tests read as scenarios rather than as mock setup. Nothing here touches the
 * network — that is the point.
 */

export const FAKE_BASE_PRECISION = 1_000_000_000n;

export function fakeMarket(overrides: Partial<PerpMarket> = {}): PerpMarket {
  return {
    venue: "fake",
    symbol: "SOL-PERP",
    venueMarketIndex: 0,
    baseSymbol: "SOL",
    baseDecimals: 9,
    quoteSymbol: "USDC",
    quoteDecimals: USDC_DECIMALS,
    minBaseAmount: 100_000_000n,
    baseStep: 100_000_000n,
    maxLeverage: 20,
    initialMarginRatio: 0.05,
    maintenanceMarginRatio: 0.03,
    takerFeeBps: 10,
    status: "active",
    ...overrides,
  };
}

export function usdc(amount: bigint): TokenAmount {
  return { mint: USDC_MINT, amount, decimals: USDC_DECIMALS };
}

export function fakePrices(overrides: Partial<PerpPrices> = {}): PerpPrices {
  return {
    symbol: "SOL-PERP",
    markPrice: 150,
    oraclePrice: 150,
    oracleSlot: 1234,
    asOfMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function fakeFunding(overrides: Partial<FundingRate> = {}): FundingRate {
  return {
    symbol: "SOL-PERP",
    bpsPerHour: 0.1,
    nextFundingMs: undefined,
    asOfMs: 1_700_000_000_000,
    ...overrides,
  };
}

export function fakePosition(
  overrides: Partial<PerpPosition> = {},
): PerpPosition {
  return {
    venue: "fake",
    symbol: "SOL-PERP",
    side: "long",
    baseAmount: 1_000_000_000n, // 1 SOL
    baseDecimals: 9,
    entryPrice: 150,
    markPrice: 150,
    notional: usdc(150_000_000n), // 150 USDC
    collateral: usdc(50_000_000n), // 50 USDC
    unrealizedPnl: 0n,
    liquidationPrice: 105,
    leverage: 3,
    ...overrides,
  };
}

export interface FakeVenueOptions {
  markets?: PerpMarket[];
  prices?: PerpPrices;
  funding?: FundingRate | null;
  positions?: PerpPosition[];
  accountExists?: boolean;
  allowAccountCreation?: boolean;
  /** What every build reports as the venue liquidation estimate. `null` = none. */
  liquidationPrice?: number | null;
  /** Force the next read to throw, to drive the fail-closed paths. */
  readError?: string | null;
}

export class FakePerpsVenue implements PerpsVenue {
  readonly id = "fake";

  markets: PerpMarket[];
  prices: PerpPrices;
  funding: FundingRate | null;
  positions: PerpPosition[];
  accountExists: boolean;
  allowAccountCreation: boolean;
  liquidationPrice: number | null;
  readError: string | null;

  /** Every build this venue produced, for assertions. */
  readonly builds: VenueOrderBuild[] = [];

  constructor(opts: FakeVenueOptions = {}) {
    this.markets = opts.markets ?? [fakeMarket()];
    this.prices = opts.prices ?? fakePrices();
    this.funding = opts.funding === undefined ? fakeFunding() : opts.funding;
    this.positions = opts.positions ?? [];
    this.accountExists = opts.accountExists ?? true;
    this.allowAccountCreation = opts.allowAccountCreation ?? false;
    this.liquidationPrice =
      opts.liquidationPrice === undefined ? 105 : opts.liquidationPrice;
    this.readError = opts.readError ?? null;
  }

  #guardRead(): void {
    if (this.readError) throw new PerpsVenueError(this.id, this.readError);
  }

  async listMarkets(): Promise<readonly PerpMarket[]> {
    this.#guardRead();
    return this.markets;
  }

  async getMarket(symbol: string): Promise<PerpMarket> {
    this.#guardRead();
    const want = symbol.trim().toUpperCase();
    const found = this.markets.find((m) => m.symbol === want);
    if (!found)
      throw new PerpsVenueError(this.id, `unknown market '${symbol}'`);
    return found;
  }

  async getPrices(symbol: string): Promise<PerpPrices> {
    this.#guardRead();
    await this.getMarket(symbol);
    return this.prices;
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    this.#guardRead();
    await this.getMarket(symbol);
    if (!this.funding)
      throw new PerpsVenueError(this.id, `${symbol}: no usable funding rate`);
    return this.funding;
  }

  async getPositions(
    _account: PerpAccountRef,
  ): Promise<readonly PerpPosition[]> {
    this.#guardRead();
    return this.positions;
  }

  async estimateLiquidationPrice(
    query: LiquidationQuery,
  ): Promise<LiquidationEstimate> {
    this.#guardRead();
    const price = this.liquidationPrice ?? undefined;
    return {
      symbol: query.market.symbol,
      side: query.side,
      liquidationPrice: price,
      referencePrice: this.prices.markPrice,
      distanceBps:
        price === undefined
          ? undefined
          : Math.floor(
              (Math.abs(this.prices.markPrice - price) /
                this.prices.markPrice) *
                10_000,
            ),
      source: price === undefined ? "model" : "venue",
    };
  }

  async getAccountStatus(account: PerpAccountRef): Promise<PerpAccountStatus> {
    this.#guardRead();
    return {
      venue: this.id,
      owner: account.owner,
      subAccountId: account.subAccountId,
      exists: this.accountExists,
      initialized: this.accountExists,
      freeCollateral: this.accountExists ? usdc(1_000_000_000n) : undefined,
      totalCollateral: this.accountExists ? usdc(1_000_000_000n) : undefined,
    };
  }

  async buildInitializeAccount(
    _account: PerpAccountRef,
  ): Promise<VenueOrderBuild> {
    if (!this.allowAccountCreation) {
      throw new PerpsVenueError(
        this.id,
        "account creation is disabled on this venue instance",
      );
    }
    return this.#build({
      market: this.markets[0]!,
      baseAmount: 0n,
      notional: usdc(0n),
      entryPrice: 0,
      slippageBps: 0,
      priorityFeeLamports: 0,
    });
  }

  async buildOpen(req: OpenPositionRequest): Promise<VenueOrderBuild> {
    this.#guardRead();
    const notionalUnits =
      (req.collateral.amount * BigInt(Math.round(req.leverage * 10_000))) /
      10_000n;
    const priceUnits = BigInt(Math.round(this.prices.markPrice * 1_000_000));
    const baseAmount = (notionalUnits * FAKE_BASE_PRECISION) / priceUnits;
    return this.#build({
      market: req.market,
      baseAmount,
      notional: {
        mint: req.collateral.mint,
        amount: notionalUnits,
        decimals: req.collateral.decimals,
      },
      entryPrice: this.prices.markPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
    });
  }

  async buildAdjust(req: AdjustPositionRequest): Promise<VenueOrderBuild> {
    this.#guardRead();
    const priceUnits = BigInt(Math.round(this.prices.markPrice * 1_000_000));
    const notionalUnits =
      (req.baseAmountDelta * priceUnits) / FAKE_BASE_PRECISION;
    return this.#build({
      market: req.market,
      baseAmount: req.baseAmountDelta,
      notional: {
        mint: req.collateral.mint,
        amount: notionalUnits,
        decimals: req.collateral.decimals,
      },
      entryPrice: this.prices.markPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
    });
  }

  async buildClose(req: ClosePositionRequest): Promise<VenueOrderBuild> {
    this.#guardRead();
    const pos = this.positions.find((p) => p.symbol === req.market.symbol);
    if (!pos)
      throw new PerpsVenueError(
        this.id,
        `no open ${req.market.symbol} position`,
      );
    const baseAmount = (pos.baseAmount * BigInt(req.fractionBps)) / 10_000n;
    const priceUnits = BigInt(Math.round(this.prices.markPrice * 1_000_000));
    return this.#build({
      market: req.market,
      baseAmount,
      notional: usdc((baseAmount * priceUnits) / FAKE_BASE_PRECISION),
      entryPrice: this.prices.markPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
    });
  }

  #build(args: {
    market: PerpMarket;
    baseAmount: bigint;
    notional: TokenAmount;
    entryPrice: number;
    slippageBps: number;
    priorityFeeLamports: number;
  }): VenueOrderBuild {
    const build: VenueOrderBuild = {
      unsignedTxBase64: "ZmFrZS11bnNpZ25lZC10eA==",
      recentBlockhash: "FakeBlockhash1111111111111111111111111111111",
      lastValidBlockHeight: 250_000_000,
      priorityFeeLamports: args.priorityFeeLamports,
      expectedBaseAmount: args.baseAmount,
      minBaseAmount:
        (args.baseAmount * BigInt(10_000 - args.slippageBps)) / 10_000n,
      entryPrice: args.entryPrice,
      notional: args.notional,
      estimatedLiquidationPrice: this.liquidationPrice ?? undefined,
      venueWarnings: [],
    };
    this.builds.push(build);
    return build;
  }
}

export function fakeSide(side: PerpSide): PerpSide {
  return side;
}
