/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. New in ARI OS: the Aetheria package
 * could not edit the kernel, so it documented the venue-position settle it
 * needed rather than implementing one. This is that implementation.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PerpPositionRef, PositionReader } from "../kernel/contracts.js";
import { PerpsVenueError } from "./errors.js";
import type { PerpsVenue } from "./venue.js";

/**
 * Adapt a {@link PerpsVenue} to the kernel's {@link PositionReader}.
 *
 * This is the piece that lets `TradeGateway` verify a perp fill at all. A perp
 * order does not move a token balance — collateral leaves the wallet on an open
 * and comes back on a close — so the gateway diffs the venue POSITION across
 * the transaction instead, and requires it to move in the order's direction by
 * at least `perp.minBaseAmount`.
 *
 * Two properties matter and are both deliberate:
 *
 *  - **Signed, not sided.** `PerpPosition` carries an unsigned `baseAmount`
 *    plus a `side`. A settle check needs one comparable number across "flat →
 *    long", "long → flatter" and "long → short", so the side is folded into the
 *    sign here: positive = long, negative = short.
 *  - **Absence is flat, failure is loud.** No position for the market means
 *    `0n` — the honest baseline for an open. But an unreadable venue THROWS,
 *    because a read that failed is not the same as a position that is empty,
 *    and the gateway refuses to open into the difference.
 */
export function positionReaderFor(venue: PerpsVenue): PositionReader {
  return {
    async readPosition(ref: PerpPositionRef): Promise<bigint> {
      if (ref.venue !== venue.id) {
        throw new PerpsVenueError(
          venue.id,
          `cannot read a '${ref.venue}' position from the '${venue.id}' venue`,
        );
      }
      const positions = await venue.getPositions({
        owner: ref.owner,
        subAccountId: ref.subAccountId,
      });
      const position = positions.find((p) => p.symbol === ref.market);
      if (!position) return 0n;
      return position.side === "long"
        ? position.baseAmount
        : -position.baseAmount;
    },
  };
}

/**
 * Fan a single {@link PositionReader} out over several venues, keyed by
 * `PerpsVenue.id`. The gateway holds exactly one reader; this is how a
 * composition with two venues mounted still gives it one.
 */
export function positionReaderOver(
  venues: readonly PerpsVenue[],
): PositionReader {
  const byId = new Map(venues.map((v) => [v.id, positionReaderFor(v)]));
  return {
    async readPosition(ref: PerpPositionRef): Promise<bigint> {
      const reader = byId.get(ref.venue);
      if (!reader) {
        throw new PerpsVenueError(
          ref.venue,
          `no perps venue named '${ref.venue}' is mounted — the fill cannot be verified`,
        );
      }
      return reader.readPosition(ref);
    },
  };
}
