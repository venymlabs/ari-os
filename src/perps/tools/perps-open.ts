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
import { buildPerpIntent } from "../intent.js";
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
  side: z.enum(["long", "short"]),
  /** Margin to post, in UI units of the collateral asset. THE INPUT LEG. */
  collateralUi: z.number().positive(),
  leverage: z.number().positive().max(100),
  orderType: z.enum(["market", "limit"]).optional(),
  limitPrice: z.number().positive().optional(),
  slippageBps: z.number().int().nonnegative().max(5000).optional(),
});
export type PerpsOpenConfig = z.infer<typeof configSchema>;

async function build(
  deps: PerpsToolDeps,
  ctx: ToolContext,
  cfg: PerpsOpenConfig,
  dryRun: boolean,
): Promise<PerpProposal> {
  const account = accountRef(deps, ctx);
  // The market symbol is resolved against the VENUE'S OWN market list, so a
  // symbol the model invented cannot survive this line.
  const market = await deps.venue.getMarket(cfg.market);
  const prices = await deps.venue.getPrices(market.symbol);
  const { funding, warning } = await readFunding(deps, market.symbol);
  const snapshot = await readSnapshot(deps, account);

  const collateralAsset = deps.collateral();
  const collateral = {
    mint: collateralAsset.mint,
    amount: toBaseUnits(cfg.collateralUi, collateralAsset.decimals),
    decimals: collateralAsset.decimals,
  };

  const orderType = cfg.orderType ?? "market";
  const slippageBps = cfg.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const venueBuild = await deps.venue.buildOpen({
    account,
    market,
    side: cfg.side,
    collateral,
    leverage: cfg.leverage,
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    priorityFeeLamports: priorityFee(deps),
  });

  const intent = buildPerpIntent({
    kind: "perp_open",
    source: "perps_open",
    market,
    account,
    side: cfg.side,
    orderType,
    limitPrice: cfg.limitPrice,
    slippageBps,
    leverage: cfg.leverage,
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
 * Open a new perp position. Builds an intent and returns it — never signs,
 * never broadcasts, never touches a keypair.
 *
 * Declares `sign`/`spend` even though it executes nothing: the artifact it
 * produces would move value, so it must be classified with the same ceremony as
 * `swap_jupiter`. Under-declaring capabilities is the dangerous direction.
 */
export function makePerpsOpenTool(
  deps: PerpsToolDeps,
): IntentToolDefinition<PerpsOpenConfig> {
  return {
    name: "perps_open",
    category: "perps",
    description:
      "Propose opening a leveraged perp position. Margin is the input leg and is capped by policy. Builds an intent for the kernel; never executes.",
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
