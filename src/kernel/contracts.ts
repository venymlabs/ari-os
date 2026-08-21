/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the Aetheria
 * `@aetheria/shared` package (enums, policy, intent, wallet, kernel, services,
 * events) is folded into this single contracts module.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { z } from "zod";
import type { GuardCode } from "./errors.js";
import type { TokenAmount } from "./money.js";

// ── Lifecycle enums ──────────────────────────────────────────────────────────

/**
 * Trade lifecycle. The reconciler is the single writer of these transitions.
 *   reserved → sent → (confirmed | expired | errored)
 *   reserved → rejected            (a guard refused before broadcast)
 * `expired` is TERMINAL — the kernel never re-signs the same intent under a new
 * blockhash (that is how you double-spend).
 */
export const TRADE_STATES = [
  "reserved",
  "sent",
  "confirmed",
  "expired",
  "errored",
  "rejected",
] as const;
export type TradeState = (typeof TRADE_STATES)[number];

/**
 * The four perpetuals kinds. `perp_reduce` / `perp_close` are *reducing*: they
 * shrink risk, post no new collateral, and must stay reachable when an opening
 * intent would be refused — an agent must always be able to get flat.
 */
export const PERP_INTENT_KINDS = [
  "perp_open",
  "perp_increase",
  "perp_reduce",
  "perp_close",
] as const;
export type PerpIntentKind = (typeof PERP_INTENT_KINDS)[number];

/** Concentrated-liquidity and bonding-curve kinds. */
export const POOL_INTENT_KINDS = [
  "lp_open",
  "lp_add",
  "lp_remove",
  "lp_close",
  "lp_claim",
  "lp_rebalance",
  "curve_buy",
  "curve_sell",
] as const;
export type PoolIntentKind = (typeof POOL_INTENT_KINDS)[number];

/**
 * Every shape of value movement the kernel knows how to chokepoint. The kind is
 * declared by the tool and re-validated here; it selects the settle strategy
 * (see {@link settleModeFor}) and nothing else. It never relaxes a cap.
 */
export const INTENT_KINDS = [
  "swap",
  ...PERP_INTENT_KINDS,
  ...POOL_INTENT_KINDS,
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export function isIntentKind(kind: string): kind is IntentKind {
  return (INTENT_KINDS as readonly string[]).includes(kind);
}

export function isPerpIntentKind(kind: string): kind is PerpIntentKind {
  return (PERP_INTENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Kinds that post zero collateral. A perp reduce or close hands the venue an
 * order, not money: its input leg is legitimately `0n`, so the "input must be
 * positive" rule is gated on this rather than removed. Every other kind still
 * has to declare a real outflow — that is what the spend caps bind to.
 */
export function postsZeroCollateral(kind: IntentKind): boolean {
  return kind === "perp_reduce" || kind === "perp_close";
}

/**
 * How the gateway verifies that a confirmed transaction actually filled.
 *
 *  - `token-delta`   the wallet's balance of the output mint must grow by at
 *                    least `quote.minOutAmount`. The swap-shaped default.
 *  - `venue-position` the fill did not move a token balance at all — it moved a
 *                    position on a venue. The gateway diffs the position
 *                    instead, against `perp.minBaseAmount`.
 */
export type SettleMode = "token-delta" | "venue-position";

export function settleModeFor(kind: IntentKind): SettleMode {
  return isPerpIntentKind(kind) ? "venue-position" : "token-delta";
}

/** How a built transaction is landed on-chain. */
export type LandMode = "jupiter-ultra" | "self-rpc";

/**
 * Where a mint in an intent came from. Only `user` / `watchlist` are pinned
 * deterministically; `untrusted` (model- or metadata-sourced) requires an
 * explicit user confirmation before the kernel will execute.
 */
export type MintProvenance = "user" | "watchlist" | "untrusted";

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * Spend caps, denominated in the INPUT-LEG quote asset (SOL or USDC) in base
 * units. The cap is on what *leaves* the wallet, so no price oracle is needed to
 * enforce it — a brand-new token with a broken oracle cannot widen the limit.
 */
export interface SpendCaps {
  readonly perTrade: bigint;
  readonly perHour: bigint;
  readonly perDay: bigint;
}

/**
 * The deterministic safety policy. Lives in the kernel, never in a prompt, and
 * is re-read at the metal inside TradeGateway.execute(). Nothing in here is ever
 * sourced from model output or tool/caller input.
 */
export interface PolicyConfig {
  /** Master arm. Defaults to false — the kernel boots in dry-run until armed. */
  readonly executionEnabled: boolean;
  /** Hard stop. When true, every value-moving action is refused. */
  readonly killSwitch: boolean;

  /** Slippage is hard-clamped to this regardless of what the user or the model asks for. */
  readonly maxSlippageBps: number;

  /** Caps when the input leg is SOL/wSOL. */
  readonly capsSol: SpendCaps;
  /** Caps when the input leg is USDC/USDT. */
  readonly capsUsdc: SpendCaps;

  /** null = allow any mint (subject to the denylist). Non-null = strict allowlist. */
  readonly mintAllowlist: readonly string[] | null;
  readonly mintDenylist: readonly string[];

  /** Token-2022 mints are detected and refused rather than mis-accounted. */
  readonly allowToken2022: boolean;

  /** Priority fee ceiling: min(absolute lamports, bps-of-notional). Never unbounded, never model-chosen. */
  readonly priorityFeeMaxLamports: bigint;
  readonly priorityFeeMaxBps: number;
}

// ── Intent ───────────────────────────────────────────────────────────────────

/** A compact, display-and-verify summary of an aggregator quote. */
export interface QuoteSummary {
  readonly inAmount: bigint; // base units of the input mint
  readonly outAmount: bigint; // expected out (base units)
  readonly minOutAmount: bigint; // worst-case out the route guarantees (otherAmountThreshold)
  readonly priceImpactPct: number; // 0..100
  readonly routeLabel: string; // e.g. "Raydium → Orca"
  readonly slippageBps: number; // slippage the route was built with (already clamped)
  readonly contextSlot: number | undefined;
}

/**
 * The slice of a perp leg the KERNEL itself needs, and nothing more.
 *
 * `src/perps` owns the full `PerpLeg` (funding, oracle, liquidation, margin
 * ratios); those belong to the perps guards, not to the money path. What the
 * gateway needs is only enough to locate the position it is about to change and
 * to bound the fill: the venue, the market, the subaccount, the direction of
 * the order, and the expected / worst-case base size.
 *
 * `PerpLeg` is structurally assignable to this, so the perps package hands its
 * own richer type straight through with no cast anywhere.
 */
export interface PerpSettleLeg {
  /** Stable venue id, e.g. 'drift'. Must match the mounted PositionReader. */
  readonly venue: string;
  /** Canonical market symbol, e.g. 'SOL-PERP'. */
  readonly market: string;
  readonly accountSubId: number;
  /** Direction of the ORDER (a close of a long is a 'short' order). */
  readonly side: "long" | "short";
  readonly baseDecimals: number;
  /** Expected and worst-case filled base size — the perps analogue of out / min-out. */
  readonly expectedBaseAmount: bigint;
  readonly minBaseAmount: bigint;
}

/**
 * A TradeIntent is the ONLY thing a sign/spend tool may produce. It is plain,
 * journalable data — never a function, never a secret. The kernel re-validates
 * every safety-relevant field from scratch; nothing here is trusted on faith.
 */
export interface TradeIntent {
  readonly kind: IntentKind;
  readonly source: string; // tool that built it, e.g. 'swap_jupiter'

  /** What LEAVES the wallet — THE spend the kernel caps on (the input leg). */
  readonly input: TokenAmount;
  /** What should arrive. */
  readonly output: { readonly mint: string; readonly decimals: number };

  /** Provenance of the mints; 'untrusted' requires an explicit user confirmation. */
  readonly inputProvenance: MintProvenance;
  readonly outputProvenance: MintProvenance;

  /** The unsigned transaction the tool built, base64 wire format (the canonical repr). */
  readonly unsignedTxBase64: string;
  /** The blockhash the tx was built with and its expiry height (the reconciler owns this lifecycle). */
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;

  /** How to land it. */
  readonly landMode: LandMode;
  /** Opaque per-landmode handle (e.g. Jupiter Ultra requestId). Never secret. */
  readonly landHandle: string | undefined;

  /**
   * The priority fee (lamports) the built transaction will pay. Surfaced on the
   * intent so the kernel can hard-cap it against policy — a tool or model can
   * never set an unbounded fee that silently drains the wallet on top of the
   * spend.
   */
  readonly priorityFeeLamports: number;

  /** The route/quote, for display and the post-confirm balance-delta check. */
  readonly quote: QuoteSummary;

  /**
   * Present iff `kind` is one of {@link PERP_INTENT_KINDS}, and required then —
   * `staticGuards` refuses a perp kind without it, and refuses a non-perp kind
   * that carries one. A perp fill is verified against this leg rather than
   * against a token balance; see {@link SettleMode}.
   */
  readonly perp?: PerpSettleLeg;

  /** Human-facing one-liner the tool proposes (the kernel may override on display). */
  readonly summary: string;
}

// ── Wallet seam ──────────────────────────────────────────────────────────────

/** A fully-signed transaction in the canonical base64 wire representation. */
export interface SignedTx {
  readonly wireBase64: string;
  /** Primary signature, base58. */
  readonly signature: string;
}

/**
 * The wallet seam. The DB never stores a key — only an opaque handle behind the
 * provider. ARI OS ships two implementations of this port: the in-process
 * {@link ../chains/solana/local-wallet.js LocalWallet} backed by the encrypted
 * keystore, and (owned separately) the isolated signer daemon, where `sign()`
 * crosses a process boundary and the key never enters this process at all.
 */
export interface WalletProvider {
  /** base58 public key. */
  readonly pubkey: string;
  /** Sign a canonical base64 wire tx; returns the signed wire + primary signature. */
  sign(unsignedTxBase64: string): Promise<SignedTx>;
}

// ── Service ports the kernel depends on ──────────────────────────────────────

/** A monotonic-ish clock seam so the selfcheck harness can drive deterministic time. */
export interface Clock {
  now(): number; // epoch ms
}

export interface MintInfo {
  readonly mint: string;
  readonly decimals: number;
  readonly programId: string; // SPL Token vs Token-2022 program id
  readonly isToken2022: boolean;
  readonly freezeAuthority: string | null;
  readonly mintAuthority: string | null;
}

export interface MintInspector {
  inspect(mint: string): Promise<MintInfo>;
}

export interface SimOutcome {
  readonly ok: boolean;
  readonly err: unknown | undefined;
  readonly logs: readonly string[] | undefined;
  readonly unitsConsumed: number | undefined;
}

export interface Simulator {
  /** Preflight sanity check only — validates the tx won't error against current state. NOT a price guarantee. */
  simulate(wireBase64: string): Promise<SimOutcome>;
}

export interface BalanceReader {
  /** Owned base-unit balance of `mint` for `owner`. Native SOL is read via the WSOL sentinel mint. */
  readBalance(owner: string, mint: string): Promise<bigint>;
}

/** Which venue position a settle check is about. */
export interface PerpPositionRef {
  readonly venue: string;
  readonly market: string;
  /** base58 owner pubkey — the gateway always passes its own wallet. */
  readonly owner: string;
  readonly subAccountId: number;
}

/**
 * The perp analogue of {@link BalanceReader}, and the reason a perp fill can be
 * verified at all.
 *
 * A perp order does not move a token balance: collateral leaves the wallet on
 * an open and a close returns it, so diffing balances says nothing about
 * whether the ORDER filled. Diffing the venue position does. The gateway reads
 * this immediately before signing and again after confirmation, and requires
 * the signed change to move in the order's direction by at least
 * `perp.minBaseAmount`.
 *
 * `src/perps/settle.ts` implements it over a `PerpsVenue`. Nothing here holds a
 * key or builds a transaction — it is a read port like every other.
 */
export interface PositionReader {
  /**
   * Signed base-unit size of the position: positive = long, negative = short,
   * `0n` = flat (including "no such position"). Throwing is a legitimate
   * answer — the gateway refuses to open into an unreadable venue.
   */
  readPosition(ref: PerpPositionRef): Promise<bigint>;
}

export interface Broadcaster {
  /** Submit an already-signed tx and return its on-chain signature. `landHandle` is per land-mode. */
  broadcast(
    signed: SignedTx,
    landHandle: string | undefined,
  ): Promise<{ signature: string }>;
}

export type ConfirmStatus = "confirmed" | "expired" | "failed";

export interface ConfirmOutcome {
  readonly status: ConfirmStatus;
  readonly slot: number | undefined;
  readonly err: unknown | undefined;
}

export interface Confirmer {
  confirm(
    signature: string,
    lastValidBlockHeight: number,
    signal?: AbortSignal,
  ): Promise<ConfirmOutcome>;
}

export interface TokenHolding {
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly programId: string;
  readonly symbol: string | undefined;
}

/** The read-only chain view a tool sees. Implemented by `src/chains/solana/rpc.ts`. */
export interface SolanaReader {
  getSolLamports(owner: string): Promise<bigint>;
  getTokenHoldings(owner: string): Promise<readonly TokenHolding[]>;
  getMintInfo(mint: string): Promise<MintInfo>;
}

/** An aggregator quote. The quote→swap flow lands via self-RPC; the kernel owns the blockhash lifecycle. */
export interface JupQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /** Slippage-adjusted worst-case out (Jupiter's otherAmountThreshold) — the route's min-out. */
  readonly otherAmountThreshold: bigint;
  readonly priceImpactPct: number;
  readonly slippageBps: number;
  readonly routeLabel: string;
  readonly contextSlot: number | undefined;
  /** Opaque provider payload to hand back to buildSwap. The kernel never trusts this. */
  readonly raw: unknown;
}

/** A fully-built unsigned swap transaction + the blockhash lifecycle the kernel will own. */
export interface SwapBuild {
  readonly swapTransactionB64: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly prioritizationFeeLamports: number;
}

export interface JupiterQuoteArgs {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}

export interface JupiterBuildArgs {
  quote: JupQuote;
  userPublicKey: string;
  priorityFeeLamports: number;
}

export interface JupiterClient {
  quote(args: JupiterQuoteArgs): Promise<JupQuote>;
  buildSwap(args: JupiterBuildArgs): Promise<SwapBuild>;
}

// ── The public money path ────────────────────────────────────────────────────

export interface ExecuteOptions {
  /** Server-generated idempotency key (see newIdempotencyKey). Required. */
  readonly idempotencyKey: string;
  /** Force simulate-only regardless of policy (used by quote cards before Confirm). */
  readonly dryRun?: boolean;
  /** True iff a human pressed Confirm — required for any untrusted-provenance mint. */
  readonly confirmedByUser?: boolean;
}

export interface FillReport {
  readonly inputDelta: bigint; // negative = spent
  readonly outputDelta: bigint; // positive = received
  readonly effectiveSlippageBps: number;
  /**
   * Perp kinds only: signed base-unit change in the venue position (positive =
   * the position moved long). This — not `outputDelta` — is what the fill check
   * bounds for a `venue-position` settle.
   */
  readonly positionDelta?: bigint;
}

export interface ExecuteResult {
  readonly tradeId: string;
  readonly state: TradeState;
  readonly signature: string | undefined;
  readonly simulated: boolean;
  readonly summary: string;
  readonly fill: FillReport | undefined;
  readonly error:
    { readonly code: string; readonly message: string } | undefined;
}

/**
 * TradeGateway — the single deterministic chokepoint every value-moving action
 * passes through. A model can reach it only by handing it a structured intent,
 * which the gateway re-validates from scratch.
 */
export interface TradeGateway {
  execute(intent: TradeIntent, opts: ExecuteOptions): Promise<ExecuteResult>;
}

// ── Journal ──────────────────────────────────────────────────────────────────

/**
 * The append-only journal event. Every trade lifecycle transition is one
 * immutable row. bigints are serialized as strings. Caps/cooldowns/PnL are
 * derived by folding these.
 */
export type JournalEvent =
  | {
      readonly type: "intent.received";
      readonly tradeId: string;
      readonly at: number;
      readonly idempotencyKey: string;
      readonly source: string;
      readonly summary: string;
    }
  | {
      readonly type: "guard.rejected";
      readonly tradeId: string;
      readonly at: number;
      readonly code: GuardCode;
      readonly message: string;
    }
  | {
      readonly type: "trade.reserved";
      readonly tradeId: string;
      readonly at: number;
      readonly bucket: string | null;
      readonly amount: string;
    }
  | {
      readonly type: "trade.simulated";
      readonly tradeId: string;
      readonly at: number;
      readonly ok: boolean;
    }
  | {
      readonly type: "trade.signed";
      readonly tradeId: string;
      readonly at: number;
      readonly signature: string;
    }
  | {
      readonly type: "trade.sent";
      readonly tradeId: string;
      readonly at: number;
      readonly signature: string;
    }
  | {
      readonly type: "trade.confirmed";
      readonly tradeId: string;
      readonly at: number;
      readonly signature: string;
      readonly inputDelta: string;
      readonly outputDelta: string;
      readonly effectiveSlippageBps: number;
      /** Perp kinds only — the signed venue position change the fill was verified against. */
      readonly positionDelta?: string;
    }
  | {
      readonly type: "trade.failed";
      readonly tradeId: string;
      readonly at: number;
      readonly code: GuardCode;
      readonly message: string;
    }
  | {
      readonly type: "trade.dryrun";
      readonly tradeId: string;
      readonly at: number;
      readonly summary: string;
    };

export type JournalEventType = JournalEvent["type"];

export interface Journal {
  append(event: JournalEvent): void;
}

// ── The intent-tool contract ─────────────────────────────────────────────────

/**
 * The contract for tools that can reach the money path.
 *
 * This is deliberately NOT `src/agent/types.ts`'s `ToolDefinition`, which is the
 * model-facing registry contract (JSON schema in, JSON out). The two differ in
 * the one way that matters here: a tool defined below has a `simulate()` that
 * returns a real, executable {@link TradeIntent} without signing anything, and
 * an `execute()` whose ONLY route to value movement is `ctx.gateway.execute()`.
 * That is what keeps "the model cannot move money" a structural property rather
 * than a convention. `src/tools/` adapts these onto the agent registry.
 */

export const TOOL_CAPABILITIES = [
  "read",
  "sign",
  "spend",
  "network",
  "read_state",
  "write_state",
] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const TOOL_CATEGORIES = [
  "data",
  "swap",
  "perps",
  "lending",
  "lp",
  "launchpad",
  "staking",
  "nft",
  "wallet",
  "notify",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/** The bundle of read-only clients available to a tool at runtime. */
export interface ToolServices {
  readonly solana: SolanaReader;
  readonly jupiter: JupiterClient;
}

/**
 * Per-invocation context. Venue handles are deliberately NOT here: a venue is a
 * composition-time singleton with its own policy getters and guard config, so
 * the venue-backed tools are factories closed over their dependencies (see
 * `src/perps/tools/deps.ts` and `src/pools/tools/deps.ts`) and satisfy this
 * context unchanged.
 */
export interface ToolContext {
  /** base58 pubkey of the on-machine wallet. */
  readonly ownerWallet: string;
  readonly rpcUrl: string;
  readonly services: ToolServices;
  /** The ONLY path to value movement. A read-only tool is handed a gateway that rejects execution. */
  readonly gateway: TradeGateway;
  readonly log: ToolLogger;
  readonly signal: AbortSignal | undefined;
}

/** What a `simulate()` returns — a real quote, never a signature. */
export interface Preview {
  readonly summary: string;
  readonly quote: QuoteSummary | undefined;
  readonly warnings: readonly string[];
  /** For sign/spend tools, the executable intent the kernel will re-validate. */
  readonly intent: TradeIntent | undefined;
  readonly data: unknown | undefined;
}

export interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string; // LLM- and human-facing
  readonly data: unknown | undefined; // structured payload
}

export interface ExecPolicy {
  readonly timeoutMs: number;
  readonly retries: number; // spend tools = 0
  readonly idempotent: boolean; // spend tools = false
}

export interface ToolExecOptions {
  readonly idempotencyKey: string;
  readonly confirmedByUser?: boolean;
}

export interface IntentToolDefinition<Cfg = unknown> {
  readonly name: string; // [action]_[protocol], e.g. swap_jupiter
  readonly category: ToolCategory;
  readonly description: string;
  readonly capabilities: readonly ToolCapability[];
  readonly execPolicy: ExecPolicy;
  readonly configSchema: z.ZodType<Cfg>;

  /** REAL quote/route/impact; never signs. Safe to call to build a quote card. */
  simulate(ctx: ToolContext, cfg: Cfg): Promise<Preview>;

  /** Non-throwing executor. sign/spend tools MUST route through ctx.gateway.execute(). */
  execute(
    ctx: ToolContext,
    cfg: Cfg,
    opts: ToolExecOptions,
  ): Promise<ToolOutcome>;
}

export function hasToolCapability(
  tool: Pick<IntentToolDefinition, "capabilities">,
  cap: ToolCapability,
): boolean {
  return tool.capabilities.includes(cap);
}

/** A tool moves value iff it declares `sign` or `spend`. */
export function movesValue(caps: readonly ToolCapability[]): boolean {
  return caps.includes("sign") || caps.includes("spend");
}
