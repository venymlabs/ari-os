import type { AppConfig } from "../config/index.js";
import type { ModelProvider } from "../agent/runtime/index.js";
import { AgentRuntime } from "../agent/runtime/index.js";
import { ToolRegistry } from "../agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import { SessionStore } from "../storage/session-store.js";
import { DurableRunStore } from "../storage/run-store.js";
import { checkDatabases } from "../storage/maintenance.js";
import {
  registerBuiltInTools,
  type BuiltInDependencies,
} from "../tools/index.js";
import { RegistryDispatcher } from "./adapters.js";
import { RpcSimulator } from "../execution/rpc-simulator.js";
import { NoxaIndexStore } from "../storage/noxa-index.js";
import { createNoxaTokenRegistry } from "../noxa.js";
import { createPublicClient, custom, http, type Address } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "../chain.js";
import {
  ExecutionStore,
  TradingOrchestrator,
  UnixSignerClient,
  type TradingRpc,
} from "../live-trading/index.js";
import { registerTradingTools } from "../live-trading/tools.js";
import {
  quoteRoutesAtBlock,
  buildRoutedSwapIntent,
  buildSwapTransaction,
  createRobinhoodTradingClient,
} from "../trading/index.js";
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  buildSimulationRequest,
  createSimulationEvidence,
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
    noxa: DependencyHealth;
    simulation: DependencyHealth;
    market: DependencyHealth;
    trading: DependencyHealth;
  };
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
}
export interface TradingComposition {
  trading: TradingOrchestrator;
  store: ExecutionStore;
  client: ReturnType<typeof createPublicClient>;
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
export function createTradingComposition(
  config: AppConfig,
  fetchFn?: typeof fetch,
): TradingComposition | undefined {
  if (!config.trading || !config.rpc) return undefined;
  const transport = fetchFn
    ? custom({
        request: async ({ method, params }) => {
          const response = await fetchFn(config.rpc!.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: params ?? [],
            }),
          });
          const payload = (await response.json()) as {
            result?: unknown;
            error?: { message?: string };
          };
          if (payload.error) throw Error(payload.error.message ?? "rpc error");
          return payload.result;
        },
      })
    : http(config.rpc.url);
  const client = createPublicClient({
    chain: robinhoodMainnet,
    transport,
  });
  const t = config.trading,
    store = new ExecutionStore(config.paths.executions);
  const policy = {
    version: 1,
    maxAmountIn: t.maxAmountIn,
    maxSlippageBps: t.maxSlippageBps,
    approvalRequired: true,
    finalityBlocks: t.finalityBlocks,
    allowedTokens: t.allowedTokens,
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
    chainId: config.rpc.chainId,
    ...(fetchFn ? { fetch: fetchFn } : {}),
    requireTrace: true,
  });
  const rpc: TradingRpc = {
    balance: async (owner, token) =>
      token
        ? await client.readContract({
            address: token,
            abi: [
              {
                type: "function",
                name: "balanceOf",
                stateMutability: "view",
                inputs: [{ type: "address" }],
                outputs: [{ type: "uint256" }],
              },
            ],
            functionName: "balanceOf",
            args: [owner],
          })
        : await client.getBalance({ address: owner }),
    quote: async (x) => {
      const blockNumber = await client.getBlockNumber(),
        block = await client.getBlock({ blockNumber });
      const routes = await quoteRoutesAtBlock(client as any, {
        quoter: t.quoter,
        paths: [100, 500, 3000, 10000].map((fee) => ({
          tokens: [x.tokenIn, x.tokenOut],
          fees: [fee],
        })),
        amountIn: x.amountIn,
        blockNumber,
      });
      const intent = buildRoutedSwapIntent({
        chainId: config.rpc!.chainId,
        owner: t.account,
        router: t.router,
        recipient: t.account,
        path: routes.best.path,
        amountIn: x.amountIn,
        quotedAmountOut: routes.best.amountOut,
        now: BigInt(Math.floor(Date.now() / 1000)),
        slippageBps: t.maxSlippageBps,
      });
      const nonce = await client.getTransactionCount({
          address: t.account,
          blockTag: "pending",
        }),
        probe = buildSwapTransaction(intent, { nonce, gas: 1n, gasPrice: 1n });
      const [gas, fees] = await Promise.all([
        client.estimateGas({
          account: t.account,
          to: t.router,
          data: probe.transaction.data,
          value: probe.transaction.value,
        }),
        client.estimateFeesPerGas(),
      ]);
      const built = buildSwapTransaction(intent, {
        nonce,
        gas,
        ...(fees.gasPrice !== undefined
          ? { gasPrice: fees.gasPrice }
          : {
              maxFeePerGas: fees.maxFeePerGas!,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
            }),
      });
      const request = buildSimulationRequest(
          { ...built.transaction, from: t.account },
          policyHash,
        ),
        result = await simulator.simulate(request);
      if (!result.success)
        throw Error(`simulation failed: ${result.revertReason ?? "reverted"}`);
      const evidence = createSimulationEvidence(request, result);
      return {
        amountOut: routes.best.amountOut,
        blockNumber,
        blockHash: block.hash,
        expiresAt: Date.now() + 30_000,
        route: routes.best.path,
        request,
        evidence,
      };
    },
    simulate: async (request) =>
      createSimulationEvidence(
        request as any,
        await simulator.simulate(request as any),
      ),
    broadcast: (raw) =>
      client.sendRawTransaction({ serializedTransaction: raw }),
    receipt: async (h) => {
      const r = await client
        .getTransactionReceipt({ hash: h })
        .catch(() => null);
      if (!r) return null;
      const n = await client.getBlockNumber();
      return {
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        status: r.status,
        confirmations: Number(n - r.blockNumber + 1n),
      };
    },
    blockHash: async (n) =>
      (await client.getBlock({ blockNumber: n }).catch(() => null))?.hash ??
      null,
  };
  let signer: UnixSignerClient | undefined;
  if (t.liveEnabled && t.signerSocketPath) {
    const token = t.signerTokenPath
      ? readFileSync(t.signerTokenPath, "utf8").trim()
      : undefined;
    signer = new UnixSignerClient(t.signerSocketPath, token);
  }
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
    const perToken = Object.fromEntries(
      t.allowedTokens.map((token) => [token, t.maxAmountIn]),
    );
    riskEvaluator = new ProductionRiskEvaluator({
      chains: [BigInt(config.rpc.chainId)],
      accounts: [t.account],
      routers: [t.router],
      tokens: t.allowedTokens,
      maxPerTrade: perToken,
      maxReservedPerToken: perToken,
      maxSlippageBps: BigInt(t.maxSlippageBps),
      maxQuoteAge: 30n,
      maxQuoteBlocks: BigInt(t.finalityBlocks),
      nativeGasReserve: 1n,
    });
    const canonicalRisk = (value: unknown): string =>
      canonicalSerialize(
        JSON.parse(
          JSON.stringify(value, (_k, v) =>
            typeof v === "bigint" ? { $bigint: v.toString() } : v,
          ),
        ),
      );
    risk = {
      assess: async (raw) => {
        try {
          let input: ProductionRiskInput;
          const wrapped = raw as any;
          if (wrapped?.quote && wrapped?.request && wrapped?.evidence) {
            const q = wrapped.quote,
              tx = wrapped.request.transaction,
              e = wrapped.evidence,
              now = BigInt(Math.floor(Date.now() / 1000));
            const [
              currentBlock,
              canonicalBlockHash,
              tokenBalance,
              nativeBalance,
            ] = await Promise.all([
              client.getBlockNumber(),
              rpc.blockHash(q.blockNumber),
              rpc.balance(t.account, q.tokenIn),
              rpc.balance(t.account),
            ]);
            if (!canonicalBlockHash) throw Error("canonical block unavailable");
            const fee = tx.gasPrice ?? tx.maxFeePerGas;
            if (fee === undefined) throw Error("gas price unavailable");
            input = {
              now,
              chain: BigInt(config.rpc!.chainId),
              account: t.account,
              router: t.router,
              tokenIn: q.tokenIn,
              tokenOut: q.tokenOut,
              amountIn: q.amountIn,
              slippageBps: BigInt(q.slippageBps),
              quoteAt: BigInt(Math.floor((q.expiresAt - 30_000) / 1000)),
              quoteBlock: q.blockNumber,
              currentBlock,
              quoteBlockHash: q.blockHash ?? e.blockHash,
              canonicalBlockHash,
              tokenBalance,
              nativeBalance,
              estimatedGasCost: BigInt(tx.gas) * BigInt(fee),
            };
          } else input = raw as ProductionRiskInput;
          const decision = riskEvaluator!.evaluate(
            input,
            reservations!.entries(input.now),
          );
          const hash = createHash("sha256")
            .update("production-risk-v2\0")
            .update(canonicalRisk({ input, decision }))
            .digest("hex");
          if (decision.allowed) riskHashes.add(hash);
          return { hash, ...decision };
        } catch {
          const decision = {
            allowed: false,
            reasons: ["risk_inputs_unavailable"],
          };
          const hash = createHash("sha256")
            .update("production-risk-v2\0")
            .update(canonicalRisk({ input: raw, decision }))
            .digest("hex");
          return { hash, ...decision };
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
        reservation: async (id) => reservations!.has(id),
        approval: async (id) => approvals!.get(id)?.status === "consumed",
        simulation: async (hash) => simulationHashes.has(hash),
        nonce: async (_chain, account) =>
          client.getTransactionCount({
            address: account as Address,
            blockTag: "pending",
          }),
      },
    });
    const originalSimulate = rpc.simulate;
    rpc.simulate = async (request) => {
      const evidence = await originalSimulate(request);
      simulationHashes.add((evidence as any).hash);
      return evidence;
    };
  }
  const reservationAdapter = reservations
    ? {
        reserve: async (x: any) => {
          const q = store.findQuoteByHash(x.quoteHash);
          if (!q) throw Error("reservation_quote_missing");
          const id = createHash("sha256")
            .update(`reservation-v1\0${x.quoteHash}\0${x.transactionHash}`)
            .digest("hex");
          if (
            !reservations!.reserveWithin(
              {
                id,
                at: BigInt(Math.floor(Date.now() / 1000)),
                asset: q.tokenIn,
                strategy: "live",
                amount: q.amountIn,
              },
              {
                // Native token units: this cap is evaluated and inserted under one
                // BEGIN IMMEDIATE transaction. Aggregate exposure is disabled until
                // the adapter has explicit normalized quote valuation evidence.
                perAsset:
                  riskEvaluator!.limits.maxReservedPerToken[q.tokenIn] ?? 0n,
              },
            )
          )
            throw Error("reservation_failed");
          return id;
        },
        valid: async (id: string) => reservations!.has(id),
        commit: async (id: string) => reservations!.commit(id),
        release: async (id: string) => reservations!.release(id),
      }
    : undefined;
  const trading = new TradingOrchestrator({
    chainId: config.rpc.chainId,
    account: t.account,
    router: t.router,
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
    client,
    ...(signer ? { signer } : {}),
    ...(approvals ? { approvals } : {}),
    ...(authorization ? { authorization } : {}),
    ...(reservations ? { reservations } : {}),
    ...(riskEvaluator ? { riskEvaluator } : {}),
    ...(risk ? { risk } : {}),
    async verify() {
      await createRobinhoodTradingClient({
        client: client as any,
        contracts: [t.router, t.quoter, t.factory],
      });
      if (signer) {
        let status;
        try {
          status = await signer.status();
        } catch {
          throw Error("signer_unavailable");
        }
        const expectedPolicyHash = `0x${createHash("sha256").update(readFileSync(t.signerPolicyPath!, "utf8")).digest("hex")}`;
        if (status.account.toLowerCase() !== t.account.toLowerCase())
          throw Error("signer_account_mismatch");
        if (
          status.chainIds.length !== 1 ||
          status.chainIds[0] !== config.rpc!.chainId
        )
          throw Error("signer_chain_ids_mismatch");
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
export function createApplication(
  config: AppConfig,
  overrides: {
    modelProvider?: ModelProvider;
    tools?: BuiltInDependencies;
    rpcFetch?: typeof fetch;
  } = {},
): Application {
  let state: "created" | "starting" | "ready" | "stopped" = "created",
    rpcHealthy = !config.rpc,
    tradingHealthy = true;
  let sessions: SessionStore | undefined, noxaStore: NoxaIndexStore | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined,
    reconciliationRunning = false;
  const runs = new DurableRunStore(config.paths.runs);
  let composed: BuiltInDependencies = {};
  if (config.rpc) {
    const simulator = new RpcSimulator({
      url: config.rpc.url,
      chainId: config.rpc.chainId,
      ...(overrides.rpcFetch ? { fetch: overrides.rpcFetch } : {}),
      requireTrace: true,
    });
    const chain =
      config.network === "mainnet" ? robinhoodMainnet : robinhoodTestnet;
    const client = createPublicClient({
      chain,
      transport: http(config.rpc.url, {
        fetchOptions: overrides.rpcFetch
          ? { fetchFn: overrides.rpcFetch }
          : undefined,
      } as any),
    });
    const noxaRegistry = createNoxaTokenRegistry(client as any);
    noxaStore = new NoxaIndexStore(config.paths.indexer);
    composed = {
      market: {
        networks: async () => [
          { id: config.rpc!.chainId, name: config.network },
        ],
      },
      noxa: {
        launches: async (limit) => noxaStore!.launches().slice(-limit),
        verify: async (address) => noxaRegistry.verifyToken(address as Address),
      },
      simulation: { simulate: (input) => simulator.simulate(input) },
    };
  }
  const registry = registerBuiltInTools(new ToolRegistry(), {
    ...composed,
    ...overrides.tools,
    market: { ...composed.market, ...overrides.tools?.market },
    noxa: { ...composed.noxa, ...overrides.tools?.noxa },
  });
  const tc = createTradingComposition(config, overrides.rpcFetch);
  if (tc) registerTradingTools(registry, tc.trading);
  const capabilities = [
    TRADING_CAPABILITIES.MARKET_DATA,
    TRADING_CAPABILITIES.RISK_ANALYSIS,
    TRADING_CAPABILITIES.ORDER_SIMULATE,
    ...(tc
      ? [TRADING_CAPABILITIES.ORDER_WRITE, TRADING_CAPABILITIES.PORTFOLIO_READ]
      : []),
  ];
  const provider = overrides.modelProvider ?? {
    id: "unconfigured",
    complete: async () => {
      throw Error("Model provider is not configured");
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    tools: new RegistryDispatcher(registry, capabilities),
  });
  return {
    registry,
    runtime,
    runs,
    ...(tc ? { trading: tc.trading } : {}),
    async start() {
      if (state === "ready") return;
      sessions = new SessionStore(config.paths.sessions);
      if (config.rpc) {
        try {
          const response = await (overrides.rpcFetch ?? fetch)(config.rpc.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_chainId",
              params: [],
            }),
          });
          if (!response.ok) throw Error("rpc probe failed");
          const payload = (await response.json()) as { result?: string };
          if (Number.parseInt(payload.result ?? "", 16) !== config.rpc.chainId)
            throw Error("rpc chain mismatch");
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
      noxaStore?.close();
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
            status: overrides.modelProvider ? "available" : "unconfigured",
            provider: provider.id,
          },
          rpc: rpcStatus,
          noxa: config.rpc ? rpcStatus : { status: "unconfigured" },
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
