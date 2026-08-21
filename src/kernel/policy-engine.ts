/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PolicyConfig, TradeIntent } from "./contracts.js";
import {
  isIntentKind,
  isPerpIntentKind,
  postsZeroCollateral,
} from "./contracts.js";
import { GuardError } from "./errors.js";
import { quoteBucketFor, slippageBps } from "./money.js";

/** Tolerance between the route's encoded min-out and the clamped slippage (rounding/oracle drift). */
const MIN_OUT_TOLERANCE_BPS = 50;

export interface GuardOptions {
  readonly dryRun: boolean;
  readonly confirmedByUser: boolean;
}

/**
 * Deterministic, side-effect-free guards that don't need network I/O. These are
 * sourced entirely from engine-owned policy + the intent's own claims; nothing
 * here trusts model output. Throws GuardError on the first failure.
 */
export function staticGuards(
  policy: PolicyConfig,
  intent: TradeIntent,
  opts: GuardOptions,
): void {
  if (policy.killSwitch) {
    throw new GuardError(
      "KILL_SWITCH",
      "kill switch is engaged — all trading is halted",
    );
  }
  if (!opts.dryRun && !policy.executionEnabled) {
    throw new GuardError(
      "EXECUTION_DISABLED",
      "execution is disabled — the kernel is in dry-run; arm it before trading",
    );
  }
  if (!isIntentKind(intent.kind)) {
    throw new GuardError(
      "INVALID_INTENT",
      `unsupported intent kind: ${String(intent.kind)}`,
    );
  }

  // The input leg must be a real outflow for every kind that HAS one. A perp
  // reduce or close posts no collateral — it hands the venue an order — so for
  // those the rule is "never negative" rather than "always positive". The check
  // is gated on the kind rather than dropped: any kind that spends still has to
  // declare a positive amount, because that amount is what the caps bind to.
  if (postsZeroCollateral(intent.kind)) {
    if (intent.input.amount < 0n) {
      throw new GuardError(
        "INVALID_INTENT",
        "input amount must not be negative",
      );
    }
  } else if (intent.input.amount <= 0n) {
    throw new GuardError("INVALID_INTENT", "input amount must be positive");
  }

  // A perp leg is required for a perp kind and forbidden for anything else, so
  // no intent can reach the money path whose settle strategy is ambiguous.
  if (isPerpIntentKind(intent.kind)) {
    if (!intent.perp) {
      throw new GuardError(
        "INVALID_INTENT",
        `intent kind ${intent.kind} is missing its perp leg`,
      );
    }
    if (intent.perp.minBaseAmount > intent.perp.expectedBaseAmount) {
      throw new GuardError(
        "INVALID_INTENT",
        "perp minimum base size exceeds the expected size",
      );
    }
    if (intent.perp.expectedBaseAmount <= 0n) {
      throw new GuardError(
        "INVALID_INTENT",
        "perp expected base size must be positive",
      );
    }
  } else if (intent.perp) {
    throw new GuardError(
      "INVALID_INTENT",
      `intent kind ${intent.kind} must not carry a perp leg`,
    );
  }

  if (!intent.unsignedTxBase64) {
    throw new GuardError(
      "INVALID_INTENT",
      "intent is missing its built transaction",
    );
  }

  // Untrusted (model/metadata-sourced) mints require an explicit human confirmation.
  if (
    (intent.inputProvenance === "untrusted" ||
      intent.outputProvenance === "untrusted") &&
    !opts.confirmedByUser
  ) {
    throw new GuardError(
      "MINT_NOT_PINNED",
      "a mint in this trade is not pinned by you — explicit confirmation required",
    );
  }

  // Priority fee is hard-capped: min(absolute lamports, bps-of-input-notional).
  // Denominated on the input leg so no price oracle sits in the safety path — a
  // tool or model can never request an unbounded fee that drains the wallet on
  // top of the spend. The fee is only bounded by notional for quote-asset inputs
  // (SOL/USDC); for a sell the absolute lamport ceiling alone applies.
  if (
    intent.priorityFeeLamports < 0 ||
    !Number.isFinite(intent.priorityFeeLamports)
  ) {
    throw new GuardError(
      "PRIORITY_FEE_INVALID",
      "priority fee must be a finite, non-negative lamport amount",
    );
  }
  const feeLamports = BigInt(Math.floor(intent.priorityFeeLamports));
  if (feeLamports > policy.priorityFeeMaxLamports) {
    throw new GuardError(
      "PRIORITY_FEE_EXCEEDED",
      `priority fee ${feeLamports} lamports exceeds the ${policy.priorityFeeMaxLamports} lamport ceiling`,
    );
  }
  // Only meaningful when there IS a notional to take a fraction of. A perp
  // reduce or close spends nothing, which would make the ceiling 0 and refuse
  // every exit — and blocking exits is how a safety system becomes the trap it
  // exists to prevent. There the absolute lamport ceiling alone applies.
  if (quoteBucketFor(intent.input.mint) && intent.input.amount > 0n) {
    const bpsCeiling =
      (intent.input.amount * BigInt(policy.priorityFeeMaxBps)) / 10_000n;
    if (feeLamports > bpsCeiling) {
      throw new GuardError(
        "PRIORITY_FEE_EXCEEDED",
        `priority fee ${feeLamports} lamports exceeds ${policy.priorityFeeMaxBps}bps of notional (${bpsCeiling})`,
      );
    }
  }

  // Slippage is hard-clamped regardless of what the user or the model asked for.
  if (intent.quote.slippageBps > policy.maxSlippageBps) {
    throw new GuardError(
      "SLIPPAGE_EXCEEDED",
      `slippage ${intent.quote.slippageBps}bps exceeds max ${policy.maxSlippageBps}bps`,
    );
  }

  // The route's worst-case out must be consistent with the clamped slippage.
  const impliedBps = slippageBps(
    intent.quote.outAmount,
    intent.quote.minOutAmount,
  );
  if (impliedBps > policy.maxSlippageBps + MIN_OUT_TOLERANCE_BPS) {
    throw new GuardError(
      "MIN_OUT_MISMATCH",
      `route min-out implies ${impliedBps}bps slippage, above the clamp`,
    );
  }

  // Mint allow/deny on both legs.
  for (const mint of [intent.input.mint, intent.output.mint]) {
    if (policy.mintDenylist.includes(mint)) {
      throw new GuardError("MINT_DENIED", `mint ${mint} is on the denylist`);
    }
    if (policy.mintAllowlist && !policy.mintAllowlist.includes(mint)) {
      throw new GuardError(
        "MINT_DENIED",
        `mint ${mint} is not on the allowlist`,
      );
    }
  }
}
