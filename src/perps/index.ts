/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * src/perps — venue-agnostic perpetuals for ARI OS.
 *
 * The architectural invariant is unchanged and non-negotiable: THE MODEL CANNOT
 * MOVE MONEY. Perps tools build a structured `PerpIntent` and return it. Nothing
 * in this package signs, broadcasts, or holds a keypair, and there is no call to
 * `TradeGateway.execute()` anywhere in it.
 *
 * Layers, bottom-up:
 *   types.ts / venue.ts   the `PerpsVenue` port — no venue SDK type crosses it
 *   liquidation.ts        pure liquidation maths + venue/model reconciliation
 *   policy.ts             input-leg-denominated perps caps
 *   exposure.ts           pure portfolio aggregation
 *   intent.ts             `PerpIntent` + the single bridge to `TradeIntent`
 *   guards.ts             pure, synchronous, fail-closed deterministic guards
 *   drift/                the first `PerpsVenue` implementation
 *   tools/                perps_markets · perps_positions · perps_open · perps_close · perps_adjust
 *   testing/              a network-free fake venue
 */

// ── domain + port ──
export type {
  FundingRate,
  LiquidationEstimate,
  PerpAccountStatus,
  PerpMarket,
  PerpMarketStatus,
  PerpOrderType,
  PerpPosition,
  PerpPrices,
  PerpSide,
} from "./types.js";
export { oppositeSide } from "./types.js";
export type {
  AdjustPositionRequest,
  BlockhashSource,
  ClosePositionRequest,
  LiquidationQuery,
  OpenPositionRequest,
  PerpAccountRef,
  PerpsVenue,
  VenueOrderBuild,
} from "./venue.js";

// ── errors ──
export {
  isPerpGuardError,
  kernelCodeFor,
  PERP_GUARD_CODES,
  PerpGuardError,
  PerpsVenueError,
} from "./errors.js";
export type { PerpGuardCode } from "./errors.js";

// ── liquidation maths ──
export {
  isUsablePrice,
  liquidationDistanceBps,
  maxLeverageForDistance,
  modelLiquidationPrice,
  oracleDivergenceBps,
  reconcileLiquidation,
} from "./liquidation.js";
export type {
  LiquidationSource,
  ModelLiquidationArgs,
  ReconciledLiquidation,
} from "./liquidation.js";

// ── policy ──
export {
  applyPerpsPolicyOverrides,
  capsFor,
  defaultPerpsPolicy,
  leverageToBps,
  notionalFromCollateral,
} from "./policy.js";
export type { PerpsCaps, PerpsPolicy, PerpsPolicyOverrides } from "./policy.js";

// ── exposure ──
export {
  emptyExposure,
  exposureFrom,
  positionIn,
  staleExposure,
} from "./exposure.js";
export type { PortfolioExposure } from "./exposure.js";

// ── intents ──
export {
  assertPerpIntentShape,
  asTradeIntent,
  buildPerpIntent,
  isOpeningKind,
  isReducingKind,
  PERP_INTENT_KINDS,
  summarizePerpIntent,
} from "./intent.js";
export type {
  BuildPerpIntentArgs,
  PerpIntent,
  PerpIntentKind,
  PerpLeg,
} from "./intent.js";

// ── guards ──
export {
  evaluatePerpGuards,
  PERP_RULES,
  perpGuards,
  positionLiquidationDistanceBps,
} from "./guards.js";
export type {
  PerpGuardContext,
  PerpGuardVerdict,
  PerpViolation,
} from "./guards.js";

// ── Drift adapter ──
export { DriftVenue, readOnlyWallet } from "./drift/drift-venue.js";
export type { DriftVenueOptions } from "./drift/drift-venue.js";
export {
  DRIFT_SETTLEMENT_MINT,
  DRIFT_VENUE_ID,
  driftMarketStatus,
  fundingBpsPerHour,
  marginRatioToFraction,
  maxLeverageFromInitialMargin,
  notionalQuoteUnits,
  toPerpMarket,
} from "./drift/convert.js";

// ── tools ──
export { createPerpsTools, PERPS_TOOL_NAMES } from "./tools/registry.js";
export type {
  AnyPerpsTool,
  PerpsToolName,
  PerpsToolset,
} from "./tools/registry.js";
export type { PerpsToolDeps } from "./tools/deps.js";
export { makePerpsMarketsTool } from "./tools/perps-markets.js";
export { makePerpsPositionsTool } from "./tools/perps-positions.js";
export { makePerpsOpenTool } from "./tools/perps-open.js";
export { makePerpsCloseTool } from "./tools/perps-close.js";
export { makePerpsAdjustTool } from "./tools/perps-adjust.js";
export type { PerpsMarketsConfig } from "./tools/perps-markets.js";
export type { PerpsPositionsConfig } from "./tools/perps-positions.js";
export type { PerpsOpenConfig } from "./tools/perps-open.js";
export type { PerpsCloseConfig } from "./tools/perps-close.js";
export type { PerpsAdjustConfig } from "./tools/perps-adjust.js";
export type { PerpProposal } from "./tools/propose.js";

// ── kernel settle adapter ──
export { positionReaderFor, positionReaderOver } from "./settle.js";

// ── testing helpers (network-free) ──
export {
  fakeFunding,
  fakeMarket,
  FakePerpsVenue,
  fakePosition,
  fakePrices,
  usdc,
} from "./testing/fake-venue.js";
export type { FakeVenueOptions } from "./testing/fake-venue.js";
