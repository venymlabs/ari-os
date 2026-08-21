/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from "zod";
import type { IntentToolDefinition } from "../../kernel/contracts.js";
import type { PerpMarket } from "../types.js";
import { errMsg, type PerpsToolDeps } from "./deps.js";

const configSchema = z.object({
  /** Filter to markets whose symbol contains this fragment, e.g. 'SOL'. */
  filter: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  /** Fetch mark/oracle price + funding per market. Costs one venue round-trip each. */
  withPrices: z.boolean().optional(),
});
export type PerpsMarketsConfig = z.infer<typeof configSchema>;

const DEFAULT_LIMIT = 12;

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "n/a";
}

function line(m: PerpMarket, extra: string): string {
  return `${m.symbol}  max ${fmt(m.maxLeverage, 1)}×  mmr ${fmt(m.maintenanceMarginRatio * 100, 2)}%  fee ${m.takerFeeBps}bps  [${m.status}]${extra}`;
}

async function render(
  deps: PerpsToolDeps,
  cfg: PerpsMarketsConfig,
): Promise<string> {
  const all = await deps.venue.listMarkets();
  const needle = cfg.filter?.trim().toUpperCase();
  const filtered = needle
    ? all.filter((m) => m.symbol.includes(needle))
    : [...all];
  const limit = cfg.limit ?? DEFAULT_LIMIT;
  const shown = filtered.slice(0, limit);

  const policy = deps.policy();
  const lines = [
    `${deps.venue.id} perp markets (${filtered.length} match, showing ${shown.length})`,
  ];

  const extras = cfg.withPrices
    ? await Promise.all(
        shown.map(async (m) => {
          const [prices, funding] = await Promise.all([
            deps.venue.getPrices(m.symbol).catch(() => null),
            deps.venue.getFundingRate(m.symbol).catch(() => null),
          ]);
          const px = prices
            ? `  mark $${fmt(prices.markPrice, 4)}`
            : "  mark n/a";
          // Funding is shown as unavailable rather than as zero — an opening
          // intent with no funding reading is refused, and the display says so.
          const fr = funding
            ? `  funding ${fmt(funding.bpsPerHour, 3)}bps/h`
            : "  funding n/a";
          return px + fr;
        }),
      )
    : shown.map(() => "");

  shown.forEach((m, i) => lines.push(line(m, extras[i] ?? "")));

  if (shown.length === 0) lines.push("(no markets matched)");
  lines.push(
    "",
    `policy: max ${policy.maxLeverage}× · min liq distance ${policy.minLiquidationDistanceBps}bps · perps ${policy.perpsEnabled ? "enabled" : "DISABLED"}`,
  );
  return lines.join("\n");
}

/** List the venue's perp markets with their margin parameters. Read-only — never builds an intent. */
export function makePerpsMarketsTool(
  deps: PerpsToolDeps,
): IntentToolDefinition<PerpsMarketsConfig> {
  return {
    name: "perps_markets",
    category: "perps",
    description:
      "List available perp markets with max leverage, maintenance margin, taker fee, status and (optionally) mark price + funding.",
    capabilities: ["read", "read_state", "network"],
    execPolicy: { timeoutMs: 20_000, retries: 2, idempotent: true },
    configSchema,
    async simulate(_ctx, cfg) {
      return {
        summary: await render(deps, cfg),
        quote: undefined,
        warnings: [],
        intent: undefined,
        data: undefined,
      };
    },
    async execute(_ctx, cfg) {
      try {
        return {
          isError: false,
          text: await render(deps, cfg),
          data: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          text: `perps_markets failed: ${errMsg(err)}`,
          data: undefined,
        };
      }
    },
  };
}
