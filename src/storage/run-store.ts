import { DatabaseSync } from "node:sqlite";
export type DurableEvent = { id: number; type: string; data: unknown };
export type DurableRun = {
  id: string;
  tenantId: string;
  subject?: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  events: DurableEvent[];
};
export class DurableRunStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private retention = 100,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS idempotency(tenant_id TEXT NOT NULL,key TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),PRIMARY KEY(tenant_id,key)); CREATE TABLE IF NOT EXISTS run_events(run_id TEXT NOT NULL REFERENCES runs(id),sequence INTEGER NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(run_id,sequence));`,
    );
  }
  create(r: DurableRun, key?: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?)")
      .run(r.id, r.tenantId, r.sessionId, r.status, r.createdAt);
    if (key)
      this.db
        .prepare("INSERT OR IGNORE INTO idempotency VALUES(?,?,?)")
        .run(r.tenantId, key, r.id);
    for (const e of r.events)
      this.db
        .prepare("INSERT OR IGNORE INTO run_events VALUES(?,?,?,?)")
        .run(r.id, e.id, e.type, JSON.stringify(e.data));
    return this.get(r.id, r.tenantId)!;
  }
  idempotent(tenant: string, key: string) {
    const row = this.db
      .prepare("SELECT run_id FROM idempotency WHERE tenant_id=? AND key=?")
      .get(tenant, key) as any;
    return row ? this.get(String(row.run_id), tenant) : undefined;
  }
  get(id: string, tenant: string): DurableRun | undefined {
    const r = this.db
      .prepare("SELECT * FROM runs WHERE id=? AND tenant_id=?")
      .get(id, tenant) as any;
    if (!r) return;
    const events = (
      this.db
        .prepare("SELECT * FROM run_events WHERE run_id=? ORDER BY sequence")
        .all(id) as any[]
    ).map((x) => ({
      id: Number(x.sequence),
      type: String(x.type),
      data: JSON.parse(String(x.data_json)),
    }));
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      sessionId: String(r.session_id),
      status: r.status,
      createdAt: Number(r.created_at),
      events,
    };
  }
  emit(id: string, type: string, data: unknown) {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 n FROM run_events WHERE run_id=?",
      )
      .get(id) as any;
    const n = Number(row.n);
    this.db
      .prepare("INSERT INTO run_events VALUES(?,?,?,?)")
      .run(id, n, type, JSON.stringify(data));
    this.db
      .prepare(
        "DELETE FROM run_events WHERE run_id=? AND sequence <= (SELECT MAX(sequence)-? FROM run_events WHERE run_id=?)",
      )
      .run(id, this.retention, id);
    return { id: n, type, data };
  }
  active(tenant: string) {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM runs WHERE tenant_id=? AND status='running'",
          )
          .get(tenant) as any
      ).n,
    );
  }
  setStatus(id: string, status: DurableRun["status"]) {
    this.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, id);
  }
  close() {
    this.db.close();
  }
}
