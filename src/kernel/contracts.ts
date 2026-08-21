/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the Aetheria
 * `@aetheria/shared` package (enums, policy, intent, wallet, kernel, services,
 * events) is folded into this single contracts module.
 * SPDX-License-Identifier: Apache-2.0
 */

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

export type IntentKind = "swap";

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
