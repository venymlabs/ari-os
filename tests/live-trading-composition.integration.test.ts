import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { loadConfig, sanitizedConfig } from "../src/config/index.js";
import {
  createApplication,
  createTradingComposition,
} from "../src/app/index.js";
import { createStandaloneServer } from "../src/server.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
import { ApprovalEngine } from "../src/execution/approvals/index.js";
import { AuthorizationIssuer } from "../src/execution/authorization/index.js";
import {
  ProductionRiskEvaluator,
  ReservationLedger,
} from "../src/execution/control/index.js";
import { CLUSTER_GENESIS_HASHES } from "../src/execution/rpc-simulator.js";
import { buildSimulationRequest } from "../src/execution/simulation.js";
import { posixPermissions, removeDir } from "./helpers.js";
import { toIpcPath } from "../src/platform.js";
import {
  blockhash,
  buildTransaction,
  CLUSTER,
  COMPUTE_BUDGET_PROGRAM,
  pubkey,
  setComputeUnitLimit,
  setComputeUnitPrice,
  SYSTEM_PROGRAM,
  systemTransfer,
  TOKEN_PROGRAM,
  transferChecked,
} from "./signer-fixtures.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "live-compose-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllGlobals();
  dirs.splice(0).forEach((d) => removeDir(d));
});

/** The trading wallet, the two tradeable mints, and one delegated token account. */
const ACCOUNT = pubkey(1),
  MINT_IN = pubkey(2),
  MINT_OUT = pubkey(3),
  TOKEN_ACCOUNT = pubkey(4),
  DESTINATION = pubkey(5);
const GENESIS = CLUSTER_GENESIS_HASHES[CLUSTER]!;
const BLOCKHASH = blockhash();
const LAST_VALID_BLOCK_HEIGHT = 1_000;
const POLICY_HASH = `0x${"cd".repeat(32)}`;

/**
 * The operator's signer policy, as a real Solana policy file.
 *
 * The composition reads its program allowlist out of this file — a transaction
 * invoking a program the operator has not pinned is refused on the host as well
 * as inside the signer.
 */
const signPolicy = {
  version: 1,
  cluster: CLUSTER,
  feePayers: [ACCOUNT],
  programs: [
    { programId: COMPUTE_BUDGET_PROGRAM, discriminator: "02", effect: "fee" },
    { programId: COMPUTE_BUDGET_PROGRAM, discriminator: "03", effect: "fee" },
    { programId: TOKEN_PROGRAM, discriminator: "05", effect: "none" },
    {
      programId: TOKEN_PROGRAM,
      discriminator: "0c",
      effect: "spend",
      spend: {
        asset: MINT_IN,
        amountOffset: 1,
        amountEncoding: "u64le",
        mintAccountIndex: 1,
      },
    },
    {
      programId: SYSTEM_PROGRAM,
      discriminator: "02000000",
      effect: "spend",
      spend: { asset: "native", amountOffset: 4, amountEncoding: "u64le" },
    },
  ],
  caps: { [MINT_IN]: "1000", native: "1000" },
  maxInstructions: 8,
  maxAccountKeys: 32,
  maxRequiredSignatures: 1,
  maxComputeUnitLimit: 400_000,
  maxComputeUnitPriceMicroLamports: "50000",
  maxPriorityFeeLamports: "15000",
  addressLookupTables: [],
};
const SIGN_POLICY_RAW = JSON.stringify(signPolicy);

function liveEnv(d: string) {
  const token = join(d, "signer.token"),
    policy = join(d, "sign-policy.json"),
    operator = join(d, "operator.key"),
    authorization = join(d, "authorization.key"),
    socket = join(d, "signer.sock");
  for (const [path, value] of [
    [token, "secret"],
    [policy, SIGN_POLICY_RAW],
    [operator, "operator-secret"],
    [authorization, "authorization-secret"],
  ] as const)
    writeFileSync(path, value, { mode: 0o600 });
  return {
    NODE_ENV: "test",
    DATA_DIR: d,
    NETWORK: "mainnet",
    RPC_URL: "http://127.0.0.1:8899",
    EXECUTION_MODE: "live",
    MAINNET_ENABLED: "true",
    MAINNET_ACKNOWLEDGE_RISK: "I_ACKNOWLEDGE_MAINNET_RISK",
    LIVE_TRADING_ENABLED: "true",
    LIVE_TRADING_ACKNOWLEDGE_RISK: "I_ACKNOWLEDGE_LIVE_TRADING_RISK",
    TRADING_ACCOUNT: ACCOUNT,
    SIGNER_SOCKET_PATH: socket,
    SIGNER_TOKEN_PATH: token,
    SIGNER_POLICY_PATH: policy,
    APPROVAL_OPERATOR_IDS: "operator",
    APPROVAL_OPERATOR_KEY_IDS: "operator-v1",
    APPROVAL_OPERATOR_KEY_PATHS: operator,
    AUTHORIZATION_KEY_ID: "authorization-v1",
    AUTHORIZATION_KEY_PATH: authorization,
    TRADING_MAX_AMOUNT_IN: "1000",
    TRADING_ALLOWED_TOKENS: `${MINT_IN},${MINT_OUT}`,
    TRADING_MAX_SLIPPAGE_BPS: "100",
    API_BEARER_TOKEN: "api",
    API_SCOPES: "tool:read,tool:invoke,trading:quote,trading:execute",
  } as const;
}

async function signerStatus(
  env: ReturnType<typeof liveEnv>,
  overrides: Record<string, unknown> = {},
) {
  const status = {
    account: ACCOUNT,
    cluster: CLUSTER,
    policyHash: `0x${createHash("sha256").update(SIGN_POLICY_RAW).digest("hex")}`,
    policyVersion: 1,
    authorizationKeyId: "authorization-v1",
    serviceVersion: "0.1.0",
    ...overrides,
  };
  const server = createServer((c) => {
    let data = "";
    c.on("data", (b) => {
      data += b;
      if (data.includes("\n"))
        c.end(JSON.stringify({ ok: true, result: status }) + "\n");
    });
  });
  await new Promise<void>((r) =>
    server.listen(toIpcPath(env.SIGNER_SOCKET_PATH!), r),
  );
  return server;
}

const rpcAccount = (lamports: number) => ({
  lamports,
  owner: SYSTEM_PROGRAM,
  data: ["", "base64"],
  executable: false,
  rentEpoch: 0,
});

/**
 * One fetch that answers both the cluster and Jupiter.
 *
 * `JupiterClient` reaches for global `fetch` (there is no injection seam), so
 * the same handler is installed globally and passed as the composition's RPC
 * fetch; it routes on host.
 */
function clusterFetch(
  options: {
    swapTransaction?: string;
    blockHeight?: number;
    calls?: string[];
  } = {},
) {
  const calls = options.calls ?? [];
  return vi.fn(async (u: any, init: any) => {
    const url = String(u);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    if (url.includes("jup.ag")) {
      if (url.includes("/quote")) {
        calls.push("jupiter.quote");
        return json({
          inAmount: "10",
          outAmount: "900",
          otherAmountThreshold: "895",
          priceImpactPct: "0.01",
          slippageBps: 50,
          contextSlot: 100,
          routePlan: [{ swapInfo: { label: "Orca" } }],
        });
      }
      calls.push("jupiter.swap");
      return json({
        swapTransaction: options.swapTransaction,
        lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
        prioritizationFeeLamports: 200_000,
      });
    }
    const body = JSON.parse(String(init?.body));
    calls.push(body.method);
    const result = ((): unknown => {
      switch (body.method) {
        case "getGenesisHash":
          return GENESIS;
        case "getBlockHeight":
          return options.blockHeight ?? 10;
        case "getSlot":
          return 100;
        case "getMultipleAccounts":
          return {
            context: { slot: 100 },
            value: (body.params[0] as string[]).map(() => rpcAccount(10_000)),
          };
        case "simulateTransaction":
          return {
            context: { slot: 100 },
            value: {
              err: null,
              logs: [`Program ${TOKEN_PROGRAM} success`],
              accounts: (body.params[1].accounts.addresses as string[]).map(
                () => rpcAccount(9_000),
              ),
              unitsConsumed: 450,
            },
          };
        case "getFeeForMessage":
          return { context: { slot: 100 }, value: 5_000 };
        case "getLatestBlockhash":
          return {
            context: { slot: 100 },
            value: {
              blockhash: BLOCKHASH,
              lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
            },
          };
        default:
          return null;
      }
    })();
    return json({ jsonrpc: "2.0", id: body.id, result });
  });
}

/** SPL Token `Revoke` — tag 5, [token account (w), owner (signer)]. */
function revokeInstruction(tokenAccount: string, owner: string, tag = 5) {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      {
        pubkey: new PublicKey(tokenAccount),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([tag]),
  });
}

const revokeRequest = (instruction: TransactionInstruction, payer = ACCOUNT) =>
  buildSimulationRequest(
    {
      cluster: CLUSTER,
      transaction: buildTransaction({
        payer,
        recentBlockhash: BLOCKHASH,
        instructions: [
          setComputeUnitLimit(200_000),
          setComputeUnitPrice(1_000n),
          instruction,
        ],
      }),
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    },
    POLICY_HASH,
  );

describe("live trading configuration and production composition", () => {
  it("injects every mandatory funded execution control into the shipped live composition", () => {
    const d = temp(),
      composition = createTradingComposition(loadConfig(liveEnv(d)))!;
    expect(composition.cluster).toBe("mainnet-beta");
    expect(composition.approvals).toBeInstanceOf(ApprovalEngine);
    expect(composition.authorization).toBeInstanceOf(AuthorizationIssuer);
    expect(composition.reservations).toBeInstanceOf(ReservationLedger);
    expect(composition.riskEvaluator).toBeInstanceOf(ProductionRiskEvaluator);
    expect(composition.risk).toBeDefined();
    expect((composition.authorization as any).signerKeyId).toBe(
      "authorization-v1",
    );
    composition.close();
  });

  it("evaluates production risk against configured limits and durable input-leg reservations", async () => {
    const d = temp(),
      composition = createTradingComposition(loadConfig(liveEnv(d)))!,
      risk = composition.risk!;
    const now = BigInt(Math.floor(Date.now() / 1000)),
      base = {
        now,
        // The evaluator's numeric chain slot is derived from the CLUSTER now,
        // not from an EVM chain id: mainnet-beta and devnet fold to different
        // numbers, and nothing in config names one independently of NETWORK.
        chain: composition.riskEvaluator!.limits.chains[0]!,
        account: ACCOUNT,
        router: composition.riskEvaluator!.limits.routers[0]!,
        tokenIn: MINT_IN,
        tokenOut: MINT_OUT,
        amountIn: 100n,
        slippageBps: 50n,
        quoteAt: now,
        quoteBlock: 1_000n,
        currentBlock: 1_000n,
        quoteBlockHash: BLOCKHASH,
        canonicalBlockHash: BLOCKHASH,
        tokenBalance: 1000n,
        nativeBalance: 10_000_000n,
        estimatedGasCost: 5_000n,
      };
    expect(await risk.assess(base)).toMatchObject({
      allowed: true,
      reasons: [],
    });
    for (const [change, reason] of [
      [{ amountIn: 1001n }, "per_trade_limit_exceeded"],
      [{ chain: 4663n }, "chain_not_allowed"],
      [{ router: MINT_OUT }, "router_not_allowed"],
      [{ tokenOut: pubkey(9) }, "token_not_allowed"],
      [{ quoteAt: now - 31n }, "quote_stale"],
      // A quote older than a blockhash lifetime describes a dead transaction.
      [{ currentBlock: 1_151n }, "quote_block_stale"],
      // The Solana analogue of a reorged quote: the blockhash cannot land.
      [{ canonicalBlockHash: "expired" }, "quote_noncanonical"],
      [{ tokenBalance: 99n }, "insufficient_token_balance"],
      [{ nativeBalance: 1n }, "insufficient_gas_reserve"],
    ] as const) {
      const result: any = await risk.assess({ ...base, ...change });
      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain(reason);
    }
    expect(
      composition.reservations!.reserve({
        id: "existing",
        at: now,
        asset: MINT_IN,
        strategy: "live",
        amount: 950n,
      }),
    ).toBe(true);
    expect((await risk.assess(base)).reasons).toContain(
      "token_reserved_exposure_exceeded",
    );
    composition.close();
  });

  it("constructs and simulates one exact unsigned transaction pinned to the quoted blockhash", async () => {
    const d = temp(),
      calls: string[] = [];
    const swapTransaction = buildTransaction({
      payer: ACCOUNT,
      recentBlockhash: BLOCKHASH,
      instructions: [
        setComputeUnitLimit(200_000),
        setComputeUnitPrice(1_000n),
        transferChecked({
          source: TOKEN_ACCOUNT,
          mint: MINT_IN,
          destination: DESTINATION,
          owner: ACCOUNT,
          amount: 10n,
        }),
      ],
    });
    const fetch = clusterFetch({ swapTransaction, calls });
    vi.stubGlobal("fetch", fetch);
    const app = createApplication(
      loadConfig({
        ...liveEnv(d),
        EXECUTION_MODE: "dry-run",
        LIVE_TRADING_ENABLED: "false",
        LIVE_TRADING_ACKNOWLEDGE_RISK: undefined,
      } as any),
      { rpcFetch: fetch as any },
    );
    const q = await app.trading!.quote({
      side: "buy",
      inputMint: MINT_IN,
      outputMint: MINT_OUT,
      amountIn: 10n,
      slippageBps: 50,
    });
    // The bytes Jupiter built are the bytes that were decoded, simulated and
    // hashed — nothing rebuilt them in between.
    expect(q.request?.transaction).toBe(swapTransaction);
    expect(q.request?.recentBlockhash).toBe(BLOCKHASH);
    expect(q.evidence?.messageHash).toBe(q.request?.messageHash);
    expect(q.lastValidBlockHeight).toBe(LAST_VALID_BLOCK_HEIGHT);
    expect(q.slot).toBe(100n);
    expect(q.amountOut).toBe(900n);
    expect(q.request?.programIds).toEqual(
      [COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM].sort(),
    );
    for (const call of [
      "jupiter.quote",
      "jupiter.swap",
      "getGenesisHash",
      "simulateTransaction",
      "getFeeForMessage",
    ])
      expect(calls).toContain(call);
    await app.stop();
  });

  it("supports read-only and dry-run but requires the complete mainnet live triple opt-in", () => {
    const d = temp();
    expect(
      loadConfig({ NODE_ENV: "test", DATA_DIR: d, EXECUTION_MODE: "dry-run" })
        .execution,
    ).toBe("dry-run");
    expect(() =>
      loadConfig({ ...liveEnv(d), LIVE_TRADING_ENABLED: "false" }),
    ).toThrow(/triple opt-in/i);
    expect(loadConfig(liveEnv(d)).trading?.account).toBe(ACCOUNT);
    expect(sanitizedConfig(loadConfig(liveEnv(d)))).not.toHaveProperty(
      "trading.signerTokenPath",
    );
  });

  it("requires RPC and absolute private regular signer files", () => {
    const d = temp(),
      e: any = liveEnv(d);
    delete e.RPC_URL;
    expect(() => loadConfig(e)).toThrow(/RPC_URL/);
    expect(() =>
      loadConfig({ ...liveEnv(d), SIGNER_SOCKET_PATH: "relative.sock" }),
    ).toThrow(/absolute/);
    if (posixPermissions) {
      chmodSync(e.SIGNER_TOKEN_PATH, 0o644);
      expect(() => loadConfig(e)).toThrow(/permissions/);
    }
  });

  it("registers trading only when configured and separates RPC liveness from signer readiness", async () => {
    const d = temp();
    const absent = createApplication(
      loadConfig({ NODE_ENV: "test", DATA_DIR: d }),
    );
    expect(
      absent.registry.listPrivileged().some((x) => x.name.startsWith("trade.")),
    ).toBe(false);
    // No wallet is supplied, so the venue toolsets are not registered at all.
    expect(
      absent.registry.listPrivileged().some((x) => x.name.startsWith("perps_")),
    ).toBe(false);
    await absent.stop();
    const fetch = clusterFetch();
    vi.stubGlobal("fetch", fetch);
    const app = createApplication(loadConfig(liveEnv(d)), {
      rpcFetch: fetch as any,
    });
    await app.start();
    expect(app.registry.listPrivileged().map((x) => x.name)).toContain(
      "trade.buy",
    );
    const health = await app.health();
    // The cluster answers; the signer does not. Readiness must not average
    // those together.
    expect(health.dependencies.rpc.status).toBe("available");
    expect(health.dependencies.trading.status).toBe("unhealthy");
    expect(app.ready()).toBe(false);
    await app.stop();
  });

  it("fails readiness with an explicit nonsecret signer identity mismatch", async () => {
    for (const [overrides, error] of [
      [
        { authorizationKeyId: "wrong-key" },
        "signer_authorization_key_id_mismatch",
      ],
      [{ cluster: "devnet" }, "signer_cluster_mismatch"],
      [{ account: pubkey(8) }, "signer_account_mismatch"],
    ] as const) {
      const d = temp(),
        env = liveEnv(d),
        server = await signerStatus(env, overrides);
      const fetch = clusterFetch();
      const composition = createTradingComposition(
        loadConfig(env),
        fetch as any,
      )!;
      await expect(composition.verify()).rejects.toThrow(error);
      composition.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("assesses revokes as the exact SPL Token Revoke transaction only", async () => {
    const d = temp();
    const fetch = clusterFetch();
    const composition = createTradingComposition(
      loadConfig(liveEnv(d)),
      fetch as any,
    )!;
    const quote = {
      side: "revoke",
      inputMint: TOKEN_ACCOUNT,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      expiresAt: Date.now() + 30_000,
    };
    const evidence = { assetDeltas: [{ asset: "native", amount: -5_000n }] };
    const assess = (over: Record<string, unknown> = {}) =>
      composition.risk!.assess({
        quote,
        evidence,
        request: revokeRequest(revokeInstruction(TOKEN_ACCOUNT, ACCOUNT)),
        ...over,
      });
    expect(await assess()).toMatchObject({ allowed: true, reasons: [] });
    for (const [over, reason] of [
      [
        {
          request: revokeRequest(revokeInstruction(TOKEN_ACCOUNT, ACCOUNT, 4)),
        },
        "revoke_instruction_mismatch",
      ],
      [
        { request: revokeRequest(revokeInstruction(pubkey(7), ACCOUNT)) },
        "revoke_target_mismatch",
      ],
      [
        { request: revokeRequest(revokeInstruction(TOKEN_ACCOUNT, pubkey(7))) },
        "revoke_owner_mismatch",
      ],
      [
        {
          request: revokeRequest(systemTransfer(ACCOUNT, DESTINATION, 1n)),
        },
        "revoke_program_mismatch",
      ],
      [
        {
          evidence: {
            assetDeltas: [{ asset: MINT_IN, amount: -1n }],
          },
        },
        "revoke_moves_assets",
      ],
      [{ quote: { ...quote, expiresAt: Date.now() - 1 } }, "quote_stale"],
      [
        { quote: { ...quote, lastValidBlockHeight: 1 } },
        "quote_blockhash_expired",
      ],
    ] as const) {
      const verdict: any = await assess(over as Record<string, unknown>);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reasons).toContain(reason);
    }
    // A program the operator never pinned in sign-policy.json is refused on the
    // host too, not only inside the signer.
    const unpinned: any = await assess({
      request: revokeRequest(
        new TransactionInstruction({
          programId: new PublicKey(pubkey(6)),
          keys: [],
          data: Buffer.from([5]),
        }),
      ),
    });
    expect(unpinned.reasons).toContain("program_not_allowed");
    composition.close();
  });

  it("mounts the venue toolsets only once custody exists", async () => {
    const d = temp();
    const wallet = {
      pubkey: ACCOUNT,
      sign: async () => {
        throw Error("no in-process custody");
      },
    };
    const app = createApplication(
      loadConfig({
        ...liveEnv(d),
        EXECUTION_MODE: "dry-run",
        LIVE_TRADING_ENABLED: "false",
        LIVE_TRADING_ACKNOWLEDGE_RISK: undefined,
      } as any),
      { wallet },
    );
    const names = app.registry.listPrivileged().map((x) => x.name);
    // Reads register once; anything that moves value registers as an
    // execute/preview pair.
    expect(names).toContain("perps_markets");
    expect(names).not.toContain("perps_markets.preview");
    expect(names).toContain("perps_open");
    expect(names).toContain("perps_open.preview");
    expect(names.some((n) => n.startsWith("pumpfun_"))).toBe(true);
    expect(
      app.registry.listPrivileged().find((x) => x.name === "perps_open")
        ?.capabilities,
    ).toEqual([TRADING_CAPABILITIES.POSITION_WRITE]);
    await app.stop();
  });

  it("mounts authenticated trading API on the shipped server", async () => {
    const d = temp();
    const s = await createStandaloneServer(
      loadConfig({
        ...liveEnv(d),
        EXECUTION_MODE: "dry-run",
        LIVE_TRADING_ENABLED: "false",
        LIVE_TRADING_ACKNOWLEDGE_RISK: undefined,
      } as any),
      {
        rpcFetch: vi.fn(async () => {
          throw Error("offline");
        }) as any,
      },
    );
    expect(
      (
        await s.inject({
          method: "POST",
          url: "/v1/trading/quote",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await s.inject({
          method: "POST",
          url: "/v1/trading/quote",
          headers: { authorization: "Bearer api" },
          payload: {},
        })
      ).statusCode,
    ).not.toBe(404);
    const revokeWithoutKey = await s.inject({
      method: "POST",
      url: "/v1/trading/revoke",
      headers: { authorization: "Bearer api" },
      payload: { tokenAccount: TOKEN_ACCOUNT },
    });
    expect(revokeWithoutKey.statusCode).toBe(400);
    expect(revokeWithoutKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await s.close();
  });
});
