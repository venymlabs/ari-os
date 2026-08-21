import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { toIpcPath } from "../platform.js";
import { isPublicKey, signatureOf } from "../signer/transaction.js";
import type {
  SimulationEvidence,
  SimulationRequest,
} from "../execution/simulation.js";
import type {
  ApprovalEngine,
  DecisionInput,
} from "../execution/approvals/index.js";
import type { AuthorizationIssuer } from "../execution/authorization/index.js";
import type {
  AuthorizationEnvelope,
  IsolatedSigner,
  SignerResultResponse,
  SignerSignResponse,
  SignerStatusResponse,
} from "../execution/authorization/wire.js";

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

/**
 * Durable execution lifecycle.
 *
 * `expired` and `dropped` are the two Solana terminal states and neither is
 * retryable. `expired`: the recent blockhash died before a signature existed.
 * `dropped`: a signature existed and was broadcast, but the cluster never saw
 * it and its blockhash is now past `lastValidBlockHeight`. In both cases the
 * only way forward is a fresh quote, a fresh simulation and a fresh operator
 * decision — never a re-sign, because a new blockhash is new message bytes and
 * a signature over the old ones may still land.
 */
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
  | "expired"
  | "dropped";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface TradingPolicy {
  version: number;
  hash?: string;
  /** cap on the input leg, in base units of the mint leaving the wallet */
  maxAmountIn: bigint;
  maxSlippageBps: number;
  approvalRequired: boolean;
  /**
   * Commitment at which an execution is considered final. Solana has no
   * confirmation depth to count; `confirmed` is supermajority vote and
   * `finalized` is rooted.
   */
  finalityCommitment: Commitment;
  /** base58 mints this account may trade */
  allowedMints?: readonly string[];
}

export interface QuoteResult {
  amountOut: bigint;
  /** context slot the quote was produced at */
  slot: bigint;
  /** block height past which the built transaction's blockhash cannot land */
  lastValidBlockHeight: number;
  expiresAt: number;
  request?: SimulationRequest;
  evidence?: SimulationEvidence;
  route?: unknown;
}

export interface SignatureStatus {
  slot: bigint;
  confirmationStatus: Commitment;
  err: unknown;
}

export interface TradingRpc {
  balance(owner: string, mint?: string): Promise<bigint>;
  quote(x: {
    side: TradeSide;
    inputMint: string;
    outputMint: string;
    amountIn: bigint;
  }): Promise<QuoteResult>;
  /**
   * Build and simulate the exact SPL Token `Revoke` that clears the delegate on
   * a token account. This is the Solana analogue of revoking an ERC-20
   * allowance: it is the one instruction that can only ever reduce what someone
   * else may move.
   */
  revokeQuote?(x: {
    tokenAccount: string;
    owner: string;
  }): Promise<QuoteResult>;
  simulate(
    x: SimulationRequest | Record<string, unknown>,
  ): Promise<
    | SimulationEvidence
    | { success: boolean; slot: bigint; simulationHash: string }
  >;
  /** Submit base64 signed wire bytes; returns the base58 signature. */
  broadcast(wire: string): Promise<string>;
  status(signature: string): Promise<SignatureStatus | null>;
  /** Current cluster block height — the blockhash-expiry fence. */
  blockHeight(): Promise<number>;
}

export type { IsolatedSigner };
export type SignerStatus = SignerStatusResponse;

type Quote = {
  id: string;
  side: QuoteSide;
  cluster: string;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  amountOut: bigint;
  minimumOut: bigint;
  slippageBps: number;
  slot: bigint;
  lastValidBlockHeight: number;
  expiresAt: number;
  intentHash: string;
  quoteHash: string;
  policyHash: string;
  route?: unknown;
  request?: SimulationRequest;
  evidence?: SimulationEvidence;
  /** base64 unsigned wire transaction */
  transaction?: string;
  messageHash?: string;
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
  /** `0x` sha256 of the message bytes that were signed */
  messageHash?: string;
  /** base58 transaction signature */
  signature?: string;
  slot?: bigint;
  lastValidBlockHeight?: number;
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
      .all() as { name?: string }[];
    if (!executionColumns.some((c) => c.name === "state")) {
      this.db.exec("ALTER TABLE executions ADD COLUMN state TEXT");
      for (const row of this.db
        .prepare("SELECT id,payload FROM executions")
        .all() as { id: string; payload: string }[])
        this.db
          .prepare("UPDATE executions SET state=? WHERE id=?")
          .run((parse(String(row.payload)) as Execution).state, row.id);
    }
    const quoteColumns = this.db.prepare("PRAGMA table_info(quotes)").all() as {
      name?: string;
    }[];
    if (!quoteColumns.some((c) => c.name === "quote_hash")) {
      this.db.exec("ALTER TABLE quotes ADD COLUMN quote_hash TEXT");
      for (const row of this.db
        .prepare("SELECT id,payload FROM quotes")
        .all() as { id: string; payload: string }[])
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
      .get(id) as { payload?: string } | undefined;
    return r ? (parse(String(r.payload)) as Quote) : undefined;
  }
  findQuoteByHash(hash: string) {
    const r = this.db
      .prepare(
        "SELECT payload FROM quotes WHERE quote_hash=? ORDER BY rowid LIMIT 1",
      )
      .get(hash) as { payload?: string } | undefined;
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
      .get(id) as { payload?: string } | undefined;
    return r ? (parse(String(r.payload)) as Execution) : undefined;
  }
  byIdempotency(k: string) {
    const r = this.db
      .prepare("SELECT payload FROM executions WHERE idempotency_key=?")
      .get(k) as { payload?: string } | undefined;
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
        .all(...states) as { payload: string }[]
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
      cluster: string;
      /** base58 fee payer the isolated signer holds */
      account: string;
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

  private get policyHash() {
    return this.c.policy.hash ?? digest(this.c.policy);
  }
  private now() {
    return (this.c.clock ?? Date.now)();
  }
  private mint(value: string, label: string) {
    if (!isPublicKey(value)) throw Error(`invalid ${label}`);
    return value;
  }

  async quote(raw: {
    side: TradeSide;
    inputMint: string;
    outputMint: string;
    amountIn: bigint;
    slippageBps: number;
  }) {
    if (
      Object.keys(raw).some(
        (k) =>
          ![
            "side",
            "inputMint",
            "outputMint",
            "amountIn",
            "slippageBps",
          ].includes(k),
      )
    )
      throw Error("unknown field");
    if (raw.side !== "buy" && raw.side !== "sell") throw Error("invalid side");
    if (raw.amountIn <= 0n || raw.amountIn > this.c.policy.maxAmountIn)
      throw Error("amount exceeds policy");
    if (raw.slippageBps < 0 || raw.slippageBps > this.c.policy.maxSlippageBps)
      throw Error("slippage exceeds policy");
    const inputMint = this.mint(raw.inputMint, "inputMint"),
      outputMint = this.mint(raw.outputMint, "outputMint"),
      allowed = this.c.policy.allowedMints;
    if (
      allowed &&
      (!allowed.includes(inputMint) || !allowed.includes(outputMint))
    )
      throw Error("mint denied");
    const r = await this.c.rpc.quote({ ...raw, inputMint, outputMint }),
      policyHash = this.policyHash,
      minimumOut = (r.amountOut * BigInt(10000 - raw.slippageBps)) / 10000n;
    const core = {
      side: raw.side,
      cluster: this.c.cluster,
      account: this.c.account,
      inputMint,
      outputMint,
      amountIn: raw.amountIn,
      minimumOut,
      route: r.route,
      policyHash,
      slot: r.slot,
      lastValidBlockHeight: r.lastValidBlockHeight,
      expiresAt: r.expiresAt,
      transaction: r.request?.transaction,
    };
    const q: Quote = {
      id: randomUUID(),
      ...raw,
      cluster: this.c.cluster,
      inputMint,
      outputMint,
      ...r,
      minimumOut,
      policyHash,
      intentHash: digest(core),
      quoteHash: digest({ ...core, amountOut: r.amountOut }),
      ...(r.request
        ? {
            transaction: r.request.transaction,
            messageHash: r.request.messageHash,
          }
        : {}),
    };
    return this.c.store.putQuote(q);
  }

  /**
   * Pin the exact SPL Token `Revoke` that clears a delegate on a token account.
   *
   * The result flows through the same lifecycle as a swap quote: execute ->
   * approve -> submit -> reconcile, with exact-transaction approval, one-time
   * authorization, and the isolated signer's own policy re-check. The token
   * account is deliberately not restricted to the trading allowlist — revoking
   * a delegate only ever reduces exposure, and operators most need it for
   * tokens they no longer trust. The signer policy's program allowlist remains
   * the final authority on what may be invoked.
   */
  async revokeQuote(tokenAccountRaw: string) {
    const tokenAccount = this.mint(tokenAccountRaw, "tokenAccount");
    if (!this.c.rpc.revokeQuote) throw Error("revoke_unsupported");
    const r = await this.c.rpc.revokeQuote({
      tokenAccount,
      owner: this.c.account,
    });
    if (!r.request || !r.evidence) throw Error("exact_transaction_required");
    const policyHash = this.policyHash;
    const core = {
      side: "revoke" as const,
      cluster: this.c.cluster,
      account: this.c.account,
      tokenAccount,
      policyHash,
      slot: r.slot,
      lastValidBlockHeight: r.lastValidBlockHeight,
      expiresAt: r.expiresAt,
      transaction: r.request.transaction,
    };
    const q: Quote = {
      id: randomUUID(),
      side: "revoke",
      cluster: this.c.cluster,
      inputMint: tokenAccount,
      outputMint: tokenAccount,
      amountIn: 0n,
      slippageBps: 0,
      ...r,
      minimumOut: 0n,
      policyHash,
      intentHash: digest(core),
      quoteHash: digest({ ...core, evidenceHash: r.evidence.hash }),
      transaction: r.request.transaction,
      messageHash: r.request.messageHash,
    };
    return this.c.store.putQuote(q);
  }

  async revoke(
    tokenAccount: string,
    o: { idempotencyKey: string; actor: string; dryRun?: boolean },
  ) {
    const old = this.c.store.byIdempotency(o.idempotencyKey);
    if (old) return old;
    const q = await this.revokeQuote(tokenAccount);
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
    if (q.expiresAt < this.now()) throw Error("quote_expired");
    const dryRun = o.dryRun ?? true;
    if (!dryRun && !this.c.liveEnabled) throw Error("live_trading_disabled");
    let evidence = q.evidence;
    if (q.request) {
      const got = await this.c.rpc.simulate(q.request);
      if (!("hash" in got)) throw Error("simulation_evidence_required");
      evidence = got;
    } else {
      const got = await this.c.rpc.simulate({
        intentHash: q.intentHash,
        slot: q.slot,
      });
      if (!("success" in got) || !got.success) throw Error("simulation_failed");
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
    if (evidence.messageHash !== q.request.messageHash)
      throw Error("simulation_transaction_mismatch");
    // Queueing an approval for a transaction whose blockhash is already dead
    // wastes an operator's attention on something that can never be submitted.
    if ((await this.c.rpc.blockHeight()) > q.lastValidBlockHeight)
      throw Error("blockhash_expired");
    const risk = await this.c.risk?.assess({
      quote: q,
      request: q.request,
      evidence,
    });
    if (risk && !risk.allowed) throw Error("risk_denied");
    const reservationId = await this.c.reservations?.reserve({
      quoteHash: q.quoteHash,
      policyHash: q.policyHash,
      messageHash: q.request.messageHash,
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
      lastValidBlockHeight: q.lastValidBlockHeight,
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

  /**
   * Project a Solana execution into the approval engine's request shape.
   *
   * `src/execution/approvals` still speaks EVM (`nonce`, `value`, `calldata`,
   * `router`), and it is outside this rewrite. Rather than leave those slots
   * empty, each carries its honest Solana counterpart, listed below so the
   * mapping is auditable rather than implied. Renaming them in the approvals
   * module is tracked separately; nothing here depends on the names.
   *
   *   chain    -> cluster
   *   account  -> fee payer
   *   router   -> the program ids the transaction invokes
   *   calldata -> base64 message bytes, i.e. exactly what will be signed
   *   nonce    -> recent blockhash, Solana's replay fence
   *   value    -> the input leg, in base units of the mint leaving the wallet
   */
  private binding(q: Quote, e: SimulationEvidence) {
    const r = q.request!;
    return {
      chain: q.cluster,
      serializedTransaction: {
        transaction: r.transaction,
        message: r.message,
        messageHash: r.messageHash,
        feePayer: r.feePayer,
        recentBlockhash: r.recentBlockhash,
        lastValidBlockHeight: r.lastValidBlockHeight,
        programIds: r.programIds,
        accountKeys: r.accountKeys,
        instructions: r.instructions,
        addressTableLookups: r.addressTableLookups,
        to: r.programIds.join(","),
        data: r.message,
        value: String(q.amountIn),
        nonce: r.recentBlockhash,
      },
      intentHash: q.intentHash,
      policyHash: q.policyHash,
      policyVersion: String(this.c.policy.version),
      simulationHash: e.hash,
      simulationBlock: String(e.slot),
      simulationState: e.blockhash,
      account: r.feePayer,
      nonce: r.recentBlockhash,
      value: String(q.amountIn),
      calldata: r.message,
      router: r.programIds.join(","),
    };
  }

  assertExact(id: string, r: SimulationRequest) {
    const x = this.require(id),
      q = this.c.store.getQuote(x.quoteId);
    if (
      !q?.request ||
      q.request.transaction !== r.transaction ||
      q.request.messageHash !== r.messageHash
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

  /**
   * Burn the execution because its blockhash can no longer land.
   *
   * Terminal by construction: the reservation is released and no signature is
   * ever produced for these bytes. Recovery means a new quote, not a retry.
   */
  private async expire(id: string, from: TradeState | TradeState[]) {
    const x = this.c.store.get(id);
    if (x?.reservationId) await this.c.reservations?.release(x.reservationId);
    return this.c.store.transition(id, from, { state: "expired" });
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
    if (q.expiresAt <= this.now()) throw Error("quote_expired");
    // The Solana replay fence. Past this height the transaction is dead; the
    // execution is burned rather than re-quoted under a fresh blockhash behind
    // the operator's back.
    if ((await this.c.rpc.blockHeight()) > q.lastValidBlockHeight) {
      await this.expire(id, x.state);
      throw Error("blockhash_expired");
    }
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
        transaction: q.request.transaction,
        envelope: env,
      });
      const signature = assertSignedTransaction(signed);
      // Persist before broadcasting: after this point a crash is recoverable by
      // looking the signature up, never by producing a second one.
      x = this.c.store.transition(id, "signing", {
        state: "submitting",
        authorizationId: env.claims.id,
        messageHash: q.request.messageHash,
        signature,
        lastValidBlockHeight: q.lastValidBlockHeight,
      });
      const landed =
        signed.broadcast ?? (await this.c.rpc.broadcast(signed.transaction));
      if (landed !== signature) throw Error("broadcast_signature_mismatch");
      await this.c.reservations?.commit(x.reservationId!);
      return this.c.store.transition(id, "submitting", {
        state: "broadcast",
        signature: landed,
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

  /**
   * Recover an execution stranded in `signing`.
   *
   * A dropped signing response is the case that must never produce a second
   * signature: the daemon may already have signed, and re-issuing an
   * authorization would authorize the same intent twice. So the signature is
   * *retrieved* from the signer's durable store, verified against the bytes it
   * came with, and broadcast once.
   */
  async recoverSigning(row: Execution) {
    const q = this.c.store.getQuote(row.quoteId);
    if (!q?.request) throw Error("exact_transaction_required");
    if (!row.authorizationId) return this.submit(row.id);
    if (!this.c.signer?.result) throw Error("signer_result_unavailable");
    const signed = await this.c.signer.result({
      authorizationId: row.authorizationId,
      messageHash: q.request.messageHash,
      recoverRaw: true,
    });
    if (signed.state === "expired") {
      await this.expire(row.id, "signing");
      throw Error("authorization_expired");
    }
    if (signed.state === "not_found") throw Error("signer_result_not_found");
    if (signed.state !== "signed") throw Error("signer_result_invalid");
    if (!signed.transaction) throw Error("signer_result_raw_unavailable");
    const signature = assertSignedTransaction(signed as SignerSignResponse);
    const x = this.c.store.transition(row.id, "signing", {
      state: "submitting",
      messageHash: q.request.messageHash,
      signature,
      lastValidBlockHeight: q.lastValidBlockHeight,
    });
    const landed = await this.c.rpc.broadcast(signed.transaction);
    if (landed !== signature) {
      this.c.store.transition(row.id, "submitting", {
        state: "reconciliation-required",
      });
      throw Error("broadcast_signature_mismatch");
    }
    await this.c.reservations?.commit(x.reservationId!);
    return this.c.store.transition(row.id, "submitting", {
      state: "broadcast",
      signature: landed,
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

  /**
   * Settle a broadcast execution without ever re-signing or resubmitting.
   *
   * A signature the cluster has never seen is not yet a failure — until its
   * blockhash passes `lastValidBlockHeight`, at which point it can never land
   * and the execution is `dropped`, terminally.
   */
  async reconcile(id: string) {
    const x = this.require(id);
    if (!x.signature) throw Error("transaction_not_broadcast");
    const status = await this.c.rpc.status(x.signature);
    if (!status) {
      if (
        x.lastValidBlockHeight !== undefined &&
        (await this.c.rpc.blockHeight()) > x.lastValidBlockHeight
      ) {
        if (x.reservationId)
          await this.c.reservations?.release(x.reservationId);
        return this.c.store.transition(id, x.state, { state: "dropped" });
      }
      return x.state === "reconciliation-required"
        ? x
        : this.c.store.transition(id, x.state, {
            state: "reconciliation-required",
          });
    }
    if (status.err)
      return this.c.store.transition(id, x.state, {
        state: "failed",
        signature: x.signature,
        slot: status.slot,
      });
    const final =
      status.confirmationStatus === "finalized" ||
      (this.c.policy.finalityCommitment === "confirmed" &&
        status.confirmationStatus === "confirmed");
    return this.c.store.transition(id, x.state, {
      state: final ? "finalized" : "confirmed",
      signature: x.signature,
      slot: status.slot,
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

/**
 * Prove a signer response is internally consistent before acting on it.
 *
 * The bytes are decoded here and the signature is read off the wire, so a
 * daemon that reported one signature while returning another — or returned
 * unsigned bytes — is caught on this side of the boundary.
 */
function assertSignedTransaction(signed: {
  transaction?: string;
  signature?: string;
}): string {
  if (
    typeof signed?.transaction !== "string" ||
    typeof signed.signature !== "string" ||
    !signed.signature
  )
    throw Error("invalid_signer_response");
  let attached: string;
  try {
    attached = signatureOf(signed.transaction);
  } catch {
    throw Error("invalid_signer_response");
  }
  if (attached !== signed.signature) throw Error("invalid_signer_response");
  return attached;
}

/**
 * The host end of the signer daemon's local socket.
 *
 * Every method returns one of the shared wire types in
 * `src/execution/authorization/wire.ts`, which are derived from
 * `SignerService`'s own signatures. That is the whole point: this class used to
 * speak a protocol the daemon had stopped speaking, and it typechecked
 * perfectly while doing so.
 */
export class UnixSignerClient implements IsolatedSigner {
  constructor(
    private socketPath: string,
    private authorizationToken = "",
    private timeoutMs = 5000,
  ) {}
  private request(payload: unknown) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
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
      !isPublicKey(v.account) ||
      typeof v.cluster !== "string" ||
      !v.cluster ||
      typeof v.policyHash !== "string" ||
      !Number.isSafeInteger(v.policyVersion) ||
      typeof v.authorizationKeyId !== "string" ||
      typeof v.serviceVersion !== "string"
    )
      throw Error("invalid_signer_status");
    return v as unknown as SignerStatus;
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
    transaction: string;
    envelope: AuthorizationEnvelope;
    broadcast?: boolean;
  }): Promise<SignerSignResponse> {
    const v = await this.request({ method: "sign", ...request });
    const signature = assertSignedTransaction(
      v as { transaction?: string; signature?: string },
    );
    if (v.broadcast !== undefined && v.broadcast !== signature)
      throw Error("invalid_signer_response");
    return v as unknown as SignerSignResponse;
  }
  async result(request: {
    authorizationId: string;
    messageHash: string;
    recoverRaw?: boolean;
  }): Promise<SignerResultResponse> {
    const v = await this.request({ method: "result", ...request });
    const state = v?.state;
    if (state === "expired" || state === "not_found") return { state };
    if (state !== "signed" || typeof v.signature !== "string" || !v.signature)
      throw Error("invalid_signer_response");
    // A recovered result may or may not carry the signed bytes; when it does,
    // they must actually carry the signature it reports.
    if (v.transaction !== undefined)
      assertSignedTransaction(
        v as { transaction?: string; signature?: string },
      );
    return v as unknown as SignerResultResponse;
  }
}
