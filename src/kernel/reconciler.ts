/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Clock, Confirmer } from "./contracts.js";
import type { KernelStore } from "./store.js";

export interface ReconcilerDeps {
  readonly store: KernelStore;
  readonly confirmer: Confirmer;
  readonly clock: Clock;
}

export interface ReconcileSummary {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
}

/**
 * Boot-time crash recovery. If the process died after broadcast but before the
 * confirm resolved, a trade is left in 'sent'. We re-check it ONCE against the
 * chain — never re-signing or re-broadcasting (that is how you double-spend):
 * if it confirmed, consume the reservation; otherwise release it and mark the
 * trade terminal. Recent-blockhash expiry is terminal by construction.
 */
export class Reconciler {
  #d: ReconcilerDeps;

  constructor(deps: ReconcilerDeps) {
    this.#d = deps;
  }

  async recover(): Promise<ReconcileSummary> {
    const { store, confirmer, clock } = this.#d;
    const pending = store.pendingSent();
    let confirmed = 0;
    let failed = 0;

    for (const trade of pending) {
      if (!trade.signature) {
        if (trade.reservation_id)
          store.releaseReservation(trade.reservation_id);
        store.fail(trade.id, "errored", "RECONCILE_NO_SIGNATURE", clock.now());
        failed += 1;
        continue;
      }
      const conf = await confirmer.confirm(
        trade.signature,
        trade.last_valid_block_height,
      );
      if (conf.status === "confirmed") {
        if (trade.reservation_id)
          store.consumeReservation(trade.reservation_id);
        store.setState(trade.id, "confirmed", clock.now());
        confirmed += 1;
      } else {
        if (trade.reservation_id)
          store.releaseReservation(trade.reservation_id);
        store.fail(
          trade.id,
          conf.status === "expired" ? "expired" : "errored",
          `RECONCILE_${conf.status.toUpperCase()}`,
          clock.now(),
        );
        failed += 1;
      }
    }

    return { checked: pending.length, confirmed, failed };
  }
}
