/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the SQLite
 * driver is `node:sqlite`'s `DatabaseSync` (the house primitive) instead of
 * better-sqlite3, `PRAGMA journal_mode` moves into `exec`, and `.changes` is
 * coerced through `Number()` because `node:sqlite` returns it as a bigint.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type StrategyKind = "dca" | "twap" | "trailing_stop" | "take_profit";
export type StrategyStatus = "active" | "paused" | "done" | "errored";

export const STRATEGY_KINDS: readonly StrategyKind[] = [
  "dca",
  "twap",
  "trailing_stop",
  "take_profit",
];

export function isStrategyKind(value: string): value is StrategyKind {
  return (STRATEGY_KINDS as readonly string[]).includes(value);
}

export interface StrategyRow {
  readonly id: string;
  readonly userId: number;
  readonly kind: StrategyKind;
  status: StrategyStatus;
  params: Record<string, unknown>;
  nextRunAt: number;
  createdAt: number;
  lastRunAt: number | null;
  runs: number;
  errors: number;
  lastError: string | null;
}

interface DbRow {
  id: string;
  user_id: number;
  kind: StrategyKind;
  status: StrategyStatus;
  params: string;
  next_run_at: number;
  created_at: number;
  last_run_at: number | null;
  runs: number;
  errors: number;
  last_error: string | null;
}

function hydrate(r: DbRow): StrategyRow {
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    // A row whose params cannot be parsed is still a strategy the operator must
    // see; it plans to `done` rather than crashing the tick loop.
  }
  return {
    id: r.id,
    userId: Number(r.user_id),
    kind: r.kind,
    status: r.status,
    params,
    nextRunAt: Number(r.next_run_at),
    createdAt: Number(r.created_at),
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    runs: Number(r.runs),
    errors: Number(r.errors),
    lastError: r.last_error,
  };
}

/**
 * SQLite-backed strategy store — strategies survive restarts, and the runner is
 * the single writer.
 *
 * Nothing in here is a safety control. A strategy row is a *schedule*: it says
 * when to propose a trade and how big a slice to propose. What actually leaves
 * the wallet is decided downstream by the kernel's guards and the input-leg
 * spend caps, which is why a corrupted or hostile row cannot spend more than an
 * operator already authorised.
 */
export class StrategyStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(dbPath = ":memory:") {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        params TEXT NOT NULL,
        next_run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        runs INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_strat_due ON strategies (status, next_run_at);
    `);
  }

  create(
    userId: number,
    kind: StrategyKind,
    params: Record<string, unknown>,
    firstRunAt: number,
  ): StrategyRow {
    const id = randomUUID();
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO strategies (id, user_id, kind, status, params, next_run_at, created_at, runs, errors)
         VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 0)`,
      )
      .run(id, userId, kind, JSON.stringify(params), firstRunAt, now);
    const row = this.get(id);
    if (!row)
      throw new Error(`strategy ${id} vanished immediately after insert`);
    return row;
  }

  get(id: string): StrategyRow | undefined {
    const r = this.#db
      .prepare(`SELECT * FROM strategies WHERE id = ?`)
      .get(id) as DbRow | undefined;
    return r ? hydrate(r) : undefined;
  }

  /** Active strategies whose next run is due. Oldest deadline first. */
  due(now: number): StrategyRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM strategies WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC`,
      )
      .all(now) as unknown as DbRow[];
    return rows.map(hydrate);
  }

  list(userId: number): StrategyRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM strategies WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as unknown as DbRow[];
    return rows.map(hydrate);
  }

  /** Every strategy, newest-first. The console shows all of them, not one user's. */
  all(limit = 100): StrategyRow[] {
    const rows = this.#db
      .prepare(`SELECT * FROM strategies ORDER BY created_at DESC LIMIT ?`)
      .all(Math.max(0, Math.floor(limit))) as unknown as DbRow[];
    return rows.map(hydrate);
  }

  save(row: StrategyRow): void {
    this.#db
      .prepare(
        `UPDATE strategies SET status = ?, params = ?, next_run_at = ?, last_run_at = ?, runs = ?, errors = ?, last_error = ? WHERE id = ?`,
      )
      .run(
        row.status,
        JSON.stringify(row.params),
        row.nextRunAt,
        row.lastRunAt,
        row.runs,
        row.errors,
        row.lastError,
        row.id,
      );
  }

  /**
   * Set a strategy's status. Returns false when no such row exists, so a
   * console route can answer 404 rather than silently pretending it worked.
   * `node:sqlite` reports `changes` as a bigint — hence the `Number()`.
   */
  setStatus(id: string, status: StrategyStatus): boolean {
    const info = this.#db
      .prepare(`UPDATE strategies SET status = ? WHERE id = ?`)
      .run(status, id);
    return Number(info.changes) > 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
