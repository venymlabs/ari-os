/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Clock } from "./contracts.js";

export const systemClock: Clock = { now: () => Date.now() };

/** A driveable clock for the selfcheck harness — lets invariants test time windows deterministically. */
export class ManualClock implements Clock {
  #t: number;
  constructor(startMs = 0) {
    this.#t = startMs;
  }
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
  set(ms: number): void {
    this.#t = ms;
  }
}
