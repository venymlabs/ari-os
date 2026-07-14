import { DatabaseSync } from "node:sqlite";
import type { ZodType } from "zod";
import {
  nextScheduleTime,
  type Schedule,
  type JobQueue,
  type Lease,
} from "../autonomy/jobs/index.js";
type Handler = (
  p: any,
  c: { signal: AbortSignal; lease: Lease },
) => Promise<string | void>;
export class JobHandlerRegistry {
  private m = new Map<string, { schema: ZodType; handler: Handler }>();
  register(type: string, schema: ZodType, handler: Handler) {
    this.m.set(type, { schema, handler });
    return this;
  }
  get(type: string) {
    return this.m.get(type);
  }
}
export class JobWorker {
  private stopRequested = false;
  private active = new Set<Promise<void>>();
  constructor(
    private q: JobQueue,
    private r: JobHandlerRegistry,
    private o: {
      workerId: string;
      leaseMs: number;
      pollMs?: number;
      concurrency?: number;
    },
  ) {}
  async runOnce() {
    const l = this.q.claim(this.o.workerId, this.o.leaseMs);
    if (!l) return false;
    const h = this.r.get(l.job.type);
    if (!h) {
      this.q.fail(l, "unknown handler");
      return true;
    }
    const parsed = h.schema.safeParse(l.job.payload);
    if (!parsed.success) {
      this.q.fail(l, "invalid payload");
      return true;
    }
    const ac = new AbortController(),
      beat = setInterval(
        () => {
          if (
            this.q.isCancellationRequested(l) ||
            !this.q.heartbeat(l, this.o.leaseMs)
          )
            ac.abort();
        },
        Math.max(1, Math.floor(this.o.leaseMs / 3)),
      );
    try {
      const ref = await h.handler(parsed.data, { signal: ac.signal, lease: l });
      if (!ac.signal.aborted)
        this.q.complete(l, { ...(ref ? { resultRef: ref } : {}) });
    } catch (e) {
      this.q.fail(l, e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(beat);
    }
    return true;
  }
  async run() {
    while (!this.stopRequested) {
      if (this.active.size < (this.o.concurrency ?? 1)) {
        const p = this.runOnce()
          .then((done) => {
            if (!done)
              return new Promise<void>((r) =>
                setTimeout(r, this.o.pollMs ?? 100),
              );
          })
          .then(() => {});
        this.active.add(p);
        p.finally(() => this.active.delete(p));
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.allSettled(this.active);
  }
  async stop() {
    this.stopRequested = true;
    this.q.beginDrain();
    await Promise.allSettled(this.active);
  }
}
export class DurableScheduler {
  private db: DatabaseSync;
  constructor(
    path: string,
    private q: JobQueue,
    private o: { clock?: () => number } = {},
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,schedule TEXT NOT NULL,next_fire INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1)",
    );
  }
  upsert(id: string, type: string, payload: unknown, schedule: Schedule) {
    const now = (this.o.clock ?? Date.now)();
    const next = nextScheduleTime(schedule, now);
    this.db
      .prepare("INSERT OR REPLACE INTO schedules VALUES(?,?,?,?,?,1)")
      .run(id, type, JSON.stringify(payload), JSON.stringify(schedule), next);
  }
  tick() {
    const now = (this.o.clock ?? Date.now)(),
      rows = this.db
        .prepare("SELECT * FROM schedules WHERE enabled=1 AND next_fire<=?")
        .all(now) as any[];
    for (const r of rows) {
      this.q.enqueue(r.type, JSON.parse(r.payload), {
        idempotencyKey: `schedule:${r.id}:${r.next_fire}`,
      });
      const schedule = JSON.parse(r.schedule) as Schedule;
      if ("at" in schedule)
        this.db.prepare("UPDATE schedules SET enabled=0 WHERE id=?").run(r.id);
      else
        this.db
          .prepare("UPDATE schedules SET next_fire=? WHERE id=?")
          .run(nextScheduleTime(schedule, r.next_fire), r.id);
    }
    return rows.length;
  }
  close() {
    this.db.close();
  }
}
