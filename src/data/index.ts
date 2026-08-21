/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real-time Solana trade tape + signals engine fed by PumpPortal's KEYLESS
 * public WebSocket. No API key, no credits, no account, and — since the feed
 * runs on Node's built-in `WebSocket` — no production dependency either.
 *
 * The one structural fact worth stating: {@link SignalsEngine} implements the
 * `RugHeatSource` port declared in `src/pools/signals.ts`, which is what
 * `guardRugHeat` reads. Mounting a feed is therefore the difference between
 * "the pools guards have a measurement" and "the pools guards refuse for want
 * of one". It is never the difference between checked and unchecked.
 */

export { SignalsFeed } from "./feed.js";
export type { SignalsFeedOptions } from "./feed.js";
export { PumpPortalWatcher, PUMPPORTAL_URL } from "./pumpportal.js";
export type {
  FeedSocket,
  FeedSocketFactory,
  PumpPortalOptions,
} from "./pumpportal.js";
export { SignalsEngine, rating } from "./signals-engine.js";
export { TradeTape } from "./tape.js";
export type { TapeTrade, TokenSignals } from "./tape.js";
