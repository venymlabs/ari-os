/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  type IntentToolDefinition,
  type MintInfo,
  type Preview,
  type ToolContext,
  type ToolOutcome,
} from "../../kernel/contracts.js";
import {
  SOL_DECIMALS,
  WSOL_MINT,
  formatAmount,
  fromBaseUnits,
  toBaseUnits,
} from "../../kernel/money.js";
import { PoolGuardError, throwRefusal } from "../errors.js";
import { guardCurveBuy, guardCurveSell } from "../guards.js";
import { type BuiltIntent, toTradeIntent } from "../intent.js";
import type { CurveState } from "../pumpfun/client.js";
import {
  buildBuyInstruction,
  buildSellInstruction,
  buildUnsignedTx,
  type CurveIxContext,
  ensureUserAtaInstruction,
  pickFeeRecipient,
} from "../pumpfun/instructions.js";
import { quoteBuyForSolBudget, quoteSell } from "../pumpfun/math.js";
import {
  routeForCurve,
  routeForMissingCurve,
  type RoutingDecision,
} from "../pumpfun/migration.js";
import { type PoolsDeps, readRugHeat } from "./deps.js";
import { shortAddr } from "./util.js";

/**
 * Direct bonding-curve trading for pre-migration pump.fun tokens.
 *
 * Aggregators cannot route a live curve, so these build the curve instructions
 * themselves. The moment a curve **completes**, the opposite is true — the token
 * is a normal AMM asset and Jupiter is strictly better — so these tools detect
 * that and *delegate* rather than compete: the result carries a `delegateTo`
 * payload naming `swap_jupiter` and the exact config to call it with. This
 * package never re-implements routing that already exists.
 */

export interface DelegationPayload {
  readonly delegateTo: "swap_jupiter";
  readonly reason: string;
  readonly config: {
    readonly inputMint: string;
    readonly outputMint: string;
    readonly amountUi: number;
    readonly slippageBps: number | undefined;
  };
}

function delegation(
  reason: string,
  cfg: DelegationPayload["config"],
): DelegationPayload {
  return { delegateTo: "swap_jupiter", reason, config: cfg };
}

async function loadCurve(
  deps: PoolsDeps,
  mint: string,
): Promise<{ curve: CurveState | null; route: RoutingDecision }> {
  const curve = await deps.curve.readCurve(mint);
  if (!curve) return { curve: null, route: routeForMissingCurve(mint) };
  return { curve, route: routeForCurve(curve) };
}

function feeRecipientFor(curve: CurveState, seed: number): PublicKey {
  return pickFeeRecipient(
    curve.global.feeRecipients,
    curve.global.feeRecipient,
    seed,
  );
}

function ixContext(
  curve: CurveState,
  user: string,
  seed: number,
): CurveIxContext {
  if (!curve.creator) {
    throw new PoolGuardError(
      "POOL_UNSUPPORTED_CURVE",
      `${curve.mint}: curve has no creator field; creator_vault cannot be derived`,
    );
  }
  return {
    user: new PublicKey(user),
    mint: new PublicKey(curve.mint),
    creator: new PublicKey(curve.creator),
    feeRecipient: feeRecipientFor(curve, seed),
    programId: deriveProgramId(curve),
  };
}

function deriveProgramId(_curve: CurveState): undefined {
  // Program id is fixed; kept as a seam so a devnet deployment can be pinned later.
  return undefined;
}

// ── pumpfun_curve ────────────────────────────────────────────────────────────

const curveSchema = z.object({ mint: z.string().min(32) });
type CurveConfig = z.infer<typeof curveSchema>;

export function makePumpfunCurveTool(
  deps: PoolsDeps,
): IntentToolDefinition<CurveConfig> {
  async function render(
    cfg: CurveConfig,
  ): Promise<{ text: string; data: unknown }> {
    // Warm the trade tape so the rug-heat gate has something to read on the next call.
    deps.watch?.(cfg.mint);
    const { curve, route } = await loadCurve(deps, cfg.mint);
    if (!curve) {
      return {
        text: `${shortAddr(cfg.mint)} has no pump.fun bonding curve — ${route.reason}.`,
        data: { route },
      };
    }
    const heat = readRugHeat(deps, cfg.mint);
    const lines = [
      `${shortAddr(cfg.mint)} · curve ${shortAddr(curve.curveAddress)}`,
      `price ${curve.uiPriceSol.toPrecision(6)} SOL · mcap ${formatAmount(curve.marketCapLamports, SOL_DECIMALS, 2)} SOL`,
      `progress ${curve.progressPct.toFixed(1)}% to migration · ${curve.complete ? "COMPLETE (migrated)" : "live"}`,
      `real reserves ${formatAmount(curve.realSolReserves, SOL_DECIMALS, 4)} SOL / ${formatAmount(curve.realTokenReserves, curve.tokenDecimals, 0)} tokens`,
      `virtual reserves ${formatAmount(curve.virtualSolReserves, SOL_DECIMALS, 4)} SOL / ${formatAmount(curve.virtualTokenReserves, curve.tokenDecimals, 0)} tokens`,
      `fee ${(Number(curve.feeBps) / 100).toFixed(2)}% (${curve.feeSource}) · route: ${route.route}`,
    ];
    if (heat)
      lines.push(`rug-heat ${heat.score}/100 — ${heat.reasons[0] ?? ""}`);
    else
      lines.push(
        "rug-heat unavailable (no signals engine / cold tape) — buys will be refused until the tape warms",
      );
    if (route.refusal)
      lines.push(`⚠ ${route.refusal.code}: ${route.refusal.message}`);
    return {
      text: lines.join("\n"),
      data: { curve: serialisable(curve), route, rugHeat: heat },
    };
  }

  return {
    name: "pumpfun_curve",
    category: "launchpad",
    description:
      "Inspect a pump.fun bonding curve: price, reserves, fee tier, progress to migration, and whether to trade the curve or route via Jupiter. Read-only.",
    capabilities: ["read", "network"],
    execPolicy: { timeoutMs: 20_000, retries: 2, idempotent: true },
    configSchema: curveSchema,
    async simulate(_ctx, cfg): Promise<Preview> {
      const { text, data } = await render(cfg);
      return {
        summary: text,
        quote: undefined,
        warnings: [],
        intent: undefined,
        data,
      };
    },
    async execute(_ctx, cfg): Promise<ToolOutcome> {
      const { text, data } = await render(cfg);
      return { isError: false, text, data };
    },
  };
}

/** Strip `bigint`s so the payload survives JSON journalling. */
function serialisable(c: CurveState): Record<string, unknown> {
  return {
    mint: c.mint,
    curveAddress: c.curveAddress,
    creator: c.creator,
    complete: c.complete,
    solPaired: c.solPaired,
    feeBps: Number(c.feeBps),
    feeSource: c.feeSource,
    uiPriceSol: c.uiPriceSol,
    progressPct: c.progressPct,
    virtualSolReserves: c.virtualSolReserves.toString(),
    virtualTokenReserves: c.virtualTokenReserves.toString(),
    realSolReserves: c.realSolReserves.toString(),
    realTokenReserves: c.realTokenReserves.toString(),
    marketCapLamports: c.marketCapLamports.toString(),
    tokenDecimals: c.tokenDecimals,
  };
}

// ── pumpfun_buy ──────────────────────────────────────────────────────────────

const buySchema = z.object({
  mint: z.string().min(32),
  /** SOL to spend, all-in (curve cost + fee). */
  amountUi: z.number().positive(),
  slippageBps: z.number().int().positive().max(5_000).optional(),
});
type BuyConfig = z.infer<typeof buySchema>;

const DEFAULT_CURVE_SLIPPAGE_BPS = 100;

export function makePumpfunBuyTool(
  deps: PoolsDeps,
): IntentToolDefinition<BuyConfig> {
  async function build(
    ctx: ToolContext,
    cfg: BuyConfig,
  ): Promise<BuiltIntent | DelegationPayload> {
    const { curve, route } = await loadCurve(deps, cfg.mint);
    if (!curve || route.route === "jupiter") {
      return delegation(route.reason, {
        inputMint: WSOL_MINT,
        outputMint: cfg.mint,
        amountUi: cfg.amountUi,
        slippageBps: cfg.slippageBps,
      });
    }
    if (route.refusal) throwRefusal(route.refusal);

    const slippageBps = cfg.slippageBps ?? DEFAULT_CURVE_SLIPPAGE_BPS;
    const solBudget = toBaseUnits(cfg.amountUi, SOL_DECIMALS);

    const mintInfo: MintInfo | null = await ctx.services.solana
      .getMintInfo(cfg.mint)
      .catch(() => null);
    const refusal = guardCurveBuy(deps.guards, {
      input: { mint: WSOL_MINT, amount: solBudget, decimals: SOL_DECIMALS },
      slippageBps,
      curve: {
        realSolReserves: curve.realSolReserves,
        complete: curve.complete,
      },
      // The curve mint keeps a live mint authority until migration by design, so the
      // *authority* check is satisfied by the curve's own guard, not by pretending
      // the mint is clean: pump mints are allowlisted only when the operator says so.
      mints: [mintInfo],
      rugHeat: readRugHeat(deps, cfg.mint),
    });
    if (refusal) throwRefusal(refusal);

    const quote = quoteBuyForSolBudget(
      curve,
      solBudget,
      curve.feeBps,
      slippageBps,
    );
    const { blockhash, lastValidBlockHeight } =
      await deps.curve.getLatestBlockhash();
    const ctxIx = ixContext(
      curve,
      ctx.ownerWallet,
      Number(curve.virtualSolReserves % 7n),
    );

    const built = buildUnsignedTx({
      payer: new PublicKey(ctx.ownerWallet),
      instructions: [
        ensureUserAtaInstruction(ctxIx),
        buildBuyInstruction({
          ctx: ctxIx,
          tokenAmount: quote.tokenAmount,
          maxSolCostLamports: quote.maxSolCostLamports,
        }),
      ],
      recentBlockhash: blockhash,
      priorityFeeLamports: deps.priorityFeeLamports ?? 200_000,
    });

    const tokensUi = fromBaseUnits(quote.tokenAmount, curve.tokenDecimals);
    const summary =
      `Buy ${tokensUi.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${shortAddr(cfg.mint)} on the pump.fun curve ` +
      `for ≤ ${formatAmount(quote.maxSolCostLamports, SOL_DECIMALS, 6)} SOL ` +
      `(${formatAmount(quote.totalLamports, SOL_DECIMALS, 6)} at quote · ${quote.priceImpactPct.toFixed(2)}% impact · ` +
      `fee ${(Number(quote.feeBps) / 100).toFixed(2)}% · slippage ${slippageBps}bps)`;

    const warnings: string[] = [];
    if (curve.progressPct > 90)
      warnings.push(
        `curve is ${curve.progressPct.toFixed(1)}% complete — it may migrate mid-flight`,
      );
    if (curve.feeSource === "fallback")
      warnings.push(
        "fee tier could not be read on-chain; a fallback rate was used",
      );
    if (quote.priceImpactPct > 5)
      warnings.push(`high price impact ${quote.priceImpactPct.toFixed(1)}%`);

    // The curve commits to an EXACT token amount and bounds the price via
    // `max_sol_cost`, so slippage lives on the input leg. `minOut === expectedOut`
    // is therefore the truth, not a shortcut — and it is what the kernel's min-out
    // consistency check wants to see.
    const intent = toTradeIntent({
      kind: "curve_buy",
      source: "pumpfun_buy",
      input: {
        mint: WSOL_MINT,
        amount: quote.maxSolCostLamports,
        decimals: SOL_DECIMALS,
      },
      output: { mint: cfg.mint, decimals: curve.tokenDecimals },
      outputProvenance: "untrusted",
      unsignedTxBase64: built.unsignedTxBase64,
      recentBlockhash: built.recentBlockhash,
      lastValidBlockHeight,
      priorityFeeLamports: built.priorityFeeLamports,
      summary,
      expectedOut: quote.tokenAmount,
      minOut: quote.tokenAmount,
      slippageBps,
      routeLabel: "pump.fun bonding curve",
      priceImpactPct: quote.priceImpactPct,
    });

    return {
      intent,
      meta: {
        action: "curve_buy",
        venue: "pumpfun",
        poolAddress: curve.curveAddress,
        positionAddress: undefined,
        detail: {
          tokenAmount: quote.tokenAmount.toString(),
          maxSolCostLamports: quote.maxSolCostLamports.toString(),
          feeBps: Number(quote.feeBps),
          feeSource: curve.feeSource,
          progressPct: curve.progressPct,
        },
        warnings,
      },
    };
  }

  return {
    name: "pumpfun_buy",
    category: "launchpad",
    description:
      "Buy a pre-migration pump.fun token directly on its bonding curve, sized in SOL. Migrated tokens are delegated to swap_jupiter. Builds an intent; never signs.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 30_000, retries: 0, idempotent: false },
    configSchema: buySchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const out = await build(ctx, cfg);
      if ("delegateTo" in out) {
        return {
          summary: delegateText(out),
          quote: undefined,
          warnings: [out.reason],
          intent: undefined,
          data: out,
        };
      }
      return {
        summary: out.intent.summary,
        quote: out.intent.quote,
        warnings: out.meta.warnings,
        intent: out.intent,
        data: out.meta,
      };
    },
    async execute(ctx, cfg, opts): Promise<ToolOutcome> {
      const out = await build(ctx, cfg);
      if ("delegateTo" in out)
        return { isError: true, text: delegateText(out), data: out };
      const r = await ctx.gateway.execute(out.intent, {
        idempotencyKey: opts.idempotencyKey,
        confirmedByUser: opts.confirmedByUser ?? false,
      });
      if (r.error && r.state !== "confirmed")
        return {
          isError: true,
          text: `${r.error.code}: ${r.error.message}`,
          data: r,
        };
      return {
        isError: false,
        text: r.summary + (r.signature ? `\nsig: ${r.signature}` : ""),
        data: { result: r, meta: out.meta },
      };
    },
  };
}

function delegateText(d: DelegationPayload): string {
  return (
    `${d.reason}\n` + `Use swap_jupiter instead: ${JSON.stringify(d.config)}`
  );
}

// ── pumpfun_sell ─────────────────────────────────────────────────────────────

const sellSchema = z
  .object({
    mint: z.string().min(32),
    /** Token amount to sell. Mutually exclusive with `percent`. */
    amountUi: z.number().positive().optional(),
    /** Percentage of the wallet's holding to sell (1..100). */
    percent: z.number().positive().max(100).optional(),
    slippageBps: z.number().int().positive().max(5_000).optional(),
  })
  .refine((v) => v.amountUi !== undefined || v.percent !== undefined, {
    message: "provide either amountUi or percent",
  });
type SellConfig = z.infer<typeof sellSchema>;

export function makePumpfunSellTool(
  deps: PoolsDeps,
): IntentToolDefinition<SellConfig> {
  async function build(
    ctx: ToolContext,
    cfg: SellConfig,
  ): Promise<BuiltIntent | DelegationPayload> {
    const { curve, route } = await loadCurve(deps, cfg.mint);
    const holdings = await deps.chain
      .getTokenBalance(ctx.ownerWallet, cfg.mint)
      .catch(() => 0n);

    if (!curve || route.route === "jupiter") {
      const decimals = curve?.tokenDecimals ?? 6;
      const amountUi =
        cfg.amountUi ??
        fromBaseUnits(
          (holdings * BigInt(Math.round(cfg.percent ?? 100))) / 100n,
          decimals,
        );
      return delegation(route.reason, {
        inputMint: cfg.mint,
        outputMint: WSOL_MINT,
        amountUi,
        slippageBps: cfg.slippageBps,
      });
    }
    if (route.refusal) throwRefusal(route.refusal);

    const slippageBps = cfg.slippageBps ?? DEFAULT_CURVE_SLIPPAGE_BPS;
    const tokenAmount =
      cfg.amountUi !== undefined
        ? toBaseUnits(cfg.amountUi, curve.tokenDecimals)
        : (holdings * BigInt(Math.round(cfg.percent ?? 100))) / 100n;
    if (tokenAmount <= 0n)
      throw new PoolGuardError(
        "POOL_SPEND_CAP",
        "nothing to sell — wallet holds none of this token",
      );
    if (tokenAmount > holdings) {
      throw new PoolGuardError(
        "POOL_SPEND_CAP",
        `wallet holds ${holdings} base units, cannot sell ${tokenAmount}`,
      );
    }

    // Exits are deliberately gated more lightly than entries: rug-heat and the
    // liquidity floor describe exactly the situation you most need to leave.
    const refusal = guardCurveSell(deps.guards, {
      input: {
        mint: cfg.mint,
        amount: tokenAmount,
        decimals: curve.tokenDecimals,
      },
      slippageBps,
      complete: curve.complete,
    });
    if (refusal) throwRefusal(refusal);

    const quote = quoteSell(curve, tokenAmount, curve.feeBps, slippageBps);
    const { blockhash, lastValidBlockHeight } =
      await deps.curve.getLatestBlockhash();
    const ctxIx = ixContext(
      curve,
      ctx.ownerWallet,
      Number(curve.virtualSolReserves % 7n),
    );

    const built = buildUnsignedTx({
      payer: new PublicKey(ctx.ownerWallet),
      instructions: [
        buildSellInstruction({
          ctx: ctxIx,
          tokenAmount,
          minSolOutputLamports: quote.minSolOutputLamports,
        }),
      ],
      recentBlockhash: blockhash,
      priorityFeeLamports: deps.priorityFeeLamports ?? 200_000,
    });

    const summary =
      `Sell ${formatAmount(tokenAmount, curve.tokenDecimals, 2)} ${shortAddr(cfg.mint)} on the pump.fun curve ` +
      `for ≥ ${formatAmount(quote.minSolOutputLamports, SOL_DECIMALS, 6)} SOL ` +
      `(${formatAmount(quote.netSolLamports, SOL_DECIMALS, 6)} at quote · ${quote.priceImpactPct.toFixed(2)}% impact · ` +
      `fee ${(Number(quote.feeBps) / 100).toFixed(2)}%)`;

    const intent = toTradeIntent({
      kind: "curve_sell",
      source: "pumpfun_sell",
      input: {
        mint: cfg.mint,
        amount: tokenAmount,
        decimals: curve.tokenDecimals,
      },
      output: { mint: WSOL_MINT, decimals: SOL_DECIMALS },
      inputProvenance: "untrusted",
      outputProvenance: "user",
      unsignedTxBase64: built.unsignedTxBase64,
      recentBlockhash: built.recentBlockhash,
      lastValidBlockHeight,
      priorityFeeLamports: built.priorityFeeLamports,
      summary,
      expectedOut: quote.netSolLamports,
      minOut: quote.minSolOutputLamports,
      slippageBps,
      routeLabel: "pump.fun bonding curve",
      priceImpactPct: quote.priceImpactPct,
    });

    return {
      intent,
      meta: {
        action: "curve_sell",
        venue: "pumpfun",
        poolAddress: curve.curveAddress,
        positionAddress: undefined,
        detail: {
          tokenAmount: tokenAmount.toString(),
          minSolOutputLamports: quote.minSolOutputLamports.toString(),
          feeBps: Number(quote.feeBps),
          feeSource: curve.feeSource,
        },
        warnings:
          curve.feeSource === "fallback"
            ? ["fee tier could not be read on-chain; a fallback rate was used"]
            : [],
      },
    };
  }

  return {
    name: "pumpfun_sell",
    category: "launchpad",
    description:
      "Sell a pre-migration pump.fun token directly on its bonding curve, by amount or percentage of holdings. Migrated tokens are delegated to swap_jupiter. Builds an intent; never signs.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 30_000, retries: 0, idempotent: false },
    configSchema: sellSchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const out = await build(ctx, cfg);
      if ("delegateTo" in out) {
        return {
          summary: delegateText(out),
          quote: undefined,
          warnings: [out.reason],
          intent: undefined,
          data: out,
        };
      }
      return {
        summary: out.intent.summary,
        quote: out.intent.quote,
        warnings: out.meta.warnings,
        intent: out.intent,
        data: out.meta,
      };
    },
    async execute(ctx, cfg, opts): Promise<ToolOutcome> {
      const out = await build(ctx, cfg);
      if ("delegateTo" in out)
        return { isError: true, text: delegateText(out), data: out };
      const r = await ctx.gateway.execute(out.intent, {
        idempotencyKey: opts.idempotencyKey,
        confirmedByUser: opts.confirmedByUser ?? false,
      });
      if (r.error && r.state !== "confirmed")
        return {
          isError: true,
          text: `${r.error.code}: ${r.error.message}`,
          data: r,
        };
      return {
        isError: false,
        text: r.summary + (r.signature ? `\nsig: ${r.signature}` : ""),
        data: { result: r, meta: out.meta },
      };
    },
  };
}
