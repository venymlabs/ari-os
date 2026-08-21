/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { type TokenAmount, USDC_DECIMALS } from "../../kernel/money.js";
import { PerpGuardError, PerpsVenueError } from "../errors.js";
import { modelLiquidationPrice } from "../liquidation.js";
import { leverageToBps } from "../policy.js";
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
  BlockhashSource,
  ClosePositionRequest,
  LiquidationQuery,
  OpenPositionRequest,
  PerpAccountRef,
  PerpsVenue,
  VenueOrderBuild,
} from "../venue.js";
import {
  DRIFT_SETTLEMENT_MINT,
  DRIFT_VENUE_ID,
  fundingBpsPerHour,
  notionalQuoteUnits,
  priceFrom,
  splitSignedBase,
  toPerpMarket,
} from "./convert.js";
import {
  BASE_PRECISION,
  type Bn,
  bnToBigInt,
  type DriftClientLike,
  type DriftPerpMarketAccount,
  type DriftSdkModule,
  PRICE_PRECISION,
  QUOTE_PRECISION,
} from "./sdk-types.js";

const DEFAULT_TAKER_FEE_BPS = 10;
const DEFAULT_PRIORITY_FEE_LAMPORTS = 200_000;

/**
 * A signing-incapable wallet for the SDK.
 *
 * `DriftClient` requires a wallet object, but this adapter must never be able to
 * sign: it only reads state and builds unsigned transactions. Handing the SDK a
 * pubkey-only object whose sign methods throw makes that a structural
 * guarantee rather than a convention — if a future SDK version tried to sign
 * inside a build path, it would crash loudly instead of quietly producing a
 * signed transaction outside the kernel.
 */
export function readOnlyWallet(publicKey: unknown): Record<string, unknown> {
  const refuse = (): never => {
    throw new PerpsVenueError(
      DRIFT_VENUE_ID,
      "the Drift adapter is signing-incapable by construction — only the kernel signs",
    );
  };
  return {
    publicKey,
    payer: undefined,
    signTransaction: refuse,
    signAllTransactions: refuse,
    signVersionedTransaction: refuse,
  };
}

export interface DriftVenueOptions {
  /** `@solana/web3.js` Connection. Opaque here — the adapter never calls it directly. */
  readonly connection: unknown;
  /** The on-machine wallet's `PublicKey`. Wrapped in `readOnlyWallet` before the SDK sees it. */
  readonly publicKey: unknown;
  /** base58 owner pubkey, for the domain types. */
  readonly owner: string;
  /** Supplies the blockhash lifecycle the kernel owns. */
  readonly blockhash: BlockhashSource;
  readonly env?: "mainnet-beta" | "devnet";
  /**
   * Gate on building an account-initialisation transaction. Defaults to false:
   * creating on-chain state is its own explicit user decision, never a side
   * effect of a trade.
   */
  readonly allowAccountCreation?: boolean | undefined;
  readonly priorityFeeLamports?: number;
  readonly takerFeeBps?: number;
  /** Test seam. Production leaves this unset and the SDK is imported lazily. */
  readonly sdkLoader?: () => Promise<DriftSdkModule>;
}

/**
 * Drift v2 implementation of `PerpsVenue`.
 *
 * Reads venue state and builds UNSIGNED transactions. It holds no keypair, has
 * no broadcast path, and every method returns plain domain types — no Drift type
 * escapes this file.
 *
 * ── Verification status, stated plainly ──
 * This adapter is written against the documented `@drift-labs/sdk` v2 API and
 * has NOT been executed against a live RPC or a funded account. The SDK is an
 * optional peer dependency and is not installed in this workspace. Treat every
 * on-chain claim here as unverified until someone runs it with a real RPC.
 * What IS verified is everything downstream: the conversions in `convert.ts`,
 * the intent shape, and every guard are unit-tested against fakes, and they are
 * built to turn an adapter mistake into a refusal rather than a bad fill.
 */
export class DriftVenue implements PerpsVenue {
  readonly id = DRIFT_VENUE_ID;

  #opts: DriftVenueOptions;
  #client: DriftClientLike | null = null;
  #sdk: DriftSdkModule | null = null;
  #connecting: Promise<void> | null = null;

  constructor(opts: DriftVenueOptions) {
    this.#opts = opts;
  }

  // ── lifecycle ──

  /**
   * Lazily import the SDK and subscribe. Idempotent and concurrency-safe: a
   * second caller awaits the first connect rather than building a second client.
   */
  async connect(): Promise<void> {
    if (this.#client) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#doConnect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<void> {
    const sdk = await this.#loadSdk();
    const client = new sdk.DriftClient({
      connection: this.#opts.connection,
      wallet: readOnlyWallet(this.#opts.publicKey),
      env: this.#opts.env ?? "mainnet-beta",
      accountSubscription: { type: "websocket" },
    });
    const ok = await client.subscribe();
    if (!ok)
      throw new PerpsVenueError(
        this.id,
        "DriftClient.subscribe() returned false",
      );
    this.#sdk = sdk;
    this.#client = client;
  }

  async disconnect(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#sdk = null;
    if (client) await client.unsubscribe().catch(() => undefined);
  }

  async #loadSdk(): Promise<DriftSdkModule> {
    if (this.#opts.sdkLoader) return this.#opts.sdkLoader();
    // Non-literal specifier: keeps `tsc` from resolving an optional peer dep that
    // is intentionally not installed, and keeps the import out of the module graph.
    const specifier = "@drift-labs/sdk";
    try {
      return (await import(specifier)) as DriftSdkModule;
    } catch (err) {
      throw new PerpsVenueError(
        this.id,
        '@drift-labs/sdk is not installed — run "npm install @drift-labs/sdk" to run perps ' +
          "against Drift. It is an OPTIONAL peer dependency, deliberately kept out of the " +
          "production install so it adds no audit surface to a deployment that does not use " +
          `it. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  #ready(): { client: DriftClientLike; sdk: DriftSdkModule } {
    if (!this.#client || !this.#sdk) {
      throw new PerpsVenueError(
        this.id,
        "DriftVenue.connect() must be awaited before use",
      );
    }
    return { client: this.#client, sdk: this.#sdk };
  }

  // ── markets ──

  async listMarkets(): Promise<readonly PerpMarket[]> {
    const { client } = this.#ready();
    const takerFeeBps = this.#opts.takerFeeBps ?? DEFAULT_TAKER_FEE_BPS;
    const accounts = this.#call(
      () => client.getPerpMarketAccounts(),
      "getPerpMarketAccounts",
    );
    const out: PerpMarket[] = [];
    for (const account of accounts) {
      const { market } = toPerpMarket(account, takerFeeBps);
      // A market we cannot convert safely is DROPPED, never defaulted. It simply
      // does not exist as far as the agent is concerned.
      if (market) out.push(market);
    }
    return out;
  }

  async getMarket(symbol: string): Promise<PerpMarket> {
    const want = symbol.trim().toUpperCase();
    const markets = await this.listMarkets();
    const found = markets.find((m) => m.symbol === want);
    if (!found)
      throw new PerpsVenueError(
        this.id,
        `unknown or unusable perp market '${symbol}'`,
      );
    return found;
  }

  #marketAccount(marketIndex: number): DriftPerpMarketAccount {
    const { client } = this.#ready();
    const account = this.#call(
      () => client.getPerpMarketAccount(marketIndex),
      "getPerpMarketAccount",
    );
    if (!account)
      throw new PerpsVenueError(
        this.id,
        `no Drift perp market account at index ${marketIndex}`,
      );
    return account;
  }

  async getPrices(symbol: string): Promise<PerpPrices> {
    const { client, sdk } = this.#ready();
    const market = await this.getMarket(symbol);
    const account = this.#marketAccount(market.venueMarketIndex);
    const oracle = this.#call(
      () => client.getOracleDataForPerpMarket(market.venueMarketIndex),
      "getOracleDataForPerpMarket",
    );

    const oraclePrice = priceFrom(oracle.price);
    if (oraclePrice === undefined || oraclePrice <= 0) {
      throw new PerpsVenueError(
        this.id,
        `${market.symbol}: no usable oracle price`,
      );
    }
    // Mark price falls back to the oracle when the SDK build does not export a
    // reserve-price helper. The guards' mark/oracle divergence check then trivially
    // passes, which is why it is a WARNING-level signal and not the only defence.
    const mark = sdk.calculateReservePrice
      ? priceFrom(sdk.calculateReservePrice(account, oracle))
      : undefined;

    return {
      symbol: market.symbol,
      markPrice: mark !== undefined && mark > 0 ? mark : oraclePrice,
      oraclePrice,
      oracleSlot: Number(bnToBigInt(oracle.slot) ?? 0n) || undefined,
      asOfMs: Date.now(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRate> {
    const market = await this.getMarket(symbol);
    const account = this.#marketAccount(market.venueMarketIndex);
    const twap = bnToBigInt(
      account.amm.historicalOracleData?.lastOraclePriceTwap,
    );
    const rate = bnToBigInt(account.amm.lastFundingRate);
    const bps = fundingBpsPerHour(rate, twap);
    if (bps === undefined) {
      // Deliberately NOT zero. A missing funding reading is refused by the guards.
      throw new PerpsVenueError(
        this.id,
        `${market.symbol}: no usable funding rate`,
      );
    }
    return {
      symbol: market.symbol,
      bpsPerHour: bps,
      nextFundingMs: undefined,
      asOfMs: Date.now(),
    };
  }

  // ── positions ──

  async getPositions(
    account: PerpAccountRef,
  ): Promise<readonly PerpPosition[]> {
    const { client } = this.#ready();
    const user = this.#call(
      () => client.getUser(account.subAccountId),
      "getUser",
    );
    const userAccount = this.#call(
      () => user.getUserAccount(),
      "getUserAccount",
    );
    const markets = await this.listMarkets();

    const out: PerpPosition[] = [];
    for (const raw of userAccount.perpPositions ?? []) {
      const signed = bnToBigInt(raw.baseAssetAmount);
      if (signed === undefined || signed === 0n) continue;
      const market = markets.find(
        (m) => m.venueMarketIndex === raw.marketIndex,
      );
      if (!market) continue;

      const oracle = this.#call(
        () => client.getOracleDataForPerpMarket(raw.marketIndex),
        "getOracleDataForPerpMarket",
      );
      const priceUnits = bnToBigInt(oracle.price);
      const markPrice = priceFrom(oracle.price);
      if (priceUnits === undefined || markPrice === undefined || markPrice <= 0)
        continue;

      const { side, magnitude } = splitSignedBase(signed);
      const notionalUnits = notionalQuoteUnits(magnitude, priceUnits);
      const quoteEntry = bnToBigInt(raw.quoteEntryAmount) ?? 0n;
      const entryPrice =
        magnitude > 0n
          ? Math.abs(Number(quoteEntry) / Number(QUOTE_PRECISION)) /
            (Number(magnitude) / Number(BASE_PRECISION))
          : 0;

      const liq = this.#safe(() =>
        priceFrom(user.liquidationPrice(raw.marketIndex)),
      );
      const collateralUnits =
        this.#safe(() => bnToBigInt(user.getTotalCollateral())) ?? 0n;
      const leverage =
        collateralUnits > 0n
          ? Number(notionalUnits) / Number(collateralUnits)
          : 0;

      // Drift PnL: quoteAssetAmount + signedBase × price, all in quote units.
      // Signed base carries the direction, so this works for both sides.
      const unrealizedPnl =
        (bnToBigInt(raw.quoteAssetAmount) ?? 0n) +
        (signed * priceUnits) / BASE_PRECISION;

      out.push({
        venue: this.id,
        symbol: market.symbol,
        side,
        baseAmount: magnitude,
        baseDecimals: market.baseDecimals,
        entryPrice:
          Number.isFinite(entryPrice) && entryPrice > 0
            ? entryPrice
            : markPrice,
        markPrice,
        notional: quoteAmount(notionalUnits),
        collateral: quoteAmount(collateralUnits),
        unrealizedPnl,
        liquidationPrice: liq,
        leverage: Number.isFinite(leverage) ? leverage : 0,
      });
    }
    return out;
  }

  async estimateLiquidationPrice(
    query: LiquidationQuery,
  ): Promise<LiquidationEstimate> {
    const { client, sdk } = this.#ready();
    const prices = await this.getPrices(query.market.symbol);

    const venuePrice = this.#safe(() => {
      const user = client.getUser(query.account.subAccountId);
      const delta = new sdk.BN(
        (query.side === "long"
          ? query.baseAmount
          : -query.baseAmount
        ).toString(),
      );
      const entry = new sdk.BN(
        Math.round(query.entryPrice * Number(PRICE_PRECISION)).toString(),
      );
      return priceFrom(
        user.liquidationPrice(query.market.venueMarketIndex, delta, entry),
      );
    });

    const collateralUi =
      Number(query.collateral.amount) / 10 ** query.collateral.decimals;
    const notionalUi =
      (Number(query.baseAmount) / Number(BASE_PRECISION)) * query.entryPrice;
    const leverage = collateralUi > 0 ? notionalUi / collateralUi : Number.NaN;
    const model = modelLiquidationPrice({
      side: query.side,
      entryPrice: query.entryPrice,
      leverage,
      maintenanceMarginRatio: query.market.maintenanceMarginRatio,
    });

    const price = venuePrice ?? model;
    const distanceBps =
      price === undefined
        ? undefined
        : Math.floor(
            (Math.abs(prices.markPrice - price) / prices.markPrice) * 10_000,
          );

    return {
      symbol: query.market.symbol,
      side: query.side,
      liquidationPrice: price,
      referencePrice: prices.markPrice,
      distanceBps,
      source: venuePrice !== undefined ? "venue" : "model",
    };
  }

  // ── account lifecycle ──

  async getAccountStatus(account: PerpAccountRef): Promise<PerpAccountStatus> {
    const { client } = this.#ready();
    const userAccount = this.#safe(() =>
      client.getUserAccount(account.subAccountId),
    );
    const exists = Boolean(userAccount);
    const free = exists
      ? this.#safe(() =>
          bnToBigInt(client.getUser(account.subAccountId).getFreeCollateral()),
        )
      : undefined;
    const total = exists
      ? this.#safe(() =>
          bnToBigInt(client.getUser(account.subAccountId).getTotalCollateral()),
        )
      : undefined;

    return {
      venue: this.id,
      owner: account.owner,
      subAccountId: account.subAccountId,
      exists,
      initialized: exists && total !== undefined,
      freeCollateral: free === undefined ? undefined : quoteAmount(free),
      totalCollateral: total === undefined ? undefined : quoteAmount(total),
    };
  }

  /**
   * Build the subaccount-initialisation transaction — and ONLY when explicitly
   * enabled. This is the "explicit, separately-gated step" the architecture
   * calls for: no order-building path ever reaches it, so a trade can never
   * create an account as a side effect.
   */
  async buildInitializeAccount(
    account: PerpAccountRef,
  ): Promise<VenueOrderBuild> {
    if (this.#opts.allowAccountCreation !== true) {
      throw new PerpGuardError(
        "ACCOUNT_CREATION_DISABLED",
        "Drift account creation is disabled — enable it explicitly, it costs rent and creates on-chain state",
        { venue: this.id, subAccountId: account.subAccountId },
      );
    }
    const { client } = this.#ready();
    const status = await this.getAccountStatus(account);
    if (status.exists) {
      throw new PerpsVenueError(
        this.id,
        `subaccount ${account.subAccountId} already exists`,
      );
    }
    const ixs = await this.#callAsync(
      () => client.getInitializeUserInstructions(account.subAccountId),
      "getInitializeUserInstructions",
    );
    // Not a trade: the size/price fields are zero because there is no position.
    // This build is never turned into a PerpIntent — it is its own artifact that
    // the engine routes as an explicit, user-confirmed setup action.
    return this.#assemble(
      [...ixs].filter((ix) => ix !== undefined && ix !== null),
      {
        expectedBaseAmount: 0n,
        minBaseAmount: 0n,
        entryPrice: 0,
        notional: quoteAmount(0n),
        estimatedLiquidationPrice: undefined,
        warnings: [
          "initialises a Drift subaccount — creates on-chain state and costs rent",
        ],
      },
    );
  }

  // ── builds ──

  async buildOpen(req: OpenPositionRequest): Promise<VenueOrderBuild> {
    const bps = leverageToBps(req.leverage);
    if (bps === undefined)
      throw new PerpsVenueError(this.id, `invalid leverage ${req.leverage}`);
    if (req.collateral.amount <= 0n)
      throw new PerpsVenueError(this.id, "open requires positive collateral");

    const notionalUnits = (req.collateral.amount * BigInt(bps)) / 10_000n;
    const { entryPrice, priceUnits } = await this.#entry(
      req.market.symbol,
      req.side,
    );
    const baseAmount = (notionalUnits * BASE_PRECISION) / priceUnits;
    if (baseAmount <= 0n)
      throw new PerpsVenueError(
        this.id,
        "derived base size is zero — collateral or leverage too small",
      );

    return this.#order({
      market: req.market,
      side: req.side,
      baseAmount,
      reduceOnly: false,
      orderType: req.orderType,
      limitPrice: req.limitPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
      account: req.account,
      collateral: req.collateral,
      entryPrice,
      notionalUnits,
    });
  }

  async buildAdjust(req: AdjustPositionRequest): Promise<VenueOrderBuild> {
    if (req.baseAmountDelta <= 0n)
      throw new PerpsVenueError(
        this.id,
        "adjust requires a positive base delta",
      );
    const positions = await this.getPositions(req.account);
    const current = positions.find((p) => p.symbol === req.market.symbol);
    if (!current)
      throw new PerpsVenueError(
        this.id,
        `no open ${req.market.symbol} position to adjust`,
      );

    // Increase trades the SAME way as the position; reduce trades the opposite way.
    const side: PerpSide =
      req.direction === "increase"
        ? current.side
        : current.side === "long"
          ? "short"
          : "long";
    const { entryPrice, priceUnits } = await this.#entry(
      req.market.symbol,
      side,
    );

    return this.#order({
      market: req.market,
      side,
      baseAmount: req.baseAmountDelta,
      reduceOnly: req.direction === "reduce",
      orderType: req.orderType,
      limitPrice: req.limitPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
      account: req.account,
      collateral: req.collateral,
      entryPrice,
      notionalUnits: notionalQuoteUnits(req.baseAmountDelta, priceUnits),
    });
  }

  async buildClose(req: ClosePositionRequest): Promise<VenueOrderBuild> {
    if (req.fractionBps <= 0 || req.fractionBps > 10_000) {
      throw new PerpsVenueError(
        this.id,
        `close fraction ${req.fractionBps}bps out of range`,
      );
    }
    const positions = await this.getPositions(req.account);
    const current = positions.find((p) => p.symbol === req.market.symbol);
    if (!current)
      throw new PerpsVenueError(
        this.id,
        `no open ${req.market.symbol} position to close`,
      );

    const baseAmount = (current.baseAmount * BigInt(req.fractionBps)) / 10_000n;
    if (baseAmount <= 0n)
      throw new PerpsVenueError(this.id, "close size rounds to zero");
    const side: PerpSide = current.side === "long" ? "short" : "long";
    const { entryPrice, priceUnits } = await this.#entry(
      req.market.symbol,
      side,
    );

    return this.#order({
      market: req.market,
      side,
      baseAmount,
      reduceOnly: true,
      orderType: req.orderType,
      limitPrice: req.limitPrice,
      slippageBps: req.slippageBps,
      priorityFeeLamports: req.priorityFeeLamports,
      account: req.account,
      collateral: {
        mint: DRIFT_SETTLEMENT_MINT,
        amount: 0n,
        decimals: USDC_DECIMALS,
      },
      entryPrice,
      notionalUnits: notionalQuoteUnits(baseAmount, priceUnits),
    });
  }

  // ── internals ──

  async #entry(
    symbol: string,
    _side: PerpSide,
  ): Promise<{ entryPrice: number; priceUnits: bigint }> {
    const prices = await this.getPrices(symbol);
    const priceUnits = BigInt(
      Math.round(prices.markPrice * Number(PRICE_PRECISION)),
    );
    if (priceUnits <= 0n)
      throw new PerpsVenueError(this.id, `${symbol}: unusable mark price`);
    return { entryPrice: prices.markPrice, priceUnits };
  }

  async #order(args: {
    market: PerpMarket;
    side: PerpSide;
    baseAmount: bigint;
    reduceOnly: boolean;
    orderType: "market" | "limit";
    limitPrice: number | undefined;
    slippageBps: number;
    priorityFeeLamports: number;
    account: PerpAccountRef;
    collateral: TokenAmount;
    entryPrice: number;
    notionalUnits: bigint;
  }): Promise<VenueOrderBuild> {
    const { client, sdk } = this.#ready();

    if (
      args.orderType === "limit" &&
      (args.limitPrice === undefined ||
        !Number.isFinite(args.limitPrice) ||
        args.limitPrice <= 0)
    ) {
      throw new PerpsVenueError(
        this.id,
        "a limit order needs a positive limit price",
      );
    }

    const direction =
      args.side === "long"
        ? sdk.PositionDirection.LONG
        : sdk.PositionDirection.SHORT;
    const baseBn = new sdk.BN(args.baseAmount.toString());
    const params: Record<string, unknown> = {
      marketIndex: args.market.venueMarketIndex,
      marketType: sdk.MarketType.PERP,
      direction,
      baseAssetAmount: baseBn,
      reduceOnly: args.reduceOnly,
    };
    if (args.orderType === "limit" && args.limitPrice !== undefined) {
      params.price = new sdk.BN(
        Math.round(args.limitPrice * Number(PRICE_PRECISION)).toString(),
      );
    }

    const build =
      args.orderType === "limit"
        ? sdk.getLimitOrderParams
        : sdk.getMarketOrderParams;
    if (!build)
      throw new PerpsVenueError(
        this.id,
        `SDK does not export a ${args.orderType}-order params builder`,
      );
    const orderParams = build(params);

    const ix = await this.#callAsync(
      () => client.getPlacePerpOrderIx(orderParams, args.account.subAccountId),
      "getPlacePerpOrderIx",
    );

    // Worst-case fill size: the same notional bought at a `slippageBps` worse price.
    const minBaseAmount =
      (args.baseAmount * BigInt(10_000 - Math.min(args.slippageBps, 10_000))) /
      10_000n;

    const liq = this.#safe(() => {
      const user = client.getUser(args.account.subAccountId);
      const delta: Bn = new sdk.BN(
        (args.side === "long" ? args.baseAmount : -args.baseAmount).toString(),
      );
      const entry: Bn = new sdk.BN(
        Math.round(args.entryPrice * Number(PRICE_PRECISION)).toString(),
      );
      return priceFrom(
        user.liquidationPrice(args.market.venueMarketIndex, delta, entry),
      );
    });

    return this.#assemble([ix], {
      expectedBaseAmount: args.baseAmount,
      minBaseAmount,
      entryPrice: args.entryPrice,
      notional: quoteAmount(args.notionalUnits),
      estimatedLiquidationPrice: liq,
      warnings:
        liq === undefined
          ? [
              "Drift produced no liquidation estimate — the guards will fall back to the isolated model",
            ]
          : [],
      priorityFeeLamports: args.priorityFeeLamports,
    });
  }

  /**
   * Assemble instructions into an unsigned versioned transaction.
   *
   * The blockhash pair reported to the kernel comes from OUR `BlockhashSource`,
   * not from whatever the SDK embedded. If the two differ (they are fetched
   * moments apart), the reported `lastValidBlockHeight` is at worst slightly
   * early or slightly late — and both are safe: expiry is TERMINAL in the
   * kernel, so an early give-up releases the reservation and a late one simply
   * fails to confirm. Neither can re-sign, which is the property that matters.
   */
  async #assemble(
    ixs: unknown[],
    extra: {
      expectedBaseAmount: bigint;
      minBaseAmount: bigint;
      entryPrice: number;
      notional: TokenAmount;
      estimatedLiquidationPrice: number | undefined;
      warnings: string[];
      priorityFeeLamports?: number;
    },
  ): Promise<VenueOrderBuild> {
    const { client } = this.#ready();
    const { blockhash, lastValidBlockHeight } =
      await this.#opts.blockhash.latestBlockhash();
    const priorityFeeLamports =
      extra.priorityFeeLamports ??
      this.#opts.priorityFeeLamports ??
      DEFAULT_PRIORITY_FEE_LAMPORTS;

    const lookupTables = client.fetchMarketLookupTableAccount
      ? await this.#safeAsync(() => client.fetchMarketLookupTableAccount!())
      : undefined;

    const tx = await this.#callAsync(
      () =>
        client.buildTransaction(
          ixs,
          {
            computeUnitsPrice: priorityFeeLamports,
            recentBlockhash: blockhash,
          },
          undefined,
          lookupTables ? [lookupTables] : undefined,
        ),
      "buildTransaction",
    );

    const wire = this.#call(() => tx.serialize(), "serialize");
    const unsignedTxBase64 = Buffer.from(wire).toString("base64");

    const warnings = [...extra.warnings];
    const embedded = tx.message?.recentBlockhash;
    if (embedded && embedded !== blockhash) {
      warnings.push(
        "the SDK embedded a different blockhash than the one reported; expiry is terminal either way",
      );
    }

    return {
      unsignedTxBase64,
      recentBlockhash: embedded ?? blockhash,
      lastValidBlockHeight,
      priorityFeeLamports,
      expectedBaseAmount: extra.expectedBaseAmount,
      minBaseAmount: extra.minBaseAmount,
      entryPrice: extra.entryPrice,
      notional: extra.notional,
      estimatedLiquidationPrice: extra.estimatedLiquidationPrice,
      venueWarnings: warnings,
    };
  }

  /** Wrap a synchronous SDK call so an SDK shape change surfaces as a venue error, never as `undefined` leaking into a guard. */
  #call<T>(fn: () => T, what: string): T {
    try {
      return fn();
    } catch (err) {
      throw new PerpsVenueError(
        this.id,
        `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #callAsync<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new PerpsVenueError(
        this.id,
        `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** For genuinely optional reads: absence is a valid answer the guards know how to refuse. */
  #safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  async #safeAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }
}

function quoteAmount(amount: bigint): TokenAmount {
  return { mint: DRIFT_SETTLEMENT_MINT, amount, decimals: USDC_DECIMALS };
}
