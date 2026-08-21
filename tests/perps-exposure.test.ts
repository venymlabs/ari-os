/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { WSOL_MINT } from "../src/kernel/money.js";
import {
  emptyExposure,
  exposureFrom,
  positionIn,
  staleExposure,
} from "../src/perps/exposure.js";
import { usdc } from "../src/perps/testing/fake-venue.js";
import { testPosition } from "../src/perps/testing/fixtures.js";

test("exposureFrom sums notional and collateral per input-leg bucket", () => {
  const e = exposureFrom([
    testPosition({
      symbol: "SOL-PERP",
      notional: usdc(150_000_000n),
      collateral: usdc(50_000_000n),
    }),
    testPosition({
      symbol: "BTC-PERP",
      notional: usdc(300_000_000n),
      collateral: usdc(100_000_000n),
    }),
  ]);
  assert.equal(e.openPositions, 2);
  assert.equal(e.notionalByBucket.usdc, 450_000_000n);
  assert.equal(e.collateralByBucket.usdc, 150_000_000n);
  assert.equal(e.notionalByBucket.sol, 0n);
  assert.equal(e.stale, false);
});

test("a short contributes exposure, not negative exposure", () => {
  const e = exposureFrom([
    testPosition({ side: "long", notional: usdc(100_000_000n) }),
    testPosition({
      symbol: "BTC-PERP",
      side: "short",
      notional: usdc(-100_000_000n),
    }),
  ]);
  assert.equal(
    e.notionalByBucket.usdc,
    200_000_000n,
    "magnitudes must add, never cancel",
  );
});

test("positions in different buckets are kept apart", () => {
  const e = exposureFrom([
    testPosition({
      notional: usdc(150_000_000n),
      collateral: usdc(50_000_000n),
    }),
    testPosition({
      symbol: "ETH-PERP",
      notional: { mint: WSOL_MINT, amount: 2_000_000_000n, decimals: 9 },
      collateral: { mint: WSOL_MINT, amount: 1_000_000_000n, decimals: 9 },
    }),
  ]);
  assert.equal(e.notionalByBucket.usdc, 150_000_000n);
  assert.equal(e.notionalByBucket.sol, 2_000_000_000n);
  assert.equal(e.stale, false);
});

test("a position in an un-bucketable asset makes the whole snapshot STALE", () => {
  const e = exposureFrom([
    testPosition({ notional: usdc(150_000_000n) }),
    testPosition({
      symbol: "WIF-PERP",
      notional: {
        mint: "BonkMint11111111111111111111111111111111111",
        amount: 1n,
        decimals: 6,
      },
      collateral: {
        mint: "BonkMint11111111111111111111111111111111111",
        amount: 1n,
        decimals: 6,
      },
    }),
  ]);
  assert.equal(
    e.stale,
    true,
    "an exposure we cannot bound must not read as bounded",
  );
  assert.equal(e.unbucketed, 1);
  assert.ok(e.staleReason);
});

test("emptyExposure is usable and staleExposure is refused-by-construction", () => {
  const empty = emptyExposure();
  assert.equal(empty.stale, false);
  assert.equal(empty.openPositions, 0);

  const stale = staleExposure("rpc timeout");
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, "rpc timeout");
  assert.equal(stale.notionalByBucket.usdc, 0n);
});

test("positionIn matches the canonical symbol case-insensitively", () => {
  const positions = [
    testPosition({ symbol: "SOL-PERP" }),
    testPosition({ symbol: "BTC-PERP" }),
  ];
  assert.equal(positionIn(positions, "sol-perp")?.symbol, "SOL-PERP");
  assert.equal(positionIn(positions, "  BTC-PERP ")?.symbol, "BTC-PERP");
  assert.equal(positionIn(positions, "ETH-PERP"), undefined);
});
