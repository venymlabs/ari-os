/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TOKEN_2022_PROGRAM_ID } from "../../chains/solana/spl.js";
import { toBaseUnits } from "../../kernel/money.js";
import type { ChainReader } from "../chain.js";
import { PoolGuardError } from "../errors.js";
import type {
  AmmVenue,
  ClaimFeesRequest,
  ListPoolsQuery,
  LpPosition,
  OpenLiquidityRequest,
  PoolSummary,
  RemoveLiquidityRequest,
  VenueTxDraft,
} from "../types.js";
import { binOfUiPrice, uiPriceOfBin } from "./bins.js";
import type { DataApiPool, MeteoraDataApi } from "./dlmm-api.js";
import {
  compileV0,
  type DlmmPoolHandle,
  type DlmmSdk,
  type SdkPoolState,
  type SdkPosition,
} from "./sdk-port.js";

export const METEORA_DLMM_VENUE_ID = "meteora-dlmm";

const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

/**
 * Meteora DLMM as an `AmmVenue`.
 *
 * Two sources, each used for what it is actually good at:
 *
 *  - the **keyless data API** for discovery and the economics a rebalance needs
 *    (TVL, 24h fees, APR) — no RPC credits, but it has no notion of the active
 *    bin, so any bin id derived from it is a display approximation;
 *  - the **SDK port** for authoritative on-chain state (`activeId`, reserves,
 *    positions) and for building transactions.
 *
 * `getPool` prefers the SDK and marks API-derived answers, so nothing downstream
 * ever mistakes a price-inverted bin estimate for the real active bin.
 *
 * Orientation convention: DLMM prices token **Y per X**, so `base = tokenX` and
 * `quote = tokenY` throughout. A pool whose Y side is not SOL or USDC therefore
 * has no supported quote asset, and `guardPoolLiquidity` refuses it — which is the
 * correct outcome, not an oversight.
 */
export class MeteoraDlmmVenue implements AmmVenue {
  readonly id = METEORA_DLMM_VENUE_ID;

  #sdk: DlmmSdk;
  #api: MeteoraDataApi | undefined;
  #chain: ChainReader;

  constructor(deps: {
    sdk: DlmmSdk;
    api?: MeteoraDataApi;
    chain: ChainReader;
  }) {
    this.#sdk = deps.sdk;
    this.#api = deps.api;
    this.#chain = deps.chain;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async listPools(query: ListPoolsQuery): Promise<readonly PoolSummary[]> {
    if (!this.#api) {
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "pool discovery needs the Meteora data API; none was configured",
      );
    }
    const { pools } = await this.#api.listPoolsForMint(
      query.mint,
      query.limit ?? 10,
    );
    const summaries = pools.map((p) => summaryFromApi(p));
    if (query.minLiquidityQuote === undefined) return summaries;
    const floor = query.minLiquidityQuote;
    return summaries.filter(
      (s) => s.liquidityQuote !== undefined && s.liquidityQuote >= floor,
    );
  }

  async getPool(address: string): Promise<PoolSummary> {
    const handle = await this.#sdk.openPool(address);
    const api = await this.#api?.getPool(address).catch(() => undefined);
    return summaryFromSdk(handle.state, api);
  }

  async getPosition(
    poolAddress: string,
    positionAddress: string,
    owner: string,
  ): Promise<LpPosition | null> {
    const handle = await this.#sdk.openPool(poolAddress);
    const positions = await handle.positionsOf(owner);
    const found = positions.find((p) => p.publicKey === positionAddress);
    return found ? positionFromSdk(found, handle.state) : null;
  }

  async listPositions(
    owner: string,
    poolAddress?: string,
  ): Promise<readonly LpPosition[]> {
    if (poolAddress) {
      const handle = await this.#sdk.openPool(poolAddress);
      const positions = await handle.positionsOf(owner);
      return positions.map((p) => positionFromSdk(p, handle.state));
    }
    const all = await this.#sdk.positionsOfUser(owner);
    const byPool = new Map<string, DlmmPoolHandle>();
    const out: LpPosition[] = [];
    for (const { pool, position } of all) {
      let handle = byPool.get(pool);
      if (!handle) {
        handle = await this.#sdk.openPool(pool);
        byPool.set(pool, handle);
      }
      out.push(positionFromSdk(position, handle.state));
    }
    return out;
  }

  // ── builders ───────────────────────────────────────────────────────────────

  async buildOpen(req: OpenLiquidityRequest): Promise<VenueTxDraft> {
    const handle = await this.#sdk.openPool(req.poolAddress);
    const parts = await handle.buildAddLiquidity({
      owner: req.owner,
      ...(req.positionAddress ? { positionAddress: req.positionAddress } : {}),
      lowerBinId: req.lowerLevel,
      upperBinId: req.upperLevel,
      // base = tokenX, quote = tokenY.
      totalXAmount: req.baseAmount,
      totalYAmount: req.quoteAmount,
      shape: req.shape,
    });
    return this.#draft(
      parts.instructions,
      parts.extraSigners,
      parts.description,
      req.owner,
      req.priorityFeeLamports,
    );
  }

  async buildRemove(req: RemoveLiquidityRequest): Promise<VenueTxDraft> {
    const handle = await this.#sdk.openPool(req.poolAddress);
    const positions = await handle.positionsOf(req.owner);
    const target = positions.find((p) => p.publicKey === req.positionAddress);
    if (!target)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        `position ${req.positionAddress} is not owned by ${req.owner}`,
      );
    if (req.bpsToRemove <= 0 || req.bpsToRemove > 10_000) {
      throw new PoolGuardError(
        "POOL_RANGE_INVALID",
        `bpsToRemove must be 1..10000, got ${req.bpsToRemove}`,
      );
    }
    const parts = await handle.buildRemoveLiquidity({
      owner: req.owner,
      positionAddress: req.positionAddress,
      fromBinId: target.lowerBinId,
      toBinId: target.upperBinId,
      bpsToRemove: req.bpsToRemove,
      claimAndClose: req.closePosition && req.bpsToRemove === 10_000,
    });
    return this.#draft(
      parts.instructions,
      parts.extraSigners,
      parts.description,
      req.owner,
      req.priorityFeeLamports,
    );
  }

  async buildClaimFees(req: ClaimFeesRequest): Promise<VenueTxDraft> {
    const handle = await this.#sdk.openPool(req.poolAddress);
    const parts = await handle.buildClaimFees({
      owner: req.owner,
      positionAddress: req.positionAddress,
    });
    return this.#draft(
      parts.instructions,
      parts.extraSigners,
      parts.description,
      req.owner,
      req.priorityFeeLamports,
    );
  }

  async #draft(
    instructions: readonly import("@solana/web3.js").TransactionInstruction[],
    extraSigners: readonly string[],
    description: string,
    payer: string,
    priorityFeeLamports: number,
  ): Promise<VenueTxDraft> {
    const { blockhash, lastValidBlockHeight } =
      await this.#chain.getLatestBlockhash();
    const { ComputeBudgetProgram } = await import("@solana/web3.js");
    const cuLimit = 600_000; // DLMM deposits touch several bin arrays; be generous.
    const microLamports = Math.floor(
      (Math.max(0, priorityFeeLamports) * 1_000_000) / cuLimit,
    );
    const withBudget = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...instructions,
    ];
    return {
      unsignedTxBase64: compileV0({
        payer,
        instructions: withBudget,
        recentBlockhash: blockhash,
      }),
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      priorityFeeLamports: Math.floor((microLamports * cuLimit) / 1_000_000),
      extraSigners,
      description,
    };
  }
}

// ── mapping ──────────────────────────────────────────────────────────────────

/** UI float → base units without float drift, refusing values outside `toFixed` range. */
export function uiToBaseUnits(
  value: number | undefined,
  decimals: number,
): bigint | undefined {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 1e21
  )
    return undefined;
  return toBaseUnits(value.toFixed(decimals), decimals);
}

export function summaryFromSdk(
  state: SdkPoolState,
  api?: DataApiPool,
): PoolSummary {
  return {
    venue: METEORA_DLMM_VENUE_ID,
    address: state.address,
    name: api?.name,
    baseMint: state.tokenXMint,
    baseDecimals: state.tokenXDecimals,
    quoteMint: state.tokenYMint,
    quoteDecimals: state.tokenYDecimals,
    levelStepBps: state.binStep,
    activeLevel: state.activeBinId,
    activePrice: uiPriceOfBin(
      state.activeBinId,
      state.binStep,
      state.tokenXDecimals,
      state.tokenYDecimals,
    ),
    baseFeeBps: state.baseFeeBps,
    // Quote-side reserves: the honest "can I get out" number, not a USD headline.
    liquidityQuote: state.reserveY,
    volume24hUsd: api?.volume?.["24h"],
    fees24hUsd: api?.fees?.["24h"],
    feeApr24hPct: api?.apr,
    hasToken2022:
      state.tokenXProgramId === TOKEN_2022 ||
      state.tokenYProgramId === TOKEN_2022,
  };
}

/**
 * Summary from the data API alone. `activeLevel` is *derived* from `current_price`
 * because the API does not report the active bin — good enough to rank pools, not
 * good enough to position liquidity, which is why every builder re-reads the pool
 * through the SDK first.
 */
export function summaryFromApi(p: DataApiPool): PoolSummary {
  const binStep = p.pool_config?.bin_step ?? 0;
  const baseDecimals = p.token_x.decimals;
  const quoteDecimals = p.token_y.decimals;
  let activeLevel = 0;
  let activePrice = p.current_price ?? 0;
  if (binStep > 0 && p.current_price !== undefined && p.current_price > 0) {
    try {
      activeLevel = binOfUiPrice(
        p.current_price,
        binStep,
        baseDecimals,
        quoteDecimals,
      );
      activePrice = uiPriceOfBin(
        activeLevel,
        binStep,
        baseDecimals,
        quoteDecimals,
      );
    } catch {
      activeLevel = 0;
    }
  }
  return {
    venue: METEORA_DLMM_VENUE_ID,
    address: p.address,
    name: p.name,
    baseMint: p.token_x.address,
    baseDecimals,
    quoteMint: p.token_y.address,
    quoteDecimals,
    levelStepBps: binStep,
    activeLevel,
    activePrice,
    baseFeeBps: Math.round((p.pool_config?.base_fee_pct ?? 0) * 100),
    liquidityQuote: uiToBaseUnits(p.token_y_amount, quoteDecimals),
    volume24hUsd: p.volume?.["24h"],
    fees24hUsd: p.fees?.["24h"],
    feeApr24hPct: p.apr,
    hasToken2022: false, // the API does not report token programs; the SDK path does.
  };
}

export function positionFromSdk(
  p: SdkPosition,
  state: SdkPoolState,
): LpPosition {
  return {
    venue: METEORA_DLMM_VENUE_ID,
    poolAddress: state.address,
    positionAddress: p.publicKey,
    owner: p.owner,
    baseMint: state.tokenXMint,
    baseDecimals: state.tokenXDecimals,
    quoteMint: state.tokenYMint,
    quoteDecimals: state.tokenYDecimals,
    levelStepBps: state.binStep,
    lowerLevel: p.lowerBinId,
    upperLevel: p.upperBinId,
    activeLevel: state.activeBinId,
    baseAmount: p.totalXAmount,
    quoteAmount: p.totalYAmount,
    unclaimedFeeBase: p.feeX,
    unclaimedFeeQuote: p.feeY,
    shape: undefined, // DLMM does not record the strategy used; callers track it themselves.
    openedAt: p.lastUpdatedAt,
  };
}
