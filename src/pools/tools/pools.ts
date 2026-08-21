/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod";
import {
  type IntentToolDefinition,
  type MintInfo,
  type Preview,
  type ToolContext,
  type ToolOutcome,
} from "../../kernel/contracts.js";
import { formatAmount, toBaseUnits } from "../../kernel/money.js";
import { PoolGuardError, throwRefusal } from "../errors.js";
import { guardLpOpen, guardLevelRange } from "../guards.js";
import {
  assertWalletSignableAlone,
  type BuiltIntent,
  toTradeIntent,
  withdrawInputLeg,
} from "../intent.js";
import {
  binSpan,
  rangeAroundActive,
  rangeWidthPct,
  uiPriceOfBin,
} from "../meteora/bins.js";
import { decideRebalance } from "../rebalance/decide.js";
import {
  LIQUIDITY_SHAPES,
  type LiquidityShape,
  type LpPosition,
  type PoolSummary,
} from "../types.js";
import { type PoolsDeps, readRugHeat } from "./deps.js";
import { shortAddr } from "./util.js";

/**
 * Agent-facing liquidity tools.
 *
 * They follow the same contract as `swap_jupiter`: `simulate()` returns a real
 * preview plus the exact intent the kernel would receive, and `execute()` hands
 * that intent to `ctx.gateway.execute()` and nothing else. No tool in this file
 * signs, broadcasts, or holds key material — the LLM's reachable surface ends at
 * "here is a structured intent".
 */

// ── pools_list ───────────────────────────────────────────────────────────────

const listSchema = z.object({
  mint: z.string().min(32),
  limit: z.number().int().positive().max(20).optional(),
});
type ListConfig = z.infer<typeof listSchema>;

function renderPool(p: PoolSummary): string {
  const liq =
    p.liquidityQuote === undefined
      ? "n/a"
      : formatAmount(p.liquidityQuote, p.quoteDecimals, 2);
  const apr =
    p.feeApr24hPct === undefined ? "n/a" : `${p.feeApr24hPct.toFixed(2)}%`;
  return (
    `${p.name ?? shortAddr(p.address)}  ${shortAddr(p.address)}\n` +
    `  binStep ${p.levelStepBps}bps · fee ${(p.baseFeeBps / 100).toFixed(2)}% · active bin ${p.activeLevel} @ ${p.activePrice.toPrecision(6)}\n` +
    `  quote-side liquidity ${liq} · 24h fees ${p.fees24hUsd === undefined ? "n/a" : `$${Math.round(p.fees24hUsd)}`} · apr ${apr}`
  );
}

export function makePoolsListTool(
  deps: PoolsDeps,
): IntentToolDefinition<ListConfig> {
  async function render(
    cfg: ListConfig,
  ): Promise<{ text: string; data: readonly PoolSummary[] }> {
    const pools = await deps.venue.listPools({
      mint: cfg.mint,
      limit: cfg.limit ?? 5,
    });
    if (pools.length === 0) {
      return {
        text:
          `No ${deps.venue.id} pools found for ${shortAddr(cfg.mint)} in the scanned window. ` +
          "Discovery scans the deepest pools only — pass a pool address directly if you have one.",
        data: [],
      };
    }
    return { text: pools.map(renderPool).join("\n"), data: pools };
  }

  return {
    name: "pools_list",
    category: "lp",
    description:
      "List concentrated-liquidity pools for a token mint (bin step, active bin, quote-side liquidity, 24h fees, APR). Read-only.",
    capabilities: ["read", "network"],
    execPolicy: { timeoutMs: 20_000, retries: 2, idempotent: true },
    configSchema: listSchema,
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

// ── pools_position ───────────────────────────────────────────────────────────

const positionSchema = z.object({
  poolAddress: z.string().min(32).optional(),
  positionAddress: z.string().min(32).optional(),
});
type PositionConfig = z.infer<typeof positionSchema>;

function renderPosition(p: LpPosition): string {
  const lower = uiPriceOfBin(
    p.lowerLevel,
    p.levelStepBps,
    p.baseDecimals,
    p.quoteDecimals,
  );
  const upper = uiPriceOfBin(
    p.upperLevel,
    p.levelStepBps,
    p.baseDecimals,
    p.quoteDecimals,
  );
  const inRange =
    p.activeLevel >= p.lowerLevel && p.activeLevel <= p.upperLevel;
  return (
    `${shortAddr(p.positionAddress)} in ${shortAddr(p.poolAddress)}\n` +
    `  bins ${p.lowerLevel}..${p.upperLevel} (${binSpan(p.lowerLevel, p.upperLevel)} bins, ` +
    `${rangeWidthPct(p.lowerLevel, p.upperLevel, p.levelStepBps).toFixed(2)}% wide) · active ${p.activeLevel} ` +
    `${inRange ? "✓ IN RANGE" : "✗ OUT OF RANGE — earning nothing"}\n` +
    `  range ${lower.toPrecision(6)} → ${upper.toPrecision(6)}\n` +
    `  holds ${formatAmount(p.baseAmount, p.baseDecimals, 4)} base + ${formatAmount(p.quoteAmount, p.quoteDecimals, 4)} quote\n` +
    `  unclaimed fees ${formatAmount(p.unclaimedFeeBase, p.baseDecimals, 6)} base + ${formatAmount(p.unclaimedFeeQuote, p.quoteDecimals, 6)} quote`
  );
}

export function makePoolsPositionTool(
  deps: PoolsDeps,
): IntentToolDefinition<PositionConfig> {
  async function load(
    ctx: ToolContext,
    cfg: PositionConfig,
  ): Promise<readonly LpPosition[]> {
    if (cfg.positionAddress && cfg.poolAddress) {
      const one = await deps.venue.getPosition(
        cfg.poolAddress,
        cfg.positionAddress,
        ctx.ownerWallet,
      );
      return one ? [one] : [];
    }
    return deps.venue.listPositions(ctx.ownerWallet, cfg.poolAddress);
  }

  async function render(
    ctx: ToolContext,
    cfg: PositionConfig,
  ): Promise<{ text: string; data: readonly LpPosition[] }> {
    const positions = await load(ctx, cfg);
    if (positions.length === 0)
      return { text: "No open liquidity positions.", data: [] };
    return {
      text: positions.map(renderPosition).join("\n\n"),
      data: positions,
    };
  }

  return {
    name: "pools_position",
    category: "lp",
    description:
      "Show the wallet’s liquidity positions: bin range, in/out of range, deposited amounts and unclaimed fees. Read-only.",
    capabilities: ["read", "read_state", "network"],
    execPolicy: { timeoutMs: 25_000, retries: 2, idempotent: true },
    configSchema: positionSchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const { text, data } = await render(ctx, cfg);
      return {
        summary: text,
        quote: undefined,
        warnings: [],
        intent: undefined,
        data,
      };
    },
    async execute(ctx, cfg): Promise<ToolOutcome> {
      const { text, data } = await render(ctx, cfg);
      return { isError: false, text, data };
    },
  };
}

// ── pools_open ───────────────────────────────────────────────────────────────

const openSchema = z.object({
  poolAddress: z.string().min(32),
  /** Quote asset (SOL/USDC) to deposit — the leg the kernel caps. */
  quoteAmountUi: z.number().positive(),
  /** Optional base-asset leg for a two-sided deposit. */
  baseAmountUi: z.number().nonnegative().optional(),
  belowBins: z.number().int().nonnegative().max(69).optional(),
  aboveBins: z.number().int().nonnegative().max(69).optional(),
  shape: z.enum(LIQUIDITY_SHAPES).optional(),
  /** Add to an existing position instead of opening a new one. */
  positionAddress: z.string().min(32).optional(),
});
type OpenConfig = z.infer<typeof openSchema>;

async function inspectMints(
  ctx: ToolContext,
  mints: readonly string[],
): Promise<readonly (MintInfo | null)[]> {
  return Promise.all(
    mints.map((m) => ctx.services.solana.getMintInfo(m).catch(() => null)),
  );
}

export function makePoolsOpenTool(
  deps: PoolsDeps,
): IntentToolDefinition<OpenConfig> {
  async function build(
    ctx: ToolContext,
    cfg: OpenConfig,
  ): Promise<BuiltIntent> {
    const pool = await deps.venue.getPool(cfg.poolAddress);
    const quoteAmount = toBaseUnits(cfg.quoteAmountUi, pool.quoteDecimals);
    const baseAmount = cfg.baseAmountUi
      ? toBaseUnits(cfg.baseAmountUi, pool.baseDecimals)
      : 0n;

    const range = rangeAroundActive(
      pool.activeLevel,
      cfg.belowBins ?? 10,
      cfg.aboveBins ?? 10,
      deps.guards.maxLevelSpan,
    );
    const shape: LiquidityShape = cfg.shape ?? "spot";

    const [mints, openPositions, baseHoldings, existing] = await Promise.all([
      inspectMints(ctx, [pool.baseMint, pool.quoteMint]),
      deps.venue.listPositions(ctx.ownerWallet),
      baseAmount > 0n
        ? deps.chain
            .getTokenBalance(ctx.ownerWallet, pool.baseMint)
            .catch(() => null)
        : Promise.resolve(0n),
      cfg.positionAddress
        ? deps.venue.getPosition(
            cfg.poolAddress,
            cfg.positionAddress,
            ctx.ownerWallet,
          )
        : Promise.resolve(null),
    ]);

    const refusal = guardLpOpen(deps.guards, {
      pool,
      input: {
        mint: pool.quoteMint,
        amount: quoteAmount,
        decimals: pool.quoteDecimals,
      },
      baseAmount,
      baseHoldings,
      mints,
      rugHeat: readRugHeat(deps, pool.baseMint),
      addQuote: quoteAmount,
      existingPositionQuote: existing?.quoteAmount ?? 0n,
      openPositions,
      isNewPosition: !cfg.positionAddress,
      lowerLevel: range.lowerBinId,
      upperLevel: range.upperBinId,
    });
    if (refusal) throwRefusal(refusal);

    const draft = await deps.venue.buildOpen({
      poolAddress: cfg.poolAddress,
      owner: ctx.ownerWallet,
      quoteAmount,
      baseAmount,
      lowerLevel: range.lowerBinId,
      upperLevel: range.upperBinId,
      shape,
      priorityFeeLamports: deps.priorityFeeLamports ?? 200_000,
      ...(cfg.positionAddress ? { positionAddress: cfg.positionAddress } : {}),
    });
    assertWalletSignableAlone(draft, "pools_open");

    const widthPct = rangeWidthPct(
      range.lowerBinId,
      range.upperBinId,
      pool.levelStepBps,
    );
    const summary =
      `${cfg.positionAddress ? "Add" : "Open"} ${shape} liquidity in ${pool.name ?? shortAddr(pool.address)}: ` +
      `${cfg.quoteAmountUi} quote${baseAmount > 0n ? ` + ${cfg.baseAmountUi} base` : ""} ` +
      `over bins ${range.lowerBinId}..${range.upperBinId} (${widthPct.toFixed(2)}% wide, active ${pool.activeLevel})`;

    const warnings: string[] = [];
    if (baseAmount > 0n) {
      warnings.push(
        "two-sided deposit: the kernel caps only the quote leg; the base leg is bounded by the pools guard",
      );
    }
    if (!pool.liquidityQuote)
      warnings.push("pool quote-side liquidity unknown");

    const intent = toTradeIntent({
      kind: cfg.positionAddress ? "lp_add" : "lp_open",
      source: "pools_open",
      input: {
        mint: pool.quoteMint,
        amount: quoteAmount,
        decimals: pool.quoteDecimals,
      },
      output: { mint: pool.baseMint, decimals: pool.baseDecimals },
      outputProvenance: "untrusted",
      unsignedTxBase64: draft.unsignedTxBase64,
      recentBlockhash: draft.recentBlockhash,
      lastValidBlockHeight: draft.lastValidBlockHeight,
      priorityFeeLamports: draft.priorityFeeLamports,
      summary,
      // Nothing lands in spot balance: the value moves into the position account.
      expectedOut: 0n,
      minOut: 0n,
      slippageBps: 0,
      routeLabel: `${deps.venue.id} ${shape}`,
    });

    return {
      intent,
      meta: {
        action: cfg.positionAddress ? "lp_add" : "lp_open",
        venue: deps.venue.id,
        poolAddress: pool.address,
        positionAddress: cfg.positionAddress,
        detail: {
          lowerBinId: range.lowerBinId,
          upperBinId: range.upperBinId,
          bins: binSpan(range.lowerBinId, range.upperBinId),
          widthPct,
          shape,
          activeBinId: pool.activeLevel,
        },
        warnings,
      },
    };
  }

  return {
    name: "pools_open",
    category: "lp",
    description:
      "Open or add to a concentrated-liquidity position around the active bin. Builds an intent for the kernel; never signs.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 40_000, retries: 0, idempotent: false },
    configSchema: openSchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const { intent, meta } = await build(ctx, cfg);
      return {
        summary: intent.summary,
        quote: intent.quote,
        warnings: meta.warnings,
        intent,
        data: meta,
      };
    },
    async execute(ctx, cfg, opts): Promise<ToolOutcome> {
      const { intent, meta } = await build(ctx, cfg);
      const r = await ctx.gateway.execute(intent, {
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
        data: { result: r, meta },
      };
    },
  };
}

// ── pools_close ──────────────────────────────────────────────────────────────

const closeSchema = z.object({
  poolAddress: z.string().min(32),
  positionAddress: z.string().min(32),
  /** 1..10000. Defaults to the whole position. */
  bpsToRemove: z.number().int().positive().max(10_000).optional(),
  claimFees: z.boolean().optional(),
  /** Close the emptied position account and reclaim its rent. Only valid at 100%. */
  closePosition: z.boolean().optional(),
});
type CloseConfig = z.infer<typeof closeSchema>;

export function makePoolsCloseTool(
  deps: PoolsDeps,
): IntentToolDefinition<CloseConfig> {
  async function build(
    ctx: ToolContext,
    cfg: CloseConfig,
  ): Promise<BuiltIntent> {
    const bps = cfg.bpsToRemove ?? 10_000;
    const pool = await deps.venue.getPool(cfg.poolAddress);
    const position = await deps.venue.getPosition(
      cfg.poolAddress,
      cfg.positionAddress,
      ctx.ownerWallet,
    );
    if (!position)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        `position ${cfg.positionAddress} not found in ${cfg.poolAddress}`,
      );
    if (position.owner !== ctx.ownerWallet) {
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "that position is not owned by this wallet",
      );
    }

    const priorityFeeLamports = deps.priorityFeeLamports ?? 200_000;
    const draft = await deps.venue.buildRemove({
      poolAddress: cfg.poolAddress,
      positionAddress: cfg.positionAddress,
      owner: ctx.ownerWallet,
      bpsToRemove: bps,
      claimFees: cfg.claimFees ?? true,
      closePosition: (cfg.closePosition ?? true) && bps === 10_000,
      priorityFeeLamports,
    });
    assertWalletSignableAlone(draft, "pools_close");

    const summary =
      `Withdraw ${(bps / 100).toFixed(2)}% of ${shortAddr(cfg.positionAddress)} in ${pool.name ?? shortAddr(pool.address)}` +
      `${cfg.claimFees === false ? "" : " and claim fees"}` +
      ` — returns ~${formatAmount((position.baseAmount * BigInt(bps)) / 10_000n, position.baseDecimals, 4)} base + ` +
      `${formatAmount((position.quoteAmount * BigInt(bps)) / 10_000n, position.quoteDecimals, 4)} quote`;

    // A withdraw takes nothing out of free balance but the transaction's cost, so
    // that cost is the declared input leg — see `intent.ts` for why.
    const intent = toTradeIntent({
      kind: bps === 10_000 ? "lp_close" : "lp_remove",
      source: "pools_close",
      input: withdrawInputLeg({
        priorityFeeLamports: draft.priorityFeeLamports,
      }),
      output: { mint: pool.quoteMint, decimals: pool.quoteDecimals },
      outputProvenance: "untrusted",
      unsignedTxBase64: draft.unsignedTxBase64,
      recentBlockhash: draft.recentBlockhash,
      lastValidBlockHeight: draft.lastValidBlockHeight,
      priorityFeeLamports: draft.priorityFeeLamports,
      summary,
      expectedOut: 0n,
      minOut: 0n,
      slippageBps: 0,
      routeLabel: `${deps.venue.id} withdraw`,
    });

    return {
      intent,
      meta: {
        action: bps === 10_000 ? "lp_close" : "lp_remove",
        venue: deps.venue.id,
        poolAddress: pool.address,
        positionAddress: cfg.positionAddress,
        detail: {
          bpsToRemove: bps,
          claimFees: cfg.claimFees ?? true,
          description: draft.description,
        },
        warnings: [
          "the declared input leg is the transaction cost — a withdraw spends nothing else",
        ],
      },
    };
  }

  return {
    name: "pools_close",
    category: "lp",
    description:
      "Withdraw liquidity from a position (optionally all of it, claiming fees and closing the account). Builds an intent; never signs.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 40_000, retries: 0, idempotent: false },
    configSchema: closeSchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const { intent, meta } = await build(ctx, cfg);
      return {
        summary: intent.summary,
        quote: intent.quote,
        warnings: meta.warnings,
        intent,
        data: meta,
      };
    },
    async execute(ctx, cfg, opts): Promise<ToolOutcome> {
      const { intent, meta } = await build(ctx, cfg);
      const r = await ctx.gateway.execute(intent, {
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
        data: { result: r, meta },
      };
    },
  };
}

// ── pools_rebalance ──────────────────────────────────────────────────────────

const rebalanceSchema = z.object({
  poolAddress: z.string().min(32),
  positionAddress: z.string().min(32),
  /** Report the decision without building the exit intent. */
  dryRun: z.boolean().optional(),
  /** UI price the position was opened at, for the divergence-loss term. */
  entryPrice: z.number().positive().optional(),
});
type RebalanceConfig = z.infer<typeof rebalanceSchema>;

export function makePoolsRebalanceTool(
  deps: PoolsDeps,
): IntentToolDefinition<RebalanceConfig> {
  async function decide(ctx: ToolContext, cfg: RebalanceConfig) {
    const [pool, position] = await Promise.all([
      deps.venue.getPool(cfg.poolAddress),
      deps.venue.getPosition(
        cfg.poolAddress,
        cfg.positionAddress,
        ctx.ownerWallet,
      ),
    ]);
    if (!position)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        `position ${cfg.positionAddress} not found`,
      );
    if (position.owner !== ctx.ownerWallet) {
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "that position is not owned by this wallet",
      );
    }

    const now = (deps.now ?? Date.now)();
    const policy = deps.rebalancePolicy;
    const priorityFeeLamports = deps.priorityFeeLamports ?? 200_000;

    // Notional in quote terms: the quote leg plus the base leg valued at the pool's
    // own active-bin price. This feeds the IL term and the fee projection only —
    // never a cap, so a bad price here can cost one transaction fee, not a position.
    // Guard the float BEFORE it reaches BigInt(): `BigInt(NaN)` throws, and a
    // rebalance preview must never blow up on an unpriceable pool.
    const notionalQuote =
      position.quoteAmount + baseValuedInQuote(position, pool.activePrice);

    // Fee projection: the pool's own 24h fee/TVL ratio applied to our notional.
    const aprPct = pool.feeApr24hPct;
    const projectedFeesPerDayQuote =
      aprPct !== undefined && Number.isFinite(aprPct) && aprPct >= 0
        ? (notionalQuote * BigInt(Math.round(aprPct * 1_000_000))) /
          100_000_000n
        : null;

    const decision = decideRebalance({
      position,
      pool,
      policy,
      now,
      history: deps.ledger.history(cfg.positionAddress, now),
      economics: {
        projectedFeesPerDayQuote,
        // Round trip = exit tx + re-entry tx, each paying base + priority fee.
        txCostQuote: quoteCostOfLamports(
          2n * BigInt(priorityFeeLamports + 10_000),
          pool,
        ),
        // Re-centring crosses inventory through the pool at its own fee.
        inventorySwapCostQuote:
          (notionalQuote * BigInt(Math.max(1, pool.baseFeeBps))) / 10_000n,
        positionNotionalQuote: notionalQuote,
        entryUiPrice: cfg.entryPrice ?? null,
        claimableFeesQuote: position.unclaimedFeeQuote,
      },
    });
    return { pool, position, decision };
  }

  async function build(
    ctx: ToolContext,
    cfg: RebalanceConfig,
  ): Promise<{
    text: string;
    built: BuiltIntent | null;
    warnings: string[];
    data: unknown;
  }> {
    const { pool, position, decision } = await decide(ctx, cfg);
    const lines = [
      `Position ${shortAddr(cfg.positionAddress)} · bins ${position.lowerLevel}..${position.upperLevel} · active ${pool.activeLevel} · drift ${decision.drift}`,
      `Decision: ${decision.action.toUpperCase()} — ${decision.reason}`,
    ];
    if (decision.economics) {
      const e = decision.economics;
      lines.push(
        `Economics (quote base units): projected fees ${e.projectedFeesQuote} · cash cost ${e.cashCostQuote} · ` +
          `divergence ${e.divergenceCostQuote} · net ${e.netBenefitQuote} · claimable ${e.claimableFeesQuote}`,
      );
    }
    if (decision.action === "hold" || cfg.dryRun) {
      return {
        text: lines.join("\n"),
        built: null,
        warnings: [],
        data: decision,
      };
    }

    const target = decision.targetRange;
    if (!target)
      return {
        text: lines.join("\n"),
        built: null,
        warnings: [],
        data: decision,
      };

    const rangeRefusal = guardLevelRange(deps.guards, {
      lowerLevel: target.lowerBinId,
      upperLevel: target.upperBinId,
      activeLevel: pool.activeLevel,
    });
    if (rangeRefusal) throwRefusal(rangeRefusal);

    const priorityFeeLamports = deps.priorityFeeLamports ?? 200_000;
    const draft = await deps.venue.buildRemove({
      poolAddress: cfg.poolAddress,
      positionAddress: cfg.positionAddress,
      owner: ctx.ownerWallet,
      bpsToRemove: 10_000,
      claimFees: true,
      closePosition: true,
      priorityFeeLamports,
    });
    assertWalletSignableAlone(draft, "pools_rebalance");

    const summary =
      `Rebalance step 1/2 — exit ${shortAddr(cfg.positionAddress)} (bins ${position.lowerLevel}..${position.upperLevel}), ` +
      `then re-open on bins ${target.lowerBinId}..${target.upperBinId} around active ${pool.activeLevel}`;

    const intent = toTradeIntent({
      kind: "lp_rebalance",
      source: "pools_rebalance",
      input: withdrawInputLeg({
        priorityFeeLamports: draft.priorityFeeLamports,
      }),
      output: { mint: pool.quoteMint, decimals: pool.quoteDecimals },
      outputProvenance: "untrusted",
      unsignedTxBase64: draft.unsignedTxBase64,
      recentBlockhash: draft.recentBlockhash,
      lastValidBlockHeight: draft.lastValidBlockHeight,
      priorityFeeLamports: draft.priorityFeeLamports,
      summary,
      expectedOut: 0n,
      minOut: 0n,
      slippageBps: 0,
      routeLabel: `${deps.venue.id} rebalance-exit`,
    });

    // A DLMM position's bin range is fixed at initialisation, so re-centring means
    // a NEW position account — which needs a second signer. The exit half is
    // executable today; the re-entry half is handed back as a ready `pools_open`
    // config for a caller that has an existing position covering the target range,
    // or once the kernel grows an ephemeral co-signer.
    const followUp = {
      tool: "pools_open",
      config: {
        poolAddress: cfg.poolAddress,
        quoteAmountUi:
          Number(position.quoteAmount) / 10 ** position.quoteDecimals,
        belowBins: pool.activeLevel - target.lowerBinId,
        aboveBins: target.upperBinId - pool.activeLevel,
        shape: deps.rebalancePolicy.shape,
      },
    };

    lines.push(
      "",
      summary,
      "",
      "Step 2/2 (run after step 1 confirms):",
      JSON.stringify(followUp.config),
    );
    return {
      text: lines.join("\n"),
      built: {
        intent,
        meta: {
          action: "lp_rebalance",
          venue: deps.venue.id,
          poolAddress: pool.address,
          positionAddress: cfg.positionAddress,
          detail: { decision, followUp },
          warnings: [
            "this intent is the EXIT half only; re-entry needs a fresh position account",
            "the declared input leg is the transaction cost — a withdraw spends nothing else",
          ],
        },
      },
      warnings: [
        "this intent is the EXIT half only; re-entry needs a fresh position account",
      ],
      data: { decision, followUp },
    };
  }

  return {
    name: "pools_rebalance",
    category: "lp",
    description:
      "Decide whether a liquidity position has drifted enough to re-centre (drift, interval, daily cap and fee-vs-cost economics), and build the exit intent when it has.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 40_000, retries: 0, idempotent: false },
    configSchema: rebalanceSchema,
    async simulate(ctx, cfg): Promise<Preview> {
      const { text, built, warnings, data } = await build(ctx, cfg);
      return {
        summary: text,
        quote: built?.intent.quote,
        warnings,
        intent: built?.intent,
        data,
      };
    },
    async execute(ctx, cfg, opts): Promise<ToolOutcome> {
      const { text, built, data } = await build(ctx, cfg);
      if (!built) return { isError: false, text, data };
      const r = await ctx.gateway.execute(built.intent, {
        idempotencyKey: opts.idempotencyKey,
        confirmedByUser: opts.confirmedByUser ?? false,
      });
      if (r.error && r.state !== "confirmed")
        return {
          isError: true,
          text: `${r.error.code}: ${r.error.message}`,
          data: r,
        };
      deps.ledger.record(cfg.positionAddress, (deps.now ?? Date.now)());
      return {
        isError: false,
        text: `${text}\n\n${r.summary}${r.signature ? `\nsig: ${r.signature}` : ""}`,
        data: { result: r, ...(data as object) },
      };
    },
  };
}

/**
 * The base leg of a position, valued in quote base units at `uiPrice`.
 * Returns 0 for an unusable price rather than throwing — an unpriceable pool
 * should degrade to "we cannot justify a rebalance", not to an exception.
 */
function baseValuedInQuote(position: LpPosition, uiPrice: number): bigint {
  if (position.baseAmount <= 0n) return 0n;
  if (!Number.isFinite(uiPrice) || uiPrice <= 0) return 0n;
  const value =
    (Number(position.baseAmount) / 10 ** position.baseDecimals) *
    uiPrice *
    10 ** position.quoteDecimals;
  if (!Number.isFinite(value) || value < 0) return 0n;
  return BigInt(Math.round(value));
}

/** Lamports expressed in the pool's quote asset. Identity when the quote *is* SOL. */
function quoteCostOfLamports(lamports: bigint, pool: PoolSummary): bigint {
  if (pool.quoteDecimals === 9) return lamports;
  // A non-SOL quote would need a SOL price to convert. Rather than invent one,
  // charge the cost at parity in the quote's own precision — an over-estimate for
  // USDC, which biases the decision toward *not* rebalancing. Safe direction.
  const scale = 10 ** Math.max(0, 9 - pool.quoteDecimals);
  return lamports / BigInt(scale === 0 ? 1 : scale);
}
