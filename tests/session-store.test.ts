import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/storage/session-store.js";
import { DatabaseSync } from "node:sqlite";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "agent-sessions-"));
  dirs.push(dir);
  return {
    db: new SessionStore(join(dir, "sessions.db")),
    path: join(dir, "sessions.db"),
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("SessionStore", () => {
  it("persists sessions, ordered messages, runs, and schema metadata", () => {
    const { db, path } = store();
    db.createSession({ id: "s1", title: "Trading research" });
    db.appendMessage({
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "Review ETH liquidity",
      createdAt: 10,
    });
    db.createRun({
      id: "r1",
      sessionId: "s1",
      status: "running",
      startedAt: 11,
    });
    db.finishRun("r1", { status: "completed", finishedAt: 12 });
    expect(db.schemaVersion()).toBe(2);
    expect(db.journalMode()).toBe("wal");
    db.close();

    const reopened = new SessionStore(path);
    expect(reopened.getSession("s1")?.title).toBe("Trading research");
    expect(reopened.getMessages("s1").map((m) => m.id)).toEqual(["m1"]);
    expect(reopened.getRun("r1")?.status).toBe("completed");
    reopened.close();
  });

  it("branches sessions with lineage and resumes independently", () => {
    const { db } = store();
    db.createSession({ id: "root" });
    db.appendMessage({
      id: "a",
      sessionId: "root",
      role: "user",
      content: "one",
      createdAt: 1,
    });
    db.appendMessage({
      id: "b",
      sessionId: "root",
      role: "assistant",
      content: "two",
      createdAt: 2,
    });
    db.branchSession({
      id: "branch",
      parentSessionId: "root",
      parentMessageId: "a",
    });
    db.appendMessage({
      id: "c",
      sessionId: "branch",
      role: "user",
      content: "alternate",
      createdAt: 3,
    });
    expect(db.getSession("branch")?.parentSessionId).toBe("root");
    expect(
      db.getMessages("branch", { includeAncestors: true }).map((m) => m.id),
    ).toEqual(["a", "c"]);
    expect(db.getMessages("root").map((m) => m.id)).toEqual(["a", "b"]);
    db.close();
  });

  it("canonically pairs one tool result with a tool call and is idempotent", () => {
    const { db } = store();
    db.createSession({ id: "s" });
    db.appendMessage({
      id: "assistant",
      sessionId: "s",
      role: "assistant",
      content: "calling",
      createdAt: 1,
    });
    db.recordToolCall({
      id: "tc",
      sessionId: "s",
      messageId: "assistant",
      toolName: "quote",
      arguments: { symbol: "ETH" },
      createdAt: 2,
    });
    db.recordToolCall({
      id: "tc",
      sessionId: "s",
      messageId: "assistant",
      toolName: "quote",
      arguments: { symbol: "ETH" },
      createdAt: 2,
    });
    db.recordFinancialEvidence({
      id: "audit:sha256:abc",
      payload: { price: 2000 },
      createdAt: 3,
    });
    db.recordToolResult({
      id: "tr",
      toolCallId: "tc",
      output: { price: 2000 },
      createdAt: 3,
      evidenceRef: "audit:sha256:abc",
    });
    expect(db.getToolExchange("tc")).toMatchObject({
      call: { toolName: "quote", arguments: { symbol: "ETH" } },
      result: { output: { price: 2000 }, evidenceRef: "audit:sha256:abc" },
    });
    expect(() =>
      db.recordToolResult({
        id: "other",
        toolCallId: "tc",
        output: {},
        createdAt: 4,
      }),
    ).toThrow();
    expect(() =>
      db.recordToolCall({
        id: "tc",
        sessionId: "s",
        messageId: "assistant",
        toolName: "other",
        arguments: {},
        createdAt: 2,
      }),
    ).toThrow();
    db.close();
  });

  it("rolls back an atomic write when any operation fails", () => {
    const { db } = store();
    expect(() =>
      db.transaction((tx) => {
        tx.createSession({ id: "rolled-back" });
        tx.appendMessage({
          id: "orphan",
          sessionId: "missing",
          role: "user",
          content: "no",
          createdAt: 1,
        });
      }),
    ).toThrow();
    expect(db.getSession("rolled-back")).toBeUndefined();
    db.close();
  });

  it("searches message text with FTS5 and returns contextual windows", () => {
    const { db } = store();
    db.createSession({ id: "s", title: "Markets" });
    for (const [i, content] of [
      "before context",
      "Ethereum liquidity fragmented across venues",
      "after context",
      "unrelated",
    ].entries())
      db.appendMessage({
        id: `m${i}`,
        sessionId: "s",
        role: i % 2 ? "assistant" : "user",
        content,
        createdAt: i,
      });
    const hits = db.search("liquidity", { contextBefore: 1, contextAfter: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message.id).toBe("m1");
    expect(hits[0]?.context.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(
      db.search("venues", { sessionId: "s" })[0]?.message.content,
    ).toContain("fragmented");
    db.close();
  });

  it("enforces ownership, canonical JSON, recovery, and immutable evidence", () => {
    const { db, path } = store();
    db.createSession({ id: "a", createdAt: 1 });
    db.createSession({ id: "b", createdAt: 1 });
    db.appendMessage({
      id: "m",
      sessionId: "a",
      role: "assistant",
      content: "x",
      createdAt: 2,
    });
    db.recordToolCall({
      id: "t",
      sessionId: "a",
      messageId: "m",
      toolName: "quote",
      arguments: { a: 1, b: 2 },
      createdAt: 3,
    });
    expect(() =>
      db.recordToolCall({
        id: "t",
        sessionId: "a",
        messageId: "m",
        toolName: "quote",
        arguments: { b: 2, a: 1 },
        createdAt: 3,
      }),
    ).not.toThrow();
    db.createRun({ id: "r", sessionId: "a", status: "running", startedAt: 4 });
    expect(db.listUnfinishedRuns().map((r) => r.id)).toEqual(["r"]);
    const ev = db.recordFinancialEvidence({
      id: "ev",
      payload: { price: 2 },
      createdAt: 5,
    });
    expect(ev.sha256).toMatch(/^[a-f0-9]{64}$/);
    db.recordToolResult({
      id: "tr",
      toolCallId: "t",
      output: {},
      createdAt: 6,
      evidenceRef: "ev",
    });
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys=ON");
    expect(() =>
      raw
        .prepare(
          "INSERT INTO sessions(id,parent_session_id,parent_message_id,created_at) VALUES('bad','b','m',1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO tool_calls(id,session_id,message_id,tool_name,arguments_json,created_at) VALUES('bad','b','m','x','{}',1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "UPDATE financial_evidence SET payload_json='{}' WHERE id='ev'",
        )
        .run(),
    ).toThrow(/immutable/i);
    expect(() =>
      raw.prepare("DELETE FROM financial_evidence WHERE id='ev'").run(),
    ).toThrow(/immutable/i);
    raw.close();
  });

  it("supports safe nesting, rejects async transactions and newer schemas", () => {
    const { db } = store();
    db.transaction((tx) =>
      tx.transaction((inner) => inner.createSession({ id: "nested" })),
    );
    expect(() => db.transaction(async () => 1)).toThrow(/async/i);
    db.close();
    const dir = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    dirs.push(dir);
    const path = join(dir, "new.db");
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TABLE schema_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO schema_meta VALUES(1,999)",
    );
    raw.close();
    expect(() => new SessionStore(path)).toThrow(/newer|unsupported/i);
  });
});
