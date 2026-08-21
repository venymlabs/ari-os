/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PERP_INTENT_KINDS,
  type MintProvenance,
  type PerpIntentKind,
  type QuoteSummary,
  type TradeIntent,
} from "../kernel/contracts.js";
import { type TokenAmount, fromBaseUnits } from "../kernel/money.js";
import { PerpGuardError } from "./errors.js";
import type {
  FundingRate,
  PerpMarket,
  PerpMarketStatus,
  PerpOrderType,
  PerpPrices,
  PerpSide,
} from "./types.js";
import type { PerpAccountRef, VenueOrderBuild } from "./venue.js";

/**
 * The four perp kinds are declared by the kernel, not here: `IntentKind`
 * includes them, so `staticGuards` recognises a perp intent and selects the
 * venue-position settle for it. Re-exported for callers that only import this
 * module.
 */
export type { PerpIntentKind } from "../kernel/contracts.js";
export { PERP_INTENT_KINDS } from "../kernel/contracts.js";

/** Reducing kinds may still run under wind-down / kill-switch: the agent must always be able to get flat. */
export function isReducingKind(kind: PerpIntentKind): boolean {
  return kind === "perp_reduce" || kind === "perp_close";
}

/** Opening kinds ADD risk and carry the full entry-quality guard set. */
export function isOpeningKind(kind: PerpIntentKind): boolean {
  return kind === "perp_open" || kind === "perp_increase";
}

/**
 * The perp-specific half of an intent. Everything a guard needs to decide, and
 * nothing it has to fetch: guards are pure functions of `(intent, policy,
 * exposure, position)`, so the entire safety layer is unit-testable with no
 * network and no clock.
 */
export interface PerpLeg {
  readonly venue: string;
  /** Canonical market symbol, e.g. 'SOL-PERP'. */
  readonly market: string;
  /** Opaque venue handle, carried for the journal. Never interpreted by a guard. */
  readonly venueMarketIndex: number;
  readonly accountSubId: number;

  readonly side: PerpSide;
  readonly orderType: PerpOrderType;
  readonly limitPrice: number | undefined;
  readonly reduceOnly: boolean;
  readonly leverage: number;
  readonly slippageBps: number;

  readonly baseDecimals: number;
  /** Expected and worst-case filled base size — the perps analogue of out / min-out. */
  readonly expectedBaseAmount: bigint;
  readonly minBaseAmount: bigint;

  /** The margin leaving the wallet. Always identical to `TradeIntent.input`. */
  readonly collateral: TokenAmount;
  /** collateral × leverage, in the COLLATERAL asset's base units. No oracle in this number. */
  readonly notional: TokenAmount;

  readonly entryPrice: number;
  readonly markPrice: number;
  readonly oraclePrice: number;
  readonly maintenanceMarginRatio: number;
  readonly marketStatus: PerpMarketStatus;

  /** The venue's own liquidation estimate. `undefined` makes the intent ambiguous, and the guards refuse it. */
  readonly venueLiquidationPrice: number | undefined;
  /** Signed bps/hour; `undefined` is refused rather than assumed to be zero. */
  readonly fundingBpsPerHour: number | undefined;
}

/**
 * A perp intent.
 *
 * Structurally a `TradeIntent` with a widened `kind` plus the `perp` leg, so the
 * ENTIRE existing kernel chokepoint applies to it unchanged:
 *
 *   • kill switch / executionEnabled            — unchanged
 *   • input-leg spend cap reserve→consume       — unchanged, and it caps the MARGIN
 *   • priority-fee ceiling (abs + bps)          — unchanged
 *   • mint allow/deny + Token-2022 detection    — unchanged
 *   • untrusted-provenance confirmation         — unchanged
 *   • slippage clamp                            — unchanged (see `quote.slippageBps`)
 *   • idempotency, persist-before-broadcast,
 *     terminal expiry, reconciler               — unchanged
 *
 * The LLM still cannot move money: a perp tool returns one of these and stops.
 *
 * ── The one place the swap-shaped kernel does NOT transfer ──
 * A perp fill does not move a token balance — it changes a position on the
 * venue — so a balance-delta settle cannot verify one. On an open the
 * collateral mint is BOTH legs, which makes the output delta negative and a
 * balance check fire a shortfall on every success.
 *
 * The kernel therefore settles a perp kind against the venue instead: it reads
 * the signed position through `PositionReader` before signing and again after
 * confirmation, and requires the change to move in the ORDER's direction by at
 * least `perp.minBaseAmount`. That is why the token quote is neutralised here:
 *
 *   quote.outAmount = quote.minOutAmount = 0n   ("no token output leg")
 *
 * which makes the min-out consistency check a no-op instead of a false
 * positive, while `perp.expectedBaseAmount` / `perp.minBaseAmount` carry the
 * real fill bounds. A perp intent with no position reader mounted is refused
 * (`SETTLE_UNVERIFIABLE`) before broadcast — fail-closed, never unverified.
 */
export interface PerpIntent extends Omit<TradeIntent, "kind"> {
  readonly kind: PerpIntentKind;
  readonly perp: PerpLeg;
}

export interface BuildPerpIntentArgs {
  readonly kind: PerpIntentKind;
  /** The tool that built it, e.g. 'perps_open'. */
  readonly source: string;
  readonly market: PerpMarket;
  readonly account: PerpAccountRef;
  readonly side: PerpSide;
  readonly orderType: PerpOrderType;
  readonly limitPrice: number | undefined;
  readonly slippageBps: number;
  readonly leverage: number;
  /** The margin leaving the wallet (zero-amount for a pure reduce/close). */
  readonly collateral: TokenAmount;
  readonly prices: PerpPrices;
  readonly funding: FundingRate | undefined;
  readonly build: VenueOrderBuild;
  readonly collateralProvenance: MintProvenance;
}

function fmtPrice(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return "n/a";
  return `$${x.toLocaleString("en-US", { maximumFractionDigits: x < 1 ? 6 : 2 })}`;
}

/** Pure assembly. Does no validation of its own — that is `perpGuards`' job, deliberately. */
export function buildPerpIntent(args: BuildPerpIntentArgs): PerpIntent {
  const { market, build, prices } = args;
  const reduceOnly = isReducingKind(args.kind);

  const quote: QuoteSummary = {
    inAmount: args.collateral.amount,
    // Deliberate: a perp has no token output leg. See the PerpIntent doc comment.
    outAmount: 0n,
    minOutAmount: 0n,
    priceImpactPct: 0,
    routeLabel: `${market.venue}:${market.symbol}`,
    slippageBps: args.slippageBps,
    contextSlot: prices.oracleSlot,
  };

  const perp: PerpLeg = {
    venue: market.venue,
    market: market.symbol,
    venueMarketIndex: market.venueMarketIndex,
    accountSubId: args.account.subAccountId,
    side: args.side,
    orderType: args.orderType,
    limitPrice: args.limitPrice,
    reduceOnly,
    leverage: args.leverage,
    slippageBps: args.slippageBps,
    baseDecimals: market.baseDecimals,
    expectedBaseAmount: build.expectedBaseAmount,
    minBaseAmount: build.minBaseAmount,
    collateral: args.collateral,
    notional: build.notional,
    entryPrice: build.entryPrice,
    markPrice: prices.markPrice,
    oraclePrice: prices.oraclePrice,
    maintenanceMarginRatio: market.maintenanceMarginRatio,
    marketStatus: market.status,
    venueLiquidationPrice: build.estimatedLiquidationPrice,
    fundingBpsPerHour: args.funding?.bpsPerHour,
  };

  return {
    kind: args.kind,
    source: args.source,
    input: args.collateral,
    /**
     * The collateral asset is also the output leg: it is what comes BACK to the
     * wallet when the position is closed. Using a real, inspectable mint keeps
     * the kernel's Token-2022 detection and mint allow/deny working on both legs.
     */
    output: { mint: args.collateral.mint, decimals: args.collateral.decimals },
    inputProvenance: args.collateralProvenance,
    outputProvenance: args.collateralProvenance,
    unsignedTxBase64: build.unsignedTxBase64,
    recentBlockhash: build.recentBlockhash,
    lastValidBlockHeight: build.lastValidBlockHeight,
    landMode: "self-rpc",
    landHandle: undefined,
    priorityFeeLamports: build.priorityFeeLamports,
    quote,
    summary: summarizePerpIntent({ kind: args.kind, perp, market }),
    perp,
  };
}

export function summarizePerpIntent(args: {
  kind: PerpIntentKind;
  perp: PerpLeg;
  market: PerpMarket;
}): string {
  const { kind, perp, market } = args;
  const verb =
    kind === "perp_open"
      ? "Open"
      : kind === "perp_increase"
        ? "Increase"
        : kind === "perp_reduce"
          ? "Reduce"
          : "Close";
  const size = fromBaseUnits(
    perp.expectedBaseAmount,
    perp.baseDecimals,
  ).toLocaleString("en-US", { maximumFractionDigits: 4 });
  const margin = fromBaseUnits(
    perp.collateral.amount,
    perp.collateral.decimals,
  ).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
  const notional = fromBaseUnits(
    perp.notional.amount,
    perp.notional.decimals,
  ).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });

  const parts = [
    `${verb} ${perp.leverage}× ${perp.side} ${market.symbol}`,
    `${size} ${market.baseSymbol}`,
    `margin ${margin} ${market.quoteSymbol} → notional ${notional} ${market.quoteSymbol}`,
    `entry ${fmtPrice(perp.entryPrice)}`,
    `liq ${fmtPrice(perp.venueLiquidationPrice)}`,
    perp.fundingBpsPerHour === undefined
      ? "funding n/a"
      : `funding ${perp.fundingBpsPerHour.toFixed(3)}bps/h`,
    `slippage ${perp.slippageBps}bps`,
  ];
  if (perp.reduceOnly) parts.push("reduce-only");
  if (perp.orderType === "limit")
    parts.push(`limit ${fmtPrice(perp.limitPrice)}`);
  return parts.join(" · ");
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Runtime structural validation. Fails CLOSED — anything missing, mistyped, or
 * out of range is a refusal, never a coerced default. Called by `perpGuards`
 * before any policy comparison so no later rule can read a NaN.
 */
export function assertPerpIntentShape(
  value: unknown,
): asserts value is PerpIntent {
  const bad = (why: string): never => {
    throw new PerpGuardError(
      "INVALID_PERP_INTENT",
      `perp intent failed structural validation: ${why}`,
    );
  };
  if (typeof value !== "object" || value === null) return bad("not an object");
  const i = value as Partial<PerpIntent>;

  if (typeof i.kind !== "string" || !PERP_INTENT_KINDS.includes(i.kind))
    return bad(`unsupported kind ${String(i.kind)}`);
  if (typeof i.source !== "string" || i.source.length === 0)
    return bad("missing source");
  if (typeof i.unsignedTxBase64 !== "string" || i.unsignedTxBase64.length === 0)
    return bad("missing built transaction");
  if (typeof i.recentBlockhash !== "string" || i.recentBlockhash.length === 0)
    return bad("missing recent blockhash");
  if (
    !Number.isInteger(i.lastValidBlockHeight) ||
    (i.lastValidBlockHeight ?? 0) <= 0
  )
    return bad("missing block height");
  if (!isFiniteNumber(i.priorityFeeLamports) || i.priorityFeeLamports < 0)
    return bad("invalid priority fee");

  const input = i.input;
  if (!input || typeof input.mint !== "string" || input.mint.length === 0)
    return bad("missing input mint");
  if (typeof input.amount !== "bigint" || input.amount < 0n)
    return bad("invalid collateral amount");
  if (!Number.isInteger(input.decimals))
    return bad("invalid collateral decimals");
  if (!i.output || typeof i.output.mint !== "string")
    return bad("missing output leg");
  if (!i.quote || typeof i.quote.slippageBps !== "number")
    return bad("missing quote summary");

  const p = i.perp;
  if (!p || typeof p !== "object") return bad("missing perp leg");
  if (typeof p.venue !== "string" || p.venue.length === 0)
    return bad("missing venue");
  if (typeof p.market !== "string" || p.market.length === 0)
    return bad("missing market");
  if (p.side !== "long" && p.side !== "short")
    return bad(`invalid side ${String(p.side)}`);
  if (p.orderType !== "market" && p.orderType !== "limit")
    return bad(`invalid order type ${String(p.orderType)}`);
  if (typeof p.reduceOnly !== "boolean") return bad("missing reduceOnly flag");
  if (!isFiniteNumber(p.leverage) || p.leverage <= 0)
    return bad("invalid leverage");
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0)
    return bad("invalid slippage");
  if (typeof p.expectedBaseAmount !== "bigint" || p.expectedBaseAmount <= 0n)
    return bad("invalid expected base size");
  if (typeof p.minBaseAmount !== "bigint" || p.minBaseAmount < 0n)
    return bad("invalid minimum base size");
  if (p.minBaseAmount > p.expectedBaseAmount)
    return bad("minimum base size exceeds the expected size");
  if (!p.collateral || typeof p.collateral.amount !== "bigint")
    return bad("missing collateral leg");
  if (
    p.collateral.mint !== input.mint ||
    p.collateral.amount !== input.amount
  ) {
    return bad("perp collateral does not match the intent input leg");
  }
  if (
    !p.notional ||
    typeof p.notional.amount !== "bigint" ||
    p.notional.amount < 0n
  )
    return bad("invalid notional");
  if (p.notional.mint !== input.mint)
    return bad("notional is not denominated in the input leg");
  if (!isFiniteNumber(p.entryPrice) || p.entryPrice <= 0)
    return bad("invalid entry price");
  if (!isFiniteNumber(p.markPrice) || p.markPrice <= 0)
    return bad("invalid mark price");
  if (!isFiniteNumber(p.oraclePrice) || p.oraclePrice <= 0)
    return bad("invalid oracle price");
  if (
    !isFiniteNumber(p.maintenanceMarginRatio) ||
    p.maintenanceMarginRatio < 0 ||
    p.maintenanceMarginRatio >= 1
  ) {
    return bad("invalid maintenance margin ratio");
  }
  if (
    p.orderType === "limit" &&
    (!isFiniteNumber(p.limitPrice) || p.limitPrice <= 0)
  ) {
    return bad("limit order without a usable limit price");
  }
  if (p.reduceOnly !== isReducingKind(i.kind)) {
    return bad(
      `reduceOnly=${String(p.reduceOnly)} is inconsistent with kind ${i.kind}`,
    );
  }
}

/**
 * The single bridge from a perp intent to the kernel's `TradeIntent`.
 *
 * There is no cast: `IntentKind` includes the four perp kinds and `TradeIntent`
 * declares an optional `perp` leg that `PerpLeg` satisfies structurally, so a
 * `PerpIntent` simply IS a `TradeIntent`. What this function still buys is the
 * structural validation — the intent is checked here, where the error names the
 * builder, before the kernel re-validates it from scratch at the chokepoint.
 */
export function asTradeIntent(intent: PerpIntent): TradeIntent {
  assertPerpIntentShape(intent);
  return intent;
}
