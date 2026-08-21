/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Preview,
  ToolContext,
  ToolOutcome,
} from "../../kernel/contracts.js";
import { evaluatePerpGuards, type PerpGuardVerdict } from "../guards.js";
import { asTradeIntent, type PerpIntent } from "../intent.js";
import type { FundingRate } from "../types.js";
import {
  errMsg,
  guardContext,
  type PerpsToolDeps,
  type PerpsSnapshot,
} from "./deps.js";

/**
 * The shared tail of every proposing perps tool.
 *
 * THE INVARIANT, in one place: these tools build an intent and stop. There is no
 * call to `ctx.gateway.execute()` anywhere in this package, no signer, no
 * broadcaster, and no keypair. `execute()` returns the same artifact
 * `simulate()` does — a proposal — because for perps there is nothing else a
 * tool is allowed to do.
 *
 * A second reason it stops here, specific to perps: `TradeGateway` settles by
 * wallet balance delta, which cannot verify a perp fill (see the `PerpIntent`
 * doc comment). Routing a perp intent through it today would produce a
 * misleading settle even if `staticGuards` accepted the kind — which it does
 * not. So the tool hands the intent back and the engine decides, with a human in
 * the loop, what to do with it.
 */
export interface PerpProposal {
  readonly kind: "perp_proposal";
  readonly intent: PerpIntent;
  readonly verdict: PerpGuardVerdict;
  readonly warnings: readonly string[];
  /** Always false. Present so a caller can assert on it rather than infer it. */
  readonly executed: false;
}

export function proposalPreview(proposal: PerpProposal): Preview {
  const lines = renderProposal(proposal);
  return {
    summary: lines,
    quote: proposal.intent.quote,
    warnings: proposal.warnings,
    // Typed as TradeIntent for the shared contract; it is the full PerpIntent
    // object, `perp` leg included. Handing it to the kernel today yields
    // INVALID_INTENT, which is the correct fail-closed answer until the kernel
    // learns the perp kinds.
    intent: asTradeIntent(proposal.intent),
    data: proposal,
  };
}

export function proposalResult(proposal: PerpProposal): ToolOutcome {
  return {
    isError: !proposal.verdict.ok,
    text: renderProposal(proposal),
    data: proposal,
  };
}

export function renderProposal(proposal: PerpProposal): string {
  const lines = [proposal.intent.summary];
  if (proposal.warnings.length > 0) {
    lines.push("", ...proposal.warnings.map((w) => `! ${w}`));
  }
  if (!proposal.verdict.ok) {
    lines.push("", "REFUSED by the perps guards:");
    for (const v of proposal.verdict.violations)
      lines.push(`  ${v.code}: ${v.message}`);
  } else {
    lines.push(
      "",
      "PROPOSAL ONLY — this tool never executes. The kernel re-validates before anything moves.",
    );
  }
  return lines.join("\n");
}

export function makeProposal(
  deps: PerpsToolDeps,
  snapshot: PerpsSnapshot,
  intent: PerpIntent,
  venueWarnings: readonly string[],
  dryRun: boolean,
): PerpProposal {
  const verdict = evaluatePerpGuards(
    intent,
    guardContext(deps, snapshot, intent.perp.market, dryRun),
  );
  return {
    kind: "perp_proposal",
    intent,
    verdict,
    warnings: venueWarnings,
    executed: false,
  };
}

/**
 * Funding is fetched separately and is allowed to fail — but the failure is
 * carried as `undefined`, never as zero. `fundingSane` refuses an opening intent
 * with no reading, so a funding outage becomes a refusal rather than a blind
 * trade.
 */
export async function readFunding(
  deps: PerpsToolDeps,
  symbol: string,
): Promise<{ funding: FundingRate | undefined; warning: string | undefined }> {
  try {
    return {
      funding: await deps.venue.getFundingRate(symbol),
      warning: undefined,
    };
  } catch (err) {
    return {
      funding: undefined,
      warning: `funding rate unavailable: ${errMsg(err)}`,
    };
  }
}

export function ctxUnused(_ctx: ToolContext): void {
  /* the proposing tools need only ownerWallet, taken in accountRef */
}
