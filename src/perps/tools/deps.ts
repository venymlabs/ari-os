/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type MintProvenance,
  type ToolContext,
} from "../../kernel/contracts.js";
import { type TokenAmount } from "../../kernel/money.js";
import {
  exposureFrom,
  type PortfolioExposure,
  positionIn,
  staleExposure,
} from "../exposure.js";
import type { PerpGuardContext } from "../guards.js";
import type { PerpsPolicy } from "../policy.js";
import type { PerpPosition } from "../types.js";
import type { PerpAccountRef, PerpsVenue } from "../venue.js";

/**
 * Perps tools are FACTORIES over these deps rather than module-level constants.
 *
 * `ToolContext` is per-INVOCATION state — wallet, gateway, read-only services.
 * A venue is a composition-time singleton with live policy getters hanging off
 * it, so it does not belong there: widening `ToolContext` would force every
 * construction site in the codebase to know about perps even when perps are
 * off. Closing over the venue and the policy getters gives tools that satisfy
 * `IntentToolDefinition` exactly — same `simulate`/`execute` signatures, same
 * unwidened `ToolContext` — while still reaching a venue the contract has never
 * heard of.
 *
 * Every field that can change at runtime is a GETTER, so a tool always reads the
 * live policy and arm state instead of a snapshot taken at construction. Same
 * reason `TradeGatewayImpl` takes `policy: () => PolicyConfig`.
 */
export interface PerpsToolDeps {
  readonly venue: PerpsVenue;
  readonly policy: () => PerpsPolicy;
  readonly killSwitch: () => boolean;
  readonly executionEnabled: () => boolean;
  /** The collateral asset posted as margin — the INPUT LEG every cap is denominated in. */
  readonly collateral: () => Pick<TokenAmount, "mint" | "decimals">;
  readonly subAccountId?: () => number;
  readonly priorityFeeLamports?: () => number;
  /**
   * Provenance of the collateral mint. Defaults to 'user': the collateral asset
   * is engine-configured, not something the model named. A market SYMBOL from
   * model text is still resolved against the venue's own market list, so an
   * invented market cannot survive.
   */
  readonly collateralProvenance?: () => MintProvenance;
}

export const DEFAULT_PERPS_PRIORITY_FEE_LAMPORTS = 200_000;
export const DEFAULT_SLIPPAGE_BPS = 50;

export function accountRef(
  deps: PerpsToolDeps,
  ctx: ToolContext,
): PerpAccountRef {
  return { owner: ctx.ownerWallet, subAccountId: deps.subAccountId?.() ?? 0 };
}

export function priorityFee(deps: PerpsToolDeps): number {
  return deps.priorityFeeLamports?.() ?? DEFAULT_PERPS_PRIORITY_FEE_LAMPORTS;
}

export interface PerpsSnapshot {
  readonly positions: readonly PerpPosition[];
  readonly exposure: PortfolioExposure;
  readonly accountInitialized: boolean;
}

/**
 * Read everything the guards need, in one place, with EVERY failure mapped to a
 * fail-closed snapshot: an unreadable venue yields a stale exposure and an
 * uninitialised account, both of which the guards refuse to open into.
 */
export async function readSnapshot(
  deps: PerpsToolDeps,
  account: PerpAccountRef,
): Promise<PerpsSnapshot> {
  let positions: readonly PerpPosition[] = [];
  let exposure: PortfolioExposure;
  try {
    positions = await deps.venue.getPositions(account);
    exposure = exposureFrom(positions);
  } catch (err) {
    exposure = staleExposure(
      `could not read positions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let accountInitialized: boolean;
  try {
    accountInitialized = (await deps.venue.getAccountStatus(account))
      .initialized;
  } catch {
    accountInitialized = false;
  }

  return { positions, exposure, accountInitialized };
}

export function guardContext(
  deps: PerpsToolDeps,
  snapshot: PerpsSnapshot,
  market: string,
  dryRun: boolean,
): PerpGuardContext {
  return {
    policy: deps.policy(),
    killSwitch: deps.killSwitch(),
    executionEnabled: deps.executionEnabled(),
    exposure: snapshot.exposure,
    position: positionIn(snapshot.positions, market),
    accountInitialized: snapshot.accountInitialized,
    dryRun,
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
