/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { TradeIntent } from "../src/kernel/contracts.js";
import { defaultPolicy } from "../src/kernel/defaults.js";
import { isGuardError } from "../src/kernel/errors.js";
import { USDC_MINT } from "../src/kernel/money.js";
import { staticGuards } from "../src/kernel/policy-engine.js";
import { isPerpGuardError } from "../src/perps/errors.js";
import type { PerpIntent, PerpIntentKind } from "../src/perps/intent.js";
import {
  assertPerpIntentShape,
  asTradeIntent,
  isOpeningKind,
  isReducingKind,
} from "../src/perps/intent.js";
import { usdc } from "../src/perps/testing/fake-venue.js";
import { BASELINE, testIntent } from "../src/perps/testing/fixtures.js";

test("the collateral IS the input leg — the amount the kernel caps on", () => {
  const i = testIntent();
  assert.equal(i.input.mint, USDC_MINT);
  assert.equal(i.input.amount, BASELINE.collateral);
  assert.equal(i.perp.collateral.amount, i.input.amount);
  assert.equal(i.perp.collateral.mint, i.input.mint);
});

test("notional is denominated in the input leg, not in USD floats", () => {
  const i = testIntent();
  assert.equal(i.perp.notional.mint, i.input.mint);
  assert.equal(i.perp.notional.amount, BASELINE.notional);
  assert.equal(typeof i.perp.notional.amount, "bigint");
});

test('the quote encodes "no token output leg" so the swap-shaped min-out check is a no-op, not a false positive', () => {
  const i = testIntent();
  assert.equal(i.quote.inAmount, BASELINE.collateral);
  assert.equal(i.quote.outAmount, 0n);
  assert.equal(i.quote.minOutAmount, 0n);
  // The real fill bounds live on the perp leg, where a perp-aware settle can find them.
  assert.equal(i.perp.expectedBaseAmount, BASELINE.baseAmount);
  assert.ok(
    i.perp.minBaseAmount > 0n &&
      i.perp.minBaseAmount < i.perp.expectedBaseAmount,
  );
});

test("slippage survives onto the quote so the kernel clamp still applies", () => {
  assert.equal(testIntent({ slippageBps: 75 }).quote.slippageBps, 75);
});

test("the output leg is the collateral asset — a real, inspectable mint on both legs", () => {
  const i = testIntent();
  assert.equal(i.output.mint, USDC_MINT);
  assert.equal(i.output.decimals, i.input.decimals);
});

test("reduceOnly is derived from the kind, never taken on trust", () => {
  assert.equal(testIntent({ kind: "perp_open" }).perp.reduceOnly, false);
  assert.equal(testIntent({ kind: "perp_increase" }).perp.reduceOnly, false);
  assert.equal(
    testIntent({ kind: "perp_reduce", side: "short", collateral: usdc(0n) })
      .perp.reduceOnly,
    true,
  );
  assert.equal(
    testIntent({ kind: "perp_close", side: "short", collateral: usdc(0n) }).perp
      .reduceOnly,
    true,
  );

  assert.equal(isOpeningKind("perp_open"), true);
  assert.equal(isOpeningKind("perp_reduce"), false);
  assert.equal(isReducingKind("perp_close"), true);
  assert.equal(isReducingKind("perp_increase"), false);
});

test("the summary states the numbers a human needs to approve the trade", () => {
  const s = testIntent().summary;
  for (const fragment of [
    "SOL-PERP",
    "long",
    "margin",
    "notional",
    "entry",
    "liq",
    "funding",
    "slippage",
  ]) {
    assert.ok(s.includes(fragment), `summary is missing '${fragment}': ${s}`);
  }
});

test("asTradeIntent keeps the perp leg on the object for the kernel journal", () => {
  const perp = testIntent();
  const trade = asTradeIntent(perp);
  assert.equal(trade.input.amount, perp.input.amount);
  assert.equal(trade.unsignedTxBase64, perp.unsignedTxBase64);
  assert.equal((trade as unknown as { perp: unknown }).perp, perp.perp);
});

/**
 * The load-bearing safety test.
 *
 * `IntentKind` has been widened, so the kernel now ACCEPTS a well-formed perp
 * intent — and the fail-closed edges moved with it. A perp kind without a perp
 * leg is unverifiable, a non-perp kind carrying one has an ambiguous settle
 * strategy, and both are refusals. This test is what fails loudly if either of
 * those stops holding.
 */
test("the kernel accepts a well-formed perp intent and refuses an ambiguous one", () => {
  const trade = asTradeIntent(testIntent());
  staticGuards(defaultPolicy(), trade, { dryRun: true, confirmedByUser: true });

  const refuses = (intent: TradeIntent, why: RegExp) => {
    try {
      staticGuards(defaultPolicy(), intent, {
        dryRun: true,
        confirmedByUser: true,
      });
      assert.fail(
        `the kernel accepted an intent it should refuse (${String(why)})`,
      );
    } catch (err) {
      assert.ok(isGuardError(err), `expected a GuardError, got ${String(err)}`);
      assert.equal(err.code, "INVALID_INTENT");
      assert.match(err.message, why);
    }
  };

  const { perp: _dropped, ...noLeg } = trade;
  refuses(noLeg as TradeIntent, /missing its perp leg/);
  refuses({ ...trade, kind: "swap" }, /must not carry a perp leg/);
  refuses(
    { ...trade, kind: "perp_frobnicate" as unknown as TradeIntent["kind"] },
    /unsupported intent kind/,
  );
});

/**
 * A close or reduce hands the venue an order rather than money, so its input leg
 * is legitimately zero — but only for those two kinds. Everything else still has
 * to declare a positive outflow, because that is what the caps bind to.
 */
test("zero collateral is accepted for a reduce/close and refused for an open", () => {
  const zero = (kind: PerpIntentKind): PerpIntent => {
    const base = testIntent();
    const collateral = { ...base.input, amount: 0n };
    return {
      ...base,
      kind,
      input: collateral,
      perp: {
        ...base.perp,
        reduceOnly: isReducingKind(kind),
        collateral,
        notional: { ...base.perp.notional, amount: 0n },
      },
    };
  };
  for (const kind of ["perp_reduce", "perp_close"] as const) {
    staticGuards(defaultPolicy(), zero(kind), {
      dryRun: true,
      confirmedByUser: true,
    });
  }
  for (const kind of ["perp_open", "perp_increase"] as const) {
    assert.throws(
      () =>
        staticGuards(defaultPolicy(), zero(kind), {
          dryRun: true,
          confirmedByUser: true,
        }),
      /input amount must be positive/,
    );
  }
});

test("a perp intent that IS structurally sound still satisfies the kernel-facing fields", () => {
  const trade = asTradeIntent(testIntent());
  assert.ok(trade.unsignedTxBase64.length > 0);
  assert.ok(trade.recentBlockhash.length > 0);
  assert.ok(trade.lastValidBlockHeight > 0);
  assert.ok(trade.priorityFeeLamports >= 0);
  assert.equal(trade.landMode, "self-rpc");
  assert.equal(trade.inputProvenance, "user");
});

test("assertPerpIntentShape rejects non-objects and foreign kinds", () => {
  for (const junk of [null, undefined, 42, "intent", []]) {
    assert.throws(() => assertPerpIntentShape(junk));
  }
  const swapish = { ...testIntent(), kind: "swap" };
  try {
    assertPerpIntentShape(swapish);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(isPerpGuardError(err));
    assert.equal(err.perpCode, "INVALID_PERP_INTENT");
  }
});

test("asTradeIntent refuses to bridge a malformed intent", () => {
  const broken = testIntent({ perp: { expectedBaseAmount: 0n } });
  assert.throws(() => asTradeIntent(broken));
});
