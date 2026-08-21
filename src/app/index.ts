import { CLUSTER_FOR_NETWORK, type AppConfig } from "../config/index.js";
import type { ModelProvider } from "../agent/runtime/index.js";
import { AgentRuntime } from "../agent/runtime/index.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import { SessionStore } from "../storage/session-store.js";
import { DurableRunStore } from "../storage/run-store.js";
import { checkDatabases } from "../storage/maintenance.js";
import {
  perpsPositionReader,
  registerBuiltInTools,
  type BuiltInDependencies,
  type VenueMounts,
} from "../tools/index.js";
import { createModelProvider, RegistryDispatcher } from "./adapters.js";
import {
  CLUSTER_GENESIS_HASHES,
  RpcSimulator,
} from "../execution/rpc-simulator.js";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  JupiterClient,
  SelfRpcBroadcaster,
  SolanaRpc,
} from "../chains/solana/index.js";
import {
  ExecutionStore,
  TradingOrchestrator,
  UnixSignerClient,
  type Commitment,
  type TradingPolicy,
  type TradingRpc,
} from "../live-trading/index.js";
import { registerTradingTools } from "../live-trading/tools.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  buildSimulationRequest,
  createSimulationEvidence,
  type PreparedTransaction,
  type SimulationEvidence,
  type SimulationRequest,
} from "../execution/simulation.js";
import {
  ApprovalEngine,
  canonicalSerialize,
  type DecisionProof,
} from "../execution/approvals/index.js";
import { AuthorizationIssuer } from "../execution/authorization/index.js";
import {
  ProductionRiskEvaluator,
  ReservationLedger,
  type ProductionRiskInput,
} from "../execution/control/index.js";
import { isPublicKey, signatureOf } from "../signer/transaction.js";
import { systemClock } from "../kernel/clock.js";
import { defaultPolicy } from "../kernel/defaults.js";
import { KernelStore } from "../kernel/store.js";
import { TradeGatewayImpl } from "../kernel/trade-gateway.js";
import { USDC_DECIMALS } from "../kernel/money.js";
import type {
  LandMode,
  PolicyConfig,
  SolanaReader,
  ToolContext,
  WalletProvider,
} from "../kernel/contracts.js";
import { PolicyController } from "../control/policy.js";
import { defaultPerpsPolicy, DriftVenue } from "../perps/index.js";
import type { PerpsPolicy } from "../perps/index.js";
import {
  buildUnsignedTx,
  MeteoraDataApi,
  MeteoraDlmmVenue,
  PumpFunClient,
  RealDlmmSdk,
  RpcChainReader,
} from "../pools/index.js";
import { DRIFT_SETTLEMENT_MINT } from "../perps/drift/convert.js";
import { SignalsFeed } from "../data/index.js";
import {
  gatewayExecutor,
  StrategyRunner,
  StrategyStore,
  strategyMint,
} from "../strategy/index.js";

/**
 * The numeric slot {@link ProductionRiskEvaluator} reserves for chain identity.
 *
 * Solana's real cluster identity is a base58 genesis hash, which does not fit
 * the evaluator's `bigint` allowlist, so it is folded into one here: distinct
 * clusters map to distinct numbers and one cluster always maps to the same
 * number. This is a local allowlist key, not a protocol constant. The
 * authoritative cluster checks are the genesis-hash probe in `verify()`, the
 * `SimulationRequest.cluster` comparison in the risk assessor, and the signer's
 * own policy `cluster` field, each independent of this one.
 */
const clusterAllowlistId = (cluster: string) =>
  BigInt(
    `0x${createHash("sha256").update(`solana:cluster:${cluster}`).digest("hex").slice(0, 16)}`,
  );

/** How long a quote may be acted on. Matches the documented CLI window. */
const QUOTE_TTL_MS = 30_000;

/**
 * Baseline tip on quoted transactions. Not a safety control: the signer's own
 * policy caps compute-unit price and the resulting priority fee, and refuses
 * anything above it inside its own process.
 */
const QUOTE_PRIORITY_FEE_LAMPORTS = 200_000;

/**
 * Lamports that must remain after the transaction fee. Solana charges rent for
 * new token accounts on top of the fee, so a wallet trading its last lamports
 * cannot settle; this is the same headroom the kernel gateway keeps.
 */
const NATIVE_FEE_RESERVE_LAMPORTS = 3_000_000n;

/**
 * How far behind the tip a quote's context slot may be. A recent blockhash
 * lives ~150 slots, so a quote older than that describes a transaction that can
 * no longer land. There is deliberately no configurable confirmation depth to
 * pair with this: finality on Solana is a commitment level, not a count.
 */
const MAX_QUOTE_SLOT_LAG = 150n;

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** SPL Token `Revoke` — a one-byte instruction that can only reduce a delegate. */
const SPL_REVOKE_DISCRIMINATOR = "05";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/**
 * Solana has no router. The evaluator's single-valued `router` slot has no
 * analogue, so it is pinned on both sides and the check that actually matters —
 * every program the transaction invokes must be in the operator's signer-policy
 * allowlist — is evaluated explicitly and merged into the same decision. The
 * signer re-checks it independently inside its own process; this is defence in
 * depth, not the authority.
 */
const ROUTER_UNUSED = "solana:no-router";

export type DependencyHealth = {
  status: "available" | "unconfigured" | "unhealthy";
};
export interface ApplicationHealth {
  status: "ok" | "unavailable";
  readOnly: boolean;
  network: AppConfig["network"];
  dependencies: {
    sessions: DependencyHealth;
    runs: DependencyHealth;
    model: DependencyHealth & { provider: string };
    rpc: DependencyHealth;
    simulation: DependencyHealth;
    market: DependencyHealth;
    trading: DependencyHealth;
  };
}
/**
 * What the operator console reads and writes.
 *
 * `policy` is the live handle the money path re-reads, so the console's kill
 * switch and dry-run toggle are the real ones. `kernel()` opens the kernel
 * database LAZILY — a process that never serves a dashboard never opens a
 * second SQLite handle — and returns the venue composition's store when one is
 * already open, so there is never a second writer.
 */
export interface ControlSurface {
  policy: PolicyController;
  /** base58 pubkey when custody is mounted; null in the default daemon. */
  walletAddress: string | null;
  /** Chain reads for the wallet panel; absent when custody is unmounted. */
  balances?: SolanaReader;
  kernel(): KernelStore | undefined;
  /**
   * Autonomous strategies, when a venue composition mounted them. Absent in the
   * default daemon (no custody ⇒ no runner ⇒ nothing to schedule), and the
   * console reports that rather than rendering an empty list as "none running".
   */
  strategies?: StrategyStore;
  strategyRunner?: StrategyRunner;
  /** The trade tape + rug-heat engine, when mounted. */
  signals?: SignalsFeed;
}

export interface Application {
  start(): Promise<void>;
  ready(): boolean;
  stop(): Promise<void>;
  health(): Promise<ApplicationHealth>;
  registry: ToolRegistry;
  runtime: AgentRuntime;
  runs: DurableRunStore;
  trading?: TradingOrchestrator;
  /** The operator console's view of this process. Always present. */
  control: ControlSurface;
}
export interface TradingComposition {
  trading: TradingOrchestrator;
  store: ExecutionStore;
  /** The read side of the cluster this composition was built on. */
  client: SolanaRpc;
  cluster: string;
  signer?: UnixSignerClient;
  approvals?: ApprovalEngine;
  authorization?: AuthorizationIssuer;
  reservations?: ReservationLedger;
  riskEvaluator?: ProductionRiskEvaluator;
  risk?: {
    assess(
      x: unknown,
    ): Promise<{ hash: string; allowed: boolean; reasons: string[] }>;
  };
  verify(): Promise<void>;
  close(): void;
}

/** SPL Token `Revoke`: clears the delegate on one token account. */
function revokeInstruction(tokenAccount: string, owner: string) {
  return new TransactionInstruction({
    programId: new PublicKey(SPL_TOKEN_PROGRAM_ID),
    keys: [
      {
        pubkey: new PublicKey(tokenAccount),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([Number.parseInt(SPL_REVOKE_DISCRIMINATOR, 16)]),
  });
}

/**
 * The operator's program allowlist, read straight out of the signer policy.
 *
 * Deliberately a narrow read rather than a full `loadSignPolicy` (which is
 * async, and whose validation belongs to the signer). An unreadable or
 * non-Solana policy yields an empty list, which refuses every swap — the
 * host-side check fails closed rather than degrading to "anything goes".
 */
function allowedPrograms(path: string | undefined): ReadonlySet<string> {
  if (!path) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      programs?: { programId?: unknown }[];
    };
    return new Set(
      (parsed.programs ?? [])
        .map((p) => p?.programId)
        .filter((p): p is string => isPublicKey(p)),
    );
  } catch {
    return new Set();
  }
}

export function createTradingComposition(
  config: AppConfig,
  fetchFn?: typeof fetch,
): TradingComposition | undefined {
  if (!config.trading || !config.rpc) return undefined;
  const t = config.trading,
    cluster: string = CLUSTER_FOR_NETWORK[config.network],
    store = new ExecutionStore(config.paths.executions);
  const connection = new Connection(config.rpc.url, {
    commitment: "confirmed",
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  const solana = new SolanaRpc(connection),
    jupiter = new JupiterClient(),
    broadcaster = new SelfRpcBroadcaster(solana);
  const rpcCall = async (method: string, params: unknown[]) => {
    const response = await (fetchFn ?? fetch)(config.rpc!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (payload.error) throw Error(payload.error.message ?? "rpc error");
    return payload.result;
  };
  const policy: TradingPolicy = {
    version: 1,
    maxAmountIn: t.maxAmountIn,
    maxSlippageBps: t.maxSlippageBps,
    approvalRequired: true,
    // Solana has no confirmation depth to count. `finalized` is rooted state and
    // is the only setting that cannot be rolled back, so it is the default until
    // an operator can express the weaker choice in configuration.
    finalityCommitment: "finalized" as Commitment,
    allowedMints: t.allowedTokens,
  };
  const policyHash = createHash("sha256")
    .update(
      JSON.stringify(policy, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    )
    .digest("hex");
  const simulator = new RpcSimulator({
    url: config.rpc.url,
    cluster,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  /**
   * Decode one built transaction into an exact simulation request and prove it
   * executes. Everything downstream — approval, authorization, the signer's own
   * re-check — is bound to the bytes pinned here.
   */
  const pin = async (
    built: PreparedTransaction,
  ): Promise<{
    request: SimulationRequest;
    evidence: SimulationEvidence;
    slot: bigint;
  }> => {
    const request = buildSimulationRequest(built, policyHash),
      result = await simulator.simulate(request);
    if (!result.success)
      throw Error(`simulation failed: ${result.err ?? "failed"}`);
    return {
      request,
      evidence: createSimulationEvidence(request, result),
      slot: result.slot,
    };
  };
  const rpc: TradingRpc = {
    balance: async (owner, mint) =>
      mint ? solana.readBalance(owner, mint) : solana.getSolLamports(owner),
    quote: async (x) => {
      // The orchestrator has already clamped slippage to policy; clamping again
      // here means a caller that reaches this port directly cannot widen it.
      const slippageBps = Math.min(
        Number((x as { slippageBps?: number }).slippageBps ?? t.maxSlippageBps),
        t.maxSlippageBps,
      );
      const quoted = await jupiter.quote({
        inputMint: x.inputMint,
        outputMint: x.outputMint,
        amount: x.amountIn,
        slippageBps,
      });
      const built = await jupiter.buildSwap({
        quote: quoted,
        userPublicKey: t.account,
        priorityFeeLamports: QUOTE_PRIORITY_FEE_LAMPORTS,
      });
      const { request, evidence, slot } = await pin({
        cluster,
        transaction: built.swapTransactionB64,
        lastValidBlockHeight: built.lastValidBlockHeight,
      });
      return {
        amountOut: quoted.outAmount,
        slot:
          quoted.contextSlot === undefined ? slot : BigInt(quoted.contextSlot),
        lastValidBlockHeight: built.lastValidBlockHeight,
        expiresAt: Date.now() + QUOTE_TTL_MS,
        route: quoted.routeLabel,
        request,
        evidence,
      };
    },
    revokeQuote: async ({ tokenAccount, owner }) => {
      const latest = await connection.getLatestBlockhash("confirmed");
      const built = buildUnsignedTx({
        payer: new PublicKey(owner),
        instructions: [revokeInstruction(tokenAccount, owner)],
        recentBlockhash: latest.blockhash,
        priorityFeeLamports: QUOTE_PRIORITY_FEE_LAMPORTS,
      });
      const { request, evidence, slot } = await pin({
        cluster,
        transaction: built.unsignedTxBase64,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      return {
        amountOut: 0n,
        slot,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        expiresAt: Date.now() + QUOTE_TTL_MS,
        request,
        evidence,
      };
    },
    simulate: async (request) => {
      const exact = request as SimulationRequest;
      return createSimulationEvidence(exact, await simulator.simulate(exact));
    },
    broadcast: async (wire) =>
      (
        await broadcaster.broadcast(
          { wireBase64: wire, signature: signatureOf(wire) },
          undefined,
        )
      ).signature,
    status: async (signature) => {
      const s = (await connection.getSignatureStatuses([signature])).value[0];
      if (!s) return null;
      return {
        slot: BigInt(s.slot),
        confirmationStatus: (s.confirmationStatus ?? "processed") as Commitment,
        err: s.err,
      };
    },
    blockHeight: () => connection.getBlockHeight("confirmed"),
  };
  let signer: UnixSignerClient | undefined;
  if (t.liveEnabled && t.signerSocketPath) {
    const token = t.signerTokenPath
      ? readFileSync(t.signerTokenPath, "utf8").trim()
      : undefined;
    signer = new UnixSignerClient(t.signerSocketPath, token);
  }
  // Revoke executions reserve no capital, but the authorization issuer
  // still requires a reservation reference that was minted by this
  // composition for the exact quote being submitted.
  const revokeReservations = new Set<string>();
  let approvals: ApprovalEngine | undefined,
    authorization: AuthorizationIssuer | undefined,
    reservations: ReservationLedger | undefined,
    riskEvaluator: ProductionRiskEvaluator | undefined,
    risk:
      | {
          assess(
            x: unknown,
          ): Promise<{ hash: string; allowed: boolean; reasons: string[] }>;
        }
      | undefined;
  if (t.liveEnabled) {
    if (
      !signer ||
      !t.approvalOperators?.length ||
      !t.approvalOperatorConfigVersion ||
      !t.authorizationKeyId ||
      !t.authorizationKeyPath
    )
      throw Error("live capital controls are not configured");
    const operatorKeys = new Map(
      t.approvalOperators.map((o) => [
        o.id,
        readFileSync(o.keyPath, "utf8").trim(),
      ]),
    );
    if ([...operatorKeys.values()].some((k) => !k))
      throw Error("approval operator key is empty");
    approvals = new ApprovalEngine(config.paths.approvals, {
      operators: t.approvalOperators.map((o) => ({
        id: o.id,
        roles: ["approver"],
        scopes: ["sign"],
      })),
      operatorConfigVersion: t.approvalOperatorConfigVersion,
      verifyDecisionProof: (p: DecisionProof) => {
        const key = operatorKeys.get(p.operatorId);
        if (!key) return false;
        const body = {
          requestId: p.requestId,
          operator: p.operatorId,
          decision: p.decision,
          challenge: p.challenge,
          expectedRevision: p.revision,
          ...(p.reason ? { reason: p.reason } : {}),
          nonce: p.nonce,
          timestamp: p.timestamp,
        };
        const expected = createHmac("sha256", key)
          .update(JSON.stringify(body))
          .digest();
        let supplied: Buffer;
        try {
          supplied = Buffer.from(p.proof!, "hex");
        } catch {
          return false;
        }
        return (
          supplied.length === expected.length &&
          timingSafeEqual(supplied, expected)
        );
      },
    });
    reservations = new ReservationLedger(config.paths.reservations);
    const riskHashes = new Set<string>(),
      simulationHashes = new Set<string>();
    const perMint = Object.fromEntries(
      t.allowedTokens.map((mint) => [mint, t.maxAmountIn]),
    );
    const programs = allowedPrograms(t.signerPolicyPath);
    riskEvaluator = new ProductionRiskEvaluator({
      chains: [clusterAllowlistId(cluster)],
      accounts: [t.account],
      routers: [ROUTER_UNUSED],
      tokens: t.allowedTokens,
      maxPerTrade: perMint,
      maxReservedPerToken: perMint,
      maxSlippageBps: BigInt(t.maxSlippageBps),
      maxQuoteAge: 30n,
      maxQuoteBlocks: MAX_QUOTE_SLOT_LAG,
      nativeGasReserve: NATIVE_FEE_RESERVE_LAMPORTS,
    });
    const canonicalRisk = (value: unknown): string =>
      canonicalSerialize(
        JSON.parse(
          JSON.stringify(value, (_k, v) =>
            typeof v === "bigint" ? { $bigint: v.toString() } : v,
          ),
        ),
      );
    const hashRisk = (
      input: unknown,
      decision: { allowed: boolean; reasons: string[] },
    ) => {
      const hash = createHash("sha256")
        .update("production-risk-v2\0")
        .update(canonicalRisk({ input, decision }))
        .digest("hex");
      if (decision.allowed) riskHashes.add(hash);
      return { hash, ...decision };
    };
    /** Every program the transaction invokes must be pinned by the operator. */
    const programsAllowed = (r: SimulationRequest) =>
      r.programIds.length > 0 && r.programIds.every((p) => programs.has(p));
    risk = {
      assess: async (raw) => {
        try {
          const wrapped = raw as any;
          if (
            wrapped?.quote?.side === "revoke" &&
            wrapped?.request &&
            wrapped?.evidence
          ) {
            // A revoke carries zero capital exposure, so the swap risk
            // evaluator does not apply. It is still assessed: the pinned
            // transaction must be exactly SPL Token `Revoke` on the quoted
            // token account, owned by the trading account, on a blockhash that
            // can still land, before it earns a risk hash the authorization
            // issuer will accept.
            const q = wrapped.quote,
              r = wrapped.request as SimulationRequest,
              reasons: string[] = [];
            const spend = r.instructions.filter(
              (i) => i.programId !== COMPUTE_BUDGET_PROGRAM_ID,
            );
            if (r.cluster !== cluster) reasons.push("cluster_not_allowed");
            if (r.feePayer !== t.account) reasons.push("account_not_allowed");
            if (!programsAllowed(r)) reasons.push("program_not_allowed");
            if (spend.length !== 1)
              reasons.push("revoke_instruction_count_invalid");
            const ix = spend[0];
            if (ix && ix.programId !== SPL_TOKEN_PROGRAM_ID)
              reasons.push("revoke_program_mismatch");
            if (ix && ix.data !== SPL_REVOKE_DISCRIMINATOR)
              reasons.push("revoke_instruction_mismatch");
            if (ix && ix.accounts[0] !== q.inputMint)
              reasons.push("revoke_target_mismatch");
            if (ix && ix.accounts[1] !== t.account)
              reasons.push("revoke_owner_mismatch");
            if (
              (wrapped.evidence.assetDeltas ?? []).some(
                (d: { asset: string }) => d.asset !== "native",
              )
            )
              reasons.push("revoke_moves_assets");
            if (q.expiresAt <= Date.now()) reasons.push("quote_stale");
            if ((await rpc.blockHeight()) > q.lastValidBlockHeight)
              reasons.push("quote_blockhash_expired");
            return hashRisk(
              {
                kind: "revoke",
                cluster,
                account: t.account,
                tokenAccount: q.inputMint,
                messageHash: r.messageHash,
              },
              { allowed: !reasons.length, reasons },
            );
          }
          if (wrapped?.quote && wrapped?.request && wrapped?.evidence) {
            const q = wrapped.quote,
              r = wrapped.request as SimulationRequest,
              e = wrapped.evidence as SimulationEvidence,
              now = BigInt(Math.floor(Date.now() / 1000));
            const [currentSlot, blockHeight, mintBalance, nativeBalance] =
              await Promise.all([
                connection.getSlot("confirmed"),
                rpc.blockHeight(),
                rpc.balance(t.account, q.inputMint),
                rpc.balance(t.account),
              ]);
            // Solana has no canonical-block-hash comparison. The equivalent
            // liveness fact is whether the quote's recent blockhash can still
            // land, so the two hashes agree exactly while it can and diverge
            // the moment it cannot — leaving `quote_noncanonical` meaning
            // precisely "this transaction is already dead".
            const alive = blockHeight <= q.lastValidBlockHeight;
            const input: ProductionRiskInput = {
              now,
              chain: clusterAllowlistId(cluster),
              account: r.feePayer,
              router: ROUTER_UNUSED,
              tokenIn: q.inputMint,
              tokenOut: q.outputMint,
              amountIn: q.amountIn,
              slippageBps: BigInt(q.slippageBps),
              quoteAt: BigInt(Math.floor((q.expiresAt - QUOTE_TTL_MS) / 1000)),
              quoteBlock: q.slot,
              currentBlock: BigInt(currentSlot),
              quoteBlockHash: r.recentBlockhash,
              canonicalBlockHash: alive ? r.recentBlockhash : "expired",
              tokenBalance: mintBalance,
              nativeBalance,
              estimatedGasCost: e.feeLamports,
            };
            const verdict = riskEvaluator!.evaluate(
              input,
              reservations!.entries(input.now),
            );
            const reasons = [...verdict.reasons];
            if (r.cluster !== cluster) reasons.push("cluster_not_allowed");
            if (!programsAllowed(r)) reasons.push("program_not_allowed");
            return hashRisk(input, {
              allowed: reasons.length === 0,
              reasons,
            });
          }
          const input = raw as ProductionRiskInput;
          return hashRisk(
            input,
            riskEvaluator!.evaluate(input, reservations!.entries(input.now)),
          );
        } catch {
          return hashRisk(raw, {
            allowed: false,
            reasons: ["risk_inputs_unavailable"],
          });
        }
      },
    };
    const authorizationKey = readFileSync(
      t.authorizationKeyPath,
      "utf8",
    ).trim();
    if (!authorizationKey) throw Error("authorization key is empty");
    authorization = new AuthorizationIssuer({
      signerKeyId: t.authorizationKeyId,
      signer: {
        sign: async (data) =>
          createHmac("sha256", authorizationKey).update(data).digest("hex"),
      },
      checks: {
        quote: async (hash) => !!store.findQuoteByHash(hash),
        policy: async (hash) => hash === policyHash,
        risk: async (hash) => riskHashes.has(hash),
        reservation: async (id) =>
          reservations!.has(id) || revokeReservations.has(id),
        approval: async (id) => approvals!.get(id)?.status === "consumed",
        simulation: async (hash) => simulationHashes.has(hash),
        // Solana's replay fence. The issuer refuses when the cluster has
        // already passed the transaction's `lastValidBlockHeight`, so no
        // authorization is ever minted for a transaction that cannot land.
        blockhash: async (c) =>
          c === cluster ? await rpc.blockHeight() : false,
      },
    });
    const originalSimulate = rpc.simulate;
    rpc.simulate = async (request) => {
      const evidence = await originalSimulate(request);
      simulationHashes.add((evidence as SimulationEvidence).hash);
      return evidence;
    };
  }
  const reservationAdapter = reservations
    ? {
        reserve: async (x: any) => {
          const q = store.findQuoteByHash(x.quoteHash);
          if (!q) throw Error("reservation_quote_missing");
          if (q.side === "revoke") {
            const revokeId = createHash("sha256")
              .update(`revoke-reservation-v1\0${x.quoteHash}\0${x.messageHash}`)
              .digest("hex");
            revokeReservations.add(revokeId);
            return revokeId;
          }
          const id = createHash("sha256")
            .update(`reservation-v1\0${x.quoteHash}\0${x.messageHash}`)
            .digest("hex");
          if (
            !reservations!.reserveWithin(
              {
                id,
                at: BigInt(Math.floor(Date.now() / 1000)),
                asset: q.inputMint,
                strategy: "live",
                amount: q.amountIn,
              },
              {
                // Input-leg base units: this cap is evaluated and inserted under
                // one BEGIN IMMEDIATE transaction. Aggregate exposure is
                // disabled until the adapter has explicit normalized quote
                // valuation evidence.
                perAsset:
                  riskEvaluator!.limits.maxReservedPerToken[q.inputMint] ?? 0n,
              },
            )
          )
            throw Error("reservation_failed");
          return id;
        },
        valid: async (id: string) =>
          revokeReservations.has(id) || reservations!.has(id),
        commit: async (id: string) =>
          revokeReservations.delete(id) || reservations!.commit(id),
        release: async (id: string) =>
          revokeReservations.delete(id) || reservations!.release(id),
      }
    : undefined;
  const trading = new TradingOrchestrator({
    cluster,
    account: t.account,
    policy: { ...policy, hash: policyHash },
    rpc,
    store,
    ...(signer ? { signer } : {}),
    ...(approvals ? { approvalEngine: approvals } : {}),
    ...(authorization ? { authorizationIssuer: authorization } : {}),
    ...(risk ? { risk } : {}),
    ...(reservationAdapter ? { reservations: reservationAdapter } : {}),
    ...(t.authorizationKeyId ? { audience: "signer" } : {}),
    liveEnabled: t.liveEnabled,
  });
  return {
    trading,
    store,
    client: solana,
    cluster,
    ...(signer ? { signer } : {}),
    ...(approvals ? { approvals } : {}),
    ...(authorization ? { authorization } : {}),
    ...(reservations ? { reservations } : {}),
    ...(riskEvaluator ? { riskEvaluator } : {}),
    ...(risk ? { risk } : {}),
    async verify() {
      // The genesis hash is the only self-describing cluster identity Solana
      // has; it replaces the EVM chain-id and contract-bytecode probes.
      const expectedGenesis = CLUSTER_GENESIS_HASHES[cluster];
      const genesis = await rpcCall("getGenesisHash", []);
      if (expectedGenesis && genesis !== expectedGenesis)
        throw Error("rpc_cluster_mismatch");
      if (signer) {
        let status;
        try {
          status = await signer.status();
        } catch {
          throw Error("signer_unavailable");
        }
        const expectedPolicyHash = `0x${createHash("sha256").update(readFileSync(t.signerPolicyPath!, "utf8")).digest("hex")}`;
        // base58 is case-sensitive: two keys differing only in case are two
        // different wallets, so this comparison is exact.
        if (status.account !== t.account)
          throw Error("signer_account_mismatch");
        if (status.cluster !== cluster) throw Error("signer_cluster_mismatch");
        if (
          status.policyHash.toLowerCase() !== expectedPolicyHash.toLowerCase()
        )
          throw Error("signer_policy_hash_mismatch");
        if (status.policyVersion !== policy.version)
          throw Error("signer_policy_version_mismatch");
        if (status.authorizationKeyId !== t.authorizationKeyId)
          throw Error("signer_authorization_key_id_mismatch");
      }
    },
    close() {
      approvals?.close();
      reservations?.close();
      store.close();
    },
  };
}

/**
 * Everything the venue-backed toolsets need beyond a `ToolContext`, plus the
 * kernel store and position reader the money path is built on.
 *
 * Mounting is gated on a {@link WalletProvider} because a venue tool that
 * cannot reach a Solana wallet has nothing to build an intent for. Custody in
 * production is the isolated signer daemon, whose `sign` takes an authorization
 * envelope rather than raw bytes, so no `WalletProvider` is derived from it
 * here: until that bridge exists the composition supplies none, the venue tools
 * are not registered, and the tools simply do not exist. That is the correct
 * default — an unmounted venue must not be reachable.
 */
interface VenueComposition {
  mounts: VenueMounts;
  store: KernelStore;
  /** The read side of the cluster, for the operator console's wallet panel. */
  reader: SolanaReader;
  /**
   * The PumpPortal trade tape and the rug-heat engine read off it. Mounted
   * unconditionally so `guardRugHeat` always has a source; started by
   * {@link Application.start} because opening a socket is a lifecycle event,
   * not a constructor side effect.
   */
  signals: SignalsFeed;
  /** Autonomous strategies. Every trade they propose goes through `gateway`. */
  strategies: StrategyStore;
  strategyRunner: StrategyRunner;
}

/**
 * The kernel policy this process boots with.
 *
 * Built once and handed to a {@link PolicyController} so the operator console
 * and the money path read the SAME object — a kill switch the console engages
 * has to be the kill switch `staticGuards` re-reads, or it is theatre.
 *
 * The mint allowlist is only adopted when every configured entry is a real
 * base58 mint. `src/config/` still validates EVM addresses, and quietly turning
 * those into a Solana allowlist would refuse everything for a reason no
 * operator could read. Spend caps and the signer policy still bind.
 */
function kernelPolicyFor(config: AppConfig): PolicyConfig {
  const configuredMints = config.trading?.allowedTokens ?? [];
  const mintAllowlist =
    configuredMints.length > 0 && configuredMints.every(isPublicKey)
      ? [...configuredMints]
      : null;
  return {
    ...defaultPolicy(),
    executionEnabled: config.trading?.liveEnabled ?? false,
    ...(config.trading
      ? { maxSlippageBps: config.trading.maxSlippageBps }
      : {}),
    mintAllowlist,
  };
}

function createVenueComposition(
  config: AppConfig,
  wallet: WalletProvider,
  policyController: PolicyController,
): VenueComposition | undefined {
  if (!config.rpc || !isPublicKey(wallet.pubkey)) return undefined;
  const cluster = CLUSTER_FOR_NETWORK[config.network];
  const connection = new Connection(config.rpc.url, "confirmed");
  const solana = new SolanaRpc(connection),
    jupiter = new JupiterClient(),
    chain = new RpcChainReader(connection),
    kernelStore = new KernelStore(join(config.dataDir, "kernel.sqlite"));
  const broadcaster = new SelfRpcBroadcaster(solana);
  const broadcasters: Record<LandMode, SelfRpcBroadcaster> = {
    "jupiter-ultra": broadcaster,
    "self-rpc": broadcaster,
  };
  // The mint allowlist is only adopted when every configured entry is a real
  // base58 mint. `src/config/` still validates EVM addresses, and quietly
  // turning those into a Solana allowlist would refuse everything for a reason
  // no operator could read. Spend caps and the signer policy still bind.
  const perps = {
    venue: new DriftVenue({
      connection,
      publicKey: new PublicKey(wallet.pubkey),
      owner: wallet.pubkey,
      blockhash: {
        latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
      },
      env:
        cluster === "mainnet-beta"
          ? ("mainnet-beta" as const)
          : ("devnet" as const),
    }),
    // `perpsEnabled` is false in the default policy, so perps tools read and
    // propose but every opening guard refuses until an operator arms them.
    policy: (): PerpsPolicy => defaultPerpsPolicy(),
    // The console's kill switch is one switch: it must stop the venue path as
    // well as the swap path, so both read the same live policy.
    killSwitch: () => policyController.get().killSwitch,
    executionEnabled: () => policyController.get().executionEnabled,
    collateral: () => ({
      mint: DRIFT_SETTLEMENT_MINT,
      decimals: USDC_DECIMALS,
    }),
  };
  const positions = perpsPositionReader({ perps });
  // From here the policy is live: the gateway re-reads it at the metal on every
  // execute, so the console's toggles change what this process will actually
  // do rather than just what it displays.
  policyController.markEnforced();
  const gateway = new TradeGatewayImpl({
    store: kernelStore,
    wallet,
    policy: () => policyController.get(),
    mints: solana,
    balances: solana,
    simulator: solana,
    broadcasters,
    confirmer: solana,
    clock: systemClock,
    // Without this the gateway refuses every perp intent with
    // SETTLE_UNVERIFIABLE — a perp fill cannot be read off a token balance.
    ...(positions ? { positions } : {}),
  });
  // The trade tape and its rug-heat engine. Constructed here and mounted on the
  // pools tools BEFORE anything can trade, because `guardRugHeat` refuses on a
  // missing reading — an unmounted engine means no curve buys at all. Mounting
  // it is not a relaxation: over an empty tape it still scores 60/100 ("no
  // trades in window"), which is at the default rejection threshold. Only
  // observed trades can produce a passing reading.
  const signals = new SignalsFeed();
  // Autonomous strategies. `gatewayExecutor` is the ONLY executor mounted, and
  // its only route to value movement is `gateway.execute` — the same chokepoint
  // the tools use, with the same guards, caps, journal and kill switch.
  const strategies = new StrategyStore(
    join(config.dataDir, "strategies.sqlite"),
  );
  const strategyRunner = new StrategyRunner(
    strategies,
    gatewayExecutor({
      gateway,
      jupiter,
      solana,
      ownerWallet: wallet.pubkey,
      // The only deterministic pin this process owns. A strategy on a mint the
      // operator has not pinned produces an `untrusted` intent, which the
      // kernel refuses with MINT_NOT_PINNED — the runner never asserts consent
      // on the operator's behalf.
      pinnedMints: () => policyController.get().mintAllowlist,
    }),
  );
  const toolContext: ToolContext = {
    ownerWallet: wallet.pubkey,
    rpcUrl: config.rpc.url,
    services: { solana, jupiter },
    gateway,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    signal: undefined,
  };
  return {
    store: kernelStore,
    reader: solana,
    signals,
    strategies,
    strategyRunner,
    mounts: {
      // `confirmedByUser` is deliberately unwired: this process has no
      // per-invocation human-confirmation channel, and the default of `false`
      // means untrusted-provenance mints are refused rather than waved through.
      runtime: { context: () => toolContext },
      perps,
      pools: {
        venue: new MeteoraDlmmVenue({
          sdk: new RealDlmmSdk(connection),
          api: new MeteoraDataApi(),
          chain,
        }),
        curve: new PumpFunClient(chain),
        chain,
        // The rug-heat source `guardRugHeat` reads. See the comment where the
        // feed is constructed: mounted always, informed only while it runs.
        signals: signals.engine,
        // Warm the tape for a mint on the read path, so the NEXT attempt has a
        // measurement instead of the illiquidity default.
        watch: (mint: string) => signals.watch(mint),
      },
    },
  };
}

export function createApplication(
  config: AppConfig,
  overrides: {
    modelProvider?: ModelProvider;
    tools?: BuiltInDependencies;
    rpcFetch?: typeof fetch;
    /** Transport for the configured LLM endpoint. Defaults to global fetch. */
    llmFetch?: typeof fetch;
    /**
     * Custody for the venue-backed toolsets. Omitted (the default) the perps
     * and liquidity tools are not registered at all.
     */
    wallet?: WalletProvider;
  } = {},
): Application {
  let state: "created" | "starting" | "ready" | "stopped" = "created",
    rpcHealthy = !config.rpc,
    tradingHealthy = true;
  let sessions: SessionStore | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined,
    reconciliationRunning = false;
  const runs = new DurableRunStore(config.paths.runs);
  let composed: BuiltInDependencies = {};
  if (config.rpc) {
    const simulator = new RpcSimulator({
      url: config.rpc.url,
      cluster: config.rpc.cluster,
      ...(overrides.rpcFetch ? { fetch: overrides.rpcFetch } : {}),
    });
    composed = {
      market: {
        networks: async () => [
          { id: config.rpc!.cluster, name: config.network },
        ],
      },
      simulation: { simulate: (input) => simulator.simulate(input) },
    };
  }
  const policyController = new PolicyController(kernelPolicyFor(config), {
    // The boot-time triple opt-in in `src/config/` is the ceiling. A browser
    // session can lower authority but never raise it past what the process was
    // started with.
    canArm: config.trading?.liveEnabled ?? false,
  });
  const venues = overrides.wallet
    ? createVenueComposition(config, overrides.wallet, policyController)
    : undefined;
  // Opened only if something actually asks for it (the console), and never
  // twice: when the venue composition already holds the kernel, that instance
  // is the one handed out.
  let lazyKernel: KernelStore | undefined;
  const control: ControlSurface = {
    policy: policyController,
    walletAddress: overrides.wallet?.pubkey ?? null,
    ...(venues ? { balances: venues.reader } : {}),
    ...(venues
      ? {
          strategies: venues.strategies,
          strategyRunner: venues.strategyRunner,
          signals: venues.signals,
        }
      : {}),
    kernel() {
      if (venues) return venues.store;
      if (state === "stopped") return undefined;
      if (!lazyKernel)
        lazyKernel = new KernelStore(join(config.dataDir, "kernel.sqlite"));
      return lazyKernel;
    },
  };
  const registry = registerBuiltInTools(new ToolRegistry(), {
    ...composed,
    ...overrides.tools,
    market: { ...composed.market, ...overrides.tools?.market },
    ...(venues ? { venues: venues.mounts } : {}),
  });
  const tc = createTradingComposition(config, overrides.rpcFetch);
  if (tc) registerTradingTools(registry, tc.trading);
  const capabilities = [
    TRADING_CAPABILITIES.MARKET_DATA,
    TRADING_CAPABILITIES.RISK_ANALYSIS,
    TRADING_CAPABILITIES.ORDER_SIMULATE,
    // Granting a capability only makes a registered tool dispatchable; the
    // gateway, the guards and the signer still decide whether anything moves.
    ...(tc || venues
      ? [TRADING_CAPABILITIES.ORDER_WRITE, TRADING_CAPABILITIES.PORTFOLIO_READ]
      : []),
    ...(venues ? [TRADING_CAPABILITIES.POSITION_WRITE] : []),
  ];
  // An explicit override wins (tests, the smoke check, an embedder supplying
  // its own planner); otherwise the configured endpoint is built here, once
  // the registry is complete so the candidate can declare the real tool set.
  // With neither, the provider is a stub that throws — a process with no model
  // still serves tools, health and the console, it just cannot plan.
  const provider =
    overrides.modelProvider ??
    (config.llm
      ? createModelProvider(config.llm, registry, {
          capabilities,
          ...(overrides.llmFetch ? { fetch: overrides.llmFetch } : {}),
        })
      : {
          id: "unconfigured",
          complete: async () => {
            throw Error("Model provider is not configured");
          },
        });
  const runtime = new AgentRuntime({
    providers: [provider],
    tools: new RegistryDispatcher(registry, capabilities),
  });
  return {
    registry,
    runtime,
    runs,
    control,
    ...(tc ? { trading: tc.trading } : {}),
    async start() {
      if (state === "ready") return;
      sessions = new SessionStore(config.paths.sessions);
      if (config.rpc) {
        // Readiness means "this endpoint is the cluster this process was
        // configured for", not merely "this endpoint answers". The genesis hash
        // is the only self-describing cluster identity Solana has, so an
        // endpoint that responds but reports a different cluster — a devnet URL
        // left in a mainnet deployment — is unhealthy, exactly as a mismatched
        // chain id used to be. An endpoint whose hash is unknown to
        // CLUSTER_GENESIS_HASHES is also unhealthy: unrecognised is not a pass.
        try {
          const response = await (overrides.rpcFetch ?? fetch)(config.rpc.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getGenesisHash",
              params: [],
            }),
          });
          if (!response.ok) throw Error("rpc probe failed");
          const payload = (await response.json()) as { result?: string };
          if (payload.result !== CLUSTER_GENESIS_HASHES[config.rpc.cluster])
            throw Error("rpc cluster mismatch");
          rpcHealthy = true;
        } catch {
          rpcHealthy = false;
        }
      }
      if (tc)
        try {
          await tc.verify();
          await tc.trading.recoverAndReconcile();
          reconciliationTimer = setInterval(async () => {
            if (reconciliationRunning) return;
            reconciliationRunning = true;
            try {
              await tc.trading.recoverAndReconcile();
            } finally {
              reconciliationRunning = false;
            }
          }, config.trading!.reconcileIntervalMs);
          reconciliationTimer.unref();
        } catch {
          tradingHealthy = false;
        }
      if (venues) {
        // Opening the keyless PumpPortal socket is a network side effect, so it
        // belongs to `start()` rather than to composition. Once it is running,
        // `guardRugHeat` has observed trades to read instead of the
        // no-trades-in-window default that refuses every curve buy.
        venues.signals.start();
        // Follow the mints the persisted strategies already name, so a restart
        // does not lose the tape that made their next trade decidable.
        for (const row of venues.strategies.all()) {
          const mint = strategyMint(row);
          if (mint) venues.signals.watch(mint);
        }
        venues.strategyRunner.start();
      }
      state = "ready";
    },
    ready() {
      return (
        state === "ready" &&
        (!config.rpc || rpcHealthy) &&
        (!config.trading || tradingHealthy)
      );
    },
    async stop() {
      if (state === "stopped") return;
      if (reconciliationTimer) clearInterval(reconciliationTimer);
      tc?.close();
      venues?.strategyRunner.stop();
      venues?.strategies.close();
      venues?.signals.stop();
      venues?.store.close();
      lazyKernel?.close();
      lazyKernel = undefined;
      sessions?.close();
      runs.close();
      state = "stopped";
    },
    async health() {
      let db = true;
      try {
        checkDatabases([config.paths.sessions, config.paths.runs]);
      } catch {
        db = false;
      }
      const rpcStatus: DependencyHealth = config.rpc
        ? { status: rpcHealthy ? "available" : "unhealthy" }
        : { status: "unconfigured" };
      return {
        status: this.ready() ? "ok" : "unavailable",
        readOnly: config.execution === "read-only",
        network: config.network,
        dependencies: {
          sessions: { status: db ? "available" : "unhealthy" },
          runs: { status: db ? "available" : "unhealthy" },
          model: {
            status:
              overrides.modelProvider || config.llm
                ? "available"
                : "unconfigured",
            provider: provider.id,
          },
          rpc: rpcStatus,
          simulation: config.rpc ? rpcStatus : { status: "unconfigured" },
          market: config.rpc
            ? { status: "available" }
            : { status: "unconfigured" },
          trading: config.trading
            ? { status: tradingHealthy ? "available" : "unhealthy" }
            : { status: "unconfigured" },
        },
      };
    },
  };
}
