/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { USDC_MINT } from "../src/kernel/money.js";
import {
  DRIFT_SETTLEMENT_MINT,
  driftMarketStatus,
  fundingBpsPerHour,
  marginRatioToFraction,
  maxLeverageFromInitialMargin,
  notionalQuoteUnits,
  priceFrom,
  splitSignedBase,
  toPerpMarket,
} from "../src/perps/drift/convert.js";
import {
  anchorEnumKey,
  decodeMarketName,
  type DriftPerpMarketAccount,
} from "../src/perps/drift/sdk-types.js";

/** ASCII bytes the way Drift stores a market name. */
function nameBytes(s: string, pad = 32): number[] {
  const out = [...s].map((c) => c.charCodeAt(0));
  while (out.length < pad) out.push(32);
  return out;
}

function marketAccount(
  overrides: Partial<DriftPerpMarketAccount> = {},
): DriftPerpMarketAccount {
  return {
    marketIndex: 0,
    name: nameBytes("SOL-PERP"),
    status: { active: {} },
    marginRatioInitial: 500, // 5% → 20×
    marginRatioMaintenance: 300, // 3%
    amm: {
      orderStepSize: { toString: () => "100000000" },
      minOrderSize: { toString: () => "100000000" },
    },
    ...overrides,
  };
}

test("fundingBpsPerHour: the worked example from the doc comment", () => {
  // SOL at $150 (twap 150_000_000 in PRICE_PRECISION) with a 0.001%/h rate.
  const bps = fundingBpsPerHour(1_500_000n, 150_000_000n);
  assert.ok(bps !== undefined);
  assert.ok(Math.abs(bps - 0.1) < 1e-9, `expected 0.1 bps/h, got ${bps}`);
});

test("fundingBpsPerHour is signed and scales linearly", () => {
  assert.ok(
    Math.abs(fundingBpsPerHour(-1_500_000n, 150_000_000n)! + 0.1) < 1e-9,
  );
  assert.ok(Math.abs(fundingBpsPerHour(15_000_000n, 150_000_000n)! - 1) < 1e-9);
  assert.equal(fundingBpsPerHour(0n, 150_000_000n), 0);
});

test("fundingBpsPerHour returns undefined — never 0 — on missing or unusable input", () => {
  assert.equal(fundingBpsPerHour(undefined, 150_000_000n), undefined);
  assert.equal(fundingBpsPerHour(1_500_000n, undefined), undefined);
  assert.equal(fundingBpsPerHour(1_500_000n, 0n), undefined);
  assert.equal(fundingBpsPerHour(1_500_000n, -5n), undefined);
});

test("driftMarketStatus maps known variants and treats anything new as unsafe", () => {
  assert.equal(driftMarketStatus("active"), "active");
  assert.equal(driftMarketStatus("reduceOnly"), "reduce-only");
  for (const halted of [
    "initialized",
    "paused",
    "fillPaused",
    "ammPaused",
    "settlement",
    "delisted",
  ]) {
    assert.equal(driftMarketStatus(halted), "halted", halted);
  }
  assert.equal(driftMarketStatus("somethingNewInV3"), "unknown");
  assert.equal(driftMarketStatus(undefined), "unknown");
});

test("margin ratios convert out of MARGIN_PRECISION and invert to max leverage", () => {
  assert.equal(marginRatioToFraction(500), 0.05);
  assert.equal(marginRatioToFraction(300), 0.03);
  assert.equal(
    marginRatioToFraction(10_000),
    undefined,
    "100% margin is not a usable ratio",
  );
  assert.equal(marginRatioToFraction(-1), undefined);
  assert.equal(marginRatioToFraction(undefined), undefined);

  assert.equal(maxLeverageFromInitialMargin(0.05), 20);
  assert.equal(maxLeverageFromInitialMargin(0), undefined);
  assert.equal(maxLeverageFromInitialMargin(undefined), undefined);
});

test("toPerpMarket produces a clean domain market", () => {
  const { market, problem } = toPerpMarket(marketAccount(), 10);
  assert.equal(problem, undefined);
  assert.ok(market);
  assert.equal(market.symbol, "SOL-PERP");
  assert.equal(market.baseSymbol, "SOL");
  assert.equal(market.venue, "drift");
  assert.equal(market.quoteSymbol, "USDC");
  assert.equal(market.baseDecimals, 9);
  assert.equal(market.quoteDecimals, 6);
  assert.equal(market.maxLeverage, 20);
  assert.equal(market.initialMarginRatio, 0.05);
  assert.equal(market.maintenanceMarginRatio, 0.03);
  assert.equal(market.status, "active");
  assert.equal(market.takerFeeBps, 10);
  assert.equal(market.minBaseAmount, 100_000_000n);
});

test("toPerpMarket DROPS a market with unusable safety fields instead of defaulting them", () => {
  const noName = toPerpMarket(marketAccount({ name: [] }), 10);
  assert.equal(noName.market, undefined);
  assert.ok(noName.problem);

  const badMargin = toPerpMarket(
    marketAccount({ marginRatioMaintenance: -5 }),
    10,
  );
  assert.equal(badMargin.market, undefined);
  assert.ok(badMargin.problem);

  const zeroInitial = toPerpMarket(
    marketAccount({ marginRatioInitial: 0 }),
    10,
  );
  assert.equal(
    zeroInitial.market,
    undefined,
    "a zero initial margin implies infinite leverage — refuse it",
  );
});

test("a non-active status survives conversion so the guards can refuse it", () => {
  const { market } = toPerpMarket(
    marketAccount({ status: { fillPaused: {} } }),
    10,
  );
  assert.equal(market?.status, "halted");
  const { market: unknownStatus } = toPerpMarket(
    marketAccount({ status: { brandNew: {} } }),
    10,
  );
  assert.equal(unknownStatus?.status, "unknown");
});

test("notionalQuoteUnits is exact integer maths from base size and price", () => {
  // 1 SOL (1e9 base units) at $150 (150e6 price units) = 150 USDC (150e6 quote units).
  assert.equal(notionalQuoteUnits(1_000_000_000n, 150_000_000n), 150_000_000n);
  // Half a SOL.
  assert.equal(notionalQuoteUnits(500_000_000n, 150_000_000n), 75_000_000n);
  // A short's signed size still yields positive notional.
  assert.equal(notionalQuoteUnits(-1_000_000_000n, 150_000_000n), 150_000_000n);
});

test("splitSignedBase reads the side off the sign", () => {
  assert.deepEqual(splitSignedBase(5n), { side: "long", magnitude: 5n });
  assert.deepEqual(splitSignedBase(-5n), { side: "short", magnitude: 5n });
  assert.deepEqual(splitSignedBase(0n), { side: "long", magnitude: 0n });
});

test('priceFrom converts PRICE_PRECISION and treats Drift\'s -1 as "no price"', () => {
  assert.equal(priceFrom({ toString: () => "150000000" }), 150);
  assert.equal(priceFrom({ toString: () => "-1" }), undefined);
  assert.equal(
    priceFrom({ toString: () => "-1" }, { negativeMeans: "zero" }),
    0,
  );
  assert.equal(priceFrom({ toString: () => "not-a-number" }), undefined);
  assert.equal(priceFrom(undefined), undefined);
});

test("name decoding and anchor enum key extraction", () => {
  assert.equal(decodeMarketName(nameBytes("BTC-PERP")), "BTC-PERP");
  assert.equal(decodeMarketName([]), undefined);
  assert.equal(decodeMarketName(undefined), undefined);
  assert.equal(anchorEnumKey({ reduceOnly: {} }), "reduceOnly");
  assert.equal(anchorEnumKey(undefined), undefined);
});

test("Drift settles in USDC, so notional and collateral land in the usdc cap bucket", () => {
  assert.equal(DRIFT_SETTLEMENT_MINT, USDC_MINT);
});
