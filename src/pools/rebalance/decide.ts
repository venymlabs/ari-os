/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PoolGuardCode } from "../errors.js";
import {
  activePositionInRange,
  type BinRange,
  binDrift,
  binSpan,
  divergenceLossPct,
  rangeAroundActive,
  uiPriceOfBin,
} from "../meteora/bins.js";
import type { LiquidityShape, LpPosition, PoolSummary } from "../types.js";
import { EMPTY_HISTORY, type RebalanceHistory } from "./ledger.js";

/**
 * The rebalance decision — pure, synchronous, and completely separate from
 * execution. It answers one question: *given this position and this target,
 * should we move the range right now?* Nothing in here builds a transaction,
 * touches the network, or reads a clock; `now` is an argument.
 *
 * Four independent brakes, all of which must release before the answer is yes:
 *
 *  1. **Drift** — the active bin must have left (or be closing on) the range by
 *     more than `driftBins`, so a price wobbling across one bin boundary cannot
 *     ping-pong the position.
 *  2. **Interval** — `minIntervalMs` since the last rebalance of this position.
 *  3. **Daily cap** — at most `maxPerDay` in a rolling 24h window.
 *  4. **Economics** — projected fees over the horizon must beat the round-trip
 *     cash cost (and, in strict mode, the divergence loss the move crystallises).
 *     A rebalance that costs more than it earns is *rejected*, not warned about.
 *
 * On the oracle question: the safety-critical caps in `guards.ts` are oracle-free
 * by construction. The economics here are not — valuing a position's base leg in
 * quote terms needs a price. That is acceptable precisely because this is an
 * optimisation, not a safety gate: a wrong price here can make us skip a
 * profitable rebalance or spend one transaction fee. It can never move more value
 * than the kernel's input-leg cap already permits.
 */

export interface RebalancePolicy {
  /** Bins the active bin must drift past a range edge before acting. */
  readonly driftBins: number;
  /**
   * Also fire while still *inside* the range once the active bin sits within this
   * fraction of an edge (0..0.5). 0 disables it — wait for a true exit. Acting
   * early keeps the position earning; acting too early is churn, hence the brakes.
   */
  readonly edgeTriggerPct: number;
  readonly minIntervalMs: number;
  readonly maxPerDay: number;
  /** How far ahead to project fee income when judging the trade-off. */
  readonly horizonMs: number;
  /** When true, projected fees must also cover the crystallised divergence loss. */
  readonly requireIlRecovery: boolean;
  /** Absolute net-benefit floor in quote base units, so we never churn for dust. */
  readonly minNetBenefitQuote: bigint;
  /** Target range shape, in bins either side of the new active bin. */
  readonly targetBelowBins: number;
  readonly targetAboveBins: number;
  readonly shape: LiquidityShape;
}

/** Conservative: act only on a real exit, once an hour at most, 4 a day, must pay for itself. */
export function defaultRebalancePolicy(): RebalancePolicy {
  return {
    driftBins: 2,
    edgeTriggerPct: 0.1,
    minIntervalMs: 3_600_000,
    maxPerDay: 4,
    horizonMs: 86_400_000,
    requireIlRecovery: true,
    minNetBenefitQuote: 0n,
    targetBelowBins: 10,
    targetAboveBins: 10,
    shape: "spot",
  };
}

/**
 * Economic inputs, all in the pool's **quote** base units. Every field is
 * nullable and a null is a *rejection*, never an assumption — the same
 * fail-closed rule the guards use.
 */
export interface RebalanceEconomics {
  /** Fee income this position's notional would earn per day back in range. */
  readonly projectedFeesPerDayQuote: bigint | null;
  /** Round-trip cash cost: base + priority fees plus the net rent delta. */
  readonly txCostQuote: bigint | null;
  /** Cost of converting inventory to fit the new range (the pool's own fee on the crossing notional). */
  readonly inventorySwapCostQuote: bigint | null;
  /** Position notional, both legs valued at the current price. Used only for the IL term. */
  readonly positionNotionalQuote: bigint | null;
  /** UI price at which the position was opened. Null ⇒ the IL term cannot be computed. */
  readonly entryUiPrice: number | null;
  /** Fees already claimable. Reported, never counted as a benefit — see below. */
  readonly claimableFeesQuote: bigint;
}

export interface EconomicsBreakdown {
  readonly projectedFeesQuote: bigint;
  readonly cashCostQuote: bigint;
  readonly divergenceCostQuote: bigint;
  readonly netBenefitQuote: bigint;
  readonly claimableFeesQuote: bigint;
  readonly divergenceLossPct: number | null;
}

export type RebalanceOutcome = "rebalance" | "hold";

export interface RebalanceDecision {
  readonly action: RebalanceOutcome;
  readonly code: PoolGuardCode | "REBALANCE_OK";
  readonly reason: string;
  /** The range to move to. Present only when `action === 'rebalance'`. */
  readonly targetRange: BinRange | null;
  readonly currentRange: BinRange;
  /** Signed bin drift of the active bin vs the current range (0 = inside). */
  readonly drift: number;
  /** 0..1 position of the active bin within the range, or null when outside. */
  readonly rangeFraction: number | null;
  readonly economics: EconomicsBreakdown | null;
}

export interface RebalanceSubject {
  readonly position: LpPosition;
  readonly pool: PoolSummary;
  readonly policy: RebalancePolicy;
  readonly economics: RebalanceEconomics;
  readonly history?: RebalanceHistory;
  readonly now: number;
}

function hold(
  code: PoolGuardCode | "REBALANCE_OK",
  reason: string,
  currentRange: BinRange,
  drift: number,
  rangeFraction: number | null,
  economics: EconomicsBreakdown | null = null,
): RebalanceDecision {
  return {
    action: "hold",
    code,
    reason,
    targetRange: null,
    currentRange,
    drift,
    rangeFraction,
    economics,
  };
}

/**
 * Should this position be rebalanced right now? Returns a decision, never throws
 * for ordinary bad inputs — a malformed position is a `hold`, because "we do not
 * understand this position" must mean "do not touch it".
 */
export function decideRebalance(s: RebalanceSubject): RebalanceDecision {
  const { position, pool, policy, now } = s;
  const history = s.history ?? EMPTY_HISTORY;
  const currentRange: BinRange = {
    lowerBinId: position.lowerLevel,
    upperBinId: position.upperLevel,
  };

  if (
    !Number.isInteger(currentRange.lowerBinId) ||
    !Number.isInteger(currentRange.upperBinId) ||
    currentRange.upperBinId < currentRange.lowerBinId
  ) {
    return hold(
      "POOL_RANGE_INVALID",
      "position range is malformed — refusing to act on it",
      currentRange,
      0,
      null,
    );
  }
  if (position.poolAddress !== pool.address) {
    return hold(
      "POOL_VENUE_ERROR",
      "position and pool do not match",
      currentRange,
      0,
      null,
    );
  }

  const activeBinId = pool.activeLevel;
  const drift = binDrift(currentRange, activeBinId);
  const rangeFraction = activePositionInRange(currentRange, activeBinId);

  // ── 1. drift ──────────────────────────────────────────────────────────────
  const exited = Math.abs(drift) > policy.driftBins;
  const nearEdge =
    rangeFraction !== null &&
    policy.edgeTriggerPct > 0 &&
    binSpan(currentRange.lowerBinId, currentRange.upperBinId) > 1 &&
    (rangeFraction <= policy.edgeTriggerPct ||
      rangeFraction >= 1 - policy.edgeTriggerPct);

  if (!exited && !nearEdge) {
    return hold(
      "REBALANCE_NOT_DRIFTED",
      drift === 0
        ? `active bin ${activeBinId} is comfortably inside ${currentRange.lowerBinId}..${currentRange.upperBinId}`
        : `active bin drifted ${drift} bins, within the ${policy.driftBins}-bin no-churn band`,
      currentRange,
      drift,
      rangeFraction,
    );
  }

  // ── 2. minimum interval ───────────────────────────────────────────────────
  if (history.lastAt !== null) {
    const since = now - history.lastAt;
    if (since < policy.minIntervalMs) {
      return hold(
        "REBALANCE_TOO_SOON",
        `last rebalance was ${Math.round(since / 1000)}s ago; minimum interval is ${Math.round(policy.minIntervalMs / 1000)}s`,
        currentRange,
        drift,
        rangeFraction,
      );
    }
  }

  // ── 3. rolling daily cap ──────────────────────────────────────────────────
  if (history.countInWindow >= policy.maxPerDay) {
    return hold(
      "REBALANCE_DAILY_CAP",
      `already rebalanced ${history.countInWindow} times in the last 24h (cap ${policy.maxPerDay})`,
      currentRange,
      drift,
      rangeFraction,
    );
  }

  // ── target range ──────────────────────────────────────────────────────────
  const targetRange = rangeAroundActive(
    activeBinId,
    policy.targetBelowBins,
    policy.targetAboveBins,
  );
  if (
    targetRange.lowerBinId === currentRange.lowerBinId &&
    targetRange.upperBinId === currentRange.upperBinId
  ) {
    return hold(
      "REBALANCE_NOT_DRIFTED",
      "target range equals the current range — nothing to do",
      currentRange,
      drift,
      rangeFraction,
    );
  }

  // ── 4. economics ──────────────────────────────────────────────────────────
  const econ = computeEconomics(s, targetRange);
  if (!econ) {
    return hold(
      "REBALANCE_UNECONOMIC",
      "economic inputs incomplete (fees, cost or notional unknown) — refusing to rebalance blind",
      currentRange,
      drift,
      rangeFraction,
    );
  }
  if (
    econ.netBenefitQuote <= 0n ||
    econ.netBenefitQuote < policy.minNetBenefitQuote
  ) {
    return hold(
      "REBALANCE_UNECONOMIC",
      `projected fees ${econ.projectedFeesQuote} do not cover cost ${econ.cashCostQuote}` +
        (policy.requireIlRecovery
          ? ` + divergence ${econ.divergenceCostQuote}`
          : "") +
        ` (net ${econ.netBenefitQuote})`,
      currentRange,
      drift,
      rangeFraction,
      econ,
    );
  }

  return {
    action: "rebalance",
    code: "REBALANCE_OK",
    reason:
      `active bin ${activeBinId} is ${drift === 0 ? "at the edge of" : `${Math.abs(drift)} bins outside`} ` +
      `${currentRange.lowerBinId}..${currentRange.upperBinId}; re-centre on ${targetRange.lowerBinId}..${targetRange.upperBinId} ` +
      `(net +${econ.netBenefitQuote} quote over ${Math.round(policy.horizonMs / 3_600_000)}h)`,
    targetRange,
    currentRange,
    drift,
    rangeFraction,
    economics: econ,
  };
}

/**
 * The trade-off, computed once and reported whole.
 *
 * Benefit is **only** the fees the position would earn back in range over the
 * horizon. `claimableFeesQuote` is deliberately excluded: those fees can be
 * collected by a bare `claim` without moving the range, so counting them as a
 * reason to rebalance would let any position with accrued fees justify an
 * arbitrarily expensive move. Reported, never credited.
 *
 * Cost is the round-trip cash out of the wallet, plus — in strict mode — the
 * divergence loss the move crystallises versus the entry price.
 *
 * Returns null when any required input is missing, which the caller must treat as
 * a rejection.
 */
export function computeEconomics(
  s: RebalanceSubject,
  targetRange: BinRange,
): EconomicsBreakdown | null {
  const { pool, policy, economics: e } = s;
  if (
    e.projectedFeesPerDayQuote === null ||
    e.txCostQuote === null ||
    e.inventorySwapCostQuote === null
  )
    return null;
  if (
    e.projectedFeesPerDayQuote < 0n ||
    e.txCostQuote < 0n ||
    e.inventorySwapCostQuote < 0n
  )
    return null;
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) return null;

  // Fee projection is scaled by how much of the *new* range actually earns: a
  // wider range spreads the same liquidity thinner, so fewer of its bins sit at
  // the active price. Narrower ⇒ more fee capture per unit, and more drift risk —
  // which is precisely the trade the brakes above are metering.
  const targetSpan = binSpan(targetRange.lowerBinId, targetRange.upperBinId);
  const currentSpan = binSpan(s.position.lowerLevel, s.position.upperLevel);
  const concentration =
    currentSpan > 0 && targetSpan > 0 ? currentSpan / targetSpan : 1;

  const horizonDays = policy.horizonMs / 86_400_000;
  const projectedFeesQuote =
    (e.projectedFeesPerDayQuote *
      BigInt(
        Math.max(0, Math.round(horizonDays * concentration * 1_000_000)),
      )) /
    1_000_000n;

  const cashCostQuote = e.txCostQuote + e.inventorySwapCostQuote;

  let divergenceCostQuote = 0n;
  let ilPct: number | null = null;
  if (policy.requireIlRecovery) {
    if (e.positionNotionalQuote === null || e.entryUiPrice === null)
      return null;
    if (
      e.positionNotionalQuote < 0n ||
      !Number.isFinite(e.entryUiPrice) ||
      e.entryUiPrice <= 0
    )
      return null;
    const nowPrice = uiPriceOfBin(
      pool.activeLevel,
      pool.levelStepBps,
      pool.baseDecimals,
      pool.quoteDecimals,
    );
    ilPct = divergenceLossPct(nowPrice / e.entryUiPrice); // negative or zero
    const lossBps = BigInt(Math.round(Math.abs(ilPct) * 100));
    divergenceCostQuote = (e.positionNotionalQuote * lossBps) / 10_000n;
  }

  const netBenefitQuote =
    projectedFeesQuote - cashCostQuote - divergenceCostQuote;
  return {
    projectedFeesQuote,
    cashCostQuote,
    divergenceCostQuote,
    netBenefitQuote,
    claimableFeesQuote: e.claimableFeesQuote,
    divergenceLossPct: ilPct,
  };
}
