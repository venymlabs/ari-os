/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type QuoteBucket,
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MINT,
  WSOL_MINT,
  toBaseUnits,
} from "../kernel/money.js";

/**
 * Perps caps, denominated in the INPUT-LEG quote asset (SOL or USDC), in base units.
 *
 * The same principle as the swap path, extended to leverage: the collateral is
 * what leaves the wallet, and notional is derived from it by an integer leverage
 * multiply — `notional = collateral × leverage`. Both sides of every comparison
 * are therefore in the input asset's own base units and NO PRICE ORACLE SITS IN
 * THE SAFETY PATH. A broken mark price cannot inflate a position past its cap,
 * because the cap never asks what the position is worth.
 */
export interface PerpsCaps {
  readonly maxCollateralPerPosition: bigint;
  readonly maxNotionalPerPosition: bigint;
  readonly maxPortfolioNotional: bigint;
}

/**
 * The deterministic perps safety policy. Engine-owned, never sourced from LLM
 * output or tool input, and re-read at the chokepoint. This layers ON TOP of the
 * kernel's `PolicyConfig` spend caps — the collateral leg still passes through
 * the kernel's own reservation, so a perp can never spend more than the wallet's
 * global per-trade/hour/day allowance either.
 */
export interface PerpsPolicy {
  /** Master arm for perps specifically. Defaults to false — perps stay dark until turned on. */
  readonly perpsEnabled: boolean;
  /**
   * Wind-down mode. When true only reduce-only intents (reduce/close) are
   * permitted — the agent may get flat, never bigger. Engaged by the kill switch
   * or manually.
   */
  readonly windDownOnly: boolean;

  readonly maxLeverage: number;
  /** Reject an opening intent that starts closer than this to liquidation. */
  readonly minLiquidationDistanceBps: number;
  /** Absolute funding magnitude above which the reading is treated as bad data. */
  readonly maxFundingRateBpsPerHour: number;
  /** Direction-aware: the most funding, per hour, this side is willing to PAY. */
  readonly maxAdverseFundingBpsPerHour: number;
  readonly maxSlippageBps: number;
  /** Mark/oracle divergence above which the market is considered untradeable. */
  readonly maxOracleDivergenceBps: number;
  /** How far the venue's and the model's liquidation estimates may disagree before the intent is ambiguous. */
  readonly liquidationToleranceBps: number;
  readonly maxOpenPositions: number;

  readonly capsSol: PerpsCaps;
  readonly capsUsdc: PerpsCaps;

  /** null = any market (subject to the denylist). Non-null = strict allowlist. */
  readonly marketAllowlist: readonly string[] | null;
  readonly marketDenylist: readonly string[];
  /** Collateral mints the agent may post as perp margin. Empty = perps are unusable (fail closed). */
  readonly allowedCollateralMints: readonly string[];

  /**
   * Whether an account/subaccount initialisation transaction may be built at all.
   * Separate from `perpsEnabled` on purpose: creating on-chain state costs rent
   * and is its own user decision, never a side effect of a trade.
   */
  readonly allowAccountCreation: boolean;
}

export function capsFor(policy: PerpsPolicy, bucket: QuoteBucket): PerpsCaps {
  return bucket === "sol" ? policy.capsSol : policy.capsUsdc;
}

/**
 * Conservative defaults: perps disarmed, 3× leverage, 20% minimum liquidation
 * distance, 1 SOL / 200 USDC of collateral per position.
 */
export function defaultPerpsPolicy(): PerpsPolicy {
  return {
    perpsEnabled: false,
    windDownOnly: false,
    maxLeverage: 3,
    minLiquidationDistanceBps: 2_000,
    maxFundingRateBpsPerHour: 5,
    maxAdverseFundingBpsPerHour: 2,
    maxSlippageBps: 100,
    maxOracleDivergenceBps: 100,
    liquidationToleranceBps: 500,
    maxOpenPositions: 3,
    capsSol: {
      maxCollateralPerPosition: toBaseUnits(1, SOL_DECIMALS),
      maxNotionalPerPosition: toBaseUnits(3, SOL_DECIMALS),
      maxPortfolioNotional: toBaseUnits(10, SOL_DECIMALS),
    },
    capsUsdc: {
      maxCollateralPerPosition: toBaseUnits(200, USDC_DECIMALS),
      maxNotionalPerPosition: toBaseUnits(600, USDC_DECIMALS),
      maxPortfolioNotional: toBaseUnits(2000, USDC_DECIMALS),
    },
    marketAllowlist: null,
    marketDenylist: [],
    allowedCollateralMints: [USDC_MINT, WSOL_MINT],
    allowAccountCreation: false,
  };
}

export interface PerpsPolicyOverrides {
  perpsEnabled?: boolean;
  windDownOnly?: boolean;
  maxLeverage?: number;
  minLiquidationDistanceBps?: number;
  maxFundingRateBpsPerHour?: number;
  maxAdverseFundingBpsPerHour?: number;
  maxSlippageBps?: number;
  maxOracleDivergenceBps?: number;
  liquidationToleranceBps?: number;
  maxOpenPositions?: number;
  /** UI amounts (e.g. 0.5 SOL), converted to base units without float drift. */
  solCollateralPerPosition?: number;
  solNotionalPerPosition?: number;
  solPortfolioNotional?: number;
  usdcCollateralPerPosition?: number;
  usdcNotionalPerPosition?: number;
  usdcPortfolioNotional?: number;
  marketAllowlist?: readonly string[] | null;
  marketDenylist?: readonly string[];
  allowedCollateralMints?: readonly string[];
  allowAccountCreation?: boolean;
}

export function applyPerpsPolicyOverrides(
  base: PerpsPolicy,
  o: PerpsPolicyOverrides,
): PerpsPolicy {
  return {
    perpsEnabled: o.perpsEnabled ?? base.perpsEnabled,
    windDownOnly: o.windDownOnly ?? base.windDownOnly,
    maxLeverage: o.maxLeverage ?? base.maxLeverage,
    minLiquidationDistanceBps:
      o.minLiquidationDistanceBps ?? base.minLiquidationDistanceBps,
    maxFundingRateBpsPerHour:
      o.maxFundingRateBpsPerHour ?? base.maxFundingRateBpsPerHour,
    maxAdverseFundingBpsPerHour:
      o.maxAdverseFundingBpsPerHour ?? base.maxAdverseFundingBpsPerHour,
    maxSlippageBps: o.maxSlippageBps ?? base.maxSlippageBps,
    maxOracleDivergenceBps:
      o.maxOracleDivergenceBps ?? base.maxOracleDivergenceBps,
    liquidationToleranceBps:
      o.liquidationToleranceBps ?? base.liquidationToleranceBps,
    maxOpenPositions: o.maxOpenPositions ?? base.maxOpenPositions,
    capsSol: {
      maxCollateralPerPosition:
        o.solCollateralPerPosition != null
          ? toBaseUnits(o.solCollateralPerPosition, SOL_DECIMALS)
          : base.capsSol.maxCollateralPerPosition,
      maxNotionalPerPosition:
        o.solNotionalPerPosition != null
          ? toBaseUnits(o.solNotionalPerPosition, SOL_DECIMALS)
          : base.capsSol.maxNotionalPerPosition,
      maxPortfolioNotional:
        o.solPortfolioNotional != null
          ? toBaseUnits(o.solPortfolioNotional, SOL_DECIMALS)
          : base.capsSol.maxPortfolioNotional,
    },
    capsUsdc: {
      maxCollateralPerPosition:
        o.usdcCollateralPerPosition != null
          ? toBaseUnits(o.usdcCollateralPerPosition, USDC_DECIMALS)
          : base.capsUsdc.maxCollateralPerPosition,
      maxNotionalPerPosition:
        o.usdcNotionalPerPosition != null
          ? toBaseUnits(o.usdcNotionalPerPosition, USDC_DECIMALS)
          : base.capsUsdc.maxNotionalPerPosition,
      maxPortfolioNotional:
        o.usdcPortfolioNotional != null
          ? toBaseUnits(o.usdcPortfolioNotional, USDC_DECIMALS)
          : base.capsUsdc.maxPortfolioNotional,
    },
    marketAllowlist:
      o.marketAllowlist !== undefined
        ? o.marketAllowlist
        : base.marketAllowlist,
    marketDenylist: o.marketDenylist ?? base.marketDenylist,
    allowedCollateralMints:
      o.allowedCollateralMints ?? base.allowedCollateralMints,
    allowAccountCreation: o.allowAccountCreation ?? base.allowAccountCreation,
  };
}

/**
 * Leverage as integer basis points, so notional maths stays in bigint and never
 * touches a float. Rejects anything non-finite or non-positive.
 */
export function leverageToBps(leverage: number): number | undefined {
  if (!Number.isFinite(leverage) || leverage <= 0) return undefined;
  const bps = Math.round(leverage * 10_000);
  return bps > 0 ? bps : undefined;
}

/**
 * Notional in the INPUT LEG's base units: collateral × leverage, in integer maths.
 * This is the number every notional cap compares against. No oracle, no float.
 */
export function notionalFromCollateral(
  collateralBaseUnits: bigint,
  leverage: number,
): bigint | undefined {
  const bps = leverageToBps(leverage);
  if (bps === undefined) return undefined;
  if (collateralBaseUnits < 0n) return undefined;
  return (collateralBaseUnits * BigInt(bps)) / 10_000n;
}
