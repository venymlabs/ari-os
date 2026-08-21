/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * src/pools — concentrated-liquidity management and pump.fun bonding-curve
 * trading, behind the same invariant as the rest of Aetheria: **nothing here moves
 * money.**
 *
 * Every value-touching entry point in this package returns a `TradeIntent` — plain,
 * journalable data — which the caller hands to `TradeGateway.execute()`. No file in
 * this package signs a transaction, broadcasts one, holds a keypair, or reaches for
 * a wallet. The LLM's reachable surface ends at "here is a structured intent", and
 * the kernel re-validates all of it from scratch.
 *
 * Layout:
 *   types.ts            venue-agnostic CLMM vocabulary + the `AmmVenue` port
 *   guards.ts           pure, fail-closed safety checks (spend, rug-heat, sizing, authorities)
 *   intent.ts           venue draft → kernel-ready `TradeIntent`
 *   chain.ts            the three RPC reads this package needs, as a port
 *   meteora/            DLMM bin maths, data API, SDK port, venue adapter
 *   rebalance/          the pure rebalance decision + its churn ledger
 *   pumpfun/            curve PDAs, decoding, exact integer maths, instructions
 *   tools/              the eight agent tools (factories over one dependency bundle)
 */

// ── contracts ──
export type {
  AmmVenue,
  ClaimFeesRequest,
  DepositSide,
  ListPoolsQuery,
  LiquidityShape,
  LpPosition,
  OpenLiquidityRequest,
  PoolSummary,
  PriceLevel,
  RangeSpec,
  RemoveLiquidityRequest,
  VenueTxDraft,
} from "./types.js";
export { LIQUIDITY_SHAPES } from "./types.js";

export {
  isPoolGuardError,
  PoolGuardError,
  refuse,
  throwRefusal,
} from "./errors.js";
export type { PoolGuardCode, Refusal } from "./errors.js";

// ── guards ──
export {
  defaultPoolGuardConfig,
  guardBaseLeg,
  guardCurveBuy,
  guardCurveLiquidity,
  guardCurveSell,
  guardCurveSlippage,
  guardLevelRange,
  guardLpOpen,
  guardLpSizing,
  guardPoolLiquidity,
  guardRugHeat,
  guardSpend,
  guardTokenAuthorities,
  limitsFor,
  MAX_LEVELS_PER_POSITION,
} from "./guards.js";
export type {
  CurveTradeSubject,
  LpOpenSubject,
  LpSizingSubject,
  PoolGuardConfig,
  QuoteLimits,
} from "./guards.js";

// ── intents ──
export {
  assertWalletSignableAlone,
  BASE_FEE_LAMPORTS,
  toTradeIntent,
  withdrawInputLeg,
} from "./intent.js";
export type { BuiltIntent, IntentDraft, PoolIntentMeta } from "./intent.js";

// ── chain ──
export { RpcChainReader } from "./chain.js";
export type { AccountSnapshot, Blockhash, ChainReader } from "./chain.js";

// ── meteora ──
export {
  activePositionInRange,
  BASIS_POINT_MAX,
  binArrayIndicesFor,
  BinMathError,
  binDrift,
  binOfPrice,
  binOfUiPrice,
  binSpan,
  distributeAmount,
  divergenceLossPct,
  isActiveInRange,
  MAX_BIN_ID,
  MAX_BIN_PER_ARRAY,
  MAX_BIN_PER_POSITION,
  MAX_BIN_STEP,
  MIN_BIN_ID,
  planDeposit,
  priceOfBin,
  rangeAroundActive,
  rangeWidthPct,
  shapeWeights,
  uiPriceOfBin,
} from "./meteora/bins.js";
export type { BinAllocation, BinRange } from "./meteora/bins.js";

export { MeteoraDataApi, MeteoraDataApiError } from "./meteora/dlmm-api.js";
export type {
  DataApiPool,
  ListResult,
  MeteoraDataApiOptions,
} from "./meteora/dlmm-api.js";

export {
  compileV0,
  DLMM_PACKAGE,
  loadDlmmModule,
  STRATEGY_NAME,
} from "./meteora/sdk-port.js";
export type {
  AddLiquidityArgs,
  DlmmPoolHandle,
  DlmmSdk,
  RemoveLiquidityArgs,
  SdkPoolState,
  SdkPosition,
  SdkTxParts,
} from "./meteora/sdk-port.js";

export { RealDlmmSdk } from "./meteora/real-sdk.js";
export {
  METEORA_DLMM_VENUE_ID,
  MeteoraDlmmVenue,
  positionFromSdk,
  summaryFromApi,
  summaryFromSdk,
  uiToBaseUnits,
} from "./meteora/venue.js";

// ── rebalance ──
export {
  computeEconomics,
  decideRebalance,
  defaultRebalancePolicy,
} from "./rebalance/decide.js";
export type {
  EconomicsBreakdown,
  RebalanceDecision,
  RebalanceEconomics,
  RebalanceOutcome,
  RebalancePolicy,
  RebalanceSubject,
} from "./rebalance/decide.js";
export { EMPTY_HISTORY, RebalanceLedger } from "./rebalance/ledger.js";
export type { RebalanceHistory } from "./rebalance/ledger.js";

// ── pump.fun ──
export {
  BONDING_CURVE_DISCRIMINATOR,
  BUY_DISCRIMINATOR,
  GLOBAL_DISCRIMINATOR,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_TOKEN_DECIMALS,
  PUMP_TOTAL_SUPPLY,
  SELL_DISCRIMINATOR,
} from "./pumpfun/constants.js";
export {
  associatedBondingCurve,
  associatedTokenAccount,
  bondingCurvePda,
  creatorVaultPda,
  CurveDecodeError,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeGlobal,
  eventAuthorityPda,
  feeConfigPda,
  globalPda,
  globalVolumeAccumulatorPda,
  isSolPaired,
  userVolumeAccumulatorPda,
} from "./pumpfun/curve.js";
export type {
  BondingCurveAccount,
  FeeConfigAccount,
  GlobalAccount,
} from "./pumpfun/curve.js";
export {
  bondingCurveMarketCap,
  calculateFeeTier,
  CurveMathError,
  curveFeeBps,
  curveProgressPct,
  curveUiPrice,
  quoteBuyForSolBudget,
  quoteSell,
  solCostForTokens,
  solForTokens,
  tokensForSol,
} from "./pumpfun/math.js";
export type {
  BuyQuote,
  CurveReserves,
  FeeTier,
  Fees,
  SellQuote,
} from "./pumpfun/math.js";
export {
  buildBuyInstruction,
  buildSellInstruction,
  buildUnsignedTx,
  buyAccounts,
  ensureUserAtaInstruction,
  pickFeeRecipient,
  sellAccounts,
} from "./pumpfun/instructions.js";
export type {
  BuiltTx,
  CurveIxContext,
  PumpAccountSlot,
} from "./pumpfun/instructions.js";
export { PumpFunClient } from "./pumpfun/client.js";
export type { CurveState, PumpFunClientOptions } from "./pumpfun/client.js";
export { routeForCurve, routeForMissingCurve } from "./pumpfun/migration.js";
export type { CurveRoute, RoutingDecision } from "./pumpfun/migration.js";

// ── tools ──
export {
  DEFAULT_PRIORITY_FEE_LAMPORTS,
  readRugHeat,
  resolveDeps,
} from "./tools/deps.js";
export type { PoolsDeps, PoolsDepsInput, RugHeatSource } from "./tools/deps.js";
export {
  makePoolsCloseTool,
  makePoolsListTool,
  makePoolsOpenTool,
  makePoolsPositionTool,
  makePoolsRebalanceTool,
} from "./tools/pools.js";
export {
  makePumpfunBuyTool,
  makePumpfunCurveTool,
  makePumpfunSellTool,
} from "./tools/pumpfun.js";
export type { DelegationPayload } from "./tools/pumpfun.js";
export { makePoolsTools, POOL_TOOL_NAMES } from "./tools/registry.js";
export type { AnyPoolTool, PoolsToolset } from "./tools/registry.js";
