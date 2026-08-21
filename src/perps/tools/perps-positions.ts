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
import { formatAmount } from "../../kernel/money.js";
import { exposureFrom } from "../exposure.js";
import { positionLiquidationDistanceBps } from "../guards.js";
import { capsFor } from "../policy.js";
import { accountRef, errMsg, type PerpsToolDeps } from "./deps.js";

const configSchema = z.object({ market: z.string().optional() });
export type PerpsPositionsConfig = z.infer<typeof configSchema>;

async function render(
  deps: PerpsToolDeps,
  ctx: ToolContext,
  cfg: PerpsPositionsConfig,
): Promise<string> {
  const account = accountRef(deps, ctx);
  const status = await deps.venue.getAccountStatus(account);
  if (!status.exists) {
    return `No ${deps.venue.id} subaccount ${account.subAccountId} for this wallet. Initialising one is a separate, explicit step.`;
  }

  const all = await deps.venue.getPositions(account);
  const needle = cfg.market?.trim().toUpperCase();
  const positions = needle ? all.filter((p) => p.symbol === needle) : [...all];
  const exposure = exposureFrom(all);
  const policy = deps.policy();

  const lines = [
    `${deps.venue.id} positions · subaccount ${account.subAccountId}`,
  ];
  if (status.totalCollateral) {
    lines.push(
      `collateral ${formatAmount(status.totalCollateral.amount, status.totalCollateral.decimals, 2)}` +
        (status.freeCollateral
          ? ` (free ${formatAmount(status.freeCollateral.amount, status.freeCollateral.decimals, 2)})`
          : ""),
    );
  }

  if (positions.length === 0) {
    lines.push("(no open perp positions)");
  }

  for (const p of positions) {
    const size = formatAmount(p.baseAmount, p.baseDecimals, 4);
    const notional = formatAmount(p.notional.amount, p.notional.decimals, 2);
    const pnl = formatAmount(p.unrealizedPnl, p.collateral.decimals, 2);
    const dist = positionLiquidationDistanceBps(p);
    // 'n/a' rather than a fabricated number: the same missing-data honesty the
    // guards enforce, surfaced to the human reading the position list.
    const liq =
      p.liquidationPrice === undefined
        ? "liq n/a"
        : `liq $${p.liquidationPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
    const distTxt = dist === undefined ? "" : ` (${dist}bps away)`;
    lines.push(
      `${p.symbol} ${p.side} ${size} · notional ${notional} · entry $${p.entryPrice.toFixed(4)} · mark $${p.markPrice.toFixed(4)} · pnl ${pnl} · ${liq}${distTxt}`,
    );
  }

  for (const bucket of ["sol", "usdc"] as const) {
    const used = exposure.notionalByBucket[bucket];
    if (used === 0n) continue;
    const cap = capsFor(policy, bucket).maxPortfolioNotional;
    const decimals = bucket === "sol" ? 9 : 6;
    lines.push(
      `${bucket.toUpperCase()} perp notional ${formatAmount(used, decimals, 2)} / ${formatAmount(cap, decimals, 2)} cap`,
    );
  }
  if (exposure.stale)
    lines.push(
      `! exposure snapshot is incomplete: ${exposure.staleReason ?? "unknown"} — opens will be refused`,
    );

  return lines.join("\n");
}

/** List open perp positions with liquidation distance and portfolio-cap usage. Read-only. */
export function makePerpsPositionsTool(
  deps: PerpsToolDeps,
): IntentToolDefinition<PerpsPositionsConfig> {
  return {
    name: "perps_positions",
    category: "perps",
    description:
      "List open perp positions with size, notional, entry/mark, unrealized PnL, liquidation distance and portfolio-cap usage.",
    capabilities: ["read", "read_state", "network"],
    execPolicy: { timeoutMs: 20_000, retries: 2, idempotent: true },
    configSchema,
    async simulate(ctx, cfg) {
      return {
        summary: await render(deps, ctx, cfg),
        quote: undefined,
        warnings: [],
        intent: undefined,
        data: undefined,
      };
    },
    async execute(ctx, cfg) {
      try {
        return {
          isError: false,
          text: await render(deps, ctx, cfg),
          data: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          text: `perps_positions failed: ${errMsg(err)}`,
          data: undefined,
        };
      }
    },
  };
}
