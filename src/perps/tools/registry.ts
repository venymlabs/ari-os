/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IntentToolDefinition } from "../../kernel/contracts.js";
import type { PerpsToolDeps } from "./deps.js";
import { makePerpsAdjustTool } from "./perps-adjust.js";
import { makePerpsCloseTool } from "./perps-close.js";
import { makePerpsMarketsTool } from "./perps-markets.js";
import { makePerpsOpenTool } from "./perps-open.js";
import { makePerpsPositionsTool } from "./perps-positions.js";

/** Heterogeneous tool container — config types differ per tool, validated via `configSchema` at call time. */
export type AnyPerpsTool = IntentToolDefinition<any>;

export interface PerpsToolset {
  readonly all: readonly AnyPerpsTool[];
  /** The two read tools — safe to expose to the model without any confirm ceremony. */
  readonly reads: readonly AnyPerpsTool[];
  /** The three proposing tools. They build intents and stop; none of them executes. */
  readonly proposals: readonly AnyPerpsTool[];
  get(name: string): AnyPerpsTool | undefined;
}

/**
 * Build the perps toolset over a venue.
 *
 * A factory rather than a module-level constant because the tools need a venue
 * and a live policy getter, and `ToolContext` — which is per-invocation state —
 * carries neither. See `tools/deps.ts` for why that split is the right one.
 */
export function createPerpsTools(deps: PerpsToolDeps): PerpsToolset {
  const reads: AnyPerpsTool[] = [
    makePerpsMarketsTool(deps),
    makePerpsPositionsTool(deps),
  ];
  const proposals: AnyPerpsTool[] = [
    makePerpsOpenTool(deps),
    makePerpsCloseTool(deps),
    makePerpsAdjustTool(deps),
  ];
  const all = [...reads, ...proposals];
  return {
    all,
    reads,
    proposals,
    get: (name: string) => all.find((t) => t.name === name),
  };
}

export const PERPS_TOOL_NAMES = [
  "perps_markets",
  "perps_positions",
  "perps_open",
  "perps_close",
  "perps_adjust",
] as const;
export type PerpsToolName = (typeof PERPS_TOOL_NAMES)[number];
