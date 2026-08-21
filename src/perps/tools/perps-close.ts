/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod";
import type {
  IntentToolDefinition,
  ToolContext,
} from "../../kernel/contracts.js";
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

const configSchema = z.object({
  market: z.string().min(3),
  /** 10000 = fully close. Defaults to a full close. */
  fractionBps: z.number().int().positive().max(10_000).optional(),
  orderType: z.enum(["market", "limit"]).optional(),
  limitPrice: z.number().positive().optional(),
  slippageBps: z.number().int().nonnegative().max(5000).optional(),
});
export type PerpsCloseConfig = z.infer<typeof configSchema>;

/**
 * Leverage is not meaningful for a reduction, and every leverage-sensitive guard
 * is skipped for reducing kinds. 1 keeps the structural validator satisfied
 * without asserting anything false about the order.
 */
const REDUCING_LEVERAGE = 1;

async function build(
  deps: PerpsToolDeps,
  ctx: ToolContext,
  cfg: PerpsCloseConfig,
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
      `no open ${market.symbol} position to close`,
      { market: market.symbol },
    );
  }

  const fractionBps = cfg.fractionBps ?? 10_000;
  const orderType = cfg.orderType ?? "market";
  const slippageBps = cfg.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const collateralAsset = deps.collateral();
  // A close posts NO new margin: the input leg is zero, so it consumes no spend cap.
  const collateral = {
    mint: collateralAsset.mint,
    amount: 0n,
    decimals: collateralAsset.decimals,
  };

  const venueBuild = await deps.venue.buildClose({
    account,
    market,
    fractionBps,
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    priorityFeeLamports: priorityFee(deps),
  });

  const intent = buildPerpIntent({
    kind: "perp_close",
    source: "perps_close",
    market,
    account,
    // Closing trades AGAINST the position.
    side: oppositeSide(position.side),
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    leverage: REDUCING_LEVERAGE,
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
 * Close (or partially close) a perp position. Reduce-only by construction, so
 * it survives wind-down mode — the agent must always be able to propose getting
 * flat. Builds an intent and returns it; never executes.
 */
export function makePerpsCloseTool(
  deps: PerpsToolDeps,
): IntentToolDefinition<PerpsCloseConfig> {
  return {
    name: "perps_close",
    category: "perps",
    description:
      "Propose closing all or part of an open perp position (reduce-only). Builds an intent for the kernel; never executes.",
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
