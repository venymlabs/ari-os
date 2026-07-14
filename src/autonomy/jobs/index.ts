import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ZodType } from "zod";

export type JobStatus =
  | "scheduled"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead-letter";
export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  scheduledAt: number;
  attemptCount: number;
  maxAttempts: number;
  resultRef?: string;
  error?: string;
  cancelRequested: boolean;
}
export interface Lease {
  job: Job;
  workerId: string;
  fencingToken: number;
  leaseExpiresAt: number;
}
export interface Attempt {
  number: number;
  workerId: string;
  fencingToken: number;
  startedAt: number;
  finishedAt?: number;
  outcome?: "succeeded" | "failed" | "cancelled";
  error?: string;
  resultRef?: string;
}
export type Schedule = { at: number } | { everyMs: number } | { cron: string };
type Row = Record<string, unknown>;
const MAX_TEXT = 1_000_000,
  val = (r: Row, k: string) => r[k],
  n = (r: Row, k: string) => Number(r[k]),
  s = (r: Row, k: string) => String(r[k]);
const validText = (v: string, name: string, allowEmpty = false) => {
  if ((!allowEmpty && !v) || v.length > MAX_TEXT)
    throw new Error(`Invalid or too large ${name}`);
};
const canonical = (v: unknown): string => {
  const seen = new Set<object>();
  const walk = (x: unknown): unknown => {
    if (
      typeof x === "bigint" ||
      typeof x === "function" ||
      typeof x === "symbol" ||
      x === undefined ||
      (typeof x === "number" && !Number.isFinite(x))
    )
      throw new Error("Payload is not JSON serializable");
    if (x && typeof x === "object") {
      if (seen.has(x)) throw new Error("Payload is not JSON serializable");
      seen.add(x);
      const y = Array.isArray(x)
        ? x.map(walk)
        : Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, walk((x as Record<string, unknown>)[k])]),
          );
      seen.delete(x);
      return y;
    }
    return x;
  };
  let text: string;
  try {
    text = JSON.stringify(walk(v));
  } catch (e) {
    throw e instanceof Error
      ? e
      : new Error("Payload is not JSON serializable");
  }
  if (text === undefined) throw new Error("Payload is not JSON serializable");
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error("Payload too large");
  return text;
};

export class JobQueue {
  private db: DatabaseSync;
  private closed = false;
  private draining = false;
  private schemas = new Map<string, ZodType>();
  private clock: () => number;
  private random: () => number;
  constructor(
    path: string,
    options: { clock?: () => number; random?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,scheduled_at INTEGER NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,idempotency_key TEXT UNIQUE,backoff_ms INTEGER NOT NULL,jitter REAL NOT NULL,worker_id TEXT,fencing_token INTEGER NOT NULL DEFAULT 0,lease_expires_at INTEGER,cancel_requested INTEGER NOT NULL DEFAULT 0,result_ref TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status,scheduled_at,created_at);
 CREATE TABLE IF NOT EXISTS job_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),number INTEGER NOT NULL,worker_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT,error TEXT,result_ref TEXT,UNIQUE(job_id,number));
 CREATE TRIGGER IF NOT EXISTS attempts_identity_immutable BEFORE UPDATE OF job_id,number,worker_id,fencing_token,started_at ON job_attempts BEGIN SELECT RAISE(ABORT,'attempt identity is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS attempts_final_immutable BEFORE UPDATE ON job_attempts WHEN OLD.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'finished attempt is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS attempts_no_delete BEFORE DELETE ON job_attempts BEGIN SELECT RAISE(ABORT,'attempts are append-only'); END;`);
  }
  private open() {
    if (this.closed) throw new Error("JobQueue is closed");
  }
  private now() {
    const x = this.clock();
    if (!Number.isSafeInteger(x) || x < 0)
      throw new Error("Invalid clock timestamp");
    return x;
  }
  private tx<T>(fn: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const x = fn();
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  register(type: string, schema: ZodType) {
    this.open();
    validText(type, "job type");
    this.schemas.set(type, schema);
    return this;
  }
  enqueue(
    type: string,
    payload: unknown,
    o: {
      id?: string;
      idempotencyKey?: string;
      scheduledAt?: number;
      maxAttempts?: number;
      backoffMs?: number;
      jitter?: number;
    } = {},
  ): Job {
    this.open();
    const schema = this.schemas.get(type);
    if (!schema) throw new Error(`Unknown job type: ${type}`);
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new Error(`Invalid job payload: ${parsed.error.message}`);
    const json = canonical(parsed.data),
      now = this.now(),
      at = o.scheduledAt ?? now,
      max = o.maxAttempts ?? 3,
      back = o.backoffMs ?? 1000,
      jitter = o.jitter ?? 0,
      id = o.id ?? randomUUID();
    validText(id, "job id");
    if (o.idempotencyKey !== undefined)
      validText(o.idempotencyKey, "idempotency key");
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !Number.isInteger(max) ||
      max < 1 ||
      !Number.isSafeInteger(back) ||
      back < 0 ||
      !Number.isFinite(jitter) ||
      jitter < 0 ||
      jitter > 1
    )
      throw new Error("Invalid retry options");
    return this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO jobs(id,type,payload_json,status,scheduled_at,max_attempts,idempotency_key,backoff_ms,jitter,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING",
        )
        .run(
          id,
          type,
          json,
          at > now ? "scheduled" : "queued",
          at,
          max,
          o.idempotencyKey ?? null,
          back,
          jitter,
          now,
          now,
        );
      if (o.idempotencyKey !== undefined) {
        const r = this.db
          .prepare("SELECT * FROM jobs WHERE idempotency_key=?")
          .get(o.idempotencyKey) as Row;
        if (s(r, "type") !== type || s(r, "payload_json") !== json)
          throw new Error("Idempotency key conflict");
        return this.map(r);
      }
      return this.getRaw(id)!;
    });
  }
  get(id: string) {
    this.open();
    return this.getRaw(id);
  }
  private getRaw(id: string) {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      Row | undefined;
    return r ? this.map(r) : undefined;
  }
  private map(r: Row): Job {
    let payload: unknown;
    try {
      payload = JSON.parse(s(r, "payload_json"));
    } catch {
      throw new Error(`Corrupt payload JSON for job ${s(r, "id")}`);
    }
    return {
      id: s(r, "id"),
      type: s(r, "type"),
      payload,
      status: s(r, "status") as JobStatus,
      scheduledAt: n(r, "scheduled_at"),
      attemptCount: n(r, "attempt_count"),
      maxAttempts: n(r, "max_attempts"),
      cancelRequested: Boolean(n(r, "cancel_requested")),
      ...(val(r, "result_ref") === null
        ? {}
        : { resultRef: s(r, "result_ref") }),
      ...(val(r, "error") === null ? {} : { error: s(r, "error") }),
    };
  }
  claim(workerId: string, leaseMs: number): Lease | undefined {
    this.open();
    if (this.draining) return undefined;
    validText(workerId, "worker id");
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
      throw new Error("Invalid lease");
    const now = this.now();
    if (!Number.isSafeInteger(now + leaseMs)) throw new Error("Invalid lease");
    return this.tx(() => {
      for (;;) {
        const expired = this.db
          .prepare(
            "SELECT * FROM jobs WHERE status='running' AND lease_expires_at<=? ORDER BY scheduled_at,created_at LIMIT 1",
          )
          .get(now) as Row | undefined;
        if (!expired) break;
        const id = s(expired, "id"),
          cancel = Boolean(n(expired, "cancel_requested")),
          exhausted = n(expired, "attempt_count") >= n(expired, "max_attempts"),
          status = cancel ? "cancelled" : exhausted ? "dead-letter" : "queued",
          outcome = cancel ? "cancelled" : "failed";
        const a = this.db
          .prepare(
            "UPDATE job_attempts SET finished_at=?,outcome=?,error=? WHERE job_id=? AND fencing_token=? AND finished_at IS NULL",
          )
          .run(
            now,
            outcome,
            cancel ? null : "Lease expired",
            id,
            n(expired, "fencing_token"),
          );
        if (a.changes !== 1)
          throw new Error("Expired attempt missing or already finalized");
        const j = this.db
          .prepare(
            "UPDATE jobs SET status=?,worker_id=NULL,lease_expires_at=NULL,error=?,updated_at=? WHERE id=? AND status='running' AND fencing_token=?",
          )
          .run(
            status,
            cancel ? null : "Lease expired",
            now,
            id,
            n(expired, "fencing_token"),
          );
        if (j.changes !== 1) throw new Error("Lease recovery fencing conflict");
      }
      const r = this.db
        .prepare(
          "SELECT id FROM jobs WHERE cancel_requested=0 AND status IN('queued','scheduled') AND scheduled_at<=? AND attempt_count<max_attempts ORDER BY scheduled_at,created_at LIMIT 1",
        )
        .get(now) as Row | undefined;
      if (!r) return undefined;
      const id = s(r, "id"),
        expires = now + leaseMs;
      const x = this.db
        .prepare(
          "UPDATE jobs SET status='running',worker_id=?,fencing_token=fencing_token+1,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status IN('queued','scheduled') AND scheduled_at<=? AND attempt_count<max_attempts",
        )
        .run(workerId, expires, now, id, now);
      if (x.changes !== 1) throw new Error("Claim fencing conflict");
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(id) as Row;
      this.db
        .prepare(
          "INSERT INTO job_attempts(job_id,number,worker_id,fencing_token,started_at) VALUES(?,?,?,?,?)",
        )
        .run(
          id,
          n(row, "attempt_count"),
          workerId,
          n(row, "fencing_token"),
          now,
        );
      return {
        job: this.map(row),
        workerId,
        fencingToken: n(row, "fencing_token"),
        leaseExpiresAt: expires,
      };
    });
  }
  heartbeat(l: Lease, leaseMs: number) {
    this.open();
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
      throw new Error("Invalid lease");
    const now = this.now();
    if (!Number.isSafeInteger(now + leaseMs)) throw new Error("Invalid lease");
    const x = this.db
      .prepare(
        "UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND worker_id=? AND fencing_token=? AND status='running' AND cancel_requested=0 AND lease_expires_at>?",
      )
      .run(now + leaseMs, now, l.job.id, l.workerId, l.fencingToken, now);
    return x.changes === 1;
  }
  complete(l: Lease, o: { resultRef?: string }) {
    this.open();
    if (o.resultRef !== undefined)
      validText(o.resultRef, "result reference", true);
    const existing = this.getRaw(l.job.id);
    if (existing?.status === "succeeded")
      return existing.resultRef === o.resultRef;
    const now = this.now();
    return this.tx(() => {
      const r = this.db
        .prepare(
          "SELECT cancel_requested FROM jobs WHERE id=? AND status='running' AND worker_id=? AND fencing_token=? AND lease_expires_at>?",
        )
        .get(l.job.id, l.workerId, l.fencingToken, now) as Row | undefined;
      if (!r) return false;
      const cancelled = Boolean(n(r, "cancel_requested")),
        status = cancelled ? "cancelled" : "succeeded";
      const x = this.db
        .prepare(
          "UPDATE jobs SET status=?,result_ref=?,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND fencing_token=? AND lease_expires_at>?",
        )
        .run(
          status,
          cancelled ? null : (o.resultRef ?? null),
          now,
          l.job.id,
          l.workerId,
          l.fencingToken,
          now,
        );
      if (x.changes !== 1) return false;
      const a = this.db
        .prepare(
          "UPDATE job_attempts SET finished_at=?,outcome=?,result_ref=? WHERE job_id=? AND fencing_token=? AND finished_at IS NULL",
        )
        .run(
          now,
          cancelled ? "cancelled" : "succeeded",
          cancelled ? null : (o.resultRef ?? null),
          l.job.id,
          l.fencingToken,
        );
      if (a.changes !== 1) throw new Error("Attempt finalization failed");
      return !cancelled;
    });
  }
  fail(l: Lease, error: string) {
    this.open();
    validText(error, "error", true);
    const now = this.now();
    return this.tx(() => {
      const r = this.db
        .prepare(
          "SELECT * FROM jobs WHERE id=? AND status='running' AND worker_id=? AND fencing_token=? AND lease_expires_at>?",
        )
        .get(l.job.id, l.workerId, l.fencingToken, now) as Row | undefined;
      if (!r) return false;
      let status: JobStatus,
        at = now;
      if (n(r, "cancel_requested")) status = "cancelled";
      else if (n(r, "attempt_count") >= n(r, "max_attempts"))
        status = "dead-letter";
      else {
        status = "scheduled";
        const delay =
          n(r, "backoff_ms") *
          2 ** (n(r, "attempt_count") - 1) *
          (1 + n(r, "jitter") * this.random());
        if (!Number.isSafeInteger(now + Math.round(delay)))
          throw new Error("Retry backoff overflow");
        at = now + Math.round(delay);
      }
      const x = this.db
        .prepare(
          "UPDATE jobs SET status=?,scheduled_at=?,error=?,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND fencing_token=? AND lease_expires_at>?",
        )
        .run(status, at, error, now, l.job.id, l.workerId, l.fencingToken, now);
      if (x.changes !== 1) return false;
      const a = this.db
        .prepare(
          "UPDATE job_attempts SET finished_at=?,outcome=?,error=? WHERE job_id=? AND fencing_token=? AND finished_at IS NULL",
        )
        .run(
          now,
          status === "cancelled" ? "cancelled" : "failed",
          error,
          l.job.id,
          l.fencingToken,
        );
      if (a.changes !== 1) throw new Error("Attempt finalization failed");
      return true;
    });
  }
  cancel(id: string) {
    this.open();
    const now = this.now();
    return this.tx(() => {
      const r = this.db
        .prepare("SELECT status,fencing_token FROM jobs WHERE id=?")
        .get(id) as Row | undefined;
      if (
        !r ||
        ["succeeded", "failed", "cancelled", "dead-letter"].includes(
          s(r, "status"),
        )
      )
        return false;
      if (s(r, "status") === "running")
        this.db
          .prepare(
            "UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=? AND status='running'",
          )
          .run(now, id);
      else
        this.db
          .prepare(
            "UPDATE jobs SET status='cancelled',cancel_requested=1,updated_at=? WHERE id=? AND status IN('queued','scheduled')",
          )
          .run(now, id);
      return true;
    });
  }
  isCancellationRequested(l: Lease) {
    this.open();
    const r = this.db
      .prepare(
        "SELECT cancel_requested FROM jobs WHERE id=? AND status='running' AND worker_id=? AND fencing_token=?",
      )
      .get(l.job.id, l.workerId, l.fencingToken) as Row | undefined;
    return !!r && Boolean(n(r, "cancel_requested"));
  }
  attempts(id: string): Attempt[] {
    this.open();
    return (
      this.db
        .prepare("SELECT * FROM job_attempts WHERE job_id=? ORDER BY number")
        .all(id) as Row[]
    ).map((r) => ({
      number: n(r, "number"),
      workerId: s(r, "worker_id"),
      fencingToken: n(r, "fencing_token"),
      startedAt: n(r, "started_at"),
      ...(val(r, "finished_at") === null
        ? {}
        : { finishedAt: n(r, "finished_at") }),
      ...(val(r, "outcome") === null
        ? {}
        : { outcome: s(r, "outcome") as NonNullable<Attempt["outcome"]> }),
      ...(val(r, "error") === null ? {} : { error: s(r, "error") }),
      ...(val(r, "result_ref") === null
        ? {}
        : { resultRef: s(r, "result_ref") }),
    }));
  }
  beginDrain() {
    this.open();
    this.draining = true;
  }
  async drain(timeoutMs = 5000) {
    this.beginDrain();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
      throw new Error("Invalid drain timeout");
    const end = Date.now() + timeoutMs;
    while (
      (
        this.db
          .prepare("SELECT count(*) n FROM jobs WHERE status='running'")
          .get() as Row
      ).n !== 0
    ) {
      if (Date.now() >= end) throw new Error("Drain timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

type ParsedField = { values: Set<number>; wildcard: boolean };
const field = (
  text: string,
  min: number,
  max: number,
  sunday = false,
): ParsedField => {
  const out = new Set<number>(),
    wildcard = text === "*";
  for (const part of text.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0)
      throw new Error("Invalid cron field");
    let lo: number, hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base!.includes("-")) {
      const bits = base!.split("-");
      if (bits.length !== 2) {
        throw new Error("Invalid cron field");
      }
      [lo, hi] = bits.map(Number) as [number, number];
    } else lo = hi = Number(base);
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < min ||
      hi > max ||
      lo > hi
    )
      throw new Error("Invalid cron field");
    for (let x = lo; x <= hi; x += step) out.add(sunday && x === 7 ? 0 : x);
  }
  return { values: out, wildcard };
};
export function nextScheduleTime(schedule: Schedule, after: number) {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("Invalid schedule timestamp");
  if ("at" in schedule) {
    if (!Number.isSafeInteger(schedule.at) || schedule.at <= after)
      throw new Error("One-shot schedule is in the past");
    return schedule.at;
  }
  if ("everyMs" in schedule) {
    if (
      !Number.isSafeInteger(schedule.everyMs) ||
      schedule.everyMs <= 0 ||
      !Number.isSafeInteger(after + schedule.everyMs)
    )
      throw new Error("Invalid interval");
    return after + schedule.everyMs;
  }
  const p = schedule.cron.trim().split(/\s+/);
  if (p.length !== 5) throw new Error("Invalid cron schedule");
  const [mi, h, dom, mo, dow] = p as [string, string, string, string, string],
    fs = [
      field(mi, 0, 59),
      field(h, 0, 23),
      field(dom, 1, 31),
      field(mo, 1, 12),
      field(dow, 0, 7, true),
    ];
  let t = Math.floor(after / 60000) * 60000 + 60000;
  for (let i = 0; i < 60 * 24 * 366 * 8; i++, t += 60000) {
    const d = new Date(t),
      domMatch = fs[2]!.values.has(d.getUTCDate()),
      dowMatch = fs[4]!.values.has(d.getUTCDay()),
      day = fs[2]!.wildcard
        ? dowMatch
        : fs[4]!.wildcard
          ? domMatch
          : domMatch || dowMatch;
    if (
      fs[0]!.values.has(d.getUTCMinutes()) &&
      fs[1]!.values.has(d.getUTCHours()) &&
      fs[3]!.values.has(d.getUTCMonth() + 1) &&
      day
    )
      return t;
  }
  throw new Error("Cron schedule has no occurrence");
}
