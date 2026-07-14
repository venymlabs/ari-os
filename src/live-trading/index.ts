import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { toIpcPath } from "../platform.js";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import type {
  SimulationEvidence,
  SimulationRequest,
} from "../execution/simulation.js";
import type {
  ApprovalEngine,
  DecisionInput,
} from "../execution/approvals/index.js";
import type {
  AuthorizationEnvelope,
  AuthorizationIssuer,
} from "../execution/authorization/index.js";
const json = (x: unknown) =>
  JSON.stringify(x, (_k, v) =>
    typeof v === "bigint" ? { $bigint: v.toString() } : v,
  );
const parse = (x: string) =>
  JSON.parse(x, (_k, v) =>
    v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v,
  );
const digest = (x: unknown) =>
  createHash("sha256").update(json(x)).digest("hex");
export type TradeSide = "buy" | "sell";
export type QuoteSide = TradeSide | "revoke";
export type TradeState =
  | "awaiting-approval"
  | "approved"
  | "dry-run"
  | "signing"
  | "submitting"
  | "reconciliation-required"
  | "broadcast"
  | "confirmed"
  | "finalized"
  | "failed"
  | "denied"
  | "dropped"
  | "reorged";
export interface TradingPolicy {
  version: number;
  hash?: string;
  maxAmountIn: bigint;
  maxSlippageBps: number;
  approvalRequired: boolean;
  finalityBlocks: number;
  allowedTokens?: readonly Address[];
}
export interface QuoteResult {
  amountOut: bigint;
  blockNumber: bigint;
  blockHash?: Hex;
  expiresAt: number;
  request?: SimulationRequest;
  evidence?: SimulationEvidence;
  route?: unknown;
}
export interface TradingRpc {
  balance(owner: Address, token?: Address): Promise<bigint>;
  quote(x: {
    side: TradeSide;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
  }): Promise<QuoteResult>;
  /** Build and simulate the exact approve(spender, 0) transaction. */
  revokeQuote?(x: { token: Address; spender: Address }): Promise<QuoteResult>;
  simulate(
    x: SimulationRequest | Record<string, unknown>,
  ): Promise<
    | SimulationEvidence
    | { success: boolean; blockNumber: bigint; simulationHash: string }
  >;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<{
    blockNumber: bigint;
    blockHash: Hex;
    status: "success" | "reverted";
    confirmations: number;
  } | null>;
  blockHash(n: bigint): Promise<Hex | null>;
}
export interface IsolatedSigner {
  sign(request: {
    serialized: Hex;
    envelope: AuthorizationEnvelope;
    authorizationToken: string;
  }): Promise<{ raw: Hex; hash: Hex } | Hex>;
  result?(request: {
    authorizationId: string;
    transactionHash: Hex;
    recoverRaw?: boolean;
  }): Promise<{ state: string; hash?: Hex; raw?: Hex }>;
}
export interface SignerStatus {
  account: Address;
  chainIds: number[];
  policyHash: string;
  policyVersion: number;
  authorizationKeyId: string;
  serviceVersion: string;
}
type Quote = {
  id: string;
  side: QuoteSide;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minimumOut: bigint;
  slippageBps: number;
  blockNumber: bigint;
  blockHash?: Hex;
  expiresAt: number;
  intentHash: string;
  quoteHash: string;
  policyHash: string;
  route?: unknown;
  request?: SimulationRequest;
  evidence?: SimulationEvidence;
  serialized?: Hex;
  transactionHash?: Hex;
};
export type Execution = {
  id: string;
  version: number;
  quoteId: string;
  quoteHash?: string;
  intentHash: string;
  policyHash?: string;
  riskHash?: string;
  reservationId?: string;
  simulationHash?: string;
  approvalId?: string;
  authorizationId?: string;
  actor: string;
  dryRun: boolean;
  idempotencyKey: string;
  state: TradeState;
  approver?: string;
  rawTransactionHash?: Hex;
  txHash?: Hex;
  blockNumber?: bigint;
  blockHash?: Hex;
  createdAt: number;
  updatedAt: number;
};
export class ExecutionStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,state TEXT);CREATE TABLE IF NOT EXISTS quotes(id TEXT PRIMARY KEY,payload TEXT NOT NULL,quote_hash TEXT)`,
    );
    // Databases created before the indexed columns existed are migrated
    // in place; the JSON payload remains the source of truth.
    const executionColumns = this.db
      .prepare("PRAGMA table_info(executions)")
      .all() as any[];
    if (!executionColumns.some((c) => c.name === "state")) {
      this.db.exec("ALTER TABLE executions ADD COLUMN state TEXT");
      for (const row of this.db
        .prepare("SELECT id,payload FROM executions")
        .all() as any[])
        this.db
          .prepare("UPDATE executions SET state=? WHERE id=?")
          .run((parse(String(row.payload)) as Execution).state, row.id);
    }
    const quoteColumns = this.db
      .prepare("PRAGMA table_info(quotes)")
      .all() as any[];
    if (!quoteColumns.some((c) => c.name === "quote_hash")) {
      this.db.exec("ALTER TABLE quotes ADD COLUMN quote_hash TEXT");
      for (const row of this.db
        .prepare("SELECT id,payload FROM quotes")
        .all() as any[])
        this.db
          .prepare("UPDATE quotes SET quote_hash=? WHERE id=?")
          .run((parse(String(row.payload)) as Quote).quoteHash, row.id);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS executions_state ON executions(state); CREATE INDEX IF NOT EXISTS quotes_quote_hash ON quotes(quote_hash)",
    );
  }
  putQuote(q: Quote) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO quotes(id,payload,quote_hash) VALUES(?,?,?)",
      )
      .run(q.id, json(q), q.quoteHash);
    return q;
  }
  getQuote(id: string) {
    const r = this.db
      .prepare("SELECT payload FROM quotes WHERE id=?")
      .get(id) as any;
    return r ? (parse(String(r.payload)) as Quote) : undefined;
  }
  findQuoteByHash(hash: string) {
    const r = this.db
      .prepare(
        "SELECT payload FROM quotes WHERE quote_hash=? ORDER BY rowid LIMIT 1",
      )
      .get(hash) as any;
    return r ? (parse(String(r.payload)) as Quote) : undefined;
  }
  create(
    x: Omit<Execution, "id" | "version" | "state" | "createdAt" | "updatedAt">,
    state: TradeState = "awaiting-approval",
  ) {
    const now = Date.now(),
      r: Execution = {
        ...x,
        id: randomUUID(),
        version: 0,
        state,
        createdAt: now,
        updatedAt: now,
      };
    this.db
      .prepare(
        "INSERT INTO executions(id,idempotency_key,payload,state) VALUES(?,?,?,?)",
      )
      .run(r.id, r.idempotencyKey, json(r), r.state);
    return r;
  }
  get(id: string) {
    const r = this.db
      .prepare("SELECT payload FROM executions WHERE id=?")
      .get(id) as any;
    return r ? (parse(String(r.payload)) as Execution) : undefined;
  }
  byIdempotency(k: string) {
    const r = this.db
      .prepare("SELECT payload FROM executions WHERE idempotency_key=?")
      .get(k) as any;
    return r ? (parse(String(r.payload)) as Execution) : undefined;
  }
  list(states: readonly TradeState[]) {
    if (!states.length) return [];
    const marks = states.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `SELECT payload FROM executions WHERE state IN (${marks}) ORDER BY rowid`,
        )
        .all(...states) as any[]
    ).map((r) => parse(String(r.payload)) as Execution);
  }
  transition(
    id: string,
    from: TradeState | TradeState[],
    p: Partial<Execution>,
    version?: number,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(id);
      if (!old) throw Error("execution_not_found");
      if (
        !(Array.isArray(from) ? from : [from]).includes(old.state) ||
        (version !== undefined && old.version !== version)
      )
        throw Error("state conflict");
      const x = {
        ...old,
        ...p,
        version: old.version + 1,
        updatedAt: Date.now(),
      };
      const r = this.db
        .prepare(
          "UPDATE executions SET payload=?,state=? WHERE id=? AND payload=?",
        )
        .run(json(x), x.state, id, json(old));
      if (Number(r.changes) !== 1) throw Error("state conflict");
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  update(id: string, p: Partial<Execution>) {
    const x = this.get(id);
    if (!x) throw Error("execution_not_found");
    return this.transition(id, x.state, p, x.version);
  }
  close() {
    this.db.close();
  }
}
export class TradingOrchestrator {
  constructor(
    private c: {
      chainId: number;
      account: Address;
      router: Address;
      policy: TradingPolicy;
      rpc: TradingRpc;
      store: ExecutionStore;
      signer?: IsolatedSigner;
      liveEnabled?: boolean;
      clock?: () => number;
      approvalEngine?: Pick<
        ApprovalEngine,
        "request" | "get" | "decide" | "consume"
      >;
      authorizationIssuer?: Pick<AuthorizationIssuer, "issue">;
      risk?: {
        assess: (x: unknown) => Promise<{ hash: string; allowed: boolean }>;
      };
      reservations?: {
        reserve: (x: unknown) => Promise<string>;
        valid: (id: string) => Promise<boolean>;
        commit: (id: string) => Promise<boolean>;
        release: (id: string) => Promise<boolean>;
      };
      audience?: string;
    },
  ) {}
  async quote(raw: {
    side: TradeSide;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    slippageBps: number;
  }) {
    if (
      Object.keys(raw).some(
        (k) =>
          !["side", "tokenIn", "tokenOut", "amountIn", "slippageBps"].includes(
            k,
          ),
      )
    )
      throw Error("unknown field");
    if (raw.side !== "buy" && raw.side !== "sell") throw Error("invalid side");
    if (raw.amountIn <= 0n || raw.amountIn > this.c.policy.maxAmountIn)
      throw Error("amount exceeds policy");
    if (raw.slippageBps < 0 || raw.slippageBps > this.c.policy.maxSlippageBps)
      throw Error("slippage exceeds policy");
    const tokenIn = getAddress(raw.tokenIn),
      tokenOut = getAddress(raw.tokenOut),
      allowed = this.c.policy.allowedTokens?.map(getAddress);
    if (allowed && (!allowed.includes(tokenIn) || !allowed.includes(tokenOut)))
      throw Error("token denied");
    const r = await this.c.rpc.quote({ ...raw, tokenIn, tokenOut }),
      policyHash = this.c.policy.hash ?? digest(this.c.policy),
      minimumOut = (r.amountOut * BigInt(10000 - raw.slippageBps)) / 10000n;
    const core = {
      side: raw.side,
      chainId: this.c.chainId,
      account: getAddress(this.c.account),
      router: getAddress(this.c.router),
      tokenIn,
      tokenOut,
      amountIn: raw.amountIn,
      minimumOut,
      route: r.route,
      policyHash,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash ?? r.evidence?.blockHash,
      expiresAt: r.expiresAt,
      serialized: r.request?.serialized,
    };
    const q: Quote = {
      id: randomUUID(),
      ...raw,
      tokenIn,
      tokenOut,
      ...r,
      minimumOut,
      policyHash,
      intentHash: digest(core),
      quoteHash: digest({ ...core, amountOut: r.amountOut }),
      ...(r.request
        ? {
            serialized: r.request.serialized,
            transactionHash: r.request.transactionHash,
          }
        : {}),
    };
    return this.c.store.putQuote(q);
  }
  /**
   * Pin the exact ERC-20 approve(router, 0) transaction that clears the
   * router allowance for a token. The result flows through the same
   * lifecycle as a swap quote: execute -> approve -> submit -> reconcile,
   * with exact-transaction approval, one-time authorization, and the
   * isolated signer's own policy checks. The token is deliberately not
   * restricted to the trading allowlist: revoking an allowance only ever
   * reduces exposure, and operators most need it for tokens they no
   * longer trust; the signer policy's `to` allowlist remains the final
   * authority on which contracts may be called.
   */
  async revokeQuote(tokenRaw: Address) {
    const token = getAddress(tokenRaw),
      spender = getAddress(this.c.router);
    if (!this.c.rpc.revokeQuote) throw Error("revoke_unsupported");
    const r = await this.c.rpc.revokeQuote({ token, spender });
    if (!r.request || !r.evidence) throw Error("exact_transaction_required");
    const policyHash = this.c.policy.hash ?? digest(this.c.policy);
    const core = {
      side: "revoke" as const,
      chainId: this.c.chainId,
      account: getAddress(this.c.account),
      router: spender,
      token,
      policyHash,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash ?? r.evidence.blockHash,
      expiresAt: r.expiresAt,
      serialized: r.request.serialized,
    };
    const q: Quote = {
      id: randomUUID(),
      side: "revoke",
      tokenIn: token,
      tokenOut: token,
      amountIn: 0n,
      slippageBps: 0,
      ...r,
      minimumOut: 0n,
      policyHash,
      intentHash: digest(core),
      quoteHash: digest({ ...core, evidenceHash: r.evidence.hash }),
      serialized: r.request.serialized,
      transactionHash: r.request.transactionHash,
    };
    return this.c.store.putQuote(q);
  }
  async revoke(
    tokenRaw: Address,
    o: { idempotencyKey: string; actor: string; dryRun?: boolean },
  ) {
    const old = this.c.store.byIdempotency(o.idempotencyKey);
    if (old) return old;
    const q = await this.revokeQuote(tokenRaw);
    return this.execute(q.id, o);
  }
  async execute(
    quoteId: string,
    o: { idempotencyKey: string; actor: string; dryRun?: boolean },
  ) {
    const old = this.c.store.byIdempotency(o.idempotencyKey);
    if (old) return old;
    const q = this.c.store.getQuote(quoteId);
    if (!q) throw Error("quote_not_found");
    if (q.expiresAt < (this.c.clock ?? Date.now)())
      throw Error("quote_expired");
    const dryRun = o.dryRun ?? true;
    if (!dryRun && !this.c.liveEnabled) throw Error("live_trading_disabled");
    let evidence = q.evidence;
    if (q.request) {
      const got = await this.c.rpc.simulate(q.request);
      if (!("hash" in got)) throw Error("simulation_evidence_required");
      evidence = got;
    } else {
      const got: any = await this.c.rpc.simulate({
        intentHash: q.intentHash,
        blockNumber: q.blockNumber,
      });
      if (!got.success) throw Error("simulation_failed");
    }
    if (dryRun)
      return this.c.store.create(
        {
          quoteId,
          quoteHash: q.quoteHash,
          intentHash: q.intentHash,
          policyHash: q.policyHash,
          ...(evidence ? { simulationHash: evidence.hash } : {}),
          actor: o.actor,
          dryRun,
          idempotencyKey: o.idempotencyKey,
        },
        "dry-run",
      );
    if (!q.request || !evidence) throw Error("exact_transaction_required");
    if (
      evidence.transactionHash !== q.request.transactionHash ||
      evidence.blockHash !== (q.blockHash ?? evidence.blockHash)
    )
      throw Error("simulation_transaction_mismatch");
    const risk = await this.c.risk?.assess({
      quote: q,
      request: q.request,
      evidence,
    });
    if (risk && !risk.allowed) throw Error("risk_denied");
    const reservationId = await this.c.reservations?.reserve({
      quoteHash: q.quoteHash,
      policyHash: q.policyHash,
      transactionHash: q.request.transactionHash,
    });
    const x = this.c.store.create({
      quoteId,
      quoteHash: q.quoteHash,
      intentHash: q.intentHash,
      policyHash: q.policyHash,
      ...(risk ? { riskHash: risk.hash } : {}),
      ...(reservationId ? { reservationId } : {}),
      simulationHash: evidence.hash,
      actor: o.actor,
      dryRun,
      idempotencyKey: o.idempotencyKey,
    });
    if (!this.c.policy.approvalRequired)
      return this.c.store.transition(x.id, "awaiting-approval", {
        state: "approved",
      });
    const approvalId = x.id,
      b = this.binding(q, evidence);
    this.c.approvalEngine?.request(
      {
        ...b,
        id: approvalId,
        type: "sign",
        proposerId: o.actor,
        expiresAt: q.expiresAt,
      },
      { quorum: 1 },
    );
    return this.c.store.transition(x.id, "awaiting-approval", { approvalId });
  }
  private binding(q: Quote, e: SimulationEvidence): any {
    const t = q.request!.transaction;
    return {
      chain: String(this.c.chainId),
      serializedTransaction: { ...t, serialized: q.request!.serialized },
      intentHash: q.intentHash,
      policyHash: q.policyHash,
      policyVersion: String(this.c.policy.version),
      simulationHash: e.hash,
      simulationBlock: String(e.blockNumber),
      simulationState: e.blockHash,
      account: this.c.account,
      nonce: String(t.nonce),
      value: String(t.value),
      calldata: t.data,
      router: t.to,
    };
  }
  assertExact(id: string, r: SimulationRequest) {
    const x = this.require(id),
      q = this.c.store.getQuote(x.quoteId);
    if (
      !q?.request ||
      q.request.serialized.toLowerCase() !== r.serialized.toLowerCase() ||
      q.request.transactionHash !== r.transactionHash
    )
      throw Error("exact transaction mismatch");
    return true;
  }
  approve(
    id: string,
    operator: string,
    input?: Omit<DecisionInput, "operatorId">,
  ) {
    const x = this.require(id);
    if (x.actor === operator) throw Error("self approval prohibited");
    if (x.state !== "awaiting-approval") throw Error("not awaiting approval");
    if (input && x.approvalId)
      this.c.approvalEngine?.decide(x.approvalId, {
        ...input,
        operatorId: operator,
      });
    else if (this.c.approvalEngine) throw Error("decision proof required");
    return this.refreshApproval(id, operator);
  }
  deny(
    id: string,
    operator: string,
    input?: Omit<DecisionInput, "operatorId" | "decision">,
  ) {
    const x = this.require(id);
    if (x.state !== "awaiting-approval") throw Error("not awaiting approval");
    if (!input || !x.approvalId || !this.c.approvalEngine)
      throw Error("decision proof required");
    this.c.approvalEngine.decide(x.approvalId, {
      ...input,
      operatorId: operator,
      decision: "deny",
    });
    return this.refreshApproval(id, operator);
  }
  refreshApproval(id: string, operator?: string) {
    const x = this.require(id);
    if (x.state !== "awaiting-approval") return x;
    if (!x.approvalId || !this.c.approvalEngine)
      throw Error("approval unavailable");
    const a = this.c.approvalEngine.get(x.approvalId);
    if (!a) throw Error("approval record missing");
    if (a.status === "denied")
      return this.c.store.transition(id, "awaiting-approval", {
        state: "denied",
        ...(operator ? { approver: operator } : {}),
      });
    if (a.status === "approved")
      return this.c.store.transition(id, "awaiting-approval", {
        state: "approved",
        ...(operator ? { approver: operator } : {}),
      });
    return x;
  }
  async submit(id: string) {
    let x = this.require(id);
    if (x.state !== "approved" && x.state !== "signing")
      throw Error(
        x.state === "submitting" ? "submission in progress" : "not approved",
      );
    const q = this.c.store.getQuote(x.quoteId);
    if (!q?.request || !q.evidence) throw Error("exact_transaction_required");
    if (!this.c.liveEnabled || !this.c.signer || !this.c.authorizationIssuer)
      throw Error("signer unavailable");
    if (
      q.expiresAt <= (this.c.clock ?? Date.now)() ||
      (q.blockHash &&
        (await this.c.rpc.blockHash(q.blockNumber)) !== q.blockHash)
    )
      throw Error("quote_stale_or_reorged");
    if (
      x.reservationId &&
      this.c.reservations &&
      !(await this.c.reservations.valid(x.reservationId))
    )
      throw Error("reservation_invalid");
    if (!x.approvalId || !this.c.approvalEngine)
      throw Error("approval unavailable");
    if (this.c.approvalEngine.get(x.approvalId)?.status !== "consumed")
      this.c.approvalEngine.consume(x.approvalId, this.binding(q, q.evidence));
    if (x.state === "approved")
      x = this.c.store.transition(id, "approved", { state: "signing" });
    try {
      const env = await this.c.authorizationIssuer.issue(
        q.request,
        q.evidence,
        {
          quoteHash: q.quoteHash,
          policyHash: q.policyHash,
          policyVersion: this.c.policy.version,
          riskHash: x.riskHash!,
          reservationId: x.reservationId!,
          approvalId: x.approvalId!,
          audience: this.c.audience ?? "signer",
        },
      );
      x = this.c.store.transition(id, "signing", {
        authorizationId: env.claims.id,
      });
      const signed = await this.c.signer.sign({
        serialized: q.request.serialized,
        envelope: env,
        authorizationToken: env.claims.id,
      });
      const raw = typeof signed === "string" ? signed : signed.raw,
        rawHash = typeof signed === "string" ? keccak256(signed) : signed.hash;
      x = this.c.store.transition(id, "signing", {
        state: "submitting",
        authorizationId: env.claims.id,
        rawTransactionHash: rawHash,
      });
      const txHash = await this.c.rpc.broadcast(raw);
      if (txHash.toLowerCase() !== rawHash.toLowerCase())
        throw Error("broadcast_hash_mismatch");
      await this.c.reservations?.commit(x.reservationId!);
      return this.c.store.transition(id, "submitting", {
        state: "broadcast",
        txHash,
      });
    } catch (e) {
      const now = this.require(id);
      if (now.state === "submitting")
        this.c.store.transition(id, "submitting", {
          state: "reconciliation-required",
        });
      throw e;
    }
  }
  recover(id: string) {
    const x = this.require(id);
    if (x.state === "submitting")
      return this.c.store.transition(id, "submitting", {
        state: "reconciliation-required",
      });
    return x;
  }
  async recoverSigning(row: Execution) {
    const q = this.c.store.getQuote(row.quoteId);
    if (!q?.request) throw Error("exact_transaction_required");
    if (!row.authorizationId) return this.submit(row.id);
    if (!this.c.signer?.result) throw Error("signer_result_unavailable");
    const signed = await this.c.signer.result({
      authorizationId: row.authorizationId,
      transactionHash: q.request.transactionHash,
      recoverRaw: true,
    });
    if (signed.state === "not_found") throw Error("signer_result_not_found");
    if (signed.state !== "signed" || !signed.hash)
      throw Error("signer_result_invalid");
    if (
      signed.hash.toLowerCase() !==
        keccak256(signed.raw ?? "0x").toLowerCase() &&
      !signed.raw
    )
      throw Error("signer_result_raw_unavailable");
    if (
      !signed.raw ||
      keccak256(signed.raw).toLowerCase() !== signed.hash.toLowerCase()
    )
      throw Error("signer_result_invalid");
    const x = this.c.store.transition(row.id, "signing", {
      state: "submitting",
      rawTransactionHash: signed.hash,
    });
    const txHash = await this.c.rpc.broadcast(signed.raw);
    if (txHash.toLowerCase() !== signed.hash.toLowerCase()) {
      this.c.store.transition(row.id, "submitting", {
        state: "reconciliation-required",
      });
      throw Error("broadcast_hash_mismatch");
    }
    await this.c.reservations?.commit(x.reservationId!);
    return this.c.store.transition(row.id, "submitting", {
      state: "broadcast",
      txHash,
    });
  }
  async recoverAndReconcile(limit = 100) {
    const rows = this.c.store
        .list([
          "signing",
          "submitting",
          "reconciliation-required",
          "broadcast",
          "confirmed",
        ])
        .slice(0, Math.max(0, limit)),
      result = { scanned: rows.length, recovered: 0, reconciled: 0, failed: 0 };
    for (const row of rows) {
      try {
        if (row.state === "signing") {
          await this.recoverSigning(row);
          result.recovered++;
        } else if (row.state === "submitting") {
          this.recover(row.id);
          result.recovered++;
        } else {
          await this.reconcile(row.id);
          result.reconciled++;
        }
      } catch {
        result.failed++;
      }
    }
    return result;
  }
  async reconcile(id: string) {
    const x = this.require(id);
    const hash = x.txHash ?? x.rawTransactionHash;
    if (!hash) throw Error("transaction_not_broadcast");
    const r = await this.c.rpc.receipt(hash);
    if (!r)
      return x.state === "reconciliation-required"
        ? x
        : this.c.store.transition(id, x.state, {
            state: "reconciliation-required",
          });
    if (
      x.blockNumber &&
      x.blockHash &&
      (await this.c.rpc.blockHash(x.blockNumber)) !== x.blockHash
    )
      return this.c.store.transition(id, x.state, {
        state: "reconciliation-required",
      });
    if (r.status === "reverted")
      return this.c.store.transition(id, x.state, {
        state: "failed",
        txHash: hash,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
      });
    return this.c.store.transition(id, x.state, {
      state:
        r.confirmations >= this.c.policy.finalityBlocks
          ? "finalized"
          : "confirmed",
      txHash: hash,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash,
    });
  }
  status(id: string) {
    const x = this.require(id);
    if (!x.approvalId || !this.c.approvalEngine) return x;
    const approval = this.c.approvalEngine.get(x.approvalId);
    return approval
      ? {
          ...x,
          challenge: approval.challenge,
          approvalRevision: approval.revision,
        }
      : x;
  }
  private require(id: string) {
    const x = this.c.store.get(id);
    if (!x) throw Error("execution_not_found");
    return x;
  }
}
export class UnixSignerClient implements IsolatedSigner {
  constructor(
    private socketPath: string,
    private authorizationToken = "",
    private timeoutMs = 5000,
  ) {}
  private request(payload: unknown) {
    return new Promise<any>((resolve, reject) => {
      const s = createConnection(toIpcPath(this.socketPath));
      let data = "";
      const timer = setTimeout(
        () => s.destroy(Error("signer_timeout")),
        this.timeoutMs,
      );
      s.on("connect", () =>
        s.write(
          json({ token: this.authorizationToken, ...(payload as object) }) +
            "\n",
        ),
      );
      s.on("data", (b) => {
        data += b;
        const at = data.indexOf("\n");
        if (at >= 0) {
          clearTimeout(timer);
          s.end();
          try {
            const r = JSON.parse(data.slice(0, at));
            if (r.error || r.ok === false) reject(Error(r.error));
            else resolve(r.result ?? r);
          } catch {
            reject(Error("invalid_signer_response"));
          }
        }
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
  async status(): Promise<SignerStatus> {
    const v = await this.request({ method: "status" });
    if (
      !v ||
      typeof v.account !== "string" ||
      !Array.isArray(v.chainIds) ||
      !v.chainIds.every((x: unknown) => Number.isSafeInteger(x)) ||
      typeof v.policyHash !== "string" ||
      !Number.isSafeInteger(v.policyVersion) ||
      typeof v.authorizationKeyId !== "string" ||
      typeof v.serviceVersion !== "string"
    )
      throw Error("invalid_signer_status");
    return { ...v, account: getAddress(v.account) };
  }
  async probe() {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }
  async sign(request: {
    serialized: Hex;
    envelope: AuthorizationEnvelope;
    authorizationToken: string;
  }) {
    const v = await this.request({
      method: "sign",
      serialized: request.serialized,
      envelope: request.envelope,
      authorizationToken: request.authorizationToken,
    });
    if (!v.raw || !v.hash || keccak256(v.raw) !== v.hash)
      throw Error("invalid_signer_response");
    return v;
  }
  async result(request: {
    authorizationId: string;
    transactionHash: Hex;
    recoverRaw?: boolean;
  }) {
    return this.request({ method: "result", ...request });
  }
}
