/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentToolDefinition } from "../../kernel/contracts.js";
import { type PoolsDeps, type PoolsDepsInput, resolveDeps } from "./deps.js";
import {
  makePoolsCloseTool,
  makePoolsListTool,
  makePoolsOpenTool,
  makePoolsPositionTool,
  makePoolsRebalanceTool,
} from "./pools.js";
import {
  makePumpfunBuyTool,
  makePumpfunCurveTool,
  makePumpfunSellTool,
} from "./pumpfun.js";

/** Heterogeneous container — config types differ per tool, validated via `configSchema` at call time. */
export type AnyPoolTool = IntentToolDefinition<any>;

export interface PoolsToolset {
  readonly deps: PoolsDeps;
  readonly tools: readonly AnyPoolTool[];
  get(name: string): AnyPoolTool | undefined;
}

/**
 * Build the eight pool/curve tools against one set of dependencies.
 *
 * Read tools first, then the intent builders, so a registry that concatenates
 * the two lists keeps reads ahead of spends in the LLM's tool listing.
 */
export function makePoolsTools(input: PoolsDepsInput): PoolsToolset {
  const deps = resolveDeps(input);
  const tools: readonly AnyPoolTool[] = [
    makePoolsListTool(deps),
    makePoolsPositionTool(deps),
    makePumpfunCurveTool(deps),
    makePoolsOpenTool(deps),
    makePoolsRebalanceTool(deps),
    makePoolsCloseTool(deps),
    makePumpfunBuyTool(deps),
    makePumpfunSellTool(deps),
  ];
  return {
    deps,
    tools,
    get: (name: string) => tools.find((t) => t.name === name),
  };
}

/** Names this package contributes, for wiring checks and prompt budgeting. */
export const POOL_TOOL_NAMES = [
  "pools_list",
  "pools_position",
  "pumpfun_curve",
  "pools_open",
  "pools_rebalance",
  "pools_close",
  "pumpfun_buy",
  "pumpfun_sell",
] as const;
