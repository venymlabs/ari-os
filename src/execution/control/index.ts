import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface PolicyDocument {
  version: string;
  effectiveAt: bigint;
  expiresAt: bigint;
  allow: {
    chains: bigint[];
    accounts: string[];
    tokens: string[];
    routers: string[];
    targets: string[];
    selectors: string[];
    recipients: string[];
  };
  limits: {
    perTrade: bigint;
    assetHourly: bigint;
    assetDaily: bigint;
    strategyHourly: bigint;
    strategyDaily: bigint;
    totalExposure: bigint;
    assetExposure: bigint;
    concentrationBps: bigint;
    drawdown: bigint;
    totalLoss: bigint;
  };
  market: {
    maxQuoteAge: bigint;
    maxSlippageBps: bigint;
    maxImpactBps: bigint;
    maxGas: bigint;
    maxFees: bigint;
    minLiquidity: bigint;
    maxTaxBps: bigint;
    allowProxy: boolean;
    maxOracleAge: bigint;
    requireSequencerUp: boolean;
  };
  approvalClass: "exact";
  deadManAfter: bigint;
  globalKill: boolean;
  strategyKills: string[];
}
export interface SignedPolicyReference {
  policyHash: string;
  signature: string;
  keyId?: string;
}
export type PolicyVerifier = (
  reference: SignedPolicyReference,
  expectedHash: string,
) => boolean;
export interface TradeRequest {
  id: string;
  now: bigint;
  chain: bigint;
  account: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  target: string;
  selector: string;
  recipient: string;
  strategy: string;
  amount: bigint;
  approvalAmount: bigint;
  quoteAt: bigint;
  slippageBps: bigint;
  impactBps: bigint;
  gas: bigint;
  fees: bigint;
  liquidity: bigint;
  taxBps: bigint;
  isProxy: boolean;
  oracleAt: bigint;
  sequencerUp: boolean;
  portfolioExposure: bigint;
  assetExposure: bigint;
  portfolioValue: bigint;
  peakValue: bigint;
  realizedLoss: bigint;
  unrealizedLoss: bigint;
  lastHeartbeat: bigint;
}
export interface LedgerEntry {
  id: string;
  at: bigint;
  asset: string;
  strategy: string;
  amount: bigint;
}
export interface ProductionRiskLimits {
  chains: bigint[];
  accounts: string[];
  routers: string[];
  tokens: string[];
  maxPerTrade: Record<string, bigint>;
  maxReservedPerToken: Record<string, bigint>;
  maxReservedAggregate?: bigint;
  maxSlippageBps: bigint;
  maxQuoteAge: bigint;
  maxQuoteBlocks: bigint;
  nativeGasReserve: bigint;
  maxDailyNotional?: bigint;
}
export interface ProductionRiskInput {
  now: bigint;
  chain: bigint;
  account: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: bigint;
  quoteAt: bigint;
  quoteBlock: bigint;
  currentBlock: bigint;
  quoteBlockHash: string;
  canonicalBlockHash: string;
  tokenBalance: bigint;
  nativeBalance: bigint;
  estimatedGasCost: bigint;
  notional?: bigint;
  dailyNotional?: bigint;
}
export class ProductionRiskEvaluator {
  constructor(readonly limits: ProductionRiskLimits) {}
  evaluate(x: ProductionRiskInput, entries: readonly LedgerEntry[]) {
    const l = this.limits,
      r: string[] = [],
      bad = (v: boolean, s: string) => {
        if (v) r.push(s);
      };
    bad(!l.chains.includes(x.chain), "chain_not_allowed");
    bad(!l.accounts.includes(x.account), "account_not_allowed");
    bad(!l.routers.includes(x.router), "router_not_allowed");
    bad(
      !l.tokens.includes(x.tokenIn) || !l.tokens.includes(x.tokenOut),
      "token_not_allowed",
    );
    const per = l.maxPerTrade[x.tokenIn],
      cap = l.maxReservedPerToken[x.tokenIn];
    bad(per === undefined, "per_trade_unit_unconfigured");
    bad(cap === undefined, "token_exposure_unit_unconfigured");
    if (per !== undefined) bad(x.amountIn > per, "per_trade_limit_exceeded");
    bad(x.amountIn <= 0n, "invalid_amount");
    bad(x.slippageBps > l.maxSlippageBps, "slippage_exceeded");
    bad(x.quoteAt > x.now || x.now - x.quoteAt > l.maxQuoteAge, "quote_stale");
    bad(
      x.quoteBlock > x.currentBlock ||
        x.currentBlock - x.quoteBlock > l.maxQuoteBlocks,
      "quote_block_stale",
    );
    bad(
      !x.quoteBlockHash || x.quoteBlockHash !== x.canonicalBlockHash,
      "quote_noncanonical",
    );
    bad(x.tokenBalance < x.amountIn, "insufficient_token_balance");
    bad(
      x.nativeBalance < x.estimatedGasCost + l.nativeGasReserve,
      "insufficient_gas_reserve",
    );
    const token = entries
      .filter((e) => e.asset === x.tokenIn)
      .reduce((n, e) => n + e.amount, 0n);
    if (cap !== undefined)
      bad(token + x.amountIn > cap, "token_reserved_exposure_exceeded");
    /* Aggregate native units are intentionally not evaluated here: different assets are incomparable without normalized valuation evidence. */ if (
      l.maxDailyNotional !== undefined
    ) {
      bad(
        x.notional === undefined || x.dailyNotional === undefined,
        "notional_unavailable",
      );
      if (x.notional !== undefined && x.dailyNotional !== undefined)
        bad(
          x.notional + x.dailyNotional > l.maxDailyNotional,
          "daily_notional_exceeded",
        );
    }
    return { allowed: r.length === 0, reasons: r };
  }
}
type Internal = LedgerEntry & { state: "reserved" | "committed" };
const plain = (v: unknown) =>
  v !== null &&
  typeof v === "object" &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
function canonical(v: unknown, seen = new Set<object>()): string {
  if (typeof v === "bigint") return `{"$bigint":"${v}"}`;
  if (["undefined", "function", "symbol", "number"].includes(typeof v))
    throw Error("unsupported canonical value");
  if (Array.isArray(v))
    return `[${v.map((x) => canonical(x, seen)).join(",")}]`;
  if (plain(v)) {
    if (seen.has(v as object)) throw Error("cyclic value");
    seen.add(v as object);
    const s = `{${Object.keys(v as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k], seen)}`,
      )
      .join(",")}}`;
    seen.delete(v as object);
    return s;
  }
  if (v === null || typeof v === "string" || typeof v === "boolean")
    return JSON.stringify(v);
  throw Error("unsupported canonical value");
}
function validatePolicy(p: PolicyDocument) {
  if (p.version !== "1" || p.effectiveAt < 0n || p.expiresAt <= p.effectiveAt)
    throw Error("invalid policy");
  const lists = [
    p.allow.chains,
    ...Object.values(p.allow)
      .filter(Array.isArray)
      .filter((x) => x !== p.allow.chains),
  ] as unknown[][];
  for (const x of lists)
    if (
      !x.length ||
      new Set(x).size !== x.length ||
      x.some((y) => typeof y === "string" && !y)
    )
      throw Error("invalid allowlist");
  const nums = [
    ...Object.values(p.limits),
    ...Object.entries(p.market)
      .filter(([, v]) => typeof v === "bigint")
      .map(([, v]) => v as bigint),
    p.deadManAfter,
  ];
  if (
    nums.some((x) => x < 0n) ||
    p.limits.concentrationBps > 10000n ||
    p.market.maxSlippageBps > 10000n ||
    p.market.maxImpactBps > 10000n ||
    p.market.maxTaxBps > 10000n
  )
    throw Error("invalid policy limits");
  Object.freeze(p);
}
export const canonicalPolicy = (p: PolicyDocument) => {
  validatePolicy(p);
  return `TRADING_POLICY_V1:${canonical(p)}`;
};
export const policyHash = (p: PolicyDocument) =>
  createHash("sha256").update(canonicalPolicy(p)).digest("hex");

export class ReservationLedger {
  private db: DatabaseSync;
  private now: () => bigint;
  private ttl: bigint;
  private closed = false;
  private aggregateQuote:
    { denomination: string; decimals: number } | undefined;
  constructor(
    path = ":memory:",
    o: {
      now?: () => bigint;
      reservationTtl?: bigint;
      aggregateQuote?: { denomination: string; decimals: number };
    } = {},
  ) {
    this.db = new DatabaseSync(path);
    this.now = o.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.ttl = o.reservationTtl ?? 3600n;
    if (
      o.aggregateQuote &&
      (!o.aggregateQuote.denomination ||
        !Number.isInteger(o.aggregateQuote.decimals) ||
        o.aggregateQuote.decimals < 0 ||
        o.aggregateQuote.decimals > 30)
    )
      throw Error("invalid aggregate quote denomination");
    this.aggregateQuote = o.aggregateQuote;
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,at TEXT NOT NULL,asset TEXT NOT NULL,strategy TEXT NOT NULL,amount TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','committed')),expires_at TEXT NOT NULL,quote_denomination TEXT,quote_decimals INTEGER,quote_value TEXT,valuation_evidence TEXT); CREATE TABLE IF NOT EXISTS ledger_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);",
    );
    for (const [name, type] of [
      ["quote_denomination", "TEXT"],
      ["quote_decimals", "INTEGER"],
      ["quote_value", "TEXT"],
      ["valuation_evidence", "TEXT"],
    ])
      try {
        this.db.exec(`ALTER TABLE reservations ADD COLUMN ${name} ${type}`);
      } catch {}
  }
  transaction<T>(f: () => T) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const x = f();
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private expire(now: bigint) {
    this.db
      .prepare(
        "DELETE FROM reservations WHERE state='reserved' AND CAST(expires_at AS INTEGER)<=?",
      )
      .run(now);
  }
  has(id: string) {
    return !!this.db.prepare("SELECT 1 FROM reservations WHERE id=?").get(id);
  }
  reserve(e: LedgerEntry) {
    if (!e.id || e.at < 0n || e.amount <= 0n) return false;
    try {
      this.db
        .prepare(
          "INSERT INTO reservations(id,at,asset,strategy,amount,state,expires_at) VALUES(?,?,?,?,?,'reserved',?)",
        )
        .run(e.id, e.at, e.asset, e.strategy, e.amount, e.at + this.ttl);
      return true;
    } catch {
      return false;
    }
  }
  reserveWithin(
    e: LedgerEntry,
    l: {
      perAsset: bigint;
      aggregate?:
        | bigint
        | {
            denomination: string;
            decimals: number;
            max: bigint;
            value: bigint;
            evidence: string;
          };
    },
  ) {
    if (!e.id || e.at < 0n || e.amount <= 0n || l.perAsset < 0n) return false;
    const q = typeof l.aggregate === "object" ? l.aggregate : undefined;
    if (
      q &&
      (!q.denomination ||
        !Number.isInteger(q.decimals) ||
        q.decimals < 0 ||
        q.decimals > 30 ||
        q.max < 0n ||
        q.value <= 0n ||
        !q.evidence)
    )
      return false;
    if (
      q &&
      this.aggregateQuote &&
      (q.denomination !== this.aggregateQuote.denomination ||
        q.decimals !== this.aggregateQuote.decimals)
    )
      return false;
    try {
      return this.transaction(() => {
        this.expire(e.at);
        const asset = (
          this.db
            .prepare("SELECT amount FROM reservations WHERE asset=?")
            .all(e.asset) as any[]
        ).reduce((n, x) => n + BigInt(x.amount), 0n);
        if (asset + e.amount > l.perAsset) return false;
        if (typeof l.aggregate === "bigint" && asset + e.amount > l.aggregate)
          return false;
        if (q) {
          const rows = this.db
            .prepare(
              "SELECT quote_denomination,quote_decimals,quote_value,valuation_evidence FROM reservations",
            )
            .all() as any[];
          if (
            rows.some(
              (x) =>
                x.quote_denomination === null ||
                x.quote_decimals === null ||
                x.quote_value === null ||
                x.valuation_evidence === null ||
                x.valuation_evidence === "" ||
                x.quote_denomination !== q.denomination ||
                x.quote_decimals !== q.decimals,
            )
          )
            return false;
          if (
            rows.reduce((n, x) => n + BigInt(x.quote_value), 0n) + q.value >
            q.max
          )
            return false;
        }
        return (
          this.db
            .prepare(
              "INSERT INTO reservations(id,at,asset,strategy,amount,state,expires_at,quote_denomination,quote_decimals,quote_value,valuation_evidence) VALUES(?,?,?,?,?,'reserved',?,?,?,?,?)",
            )
            .run(
              e.id,
              e.at,
              e.asset,
              e.strategy,
              e.amount,
              e.at + this.ttl,
              q?.denomination ?? null,
              q?.decimals ?? null,
              q?.value ?? null,
              q?.evidence ?? null,
            ).changes !== 0
        );
      });
    } catch {
      return false;
    }
  }
  release(id: string) {
    return (
      this.db
        .prepare("DELETE FROM reservations WHERE id=? AND state='reserved'")
        .run(id).changes === 1n
    );
  }
  commit(id: string, _at?: bigint) {
    const at = this.now();
    return (
      this.db
        .prepare(
          "UPDATE reservations SET state='committed',at=?,expires_at=? WHERE id=? AND state='reserved'",
        )
        .run(at, at, id).changes === 1n ||
      !!this.db
        .prepare("SELECT 1 FROM reservations WHERE id=? AND state='committed'")
        .get(id)
    );
  }
  entries(now: bigint) {
    this.expire(now);
    return (
      this.db
        .prepare("SELECT id,at,asset,strategy,amount,state FROM reservations")
        .all() as any[]
    ).map(
      (r) => ({ ...r, at: BigInt(r.at), amount: BigInt(r.amount) }) as Internal,
    );
  }
  usage(now: bigint, w: bigint, p: (e: LedgerEntry) => boolean) {
    return this.entries(now)
      .filter((e) => e.at > now - w && e.at <= now && p(e))
      .reduce((n, e) => n + e.amount, 0n);
  }
  reconcile(es: LedgerEntry[], now = this.now()) {
    if (
      es.some((e) => !e.id || e.at < 0n || e.at > now || e.amount <= 0n) ||
      new Set(es.map((e) => e.id)).size !== es.length
    )
      throw Error("invalid snapshot");
    const local = this.entries(now).filter((e) => e.state === "committed");
    const snap = new Map(es.map((e) => [e.id, e]));
    const discrepancy =
      local.some((e) => !snap.has(e.id)) ||
      es.some(
        (e) => !local.some((x) => x.id === e.id && x.amount === e.amount),
      );
    this.transaction(() => {
      for (const e of es)
        this.db
          .prepare(
            "INSERT INTO reservations(id,at,asset,strategy,amount,state,expires_at) VALUES(?,?,?,?,?,'committed',?) ON CONFLICT(id) DO NOTHING",
          )
          .run(e.id, e.at, e.asset, e.strategy, e.amount, e.at);
      this.db
        .prepare(
          "INSERT INTO ledger_meta VALUES('status',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        )
        .run(discrepancy ? "discrepancy" : "ok");
    });
    return discrepancy ? "discrepancy" : "ok";
  }
  status() {
    return ((
      this.db.prepare("SELECT v FROM ledger_meta WHERE k='status'").get() as any
    )?.v ?? "ok") as "ok" | "discrepancy";
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
export interface Decision {
  allowed: boolean;
  reasons: string[];
  reservationId?: string;
}
export class TradingControl {
  constructor(
    private p: PolicyDocument,
    private ref: SignedPolicyReference,
    private verify: PolicyVerifier,
    private ledger = new ReservationLedger(),
  ) {
    validatePolicy(p);
  }
  reserve(t: TradeRequest): Decision {
    return this.ledger.transaction(() => this.evaluate(t));
  }
  private evaluate(t: TradeRequest): Decision {
    const p = this.p,
      r: string[] = [];
    const bad = (x: boolean, s: string) => {
        if (x) r.push(s);
      },
      has = (a: readonly any[], x: any) => a.includes(x);
    try {
      const h = policyHash(p);
      if (h !== this.ref.policyHash || !this.verify(this.ref, h)) throw Error();
    } catch {
      r.push("policy_signature_invalid");
    }
    const vals = [
      t.now,
      t.chain,
      t.amount,
      t.approvalAmount,
      t.quoteAt,
      t.slippageBps,
      t.impactBps,
      t.gas,
      t.fees,
      t.liquidity,
      t.taxBps,
      t.oracleAt,
      t.portfolioExposure,
      t.assetExposure,
      t.portfolioValue,
      t.peakValue,
      t.realizedLoss,
      t.unrealizedLoss,
      t.lastHeartbeat,
    ];
    bad(vals.some((x) => x < 0n) || t.amount === 0n, "invalid_numeric_input");
    if (t.amount <= 0n) r.push("invalid_amount");
    bad(t.quoteAt > t.now, "quote_future");
    bad(t.oracleAt > t.now, "oracle_future");
    bad(t.lastHeartbeat > t.now, "heartbeat_future");
    bad(t.now < p.effectiveAt || t.now >= p.expiresAt, "policy_inactive");
    bad(p.globalKill, "global_kill_switch");
    bad(p.strategyKills.includes(t.strategy), "strategy_kill_switch");
    for (const [ok, s] of [
      [has(p.allow.chains, t.chain), "chain_not_allowed"],
      [has(p.allow.accounts, t.account), "account_not_allowed"],
      [
        has(p.allow.tokens, t.tokenIn) && has(p.allow.tokens, t.tokenOut),
        "token_not_allowed",
      ],
      [has(p.allow.routers, t.router), "router_not_allowed"],
      [has(p.allow.targets, t.target), "target_not_allowed"],
      [has(p.allow.selectors, t.selector), "selector_not_allowed"],
      [has(p.allow.recipients, t.recipient), "recipient_not_allowed"],
    ] as [boolean, string][])
      bad(!ok, s);
    bad(t.approvalAmount !== t.amount, "approval_not_exact");
    bad(t.amount > p.limits.perTrade, "per_trade_limit_exceeded");
    bad(t.now - t.quoteAt > p.market.maxQuoteAge, "quote_stale");
    bad(t.slippageBps > p.market.maxSlippageBps, "slippage_exceeded");
    bad(t.impactBps > p.market.maxImpactBps, "impact_exceeded");
    bad(t.gas > p.market.maxGas, "gas_exceeded");
    bad(t.fees > p.market.maxFees, "fees_exceeded");
    bad(t.liquidity < p.market.minLiquidity, "liquidity_too_low");
    bad(t.taxBps > p.market.maxTaxBps, "tax_exceeded");
    bad(t.isProxy && !p.market.allowProxy, "proxy_forbidden");
    bad(t.now - t.oracleAt > p.market.maxOracleAge, "oracle_stale");
    bad(p.market.requireSequencerUp && !t.sequencerUp, "sequencer_down");
    const entries = this.ledger.entries(t.now),
      asset = entries
        .filter((e) => e.asset === t.tokenIn)
        .reduce((n, e) => n + e.amount, 0n),
      total = entries.reduce((n, e) => n + e.amount, 0n);
    bad(
      t.portfolioExposure + total + t.amount > p.limits.totalExposure,
      "total_exposure_exceeded",
    );
    bad(
      t.assetExposure + asset + t.amount > p.limits.assetExposure,
      "asset_exposure_exceeded",
    );
    bad(
      t.portfolioValue <= 0n ||
        (t.assetExposure + asset + t.amount) * 10000n >
          p.limits.concentrationBps * t.portfolioValue,
      "concentration_exceeded",
    );
    bad(
      t.peakValue > t.portfolioValue &&
        t.peakValue - t.portfolioValue > p.limits.drawdown,
      "drawdown_exceeded",
    );
    bad(
      t.realizedLoss + t.unrealizedLoss > p.limits.totalLoss,
      "loss_exceeded",
    );
    bad(t.now - t.lastHeartbeat > p.deadManAfter, "dead_man_switch");
    const u = (w: bigint, f: (e: LedgerEntry) => boolean) =>
      this.ledger.usage(t.now, w, f) + t.amount;
    bad(
      u(3600n, (e) => e.asset === t.tokenIn) > p.limits.assetHourly,
      "asset_hourly_limit_exceeded",
    );
    bad(
      u(86400n, (e) => e.asset === t.tokenIn) > p.limits.assetDaily,
      "asset_daily_limit_exceeded",
    );
    bad(
      u(3600n, (e) => e.strategy === t.strategy) > p.limits.strategyHourly,
      "strategy_hourly_limit_exceeded",
    );
    bad(
      u(86400n, (e) => e.strategy === t.strategy) > p.limits.strategyDaily,
      "strategy_daily_limit_exceeded",
    );
    bad(this.ledger.has(t.id), "duplicate_trade_id");
    if (r.length) return { allowed: false, reasons: r };
    return this.ledger.reserve({
      id: t.id,
      at: t.now,
      asset: t.tokenIn,
      strategy: t.strategy,
      amount: t.amount,
    })
      ? { allowed: true, reasons: [], reservationId: t.id }
      : { allowed: false, reasons: ["duplicate_trade_id"] };
  }
  release(id: string) {
    return this.ledger.transaction(() => this.ledger.release(id));
  }
  commit(id: string, at: bigint) {
    return this.ledger.transaction(() => this.ledger.commit(id, at));
  }
  reconcile(e: LedgerEntry[]) {
    return this.ledger.reconcile(e);
  }
}
