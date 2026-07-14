import { DatabaseSync } from "node:sqlite";
const enc = (_k: string, v: unknown) =>
    typeof v === "bigint" ? { $bigint: v.toString() } : v,
  dec = (_k: string, v: any) =>
    v && v.$bigint !== undefined ? BigInt(v.$bigint) : v;
export class NoxaIndexStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),number TEXT NOT NULL,hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS blocks(number TEXT PRIMARY KEY,hash TEXT NOT NULL,parent_hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS launches(id TEXT PRIMARY KEY,block_number TEXT NOT NULL,block_hash TEXT NOT NULL,data TEXT NOT NULL,canonical INTEGER NOT NULL DEFAULT 1,verified INTEGER NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS leader(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,token INTEGER NOT NULL DEFAULT 0,expires INTEGER);`,
    );
  }
  checkpoint() {
    const r = this.db
      .prepare("SELECT * FROM checkpoint WHERE id=1")
      .get() as any;
    return r ? { number: BigInt(r.number), hash: r.hash } : undefined;
  }
  launches(canonical = true) {
    return (
      this.db
        .prepare(
          "SELECT data FROM launches WHERE canonical=? ORDER BY CAST(block_number AS INTEGER)",
        )
        .all(canonical ? 1 : 0) as any[]
    ).map((r) => JSON.parse(r.data, dec));
  }
  commit(block: any, launches: any[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO blocks VALUES(?,?,?)")
        .run(String(block.number), block.hash, block.parentHash);
      for (const l of launches)
        this.db
          .prepare("INSERT OR IGNORE INTO launches VALUES(?,?,?,?,1,?,?)")
          .run(
            l.id,
            String(l.blockNumber),
            l.blockHash,
            JSON.stringify(l, enc),
            l.verified ? 1 : 0,
            Date.now(),
          );
      this.db
        .prepare(
          "INSERT INTO checkpoint VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET number=excluded.number,hash=excluded.hash",
        )
        .run(String(block.number), block.hash);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  rollback(after: bigint) {
    const rows = this.db
      .prepare(
        "SELECT data FROM launches WHERE CAST(block_number AS INTEGER)>? AND canonical=1",
      )
      .all(Number(after)) as any[];
    this.db
      .prepare(
        "UPDATE launches SET canonical=0 WHERE CAST(block_number AS INTEGER)>?",
      )
      .run(Number(after));
    const b = this.db
      .prepare("SELECT * FROM blocks WHERE CAST(number AS INTEGER)=?")
      .get(Number(after)) as any;
    if (b)
      this.db
        .prepare("INSERT OR REPLACE INTO checkpoint VALUES(1,?,?)")
        .run(String(after), b.hash);
    return rows.map((r) => JSON.parse(r.data, dec));
  }
  acquire(owner: string, now: number, ms: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare("SELECT * FROM leader WHERE id=1").get() as any;
      if (r && r.expires > now && r.owner !== owner) {
        this.db.exec("COMMIT");
        return 0;
      }
      const token = (r?.token ?? 0) + 1;
      this.db
        .prepare("INSERT OR REPLACE INTO leader VALUES(1,?,?,?)")
        .run(owner, token, now + ms);
      this.db.exec("COMMIT");
      return token;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
