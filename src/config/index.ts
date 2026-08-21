import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { permissionsAreUnsafe } from "../platform.js";
import { Secret } from "../kernel/secret.js";
import { isPublicKey } from "../signer/transaction.js";

/**
 * The Solana cluster each network name selects.
 *
 * `testnet` maps to `devnet` because that is the cluster operators actually
 * rehearse on — Solana's own `testnet` is a validator-release cluster, not a
 * staging network. The cluster is derived, never configured: an operator who
 * could name the cluster independently of `NETWORK` could point a `mainnet`
 * process at devnet, or the reverse.
 */
export const CLUSTER_FOR_NETWORK = {
  mainnet: "mainnet-beta",
  testnet: "devnet",
} as const;
export type Cluster =
  (typeof CLUSTER_FOR_NETWORK)[keyof typeof CLUSTER_FOR_NETWORK];

/** What ARI OS needs to know about one OpenAI-compatible LLM endpoint. */
export interface LlmProviderProfile {
  /** Default OpenAI-compatible base URL. `LLM_BASE_URL` overrides it. */
  readonly baseUrl: string;
  /**
   * The endpoint runs on the operator's own machine or LAN.
   *
   * This is a security classification, not a label. A local endpoint may be
   * reached over plain HTTP and may hold no API key at all — which is the point
   * of self-hosting: the model reasoning over your positions never leaves your
   * network, so there is no credential to protect in transit and no vendor to
   * present one to. A hosted endpoint is the opposite on both counts, and
   * {@link loadConfig} refuses one that is missing either.
   */
  readonly local: boolean;
  /**
   * Non-OpenAI request-body fields this provider understands, merged into every
   * chat completion. See {@link LLM_PROVIDERS}.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/**
 * The OpenAI-compatible LLM endpoints this process knows how to address.
 *
 * `extraBody` is the per-provider request-body hook, and it is the reason this
 * is a table rather than a switch. llama.cpp-backed local servers accept knobs
 * that are not in the OpenAI schema: Lemonade takes
 * `chat_template_kwargs.enable_thinking = false`, which suppresses a reasoning
 * model's thinking trace — roughly a 4x output-token saving on tool-routing
 * steps, and often the difference between fitting a small context window and
 * overflowing it. Adding a provider is adding a row here; nothing in
 * `src/agent/models/` learns any provider's name, and the transport merges
 * these fields UNDER the canonical OpenAI ones, so no row can redefine `model`,
 * `messages`, `tools` or `stream`.
 *
 * The default `baseUrl` of a local provider is only a convenience for the
 * single-machine case, and is the port the reference deployment happened to
 * listen on rather than a protocol constant. A server on another box — the
 * usual arrangement, since the GPU is rarely the laptop — is named explicitly
 * with `LLM_BASE_URL`, which overrides the default for every provider.
 */
export const LLM_PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", local: false },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", local: false },
  groq: { baseUrl: "https://api.groq.com/openai/v1", local: false },
  together: { baseUrl: "https://api.together.xyz/v1", local: false },
  xai: { baseUrl: "https://api.x.ai/v1", local: false },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", local: false },
  lemonade: {
    baseUrl: "http://localhost:13305/api/v1",
    local: true,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
  ollama: { baseUrl: "http://localhost:11434/v1", local: true },
  "llama-cpp": { baseUrl: "http://localhost:8080/v1", local: true },
} as const satisfies Record<string, LlmProviderProfile>;
export type LlmProvider = keyof typeof LLM_PROVIDERS;
const llmProviderNames = Object.keys(LLM_PROVIDERS) as [
  LlmProvider,
  ...LlmProvider[],
];

/**
 * In an environment file a blank value means "not set", so the schema must
 * agree. Without this, a `.env` copied from `templates/` with an unused
 * `LLM_PROVIDER=` line fails to parse rather than reading as unconfigured.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), inner);

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
    MARKET_PROVIDER_URLS: z.string().optional(),
    LLM_PROVIDER: blankAsAbsent(z.enum(llmProviderNames).optional()),
    LLM_BASE_URL: blankAsAbsent(url.optional()),
    LLM_MODEL: blankAsAbsent(z.string().min(1).optional()),
    LLM_API_KEY: blankAsAbsent(z.string().min(1).optional()),
    LLM_CONTEXT_WINDOW: blankAsAbsent(
      z.coerce.number().int().positive().max(10_000_000).default(8192),
    ),
    LLM_MAX_OUTPUT_TOKENS: blankAsAbsent(
      z.coerce.number().int().positive().max(1_000_000).default(1024),
    ),
    LLM_INPUT_COST_PER_MILLION: blankAsAbsent(
      z.coerce.number().nonnegative().default(0),
    ),
    LLM_OUTPUT_COST_PER_MILLION: blankAsAbsent(
      z.coerce.number().nonnegative().default(0),
    ),
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
    TRADING_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600000)
      .default(15000),
  })
  .passthrough();
export interface TradingConfig {
  /** The signing wallet: a base58 Ed25519 public key. */
  account: string;
  signerSocketPath?: string;
  signerTokenPath?: string;
  signerPolicyPath?: string;
  maxAmountIn: bigint;
  /** Tradeable assets, as base58 mints. */
  allowedTokens: string[];
  maxSlippageBps: number;
  reconcileIntervalMs: number;
  liveEnabled: boolean;
  approvalOperators?: { id: string; keyId: string; keyPath: string }[];
  approvalOperatorConfigVersion?: string;
  authorizationKeyId?: string;
  authorizationKeyPath?: string;
}
/**
 * A resolved LLM endpoint: where the planner runs and what it may spend.
 *
 * The token and cost figures are the ones `ModelRouter` already understands —
 * they become the single {@link import("../agent/models/index.js").ModelCandidate}
 * the composition root routes through. For a self-hosted server the costs are
 * genuinely zero, which is why they default to 0 rather than to a guess.
 */
export interface LlmConfig {
  provider: LlmProvider;
  /** True for a provider whose endpoint is the operator's own machine or LAN. */
  local: boolean;
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  model: string;
  /**
   * Absent for a keyless local server, which is the supported case rather than
   * a degraded one. Wrapped so it cannot reach a log, a JSON body or an
   * inspector: the only way out is `.reveal()` at the point of use.
   */
  apiKey?: Secret;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Provider-specific request body fields. See {@link LLM_PROVIDERS}. */
  extraBody?: Readonly<Record<string, unknown>>;
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
  rpc?: { url: string; cluster: Cluster };
  /** The planner endpoint. Absent means no model is configured at all. */
  llm?: LlmConfig;
  trading?: TradingConfig;
  marketProviderUrls: string[];
  paths: {
    sessions: string;
    runs: string;
    jobs: string;
    events: string;
    triggers: string;
    memory: string;
    skills: string;
    logs: string;
    audit: string;
    executions: string;
    approvals: string;
    reservations: string;
  };
}
/**
 * A wallet or asset identifier: a base58 Ed25519 public key, verbatim.
 *
 * Case is significant — two keys differing only in case are two different
 * wallets — so nothing here normalizes, lowercases, or checksums. The value
 * either decodes to 32 bytes on the Ed25519 curve or it is refused.
 */
const walletOrAsset = (v: string, n: string) => {
  if (!isPublicKey(v)) throw Error(`${n} is not a base58 public key`);
  return v;
};
const privateFile = (p: string, n: string) => {
  if (!isAbsolute(p)) throw Error(`${n} must be absolute`);
  const s = lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink())
    throw Error(`${n} must be a regular file`);
  if (permissionsAreUnsafe(s)) throw Error(`${n} permissions are unsafe`);
};
/**
 * Resolve the LLM endpoint, or return undefined when none is configured.
 *
 * Presence is all-or-nothing: naming any `LLM_*` variable declares the intent
 * to run a planner, and from there the required values are required. A half
 * configuration — a key with no model, a base URL with no provider — is a
 * misconfiguration that would otherwise surface as an opaque 404 on the first
 * user turn, so it is refused at boot instead.
 *
 * A hosted provider fails closed on two counts a local one does not: it must
 * present a key, and its base URL must be HTTPS, because a bearer token must
 * never cross a network in cleartext. A local provider may be keyless and may
 * be plain HTTP — over your own LAN there is no credential in flight and no
 * third party to authenticate to, and requiring a key there would block the
 * exact deployment self-hosting exists to enable.
 */
function loadLlmConfig(
  e: z.infer<typeof schema>,
  provider: LlmProvider,
): LlmConfig {
  if (!e.LLM_MODEL) throw Error("LLM_MODEL is required");
  const profile: LlmProviderProfile = LLM_PROVIDERS[provider];
  const baseUrl = e.LLM_BASE_URL ?? profile.baseUrl;
  // The transport appends `/chat/completions` to this string, so a base URL
  // carrying a query or fragment does not merely look odd — it builds a path
  // that no server routes. Embedded credentials are refused outright: they
  // would put a secret into every value that prints the endpoint.
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password)
    throw Error("LLM_BASE_URL must not embed credentials");
  if (parsed.search || parsed.hash)
    throw Error("LLM_BASE_URL must carry no query string or fragment");
  if (!profile.local) {
    if (parsed.protocol !== "https:")
      throw Error(`LLM_BASE_URL for ${provider} must be an HTTPS URL`);
    if (!e.LLM_API_KEY) throw Error(`LLM_API_KEY is required for ${provider}`);
  }
  // Every completion reserves its output allowance inside the context window,
  // so a ceiling at or above the window can never be satisfied and would refuse
  // every request at routing time rather than here.
  if (e.LLM_MAX_OUTPUT_TOKENS >= e.LLM_CONTEXT_WINDOW)
    throw Error("LLM_MAX_OUTPUT_TOKENS must be below LLM_CONTEXT_WINDOW");
  return {
    provider,
    local: profile.local,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: e.LLM_MODEL,
    ...(e.LLM_API_KEY
      ? { apiKey: new Secret(e.LLM_API_KEY, `llm-api-key:${provider}`) }
      : {}),
    contextWindow: e.LLM_CONTEXT_WINDOW,
    maxOutputTokens: e.LLM_MAX_OUTPUT_TOKENS,
    inputCostPerMillion: e.LLM_INPUT_COST_PER_MILLION,
    outputCostPerMillion: e.LLM_OUTPUT_COST_PER_MILLION,
    ...(profile.extraBody ? { extraBody: profile.extraBody } : {}),
  };
}
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
  const cluster = CLUSTER_FOR_NETWORK[e.NETWORK];
  const root = resolve(data);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const child of ["memory", "skills", "logs", "audit"])
    mkdirSync(join(root, child), { recursive: true, mode: 0o700 });
  let trading: TradingConfig | undefined;
  if (tradingConfigured) {
    if (e.NETWORK !== "mainnet")
      throw Error("Trading is only supported on mainnet-beta");
    if (!e.TRADING_ACCOUNT || !e.TRADING_MAX_AMOUNT_IN)
      throw Error("TRADING_ACCOUNT and TRADING_MAX_AMOUNT_IN are required");
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
      account: walletOrAsset(e.TRADING_ACCOUNT, "TRADING_ACCOUNT"),
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
      ).map((x) => walletOrAsset(x, "TRADING_ALLOWED_TOKENS")),
      maxSlippageBps: e.TRADING_MAX_SLIPPAGE_BPS,
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
  const llmConfigured = !!(
    e.LLM_PROVIDER ||
    e.LLM_BASE_URL ||
    e.LLM_MODEL ||
    e.LLM_API_KEY
  );
  if (llmConfigured && !e.LLM_PROVIDER)
    throw Error("LLM_PROVIDER is required when any LLM_* variable is set");
  const llm = e.LLM_PROVIDER ? loadLlmConfig(e, e.LLM_PROVIDER) : undefined;
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
    ...(e.RPC_URL ? { rpc: { url: e.RPC_URL, cluster } } : {}),
    ...(llm ? { llm } : {}),
    ...(trading ? { trading } : {}),
    marketProviderUrls,
    paths: {
      sessions: join(root, "sessions.sqlite"),
      runs: join(root, "runs.sqlite"),
      jobs: join(root, "jobs.sqlite"),
      events: join(root, "events.sqlite"),
      triggers: join(root, "triggers.sqlite"),
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
    cluster: c.rpc?.cluster ?? null,
    marketProvidersConfigured: c.marketProviderUrls.length,
    ...(c.llm
      ? {
          llm: {
            provider: c.llm.provider,
            model: c.llm.model,
            // HOST ONLY, on the same rule the RPC label follows: a hosted
            // provider's base URL can carry a key in its path, and this value
            // is printed by `config:check` and rendered in a browser.
            baseUrlHost: new URL(c.llm.baseUrl).host,
            local: c.llm.local,
            // Whether a key exists, never the key. `Secret` would render as
            // `[redacted:…]` anyway; saying so as a boolean is the useful form.
            apiKeyConfigured: !!c.llm.apiKey,
            contextWindow: c.llm.contextWindow,
            maxOutputTokens: c.llm.maxOutputTokens,
            extraBodyFields: Object.keys(c.llm.extraBody ?? {}),
          },
        }
      : {}),
    ...(c.trading
      ? {
          trading: {
            account: c.trading.account,
            liveEnabled: c.trading.liveEnabled,
            maxAmountIn: c.trading.maxAmountIn.toString(),
            allowedTokens: c.trading.allowedTokens,
            maxSlippageBps: c.trading.maxSlippageBps,
          },
        }
      : {}),
  };
}
