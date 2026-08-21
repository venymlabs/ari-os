/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: NEW in this
 * repo — Aetheria wired the tape, the watcher and the engine together inside
 * its engine package, which ARI OS does not have. This is that wiring, given a
 * lifecycle the composition root can own.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PumpPortalWatcher, type PumpPortalOptions } from "./pumpportal.js";
import { SignalsEngine } from "./signals-engine.js";
import { TradeTape, type TapeTrade } from "./tape.js";

/**
 * Tape + feed + heuristics as one mountable unit.
 *
 * The {@link SignalsEngine} it exposes is a {@link RugHeatSource} and exists
 * from construction, before any socket is opened. That ordering is the whole
 * point: the pools guards get a real, non-null reading immediately, and what
 * the running feed changes is whether that reading is INFORMED. An unstarted
 * feed reports 60/100 ("no trades in window") for every mint, which is at the
 * default `maxRugHeat` rejection threshold — so a dead feed refuses buys rather
 * than waving them through.
 *
 * `start()` is a network side effect and belongs to the application lifecycle,
 * never to a constructor.
 */
export interface SignalsFeedOptions {
  /** Overrides for the underlying watcher (URL, socket factory). */
  readonly watcher?: Omit<PumpPortalOptions, "onTrade" | "onNewToken">;
  /** Trades retained per mint. */
  readonly maxPerMint?: number;
  /**
   * How many freshly-launched mints to auto-follow. PumpPortal's new-token
   * stream is a firehose and each follow costs a subscription, so the newest
   * `maxAutoFollow` launches are tracked and older ones dropped. Explicitly
   * watched mints (see {@link SignalsFeed.watch}) are never evicted.
   */
  readonly maxAutoFollow?: number;
}

export class SignalsFeed {
  readonly #tape: TradeTape;
  readonly #engine: SignalsEngine;
  readonly #watcher: PumpPortalWatcher;
  readonly #maxAutoFollow: number;
  /** Auto-followed launches, oldest-first. Explicit watches are not in here. */
  readonly #autoFollowed: string[] = [];
  readonly #pinned = new Set<string>();
  #started = false;

  constructor(options: SignalsFeedOptions = {}) {
    this.#tape = new TradeTape(options.maxPerMint ?? 500);
    this.#engine = new SignalsEngine(this.#tape);
    this.#maxAutoFollow = Math.max(0, options.maxAutoFollow ?? 64);
    this.#watcher = new PumpPortalWatcher({
      ...options.watcher,
      onTrade: (t: TapeTrade) => this.#tape.addTrade(t),
      onNewToken: (mint: string) => this.#autoFollow(mint),
    });
  }

  /** The `RugHeatSource` to mount on the pools tools. Always present. */
  get engine(): SignalsEngine {
    return this.#engine;
  }

  get tape(): TradeTape {
    return this.#tape;
  }

  /** True while the socket is open — the console's "connected" light. */
  get connected(): boolean {
    return this.#watcher.connected;
  }

  get started(): boolean {
    return this.#started;
  }

  /** Open the feed. Idempotent. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#watcher.start();
  }

  /** Close the feed. The engine keeps answering off whatever the tape holds. */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#watcher.stop();
  }

  /**
   * Follow a specific mint for as long as the feed runs. Pinned: never evicted
   * by the auto-follow budget, because a mint someone is about to trade matters
   * more than the newest launch.
   */
  watch(mint: string): void {
    if (this.#pinned.has(mint)) return;
    this.#pinned.add(mint);
    this.#watcher.subscribeTokenTrade(mint);
  }

  /** Mints currently subscribed on the socket. */
  watching(): string[] {
    return this.#watcher.subscriptions();
  }

  #autoFollow(mint: string): void {
    if (this.#maxAutoFollow === 0) return;
    if (this.#pinned.has(mint) || this.#autoFollowed.includes(mint)) return;
    this.#autoFollowed.push(mint);
    this.#watcher.subscribeTokenTrade(mint);
    while (this.#autoFollowed.length > this.#maxAutoFollow) {
      const evicted = this.#autoFollowed.shift();
      if (evicted !== undefined && !this.#pinned.has(evicted)) {
        this.#watcher.unsubscribeTokenTrade(evicted);
      }
    }
  }
}
