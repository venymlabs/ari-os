/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type QuoteBucket,
  formatAmount,
  quoteBucketFor,
} from "../kernel/money.js";
import {
  isPerpGuardError,
  type PerpGuardCode,
  PerpGuardError,
} from "./errors.js";
import type { PortfolioExposure } from "./exposure.js";
import {
  assertPerpIntentShape,
  isOpeningKind,
  isReducingKind,
  type PerpIntent,
} from "./intent.js";
import {
  liquidationDistanceBps,
  modelLiquidationPrice,
  oracleDivergenceBps,
  reconcileLiquidation,
} from "./liquidation.js";
import { capsFor, notionalFromCollateral, type PerpsPolicy } from "./policy.js";
import type { PerpPosition } from "./types.js";

/**
 * Perps guards — pure, synchronous, total, and fail-closed.
 *
 * Every rule is a `(intent, ctx) => violation | null` function of data the
 * caller already has. No I/O, no clock, no randomness: the entire perps safety
 * layer is decidable from its arguments, which is exactly what makes it
 * exhaustively unit-testable and what keeps it honest about missing data —
 * "I could not read it" is always a refusal, never a default.
 *
 * These run IN ADDITION to the kernel's `staticGuards` + input-leg cap
 * reservation, never instead of them. The margin still passes through the same
 * chokepoint as any swap.
 */

export interface PerpViolation {
  readonly code: PerpGuardCode;
  readonly message: string;
  readonly details: Record<string, unknown> | undefined;
}

export interface PerpGuardContext {
  readonly policy: PerpsPolicy;
  /** Mirrored from the kernel's `PolicyConfig` so the perps layer sees the same arm state. */
  readonly killSwitch: boolean;
  readonly executionEnabled: boolean;
  /** Portfolio snapshot. A stale snapshot refuses every opening intent. */
  readonly exposure: PortfolioExposure;
  /** The existing position in this market, if any. */
  readonly position: PerpPosition | undefined;
  /** Whether the venue subaccount already exists. Creation is its own gated step. */
  readonly accountInitialized: boolean;
  readonly dryRun: boolean;
}

type Rule = (intent: PerpIntent, ctx: PerpGuardContext) => PerpViolation | null;

function v(
  code: PerpGuardCode,
  message: string,
  details?: Record<string, unknown>,
): PerpViolation {
  return { code, message, details };
}

// ── arm state ────────────────────────────────────────────────────────────────

/**
 * Kill switch and wind-down both mean the same thing here: RISK MAY ONLY GO
 * DOWN. Opening intents are refused; reducing intents survive this layer so the
 * agent can always propose getting flat.
 *
 * Honest note: the kernel's own `staticGuards` refuses EVERYTHING while the kill
 * switch is engaged, including a close. Wind-down is therefore the mechanism
 * that actually lets an operator de-risk while staying armed; the kill switch is
 * a full stop, and getting flat under it is a deliberate human action.
 */
const armState: Rule = (i, ctx) => {
  if (ctx.killSwitch && isOpeningKind(i.kind)) {
    return v(
      "KILL_SWITCH",
      "kill switch is engaged — perp exposure may only be reduced",
    );
  }
  if (!ctx.dryRun && !ctx.executionEnabled) {
    return v(
      "PERPS_DISABLED",
      "execution is disabled — Aetheria is in dry-run. Use /enable to arm.",
    );
  }
  if (!ctx.policy.perpsEnabled && isOpeningKind(i.kind)) {
    return v(
      "PERPS_DISABLED",
      "perps are not enabled — only reducing an existing position is permitted",
    );
  }
  if (ctx.policy.windDownOnly && isOpeningKind(i.kind)) {
    return v(
      "WIND_DOWN_ONLY",
      "wind-down mode is active — reduce-only intents may proceed, opens may not",
    );
  }
  return null;
};

const accountReady: Rule = (i, ctx) => {
  if (ctx.accountInitialized) return null;
  return v(
    "ACCOUNT_NOT_INITIALIZED",
    `no ${i.perp.venue} subaccount ${i.perp.accountSubId} — initialise it as a separate, explicit step`,
    {
      venue: i.perp.venue,
      subAccountId: i.perp.accountSubId,
    },
  );
};

// ── market admissibility ─────────────────────────────────────────────────────

const marketAllowed: Rule = (i, ctx) => {
  const market = i.perp.market.toUpperCase();
  if (ctx.policy.marketDenylist.some((m) => m.toUpperCase() === market)) {
    return v("MARKET_DENIED", `market ${i.perp.market} is on the denylist`);
  }
  const allow = ctx.policy.marketAllowlist;
  if (allow && !allow.some((m) => m.toUpperCase() === market)) {
    return v(
      "MARKET_DENIED",
      `market ${i.perp.market} is not on the allowlist`,
    );
  }
  return null;
};

const marketTradeable: Rule = (i) => {
  const status = i.perp.marketStatus;
  if (status === "active") return null;
  // A reduce-only market still permits getting smaller.
  if (status === "reduce-only" && isReducingKind(i.kind)) return null;
  return v(
    "MARKET_NOT_TRADEABLE",
    `market ${i.perp.market} status is '${status}'`,
    { status },
  );
};

// ── collateral admissibility (the input leg) ─────────────────────────────────

const collateralAllowed: Rule = (i, ctx) => {
  const mint = i.perp.collateral.mint;
  if (ctx.policy.allowedCollateralMints.length === 0) {
    return v(
      "COLLATERAL_MINT_DENIED",
      "no collateral mint is permitted for perps",
    );
  }
  if (!ctx.policy.allowedCollateralMints.includes(mint)) {
    return v(
      "COLLATERAL_MINT_DENIED",
      `collateral mint ${mint} is not permitted as perp margin`,
      { mint },
    );
  }
  return null;
};

/**
 * If the collateral is not a recognised quote asset it has no cap bucket, which
 * means the position could not be bounded in the input leg — the one denomination
 * the safety path trusts. Refuse rather than fall back to a USD oracle.
 */
const collateralCappable: Rule = (i) => {
  if (bucketOf(i) !== null) return null;
  return v(
    "COLLATERAL_NOT_CAPPABLE",
    `collateral ${i.perp.collateral.mint} has no spend-cap bucket — cannot be bounded without a price oracle`,
    {
      mint: i.perp.collateral.mint,
    },
  );
};

function bucketOf(i: PerpIntent): QuoteBucket | null {
  return quoteBucketFor(i.perp.collateral.mint);
}

// ── order shape ──────────────────────────────────────────────────────────────

const slippageWithinClamp: Rule = (i, ctx) => {
  if (i.perp.slippageBps <= ctx.policy.maxSlippageBps) return null;
  return v(
    "SLIPPAGE_EXCEEDED",
    `slippage ${i.perp.slippageBps}bps exceeds max ${ctx.policy.maxSlippageBps}bps`,
    {
      requested: i.perp.slippageBps,
      max: ctx.policy.maxSlippageBps,
    },
  );
};

/**
 * Reduce/close must actually reduce: a matching position must exist, the order
 * must face the OPPOSITE way, and it must not be larger than the position it
 * targets (otherwise "close" silently flips you into the other side).
 */
const reduceIsAReduction: Rule = (i, ctx) => {
  if (!isReducingKind(i.kind)) return null;
  const pos = ctx.position;
  if (!pos)
    return v(
      "NO_POSITION",
      `no open ${i.perp.market} position to ${i.kind === "perp_close" ? "close" : "reduce"}`,
    );
  if (pos.symbol.toUpperCase() !== i.perp.market.toUpperCase()) {
    return v(
      "POSITION_SIDE_MISMATCH",
      "position context is for a different market",
    );
  }
  if (pos.side === i.perp.side) {
    return v(
      "POSITION_SIDE_MISMATCH",
      `a ${i.perp.side} order does not reduce a ${pos.side} position — it increases it`,
      {
        positionSide: pos.side,
        orderSide: i.perp.side,
      },
    );
  }
  if (i.perp.expectedBaseAmount > pos.baseAmount) {
    return v(
      "SIZE_EXCEEDS_POSITION",
      "order size exceeds the position it targets — this would flip the side, not reduce it",
      {
        orderBase: i.perp.expectedBaseAmount.toString(),
        positionBase: pos.baseAmount.toString(),
      },
    );
  }
  return null;
};

/** An increase must face the SAME way as any existing position, or it is a flip in disguise. */
const increaseMatchesPosition: Rule = (i, ctx) => {
  if (i.kind !== "perp_increase") return null;
  const pos = ctx.position;
  if (!pos)
    return v("NO_POSITION", `no open ${i.perp.market} position to increase`);
  if (pos.side !== i.perp.side) {
    return v(
      "POSITION_SIDE_MISMATCH",
      `cannot increase a ${pos.side} position with a ${i.perp.side} order`,
      {
        positionSide: pos.side,
        orderSide: i.perp.side,
      },
    );
  }
  return null;
};

// ── leverage + input-leg caps ────────────────────────────────────────────────

const leverageWithinCap: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const lev = i.perp.leverage;
  if (lev > ctx.policy.maxLeverage) {
    return v(
      "LEVERAGE_EXCEEDED",
      `leverage ${lev}× exceeds the ${ctx.policy.maxLeverage}× cap`,
      { leverage: lev, max: ctx.policy.maxLeverage },
    );
  }
  return null;
};

const collateralWithinCap: Rule = (i, ctx) => {
  const bucket = bucketOf(i);
  if (bucket === null) return null; // collateralCappable already refused this
  if (i.perp.collateral.amount === 0n) return null;
  const cap = capsFor(ctx.policy, bucket).maxCollateralPerPosition;
  if (i.perp.collateral.amount > cap) {
    return v(
      "COLLATERAL_CAP_EXCEEDED",
      `collateral ${fmt(i.perp.collateral.amount, i.perp.collateral.decimals)} exceeds the per-position cap of ${fmt(cap, i.perp.collateral.decimals)}`,
      {
        bucket,
        amount: i.perp.collateral.amount.toString(),
        cap: cap.toString(),
      },
    );
  }
  return null;
};

/**
 * Notional cap, denominated in the input leg.
 *
 * The cap compares against `max(venue-claimed notional, collateral × leverage)`.
 * Recomputing from the collateral is what removes the venue from the safety
 * path: an adapter that under-reports notional — through a bug or a compromise —
 * cannot buy a bigger position than the margin allows, because the derived
 * number is integer maths on the amount that is actually leaving the wallet.
 */
const notionalWithinCap: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const bucket = bucketOf(i);
  if (bucket === null) return null;

  const derived = notionalFromCollateral(
    i.perp.collateral.amount,
    i.perp.leverage,
  );
  if (derived === undefined) {
    return v(
      "NOTIONAL_CAP_EXCEEDED",
      "notional could not be derived from the collateral and leverage",
      {
        collateral: i.perp.collateral.amount.toString(),
        leverage: i.perp.leverage,
      },
    );
  }
  const claimed = i.perp.notional.amount;
  const effective = claimed > derived ? claimed : derived;
  const cap = capsFor(ctx.policy, bucket).maxNotionalPerPosition;
  if (effective > cap) {
    return v(
      "NOTIONAL_CAP_EXCEEDED",
      `notional ${fmt(effective, i.perp.notional.decimals)} exceeds the per-position cap of ${fmt(cap, i.perp.notional.decimals)}`,
      {
        bucket,
        claimed: claimed.toString(),
        derived: derived.toString(),
        cap: cap.toString(),
      },
    );
  }
  return null;
};

const portfolioWithinCap: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const bucket = bucketOf(i);
  if (bucket === null) return null;

  if (ctx.exposure.stale) {
    return v(
      "EXPOSURE_UNKNOWN",
      `portfolio perp exposure is unknown (${ctx.exposure.staleReason ?? "stale snapshot"}) — refusing to add to an unbounded total`,
    );
  }

  const derived =
    notionalFromCollateral(i.perp.collateral.amount, i.perp.leverage) ??
    i.perp.notional.amount;
  const add =
    i.perp.notional.amount > derived ? i.perp.notional.amount : derived;
  const current = ctx.exposure.notionalByBucket[bucket];
  const cap = capsFor(ctx.policy, bucket).maxPortfolioNotional;
  if (current + add > cap) {
    return v(
      "PORTFOLIO_EXPOSURE_EXCEEDED",
      `total perp notional ${fmt(current + add, i.perp.notional.decimals)} would exceed the ${fmt(cap, i.perp.notional.decimals)} portfolio cap`,
      {
        bucket,
        current: current.toString(),
        adding: add.toString(),
        cap: cap.toString(),
      },
    );
  }
  return null;
};

const positionCountWithinCap: Rule = (i, ctx) => {
  if (i.kind !== "perp_open") return null; // an increase reuses an existing slot
  if (ctx.exposure.stale) {
    return v(
      "EXPOSURE_UNKNOWN",
      "portfolio snapshot is stale — cannot count open positions",
    );
  }
  if (ctx.position) return null; // already holding this market: not a new slot
  if (ctx.exposure.openPositions >= ctx.policy.maxOpenPositions) {
    return v(
      "POSITION_COUNT_EXCEEDED",
      `already holding ${ctx.exposure.openPositions} perp positions (max ${ctx.policy.maxOpenPositions})`,
      {
        open: ctx.exposure.openPositions,
        max: ctx.policy.maxOpenPositions,
      },
    );
  }
  return null;
};

// ── risk-of-ruin ─────────────────────────────────────────────────────────────

/**
 * Minimum liquidation distance.
 *
 * The venue's estimate is cross-checked against an independent isolated model
 * and the CONSERVATIVE one wins (see `reconcileLiquidation`), so neither a rosy
 * venue number nor a units bug in the adapter can buy extra leverage. If neither
 * source produced a usable number the intent is refused outright — this is the
 * guard that most needs to fail closed, because "I don't know where you get
 * liquidated" is the worst possible state to open leverage in.
 */
const liquidationDistanceOk: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const p = i.perp;

  const model = modelLiquidationPrice({
    side: p.side,
    entryPrice: p.entryPrice,
    leverage: p.leverage,
    maintenanceMarginRatio: p.maintenanceMarginRatio,
  });
  const reconciled = reconcileLiquidation({
    side: p.side,
    referencePrice: p.entryPrice,
    venuePrice: p.venueLiquidationPrice,
    modelPrice: model,
    toleranceBps: ctx.policy.liquidationToleranceBps,
  });

  if (
    reconciled.ambiguity !== undefined ||
    reconciled.distanceBps === undefined
  ) {
    return v(
      "LIQUIDATION_UNKNOWN",
      `liquidation price is unusable: ${reconciled.ambiguity ?? "no distance could be computed"}`,
      {
        venue: p.venueLiquidationPrice,
        model,
      },
    );
  }
  if (reconciled.distanceBps < ctx.policy.minLiquidationDistanceBps) {
    return v(
      "LIQUIDATION_TOO_CLOSE",
      `entry sits ${reconciled.distanceBps}bps from liquidation, inside the ${ctx.policy.minLiquidationDistanceBps}bps floor`,
      {
        distanceBps: reconciled.distanceBps,
        min: ctx.policy.minLiquidationDistanceBps,
        liquidationPrice: reconciled.liquidationPrice,
        source: reconciled.source,
      },
    );
  }
  return null;
};

const oracleAgreesWithMark: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const div = oracleDivergenceBps(i.perp.markPrice, i.perp.oraclePrice);
  if (div === undefined) {
    return v("ORACLE_DIVERGENCE", "mark or oracle price is unusable");
  }
  if (div > ctx.policy.maxOracleDivergenceBps) {
    return v(
      "ORACLE_DIVERGENCE",
      `mark and oracle diverge by ${div}bps (max ${ctx.policy.maxOracleDivergenceBps}bps)`,
      {
        divergenceBps: div,
        max: ctx.policy.maxOracleDivergenceBps,
      },
    );
  }
  return null;
};

/**
 * Funding sanity, in two parts:
 *   1. MAGNITUDE — a reading beyond the sanity bound in either direction is
 *      treated as bad data or a market in crisis, and refused.
 *   2. DIRECTION — the side actually paying is checked against the adverse
 *      budget. Receiving funding is never a reason to refuse.
 * A missing reading is refused outright; assuming zero funding is the exact
 * mistake this guard exists to prevent.
 */
const fundingSane: Rule = (i, ctx) => {
  if (!isOpeningKind(i.kind)) return null;
  const f = i.perp.fundingBpsPerHour;
  if (f === undefined || !Number.isFinite(f)) {
    return v(
      "FUNDING_RATE_UNKNOWN",
      "no funding-rate reading for this market — refusing to open blind",
    );
  }
  if (Math.abs(f) > ctx.policy.maxFundingRateBpsPerHour) {
    return v(
      "FUNDING_RATE_UNSANE",
      `funding ${f.toFixed(3)}bps/h is beyond the ${ctx.policy.maxFundingRateBpsPerHour}bps/h sanity bound`,
      {
        fundingBpsPerHour: f,
        max: ctx.policy.maxFundingRateBpsPerHour,
      },
    );
  }
  // Positive funding = longs pay shorts.
  const adverse = i.perp.side === "long" ? f : -f;
  if (adverse > ctx.policy.maxAdverseFundingBpsPerHour) {
    return v(
      "FUNDING_RATE_ADVERSE",
      `a ${i.perp.side} here pays ${adverse.toFixed(3)}bps/h funding, above the ${ctx.policy.maxAdverseFundingBpsPerHour}bps/h budget`,
      {
        adverseBpsPerHour: adverse,
        max: ctx.policy.maxAdverseFundingBpsPerHour,
      },
    );
  }
  return null;
};

function fmt(amount: bigint, decimals: number): string {
  return formatAmount(amount, decimals);
}

/**
 * The rule list. Order is the reporting order and the throw order: arm state
 * first (cheapest and most important), then admissibility, then caps, then
 * risk-of-ruin.
 */
export const PERP_RULES: readonly Rule[] = [
  armState,
  accountReady,
  marketAllowed,
  marketTradeable,
  collateralAllowed,
  collateralCappable,
  slippageWithinClamp,
  reduceIsAReduction,
  increaseMatchesPosition,
  leverageWithinCap,
  collateralWithinCap,
  notionalWithinCap,
  portfolioWithinCap,
  positionCountWithinCap,
  liquidationDistanceOk,
  oracleAgreesWithMark,
  fundingSane,
];

/**
 * ENFORCEMENT path: throws `PerpGuardError` on the first violation.
 * `PerpGuardError extends GuardError`, so the kernel's existing error handling,
 * journal, and Telegram rendering all work on it unchanged.
 */
export function perpGuards(intent: PerpIntent, ctx: PerpGuardContext): void {
  assertPerpIntentShape(intent);
  for (const rule of PERP_RULES) {
    const violation = rule(intent, ctx);
    if (violation)
      throw new PerpGuardError(
        violation.code,
        violation.message,
        violation.details,
      );
  }
}

export interface PerpGuardVerdict {
  readonly ok: boolean;
  readonly violations: readonly PerpViolation[];
}

/**
 * ADVISORY path: runs every rule and collects all violations, for quote cards
 * and tool previews. Shares the exact same rule list as `perpGuards`, so an
 * advisory pass can never disagree with enforcement.
 */
export function evaluatePerpGuards(
  intent: PerpIntent,
  ctx: PerpGuardContext,
): PerpGuardVerdict {
  try {
    assertPerpIntentShape(intent);
  } catch (err) {
    if (isPerpGuardError(err)) {
      return {
        ok: false,
        violations: [v(err.perpCode, err.message, undefined)],
      };
    }
    return {
      ok: false,
      violations: [
        v(
          "INVALID_PERP_INTENT",
          err instanceof Error ? err.message : String(err),
          undefined,
        ),
      ],
    };
  }

  const violations: PerpViolation[] = [];
  for (const rule of PERP_RULES) {
    const violation = rule(intent, ctx);
    if (violation) violations.push(violation);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Live-position risk read, for monitoring rather than admission: how close an
 * ALREADY OPEN position sits to liquidation right now. Returns `undefined` when
 * the venue gave no usable liquidation price — again, never a guess.
 */
export function positionLiquidationDistanceBps(
  position: PerpPosition,
): number | undefined {
  if (position.liquidationPrice === undefined) return undefined;
  return liquidationDistanceBps({
    side: position.side,
    referencePrice: position.markPrice,
    liquidationPrice: position.liquidationPrice,
  });
}
