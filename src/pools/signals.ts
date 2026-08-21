/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: extracted from
 * Aetheria's `SignalsEngine` so the pools guards can depend on
 * the READING without depending on the engine that produces it.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A rug-heat reading over a trailing window of the trade tape.
 *
 * The producer is a signals engine over live trade data. This module declares
 * only the reading and the port that supplies it, so the pools guards stay pure
 * and testable and the engine can be swapped or left unmounted. Leaving it
 * unmounted does NOT make the guards permissive: `guardRugHeat` refuses on a
 * missing reading, so an unwired signals engine means no curve buys, not
 * unchecked ones.
 */
export interface RugHeat {
  /** 0 (looks normal) .. 100 (multiple strong rug tells). */
  score: number;
  reasons: string[];
}

/** Structural view of a signals engine. A real engine satisfies this as-is. */
export interface RugHeatSource {
  rugHeatScore(mint: string, windowMs?: number): RugHeat;
}
