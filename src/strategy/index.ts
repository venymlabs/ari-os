/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Autonomous strategies: DCA, TWAP, trailing stop, take profit.
 *
 * A strategy is a *schedule*, not an execution path. The runner decides WHEN to
 * propose a trade and HOW BIG a slice to propose; every one of those proposals
 * is turned into a plain `TradeIntent` by `gatewayExecutor` and handed to
 * `TradeGateway.execute()`, exactly like a tool invocation. Nothing in this
 * directory signs, broadcasts, or holds a keypair.
 */

export { gatewayExecutor, STRATEGY_SOURCE } from "./executor.js";
export type { GatewayExecutorDeps } from "./executor.js";
export { StrategyRunner } from "./runner.js";
export type {
  StrategyExecutor,
  StrategySwap,
  StrategySwapResult,
} from "./runner.js";
export { isStrategyKind, STRATEGY_KINDS, StrategyStore } from "./store.js";
export type { StrategyKind, StrategyRow, StrategyStatus } from "./store.js";
export { strategyMint, strategyView } from "./view.js";
