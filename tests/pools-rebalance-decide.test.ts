/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { SOL_DECIMALS, WSOL_MINT, toBaseUnits } from "../src/kernel/money.js";
import type { LpPosition, PoolSummary } from "../src/pools/types.js";
import { uiPriceOfBin } from "../src/pools/meteora/bins.js";
import {
  computeEconomics,
  decideRebalance,
  defaultRebalancePolicy,
  type RebalanceEconomics,
  type RebalancePolicy,
  type RebalanceSubject,
} from "../src/pools/rebalance/decide.js";
import {
  EMPTY_HISTORY,
  RebalanceLedger,
} from "../src/pools/rebalance/ledger.js";

const TOKEN = "BonkMint11111111111111111111111111111111111";
const POOL = "PooL11111111111111111111111111111111111111";
const POSITION = "Pos111111111111111111111111111111111111111";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function pool(
  activeLevel: number,
  over: Partial<PoolSummary> = {},
): PoolSummary {
  return {
    venue: "meteora-dlmm",
    address: POOL,
    name: "BONK-SOL",
    baseMint: TOKEN,
    baseDecimals: 6,
    quoteMint: WSOL_MINT,
    quoteDecimals: SOL_DECIMALS,
    levelStepBps: 25,
    activeLevel,
    activePrice: uiPriceOfBin(activeLevel, 25, 6, SOL_DECIMALS),
    baseFeeBps: 25,
    liquidityQuote: toBaseUnits(500, SOL_DECIMALS),
    volume24hUsd: 100_000,
    fees24hUsd: 250,
    feeApr24hPct: 40,
    hasToken2022: false,
    ...over,
  };
}

function position(over: Partial<LpPosition> = {}): LpPosition {
  return {
    venue: "meteora-dlmm",
    poolAddress: POOL,
    positionAddress: POSITION,
    owner: "Ownr11111111111111111111111111111111111111",
    baseMint: TOKEN,
    baseDecimals: 6,
    quoteMint: WSOL_MINT,
    quoteDecimals: SOL_DECIMALS,
    levelStepBps: 25,
    lowerLevel: 990,
    upperLevel: 1010,
    activeLevel: 1000,
    baseAmount: 0n,
    quoteAmount: toBaseUnits(1, SOL_DECIMALS),
    unclaimedFeeBase: 0n,
    unclaimedFeeQuote: toBaseUnits(0.01, SOL_DECIMALS),
    shape: "spot",
    openedAt: NOW - 5 * HOUR,
    ...over,
  };
}

/** Generous economics: fees comfortably clear the cost, so other gates are isolated. */
function goodEconomics(
  over: Partial<RebalanceEconomics> = {},
): RebalanceEconomics {
  return {
    projectedFeesPerDayQuote: toBaseUnits(0.1, SOL_DECIMALS),
    txCostQuote: toBaseUnits(0.0005, SOL_DECIMALS),
    inventorySwapCostQuote: toBaseUnits(0.001, SOL_DECIMALS),
    positionNotionalQuote: toBaseUnits(1, SOL_DECIMALS),
    entryUiPrice: uiPriceOfBin(1000, 25, 6, SOL_DECIMALS),
    claimableFeesQuote: toBaseUnits(0.01, SOL_DECIMALS),
    ...over,
  };
}

function subject(over: Partial<RebalanceSubject> = {}): RebalanceSubject {
  return {
    position: position(),
    pool: pool(1040), // 30 bins above the upper edge → firmly drifted
    policy: defaultRebalancePolicy(),
    economics: goodEconomics(),
    history: EMPTY_HISTORY,
    now: NOW,
    ...over,
  };
}

// ── drift ────────────────────────────────────────────────────────────────────

test("a position sitting mid-range is left alone", () => {
  const d = decideRebalance(subject({ pool: pool(1000) }));
  assert.equal(d.action, "hold");
  assert.equal(d.code, "REBALANCE_NOT_DRIFTED");
  assert.equal(d.drift, 0);
  assert.equal(d.rangeFraction, 0.5);
});

test("drift inside the no-churn band does not trigger", () => {
  // driftBins = 2, edge trigger disabled so only the exit rule applies.
  const policy: RebalancePolicy = {
    ...defaultRebalancePolicy(),
    edgeTriggerPct: 0,
  };
  assert.equal(
    decideRebalance(subject({ pool: pool(1012), policy })).code,
    "REBALANCE_NOT_DRIFTED",
  );
  assert.equal(
    decideRebalance(subject({ pool: pool(1013), policy })).action,
    "rebalance",
  );
  assert.equal(
    decideRebalance(subject({ pool: pool(988), policy })).code,
    "REBALANCE_NOT_DRIFTED",
  );
  assert.equal(
    decideRebalance(subject({ pool: pool(987), policy })).action,
    "rebalance",
  );
});

test("the edge trigger fires while still technically in range", () => {
  const policy: RebalancePolicy = {
    ...defaultRebalancePolicy(),
    edgeTriggerPct: 0.1,
  };
  // 21-bin range 990..1010; 10% of the span is the outer two bins on each side.
  const nearTop = decideRebalance(subject({ pool: pool(1009), policy }));
  assert.equal(nearTop.action, "rebalance", nearTop.reason);
  assert.equal(nearTop.drift, 0, "still inside the range");
  assert.equal(
    decideRebalance(subject({ pool: pool(1000), policy })).action,
    "hold",
  );
});

test("drift is reported with a sign so callers can tell which asset they ended up holding", () => {
  assert.equal(decideRebalance(subject({ pool: pool(1040) })).drift, 30);
  assert.equal(decideRebalance(subject({ pool: pool(960) })).drift, -30);
});

// ── rate limits ──────────────────────────────────────────────────────────────

test("minimum interval blocks a drifted position that moved recently", () => {
  const d = decideRebalance(
    subject({ history: { lastAt: NOW - 30 * 60_000, countInWindow: 1 } }),
  );
  assert.equal(d.action, "hold");
  assert.equal(d.code, "REBALANCE_TOO_SOON");

  const ok = decideRebalance(
    subject({ history: { lastAt: NOW - 2 * HOUR, countInWindow: 1 } }),
  );
  assert.equal(ok.action, "rebalance");
});

test("the rolling daily cap blocks the fifth move in 24h", () => {
  const d = decideRebalance(
    subject({ history: { lastAt: NOW - 5 * HOUR, countInWindow: 4 } }),
  );
  assert.equal(d.code, "REBALANCE_DAILY_CAP");
  const ok = decideRebalance(
    subject({ history: { lastAt: NOW - 5 * HOUR, countInWindow: 3 } }),
  );
  assert.equal(ok.action, "rebalance");
});

test("drift is checked before the rate limits so a calm position reports the useful reason", () => {
  const d = decideRebalance(
    subject({ pool: pool(1000), history: { lastAt: NOW, countInWindow: 99 } }),
  );
  assert.equal(d.code, "REBALANCE_NOT_DRIFTED");
});

// ── economics ────────────────────────────────────────────────────────────────

test("a rebalance that costs more than it earns is rejected", () => {
  const d = decideRebalance(
    subject({
      economics: goodEconomics({
        projectedFeesPerDayQuote: toBaseUnits(0.0001, SOL_DECIMALS),
        inventorySwapCostQuote: toBaseUnits(0.05, SOL_DECIMALS),
      }),
    }),
  );
  assert.equal(d.action, "hold");
  assert.equal(d.code, "REBALANCE_UNECONOMIC");
  assert.ok(d.economics);
  assert.ok((d.economics?.netBenefitQuote ?? 0n) < 0n);
});

test("missing economic inputs are a rejection, never an assumption", () => {
  for (const missing of [
    "projectedFeesPerDayQuote",
    "txCostQuote",
    "inventorySwapCostQuote",
  ] as const) {
    const d = decideRebalance(
      subject({ economics: goodEconomics({ [missing]: null }) }),
    );
    assert.equal(d.code, "REBALANCE_UNECONOMIC", missing);
    assert.equal(
      d.economics,
      null,
      `${missing} should short-circuit the breakdown`,
    );
  }
});

test("strict IL mode needs an entry price; lenient mode does not", () => {
  const strict = decideRebalance(
    subject({ economics: goodEconomics({ entryUiPrice: null }) }),
  );
  assert.equal(strict.code, "REBALANCE_UNECONOMIC");

  const policy: RebalancePolicy = {
    ...defaultRebalancePolicy(),
    requireIlRecovery: false,
  };
  const lenient = decideRebalance(
    subject({ policy, economics: goodEconomics({ entryUiPrice: null }) }),
  );
  assert.equal(lenient.action, "rebalance");
  assert.equal(lenient.economics?.divergenceCostQuote, 0n);
  assert.equal(lenient.economics?.divergenceLossPct, null);
});

test("a large price move crystallises enough divergence loss to veto the move", () => {
  // Entry near bin 1000, price now far above → real divergence against holding.
  const farPool = pool(6000);
  const d = decideRebalance(
    subject({
      pool: farPool,
      economics: goodEconomics({
        projectedFeesPerDayQuote: toBaseUnits(0.02, SOL_DECIMALS),
        entryUiPrice: uiPriceOfBin(1000, 25, 6, SOL_DECIMALS),
      }),
    }),
  );
  assert.equal(d.code, "REBALANCE_UNECONOMIC");
  assert.ok((d.economics?.divergenceCostQuote ?? 0n) > 0n);
  assert.ok((d.economics?.divergenceLossPct ?? 0) < 0);
});

test("claimable fees are reported but never counted as a reason to rebalance", () => {
  const withFees = goodEconomics({
    projectedFeesPerDayQuote: 0n,
    claimableFeesQuote: toBaseUnits(10, SOL_DECIMALS),
  });
  const d = decideRebalance(subject({ economics: withFees }));
  assert.equal(
    d.code,
    "REBALANCE_UNECONOMIC",
    "a fat claimable balance must not justify the move",
  );
  assert.equal(d.economics?.claimableFeesQuote, toBaseUnits(10, SOL_DECIMALS));
  assert.equal(d.economics?.projectedFeesQuote, 0n);
});

test('minNetBenefitQuote is an absolute floor on top of "better than zero"', () => {
  const policy: RebalancePolicy = {
    ...defaultRebalancePolicy(),
    minNetBenefitQuote: toBaseUnits(10, SOL_DECIMALS),
  };
  const d = decideRebalance(subject({ policy }));
  assert.equal(d.code, "REBALANCE_UNECONOMIC");
});

test("narrowing the range scales the fee projection up, widening scales it down", () => {
  const s = subject();
  const narrow = computeEconomics(s, { lowerBinId: 1035, upperBinId: 1045 }); // 11 bins vs 21
  const wide = computeEconomics(s, { lowerBinId: 1000, upperBinId: 1060 }); // 61 bins
  assert.ok(narrow && wide);
  assert.ok(
    (narrow?.projectedFeesQuote ?? 0n) > (wide?.projectedFeesQuote ?? 0n),
  );
});

// ── target + shape ───────────────────────────────────────────────────────────

test("an approved rebalance centres the target on the new active bin", () => {
  const d = decideRebalance(subject({ pool: pool(1040) }));
  assert.equal(d.action, "rebalance");
  assert.deepEqual(d.targetRange, { lowerBinId: 1030, upperBinId: 1050 });
  assert.deepEqual(d.currentRange, { lowerBinId: 990, upperBinId: 1010 });
});

test("a target identical to the current range is a no-op hold", () => {
  const policy: RebalancePolicy = {
    ...defaultRebalancePolicy(),
    edgeTriggerPct: 0.5,
  };
  const d = decideRebalance(subject({ pool: pool(1000), policy }));
  assert.equal(d.action, "hold");
  assert.equal(d.code, "REBALANCE_NOT_DRIFTED");
});

// ── refusing to act on nonsense ──────────────────────────────────────────────

test("a malformed position or a mismatched pool is never touched", () => {
  const bad = decideRebalance(
    subject({ position: position({ lowerLevel: 1010, upperLevel: 990 }) }),
  );
  assert.equal(bad.action, "hold");
  assert.equal(bad.code, "POOL_RANGE_INVALID");

  const mismatch = decideRebalance(
    subject({
      position: position({
        poolAddress: "OtherPool1111111111111111111111111111111",
      }),
    }),
  );
  assert.equal(mismatch.code, "POOL_VENUE_ERROR");
});

// ── ledger ───────────────────────────────────────────────────────────────────

test("the ledger counts a rolling 24h window, not a calendar day", () => {
  const ledger = new RebalanceLedger();
  assert.deepEqual(ledger.history(POSITION, NOW), EMPTY_HISTORY);

  ledger.record(POSITION, NOW - 23 * HOUR);
  ledger.record(POSITION, NOW - 2 * HOUR);
  const h = ledger.history(POSITION, NOW);
  assert.equal(h.countInWindow, 2);
  assert.equal(h.lastAt, NOW - 2 * HOUR);

  // One hour later the oldest entry falls out of the window.
  const later = ledger.history(POSITION, NOW + 2 * HOUR);
  assert.equal(later.countInWindow, 1);
});

test("the ledger keeps positions independent", () => {
  const ledger = new RebalanceLedger();
  ledger.record("A", NOW);
  ledger.record("A", NOW);
  ledger.record("B", NOW);
  assert.equal(ledger.history("A", NOW).countInWindow, 2);
  assert.equal(ledger.history("B", NOW).countInWindow, 1);
  assert.equal(ledger.history("C", NOW).countInWindow, 0);
  assert.deepEqual([...ledger.tracked()].sort(), ["A", "B"]);
});

test("ledger + decision compose: four moves then the cap holds the fifth", () => {
  const ledger = new RebalanceLedger();
  let t = NOW;
  for (let i = 0; i < 4; i++) {
    const d = decideRebalance(
      subject({ now: t, history: ledger.history(POSITION, t) }),
    );
    assert.equal(d.action, "rebalance", `move ${i + 1}`);
    ledger.record(POSITION, t);
    t += 2 * HOUR;
  }
  const fifth = decideRebalance(
    subject({ now: t, history: ledger.history(POSITION, t) }),
  );
  assert.equal(fifth.code, "REBALANCE_DAILY_CAP");

  // Past the window, the allowance is back.
  const nextDay = t + 24 * HOUR;
  const after = decideRebalance(
    subject({ now: nextDay, history: ledger.history(POSITION, nextDay) }),
  );
  assert.equal(after.action, "rebalance");
});
