import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Finality = "unsafe" | "safe" | "finalized";
export interface ChainPosition {
  number: bigint;
  hash: string;
  parentHash: string;
  finality: Finality;
}
export interface Provenance {
  provider: string;
  observedAt: string;
  [key: string]: unknown;
}
export interface EventEnvelope<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly source: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly block?: ChainPosition;
  readonly provenance?: Provenance;
  readonly payload: T;
}
export type EnvelopeInput<T> = {
  type: string;
  payload: T;
  source: string;
  version?: number;
  correlationId?: string;
  causationId?: string;
  block?: ChainPosition;
  provenance?: Provenance;
  now?: () => Date;
  id?: () => string;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as object)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const nonempty = (x: unknown) => typeof x === "string" && x.trim().length > 0;
export function createEnvelope<T>(input: EnvelopeInput<T>): EventEnvelope<T> {
  if (
    !nonempty(input.type) ||
    !nonempty(input.source) ||
    !Number.isSafeInteger(input.version ?? 1) ||
    (input.version ?? 1) < 1
  )
    throw Error("invalid event envelope");
  const id = input.id?.() ?? randomUUID();
  const occurredAt = (input.now?.() ?? new Date()).toISOString();
  if (
    input.block &&
    (!nonempty(input.block.hash) ||
      !nonempty(input.block.parentHash) ||
      input.block.number < 0n ||
      !["unsafe", "safe", "finalized"].includes(input.block.finality))
  )
    throw Error("invalid chain position");
  const value: EventEnvelope<T> = {
    id,
    type: input.type,
    version: input.version ?? 1,
    source: input.source,
    correlationId: input.correlationId ?? id,
    occurredAt,
    payload: input.payload,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.block ? { block: input.block } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
  return freeze(value);
}
export function reorgCorrection(
  original: EventEnvelope,
  canonical: ChainPosition,
) {
  if (!original.block) throw Error("cannot correct an event without a block");
  return createEnvelope({
    id: () =>
      createHash("sha256")
        .update(`${original.id}:${canonical.hash}`)
        .digest("hex"),
    type: "chain.reorg.correction",
    source: "chain",
    correlationId: original.correlationId,
    causationId: original.id,
    payload: {
      orphanedEventId: original.id,
      orphanedBlockHash: original.block.hash,
      canonicalBlockHash: canonical.hash,
      canonicalBlockNumber: canonical.number,
      reversal: true,
    },
    block: canonical,
  });
}

export interface StoredEvent {
  cursor: number;
  envelope: EventEnvelope;
}
export interface HandlerTransaction {
  idempotencyKey: string;
  execute(sql: string, ...params: unknown[]): unknown;
  query(sql: string, ...params: unknown[]): unknown[];
}
type Handler = (
  event: EventEnvelope,
  tx: HandlerTransaction,
) => void | Promise<void>;
export type Options = {
  types?: string[];
  filter?: (event: EventEnvelope) => boolean;
  limit?: number;
  subscriptionVersion?: string;
};
interface Sub {
  name: string;
  handler: Handler;
  options: Options;
}
export interface EventBus {
  publish(event: EventEnvelope): Promise<StoredEvent>;
  subscribe(name: string, handler: Handler, options?: Options): () => void;
  deliver(): Promise<void>;
  replay(cursor: number, options?: Options): Promise<StoredEvent[]>;
  offset(consumer: string): Promise<number>;
}
const noopTx = (id: string): HandlerTransaction => ({
  idempotencyKey: id,
  execute: () => {
    throw Error("transactional effects require SqliteEventBus");
  },
  query: () => [],
});
export class InMemoryEventBus implements EventBus {
  private events: StoredEvent[] = [];
  private subscriptions = new Map<string, Sub>();
  private offsets = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();
  subscribe(name: string, handler: Handler, options: Options = {}) {
    if (this.subscriptions.has(name)) throw Error(`duplicate consumer ${name}`);
    this.subscriptions.set(name, { name, handler, options });
    return () => this.subscriptions.delete(name);
  }
  private enqueue(s: Sub, fn: () => Promise<void>) {
    const next = (this.chains.get(s.name) ?? Promise.resolve()).then(fn);
    this.chains.set(
      s.name,
      next.catch(() => {}),
    );
    return next;
  }
  async publish(envelope: EventEnvelope) {
    const stored = { cursor: this.events.length + 1, envelope };
    this.events.push(stored);
    for (const s of this.subscriptions.values())
      await this.enqueue(s, () => this.process(s, stored)).catch(() => {});
    return stored;
  }
  async deliver() {
    for (const s of this.subscriptions.values())
      await this.enqueue(s, async () => {
        for (const x of this.events)
          if (x.cursor > (this.offsets.get(s.name) ?? 0))
            await this.process(s, x);
      });
  }
  private async process(s: Sub, x: StoredEvent) {
    if (x.cursor <= (this.offsets.get(s.name) ?? 0)) return;
    if (this.matches(x.envelope, s.options))
      await s.handler(x.envelope, noopTx(x.envelope.id));
    this.offsets.set(s.name, x.cursor);
  }
  private matches(e: EventEnvelope, o: Options) {
    return (!o.types || o.types.includes(e.type)) && (!o.filter || o.filter(e));
  }
  async replay(cursor: number, o: Options = {}) {
    return this.events
      .filter((x) => x.cursor > cursor && this.matches(x.envelope, o))
      .slice(0, o.limit ?? 1000);
  }
  async offset(c: string) {
    return this.offsets.get(c) ?? 0;
  }
}
const encode = (_k: string, v: unknown) =>
  typeof v === "bigint" ? { $bigint: v.toString() } : v;
const decode = (_k: string, v: unknown) =>
  v &&
  typeof v === "object" &&
  Object.keys(v).length === 1 &&
  typeof (v as any).$bigint === "string"
    ? BigInt((v as any).$bigint)
    : v;
export interface EventSchema {
  latest: number;
  validate: (payload: unknown) => boolean;
  upcast?: (payload: unknown, version: number) => unknown;
}
export interface SqliteBusConfig {
  maxAttempts?: number;
  batchSize?: number;
  schemas?: Record<string, EventSchema>;
}
const locks = new Map<string, Promise<void>>();
export class SqliteEventBus implements EventBus {
  private db: DatabaseSync;
  private subscriptions = new Map<string, Sub>();
  private maxAttempts: number;
  private batchSize: number;
  constructor(
    private path: string,
    private config: SqliteBusConfig = {},
  ) {
    this.maxAttempts = config.maxAttempts ?? 5;
    this.batchSize = config.batchSize ?? 100;
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS outbox(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,envelope TEXT NOT NULL); CREATE INDEX IF NOT EXISTS outbox_type_cursor ON outbox(type,cursor); CREATE TABLE IF NOT EXISTS inbox(consumer TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(consumer,event_id)); CREATE TABLE IF NOT EXISTS consumer_offsets(consumer TEXT PRIMARY KEY,cursor INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS retries(consumer TEXT NOT NULL,cursor INTEGER NOT NULL,attempts INTEGER NOT NULL,last_error TEXT,PRIMARY KEY(consumer,cursor)); CREATE TABLE IF NOT EXISTS dead_letters(consumer TEXT NOT NULL,cursor INTEGER NOT NULL,event_id TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(consumer,cursor)); CREATE TABLE IF NOT EXISTS subscriptions(consumer TEXT PRIMARY KEY,definition TEXT NOT NULL);",
    );
  }
  private normalize(e: EventEnvelope) {
    const schema = this.config.schemas?.[e.type];
    if (!schema) return e;
    if (e.version > schema.latest)
      throw Error(`unsupported schema version ${e.version}`);
    const payload =
      e.version < schema.latest && schema.upcast
        ? schema.upcast(e.payload, e.version)
        : e.payload;
    if (!schema.validate(payload))
      throw Error(`schema validation failed for ${e.type}`);
    return freeze({ ...e, version: schema.latest, payload });
  }
  subscribe(name: string, handler: Handler, options: Options = {}) {
    if (this.subscriptions.has(name)) throw Error(`duplicate consumer ${name}`);
    const definition = JSON.stringify({
      types: options.types ?? null,
      version: options.subscriptionVersion ?? "1",
      filter: options.filter?.toString() ?? null,
    });
    const old = this.db
      .prepare("SELECT definition FROM subscriptions WHERE consumer=?")
      .get(name) as any;
    if (old && old.definition !== definition)
      throw Error(`subscription definition changed for ${name}`);
    this.db
      .prepare("INSERT OR IGNORE INTO subscriptions VALUES(?,?)")
      .run(name, definition);
    this.subscriptions.set(name, { name, handler, options });
    return () => this.subscriptions.delete(name);
  }
  private serialized(fn: () => Promise<void>) {
    const prior = locks.get(this.path) ?? Promise.resolve();
    const next = prior.then(fn);
    locks.set(
      this.path,
      next.catch(() => {}),
    );
    return next;
  }
  async publish(input: EventEnvelope) {
    const envelope = this.normalize(input);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(event_id,type,envelope) VALUES(?,?,?)",
      )
      .run(envelope.id, envelope.type, JSON.stringify(envelope, encode));
    const row = this.db
      .prepare("SELECT cursor FROM outbox WHERE event_id=?")
      .get(envelope.id) as any;
    const stored = { cursor: Number(row.cursor), envelope };
    for (const s of this.subscriptions.values())
      await this.serialized(() => this.process(s, stored)).catch(() => {});
    return stored;
  }
  private matches(e: EventEnvelope, o: Options) {
    return (!o.types || o.types.includes(e.type)) && (!o.filter || o.filter(e));
  }
  private tx(id: string): HandlerTransaction {
    return {
      idempotencyKey: id,
      execute: (sql, ...p) => this.db.prepare(sql).run(...(p as any[])),
      query: (sql, ...p) =>
        this.db.prepare(sql).all(...(p as any[])) as unknown[],
    };
  }
  private async process(s: Sub, x: StoredEvent) {
    if (x.cursor <= (await this.offset(s.name))) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.matches(x.envelope, s.options))
        await s.handler(x.envelope, this.tx(x.envelope.id));
      this.db
        .prepare("INSERT OR IGNORE INTO inbox VALUES(?,?)")
        .run(s.name, x.envelope.id);
      this.db
        .prepare(
          "INSERT INTO consumer_offsets VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET cursor=excluded.cursor",
        )
        .run(s.name, x.cursor);
      this.db
        .prepare("DELETE FROM retries WHERE consumer=? AND cursor=?")
        .run(s.name, x.cursor);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      const msg = error instanceof Error ? error.message : String(error);
      this.db
        .prepare(
          "INSERT INTO retries VALUES(?,?,1,?) ON CONFLICT(consumer,cursor) DO UPDATE SET attempts=attempts+1,last_error=excluded.last_error",
        )
        .run(s.name, x.cursor, msg);
      const r = this.db
        .prepare("SELECT attempts FROM retries WHERE consumer=? AND cursor=?")
        .get(s.name, x.cursor) as any;
      if (Number(r.attempts) >= this.maxAttempts) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare("INSERT OR IGNORE INTO dead_letters VALUES(?,?,?,?)")
            .run(s.name, x.cursor, x.envelope.id, msg);
          this.db
            .prepare(
              "INSERT INTO consumer_offsets VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET cursor=excluded.cursor",
            )
            .run(s.name, x.cursor);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      } else throw error;
    }
  }
  async deliver() {
    for (const s of this.subscriptions.values())
      await this.serialized(async () => {
        for (;;) {
          const rows = await this.replay(await this.offset(s.name), {
            limit: this.batchSize,
          });
          if (!rows.length) break;
          for (const x of rows) await this.process(s, x);
          if (rows.length < this.batchSize) break;
        }
      });
  }
  async replay(cursor: number, o: Options = {}) {
    const limit = Math.max(1, Math.min(o.limit ?? this.batchSize, 1000));
    const rows = this.db
      .prepare(
        "SELECT cursor,envelope FROM outbox WHERE cursor>? ORDER BY cursor LIMIT ?",
      )
      .all(cursor, limit) as any[];
    const result: StoredEvent[] = [];
    for (const r of rows) {
      try {
        const e = this.normalize(JSON.parse(r.envelope, decode));
        if (this.matches(e, o))
          result.push({ cursor: Number(r.cursor), envelope: e });
      } catch {
        /* malformed persisted rows are poison and omitted from administrative replay */
      }
    }
    return result;
  }
  async offset(c: string) {
    const row = this.db
      .prepare("SELECT cursor FROM consumer_offsets WHERE consumer=?")
      .get(c) as any;
    return Number(row?.cursor ?? 0);
  }
  deadLetters(c?: string) {
    return (
      c
        ? this.db
            .prepare(
              "SELECT * FROM dead_letters WHERE consumer=? ORDER BY cursor",
            )
            .all(c)
        : this.db
            .prepare("SELECT * FROM dead_letters ORDER BY consumer,cursor")
            .all()
    ) as unknown[];
  }
  execute(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).run(...(p as any[]));
  }
  query(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...(p as any[])) as unknown[];
  }
  close() {
    this.db.close();
  }
}

export interface TriggerConfig {
  now?: () => number;
  cooldownMs?: number;
  debounceMs?: number;
  priceAbove?: number;
  volumeAbove?: number;
  liquidityAbove?: number;
  statePath?: string;
}
interface Pending {
  start: number;
  event: EventEnvelope;
  type: string;
  key: string;
}
export class MarketTriggerEngine {
  private now: () => number;
  private cooldown: number;
  private debounce: number;
  private db?: DatabaseSync;
  private pending = new Map<string, Pending>();
  private fired = new Map<string, number>();
  private ids = new Set<string>();
  constructor(private config: TriggerConfig) {
    for (const n of [
      config.cooldownMs ?? 0,
      config.debounceMs ?? 0,
      config.priceAbove,
      config.volumeAbove,
      config.liquidityAbove,
    ])
      if (n !== undefined && (!Number.isFinite(n) || n < 0))
        throw Error("invalid trigger configuration");
    this.now = config.now ?? Date.now;
    this.cooldown = config.cooldownMs ?? 0;
    this.debounce = config.debounceMs ?? 0;
    if (config.statePath) {
      this.db = new DatabaseSync(config.statePath);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS trigger_ids(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS trigger_pending(key TEXT PRIMARY KEY,start INTEGER NOT NULL,event TEXT NOT NULL,type TEXT NOT NULL); CREATE TABLE IF NOT EXISTS trigger_fired(key TEXT PRIMARY KEY,at INTEGER NOT NULL);",
      );
    }
  }
  private seen(id: string) {
    if (this.db) {
      const r = this.db
        .prepare("INSERT OR IGNORE INTO trigger_ids VALUES(?)")
        .run(id);
      return Number(r.changes) === 0;
    }
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    return false;
  }
  private getFired(k: string) {
    if (this.db)
      return Number(
        (
          this.db
            .prepare("SELECT at FROM trigger_fired WHERE key=?")
            .get(k) as any
        )?.at ?? NaN,
      );
    return this.fired.get(k);
  }
  private emit(p: Pending) {
    const now = this.now(),
      last = this.getFired(p.key);
    if (
      last !== undefined &&
      Number.isFinite(last) &&
      now - last < this.cooldown
    )
      return [];
    if (this.db)
      this.db
        .prepare(
          "INSERT INTO trigger_fired VALUES(?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at",
        )
        .run(p.key, now);
    else this.fired.set(p.key, now);
    return [
      createEnvelope({
        type: p.type,
        source: "market-trigger",
        correlationId: p.event.correlationId,
        causationId: p.event.id,
        payload: { trigger: p.event.type, input: p.event.payload },
      }),
    ];
  }
  evaluate(e: EventEnvelope): EventEnvelope[] {
    if (this.seen(e.id)) return [];
    const p = e.payload as Record<string, unknown>;
    let type: string | undefined;
    const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    if (e.type === "market.noxa.launch" && p.token === "NOXA")
      type = "trigger.noxa.launch";
    else if (
      e.type === "market.liquidity" &&
      finite(p.value) &&
      (p.value as number) >= (this.config.liquidityAbove ?? Infinity)
    )
      type = "trigger.liquidity.threshold";
    else if (
      e.type === "market.price" &&
      finite(p.value) &&
      (p.value as number) >= (this.config.priceAbove ?? Infinity)
    )
      type = "trigger.price.threshold";
    else if (
      e.type === "market.volume" &&
      finite(p.value) &&
      (p.value as number) >= (this.config.volumeAbove ?? Infinity)
    )
      type = "trigger.volume.threshold";
    else if (e.type === "risk.alert") type = "trigger.risk.alert";
    else if (e.type === "policy.alert") type = "trigger.policy.alert";
    if (!type) return [];
    const key = `${type}:${String(p.symbol ?? p.token ?? "")}`,
      item = { start: this.now(), event: e, type, key };
    if (this.debounce > 0) {
      if (this.db)
        this.db
          .prepare(
            "INSERT INTO trigger_pending VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING",
          )
          .run(key, item.start, JSON.stringify(e, encode), type);
      else if (!this.pending.has(key)) this.pending.set(key, item);
      return this.flush();
    }
    return this.emit(item);
  }
  flush() {
    const now = this.now(),
      due: Pending[] = [];
    if (this.db) {
      for (const r of this.db
        .prepare("SELECT * FROM trigger_pending WHERE start<=?")
        .all(now - this.debounce) as any[])
        due.push({
          key: r.key,
          start: r.start,
          event: JSON.parse(r.event, decode),
          type: r.type,
        });
      for (const p of due)
        this.db.prepare("DELETE FROM trigger_pending WHERE key=?").run(p.key);
    } else
      for (const [k, p] of this.pending)
        if (now - p.start >= this.debounce) {
          due.push(p);
          this.pending.delete(k);
        }
    return due.flatMap((p) => this.emit(p));
  }
  close() {
    this.db?.close();
  }
}
