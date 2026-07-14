import { afterEach, describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import { z } from "zod";
import { JobQueue, nextScheduleTime } from "../src/autonomy/jobs/index.js";

const queues: JobQueue[] = [];
const make = (now = 1_000, random = () => 0) => {
  const q = new JobQueue(":memory:", { clock: () => now, random });
  queues.push(q);
  return { q, setNow: (n: number) => (now = n) };
};
afterEach(() => {
  while (queues.length) queues.pop()!.close();
});

describe("durable job queue", () => {
  it("recovers expired attempts, honours retry budget, and running cancellation", () => {
    const { q, setNow } = make(100);
    q.register("x", z.any());
    const job = q.enqueue("x", {}, { maxAttempts: 2 });
    q.claim("a", 10);
    setNow(111);
    expect(q.claim("b", 10)?.fencingToken).toBe(2);
    expect(q.attempts(job.id)[0]).toMatchObject({
      finishedAt: 111,
      outcome: "failed",
      error: "Lease expired",
    });
    setNow(122);
    expect(q.claim("c", 10)).toBeUndefined();
    expect(q.get(job.id)?.status).toBe("dead-letter");
    expect(q.attempts(job.id)[1]).toMatchObject({
      finishedAt: 122,
      outcome: "failed",
    });
    const cancelled = q.enqueue("x", {});
    const lease = q.claim("a", 10)!;
    expect(lease.job.id).toBe(cancelled.id);
    q.cancel(cancelled.id);
    setNow(133);
    expect(q.claim("b", 10)).toBeUndefined();
    expect(q.get(cancelled.id)?.status).toBe("cancelled");
    expect(q.attempts(cancelled.id)[0]?.outcome).toBe("cancelled");
  });

  it("rejects expired/invalid heartbeats and stale finalization across connections", () => {
    const path = `/tmp/jobs-race-${process.pid}-${Date.now()}.db`;
    const now = { v: 100 };
    const a = new JobQueue(path, { clock: () => now.v }),
      b = new JobQueue(path, { clock: () => now.v });
    queues.push(a, b);
    a.register("x", z.any());
    b.register("x", z.any());
    const job = a.enqueue("x", {});
    const old = a.claim("a", 10)!;
    expect(() => a.heartbeat(old, 0)).toThrow(/lease/i);
    expect(() => a.heartbeat(old, Number.NaN)).toThrow(/lease/i);
    now.v = 110;
    expect(a.heartbeat(old, 10)).toBe(false);
    const fresh = b.claim("b", 10)!;
    a.cancel(job.id);
    expect(a.complete(old, {})).toBe(false);
    expect(b.complete(fresh, {})).toBe(false);
    expect(a.get(job.id)?.status).toBe("cancelled");
    expect(a.attempts(job.id).every((x) => x.finishedAt !== undefined)).toBe(
      true,
    );
    a.close();
    b.close();
    try {
      unlinkSync(path);
    } catch {}
  });

  it("canonicalizes keyed payloads and validates serialization, limits, and close guards", () => {
    const { q } = make();
    q.register("x", z.any());
    expect(q.enqueue("x", { a: 1 }).id).not.toBe(q.enqueue("x", { a: 1 }).id);
    const one = q.enqueue("x", { a: 1, b: 2 }, { idempotencyKey: "k" });
    expect(q.enqueue("x", { b: 2, a: 1 }, { idempotencyKey: "k" }).id).toBe(
      one.id,
    );
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => q.enqueue("x", cyclic)).toThrow(/serializ/i);
    expect(() => q.enqueue("x", BigInt(1))).toThrow(/serializ/i);
    expect(() => q.enqueue("x", "x".repeat(1_000_001))).toThrow(/large/i);
    q.close();
    expect(() => q.get("x")).toThrow(/closed/i);
    expect(() => q.enqueue("x", {})).toThrow(/closed/i);
  });

  it("validates registered job payloads and enforces idempotency keys", () => {
    const { q } = make();
    q.register("email", z.object({ to: z.string().email() }));
    expect(() => q.enqueue("email", { to: "bad" })).toThrow(/payload/i);
    const a = q.enqueue(
      "email",
      { to: "a@b.com" },
      { idempotencyKey: "welcome" },
    );
    const b = q.enqueue(
      "email",
      { to: "a@b.com" },
      { idempotencyKey: "welcome" },
    );
    expect(b.id).toBe(a.id);
    expect(q.get(a.id)?.status).toBe("queued");
  });

  it("claims due jobs atomically and fences stale workers", () => {
    const { q, setNow } = make();
    q.register("x", z.object({ n: z.number() }));
    const job = q.enqueue("x", { n: 1 });
    const first = q.claim("worker-a", 100)!;
    expect(first.job.id).toBe(job.id);
    expect(q.claim("worker-b", 100)).toBeUndefined();
    expect(q.heartbeat(first, 100)).toBe(true);
    setNow(1_201);
    const second = q.claim("worker-b", 100)!;
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(q.complete(first, { resultRef: "stale" })).toBe(false);
    expect(q.complete(second, { resultRef: "result://1" })).toBe(true);
    expect(q.complete(second, { resultRef: "result://1" })).toBe(true);
    expect(q.complete(second, { resultRef: "different" })).toBe(false);
    expect(q.get(job.id)).toMatchObject({
      status: "succeeded",
      resultRef: "result://1",
    });
    expect(q.attempts(job.id)).toHaveLength(2);
  });

  it("retries with injected exponential backoff and jitter then dead-letters", () => {
    const { q, setNow } = make(100, () => 0.5);
    q.register("x", z.any());
    const job = q.enqueue(
      "x",
      {},
      { maxAttempts: 2, backoffMs: 100, jitter: 0.2 },
    );
    const a = q.claim("w", 10)!;
    expect(q.fail(a, "oops")).toBe(true);
    expect(q.get(job.id)).toMatchObject({
      status: "scheduled",
      scheduledAt: 210,
    });
    setNow(209);
    expect(q.claim("w", 10)).toBeUndefined();
    setNow(210);
    const b = q.claim("w", 10)!;
    q.fail(b, "again");
    expect(q.get(job.id)?.status).toBe("dead-letter");
    expect(q.attempts(job.id).map((x) => x.outcome)).toEqual([
      "failed",
      "failed",
    ]);
  });

  it("cancels queued jobs and requests cancellation of running jobs", () => {
    const { q } = make();
    q.register("x", z.any());
    const queued = q.enqueue("x", {});
    expect(q.cancel(queued.id)).toBe(true);
    expect(q.get(queued.id)?.status).toBe("cancelled");
    const running = q.enqueue("x", {});
    const lease = q.claim("w", 100)!;
    expect(lease.job.id).toBe(running.id);
    expect(q.cancel(running.id)).toBe(true);
    expect(q.isCancellationRequested(lease)).toBe(true);
    expect(q.complete(lease, {})).toBe(false);
    expect(q.get(running.id)?.status).toBe("cancelled");
  });

  it("persists across reopen and clean shutdown is idempotent", () => {
    const path = `/tmp/jobs-${process.pid}-${Date.now()}.db`;
    const q = new JobQueue(path, { clock: () => 1 });
    q.register("x", z.any());
    const id = q.enqueue("x", {}).id;
    q.close();
    q.close();
    const reopened = new JobQueue(path, { clock: () => 2 });
    queues.push(reopened);
    expect(reopened.get(id)?.payload).toEqual({});
  });
});

describe("deterministic schedules", () => {
  it("supports one-shot, intervals, and basic five-field cron", () => {
    expect(nextScheduleTime({ at: 500 }, 100)).toBe(500);
    expect(nextScheduleTime({ everyMs: 100 }, 250)).toBe(350);
    expect(
      nextScheduleTime({ cron: "*/15 * * * *" }, Date.UTC(2025, 0, 1, 0, 7)),
    ).toBe(Date.UTC(2025, 0, 1, 0, 15));
    expect(() => nextScheduleTime({ cron: "bad" }, 0)).toThrow(/cron/i);
  });
  it("supports standard cron ranges, steps, Sunday 7, leap years, and DOM/DOW OR", () => {
    expect(nextScheduleTime({ cron: "0 0 1 * 1" }, Date.UTC(2025, 0, 1))).toBe(
      Date.UTC(2025, 0, 6),
    );
    expect(nextScheduleTime({ cron: "0 0 * * 7" }, Date.UTC(2025, 0, 4))).toBe(
      Date.UTC(2025, 0, 5),
    );
    expect(
      nextScheduleTime({ cron: "0 0 28-31/2 2 *" }, Date.UTC(2024, 1, 27)),
    ).toBe(Date.UTC(2024, 1, 28));
    expect(nextScheduleTime({ cron: "0 0 29 2 *" }, Date.UTC(2023, 2, 1))).toBe(
      Date.UTC(2024, 1, 29),
    );
    expect(() => nextScheduleTime({ at: 99 }, 100)).toThrow(/past/i);
  });
});
