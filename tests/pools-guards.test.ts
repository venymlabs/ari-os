/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { type MintInfo } from "../src/kernel/contracts.js";
import {
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MINT,
  WSOL_MINT,
  toBaseUnits,
} from "../src/kernel/money.js";
import type { RugHeat } from "../src/pools/signals.js";
import {
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
  type PoolGuardConfig,
} from "../src/pools/guards.js";
import type { LpPosition, PoolSummary } from "../src/pools/types.js";

const TOKEN = "BonkMint11111111111111111111111111111111111";
const CFG = defaultPoolGuardConfig();

function mint(over: Partial<MintInfo> = {}): MintInfo {
  return {
    mint: TOKEN,
    decimals: 6,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    isToken2022: false,
    freezeAuthority: null,
    mintAuthority: null,
    ...over,
  };
}

function pool(over: Partial<PoolSummary> = {}): PoolSummary {
  return {
    venue: "meteora-dlmm",
    address: "PooL11111111111111111111111111111111111111",
    name: "BONK-SOL",
    baseMint: TOKEN,
    baseDecimals: 6,
    quoteMint: WSOL_MINT,
    quoteDecimals: SOL_DECIMALS,
    levelStepBps: 25,
    activeLevel: 1000,
    activePrice: 0.0001,
    baseFeeBps: 25,
    liquidityQuote: toBaseUnits(500, SOL_DECIMALS),
    volume24hUsd: 100_000,
    fees24hUsd: 250,
    feeApr24hPct: 12,
    hasToken2022: false,
    ...over,
  };
}

function position(over: Partial<LpPosition> = {}): LpPosition {
  return {
    venue: "meteora-dlmm",
    poolAddress: pool().address,
    positionAddress: "Pos111111111111111111111111111111111111111",
    owner: "Ownr11111111111111111111111111111111111111",
    baseMint: TOKEN,
    baseDecimals: 6,
    quoteMint: WSOL_MINT,
    quoteDecimals: SOL_DECIMALS,
    levelStepBps: 25,
    lowerLevel: 990,
    upperLevel: 1010,
    activeLevel: 1000,
    baseAmount: 0n,
    quoteAmount: 0n,
    unclaimedFeeBase: 0n,
    unclaimedFeeQuote: 0n,
    shape: "spot",
    openedAt: undefined,
    ...over,
  };
}

const CLEAN_HEAT: RugHeat = {
  score: 10,
  reasons: ["no strong rug tells in window"],
};

// ── spend cap ────────────────────────────────────────────────────────────────

test("spend cap binds on SOL and USDC and ignores a token input leg", () => {
  assert.equal(
    guardSpend(CFG, {
      mint: WSOL_MINT,
      amount: toBaseUnits(0.5, SOL_DECIMALS),
      decimals: 9,
    }),
    null,
  );
  assert.equal(
    guardSpend(CFG, {
      mint: WSOL_MINT,
      amount: toBaseUnits(0.51, SOL_DECIMALS),
      decimals: 9,
    })?.code,
    "POOL_SPEND_CAP",
  );
  assert.equal(
    guardSpend(CFG, {
      mint: USDC_MINT,
      amount: toBaseUnits(100, USDC_DECIMALS),
      decimals: 6,
    }),
    null,
  );
  assert.equal(
    guardSpend(CFG, {
      mint: USDC_MINT,
      amount: toBaseUnits(101, USDC_DECIMALS),
      decimals: 6,
    })?.code,
    "POOL_SPEND_CAP",
  );
  // A sell: the input is the token, which no quote-denominated cap can bound.
  assert.equal(
    guardSpend(CFG, { mint: TOKEN, amount: 10n ** 18n, decimals: 6 }),
    null,
  );
});

test("a non-positive spend is always refused", () => {
  assert.equal(
    guardSpend(CFG, { mint: WSOL_MINT, amount: 0n, decimals: 9 })?.code,
    "POOL_SPEND_CAP",
  );
  assert.equal(
    guardSpend(CFG, { mint: TOKEN, amount: -1n, decimals: 6 })?.code,
    "POOL_SPEND_CAP",
  );
});

test("limitsFor maps quote assets to their bucket and rejects anything else", () => {
  assert.equal(limitsFor(CFG, WSOL_MINT), CFG.sol);
  assert.equal(limitsFor(CFG, USDC_MINT), CFG.usdc);
  assert.equal(limitsFor(CFG, TOKEN), null);
});

// ── authorities ──────────────────────────────────────────────────────────────

test("a live mint or freeze authority is refused unless the mint is allowlisted", () => {
  assert.equal(guardTokenAuthorities(CFG, [mint()]), null);
  assert.equal(
    guardTokenAuthorities(CFG, [mint({ mintAuthority: "Auth1" })])?.code,
    "POOL_MINT_AUTHORITY",
  );
  assert.equal(
    guardTokenAuthorities(CFG, [mint({ freezeAuthority: "Auth2" })])?.code,
    "POOL_FREEZE_AUTHORITY",
  );

  const allow: PoolGuardConfig = { ...CFG, authorityAllowlist: [TOKEN] };
  assert.equal(
    guardTokenAuthorities(allow, [
      mint({ mintAuthority: "Auth1", freezeAuthority: "Auth2" }),
    ]),
    null,
  );
});

test("authority check fails closed on a missing or empty mint record", () => {
  assert.equal(guardTokenAuthorities(CFG, [])?.code, "POOL_MINT_AUTHORITY");
  assert.equal(guardTokenAuthorities(CFG, [null])?.code, "POOL_MINT_AUTHORITY");
  assert.equal(
    guardTokenAuthorities(CFG, [mint(), undefined])?.code,
    "POOL_MINT_AUTHORITY",
  );
});

test("Token-2022 is refused for parity with the kernel, and the allowlist does not bypass it", () => {
  assert.equal(
    guardTokenAuthorities(CFG, [mint({ isToken2022: true })])?.code,
    "POOL_TOKEN2022",
  );
  const allow: PoolGuardConfig = { ...CFG, authorityAllowlist: [TOKEN] };
  assert.equal(
    guardTokenAuthorities(allow, [mint({ isToken2022: true })])?.code,
    "POOL_TOKEN2022",
  );
  const enabled: PoolGuardConfig = { ...CFG, allowToken2022: true };
  assert.equal(
    guardTokenAuthorities(enabled, [mint({ isToken2022: true })]),
    null,
  );
});

// ── rug heat ─────────────────────────────────────────────────────────────────

test("rug-heat at or above the threshold is a rejection, not advice", () => {
  assert.equal(guardRugHeat(CFG, CLEAN_HEAT), null);
  assert.equal(guardRugHeat(CFG, { score: 59, reasons: [] }), null);
  assert.equal(
    guardRugHeat(CFG, { score: 60, reasons: ["x"] })?.code,
    "POOL_RUG_HEAT",
  );
  assert.equal(
    guardRugHeat(CFG, { score: 100, reasons: ["x"] })?.code,
    "POOL_RUG_HEAT",
  );
});

test("a missing or nonsense rug-heat reading fails closed", () => {
  assert.equal(guardRugHeat(CFG, null)?.code, "POOL_RUG_HEAT");
  assert.equal(guardRugHeat(CFG, undefined)?.code, "POOL_RUG_HEAT");
  assert.equal(
    guardRugHeat(CFG, { score: Number.NaN, reasons: [] })?.code,
    "POOL_RUG_HEAT",
  );
});

test("a never-traded mint scores 60 from the signals engine and lands on the reject side", () => {
  // SignalsEngine returns exactly this for a mint with no trades in the window.
  const cold: RugHeat = {
    score: 60,
    reasons: ["no trades in window — illiquid / inactive"],
  };
  assert.equal(guardRugHeat(CFG, cold)?.code, "POOL_RUG_HEAT");
});

// ── pool liquidity ───────────────────────────────────────────────────────────

test("pool TVL floor is denominated in the pool quote asset", () => {
  assert.equal(guardPoolLiquidity(CFG, pool()), null);
  assert.equal(
    guardPoolLiquidity(
      CFG,
      pool({ liquidityQuote: toBaseUnits(49, SOL_DECIMALS) }),
    )?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
  assert.equal(
    guardPoolLiquidity(CFG, pool({ liquidityQuote: undefined }))?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
});

test("a pool quoted in something other than SOL or USDC has no supported cap and is refused", () => {
  const weird = pool({ quoteMint: TOKEN, quoteDecimals: 6 });
  assert.equal(guardPoolLiquidity(CFG, weird)?.code, "POOL_LIQUIDITY_FLOOR");
  assert.equal(
    guardLpSizing(CFG, {
      pool: weird,
      addQuote: 1n,
      existingPositionQuote: 0n,
      openPositions: [],
      isNewPosition: true,
    })?.code,
    "POOL_POSITION_CAP",
  );
});

// ── LP sizing ────────────────────────────────────────────────────────────────

test("position notional cap counts what is already in the position", () => {
  const base = { pool: pool(), openPositions: [], isNewPosition: false };
  assert.equal(
    guardLpSizing(CFG, {
      ...base,
      addQuote: toBaseUnits(0.5, 9),
      existingPositionQuote: toBaseUnits(1.5, 9),
    }),
    null,
  );
  assert.equal(
    guardLpSizing(CFG, {
      ...base,
      addQuote: toBaseUnits(0.6, 9),
      existingPositionQuote: toBaseUnits(1.5, 9),
    })?.code,
    "POOL_POSITION_CAP",
  );
});

test("concurrent-position cap applies to new positions only", () => {
  const open = new Array(CFG.maxConcurrentPositions)
    .fill(null)
    .map(() => position());
  assert.equal(
    guardLpSizing(CFG, {
      pool: pool(),
      addQuote: 1n,
      existingPositionQuote: 0n,
      openPositions: open,
      isNewPosition: true,
    })?.code,
    "POOL_MAX_POSITIONS",
  );
  // Topping up an existing position does not add a position.
  assert.equal(
    guardLpSizing(CFG, {
      pool: pool(),
      addQuote: 1n,
      existingPositionQuote: 0n,
      openPositions: open,
      isNewPosition: false,
    }),
    null,
  );
});

test("negative position amounts are refused", () => {
  assert.equal(
    guardLpSizing(CFG, {
      pool: pool(),
      addQuote: -1n,
      existingPositionQuote: 0n,
      openPositions: [],
      isNewPosition: true,
    })?.code,
    "POOL_POSITION_CAP",
  );
});

// ── base leg ─────────────────────────────────────────────────────────────────

test("the base leg is bounded as a share of holdings, oracle-free", () => {
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 0n, baseHoldings: 0n }),
    null,
    "quote-only deposit has no second leg",
  );
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 250n, baseHoldings: 1000n }),
    null,
    "25% of holdings is the default cap",
  );
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 251n, baseHoldings: 1000n })?.code,
    "POOL_BASE_LEG_CAP",
  );
});

test("the base-leg guard fails closed on unknown holdings and can be disabled entirely", () => {
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 1n, baseHoldings: null })?.code,
    "POOL_BASE_LEG_CAP",
  );
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 1n, baseHoldings: undefined })?.code,
    "POOL_BASE_LEG_CAP",
  );
  assert.equal(
    guardBaseLeg(CFG, { baseAmount: 1n, baseHoldings: 0n })?.code,
    "POOL_BASE_LEG_CAP",
  );
  const noTwoSided: PoolGuardConfig = { ...CFG, maxBaseLegPctOfHoldings: 0 };
  assert.equal(
    guardBaseLeg(noTwoSided, { baseAmount: 1n, baseHoldings: 10_000n })?.code,
    "POOL_BASE_LEG_CAP",
  );
});

// ── ranges ───────────────────────────────────────────────────────────────────

test("level range must be ordered, integral and no wider than one position", () => {
  assert.equal(
    guardLevelRange(CFG, { lowerLevel: 90, upperLevel: 110, activeLevel: 100 }),
    null,
  );
  assert.equal(
    guardLevelRange(CFG, { lowerLevel: 110, upperLevel: 90, activeLevel: 100 })
      ?.code,
    "POOL_RANGE_INVALID",
  );
  assert.equal(
    guardLevelRange(CFG, { lowerLevel: 0.5, upperLevel: 10, activeLevel: 5 })
      ?.code,
    "POOL_RANGE_INVALID",
  );
  assert.equal(
    guardLevelRange(CFG, { lowerLevel: 0, upperLevel: 70, activeLevel: 35 })
      ?.code,
    "POOL_RANGE_INVALID",
  );
  assert.equal(
    guardLevelRange(CFG, { lowerLevel: 0, upperLevel: 69, activeLevel: 35 }),
    null,
  );
});

// ── bonding curve ────────────────────────────────────────────────────────────

test("curve slippage is bounded and non-finite values are refused", () => {
  assert.equal(guardCurveSlippage(CFG, 300), null);
  assert.equal(guardCurveSlippage(CFG, 301)?.code, "POOL_SLIPPAGE");
  assert.equal(guardCurveSlippage(CFG, -1)?.code, "POOL_SLIPPAGE");
  assert.equal(guardCurveSlippage(CFG, Number.NaN)?.code, "POOL_SLIPPAGE");
});

test("curve liquidity floor reads real reserves, and a completed curve redirects", () => {
  assert.equal(
    guardCurveLiquidity(CFG, {
      realSolReserves: toBaseUnits(2, 9),
      complete: false,
    }),
    null,
  );
  assert.equal(
    guardCurveLiquidity(CFG, {
      realSolReserves: toBaseUnits(1.99, 9),
      complete: false,
    })?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
  assert.equal(
    guardCurveLiquidity(CFG, { realSolReserves: null, complete: false })?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
  assert.equal(
    guardCurveLiquidity(CFG, {
      realSolReserves: toBaseUnits(100, 9),
      complete: true,
    })?.code,
    "POOL_MIGRATED",
  );
});

// ── composites ───────────────────────────────────────────────────────────────

function lpSubject(over: Record<string, unknown> = {}) {
  return {
    pool: pool(),
    input: {
      mint: WSOL_MINT,
      amount: toBaseUnits(0.2, SOL_DECIMALS),
      decimals: SOL_DECIMALS,
    },
    baseAmount: 0n,
    baseHoldings: 0n,
    mints: [mint(), mint({ mint: WSOL_MINT, decimals: 9 })],
    rugHeat: CLEAN_HEAT,
    addQuote: toBaseUnits(0.2, SOL_DECIMALS),
    existingPositionQuote: 0n,
    openPositions: [],
    isNewPosition: true,
    lowerLevel: 990,
    upperLevel: 1010,
    ...over,
  } as Parameters<typeof guardLpOpen>[1];
}

test("a clean LP open passes every guard", () => {
  assert.equal(guardLpOpen(CFG, lpSubject()), null);
});

test("guardLpOpen reports the most significant failure first", () => {
  // Authorities outrank rug-heat, which outranks liquidity, which outranks sizing.
  assert.equal(
    guardLpOpen(
      CFG,
      lpSubject({
        mints: [mint({ mintAuthority: "A" })],
        rugHeat: { score: 99, reasons: [] },
      }),
    )?.code,
    "POOL_MINT_AUTHORITY",
  );
  assert.equal(
    guardLpOpen(
      CFG,
      lpSubject({
        rugHeat: { score: 99, reasons: [] },
        pool: pool({ liquidityQuote: 0n }),
      }),
    )?.code,
    "POOL_RUG_HEAT",
  );
  assert.equal(
    guardLpOpen(CFG, lpSubject({ pool: pool({ liquidityQuote: 0n }) }))?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
  assert.equal(
    guardLpOpen(
      CFG,
      lpSubject({
        input: {
          mint: WSOL_MINT,
          amount: toBaseUnits(5, SOL_DECIMALS),
          decimals: SOL_DECIMALS,
        },
        addQuote: toBaseUnits(5, SOL_DECIMALS),
      }),
    )?.code,
    "POOL_SPEND_CAP",
  );
});

function curveSubject(over: Record<string, unknown> = {}) {
  return {
    input: {
      mint: WSOL_MINT,
      amount: toBaseUnits(0.1, SOL_DECIMALS),
      decimals: SOL_DECIMALS,
    },
    slippageBps: 100,
    curve: { realSolReserves: toBaseUnits(10, SOL_DECIMALS), complete: false },
    mints: [mint()],
    rugHeat: CLEAN_HEAT,
    ...over,
  } as Parameters<typeof guardCurveBuy>[1];
}

test("a clean curve buy passes, and each gate can veto it alone", () => {
  assert.equal(guardCurveBuy(CFG, curveSubject()), null);
  assert.equal(
    guardCurveBuy(
      CFG,
      curveSubject({ mints: [mint({ freezeAuthority: "F" })] }),
    )?.code,
    "POOL_FREEZE_AUTHORITY",
  );
  assert.equal(
    guardCurveBuy(CFG, curveSubject({ rugHeat: null }))?.code,
    "POOL_RUG_HEAT",
  );
  assert.equal(
    guardCurveBuy(
      CFG,
      curveSubject({ curve: { realSolReserves: 1n, complete: false } }),
    )?.code,
    "POOL_LIQUIDITY_FLOOR",
  );
  assert.equal(
    guardCurveBuy(CFG, curveSubject({ slippageBps: 9_999 }))?.code,
    "POOL_SLIPPAGE",
  );
  assert.equal(
    guardCurveBuy(
      CFG,
      curveSubject({
        input: { mint: WSOL_MINT, amount: toBaseUnits(9, 9), decimals: 9 },
      }),
    )?.code,
    "POOL_SPEND_CAP",
  );
});

test("an exit is never blocked by rug-heat or a liquidity floor — only by shape", () => {
  const sell = {
    input: { mint: TOKEN, amount: 1_000n, decimals: 6 },
    slippageBps: 100,
    complete: false,
  };
  assert.equal(guardCurveSell(CFG, sell), null);
  // Even a burning, illiquid token can be exited.
  assert.equal(guardCurveSell(CFG, { ...sell, slippageBps: 300 }), null);
  assert.equal(
    guardCurveSell(CFG, { ...sell, slippageBps: 301 })?.code,
    "POOL_SLIPPAGE",
  );
  assert.equal(
    guardCurveSell(CFG, { ...sell, complete: true })?.code,
    "POOL_MIGRATED",
  );
});
