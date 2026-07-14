import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { NOXA_FACTORY_ADDRESS, NOXA_FACTORY_START_BLOCK } from "../noxa.js";
import { permissionsAreUnsafe } from "../platform.js";
const boolean = z.enum(["true", "false"]).transform((v) => v === "true");
const url = z
  .string()
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "must be an HTTP(S) URL",
  );
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATA_DIR: z.string().min(1).optional(),
    XDG_STATE_HOME: z.string().optional(),
    NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    MAINNET_ENABLED: boolean.default("false"),
    MAINNET_ACKNOWLEDGE_RISK: z.string().optional(),
    EXECUTION_MODE: z
      .enum(["read-only", "dry-run", "live"])
      .default("read-only"),
    LIVE_TRADING_ENABLED: boolean.default("false"),
    LIVE_TRADING_ACKNOWLEDGE_RISK: z.string().optional(),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    UNSAFE_ALLOW_EXTERNAL_DATABASES: boolean.default("false"),
    RPC_URL: url.optional(),
    CHAIN_ID: z.coerce.number().int().positive().optional(),
    NOXA_FACTORY_ADDRESS: z.string().optional(),
    NOXA_FACTORY_START_BLOCK: z.coerce.bigint().nonnegative().optional(),
    MARKET_PROVIDER_URLS: z.string().optional(),
    API_BEARER_TOKEN: z.string().min(1).optional(),
    API_BEARER_TOKEN_SHA256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    API_TENANT_ID: z.string().min(1).default("default"),
    API_SCOPES: z.string().default("agent:read,tool:read"),
    TRADING_ACCOUNT: z.string().optional(),
    SIGNER_SOCKET_PATH: z.string().optional(),
    SIGNER_TOKEN_PATH: z.string().optional(),
    SIGNER_POLICY_PATH: z.string().optional(),
    APPROVAL_OPERATOR_IDS: z.string().optional(),
    APPROVAL_OPERATOR_KEY_IDS: z.string().optional(),
    APPROVAL_OPERATOR_KEY_PATHS: z.string().optional(),
    APPROVAL_OPERATOR_CONFIG_VERSION: z.string().default("1"),
    AUTHORIZATION_KEY_ID: z.string().optional(),
    AUTHORIZATION_KEY_PATH: z.string().optional(),
    TRADING_MAX_AMOUNT_IN: z.coerce.bigint().positive().optional(),
    TRADING_ALLOWED_TOKENS: z.string().optional(),
    TRADING_MAX_SLIPPAGE_BPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .default(100),
    TRADING_FINALITY_BLOCKS: z.coerce.number().int().positive().default(12),
    TRADING_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600000)
      .default(15000),
  })
  .passthrough();
export interface TradingConfig {
  account: Address;
  router: Address;
  quoter: Address;
  factory: Address;
  signerSocketPath?: string;
  signerTokenPath?: string;
  signerPolicyPath?: string;
  maxAmountIn: bigint;
  allowedTokens: Address[];
  maxSlippageBps: number;
  finalityBlocks: number;
  reconcileIntervalMs: number;
  liveEnabled: boolean;
  approvalOperators?: { id: string; keyId: string; keyPath: string }[];
  approvalOperatorConfigVersion?: string;
  authorizationKeyId?: string;
  authorizationKeyPath?: string;
}
export interface AppConfig {
  mode: "development" | "test" | "production";
  network: "testnet" | "mainnet";
  execution: "read-only" | "dry-run" | "live";
  host: string;
  port: number;
  logLevel: string;
  shutdownTimeoutMs: number;
  dataDir: string;
  auth: {
    bearerToken?: string;
    bearerTokenSha256?: string;
    tenantId: string;
    scopes: string[];
  };
  rpc?: { url: string; chainId: number };
  trading?: TradingConfig;
  noxa: { factoryAddress: `0x${string}`; startBlock: bigint };
  marketProviderUrls: string[];
  paths: {
    sessions: string;
    runs: string;
    jobs: string;
    events: string;
    triggers: string;
    indexer: string;
    memory: string;
    skills: string;
    logs: string;
    audit: string;
    executions: string;
    approvals: string;
    reservations: string;
  };
}
const address = (v: string, n: string) => {
  try {
    return getAddress(v);
  } catch {
    throw Error(`${n} is invalid`);
  }
};
const privateFile = (p: string, n: string) => {
  if (!isAbsolute(p)) throw Error(`${n} must be absolute`);
  const s = lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink())
    throw Error(`${n} must be a regular file`);
  if (permissionsAreUnsafe(s)) throw Error(`${n} permissions are unsafe`);
};
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  _cwd = process.cwd(),
  requirements: { requireRpc?: boolean } = {},
): AppConfig {
  const e = schema.parse(env);
  const tradingConfigured =
    e.EXECUTION_MODE === "live" ||
    !!(
      e.TRADING_ACCOUNT ||
      e.TRADING_MAX_AMOUNT_IN ||
      e.TRADING_ALLOWED_TOKENS
    );
  const data =
    e.DATA_DIR ??
    join(
      e.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "robinhood-agent-os",
    );
  if (!isAbsolute(data)) throw Error("DATA_DIR must be an absolute path");
  if (
    e.NETWORK === "mainnet" &&
    !(
      e.MAINNET_ENABLED &&
      e.MAINNET_ACKNOWLEDGE_RISK === "I_ACKNOWLEDGE_MAINNET_RISK"
    )
  )
    throw Error(
      "Mainnet requires double opt-in: MAINNET_ENABLED and MAINNET_ACKNOWLEDGE_RISK",
    );
  if (
    e.EXECUTION_MODE === "live" &&
    !(
      e.NETWORK === "mainnet" &&
      e.MAINNET_ENABLED &&
      e.MAINNET_ACKNOWLEDGE_RISK === "I_ACKNOWLEDGE_MAINNET_RISK" &&
      e.LIVE_TRADING_ENABLED &&
      e.LIVE_TRADING_ACKNOWLEDGE_RISK === "I_ACKNOWLEDGE_LIVE_TRADING_RISK"
    )
  )
    throw Error("Live mainnet requires explicit triple opt-in");
  const expected = e.NETWORK === "mainnet" ? 4663 : 46630,
    chainId = e.CHAIN_ID ?? expected;
  if (chainId !== expected) throw Error(`CHAIN_ID does not match ${e.NETWORK}`);
  const factoryAddress = address(
    e.NOXA_FACTORY_ADDRESS ?? NOXA_FACTORY_ADDRESS,
    "NOXA_FACTORY_ADDRESS",
  );
  const root = resolve(data);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const child of ["memory", "skills", "logs", "audit"])
    mkdirSync(join(root, child), { recursive: true, mode: 0o700 });
  let trading: TradingConfig | undefined;
  if (tradingConfigured) {
    if (e.NETWORK !== "mainnet")
      throw Error("Trading contracts are only verified on mainnet");
    if (!e.TRADING_ACCOUNT || !e.TRADING_MAX_AMOUNT_IN)
      throw Error("TRADING_ACCOUNT and TRADING_MAX_AMOUNT_IN are required");
    const contracts = {
      router: "0xcaf681a66d020601342297493863e78c959e5cb2",
      quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
      factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    };
    if (e.EXECUTION_MODE === "live") {
      for (const [p, n] of [
        [e.SIGNER_TOKEN_PATH, "SIGNER_TOKEN_PATH"],
        [e.SIGNER_POLICY_PATH, "SIGNER_POLICY_PATH"],
      ] as const) {
        if (!p) throw Error(`${n} is required`);
        privateFile(p, n);
      }
      if (!e.SIGNER_SOCKET_PATH || !isAbsolute(e.SIGNER_SOCKET_PATH))
        throw Error("SIGNER_SOCKET_PATH must be absolute");
      for (const n of [
        "APPROVAL_OPERATOR_IDS",
        "APPROVAL_OPERATOR_KEY_IDS",
        "APPROVAL_OPERATOR_KEY_PATHS",
        "AUTHORIZATION_KEY_ID",
        "AUTHORIZATION_KEY_PATH",
      ] as const)
        if (!e[n]) throw Error(`${n} is required`);
      const ids = e.APPROVAL_OPERATOR_IDS!.split(","),
        keyIds = e.APPROVAL_OPERATOR_KEY_IDS!.split(","),
        keyPaths = e.APPROVAL_OPERATOR_KEY_PATHS!.split(",");
      if (
        ids.length !== keyIds.length ||
        ids.length !== keyPaths.length ||
        ids.some((id, i) => !id || !keyIds[i] || !keyPaths[i])
      )
        throw Error("approval operator configuration mismatch");
      for (const p of [...keyPaths, e.AUTHORIZATION_KEY_PATH!])
        privateFile(p, "approval/authorization key");
    }
    if (!e.RPC_URL) throw Error("RPC_URL is required");
    trading = {
      account: address(e.TRADING_ACCOUNT, "TRADING_ACCOUNT"),
      router: address(contracts.router, "router"),
      quoter: address(contracts.quoter, "quoter"),
      factory: address(contracts.factory, "factory"),
      ...(e.SIGNER_SOCKET_PATH
        ? { signerSocketPath: e.SIGNER_SOCKET_PATH }
        : {}),
      ...(e.SIGNER_TOKEN_PATH ? { signerTokenPath: e.SIGNER_TOKEN_PATH } : {}),
      ...(e.SIGNER_POLICY_PATH
        ? { signerPolicyPath: e.SIGNER_POLICY_PATH }
        : {}),
      maxAmountIn: e.TRADING_MAX_AMOUNT_IN,
      allowedTokens: (
        e.TRADING_ALLOWED_TOKENS?.split(",").filter(Boolean) ?? []
      ).map((x) => address(x, "TRADING_ALLOWED_TOKENS")),
      maxSlippageBps: e.TRADING_MAX_SLIPPAGE_BPS,
      finalityBlocks: e.TRADING_FINALITY_BLOCKS,
      reconcileIntervalMs: e.TRADING_RECONCILE_INTERVAL_MS,
      liveEnabled: e.EXECUTION_MODE === "live",
      ...(e.APPROVAL_OPERATOR_IDS
        ? {
            approvalOperators: e.APPROVAL_OPERATOR_IDS.split(",").map(
              (id, i) => ({
                id,
                keyId: e.APPROVAL_OPERATOR_KEY_IDS!.split(",")[i]!,
                keyPath: e.APPROVAL_OPERATOR_KEY_PATHS!.split(",")[i]!,
              }),
            ),
            approvalOperatorConfigVersion: e.APPROVAL_OPERATOR_CONFIG_VERSION,
            authorizationKeyId: e.AUTHORIZATION_KEY_ID!,
            authorizationKeyPath: e.AUTHORIZATION_KEY_PATH!,
          }
        : {}),
    };
  }
  if (requirements.requireRpc && !e.RPC_URL) throw Error("RPC_URL is required");
  const marketProviderUrls = (
    e.MARKET_PROVIDER_URLS?.split(",").filter(Boolean) ?? []
  ).map((v) => url.parse(v));
  return {
    mode: e.NODE_ENV,
    network: e.NETWORK,
    execution: e.EXECUTION_MODE,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    dataDir: root,
    auth: {
      ...(e.API_BEARER_TOKEN ? { bearerToken: e.API_BEARER_TOKEN } : {}),
      ...(e.API_BEARER_TOKEN_SHA256
        ? { bearerTokenSha256: e.API_BEARER_TOKEN_SHA256.toLowerCase() }
        : {}),
      tenantId: e.API_TENANT_ID,
      scopes: e.API_SCOPES.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    },
    ...(e.RPC_URL ? { rpc: { url: e.RPC_URL, chainId } } : {}),
    ...(trading ? { trading } : {}),
    noxa: {
      factoryAddress,
      startBlock: e.NOXA_FACTORY_START_BLOCK ?? NOXA_FACTORY_START_BLOCK,
    },
    marketProviderUrls,
    paths: {
      sessions: join(root, "sessions.sqlite"),
      runs: join(root, "runs.sqlite"),
      jobs: join(root, "jobs.sqlite"),
      events: join(root, "events.sqlite"),
      triggers: join(root, "triggers.sqlite"),
      indexer: join(root, "indexer.sqlite"),
      memory: join(root, "memory"),
      skills: join(root, "skills"),
      logs: join(root, "logs"),
      audit: join(root, "audit"),
      executions: join(root, "executions.sqlite"),
      approvals: join(root, "approvals.sqlite"),
      reservations: join(root, "reservations.sqlite"),
    },
  };
}
export function sanitizedConfig(c: AppConfig) {
  return {
    mode: c.mode,
    network: c.network,
    execution: c.execution,
    host: c.host,
    port: c.port,
    dataDir: c.dataDir,
    logLevel: c.logLevel,
    rpcConfigured: !!c.rpc,
    marketProvidersConfigured: c.marketProviderUrls.length,
    noxa: { factoryConfigured: true, startBlock: c.noxa.startBlock.toString() },
    ...(c.trading
      ? {
          trading: {
            account: c.trading.account,
            liveEnabled: c.trading.liveEnabled,
            maxAmountIn: c.trading.maxAmountIn.toString(),
            allowedTokens: c.trading.allowedTokens,
            maxSlippageBps: c.trading.maxSlippageBps,
            finalityBlocks: c.trading.finalityBlocks,
          },
        }
      : {}),
  };
}
