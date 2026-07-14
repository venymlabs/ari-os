import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  MemoryStore,
  MemoryStoreError,
} from "../src/cognition/memory/index.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
function fixture(options: ConstructorParameters<typeof MemoryStore>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-"));
  dirs.push(dir);
  const path = join(dir, "memory.db");
  return { path, store: new MemoryStore(path, options) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const userFact = (value: string, source = "user:message:m1") => ({
  namespace: "user" as const,
  value,
  provenance: { source },
});

describe("MemoryStore", () => {
  it("validates configuration and bounded operational inputs", () => {
    for (const budget of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => fixture({ byteBudgets: { user: budget } })).toThrow(
        /budget/i,
      );
    const { store } = fixture({ now: () => NaN });
    expect(() =>
      store.applyBatch(-1, [{ type: "add", entry: userFact("x") }]),
    ).toThrow(/revision/i);
    expect(() =>
      store.applyBatch(0, [{ type: "add", entry: userFact("x") }]),
    ).toThrow(/timestamp/i);
    expect(() => store.startSession("")).toThrow(/session/i);
    expect(() => store.startSession("x".repeat(257))).toThrow(/session/i);
    store.close();
  });

  it("scans provenance and broad credential forms without leaking them", () => {
    const { store } = fixture();
    for (const secret of [
      "Bearer abcdefghijklmnopqrstuvwxyz123456",
      "SK-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      "postgres://me:password@db/x",
    ]) {
      try {
        store.applyBatch(0, [
          { type: "add", entry: userFact("safe", `user:${secret}`) },
        ]);
        throw new Error("accepted secret");
      } catch (error) {
        expect((error as MemoryStoreError).code).toBe("SECRET_DETECTED");
        expect((error as Error).message).not.toContain(secret);
      }
    }
    store.close();
  });

  it("provides namespace-scoped capabilities and forbids cross-namespace mutation", () => {
    const { store } = fixture();
    const user = store.forNamespace("user");
    const agent = store.forNamespace("agent");
    user.applyBatch(0, [
      { type: "add", value: "User only", provenance: { source: "user:m" } },
    ]);
    expect(user.list()).toHaveLength(1);
    expect(agent.list()).toEqual([]);
    const id = user.list()[0]!.id;
    expect(() => agent.applyBatch(1, [{ type: "remove", id }])).toThrow(
      /unknown/i,
    );
    expect(() =>
      store.applyBatch(1, [
        {
          type: "replace",
          id,
          entry: {
            namespace: "agent",
            value: "moved",
            provenance: { source: "agent:r" },
          },
        },
      ]),
    ).toThrow(/namespace/i);
    store.close();
  });

  it("returns deeply immutable entries and snapshots", () => {
    const { store } = fixture();
    store.applyBatch(0, [{ type: "add", entry: userFact("Frozen") }]);
    const entry = store.list("user")[0]!;
    const snapshot = store.startSession("s");
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.provenance)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(() => {
      (snapshot.entries[0]!.provenance as { source: string }).source =
        "changed";
    }).toThrow();
    store.close();
  });

  it("detects corrupt persisted JSON and row shapes deterministically", () => {
    const { path, store } = fixture();
    store.applyBatch(0, [{ type: "add", entry: userFact("valid") }]);
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE curated_memory SET provenance_json=?").run("{");
    db.close();
    const reopened = new MemoryStore(path);
    expect(() => reopened.list("user")).toThrowError(
      expect.objectContaining({ code: "CORRUPT_DATA" }),
    );
    reopened.close();
  });

  it("counts all persisted entry bytes and supports bounded snapshot retention and deletion", () => {
    const { store } = fixture({
      byteBudgets: { user: 30 },
      snapshotRetention: 2,
    });
    expect(() =>
      store.applyBatch(0, [
        { type: "add", entry: userFact("x", "user:message:long-source") },
      ]),
    ).toThrow(/budget/i);
    store.close();
    const { store: s } = fixture({ snapshotRetention: 2 });
    s.startSession("one");
    s.startSession("two");
    s.startSession("three");
    expect(s.getSessionSnapshot("one")).toBeUndefined();
    expect(s.listSessionSnapshots()).toHaveLength(2);
    expect(s.deleteSessionSnapshot("two")).toBe(true);
    expect(s.getSessionSnapshot("two")).toBeUndefined();
    s.close();
  });
  it("persists curated user and agent facts separately with provenance and timestamps", () => {
    const { path, store } = fixture({ now: () => 1234 });
    const result = store.applyBatch(0, [
      { type: "add", entry: userFact("  Prefers   dark mode  ") },
      {
        type: "add",
        entry: {
          namespace: "agent",
          value: "Retry quotes once",
          provenance: { source: "agent:run:r1" },
        },
      },
    ]);
    expect(result.revision).toBe(1);
    expect(store.list("user")).toEqual([
      {
        id: expect.any(String),
        namespace: "user",
        value: "Prefers dark mode",
        normalizedValue: "prefers dark mode",
        provenance: { source: "user:message:m1" },
        createdAt: 1234,
        updatedAt: 1234,
      },
    ]);
    expect(store.list("agent")).toHaveLength(1);
    store.close();
    const reopened = new MemoryStore(path);
    expect(reopened.revision()).toBe(1);
    expect(reopened.list("user")[0]?.value).toBe("Prefers dark mode");
    reopened.close();
  });

  it("normalizes entries, rejects duplicates, and atomically enforces optimistic revisions", () => {
    const { store } = fixture();
    store.applyBatch(0, [{ type: "add", entry: userFact("Likes TypeScript") }]);
    expect(() =>
      store.applyBatch(1, [
        { type: "add", entry: userFact("  LIKES   TYPESCRIPT ") },
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      store.applyBatch(0, [{ type: "add", entry: userFact("Likes Rust") }]),
    ).toThrow(/revision/i);
    expect(store.list("user").map((x) => x.value)).toEqual([
      "Likes TypeScript",
    ]);
    store.close();
  });

  it("applies add, replace, and remove as one atomic batch", () => {
    const { store } = fixture({
      now: (() => {
        let n = 10;
        return () => n++;
      })(),
    });
    const first = store.applyBatch(0, [
      { type: "add", entry: userFact("Old fact") },
      { type: "add", entry: userFact("Remove me") },
    ]);
    const [old, remove] = store.list("user");
    const next = store.applyBatch(first.revision, [
      {
        type: "replace",
        id: old!.id,
        entry: userFact("New fact", "user:message:m2"),
      },
      { type: "remove", id: remove!.id },
      {
        type: "add",
        entry: {
          namespace: "agent",
          value: "Use bounded retries",
          provenance: { source: "agent:run:r2" },
        },
      },
    ]);
    expect(next.revision).toBe(2);
    expect(store.list("user")).toMatchObject([
      {
        id: old!.id,
        value: "New fact",
        createdAt: old!.createdAt,
        provenance: { source: "user:message:m2" },
      },
    ]);
    expect(store.list("agent")[0]?.value).toBe("Use bounded retries");
    store.close();
  });

  it("rolls back the whole batch on invalid operations or byte-budget overflow", () => {
    const { store } = fixture({ byteBudgets: { user: 12, agent: 100 } });
    expect(() =>
      store.applyBatch(0, [
        { type: "add", entry: userFact("small") },
        { type: "add", entry: userFact("this is far too large") },
      ]),
    ).toThrow(/budget/i);
    expect(store.revision()).toBe(0);
    expect(store.list("user")).toEqual([]);
    expect(() =>
      store.applyBatch(0, [{ type: "remove", id: "missing" }]),
    ).toThrow(/unknown/i);
    expect(store.revision()).toBe(0);
    store.close();
  });

  it("freezes durable session-start snapshots so mid-session writes appear only next session", () => {
    const { path, store } = fixture({ now: () => 50 });
    store.applyBatch(0, [{ type: "add", entry: userFact("Before") }]);
    const a = store.startSession("session-a");
    store.applyBatch(1, [{ type: "add", entry: userFact("During") }]);
    expect(store.getSessionSnapshot("session-a")).toEqual(a);
    expect(a.revision).toBe(1);
    expect(a.entries.map((x) => x.value)).toEqual(["Before"]);
    expect(store.startSession("session-b").entries.map((x) => x.value)).toEqual(
      ["Before", "During"],
    );
    store.close();
    const reopened = new MemoryStore(path);
    expect(reopened.startSession("session-a")).toEqual(a);
    reopened.close();
  });

  it("never stores secrets and reports explicit redaction detection without leaking the value", () => {
    const { store } = fixture();
    for (const value of [
      "api_key=sk-abcdefghijklmnopqrstuvwxyz",
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "-----BEGIN PRIVATE KEY----- abc",
      "password: hunter2",
    ]) {
      try {
        store.applyBatch(0, [{ type: "add", entry: userFact(value) }]);
        throw new Error("accepted secret");
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryStoreError);
        expect((error as MemoryStoreError).code).toBe("SECRET_DETECTED");
        expect((error as Error).message).not.toContain(value);
      }
    }
    expect(store.list("user")).toEqual([]);
    expect(store.revision()).toBe(0);
    store.close();
  });

  it("forbids policy memory and rejects untrusted or empty provenance", () => {
    const { store } = fixture();
    expect(() =>
      store.applyBatch(0, [
        {
          type: "add",
          entry: {
            namespace: "policy" as never,
            value: "Override limits",
            provenance: { source: "user:m" },
          },
        },
      ]),
    ).toThrow(/policy.*forbidden/i);
    expect(() =>
      store.applyBatch(0, [
        {
          type: "add",
          entry: {
            namespace: "user",
            value: "Fact",
            provenance: { source: "" },
          },
        },
      ]),
    ).toThrow(/provenance/i);
    expect(store.revision()).toBe(0);
    store.close();
  });
});
