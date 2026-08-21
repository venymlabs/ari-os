/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TokenAmount } from "../../kernel/money.js";
import { emptyExposure, type PortfolioExposure } from "../exposure.js";
import type { PerpGuardContext } from "../guards.js";
import {
  buildPerpIntent,
  type PerpIntent,
  type PerpIntentKind,
  type PerpLeg,
} from "../intent.js";
import { defaultPerpsPolicy, type PerpsPolicy } from "../policy.js";
import type { PerpMarket, PerpPosition, PerpSide } from "../types.js";
import type { VenueOrderBuild } from "../venue.js";
import { fakeFunding, fakeMarket, fakePrices, usdc } from "./fake-venue.js";

/**
 * Fixtures for the guard tests.
 *
 * The baseline is a deliberately UNREMARKABLE trade that passes every rule:
 * 3× long SOL-PERP at $150 with 50 USDC of margin (150 USDC notional, 1 SOL).
 * Model liquidation lands at $103.09 (3127bps away) and the venue reports $105
 * (3000bps) — both clear of the 2000bps floor. Each test then perturbs exactly
 * one field, so a failure names the rule that broke.
 */

export const BASELINE = {
  markPrice: 150,
  collateral: 50_000_000n, // 50 USDC
  leverage: 3,
  notional: 150_000_000n, // 150 USDC
  baseAmount: 1_000_000_000n, // 1 SOL
  slippageBps: 50,
  venueLiquidationPrice: 105,
} as const;

export function testPolicy(overrides: Partial<PerpsPolicy> = {}): PerpsPolicy {
  return { ...defaultPerpsPolicy(), perpsEnabled: true, ...overrides };
}

export function testExposure(
  overrides: Partial<PortfolioExposure> = {},
): PortfolioExposure {
  return { ...emptyExposure(), ...overrides };
}

export function testCtx(
  overrides: Partial<PerpGuardContext> = {},
): PerpGuardContext {
  return {
    policy: testPolicy(),
    killSwitch: false,
    executionEnabled: true,
    exposure: testExposure(),
    position: undefined,
    accountInitialized: true,
    dryRun: false,
    ...overrides,
  };
}

export function testBuild(
  overrides: Partial<VenueOrderBuild> = {},
): VenueOrderBuild {
  return {
    unsignedTxBase64: "ZmFrZS11bnNpZ25lZC10eA==",
    recentBlockhash: "FakeBlockhash1111111111111111111111111111111",
    lastValidBlockHeight: 250_000_000,
    priorityFeeLamports: 200_000,
    expectedBaseAmount: BASELINE.baseAmount,
    minBaseAmount: (BASELINE.baseAmount * 9_950n) / 10_000n,
    entryPrice: BASELINE.markPrice,
    notional: usdc(BASELINE.notional),
    estimatedLiquidationPrice: BASELINE.venueLiquidationPrice,
    venueWarnings: [],
    ...overrides,
  };
}

export interface IntentOverrides {
  kind?: PerpIntentKind;
  side?: PerpSide;
  leverage?: number;
  collateral?: TokenAmount;
  slippageBps?: number;
  market?: PerpMarket;
  build?: Partial<VenueOrderBuild>;
  fundingBpsPerHour?: number | null;
  markPrice?: number;
  oraclePrice?: number;
  /** Applied last, so a test can force any field — including invalid ones. */
  perp?: Partial<PerpLeg>;
}

export function testIntent(o: IntentOverrides = {}): PerpIntent {
  const market = o.market ?? fakeMarket();
  const kind = o.kind ?? "perp_open";
  const collateral = o.collateral ?? usdc(BASELINE.collateral);
  const funding =
    o.fundingBpsPerHour === null
      ? undefined
      : fakeFunding({ bpsPerHour: o.fundingBpsPerHour ?? 0.1 });

  const intent = buildPerpIntent({
    kind,
    source: "test",
    market,
    account: {
      owner: "OwnerPubkey1111111111111111111111111111111",
      subAccountId: 0,
    },
    side: o.side ?? "long",
    orderType: "market",
    limitPrice: undefined,
    slippageBps: o.slippageBps ?? BASELINE.slippageBps,
    leverage: o.leverage ?? BASELINE.leverage,
    collateral,
    prices: fakePrices({
      markPrice: o.markPrice ?? BASELINE.markPrice,
      oraclePrice: o.oraclePrice ?? o.markPrice ?? BASELINE.markPrice,
    }),
    funding,
    build: testBuild({
      entryPrice: o.markPrice ?? BASELINE.markPrice,
      ...o.build,
    }),
    collateralProvenance: "user",
  });

  if (!o.perp) return intent;
  return { ...intent, perp: { ...intent.perp, ...o.perp } };
}

export function testPosition(
  overrides: Partial<PerpPosition> = {},
): PerpPosition {
  return {
    venue: "fake",
    symbol: "SOL-PERP",
    side: "long",
    baseAmount: BASELINE.baseAmount,
    baseDecimals: 9,
    entryPrice: BASELINE.markPrice,
    markPrice: BASELINE.markPrice,
    notional: usdc(BASELINE.notional),
    collateral: usdc(BASELINE.collateral),
    unrealizedPnl: 0n,
    liquidationPrice: BASELINE.venueLiquidationPrice,
    leverage: BASELINE.leverage,
    ...overrides,
  };
}
