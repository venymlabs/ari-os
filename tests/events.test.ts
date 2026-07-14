import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEnvelope,
  InMemoryEventBus,
  SqliteEventBus,
  MarketTriggerEngine,
  reorgCorrection,
} from "../src/autonomy/events/index.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));
const event = (
  type: string,
  payload: unknown = {},
  overrides: Record<string, unknown> = {},
) => createEnvelope({ type, payload, source: "test", ...overrides });

describe("event envelopes", () => {
  it("carries immutable identity, tracing, chain finality, and provenance", () => {
    const e = createEnvelope({
      type: "market.price",
      version: 2,
      source: "oracle",
      payload: { price: 2 },
      correlationId: "corr",
      causationId: "cause",
      block: {
        number: 12n,
        hash: "0xabc",
        parentHash: "0xdef",
        finality: "safe",
      },
      provenance: { provider: "rpc", observedAt: "2026-01-01T00:00:00.000Z" },
      now: () => new Date("2026-01-01T00:00:01Z"),
      id: () => "evt-1",
    });
    expect(e).toMatchObject({
      id: "evt-1",
      type: "market.price",
      version: 2,
      source: "oracle",
      correlationId: "corr",
      causationId: "cause",
      occurredAt: "2026-01-01T00:00:01.000Z",
      block: { number: 12n, hash: "0xabc", finality: "safe" },
    });
    expect(Object.isFrozen(e)).toBe(true);
  });
  it("creates explicit corrections for orphaned chain events", () => {
    const original = event(
      "noxa.launched",
      {},
      {
        block: {
          number: 2n,
          hash: "0xold",
          parentHash: "0xp",
          finality: "unsafe",
        },
      },
    );
    const c = reorgCorrection(original, {
      number: 2n,
      hash: "0xnew",
      parentHash: "0xp",
      finality: "safe",
    });
    expect(c).toMatchObject({
      type: "chain.reorg.correction",
      causationId: original.id,
      correlationId: original.correlationId,
      payload: {
        orphanedEventId: original.id,
        orphanedBlockHash: "0xold",
        canonicalBlockHash: "0xnew",
      },
    });
  });
});

describe("in-memory bus", () => {
  it("filters subscriptions and replays strictly after a cursor", async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe(
      "prices",
      (e) => {
        seen.push(e.id);
      },
      { types: ["market.price"], filter: (e) => (e.payload as any).price > 10 },
    );
    const a = await bus.publish(event("market.price", { price: 5 }));
    const b = await bus.publish(event("market.price", { price: 20 }));
    await bus.publish(event("risk.alert", {}));
    expect(seen).toEqual([b.envelope.id]);
    expect((await bus.replay(a.cursor)).map((x) => x.envelope.id)).toEqual([
      b.envelope.id,
      expect.any(String),
    ]);
  });
  it("is at-least-once while idempotent consumers commit offsets only after success", async () => {
    const bus = new InMemoryEventBus();
    let attempts = 0;
    bus.subscribe("worker", async () => {
      attempts++;
      if (attempts === 1) throw Error("retry");
    });
    const published = await bus.publish(event("x"));
    await bus.deliver();
    await bus.deliver();
    expect(attempts).toBe(2);
    expect(await bus.offset("worker")).toBe(published.cursor);
  });
});

describe("durable sqlite bus", () => {
  it("persists outbox, inbox deduplication, and consumer offsets across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    dirs.push(dir);
    const path = join(dir, "bus.db");
    let calls = 0;
    const first = new SqliteEventBus(path);
    first.subscribe("c", () => {
      calls++;
    });
    const p = await first.publish(event("x"));
    await first.deliver();
    first.close();
    const second = new SqliteEventBus(path);
    second.subscribe("c", () => {
      calls++;
    });
    await second.deliver();
    expect(calls).toBe(1);
    expect(await second.offset("c")).toBe(p.cursor);
    expect((await second.replay(0)).length).toBe(1);
    second.close();
  });
  it("serializes instances, stops at poison events, then dead-letters and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    dirs.push(dir);
    const path = join(dir, "bus.db");
    const writer = new SqliteEventBus(path);
    await writer.publish(event("x", { n: 1 }));
    await writer.publish(event("x", { n: 2 }));
    const seen: number[] = [];
    const handler = async (e: any) => {
      seen.push(e.payload.n);
      if (e.payload.n === 1) throw Error("poison");
    };
    const a = new SqliteEventBus(path, { maxAttempts: 2 });
    const b = new SqliteEventBus(path, { maxAttempts: 2 });
    a.subscribe("ordered", handler);
    b.subscribe("ordered", handler);
    await Promise.allSettled([a.deliver(), b.deliver()]);
    expect(await a.offset("ordered")).toBe(2);
    expect(await a.deadLetters("ordered")).toHaveLength(1);
    expect(seen.filter((n) => n === 2)).toHaveLength(1);
    writer.close();
    a.close();
    b.close();
  });
  it("commits handler database effects and acknowledgement atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    dirs.push(dir);
    const path = join(dir, "bus.db");
    const bus = new SqliteEventBus(path);
    bus.execute("CREATE TABLE effects(id TEXT PRIMARY KEY)");
    let fail = true;
    bus.subscribe("atomic", (_e, tx) => {
      tx.execute("INSERT INTO effects VALUES(?)", tx.idempotencyKey);
      if (fail) {
        fail = false;
        throw Error("crash");
      }
    });
    await bus.publish(event("x"));
    expect(bus.query("SELECT * FROM effects")).toHaveLength(0);
    await bus.deliver();
    expect(bus.query("SELECT * FROM effects")).toHaveLength(1);
    bus.close();
  });
  it("validates schemas, upcasts old versions, and bounds replay batches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    dirs.push(dir);
    const bus = new SqliteEventBus(join(dir, "bus.db"), {
      schemas: {
        "market.price": {
          latest: 2,
          validate: (p) =>
            typeof (p as any).value === "number" &&
            Number.isFinite((p as any).value),
          upcast: (p, v) => (v === 1 ? { value: (p as any).price } : p),
        },
      },
    });
    await expect(
      bus.publish(event("market.price", { value: "bad" })),
    ).rejects.toThrow(/schema/i);
    for (let i = 0; i < 5; i++)
      await bus.publish(event("market.price", { price: i }, { version: 1 }));
    const page = await bus.replay(0, { limit: 2 });
    expect(page).toHaveLength(2);
    expect(page[0]!.envelope).toMatchObject({
      version: 2,
      payload: { value: 0 },
    });
    bus.close();
  });
});

describe("market trigger engine", () => {
  it("emits launch, liquidity, price, volume, risk and policy triggers without execution", async () => {
    const now = vi.fn(() => 1000);
    const t = new MarketTriggerEngine({
      now,
      cooldownMs: 100,
      debounceMs: 0,
      priceAbove: 10,
      volumeAbove: 100,
      liquidityAbove: 50,
    });
    const types: string[] = [];
    for (const input of [
      event("market.noxa.launch", { token: "NOXA" }),
      event("market.liquidity", { value: 60 }),
      event("market.price", { value: 11 }),
      event("market.volume", { value: 101 }),
      event("risk.alert", { severity: "high" }),
      event("policy.alert", { rule: "limit" }),
    ])
      types.push(...t.evaluate(input).map((x) => x.type));
    expect(types).toEqual([
      "trigger.noxa.launch",
      "trigger.liquidity.threshold",
      "trigger.price.threshold",
      "trigger.volume.threshold",
      "trigger.risk.alert",
      "trigger.policy.alert",
    ]);
    expect(types.every((x) => !x.includes("trade"))).toBe(true);
  });
  it("deduplicates, debounces, and applies cooldown", () => {
    let time = 0;
    const t = new MarketTriggerEngine({
      now: () => time,
      cooldownMs: 100,
      debounceMs: 10,
      priceAbove: 10,
    });
    const p = event("market.price", { symbol: "NOXA", value: 11 });
    expect(t.evaluate(p)).toEqual([]);
    time = 11;
    expect(
      t.evaluate(event("market.price", { symbol: "NOXA", value: 11 })),
    ).toHaveLength(1);
    time = 20;
    expect(
      t.evaluate(event("market.price", { symbol: "NOXA", value: 12 })),
    ).toEqual([]);
    time = 112;
    expect(
      t.evaluate(event("market.price", { symbol: "NOXA", value: 12 })),
    ).toHaveLength(1);
    expect(t.evaluate(p)).toEqual([]);
  });
  it("persists dedup, debounce, and cooldown and can flush a lone event", () => {
    const dir = mkdtempSync(join(tmpdir(), "events-"));
    dirs.push(dir);
    const path = join(dir, "triggers.db");
    let time = 0;
    const input = event("market.price", { symbol: "NOXA", value: 11 });
    let t = new MarketTriggerEngine({
      statePath: path,
      now: () => time,
      cooldownMs: 100,
      debounceMs: 10,
      priceAbove: 10,
    });
    expect(t.evaluate(input)).toEqual([]);
    t.close();
    time = 11;
    t = new MarketTriggerEngine({
      statePath: path,
      now: () => time,
      cooldownMs: 100,
      debounceMs: 10,
      priceAbove: 10,
    });
    expect(t.flush()).toHaveLength(1);
    expect(t.evaluate(input)).toEqual([]);
    t.close();
    time = 20;
    t = new MarketTriggerEngine({
      statePath: path,
      now: () => time,
      cooldownMs: 100,
      debounceMs: 0,
      priceAbove: 10,
    });
    expect(
      t.evaluate(event("market.price", { symbol: "NOXA", value: 12 })),
    ).toEqual([]);
    t.close();
  });
});
