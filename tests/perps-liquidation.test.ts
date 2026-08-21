/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isUsablePrice,
  liquidationDistanceBps,
  maxLeverageForDistance,
  modelLiquidationPrice,
  oracleDivergenceBps,
  reconcileLiquidation,
} from "../src/perps/liquidation.js";

const close = (
  actual: number | undefined,
  expected: number,
  tol = 1e-6,
): void => {
  assert.ok(actual !== undefined, "expected a number, got undefined");
  assert.ok(Math.abs(actual - expected) < tol, `${actual} !≈ ${expected}`);
};

test("modelLiquidationPrice anchors: 1× is un-liquidatable long / 2× entry short", () => {
  // A 1× long with zero maintenance margin can only be liquidated at zero.
  close(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 100,
      leverage: 1,
      maintenanceMarginRatio: 0,
    }),
    0,
  );
  // A 1× short doubles its loss at 2× entry.
  close(
    modelLiquidationPrice({
      side: "short",
      entryPrice: 100,
      leverage: 1,
      maintenanceMarginRatio: 0,
    }),
    200,
  );
});

test("modelLiquidationPrice matches the closed form at 10× with 3% maintenance", () => {
  // long : entry·(1 − 1/L)/(1 − m) = 100·0.9/0.97
  close(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.03,
    }),
    92.783505154,
    1e-6,
  );
  // short: entry·(1 + 1/L)/(1 + m) = 100·1.1/1.03
  close(
    modelLiquidationPrice({
      side: "short",
      entryPrice: 100,
      leverage: 10,
      maintenanceMarginRatio: 0.03,
    }),
    106.796116505,
    1e-6,
  );
});

test("modelLiquidationPrice moves the right way with leverage", () => {
  const low = modelLiquidationPrice({
    side: "long",
    entryPrice: 100,
    leverage: 2,
    maintenanceMarginRatio: 0.03,
  })!;
  const high = modelLiquidationPrice({
    side: "long",
    entryPrice: 100,
    leverage: 20,
    maintenanceMarginRatio: 0.03,
  })!;
  assert.ok(
    high > low,
    "more leverage must put liquidation closer to entry for a long",
  );
});

test("modelLiquidationPrice returns undefined rather than guessing on bad input", () => {
  assert.equal(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 0,
      leverage: 3,
      maintenanceMarginRatio: 0.03,
    }),
    undefined,
  );
  assert.equal(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 100,
      leverage: 0,
      maintenanceMarginRatio: 0.03,
    }),
    undefined,
  );
  assert.equal(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 100,
      leverage: Number.NaN,
      maintenanceMarginRatio: 0.03,
    }),
    undefined,
  );
  assert.equal(
    modelLiquidationPrice({
      side: "long",
      entryPrice: 100,
      leverage: 3,
      maintenanceMarginRatio: 1,
    }),
    undefined,
  );
  assert.equal(
    modelLiquidationPrice({
      side: "long",
      entryPrice: Number.POSITIVE_INFINITY,
      leverage: 3,
      maintenanceMarginRatio: 0.03,
    }),
    undefined,
  );
});

test("liquidationDistanceBps measures the gap on the correct side", () => {
  assert.equal(
    liquidationDistanceBps({
      side: "long",
      referencePrice: 150,
      liquidationPrice: 105,
    }),
    3000,
  );
  assert.equal(
    liquidationDistanceBps({
      side: "short",
      referencePrice: 150,
      liquidationPrice: 195,
    }),
    3000,
  );
});

test("liquidationDistanceBps refuses an already-underwater position instead of reinterpreting it", () => {
  // A long whose "liquidation price" is ABOVE the mark is nonsense or already liquidated.
  assert.equal(
    liquidationDistanceBps({
      side: "long",
      referencePrice: 100,
      liquidationPrice: 120,
    }),
    undefined,
  );
  assert.equal(
    liquidationDistanceBps({
      side: "short",
      referencePrice: 100,
      liquidationPrice: 80,
    }),
    undefined,
  );
  assert.equal(
    liquidationDistanceBps({
      side: "long",
      referencePrice: 0,
      liquidationPrice: 10,
    }),
    undefined,
  );
  assert.equal(
    liquidationDistanceBps({
      side: "long",
      referencePrice: 100,
      liquidationPrice: Number.NaN,
    }),
    undefined,
  );
});

test("maxLeverageForDistance inverts the distance formula", () => {
  const minDist = 2_000; // 20%
  const m = 0.03;
  const maxL = maxLeverageForDistance(minDist, "long", m)!;
  const atLimit = modelLiquidationPrice({
    side: "long",
    entryPrice: 100,
    leverage: maxL,
    maintenanceMarginRatio: m,
  })!;
  const dist = liquidationDistanceBps({
    side: "long",
    referencePrice: 100,
    liquidationPrice: atLimit,
  })!;
  assert.ok(
    Math.abs(dist - minDist) <= 1,
    `distance at max leverage should be the floor, got ${dist}`,
  );

  // A hair more leverage must break the floor.
  const over = modelLiquidationPrice({
    side: "long",
    entryPrice: 100,
    leverage: maxL * 1.05,
    maintenanceMarginRatio: m,
  })!;
  assert.ok(
    liquidationDistanceBps({
      side: "long",
      referencePrice: 100,
      liquidationPrice: over,
    })! < minDist,
  );
});

test("reconcileLiquidation takes the CONSERVATIVE (closest) estimate", () => {
  // Venue says liquidation is further away than the model — the model wins.
  const r = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: 90,
    modelPrice: 110,
    toleranceBps: 500,
  });
  assert.equal(r.source, "model");
  assert.equal(r.liquidationPrice, 110);
  assert.equal(r.distanceBps, Math.floor(((150 - 110) / 150) * 10_000));

  // Venue says it is CLOSER — the venue wins.
  const r2 = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: 120,
    modelPrice: 110,
    toleranceBps: 500,
  });
  assert.equal(r2.source, "venue");
  assert.equal(r2.liquidationPrice, 120);
});

test("reconcileLiquidation reports disagreement as a warning, not a refusal", () => {
  const r = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: 20,
    modelPrice: 110,
    toleranceBps: 500,
  });
  assert.equal(
    r.ambiguity,
    undefined,
    "a cross-margin disagreement must not block the trade",
  );
  assert.equal(r.disagrees, true);
  assert.ok((r.disagreementBps ?? 0) > 500);
  assert.equal(
    r.source,
    "model",
    "the closer (model) estimate is still the one used",
  );
});

test("reconcileLiquidation is AMBIGUOUS when neither source is usable — the fail-closed case", () => {
  const none = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: undefined,
    modelPrice: undefined,
    toleranceBps: 500,
  });
  assert.ok(none.ambiguity);
  assert.equal(none.distanceBps, undefined);

  // A negative venue price and an unusable model are equally ambiguous.
  const bad = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: 400,
    modelPrice: undefined,
    toleranceBps: 500,
  });
  assert.ok(bad.ambiguity, "a long cannot liquidate above the mark");

  const noRef = reconcileLiquidation({
    side: "long",
    referencePrice: 0,
    venuePrice: 100,
    modelPrice: 100,
    toleranceBps: 500,
  });
  assert.ok(noRef.ambiguity);
});

test("reconcileLiquidation falls back cleanly when only one source is usable", () => {
  const venueOnly = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: 105,
    modelPrice: undefined,
    toleranceBps: 500,
  });
  assert.equal(venueOnly.source, "venue");
  assert.equal(venueOnly.distanceBps, 3000);

  const modelOnly = reconcileLiquidation({
    side: "long",
    referencePrice: 150,
    venuePrice: undefined,
    modelPrice: 105,
    toleranceBps: 500,
  });
  assert.equal(modelOnly.source, "model");
  assert.equal(modelOnly.distanceBps, 3000);
});

test("oracleDivergenceBps and isUsablePrice", () => {
  assert.equal(oracleDivergenceBps(101, 100), 100);
  assert.equal(oracleDivergenceBps(99, 100), 100);
  assert.equal(oracleDivergenceBps(100, 100), 0);
  assert.equal(oracleDivergenceBps(Number.NaN, 100), undefined);
  assert.equal(oracleDivergenceBps(100, 0), undefined);
  assert.equal(isUsablePrice(1), true);
  assert.equal(isUsablePrice(0), false);
  assert.equal(isUsablePrice(-1), false);
  assert.equal(isUsablePrice(undefined), false);
});
