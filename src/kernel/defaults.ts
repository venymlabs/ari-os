/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: extracted from
 * `packages/shared/src/schemas.ts`; the Aetheria env/Telegram config loader is
 * intentionally not ported (ARI OS has its own in `src/config/`).
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PolicyConfig } from "./contracts.js";
import { SOL_DECIMALS, toBaseUnits, USDC_DECIMALS } from "./money.js";

export interface PolicyOverrides {
  executionEnabled?: boolean;
  killSwitch?: boolean;
  maxSlippageBps?: number;
  capSolPerTrade?: number;
  capSolPerHour?: number;
  capSolPerDay?: number;
  capUsdcPerTrade?: number;
  capUsdcPerHour?: number;
  capUsdcPerDay?: number;
  mintAllowlist?: readonly string[] | null;
  mintDenylist?: readonly string[];
  allowToken2022?: boolean;
}

/** Conservative defaults: dry-run, 1% max slippage, 1 SOL / 200 USDC per trade. */
export function defaultPolicy(): PolicyConfig {
  return {
    executionEnabled: false,
    killSwitch: false,
    maxSlippageBps: 100,
    capsSol: {
      perTrade: toBaseUnits(1, SOL_DECIMALS),
      perHour: toBaseUnits(5, SOL_DECIMALS),
      perDay: toBaseUnits(10, SOL_DECIMALS),
    },
    capsUsdc: {
      perTrade: toBaseUnits(200, USDC_DECIMALS),
      perHour: toBaseUnits(1000, USDC_DECIMALS),
      perDay: toBaseUnits(2000, USDC_DECIMALS),
    },
    mintAllowlist: null,
    mintDenylist: [],
    allowToken2022: false,
    priorityFeeMaxLamports: toBaseUnits(0.005, SOL_DECIMALS),
    priorityFeeMaxBps: 50,
  };
}

export function applyPolicyOverrides(
  base: PolicyConfig,
  o: PolicyOverrides,
): PolicyConfig {
  return {
    executionEnabled: o.executionEnabled ?? base.executionEnabled,
    killSwitch: o.killSwitch ?? base.killSwitch,
    maxSlippageBps: o.maxSlippageBps ?? base.maxSlippageBps,
    capsSol: {
      perTrade:
        o.capSolPerTrade != null
          ? toBaseUnits(o.capSolPerTrade, SOL_DECIMALS)
          : base.capsSol.perTrade,
      perHour:
        o.capSolPerHour != null
          ? toBaseUnits(o.capSolPerHour, SOL_DECIMALS)
          : base.capsSol.perHour,
      perDay:
        o.capSolPerDay != null
          ? toBaseUnits(o.capSolPerDay, SOL_DECIMALS)
          : base.capsSol.perDay,
    },
    capsUsdc: {
      perTrade:
        o.capUsdcPerTrade != null
          ? toBaseUnits(o.capUsdcPerTrade, USDC_DECIMALS)
          : base.capsUsdc.perTrade,
      perHour:
        o.capUsdcPerHour != null
          ? toBaseUnits(o.capUsdcPerHour, USDC_DECIMALS)
          : base.capsUsdc.perHour,
      perDay:
        o.capUsdcPerDay != null
          ? toBaseUnits(o.capUsdcPerDay, USDC_DECIMALS)
          : base.capsUsdc.perDay,
    },
    mintAllowlist:
      o.mintAllowlist !== undefined ? o.mintAllowlist : base.mintAllowlist,
    mintDenylist: o.mintDenylist ?? base.mintDenylist,
    allowToken2022: o.allowToken2022 ?? base.allowToken2022,
    priorityFeeMaxLamports: base.priorityFeeMaxLamports,
    priorityFeeMaxBps: base.priorityFeeMaxBps,
  };
}
