/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the `RugHeat`
 * reading is imported from `src/pools/signals.ts` (where it was extracted to)
 * and the class declares `implements RugHeatSource`, so satisfying the port the
 * pools guards depend on is checked by the compiler rather than by eye.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RugHeat, RugHeatSource } from "../pools/signals.js";
import type { TokenSignals, TradeTape } from "./tape.js";

/**
 * Heuristics layered on top of the raw tape. `rugHeatScore` distils a token's
 * recent trade flow into a 0..100 "how sketchy does this look" number with
 * human-readable reasons; `summary` pairs that with the windowed signals as one
 * line. Pure reads off the tape — no I/O, so it is safe to call from inside a
 * guard.
 *
 * This is the producer for the {@link RugHeatSource} port declared in
 * `src/pools/signals.ts`. Mounting it is what gives `guardRugHeat` a reading at
 * all: with nothing mounted the guard refuses every curve buy, and with this
 * mounted over an EMPTY tape it still refuses (an unseen mint scores 60, at the
 * default rejection threshold). A permissive answer requires observed trades.
 *
 * NOT financial advice — a triage gauge, deliberately biased towards refusing.
 */
export class SignalsEngine implements RugHeatSource {
  readonly #tape: TradeTape;

  constructor(tape: TradeTape) {
    this.#tape = tape;
  }

  /** The tape this engine reads. Exposed so a feed can write to the same one. */
  get tape(): TradeTape {
    return this.#tape;
  }

  /**
   * A 0..100 rug-heat heuristic over the trailing `windowMs`. Higher = riskier.
   * Tells we weight: a tiny/empty unique-buyer set, lopsided buy/sell pressure
   * (in either direction), thin SOL volume, and one-sided sell dumps.
   */
  rugHeatScore(mint: string, windowMs = 300_000): RugHeat {
    const s = this.#tape.signals(mint, windowMs);
    const reasons: string[] = [];
    let score = 0;

    // No activity at all is its own kind of risk (dead / pre-rug). This is the
    // reading an unmounted feed produces for every mint, and it sits at the
    // default rejection threshold on purpose.
    if (s.trades === 0) {
      return {
        score: 60,
        reasons: ["no trades in window — illiquid / inactive"],
      };
    }

    // 1. Concentration: very few distinct buyers => easy to manipulate.
    if (s.uniqueBuyers <= 1) {
      score += 30;
      reasons.push(`only ${s.uniqueBuyers} unique buyer(s)`);
    } else if (s.uniqueBuyers <= 3) {
      score += 18;
      reasons.push(`thin buyer base (${s.uniqueBuyers} unique buyers)`);
    } else if (s.uniqueBuyers <= 6) {
      score += 8;
      reasons.push(`modest buyer base (${s.uniqueBuyers} unique buyers)`);
    }

    // 2. Pressure imbalance: extreme in EITHER direction is a tell. Use the
    //    SIZE-weighted pressure — count-based pressure is fooled by dust spam.
    const imbalance = Math.abs(s.volumeWeightedBuyPressurePct - 50);
    if (imbalance >= 40) {
      score += 25;
      reasons.push(
        `extreme one-sided flow (${s.volumeWeightedBuyPressurePct.toFixed(0)}% buy volume)`,
      );
    } else if (imbalance >= 25) {
      score += 12;
      reasons.push(
        `lopsided flow (${s.volumeWeightedBuyPressurePct.toFixed(0)}% buy volume)`,
      );
    }

    // 2b. Count/size divergence: many small buys masking large sells =
    //     distribution / wash.
    if (
      s.trades >= 4 &&
      s.buyPressurePct >= 60 &&
      s.volumeWeightedBuyPressurePct <= 40
    ) {
      score += 18;
      reasons.push(
        `buy count high but sell SIZE dominates (${s.buyPressurePct.toFixed(0)}% buys vs ${s.volumeWeightedBuyPressurePct.toFixed(0)}% buy volume)`,
      );
    }

    // 2c. Single-trade dominance: one print is most of the window's volume.
    if (
      s.volumeSol > 0 &&
      s.trades >= 3 &&
      s.largestTradeSol / s.volumeSol >= 0.8
    ) {
      score += 12;
      reasons.push(
        `one trade is ${((s.largestTradeSol / s.volumeSol) * 100).toFixed(0)}% of volume`,
      );
    }

    // 3. Sell-dominant flow draining SOL => active exit / dump.
    if (s.netSolFlow < 0 && s.volumeSol > 0) {
      const drainPct = (-s.netSolFlow / s.volumeSol) * 100;
      if (drainPct >= 60) {
        score += 25;
        reasons.push(
          `net SOL outflow (${drainPct.toFixed(0)}% of volume selling)`,
        );
      } else if (drainPct >= 30) {
        score += 12;
        reasons.push(
          `net SOL outflow (${drainPct.toFixed(0)}% of volume selling)`,
        );
      }
    }

    // 4. Thin volume => fragile, easily moved book.
    if (s.volumeSol < 1) {
      score += 20;
      reasons.push(`tiny volume (${s.volumeSol.toFixed(3)} SOL)`);
    } else if (s.volumeSol < 5) {
      score += 10;
      reasons.push(`low volume (${s.volumeSol.toFixed(2)} SOL)`);
    }

    // 5. Sellers but ~no fresh buyers => bag-holders exiting.
    if (s.uniqueSellers >= 3 && s.uniqueBuyers === 0) {
      score += 15;
      reasons.push("sellers active with no buyers");
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    if (reasons.length === 0) reasons.push("no strong rug tells in window");
    return { score, reasons };
  }

  /** One-line human summary: windowed signals + rug-heat verdict. */
  summary(mint: string, windowMs = 300_000): string {
    const s: TokenSignals = this.#tape.signals(mint, windowMs);
    const heat = this.rugHeatScore(mint, windowMs);
    const mins = Math.round(windowMs / 60_000);
    const price =
      s.lastPriceSol !== undefined
        ? `${s.lastPriceSol.toPrecision(4)} SOL`
        : "n/a";
    const move =
      s.priceChangePct !== undefined ? ` (${signed(s.priceChangePct)}%)` : "";

    return (
      `${short(mint)} · last ${mins}m: ${s.trades} trades ` +
      `(${s.buys}B/${s.sells}S, ${s.volumeWeightedBuyPressurePct.toFixed(0)}% buy vol / ${s.buyPressurePct.toFixed(0)}% by count) · ` +
      `vol ${s.volumeSol.toFixed(2)} SOL · net ${signed(s.netSolFlow)} SOL · ` +
      `${s.uniqueBuyers} buyers/${s.uniqueSellers} sellers · px ${price}${move} · ` +
      `rug-heat ${heat.score}/100 [${rating(heat.score)}] — ${heat.reasons[0]}`
    );
  }
}

/** Coarse label for a rug-heat score. */
export function rating(score: number): string {
  if (score >= 70) return "HIGH";
  if (score >= 40) return "ELEVATED";
  if (score >= 20) return "WATCH";
  return "LOW";
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function short(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}
