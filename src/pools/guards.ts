/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { type MintInfo } from "../kernel/contracts.js";
import {
  SOL_DECIMALS,
  type TokenAmount,
  USDC_DECIMALS,
  quoteBucketFor,
  toBaseUnits,
} from "../kernel/money.js";
import type { RugHeat } from "./signals.js";
import { refuse, type Refusal } from "./errors.js";
import type { LpPosition, PoolSummary, PriceLevel } from "./types.js";

/**
 * Pure, synchronous, **fail-closed** guards for liquidity and bonding-curve
 * actions.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **No I/O, no clock, no randomness.** Every input is passed in, so every
 *     branch is unit-testable and nothing here can hang a trade.
 *  2. **Absent evidence is a refusal.** A missing mint record, a missing rug-heat
 *     reading, an unknown TVL — each returns a `Refusal`, never a pass. The
 *     failure mode of "we couldn't check" must be identical to "the check failed".
 *  3. **Caps are denominated in the asset that leaves the wallet.** No price
 *     oracle sits in this path, exactly as in the kernel's input-leg caps: a
 *     memecoin with a broken price feed cannot inflate its way past a limit.
 *
 * These run *before* the kernel and add nothing to it. `TradeGateway.execute()`
 * still re-derives everything it cares about from the intent itself.
 */

/** Per-quote-asset limits, in that asset's base units. */
export interface QuoteLimits {
  /** Max input-leg amount for one value-moving pool/curve action. */
  readonly maxSpendPerAction: bigint;
  /** Max total quote notional allowed to sit inside a single LP position. */
  readonly maxLpPositionQuote: bigint;
  /** A pool below this TVL (quote base units) is refused outright. */
  readonly minPoolLiquidityQuote: bigint;
}

export interface PoolGuardConfig {
  readonly sol: QuoteLimits;
  readonly usdc: QuoteLimits;

  /** Hard ceiling on concurrent open LP positions across all venues. */
  readonly maxConcurrentPositions: number;

  /**
   * For a two-sided deposit the base leg also leaves the wallet, and the kernel
   * only caps the quote leg. This bounds the base leg as a percentage of what the
   * wallet currently holds of that mint — oracle-free, denominated in the asset
   * itself. 100 disables the check; 0 forbids two-sided deposits entirely.
   */
  readonly maxBaseLegPctOfHoldings: number;

  /**
   * Rug-heat at or above this is a **rejection**, not a warning. Sourced from
   * A signals engine's `rugHeatScore()` (0 = clean, 100 = burning); see `signals.ts`.
   */
  readonly maxRugHeat: number;

  /** Slippage bound for bonding-curve buys/sells, in bps. */
  readonly maxCurveSlippageBps: number;
  /** A curve holding less real SOL than this is untradeable-by-policy. */
  readonly minCurveRealSolLamports: bigint;

  /** Mints explicitly permitted to carry a live mint/freeze authority. */
  readonly authorityAllowlist: readonly string[];
  /** Phase parity with the kernel: Token-2022 legs are refused unless enabled. */
  readonly allowToken2022: boolean;

  /** Widest level span a single position may cover. DLMM's own limit is 70 bins. */
  readonly maxLevelSpan: number;
}

/** DLMM stores at most 70 bins in one position account (`DEFAULT_BIN_PER_POSITION`). */
export const MAX_LEVELS_PER_POSITION = 70;

/**
 * Deliberately tight defaults. LP is a longer-dated, harder-to-exit exposure than
 * a swap, so these sit *below* the kernel's swap caps rather than beside them.
 */
export function defaultPoolGuardConfig(): PoolGuardConfig {
  return {
    sol: {
      maxSpendPerAction: toBaseUnits(0.5, SOL_DECIMALS),
      maxLpPositionQuote: toBaseUnits(2, SOL_DECIMALS),
      minPoolLiquidityQuote: toBaseUnits(50, SOL_DECIMALS),
    },
    usdc: {
      maxSpendPerAction: toBaseUnits(100, USDC_DECIMALS),
      maxLpPositionQuote: toBaseUnits(400, USDC_DECIMALS),
      minPoolLiquidityQuote: toBaseUnits(10_000, USDC_DECIMALS),
    },
    maxConcurrentPositions: 5,
    maxBaseLegPctOfHoldings: 25,
    maxRugHeat: 60,
    maxCurveSlippageBps: 300,
    minCurveRealSolLamports: toBaseUnits(2, SOL_DECIMALS),
    authorityAllowlist: [],
    allowToken2022: false,
    maxLevelSpan: MAX_LEVELS_PER_POSITION,
  };
}

export function limitsFor(
  cfg: PoolGuardConfig,
  mint: string,
): QuoteLimits | null {
  const bucket = quoteBucketFor(mint);
  if (bucket === "sol") return cfg.sol;
  if (bucket === "usdc") return cfg.usdc;
  return null;
}

// ── individual guards ────────────────────────────────────────────────────────

/**
 * Input-leg spend cap. Mirrors the kernel's denomination rule: only quote-asset
 * inputs (SOL/USDC) are capped in notional terms, because only those can be
 * bounded without a price oracle. A token input (a sell) is not capped here —
 * that is the kernel's `quoteBucketFor(...) === null` branch, restated, not a hole.
 */
export function guardSpend(
  cfg: PoolGuardConfig,
  input: TokenAmount,
): Refusal | null {
  if (input.amount <= 0n) {
    return refuse("POOL_SPEND_CAP", "input amount must be positive");
  }
  const limits = limitsFor(cfg, input.mint);
  if (!limits) return null; // selling a token: nothing leaves that a quote cap can bound.
  if (input.amount > limits.maxSpendPerAction) {
    return refuse(
      "POOL_SPEND_CAP",
      `spend ${input.amount} exceeds the per-action cap ${limits.maxSpendPerAction}`,
      {
        amount: input.amount.toString(),
        cap: limits.maxSpendPerAction.toString(),
      },
    );
  }
  return null;
}

/**
 * Live mint or freeze authority is a rejection unless the mint is explicitly
 * allowlisted. A `null`/`undefined` entry means we could not read the mint — also
 * a rejection. Token-2022 is refused for parity with the kernel's phase-1 stance.
 */
export function guardTokenAuthorities(
  cfg: PoolGuardConfig,
  mints: readonly (MintInfo | null | undefined)[],
): Refusal | null {
  if (mints.length === 0) {
    return refuse(
      "POOL_MINT_AUTHORITY",
      "no mint records supplied — cannot verify authorities",
    );
  }
  for (const info of mints) {
    if (!info) {
      return refuse(
        "POOL_MINT_AUTHORITY",
        "mint record unavailable — refusing rather than assuming it is clean",
      );
    }
    if (!cfg.allowToken2022 && info.isToken2022) {
      return refuse(
        "POOL_TOKEN2022",
        `${info.mint} is a Token-2022 mint (transfer fees/hooks); refused`,
        {
          mint: info.mint,
        },
      );
    }
    const allowlisted = cfg.authorityAllowlist.includes(info.mint);
    if (allowlisted) continue;
    if (info.mintAuthority) {
      return refuse(
        "POOL_MINT_AUTHORITY",
        `${info.mint} still has a live mint authority (supply can be inflated)`,
        {
          mint: info.mint,
          authority: info.mintAuthority,
        },
      );
    }
    if (info.freezeAuthority) {
      return refuse(
        "POOL_FREEZE_AUTHORITY",
        `${info.mint} still has a live freeze authority (your tokens can be frozen)`,
        {
          mint: info.mint,
          authority: info.freezeAuthority,
        },
      );
    }
  }
  return null;
}

/**
 * Rug-heat as a hard gate. A signals engine returns 60 for a mint
 * with no trades in the window, so "we have never seen this token trade" lands on
 * the reject side of the default threshold by construction — which is the point.
 */
export function guardRugHeat(
  cfg: PoolGuardConfig,
  heat: RugHeat | null | undefined,
): Refusal | null {
  if (!heat || !Number.isFinite(heat.score)) {
    return refuse(
      "POOL_RUG_HEAT",
      "no rug-heat reading available — refusing rather than trading blind",
    );
  }
  if (heat.score >= cfg.maxRugHeat) {
    return refuse(
      "POOL_RUG_HEAT",
      `rug-heat ${heat.score}/100 is at or above the ${cfg.maxRugHeat} rejection threshold`,
      {
        score: heat.score,
        threshold: cfg.maxRugHeat,
        reasons: heat.reasons.slice(0, 3),
      },
    );
  }
  return null;
}

/** Pool TVL floor, denominated in the pool's quote asset. Unknown TVL is a refusal. */
export function guardPoolLiquidity(
  cfg: PoolGuardConfig,
  pool: PoolSummary,
): Refusal | null {
  const limits = limitsFor(cfg, pool.quoteMint);
  if (!limits) {
    return refuse(
      "POOL_LIQUIDITY_FLOOR",
      `pool quote asset ${pool.quoteMint} is not a supported quote asset (SOL/USDC)`,
    );
  }
  if (pool.liquidityQuote === undefined) {
    return refuse(
      "POOL_LIQUIDITY_FLOOR",
      "pool TVL unavailable — refusing rather than assuming it is deep enough",
    );
  }
  if (pool.liquidityQuote < limits.minPoolLiquidityQuote) {
    return refuse(
      "POOL_LIQUIDITY_FLOOR",
      `pool TVL ${pool.liquidityQuote} is below the ${limits.minPoolLiquidityQuote} floor`,
      {
        tvl: pool.liquidityQuote.toString(),
        floor: limits.minPoolLiquidityQuote.toString(),
      },
    );
  }
  return null;
}

export interface LpSizingSubject {
  readonly pool: PoolSummary;
  /** Quote base units being added by this action. */
  readonly addQuote: bigint;
  /** Quote base units already in the position being added to (0 for a new one). */
  readonly existingPositionQuote: bigint;
  /** Every currently-open position, across all venues. */
  readonly openPositions: readonly LpPosition[];
  /** True when this action opens a brand-new position rather than topping one up. */
  readonly isNewPosition: boolean;
}

/** Per-position notional cap plus the concurrent-position count cap. */
export function guardLpSizing(
  cfg: PoolGuardConfig,
  s: LpSizingSubject,
): Refusal | null {
  const limits = limitsFor(cfg, s.pool.quoteMint);
  if (!limits) {
    return refuse(
      "POOL_POSITION_CAP",
      `pool quote asset ${s.pool.quoteMint} is not a supported quote asset (SOL/USDC)`,
    );
  }
  if (s.addQuote < 0n || s.existingPositionQuote < 0n) {
    return refuse("POOL_POSITION_CAP", "position amounts must be non-negative");
  }
  const after = s.existingPositionQuote + s.addQuote;
  if (after > limits.maxLpPositionQuote) {
    return refuse(
      "POOL_POSITION_CAP",
      `position would hold ${after} quote, above the ${limits.maxLpPositionQuote} cap`,
      {
        after: after.toString(),
        cap: limits.maxLpPositionQuote.toString(),
      },
    );
  }
  if (s.isNewPosition && s.openPositions.length >= cfg.maxConcurrentPositions) {
    return refuse(
      "POOL_MAX_POSITIONS",
      `already holding ${s.openPositions.length} positions (max ${cfg.maxConcurrentPositions})`,
      {
        open: s.openPositions.length,
        max: cfg.maxConcurrentPositions,
      },
    );
  }
  return null;
}

/**
 * The base (non-quote) leg of a two-sided deposit leaves the wallet too, and the
 * kernel's input-leg cap only sees the quote leg. Bound it as a share of current
 * holdings of that same mint — oracle-free, and it degrades to "reject" when the
 * holding is unknown.
 */
export function guardBaseLeg(
  cfg: PoolGuardConfig,
  args: {
    readonly baseAmount: bigint;
    readonly baseHoldings: bigint | null | undefined;
  },
): Refusal | null {
  if (args.baseAmount <= 0n) return null; // quote-only deposit: no second leg to bound.
  if (cfg.maxBaseLegPctOfHoldings <= 0) {
    return refuse(
      "POOL_BASE_LEG_CAP",
      "two-sided deposits are disabled (maxBaseLegPctOfHoldings = 0)",
    );
  }
  if (args.baseHoldings === null || args.baseHoldings === undefined) {
    return refuse(
      "POOL_BASE_LEG_CAP",
      "wallet holding of the base mint is unknown — cannot bound the second leg",
    );
  }
  if (args.baseHoldings <= 0n) {
    return refuse("POOL_BASE_LEG_CAP", "wallet holds none of the base mint");
  }
  const allowed =
    (args.baseHoldings * BigInt(Math.floor(cfg.maxBaseLegPctOfHoldings))) /
    100n;
  if (args.baseAmount > allowed) {
    return refuse(
      "POOL_BASE_LEG_CAP",
      `base leg ${args.baseAmount} exceeds ${cfg.maxBaseLegPctOfHoldings}% of holdings (${allowed})`,
      {
        amount: args.baseAmount.toString(),
        allowed: allowed.toString(),
      },
    );
  }
  return null;
}

/** Level range sanity: ordered, finite, integral, and no wider than one position holds. */
export function guardLevelRange(
  cfg: PoolGuardConfig,
  range: {
    readonly lowerLevel: PriceLevel;
    readonly upperLevel: PriceLevel;
    readonly activeLevel: PriceLevel;
  },
): Refusal | null {
  const { lowerLevel, upperLevel, activeLevel } = range;
  for (const [name, v] of [
    ["lowerLevel", lowerLevel],
    ["upperLevel", upperLevel],
    ["activeLevel", activeLevel],
  ] as const) {
    if (!Number.isInteger(v))
      return refuse(
        "POOL_RANGE_INVALID",
        `${name} must be an integer level, got ${String(v)}`,
      );
  }
  if (upperLevel < lowerLevel) {
    return refuse(
      "POOL_RANGE_INVALID",
      `upperLevel ${upperLevel} is below lowerLevel ${lowerLevel}`,
    );
  }
  const span = upperLevel - lowerLevel + 1;
  const cap = Math.min(cfg.maxLevelSpan, MAX_LEVELS_PER_POSITION);
  if (span > cap) {
    return refuse(
      "POOL_RANGE_INVALID",
      `range spans ${span} levels, above the ${cap} maximum`,
      { span, cap },
    );
  }
  return null;
}

/** Bonding-curve slippage bound. Non-finite / negative slippage is a refusal. */
export function guardCurveSlippage(
  cfg: PoolGuardConfig,
  slippageBps: number,
): Refusal | null {
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    return refuse(
      "POOL_SLIPPAGE",
      `slippage must be a finite non-negative bps value, got ${String(slippageBps)}`,
    );
  }
  if (slippageBps > cfg.maxCurveSlippageBps) {
    return refuse(
      "POOL_SLIPPAGE",
      `slippage ${slippageBps}bps exceeds the ${cfg.maxCurveSlippageBps}bps bound`,
      {
        slippageBps,
        bound: cfg.maxCurveSlippageBps,
      },
    );
  }
  return null;
}

/**
 * Minimum-liquidity floor for a bonding curve, read off the curve's *real* SOL
 * reserves — the SOL actually withdrawable, not the virtual reserve that only
 * shapes the price. A fresh curve with 0.1 SOL in it cannot absorb an exit.
 */
export function guardCurveLiquidity(
  cfg: PoolGuardConfig,
  curve: {
    readonly realSolReserves: bigint | null | undefined;
    readonly complete: boolean;
  },
): Refusal | null {
  if (curve.complete) {
    return refuse(
      "POOL_MIGRATED",
      "this curve has completed and migrated — route it through the Jupiter swap path",
    );
  }
  if (curve.realSolReserves === null || curve.realSolReserves === undefined) {
    return refuse(
      "POOL_LIQUIDITY_FLOOR",
      "curve reserves unavailable — refusing rather than trading blind",
    );
  }
  if (curve.realSolReserves < cfg.minCurveRealSolLamports) {
    return refuse(
      "POOL_LIQUIDITY_FLOOR",
      `curve holds ${curve.realSolReserves} lamports, below the ${cfg.minCurveRealSolLamports} floor`,
      {
        reserves: curve.realSolReserves.toString(),
        floor: cfg.minCurveRealSolLamports.toString(),
      },
    );
  }
  return null;
}

// ── composites ───────────────────────────────────────────────────────────────

/** Run a sequence of checks and return the FIRST refusal. Order is significance order. */
function first(...checks: readonly (Refusal | null)[]): Refusal | null {
  for (const c of checks) if (c) return c;
  return null;
}

export interface LpOpenSubject extends LpSizingSubject {
  readonly input: TokenAmount;
  readonly baseAmount: bigint;
  readonly baseHoldings: bigint | null | undefined;
  readonly mints: readonly (MintInfo | null | undefined)[];
  readonly rugHeat: RugHeat | null | undefined;
  readonly lowerLevel: PriceLevel;
  readonly upperLevel: PriceLevel;
}

/** Every guard that must pass before an LP open/add intent may be built. */
export function guardLpOpen(
  cfg: PoolGuardConfig,
  s: LpOpenSubject,
): Refusal | null {
  return first(
    guardTokenAuthorities(cfg, s.mints),
    guardRugHeat(cfg, s.rugHeat),
    guardPoolLiquidity(cfg, s.pool),
    guardSpend(cfg, s.input),
    guardLpSizing(cfg, s),
    guardBaseLeg(cfg, {
      baseAmount: s.baseAmount,
      baseHoldings: s.baseHoldings,
    }),
    guardLevelRange(cfg, {
      lowerLevel: s.lowerLevel,
      upperLevel: s.upperLevel,
      activeLevel: s.pool.activeLevel,
    }),
  );
}

export interface CurveTradeSubject {
  readonly input: TokenAmount;
  readonly slippageBps: number;
  readonly curve: {
    readonly realSolReserves: bigint | null | undefined;
    readonly complete: boolean;
  };
  readonly mints: readonly (MintInfo | null | undefined)[];
  readonly rugHeat: RugHeat | null | undefined;
}

/**
 * Every guard that must pass before a bonding-curve buy intent may be built.
 *
 * Note the deliberate asymmetry with `guardCurveSell`: a buy is discretionary and
 * gets the full gate; a sell is an *exit* and must never be blocked by rug-heat or
 * a liquidity floor — those are exactly the conditions under which you most want
 * out. Blocking exits is how a safety system becomes the rug.
 */
export function guardCurveBuy(
  cfg: PoolGuardConfig,
  s: CurveTradeSubject,
): Refusal | null {
  return first(
    guardTokenAuthorities(cfg, s.mints),
    guardRugHeat(cfg, s.rugHeat),
    guardCurveLiquidity(cfg, s.curve),
    guardCurveSlippage(cfg, s.slippageBps),
    guardSpend(cfg, s.input),
  );
}

/** Exit path: shape checks only. A migrated curve still redirects to Jupiter. */
export function guardCurveSell(
  cfg: PoolGuardConfig,
  s: {
    readonly input: TokenAmount;
    readonly slippageBps: number;
    readonly complete: boolean;
  },
): Refusal | null {
  if (s.complete) {
    return refuse(
      "POOL_MIGRATED",
      "this curve has completed and migrated — route the sell through the Jupiter swap path",
    );
  }
  return first(
    guardCurveSlippage(cfg, s.slippageBps),
    guardSpend(cfg, s.input),
  );
}
