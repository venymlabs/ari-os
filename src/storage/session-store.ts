import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export interface Session {
  id: string;
  title?: string;
  parentSessionId?: string;
  parentMessageId?: string;
  createdAt: number;
}
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  sequence: number;
}
export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
}
export interface ToolCall {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  arguments: unknown;
  createdAt: number;
}
export interface ToolResult {
  id: string;
  toolCallId: string;
  output: unknown;
  createdAt: number;
  evidenceRef?: string;
}
export interface FinancialEvidence {
  id: string;
  payload: unknown;
  sha256: string;
  createdAt: number;
}
export interface SearchHit {
  message: Message;
  context: Message[];
}
type Row = Record<string, unknown>;
const obj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function canonical(v: unknown, seen = new Set<object>()): string {
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  )
    return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new Error("Invalid JSON: cycle");
    seen.add(v);
    const s = `[${v.map((x) => canonical(x, seen)).join(",")}]`;
    seen.delete(v);
    return s;
  }
  if (obj(v)) {
    if (seen.has(v)) throw new Error("Invalid JSON: cycle");
    seen.add(v);
    const s = `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k], seen)}`)
      .join(",")}}`;
    seen.delete(v);
    return s;
  }
  throw new Error("Invalid JSON value");
}
const parse = (s: string): unknown => JSON.parse(s);
const text = (r: Row, k: string) => String(r[k]);
const num = (r: Row, k: string) => Number(r[k]);
export class SessionStore {
  private readonly db: DatabaseSync;
  private depth = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000",
    );
    this.migrate();
  }
  private migrate() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const has = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'",
        )
        .get();
      if (has) {
        const cols = this.db
          .prepare("PRAGMA table_info(schema_meta)")
          .all() as Row[];
        if (!cols.some((c) => c.name === "id")) {
          this.db.exec("DROP TABLE schema_meta");
        } else {
          const rows = this.db
            .prepare("SELECT version FROM schema_meta")
            .all() as Row[];
          if (rows.length !== 1) throw new Error("Invalid schema metadata");
          if (num(rows[0]!, "version") > 2)
            throw new Error("Unsupported newer schema");
        }
      }
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS schema_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT OR IGNORE INTO schema_meta VALUES(1,2);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT,parent_session_id TEXT,parent_message_id TEXT,created_at INTEGER NOT NULL,FOREIGN KEY(parent_session_id,parent_message_id) REFERENCES messages(session_id,id),CHECK((parent_session_id IS NULL)=(parent_message_id IS NULL)));
CREATE TABLE IF NOT EXISTS messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),role TEXT NOT NULL CHECK(role IN('user','assistant','system','tool')),content TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,id));
CREATE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id,sequence); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),status TEXT NOT NULL CHECK(status IN('running','completed','failed','cancelled')),started_at INTEGER NOT NULL,finished_at INTEGER,CHECK((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL))); CREATE INDEX IF NOT EXISTS runs_unfinished ON runs(status,started_at) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,tool_name TEXT NOT NULL,arguments_json TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(session_id,message_id) REFERENCES messages(session_id,id));
CREATE TABLE IF NOT EXISTS financial_evidence(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,sha256 TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL); CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON financial_evidence BEGIN SELECT RAISE(ABORT,'financial evidence is immutable');END; CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON financial_evidence BEGIN SELECT RAISE(ABORT,'financial evidence is immutable');END;
CREATE TABLE IF NOT EXISTS tool_results(id TEXT PRIMARY KEY,tool_call_id TEXT UNIQUE NOT NULL REFERENCES tool_calls(id),output_json TEXT NOT NULL,created_at INTEGER NOT NULL,evidence_ref TEXT REFERENCES financial_evidence(id));
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content,content='messages',content_rowid='sequence'); CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,content)VALUES(new.sequence,new.content);END; CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,content)VALUES('delete',old.sequence,old.content);END;`);
      this.db.prepare("UPDATE schema_meta SET version=2 WHERE id=1").run();
      this.db.exec(
        "INSERT INTO messages_fts(messages_fts) VALUES('rebuild'); COMMIT",
      );
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  schemaVersion() {
    return num(
      this.db
        .prepare("SELECT version FROM schema_meta WHERE id=1")
        .get() as Row,
      "version",
    );
  }
  journalMode() {
    return text(
      this.db.prepare("PRAGMA journal_mode").get() as Row,
      "journal_mode",
    ).toLowerCase();
  }
  close() {
    this.db.close();
  }
  createSession(i: {
    id: string;
    title?: string;
    parentSessionId?: string;
    parentMessageId?: string;
    createdAt?: number;
  }) {
    const at = i.createdAt ?? Date.now();
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(
        i.id,
        i.title ?? null,
        i.parentSessionId ?? null,
        i.parentMessageId ?? null,
        at,
      );
    const s = this.getSession(i.id);
    if (
      !s ||
      s.title !== i.title ||
      s.parentSessionId !== i.parentSessionId ||
      s.parentMessageId !== i.parentMessageId ||
      s.createdAt !== at
    )
      throw new Error(`Session id conflict: ${i.id}`);
    return s;
  }
  branchSession(i: {
    id: string;
    parentSessionId: string;
    parentMessageId: string;
    title?: string;
    createdAt?: number;
  }) {
    return this.createSession(i);
  }
  getSession(id: string) {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      Row | undefined;
    return r
      ? {
          id: text(r, "id"),
          ...(r.title === null ? {} : { title: text(r, "title") }),
          ...(r.parent_session_id === null
            ? {}
            : {
                parentSessionId: text(r, "parent_session_id"),
                parentMessageId: text(r, "parent_message_id"),
              }),
          createdAt: num(r, "created_at"),
        }
      : undefined;
  }
  private mm(r: Row): Message {
    return {
      id: text(r, "id"),
      sessionId: text(r, "session_id"),
      role: text(r, "role") as MessageRole,
      content: text(r, "content"),
      createdAt: num(r, "created_at"),
      sequence: num(r, "sequence"),
    };
  }
  appendMessage(i: Omit<Message, "sequence">) {
    this.db
      .prepare(
        "INSERT INTO messages(id,session_id,role,content,created_at)VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(i.id, i.sessionId, i.role, i.content, i.createdAt);
    const r = this.db.prepare("SELECT * FROM messages WHERE id=?").get(i.id) as
      Row | undefined;
    if (
      !r ||
      text(r, "session_id") !== i.sessionId ||
      text(r, "role") !== i.role ||
      text(r, "content") !== i.content ||
      num(r, "created_at") !== i.createdAt
    )
      throw new Error(`Message id conflict: ${i.id}`);
    return this.mm(r);
  }
  getMessages(id: string, o: { includeAncestors?: boolean } = {}) {
    if (!o.includeAncestors)
      return (
        this.db
          .prepare(
            "SELECT * FROM messages WHERE session_id=? ORDER BY sequence",
          )
          .all(id) as Row[]
      ).map((r) => this.mm(r));
    const seen = new Set<string>(),
      line: Session[] = [];
    let s = this.getSession(id);
    while (s) {
      if (seen.has(s.id)) throw new Error("Session lineage cycle");
      seen.add(s.id);
      line.unshift(s);
      s = s.parentSessionId ? this.getSession(s.parentSessionId) : undefined;
    }
    const out: Message[] = [];
    line.forEach((x, n) => {
      const rows = this.getMessages(x.id),
        cut = line[n + 1]?.parentMessageId;
      if (cut) {
        const p = rows.findIndex((m) => m.id === cut);
        if (p < 0) throw new Error("Missing branch point");
        out.push(...rows.slice(0, p + 1));
      } else out.push(...rows);
    });
    return out;
  }
  createRun(i: {
    id: string;
    sessionId: string;
    status: RunStatus;
    startedAt: number;
  }) {
    this.db
      .prepare(
        "INSERT INTO runs(id,session_id,status,started_at)VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(i.id, i.sessionId, i.status, i.startedAt);
    const r = this.getRun(i.id);
    if (
      !r ||
      r.sessionId !== i.sessionId ||
      r.status !== i.status ||
      r.startedAt !== i.startedAt
    )
      throw new Error(`Run id conflict: ${i.id}`);
    return r;
  }
  finishRun(
    id: string,
    i: { status: Exclude<RunStatus, "running">; finishedAt: number },
  ) {
    const old = this.getRun(id);
    if (!old) throw new Error(`Unknown run: ${id}`);
    if (old.finishedAt !== undefined) {
      if (old.status !== i.status || old.finishedAt !== i.finishedAt)
        throw new Error(`Run completion conflict: ${id}`);
      return old;
    }
    this.db
      .prepare(
        "UPDATE runs SET status=?,finished_at=? WHERE id=? AND finished_at IS NULL",
      )
      .run(i.status, i.finishedAt, id);
    return this.getRun(id)!;
  }
  getRun(id: string) {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as
      Row | undefined;
    return r
      ? {
          id: text(r, "id"),
          sessionId: text(r, "session_id"),
          status: text(r, "status") as RunStatus,
          startedAt: num(r, "started_at"),
          ...(r.finished_at === null
            ? {}
            : { finishedAt: num(r, "finished_at") }),
        }
      : undefined;
  }
  listUnfinishedRuns() {
    return (
      this.db
        .prepare(
          "SELECT * FROM runs WHERE finished_at IS NULL ORDER BY started_at",
        )
        .all() as Row[]
    ).map((r) => this.getRun(text(r, "id"))!);
  }
  getRecoveryState(id: string) {
    const run = this.getRun(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return {
      run,
      session: this.getSession(run.sessionId)!,
      messages: this.getMessages(run.sessionId, { includeAncestors: true }),
    };
  }
  recordFinancialEvidence(i: {
    id: string;
    payload: unknown;
    createdAt: number;
  }) {
    const p = canonical(i.payload),
      sha256 = createHash("sha256").update(p).digest("hex");
    this.db
      .prepare(
        "INSERT INTO financial_evidence VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(i.id, p, sha256, i.createdAt);
    const r = this.db
      .prepare("SELECT * FROM financial_evidence WHERE id=?")
      .get(i.id) as Row | undefined;
    if (
      !r ||
      text(r, "payload_json") !== p ||
      num(r, "created_at") !== i.createdAt
    )
      throw new Error(`Evidence id conflict: ${i.id}`);
    return { id: i.id, payload: parse(p), sha256, createdAt: i.createdAt };
  }
  recordToolCall(i: ToolCall) {
    const a = canonical(i.arguments);
    this.db
      .prepare(
        "INSERT INTO tool_calls VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(i.id, i.sessionId, i.messageId, i.toolName, a, i.createdAt);
    const c = this.getToolExchange(i.id)?.call;
    if (
      !c ||
      c.sessionId !== i.sessionId ||
      c.messageId !== i.messageId ||
      c.toolName !== i.toolName ||
      canonical(c.arguments) !== a ||
      c.createdAt !== i.createdAt
    )
      throw new Error(`Tool call id conflict: ${i.id}`);
    return c;
  }
  recordToolResult(i: ToolResult) {
    const o = canonical(i.output);
    this.db
      .prepare(
        "INSERT INTO tool_results VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(i.id, i.toolCallId, o, i.createdAt, i.evidenceRef ?? null);
    const r = this.getToolExchange(i.toolCallId)?.result;
    if (
      !r ||
      r.id !== i.id ||
      canonical(r.output) !== o ||
      r.createdAt !== i.createdAt ||
      r.evidenceRef !== i.evidenceRef
    )
      throw new Error(`Tool result conflict: ${i.toolCallId}`);
    return r;
  }
  getToolExchange(id: string) {
    const r = this.db
      .prepare(
        "SELECT c.*,r.id rid,r.output_json,r.created_at rat,r.evidence_ref FROM tool_calls c LEFT JOIN tool_results r ON r.tool_call_id=c.id WHERE c.id=?",
      )
      .get(id) as Row | undefined;
    if (!r) return undefined;
    const call: ToolCall = {
      id: text(r, "id"),
      sessionId: text(r, "session_id"),
      messageId: text(r, "message_id"),
      toolName: text(r, "tool_name"),
      arguments: parse(text(r, "arguments_json")),
      createdAt: num(r, "created_at"),
    };
    return {
      call,
      ...(r.rid === null
        ? {}
        : {
            result: {
              id: text(r, "rid"),
              toolCallId: id,
              output: parse(text(r, "output_json")),
              createdAt: num(r, "rat"),
              ...(r.evidence_ref === null
                ? {}
                : { evidenceRef: text(r, "evidence_ref") }),
            },
          }),
    };
  }
  transaction<T>(fn: (s: SessionStore) => T): T {
    const n = this.depth++;
    const sp = `nested_${n}`;
    this.db.exec(n ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
    try {
      const v = fn(this);
      if (obj(v) && typeof (v as { then?: unknown }).then === "function")
        throw new Error("Async transactions are not supported");
      this.db.exec(n ? `RELEASE ${sp}` : "COMMIT");
      return v;
    } catch (e) {
      try {
        this.db.exec(n ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
      } catch {}
      throw e;
    } finally {
      this.depth--;
    }
  }
  search(
    q: string,
    o: {
      sessionId?: string;
      contextBefore?: number;
      contextAfter?: number;
      limit?: number;
    } = {},
  ) {
    const before = Math.max(0, o.contextBefore ?? 0),
      after = Math.max(0, o.contextAfter ?? 0),
      limit = Math.max(0, o.limit ?? 20);
    let rows: Row[];
    try {
      rows = (
        o.sessionId
          ? this.db
              .prepare(
                "SELECT m.* FROM messages_fts f JOIN messages m ON m.sequence=f.rowid WHERE messages_fts MATCH ? AND m.session_id=? LIMIT ?",
              )
              .all(q, o.sessionId, limit)
          : this.db
              .prepare(
                "SELECT m.* FROM messages_fts f JOIN messages m ON m.sequence=f.rowid WHERE messages_fts MATCH ? LIMIT ?",
              )
              .all(q, limit)
      ) as Row[];
    } catch {
      throw new Error("Invalid search query");
    }
    return rows.map((r) => {
      const message = this.mm(r),
        all = this.getMessages(message.sessionId, { includeAncestors: true }),
        i = all.findIndex((m) => m.id === message.id);
      return {
        message,
        context: all.slice(Math.max(0, i - before), i + after + 1),
      };
    });
  }
}
