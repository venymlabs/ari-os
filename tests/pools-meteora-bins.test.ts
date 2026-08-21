/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  activePositionInRange,
  BinMathError,
  binArrayIndicesFor,
  binDrift,
  binOfPrice,
  binOfUiPrice,
  binSpan,
  distributeAmount,
  divergenceLossPct,
  isActiveInRange,
  MAX_BIN_PER_POSITION,
  planDeposit,
  priceOfBin,
  rangeAroundActive,
  rangeWidthPct,
  shapeWeights,
  uiPriceOfBin,
} from "../src/pools/meteora/bins.js";

test("bin 0 is price 1 and each bin is exactly one binStep apart", () => {
  assert.equal(priceOfBin(0, 25), 1);
  assert.ok(Math.abs(priceOfBin(1, 25) - 1.0025) < 1e-12);
  assert.ok(Math.abs(priceOfBin(-1, 25) - 1 / 1.0025) < 1e-12);
  // Ten bins compound, they do not add.
  assert.ok(Math.abs(priceOfBin(10, 100) - 1.01 ** 10) < 1e-12);
});

test("binOfPrice inverts priceOfBin exactly across the sign range", () => {
  for (const binStep of [1, 4, 25, 100, 400]) {
    for (const binId of [-5000, -70, -1, 0, 1, 70, 5000]) {
      assert.equal(
        binOfPrice(priceOfBin(binId, binStep), binStep),
        binId,
        `binStep ${binStep} bin ${binId}`,
      );
    }
  }
});

test("ui price folds in the decimal difference both ways", () => {
  // SOL(9) / USDC(6): a lamport-terms price of 1 is 1e3 in UI terms.
  assert.ok(Math.abs(uiPriceOfBin(0, 25, 9, 6) - 1000) < 1e-9);
  assert.equal(binOfUiPrice(uiPriceOfBin(42, 25, 9, 6), 25, 9, 6), 42);
});

test("rangeWidthPct measures the compounded span, not the bin count", () => {
  assert.ok(
    Math.abs(rangeWidthPct(0, 10, 100) - (1.01 ** 10 - 1) * 100) < 1e-9,
  );
  assert.equal(rangeWidthPct(5, 5, 25), 0);
});

test("malformed inputs throw rather than silently producing bin 0", () => {
  assert.throws(() => priceOfBin(1.5, 25), BinMathError);
  assert.throws(() => priceOfBin(0, 0), BinMathError);
  assert.throws(() => priceOfBin(0, 401), BinMathError);
  assert.throws(() => binOfPrice(0, 25), BinMathError);
  assert.throws(() => binOfPrice(-1, 25), BinMathError);
  assert.throws(() => binOfPrice(Number.NaN, 25), BinMathError);
});

test("rangeAroundActive shrinks the widest side until the range fits one position", () => {
  const r = rangeAroundActive(1000, 10, 10);
  assert.deepEqual(r, { lowerBinId: 990, upperBinId: 1010 });
  assert.equal(binSpan(r.lowerBinId, r.upperBinId), 21);

  const wide = rangeAroundActive(0, 60, 60);
  assert.equal(binSpan(wide.lowerBinId, wide.upperBinId), MAX_BIN_PER_POSITION);
  // Symmetric shrink keeps the active bin near the middle.
  assert.ok(
    Math.abs(Math.abs(wide.lowerBinId) - Math.abs(wide.upperBinId)) <= 1,
  );

  const lopsided = rangeAroundActive(0, 0, 100);
  assert.equal(lopsided.lowerBinId, 0);
  assert.equal(
    binSpan(lopsided.lowerBinId, lopsided.upperBinId),
    MAX_BIN_PER_POSITION,
  );

  const custom = rangeAroundActive(0, 20, 20, 11);
  assert.equal(binSpan(custom.lowerBinId, custom.upperBinId), 11);
});

test("binDrift is signed and zero inside the range", () => {
  const range = { lowerBinId: 100, upperBinId: 110 };
  assert.equal(binDrift(range, 105), 0);
  assert.equal(binDrift(range, 100), 0);
  assert.equal(binDrift(range, 110), 0);
  assert.equal(binDrift(range, 113), 3);
  assert.equal(binDrift(range, 96), -4);
  assert.equal(isActiveInRange(range, 111), false);
});

test("activePositionInRange reports where in the range the price sits", () => {
  const range = { lowerBinId: 0, upperBinId: 10 };
  assert.equal(activePositionInRange(range, 0), 0);
  assert.equal(activePositionInRange(range, 10), 1);
  assert.equal(activePositionInRange(range, 5), 0.5);
  assert.equal(activePositionInRange(range, 11), null);
  assert.equal(activePositionInRange({ lowerBinId: 3, upperBinId: 3 }, 3), 0.5);
});

test("binArrayIndicesFor counts the 70-bin accounts a range touches", () => {
  assert.deepEqual(binArrayIndicesFor({ lowerBinId: 0, upperBinId: 69 }), [0]);
  assert.deepEqual(
    binArrayIndicesFor({ lowerBinId: 60, upperBinId: 80 }),
    [0, 1],
  );
  assert.deepEqual(
    binArrayIndicesFor({ lowerBinId: 140, upperBinId: 145 }),
    [2],
  );
});

test("distributeAmount never loses or invents a base unit", () => {
  for (const total of [0n, 1n, 7n, 1_000_000n, 999_999_999_999n]) {
    for (const weights of [
      [1, 1, 1],
      [1, 2, 3, 4],
      [0.001, 5, 0.001],
      new Array(70).fill(1),
    ]) {
      const parts = distributeAmount(total, weights);
      assert.equal(
        parts.reduce((a, b) => a + b, 0n),
        total,
        `total ${total} weights ${weights.length}`,
      );
      assert.equal(parts.length, weights.length);
      assert.ok(parts.every((p) => p >= 0n));
    }
  }
});

test("distributeAmount rejects impossible inputs", () => {
  assert.throws(() => distributeAmount(10n, []), BinMathError);
  assert.throws(() => distributeAmount(-1n, [1]), BinMathError);
  assert.throws(() => distributeAmount(10n, [0, 0]), BinMathError);
});

test("shape weights have the right silhouette", () => {
  const range = { lowerBinId: 0, upperBinId: 20 };
  const active = 10;

  const spot = shapeWeights("spot", range, active);
  assert.equal(new Set(spot).size, 1, "spot is uniform");

  const curve = shapeWeights("curve", range, active);
  const peak = curve.indexOf(Math.max(...curve));
  assert.equal(peak, 10, "curve peaks on the active bin");
  assert.ok(
    (curve[0] as number) < (curve[10] as number),
    "curve thins toward the edges",
  );

  const bidAsk = shapeWeights("bid-ask", range, active);
  assert.ok(
    (bidAsk[0] as number) > (bidAsk[10] as number),
    "bid-ask is heaviest at the edges",
  );
  assert.ok((bidAsk[20] as number) > (bidAsk[10] as number));
});

test("shape weights centre on the nearest edge when the active bin is outside", () => {
  const range = { lowerBinId: 100, upperBinId: 110 };
  const curve = shapeWeights("curve", range, 200); // far above the range
  assert.equal(
    curve.indexOf(Math.max(...curve)),
    10,
    "peak clamps to the upper edge",
  );
});

test("planDeposit puts quote at or below the active bin and base at or above it", () => {
  const range = { lowerBinId: 95, upperBinId: 105 };
  const quote = planDeposit({
    range,
    activeBinId: 100,
    binStep: 25,
    shape: "spot",
    amount: 1_000_000n,
    side: "quote",
    baseDecimals: 6,
    quoteDecimals: 9,
  });
  assert.deepEqual(
    quote.map((a) => a.binId),
    [95, 96, 97, 98, 99, 100],
  );
  assert.equal(
    quote.reduce((a, b) => a + b.amount, 0n),
    1_000_000n,
  );

  const base = planDeposit({
    range,
    activeBinId: 100,
    binStep: 25,
    shape: "spot",
    amount: 777n,
    side: "base",
    baseDecimals: 6,
    quoteDecimals: 9,
  });
  assert.deepEqual(
    base.map((a) => a.binId),
    [100, 101, 102, 103, 104, 105],
  );
  assert.equal(
    base.reduce((a, b) => a + b.amount, 0n),
    777n,
  );
});

test("planDeposit returns nothing when the side has no bins to fund", () => {
  // Range entirely above the active bin: there is no bid side to put quote into.
  const plan = planDeposit({
    range: { lowerBinId: 110, upperBinId: 120 },
    activeBinId: 100,
    binStep: 25,
    shape: "spot",
    amount: 500n,
    side: "quote",
    baseDecimals: 6,
    quoteDecimals: 9,
  });
  assert.equal(plan.length, 0);
});

test("divergence loss is zero at parity and matches the closed form", () => {
  assert.equal(divergenceLossPct(1), 0);
  // r = 4 → 2·2/5 − 1 = −0.2
  assert.ok(Math.abs(divergenceLossPct(4) - -20) < 1e-9);
  // Symmetric in r and 1/r.
  assert.ok(Math.abs(divergenceLossPct(4) - divergenceLossPct(0.25)) < 1e-9);
  assert.ok(divergenceLossPct(1.5) < 0);
  assert.throws(() => divergenceLossPct(0), BinMathError);
});
