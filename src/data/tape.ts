/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The trade tape — a per-mint ring buffer of recent on-chain trades plus the
 * pure, synchronous signal math computed over a trailing time window. No I/O
 * and no clock injection: callers feed trades in (each already stamped with
 * `ts`), and `signals()` reads `Date.now()` once to bound the window. Cheap
 * enough to call on every poll tick.
 *
 * This module is deliberately the only place trade history lives. The feed
 * (`pumpportal.ts`) writes to it and the heuristics (`signals-engine.ts`) read
 * from it, so a signals reading is always a function of observed trades and
 * never of a network call made mid-guard.
 */

/** A single buy or sell printed to the tape. `solAmount` is the SOL leg size. */
export interface TapeTrade {
  readonly mint: string;
  readonly solAmount: number;
  readonly isBuy: boolean;
  readonly trader: string;
  readonly ts: number;
  /** Token price in SOL at the time of the fill, when the feed provides it. */
  readonly priceSol?: number | undefined;
}

/** Windowed market-microstructure signals for one mint. */
export interface TokenSignals {
  readonly mint: string;
  readonly buys: number;
  readonly sells: number;
  /** Buy SOL volume minus sell SOL volume over the window (positive = inflow). */
  readonly netSolFlow: number;
  /** Total SOL traded (buys + sells) over the window. */
  readonly volumeSol: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  /** buys / (buys + sells) * 100 by COUNT; 0 when there are no trades. */
  readonly buyPressurePct: number;
  /**
   * buyVol / (buyVol + sellVol) * 100 by SOL SIZE; 0 when no volume. The honest
   * "pressure" number — one whale buy outweighs a hundred dust buys.
   */
  readonly volumeWeightedBuyPressurePct: number;
  /** Largest single trade (SOL) in the window — a size outlier / whale tell. */
  readonly largestTradeSol: number;
  /**
   * % price change from the earliest to the latest priced trade in the window
   * (undefined when fewer than two trades carried a price).
   */
  readonly priceChangePct?: number | undefined;
  /** Price (SOL) of the most recent trade in the window that carried one. */
  readonly lastPriceSol?: number | undefined;
  /** Trade count in the window (buys + sells). */
  readonly trades: number;
}

export class TradeTape {
  /** Newest-last per-mint ring buffers. */
  readonly #byMint = new Map<string, TapeTrade[]>();
  readonly #maxPerMint: number;

  constructor(maxPerMint = 500) {
    this.#maxPerMint = Math.max(1, Math.floor(maxPerMint));
  }

  /** Append a trade, evicting the oldest once a mint's buffer is over cap. */
  addTrade(t: TapeTrade): void {
    let buf = this.#byMint.get(t.mint);
    if (!buf) {
      buf = [];
      this.#byMint.set(t.mint, buf);
    }
    buf.push(t);
    // Drop from the front (oldest) until back under the cap.
    while (buf.length > this.#maxPerMint) buf.shift();
  }

  /** A copy of the current tape for a mint, oldest-first. Empty when unseen. */
  trades(mint: string): TapeTrade[] {
    const buf = this.#byMint.get(mint);
    return buf ? buf.slice() : [];
  }

  /** Mints currently tracked on the tape. */
  mints(): string[] {
    return [...this.#byMint.keys()];
  }

  /** Total trades held across every mint — the feed's liveness proxy. */
  size(): number {
    let n = 0;
    for (const buf of this.#byMint.values()) n += buf.length;
    return n;
  }

  /**
   * Pure signal roll-up over the trailing `windowMs`. Trades with `ts` older
   * than the window are ignored; `lastPriceSol` reflects the most recent
   * in-window trade that carried a price.
   */
  signals(mint: string, windowMs = 300_000): TokenSignals {
    const buf = this.#byMint.get(mint);
    const cutoff = Date.now() - Math.max(0, windowMs);

    let buys = 0;
    let sells = 0;
    let buyVol = 0;
    let sellVol = 0;
    let largestTradeSol = 0;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    let lastPriceSol: number | undefined;
    let lastTs = -Infinity;
    let firstPriceSol: number | undefined;
    let firstTs = Infinity;

    if (buf) {
      for (const t of buf) {
        if (t.ts < cutoff) continue;
        if (t.isBuy) {
          buys += 1;
          buyVol += t.solAmount;
          if (t.trader) buyers.add(t.trader);
        } else {
          sells += 1;
          sellVol += t.solAmount;
          if (t.trader) sellers.add(t.trader);
        }
        if (t.solAmount > largestTradeSol) largestTradeSol = t.solAmount;
        if (t.priceSol !== undefined) {
          // Newest in-window price (buffer is newest-last, but guard ts anyway).
          if (t.ts >= lastTs) {
            lastTs = t.ts;
            lastPriceSol = t.priceSol;
          }
          // Earliest in-window price, for the window's price change.
          if (t.ts <= firstTs) {
            firstTs = t.ts;
            firstPriceSol = t.priceSol;
          }
        }
      }
    }

    const trades = buys + sells;
    const buyPressurePct = trades > 0 ? (buys / trades) * 100 : 0;
    const volume = buyVol + sellVol;
    const volumeWeightedBuyPressurePct =
      volume > 0 ? (buyVol / volume) * 100 : 0;
    const priceChangePct =
      firstPriceSol !== undefined &&
      lastPriceSol !== undefined &&
      firstPriceSol > 0 &&
      firstTs < lastTs
        ? ((lastPriceSol - firstPriceSol) / firstPriceSol) * 100
        : undefined;

    return {
      mint,
      buys,
      sells,
      netSolFlow: buyVol - sellVol,
      volumeSol: volume,
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      buyPressurePct,
      volumeWeightedBuyPressurePct,
      largestTradeSol,
      priceChangePct,
      lastPriceSol,
      trades,
    };
  }
}
