/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Venue-agnostic concentrated-liquidity vocabulary.
 *
 * Every concentrated-liquidity AMM discretises price into levels: Meteora DLMM
 * calls them *bins* stepped by `binStep` bps, Uniswap V3 calls them *ticks*.
 * This module speaks only in that shared vocabulary — `PriceLevel`, `levelStepBps`,
 * `LiquidityShape` — so nothing Meteora-specific (no `BN`, no `PublicKey`, no
 * `LbPair`, no `StrategyType`) crosses the port. Amounts are always `bigint` base
 * units, matching the kernel's `TokenAmount`.
 */

/**
 * A discrete price level index. `price(level) = (1 + levelStepBps/10_000) ^ level`
 * in *lamport* terms; multiply by `10^(baseDecimals - quoteDecimals)` for the UI price.
 * Meteora calls this a bin id.
 */
export type PriceLevel = number;

/**
 * How liquidity is spread across the levels of a position.
 *  - `spot`    uniform across the range (the default; lowest maintenance)
 *  - `curve`   concentrated at the active level (max fee capture, max IL)
 *  - `bid-ask` concentrated at the range edges (mean-reversion / exit ladder)
 */
export const LIQUIDITY_SHAPES = ["spot", "curve", "bid-ask"] as const;
export type LiquidityShape = (typeof LIQUIDITY_SHAPES)[number];

/** Which side(s) of the active level a deposit funds. */
export type DepositSide = "quote-only" | "base-only" | "both";

/** A pool, normalised. `base` is the token being priced; `quote` is what it is priced in. */
export interface PoolSummary {
  /** Venue id, e.g. `meteora-dlmm`. */
  readonly venue: string;
  readonly address: string;
  readonly name: string | undefined;

  readonly baseMint: string;
  readonly baseDecimals: number;
  readonly quoteMint: string;
  readonly quoteDecimals: number;

  /** Geometric step between adjacent price levels, in bps. Meteora `binStep`. */
  readonly levelStepBps: number;
  /** The level the pool is currently trading in. Meteora `activeId`. */
  readonly activeLevel: PriceLevel;
  /** UI price of the active level (quote per 1 base), for display only — never for cap math. */
  readonly activePrice: number;

  /** Pool base fee in bps. */
  readonly baseFeeBps: number;

  /** TVL denominated in the quote asset's base units, when the venue reports it. */
  readonly liquidityQuote: bigint | undefined;
  readonly volume24hUsd: number | undefined;
  readonly fees24hUsd: number | undefined;
  /** Annualised fee/TVL, as reported by the venue. Advisory only. */
  readonly feeApr24hPct: number | undefined;

  /** True when the pool's base or quote mint uses the Token-2022 program. */
  readonly hasToken2022: boolean;
}

/** One wallet-owned liquidity position. */
export interface LpPosition {
  readonly venue: string;
  readonly poolAddress: string;
  readonly positionAddress: string;
  readonly owner: string;

  readonly baseMint: string;
  readonly baseDecimals: number;
  readonly quoteMint: string;
  readonly quoteDecimals: number;

  readonly levelStepBps: number;
  /** Inclusive level range this position holds liquidity across. */
  readonly lowerLevel: PriceLevel;
  readonly upperLevel: PriceLevel;
  /** The pool's active level at the time this snapshot was read. */
  readonly activeLevel: PriceLevel;

  /** Base-unit amounts currently deposited. */
  readonly baseAmount: bigint;
  readonly quoteAmount: bigint;
  /** Base-unit fees earned and not yet claimed. */
  readonly unclaimedFeeBase: bigint;
  readonly unclaimedFeeQuote: bigint;

  readonly shape: LiquidityShape | undefined;
  /** Epoch ms the position was opened, when the venue records it. */
  readonly openedAt: number | undefined;
}

/**
 * A venue-built, wallet-signable transaction. Deliberately the *same* shape the
 * kernel's `TradeIntent` needs: base64 wire tx + the blockhash lifecycle the
 * reconciler owns. Nothing here is signed and nothing here is a keypair.
 */
export interface VenueTxDraft {
  readonly unsignedTxBase64: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly priorityFeeLamports: number;
  /**
   * Base58 pubkeys of signers this tx needs *beyond* the agent's wallet — e.g. the
   * fresh position keypair DLMM's `initialize_position*` family requires. The
   * wallet contract signs exactly one key, so a non-empty list is a hard refusal
   * (`POOL_EXTRA_SIGNER`) rather than something quietly worked around.
   */
  readonly extraSigners: readonly string[];
  readonly description: string;
}

// ── request shapes ──

export interface ListPoolsQuery {
  /** Only pools containing this mint on either side. */
  readonly mint: string;
  /** Minimum TVL in quote base units. Venue-side filter when supported. */
  readonly minLiquidityQuote?: bigint;
  readonly limit?: number;
}

/** A level range, expressed the way a caller thinks about it. */
export interface RangeSpec {
  /** Levels below the active level to cover (>= 0). */
  readonly belowLevels: number;
  /** Levels above the active level to cover (>= 0). */
  readonly aboveLevels: number;
}

export interface OpenLiquidityRequest {
  readonly poolAddress: string;
  readonly owner: string;
  /** Base-unit amount of the quote asset to deposit (the leg the kernel caps). */
  readonly quoteAmount: bigint;
  /** Base-unit amount of the base asset to deposit. 0 for a quote-only position. */
  readonly baseAmount: bigint;
  readonly lowerLevel: PriceLevel;
  readonly upperLevel: PriceLevel;
  readonly shape: LiquidityShape;
  readonly priorityFeeLamports: number;
  /** Reuse an existing position instead of initialising a new one. */
  readonly positionAddress?: string;
}

export interface RemoveLiquidityRequest {
  readonly poolAddress: string;
  readonly positionAddress: string;
  readonly owner: string;
  /** 0..10_000. 10_000 withdraws the whole range. */
  readonly bpsToRemove: number;
  readonly claimFees: boolean;
  /** Close the (now empty) position account and reclaim its rent. */
  readonly closePosition: boolean;
  readonly priorityFeeLamports: number;
}

export interface ClaimFeesRequest {
  readonly poolAddress: string;
  readonly positionAddress: string;
  readonly owner: string;
  readonly priorityFeeLamports: number;
}

/**
 * The venue port. One implementation per AMM. Reads return normalised domain
 * objects; builders return an unsigned `VenueTxDraft` and nothing else — an
 * `AmmVenue` never signs, never broadcasts, and never sees a keypair.
 */
export interface AmmVenue {
  readonly id: string;

  listPools(query: ListPoolsQuery): Promise<readonly PoolSummary[]>;
  getPool(address: string): Promise<PoolSummary>;
  /**
   * One position, scoped to its owner. The owner is a parameter rather than
   * something the venue reads back off-chain: position accounts are wallet-owned,
   * every venue SDK enumerates them per owner, and asking for "whoever owns this
   * address" would invite a caller to act on somebody else's position.
   */
  getPosition(
    poolAddress: string,
    positionAddress: string,
    owner: string,
  ): Promise<LpPosition | null>;
  listPositions(
    owner: string,
    poolAddress?: string,
  ): Promise<readonly LpPosition[]>;

  buildOpen(req: OpenLiquidityRequest): Promise<VenueTxDraft>;
  buildRemove(req: RemoveLiquidityRequest): Promise<VenueTxDraft>;
  buildClaimFees(req: ClaimFeesRequest): Promise<VenueTxDraft>;
}
