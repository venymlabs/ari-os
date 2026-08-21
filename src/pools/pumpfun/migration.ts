/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TOKEN_PROGRAM_ID } from "../../chains/solana/spl.js";
import { refuse, type Refusal } from "../errors.js";
import type { CurveState } from "./client.js";

const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();

/**
 * Pre- vs post-migration routing.
 *
 * A pump.fun token lives on its bonding curve until the curve completes, at which
 * point liquidity moves to PumpSwap and the token becomes routable by aggregators.
 * Those are two different execution paths, and picking the wrong one does not fail
 * cleanly — a bonding-curve instruction against a completed curve reverts, and a
 * Jupiter route against a live curve either finds nothing or finds a sliver of
 * side liquidity and fills at a terrible price.
 *
 * So the choice is made explicitly here, as data, and `pumpfun_buy` / `pumpfun_sell`
 * **delegate** rather than guess: a migrated token is answered with
 * `route: 'jupiter'`, which the tool surfaces as an instruction to use the existing
 * `swap_jupiter` path. This package never re-implements what Jupiter already does.
 */

export type CurveRoute = "bonding-curve" | "jupiter";

export interface RoutingDecision {
  readonly route: CurveRoute;
  readonly reason: string;
  /** Set when the caller must be stopped rather than redirected. */
  readonly refusal: Refusal | null;
}

/** No curve account at all: the mint was never a pump launch, so it is Jupiter's problem. */
export function routeForMissingCurve(mint: string): RoutingDecision {
  return {
    route: "jupiter",
    reason: `${mint} has no pump.fun bonding curve — route it through swap_jupiter`,
    refusal: null,
  };
}

/**
 * Decide how to trade a token whose curve we could read.
 *
 * The refusals here are the shapes this package deliberately does not build:
 * a non-SOL quote mint, a Token-2022 base mint, mayhem or cashback coins — all of
 * which require pump's `buy_v2` with its 27-account layout. Approximating them
 * with the legacy instruction would produce a transaction that either reverts or,
 * worse, transacts against the wrong accounts.
 */
export function routeForCurve(curve: CurveState): RoutingDecision {
  if (curve.complete) {
    return {
      route: "jupiter",
      reason: `${curve.mint} has completed its bonding curve and migrated — route it through swap_jupiter`,
      refusal: null,
    };
  }
  if (!curve.solPaired) {
    return {
      route: "bonding-curve",
      reason: "curve is quoted in a non-SOL asset",
      refusal: refuse(
        "POOL_UNSUPPORTED_CURVE",
        `${curve.mint} is quoted in ${curve.raw.quoteMint ?? "a non-SOL asset"} and needs pump's buy_v2 path`,
      ),
    };
  }
  if (curve.tokenProgramId !== TOKEN_PROGRAM) {
    return {
      route: "bonding-curve",
      reason: "Token-2022 base mint",
      refusal: refuse(
        "POOL_TOKEN2022",
        `${curve.mint} is a Token-2022 mint; the legacy buy/sell instructions do not cover it`,
      ),
    };
  }
  if (curve.creator === undefined) {
    return {
      route: "bonding-curve",
      reason: "curve predates the creator field",
      refusal: refuse(
        "POOL_UNSUPPORTED_CURVE",
        `${curve.mint} is a pre-creator-fee curve (${curve.raw.rawLength}-byte account); its creator_vault cannot be derived`,
      ),
    };
  }
  if (curve.isMayhemMode === true || curve.isCashbackCoin === true) {
    return {
      route: "bonding-curve",
      reason: "mayhem/cashback coin",
      refusal: refuse(
        "POOL_UNSUPPORTED_CURVE",
        `${curve.mint} is a mayhem/cashback coin and needs pump's buy_v2 account layout`,
      ),
    };
  }
  return {
    route: "bonding-curve",
    reason: "live SOL-paired curve",
    refusal: null,
  };
}
