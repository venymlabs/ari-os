/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: NEW in this
 * repo — Aetheria surfaced strategies as Telegram text, ARI OS has a console,
 * so this projects a `StrategyRow` onto the dashboard's `StrategyView`.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StrategyView } from "../control/view.js";
import { SOL_DECIMALS, toBaseUnits, WSOL_MINT } from "../kernel/money.js";
import type { StrategyRow } from "./store.js";

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
function short(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/**
 * Project one strategy row onto the console's view model.
 *
 * The rule from `src/control/snapshot.ts` applies here too: never invent a
 * number. `trigger` is null unless the strategy actually has a price target and
 * a live reading to compare it against, and `budget` is null unless a budget
 * was set — a zero-of-zero meter reads as "spent nothing of nothing", which is
 * not what "no budget configured" means.
 */
export function strategyView(row: StrategyRow): StrategyView {
  const p = row.params;
  const token = str(p.token);
  const label = labelFor(row, token);

  const params = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const);

  let progress: StrategyView["progress"] = null;
  let budget: StrategyView["budget"] = null;
  let trigger: StrategyView["trigger"] = null;

  if (row.kind === "twap") {
    const slices = Math.max(1, Math.floor(num(p.slices, 1)));
    progress = { done: Math.floor(num(p.doneSlices)), total: slices };
  } else if (row.kind === "dca") {
    const total = num(p.totalBudgetUi);
    const spent = num(p.spentUi);
    if (total > 0) {
      const per = num(p.amountUiPerStep);
      if (per > 0) {
        progress = {
          done: Math.floor(spent / per + 1e-9),
          total: Math.ceil(total / per - 1e-9),
        };
      }
      budget = {
        spent: toBaseUnits(spent, SOL_DECIMALS).toString(),
        cap: toBaseUnits(total, SOL_DECIMALS).toString(),
        symbol: "SOL",
        decimals: SOL_DECIMALS,
      };
    }
  } else if (row.kind === "trailing_stop") {
    const peak = num(p.peak);
    const dropPct = num(p.dropPct, 10);
    // A peak is only recorded once a price has actually been read, so its
    // absence is the honest signal that no reading exists yet.
    if (peak > 0) {
      const target = peak * (1 - dropPct / 100);
      trigger = {
        label: `stop at −${dropPct}% from ${peak.toPrecision(4)}`,
        current: peak,
        target,
        distancePct: peak > 0 ? ((peak - target) / peak) * 100 : 0,
      };
    }
  } else if (row.kind === "take_profit") {
    const entry = num(p.entryPrice);
    const gainPct = num(p.gainPct, 50);
    if (entry > 0) {
      const target = entry * (1 + gainPct / 100);
      trigger = {
        label: `take profit at +${gainPct}% from ${entry.toPrecision(4)}`,
        current: entry,
        target,
        distancePct: gainPct,
      };
    }
  }

  return {
    id: row.id,
    kind: row.kind,
    label,
    status: row.status,
    params,
    nextRunAt: row.status === "active" ? row.nextRunAt : null,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    runs: row.runs,
    errors: row.errors,
    lastError: row.lastError,
    progress,
    trigger,
    budget,
  };
}

function labelFor(row: StrategyRow, token: string): string {
  const t = token ? short(token) : "—";
  const p = row.params;
  switch (row.kind) {
    case "dca":
      return `DCA ${num(p.amountUiPerStep)} SOL → ${t}`;
    case "twap":
      return `TWAP ${str(p.side, "buy")} ${num(p.totalUi)} over ${Math.max(1, Math.floor(num(p.slices, 1)))} → ${t}`;
    case "trailing_stop":
      return `Trailing stop −${num(p.dropPct, 10)}% on ${t}`;
    case "take_profit":
      return `Take profit +${num(p.gainPct, 50)}% on ${t}`;
  }
}

/** The mint a strategy trades, when it names one. Used to warm the trade tape. */
export function strategyMint(row: StrategyRow): string | undefined {
  const token = str(row.params.token);
  return token && token !== WSOL_MINT ? token : undefined;
}
