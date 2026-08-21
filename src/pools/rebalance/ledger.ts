/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rebalance history — the state the churn limiters read.
 *
 * Kept deliberately tiny and *injected* rather than global: the decision function
 * takes a plain `RebalanceHistory` value, so it stays pure and the persistence
 * choice (in-memory here, SQLite in the engine) is somebody else's problem.
 *
 * The daily cap is a **rolling 24h window**, not a calendar day. A calendar reset
 * lets an agent burn its whole allowance at 23:59 and the next one at 00:01 —
 * exactly the churn the cap exists to prevent.
 */

export interface RebalanceHistory {
  /** Epoch ms of the most recent rebalance for this position, or null if never. */
  readonly lastAt: number | null;
  /** Rebalances for this position inside the trailing 24h. */
  readonly countInWindow: number;
}

export const EMPTY_HISTORY: RebalanceHistory = {
  lastAt: null,
  countInWindow: 0,
};

const DAY_MS = 86_400_000;

/** In-memory rolling-window ledger. One instance per engine; keyed by position address. */
export class RebalanceLedger {
  #windowMs: number;
  #byPosition = new Map<string, number[]>();

  constructor(windowMs: number = DAY_MS) {
    this.#windowMs = Math.max(1, Math.floor(windowMs));
  }

  /** Record a rebalance that actually executed. Never record a rejected decision. */
  record(positionAddress: string, at: number): void {
    const list = this.#byPosition.get(positionAddress) ?? [];
    list.push(at);
    this.#prune(list, at);
    this.#byPosition.set(positionAddress, list);
  }

  history(positionAddress: string, now: number): RebalanceHistory {
    const list = this.#byPosition.get(positionAddress);
    if (!list || list.length === 0) return EMPTY_HISTORY;
    this.#prune(list, now);
    if (list.length === 0) return EMPTY_HISTORY;
    return { lastAt: Math.max(...list), countInWindow: list.length };
  }

  /** Positions with any activity still inside the window. */
  tracked(): readonly string[] {
    return [...this.#byPosition.keys()];
  }

  #prune(list: number[], now: number): void {
    const cutoff = now - this.#windowMs;
    while (list.length > 0 && (list[0] as number) < cutoff) list.shift();
  }
}
