import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type MemoryNamespace = "user" | "agent";
export interface Provenance { readonly source: string }
export interface MemoryEntry { readonly id: string; readonly namespace: MemoryNamespace; readonly value: string; readonly normalizedValue: string; readonly provenance: Provenance; readonly createdAt: number; readonly updatedAt: number }
export type MemoryOperation =
  | { type: "add"; entry: { namespace: MemoryNamespace; value: string; provenance: Provenance } }
  | { type: "replace"; id: string; entry: { namespace: MemoryNamespace; value: string; provenance: Provenance } }
  | { type: "remove"; id: string; namespace?: MemoryNamespace };
export interface MemorySnapshot { readonly sessionId: string; readonly revision: number; readonly createdAt: number; readonly entries: readonly MemoryEntry[] }
export interface MemoryStoreOptions { now?: () => number; byteBudgets?: Partial<Record<MemoryNamespace, number>>; snapshotRetention?: number }
type ErrorCode = "REVISION_CONFLICT" | "SECRET_DETECTED" | "DUPLICATE" | "BUDGET_EXCEEDED" | "INVALID_OPERATION" | "CORRUPT_DATA";

export class MemoryStoreError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = "MemoryStoreError"; }
}

const MAX_VALUE_BYTES = 64 * 1024, MAX_SOURCE_BYTES = 1024, MAX_SESSION_BYTES = 256;
const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").normalize("NFKC");
const secretPatterns: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
  /\b(?:api[_-]?key|secret|password|passwd|private[_-]?key)\s*[:=]\s*\S+/iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/iu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/iu,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu,
];
const invalid = (message: string): never => { throw new MemoryStoreError("INVALID_OPERATION", message); };
const corrupt = (): never => { throw new MemoryStoreError("CORRUPT_DATA", "Corrupt durable memory data"); };
const safeInteger = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const deepFreezeEntry = (e: MemoryEntry): MemoryEntry => Object.freeze({ ...e, provenance: Object.freeze({ ...e.provenance }) });

function rowEntry(r: Record<string, unknown>): MemoryEntry {
  try {
    const provenance: unknown = JSON.parse(String(r.provenance_json));
    if (typeof r.id !== "string" || (r.namespace !== "user" && r.namespace !== "agent") || typeof r.value !== "string" || typeof r.normalized_value !== "string" ||
        !provenance || typeof provenance !== "object" || Object.keys(provenance).length !== 1 || typeof (provenance as Record<string, unknown>).source !== "string" ||
        !safeInteger(r.created_at) || !safeInteger(r.updated_at)) corrupt();
    return deepFreezeEntry({ id: r.id as string, namespace: r.namespace as MemoryNamespace, value: r.value as string, normalizedValue: r.normalized_value as string,
      provenance: { source: (provenance as Provenance).source }, createdAt: r.created_at as number, updatedAt: r.updated_at as number });
  } catch (error) { if (error instanceof MemoryStoreError) throw error; return corrupt(); }
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly budgets: Record<MemoryNamespace, number>;
  private readonly retention: number;
  constructor(path: string, options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.budgets = { user: options.byteBudgets?.user ?? 64 * 1024, agent: options.byteBudgets?.agent ?? 64 * 1024 };
    this.retention = options.snapshotRetention ?? 100;
    for (const budget of Object.values(this.budgets)) if (!safeInteger(budget)) throw new MemoryStoreError("INVALID_OPERATION", "Memory budget must be a finite nonnegative safe integer");
    if (!safeInteger(this.retention)) throw new MemoryStoreError("INVALID_OPERATION", "Snapshot retention must be a finite nonnegative safe integer");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS memory_meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO memory_meta VALUES(1,0); CREATE TABLE IF NOT EXISTS curated_memory(id TEXT PRIMARY KEY, namespace TEXT NOT NULL CHECK(namespace IN('user','agent')), value TEXT NOT NULL, normalized_value TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(namespace,normalized_value)); CREATE TABLE IF NOT EXISTS memory_snapshots(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, entries_json TEXT NOT NULL); COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  revision(): number { const n = (this.db.prepare("SELECT revision FROM memory_meta WHERE id=1").get() as Record<string, unknown> | undefined)?.revision; if (!safeInteger(n)) return corrupt(); return n as number; }
  list(namespace?: MemoryNamespace): MemoryEntry[] {
    if (namespace !== undefined && namespace !== "user" && namespace !== "agent") invalid("Invalid memory namespace");
    const rows = (namespace ? this.db.prepare("SELECT * FROM curated_memory WHERE namespace=? ORDER BY rowid").all(namespace) : this.db.prepare("SELECT * FROM curated_memory ORDER BY rowid").all()) as Record<string, unknown>[];
    return Object.freeze(rows.map(rowEntry)) as unknown as MemoryEntry[];
  }
  forNamespace(namespace: MemoryNamespace) {
    if (namespace !== "user" && namespace !== "agent") invalid("Invalid memory namespace");
    return Object.freeze({
      list: () => this.list(namespace),
      applyBatch: (expectedRevision: number, operations: readonly ({ type: "add"; value: string; provenance: Provenance } | { type: "replace"; id: string; value: string; provenance: Provenance } | { type: "remove"; id: string })[]) =>
        this.applyBatch(expectedRevision, operations.map(op => op.type === "remove" ? { ...op, namespace } : { type: op.type, ...(op.type === "replace" ? { id: op.id } : {}), entry: { namespace, value: op.value, provenance: op.provenance } } as MemoryOperation)),
    });
  }
  private validate(entry: { namespace: MemoryNamespace; value: string; provenance: Provenance }) {
    if ((entry.namespace as string) === "policy") invalid("Policy memory namespace is forbidden");
    if (entry.namespace !== "user" && entry.namespace !== "agent") invalid("Invalid memory namespace");
    if (typeof entry.value !== "string" || Buffer.byteLength(entry.value, "utf8") > MAX_VALUE_BYTES) invalid("Memory value is invalid or too large");
    if (!entry.provenance || typeof entry.provenance.source !== "string" || Buffer.byteLength(entry.provenance.source, "utf8") > MAX_SOURCE_BYTES) invalid("Memory provenance is invalid or too large");
    const value = normalize(entry.value), source = normalize(entry.provenance.source);
    if (!value) invalid("Memory value is empty"); if (!source) invalid("Memory provenance is required");
    if (secretPatterns.some(pattern => pattern.test(value) || pattern.test(source))) throw new MemoryStoreError("SECRET_DETECTED", "Potential secret or credential detected by defense-in-depth scanning; memory was not stored");
    return { value, normalized: value.toLocaleLowerCase("en-US").normalize("NFKC"), provenance: { source } };
  }
  applyBatch(expectedRevision: number, operations: readonly MemoryOperation[]): { revision: number; entries: MemoryEntry[] } {
    if (!safeInteger(expectedRevision)) invalid("Expected revision must be a nonnegative safe integer");
    if (!Array.isArray(operations) || !operations.length) invalid("Empty memory batch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.revision() !== expectedRevision) throw new MemoryStoreError("REVISION_CONFLICT", "Memory revision conflict");
      for (const operation of operations) {
        if (operation.type === "remove") {
          const result = operation.namespace ? this.db.prepare("DELETE FROM curated_memory WHERE id=? AND namespace=?").run(operation.id, operation.namespace) : this.db.prepare("DELETE FROM curated_memory WHERE id=?").run(operation.id);
          if (result.changes !== 1) invalid(`Unknown memory entry: ${operation.id}`); continue;
        }
        const clean = this.validate(operation.entry); const at = this.now(); if (!safeInteger(at)) invalid("Memory timestamp must be a nonnegative safe integer");
        try {
          if (operation.type === "add") this.db.prepare("INSERT INTO curated_memory VALUES(?,?,?,?,?,?,?)").run(randomUUID(), operation.entry.namespace, clean.value, clean.normalized, JSON.stringify(clean.provenance), at, at);
          else {
            const current = this.db.prepare("SELECT namespace FROM curated_memory WHERE id=?").get(operation.id) as { namespace?: unknown } | undefined;
            if (!current) invalid(`Unknown memory entry: ${operation.id}`); if (current!.namespace !== operation.entry.namespace) invalid("Cross-namespace replacement is forbidden");
            this.db.prepare("UPDATE curated_memory SET value=?,normalized_value=?,provenance_json=?,updated_at=? WHERE id=?").run(clean.value, clean.normalized, JSON.stringify(clean.provenance), at, operation.id);
          }
        } catch (error) {
          if (error instanceof MemoryStoreError) throw error;
          const sqlite = error as { code?: string; errcode?: number; errstr?: string };
          if (sqlite.code === "ERR_SQLITE_ERROR" && sqlite.errcode === 2067) throw new MemoryStoreError("DUPLICATE", "Duplicate normalized memory entry");
          throw error;
        }
      }
      for (const namespace of ["user", "agent"] as const) {
        const bytes = this.list(namespace).reduce((sum, e) => sum + Buffer.byteLength(e.id + e.namespace + e.value + e.normalizedValue + JSON.stringify(e.provenance), "utf8") + 16, 0);
        if (bytes > this.budgets[namespace]) throw new MemoryStoreError("BUDGET_EXCEEDED", `${namespace} memory byte budget exceeded`);
      }
      const revision = expectedRevision + 1; this.db.prepare("UPDATE memory_meta SET revision=? WHERE id=1").run(revision); this.db.exec("COMMIT");
      return Object.freeze({ revision, entries: this.list() });
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  private validateSessionId(id: string) { if (typeof id !== "string" || !id.trim() || Buffer.byteLength(id, "utf8") > MAX_SESSION_BYTES || id !== id.normalize("NFKC")) invalid("Session ID is invalid, non-canonical, or too large"); }
  startSession(sessionId: string): MemorySnapshot {
    this.validateSessionId(sessionId); this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getSessionSnapshot(sessionId); if (existing) { this.db.exec("COMMIT"); return existing; }
      const at = this.now(); if (!safeInteger(at)) invalid("Snapshot timestamp must be a nonnegative safe integer");
      const revision = this.revision(), entries = this.list();
      this.db.prepare("INSERT INTO memory_snapshots VALUES(?,?,?,?)").run(sessionId, revision, at, JSON.stringify(entries));
      this.db.prepare("DELETE FROM memory_snapshots WHERE session_id IN (SELECT session_id FROM memory_snapshots ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)").run(this.retention);
      this.db.exec("COMMIT"); return this.getSessionSnapshot(sessionId) ?? invalid("Snapshot was removed by retention policy");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  getSessionSnapshot(sessionId: string): MemorySnapshot | undefined {
    this.validateSessionId(sessionId); const row = this.db.prepare("SELECT * FROM memory_snapshots WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined; if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(String(row.entries_json)); if (!Array.isArray(parsed) || !safeInteger(row.revision) || !safeInteger(row.created_at)) return corrupt();
      const entries = Object.freeze(parsed.map(e => {
        if (!e || typeof e !== "object") return corrupt(); const x = e as Record<string, unknown>;
        return rowEntry({ id: x.id, namespace: x.namespace, value: x.value, normalized_value: x.normalizedValue, provenance_json: JSON.stringify(x.provenance), created_at: x.createdAt, updated_at: x.updatedAt });
      }));
      return Object.freeze({ sessionId, revision: row.revision as number, createdAt: row.created_at as number, entries });
    } catch (error) { if (error instanceof MemoryStoreError) throw error; return corrupt(); }
  }
  listSessionSnapshots(): MemorySnapshot[] { return Object.freeze((this.db.prepare("SELECT session_id FROM memory_snapshots ORDER BY created_at,rowid").all() as { session_id: string }[]).map(r => this.getSessionSnapshot(r.session_id)!)) as unknown as MemorySnapshot[]; }
  deleteSessionSnapshot(sessionId: string): boolean { this.validateSessionId(sessionId); return this.db.prepare("DELETE FROM memory_snapshots WHERE session_id=?").run(sessionId).changes === 1; }
}
