/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: NEW in this
 * repo. Aetheria's strategy runner called an engine-level `swap()` that owned
 * quoting and execution; ARI OS has no such engine, so this is the adapter that
 * turns a scheduled {@link StrategySwap} into a kernel `TradeIntent` and hands
 * it to `TradeGateway.execute()` — the same chokepoint every tool uses.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  JupiterClient,
  MintProvenance,
  SolanaReader,
  TradeGateway,
  TradeIntent,
} from "../kernel/contracts.js";
import {
  SOL_DECIMALS,
  toBaseUnits,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} from "../kernel/money.js";
import type { StrategyExecutor, StrategySwap } from "./runner.js";

/** The tool name recorded on every intent a strategy produces. */
export const STRATEGY_SOURCE = "strategy_runner";

/** Baseline tip. The kernel re-caps the built fee against live policy anyway. */
const DEFAULT_PRIORITY_FEE_LAMPORTS = 200_000;

/**
 * Mints whose provenance is structural rather than asserted: the quote assets
 * the caps themselves are denominated in.
 */
const QUOTE_MINTS = new Set<string>([WSOL_MINT, USDC_MINT, USDT_MINT]);

export interface GatewayExecutorDeps {
  /** The ONE path to value movement. There is no other in this module. */
  readonly gateway: TradeGateway;
  readonly jupiter: JupiterClient;
  /** Read side, for mint decimals. */
  readonly solana: SolanaReader;
  readonly ownerWallet: string;
  /**
   * The operator's pinned mint list — normally `PolicyConfig.mintAllowlist`.
   * Anything outside it (and outside the quote assets) is `untrusted`, which
   * the kernel refuses without a per-trade human confirmation. See below.
   */
  readonly pinnedMints?: () => readonly string[] | null | undefined;
  readonly priorityFeeLamports?: number;
  readonly defaultSlippageBps?: number;
  /** Price feed for trailing-stop / take-profit strategies. */
  readonly price?: (mint: string) => Promise<number | undefined>;
  readonly notify?: (userId: number, text: string) => Promise<void>;
}

/**
 * Build the executor the {@link StrategyRunner} is mounted with.
 *
 * ── Why this file is the interesting one ────────────────────────────────────
 *
 * A strategy runner is the most tempting place in an agent to grow a private
 * execution path: it already runs unattended on a timer, so "just sign it here"
 * is one refactor away. It does not have one. `swap()` below quotes, assembles
 * a plain `TradeIntent`, and calls `gateway.execute()`. There is no keypair in
 * scope, no broadcaster, no `sign`, and no RPC write — the read port is
 * `SolanaReader`, which cannot send anything. Every safety property the swap
 * tools get, autonomous strategies get for the same reason and in the same
 * place: caps on the input leg, slippage clamp, priority-fee ceiling, mint
 * allow/deny, kill switch, idempotency, journal.
 *
 * ── On `confirmedByUser` ────────────────────────────────────────────────────
 *
 * It is never set here, and that is deliberate rather than an omission. It
 * means "a human pressed Confirm for THIS trade", which by construction no one
 * did — the point of a schedule is that nobody is watching. So an unpinned mint
 * (`untrusted` provenance) is refused by `MINT_NOT_PINNED` rather than waved
 * through by an autonomous caller asserting consent on the operator's behalf.
 * The way to run a strategy on a token is to pin the mint in policy, which is
 * an explicit, durable, operator-side act — not a flag the runner can set.
 */
export function gatewayExecutor(deps: GatewayExecutorDeps): StrategyExecutor {
  const priorityFeeLamports =
    deps.priorityFeeLamports ?? DEFAULT_PRIORITY_FEE_LAMPORTS;

  const provenanceFor = (mint: string): MintProvenance => {
    if (QUOTE_MINTS.has(mint)) return "user";
    const pinned = deps.pinnedMints?.();
    return pinned && pinned.includes(mint) ? "user" : "untrusted";
  };

  const decimalsFor = async (mint: string): Promise<number> => {
    if (mint === WSOL_MINT) return SOL_DECIMALS;
    const info = await deps.solana.getMintInfo(mint);
    return info.decimals;
  };

  const executor: StrategyExecutor = {
    async swap(req: StrategySwap, idempotencyKey: string) {
      try {
        const intent = await buildIntent(req);
        const result = await deps.gateway.execute(intent, { idempotencyKey });
        if (result.error) {
          return {
            ok: false,
            text: `${result.error.code} — ${result.error.message}`,
          };
        }
        return {
          ok: result.state === "confirmed" || result.simulated,
          text: result.summary,
          signature: result.signature,
        };
      } catch (e) {
        // A non-throwing executor: the runner's error breaker counts this,
        // and three in a row pause the strategy.
        return { ok: false, text: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  async function buildIntent(req: StrategySwap): Promise<TradeIntent> {
    if (!Number.isFinite(req.amountUi) || req.amountUi <= 0) {
      throw new Error(
        `${STRATEGY_SOURCE}: input leg must be positive (got ${req.amountUi})`,
      );
    }
    const inputDecimals = await decimalsFor(req.inputMint);
    const amount = toBaseUnits(req.amountUi, inputDecimals);
    if (amount <= 0n) {
      throw new Error(
        `${STRATEGY_SOURCE}: ${req.amountUi} rounds to zero base units of ${req.inputMint}`,
      );
    }
    const slippageBps = req.slippageBps ?? deps.defaultSlippageBps ?? 100;
    const quote = await deps.jupiter.quote({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount,
      slippageBps,
    });
    const build = await deps.jupiter.buildSwap({
      quote,
      userPublicKey: deps.ownerWallet,
      priorityFeeLamports,
    });
    const outputDecimals = await decimalsFor(req.outputMint);

    return {
      kind: "swap",
      source: STRATEGY_SOURCE,
      input: { mint: req.inputMint, amount, decimals: inputDecimals },
      output: { mint: req.outputMint, decimals: outputDecimals },
      inputProvenance: provenanceFor(req.inputMint),
      outputProvenance: provenanceFor(req.outputMint),
      unsignedTxBase64: build.swapTransactionB64,
      recentBlockhash: build.recentBlockhash,
      lastValidBlockHeight: build.lastValidBlockHeight,
      landMode: "self-rpc",
      landHandle: undefined,
      priorityFeeLamports: build.prioritizationFeeLamports,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        minOutAmount: quote.otherAmountThreshold,
        priceImpactPct: quote.priceImpactPct,
        routeLabel: quote.routeLabel,
        slippageBps: quote.slippageBps,
        contextSlot: quote.contextSlot,
      },
      summary: `${req.kind} ${req.amountUi} of ${short(req.inputMint)} → ${short(req.outputMint)} (autonomous strategy)`,
    };
  }

  if (deps.price) executor.price = deps.price;
  if (deps.notify) executor.notify = deps.notify;
  return executor;
}

function short(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}
