/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod";
import {
  type IntentToolDefinition,
  type ToolContext,
} from "../../kernel/contracts.js";
import { toBaseUnits } from "../../kernel/money.js";
import { PerpGuardError } from "../errors.js";
import { positionIn } from "../exposure.js";
import { buildPerpIntent } from "../intent.js";
import { oppositeSide } from "../types.js";
import {
  accountRef,
  DEFAULT_SLIPPAGE_BPS,
  type PerpsToolDeps,
  priorityFee,
  readSnapshot,
} from "./deps.js";
import {
  makeProposal,
  type PerpProposal,
  proposalPreview,
  proposalResult,
  readFunding,
} from "./propose.js";

const configSchema = z
  .object({
    market: z.string().min(3),
    direction: z.enum(["increase", "reduce"]),
    /** Base-asset size to add or remove, in UI units (e.g. 0.5 SOL of SOL-PERP). */
    baseUi: z.number().positive(),
    /** Additional margin for an increase. Required when increasing, ignored when reducing. */
    collateralUi: z.number().positive().optional(),
    leverage: z.number().positive().max(100).optional(),
    orderType: z.enum(["market", "limit"]).optional(),
    limitPrice: z.number().positive().optional(),
    slippageBps: z.number().int().nonnegative().max(5000).optional(),
  })
  .refine(
    (c) =>
      c.direction === "reduce" ||
      (c.collateralUi !== undefined && c.leverage !== undefined),
    {
      message: "increasing a position requires both collateralUi and leverage",
      path: ["collateralUi"],
    },
  );
export type PerpsAdjustConfig = z.infer<typeof configSchema>;

const REDUCING_LEVERAGE = 1;

async function build(
  deps: PerpsToolDeps,
  ctx: ToolContext,
  cfg: PerpsAdjustConfig,
  dryRun: boolean,
): Promise<PerpProposal> {
  const account = accountRef(deps, ctx);
  const market = await deps.venue.getMarket(cfg.market);
  const prices = await deps.venue.getPrices(market.symbol);
  const { funding, warning } = await readFunding(deps, market.symbol);
  const snapshot = await readSnapshot(deps, account);

  const position = positionIn(snapshot.positions, market.symbol);
  if (!position) {
    throw new PerpGuardError(
      "NO_POSITION",
      `no open ${market.symbol} position to adjust`,
      { market: market.symbol },
    );
  }

  const increasing = cfg.direction === "increase";
  const orderType = cfg.orderType ?? "market";
  const slippageBps = cfg.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const collateralAsset = deps.collateral();
  const collateral = {
    mint: collateralAsset.mint,
    // A reduce posts no new margin, so its input leg is zero and it consumes no spend cap.
    amount: increasing
      ? toBaseUnits(cfg.collateralUi ?? 0, collateralAsset.decimals)
      : 0n,
    decimals: collateralAsset.decimals,
  };

  const venueBuild = await deps.venue.buildAdjust({
    account,
    market,
    direction: cfg.direction,
    baseAmountDelta: toBaseUnits(cfg.baseUi, market.baseDecimals),
    collateral,
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    priorityFeeLamports: priorityFee(deps),
  });

  const intent = buildPerpIntent({
    kind: increasing ? "perp_increase" : "perp_reduce",
    source: "perps_adjust",
    market,
    account,
    // Increasing trades WITH the position; reducing trades against it.
    side: increasing ? position.side : oppositeSide(position.side),
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    leverage: increasing ? (cfg.leverage ?? 1) : REDUCING_LEVERAGE,
    collateral,
    prices,
    funding,
    build: venueBuild,
    collateralProvenance: deps.collateralProvenance?.() ?? "user",
  });

  const warnings = [...venueBuild.venueWarnings];
  if (warning) warnings.push(warning);
  return makeProposal(deps, snapshot, intent, warnings, dryRun);
}

/**
 * Increase or reduce an existing perp position by a base-size delta. An increase
 * carries the full opening guard set (leverage, caps, liquidation distance,
 * funding); a reduce carries only the reduction-consistency guards, so getting
 * smaller is never blocked by an entry-quality rule. Builds an intent; never executes.
 */
export function makePerpsAdjustTool(
  deps: PerpsToolDeps,
): IntentToolDefinition<PerpsAdjustConfig> {
  return {
    name: "perps_adjust",
    category: "perps",
    description:
      "Propose increasing or reducing an open perp position by a base-size delta. Builds an intent for the kernel; never executes.",
    capabilities: ["sign", "spend", "network"],
    execPolicy: { timeoutMs: 30_000, retries: 0, idempotent: false },
    configSchema,
    async simulate(ctx, cfg) {
      return proposalPreview(await build(deps, ctx, cfg, true));
    },
    async execute(ctx, cfg) {
      return proposalResult(await build(deps, ctx, cfg, false));
    },
  };
}
