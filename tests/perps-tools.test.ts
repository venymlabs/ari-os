/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type ToolContext,
  type ToolServices,
  movesValue,
} from "../src/kernel/contracts.js";
import { USDC_DECIMALS, USDC_MINT } from "../src/kernel/money.js";
import { isPerpGuardError } from "../src/perps/errors.js";
import type { PerpIntent } from "../src/perps/intent.js";
import type { PerpsPolicy } from "../src/perps/policy.js";
import type { PerpAccountRef } from "../src/perps/venue.js";
import type { PerpPosition } from "../src/perps/types.js";
import {
  fakeMarket,
  FakePerpsVenue,
  fakePosition,
} from "../src/perps/testing/fake-venue.js";
import { testPolicy } from "../src/perps/testing/fixtures.js";
import type { PerpsToolDeps } from "../src/perps/tools/deps.js";
import type { PerpProposal } from "../src/perps/tools/propose.js";
import { createPerpsTools } from "../src/perps/tools/registry.js";

/**
 * A gateway that counts calls and refuses to do anything.
 *
 * This is the test that enforces the architectural invariant: after exercising
 * every perps tool, `gatewaySpy.calls` must still be 0. No perps tool may reach
 * `TradeGateway.execute()` — they build intents and stop.
 */
interface GatewaySpy {
  calls: number;
}

function toolCtx(spy: GatewaySpy): ToolContext {
  return {
    ownerWallet: "OwnerPubkey1111111111111111111111111111111",
    rpcUrl: "http://localhost:8899",
    services: {} as unknown as ToolServices,
    gateway: {
      execute: async () => {
        spy.calls += 1;
        throw new Error(
          "a perps tool reached the gateway — the invariant is broken",
        );
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    signal: undefined,
  };
}

function makeDeps(
  venue: FakePerpsVenue,
  policy: PerpsPolicy = testPolicy(),
  over: Partial<PerpsToolDeps> = {},
): PerpsToolDeps {
  return {
    venue,
    policy: () => policy,
    killSwitch: () => false,
    executionEnabled: () => true,
    collateral: () => ({ mint: USDC_MINT, decimals: USDC_DECIMALS }),
    ...over,
  };
}

const spy: GatewaySpy = { calls: 0 };
const ctx = toolCtx(spy);

function proposalOf(data: unknown): PerpProposal {
  const p = data as PerpProposal;
  assert.equal(p.kind, "perp_proposal");
  return p;
}

// ── reads ────────────────────────────────────────────────────────────────────

test("perps_markets lists markets and states the live policy", async () => {
  const venue = new FakePerpsVenue({
    markets: [
      fakeMarket(),
      fakeMarket({
        symbol: "BTC-PERP",
        venueMarketIndex: 1,
        baseSymbol: "BTC",
      }),
    ],
  });
  const tools = createPerpsTools(makeDeps(venue));
  const res = await tools
    .get("perps_markets")!
    .execute(ctx, {}, { idempotencyKey: "k" });
  assert.equal(res.isError, false);
  assert.match(res.text, /SOL-PERP/);
  assert.match(res.text, /BTC-PERP/);
  assert.match(res.text, /max 20×/);
  assert.match(res.text, /min liq distance 2000bps/);
});

test('perps_markets can attach prices and funding, and says "n/a" when funding is unavailable', async () => {
  const ok = new FakePerpsVenue();
  const withPrices = await createPerpsTools(makeDeps(ok))
    .get("perps_markets")!
    .execute(ctx, { withPrices: true }, { idempotencyKey: "k" });
  assert.match(withPrices.text, /mark \$150/);
  assert.match(withPrices.text, /funding 0\.1bps\/h/);

  const noFunding = new FakePerpsVenue({ funding: null });
  const res = await createPerpsTools(makeDeps(noFunding))
    .get("perps_markets")!
    .execute(ctx, { withPrices: true }, { idempotencyKey: "k" });
  assert.match(
    res.text,
    /funding n\/a/,
    "a missing funding reading must never render as 0",
  );
});

test("perps_positions reports no subaccount rather than inventing one", async () => {
  const venue = new FakePerpsVenue({ accountExists: false });
  const res = await createPerpsTools(makeDeps(venue))
    .get("perps_positions")!
    .execute(ctx, {}, { idempotencyKey: "k" });
  assert.equal(res.isError, false);
  assert.match(res.text, /No fake subaccount 0/);
  assert.match(res.text, /separate, explicit step/);
});

test("perps_positions renders size, pnl, liquidation distance and cap usage", async () => {
  const venue = new FakePerpsVenue({ positions: [fakePosition()] });
  const res = await createPerpsTools(makeDeps(venue))
    .get("perps_positions")!
    .execute(ctx, {}, { idempotencyKey: "k" });
  assert.match(res.text, /SOL-PERP long 1/);
  assert.match(res.text, /liq \$105/);
  assert.match(res.text, /3000bps away/);
  assert.match(res.text, /USDC perp notional 150 \/ 2,000 cap/);
});

test("perps_positions flags an incomplete exposure snapshot", async () => {
  const venue = new FakePerpsVenue({
    positions: [
      fakePosition({
        notional: {
          mint: "BonkMint11111111111111111111111111111111111",
          amount: 1n,
          decimals: 6,
        },
      }),
    ],
  });
  const res = await createPerpsTools(makeDeps(venue))
    .get("perps_positions")!
    .execute(ctx, {}, { idempotencyKey: "k" });
  assert.match(res.text, /exposure snapshot is incomplete/);
});

// ── proposals ────────────────────────────────────────────────────────────────

test("perps_open builds a complete intent and NEVER executes", async () => {
  const venue = new FakePerpsVenue();
  const tool = createPerpsTools(makeDeps(venue)).get("perps_open")!;
  const cfg = {
    market: "SOL-PERP",
    side: "long" as const,
    collateralUi: 50,
    leverage: 3,
  };

  const preview = await tool.simulate(ctx, cfg);
  assert.ok(preview.intent, "simulate must return the intent it built");
  const intent = preview.intent as unknown as PerpIntent;
  assert.equal(intent.kind, "perp_open");
  assert.equal(intent.input.mint, USDC_MINT);
  assert.equal(intent.input.amount, 50_000_000n);
  assert.equal(intent.perp.notional.amount, 150_000_000n);
  assert.equal(intent.perp.expectedBaseAmount, 1_000_000_000n);
  assert.equal(intent.perp.reduceOnly, false);

  const res = await tool.execute(ctx, cfg, { idempotencyKey: "k" });
  assert.equal(res.isError, false);
  const proposal = proposalOf(res.data);
  assert.equal(
    proposal.executed,
    false,
    "a perps tool must never report execution",
  );
  assert.equal(proposal.verdict.ok, true);
  assert.match(res.text, /PROPOSAL ONLY/);
  assert.equal(spy.calls, 0);
});

test("perps_open surfaces a guard refusal instead of proposing the trade", async () => {
  const venue = new FakePerpsVenue();
  const tool = createPerpsTools(
    makeDeps(venue, testPolicy({ maxLeverage: 2 })),
  ).get("perps_open")!;
  const res = await tool.execute(
    ctx,
    { market: "SOL-PERP", side: "long", collateralUi: 50, leverage: 3 },
    { idempotencyKey: "k" },
  );
  assert.equal(res.isError, true);
  assert.match(res.text, /REFUSED by the perps guards/);
  assert.match(res.text, /LEVERAGE_EXCEEDED/);
  assert.equal(proposalOf(res.data).verdict.ok, false);
});

test("perps_open refuses a market the venue does not have — an invented symbol cannot survive", async () => {
  const venue = new FakePerpsVenue();
  const tool = createPerpsTools(makeDeps(venue)).get("perps_open")!;
  await assert.rejects(
    () =>
      tool.execute(
        ctx,
        {
          market: "TOTALLY-MADE-UP-PERP",
          side: "long",
          collateralUi: 10,
          leverage: 2,
        },
        { idempotencyKey: "k" },
      ),
    /unknown market/,
  );
});

test("perps_close builds a reduce-only intent facing the opposite way, with zero new margin", async () => {
  const venue = new FakePerpsVenue({
    positions: [fakePosition({ side: "long" })],
  });
  const tool = createPerpsTools(makeDeps(venue)).get("perps_close")!;
  const res = await tool.execute(
    ctx,
    { market: "SOL-PERP" },
    { idempotencyKey: "k" },
  );

  const intent = proposalOf(res.data).intent;
  assert.equal(intent.kind, "perp_close");
  assert.equal(intent.perp.reduceOnly, true);
  assert.equal(intent.perp.side, "short", "closing a long must sell");
  assert.equal(
    intent.input.amount,
    0n,
    "a close posts no new margin, so it consumes no spend cap",
  );
  assert.equal(res.isError, false);
  assert.equal(spy.calls, 0);
});

test("perps_close honours a partial fraction", async () => {
  const venue = new FakePerpsVenue({
    positions: [fakePosition({ baseAmount: 1_000_000_000n })],
  });
  const tool = createPerpsTools(makeDeps(venue)).get("perps_close")!;
  const res = await tool.execute(
    ctx,
    { market: "SOL-PERP", fractionBps: 2_500 },
    { idempotencyKey: "k" },
  );
  assert.equal(
    proposalOf(res.data).intent.perp.expectedBaseAmount,
    250_000_000n,
  );
});

test("perps_close with nothing open refuses before it builds anything", async () => {
  const venue = new FakePerpsVenue({ positions: [] });
  const tool = createPerpsTools(makeDeps(venue)).get("perps_close")!;
  try {
    await tool.execute(ctx, { market: "SOL-PERP" }, { idempotencyKey: "k" });
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(isPerpGuardError(err));
    assert.equal(err.perpCode, "NO_POSITION");
  }
});

test("perps_close still works while the kill switch is engaged — the agent can always propose getting flat", async () => {
  const venue = new FakePerpsVenue({ positions: [fakePosition()] });
  const deps = makeDeps(venue, testPolicy({ windDownOnly: true }), {
    killSwitch: () => true,
  });
  const res = await createPerpsTools(deps)
    .get("perps_close")!
    .execute(ctx, { market: "SOL-PERP" }, { idempotencyKey: "k" });
  assert.equal(res.isError, false);
  assert.equal(proposalOf(res.data).verdict.ok, true);
});

test("perps_adjust increases with the position and reduces against it", async () => {
  const venue = new FakePerpsVenue({
    positions: [fakePosition({ side: "long" })],
  });
  const tool = createPerpsTools(makeDeps(venue)).get("perps_adjust")!;

  const inc = await tool.execute(
    ctx,
    {
      market: "SOL-PERP",
      direction: "increase",
      baseUi: 0.5,
      collateralUi: 25,
      leverage: 3,
    },
    { idempotencyKey: "k" },
  );
  const incIntent = proposalOf(inc.data).intent;
  assert.equal(incIntent.kind, "perp_increase");
  assert.equal(incIntent.perp.side, "long");
  assert.equal(incIntent.perp.reduceOnly, false);
  assert.equal(incIntent.input.amount, 25_000_000n);
  assert.equal(inc.isError, false);

  const red = await tool.execute(
    ctx,
    { market: "SOL-PERP", direction: "reduce", baseUi: 0.5 },
    { idempotencyKey: "k" },
  );
  const redIntent = proposalOf(red.data).intent;
  assert.equal(redIntent.kind, "perp_reduce");
  assert.equal(redIntent.perp.side, "short");
  assert.equal(redIntent.perp.reduceOnly, true);
  assert.equal(redIntent.input.amount, 0n);
  assert.equal(red.isError, false);
});

test("perps_adjust rejects an increase that omits margin or leverage, at the schema level", () => {
  const tool = createPerpsTools(makeDeps(new FakePerpsVenue())).get(
    "perps_adjust",
  )!;
  assert.equal(
    tool.configSchema.safeParse({
      market: "SOL-PERP",
      direction: "increase",
      baseUi: 1,
    }).success,
    false,
  );
  assert.equal(
    tool.configSchema.safeParse({
      market: "SOL-PERP",
      direction: "reduce",
      baseUi: 1,
    }).success,
    true,
  );
});

// ── fail-closed plumbing ─────────────────────────────────────────────────────

class BrokenPositionsVenue extends FakePerpsVenue {
  override async getPositions(
    _account: PerpAccountRef,
  ): Promise<readonly PerpPosition[]> {
    throw new Error("rpc timeout");
  }
}

test("an unreadable position list becomes a STALE exposure, and the open is refused", async () => {
  const venue = new BrokenPositionsVenue();
  const tool = createPerpsTools(makeDeps(venue)).get("perps_open")!;
  const res = await tool.execute(
    ctx,
    { market: "SOL-PERP", side: "long", collateralUi: 50, leverage: 3 },
    { idempotencyKey: "k" },
  );
  assert.equal(res.isError, true);
  const codes = proposalOf(res.data).verdict.violations.map((v) => v.code);
  assert.ok(
    codes.includes("EXPOSURE_UNKNOWN"),
    `expected EXPOSURE_UNKNOWN, got ${codes.join(", ")}`,
  );
});

test('a funding outage is carried as "unknown" and refuses the open', async () => {
  const venue = new FakePerpsVenue({ funding: null });
  const tool = createPerpsTools(makeDeps(venue)).get("perps_open")!;
  const res = await tool.execute(
    ctx,
    { market: "SOL-PERP", side: "long", collateralUi: 50, leverage: 3 },
    { idempotencyKey: "k" },
  );
  assert.equal(res.isError, true);
  const proposal = proposalOf(res.data);
  assert.ok(
    proposal.verdict.violations.some((v) => v.code === "FUNDING_RATE_UNKNOWN"),
  );
  assert.ok(
    proposal.warnings.some((w) => w.includes("funding rate unavailable")),
  );
});

test("the tools always read the CURRENT policy, not a snapshot from construction", async () => {
  const venue = new FakePerpsVenue();
  let policy = testPolicy();
  const tools = createPerpsTools(
    makeDeps(venue, policy, { policy: () => policy }),
  );
  const cfg = {
    market: "SOL-PERP",
    side: "long" as const,
    collateralUi: 50,
    leverage: 3,
  };

  const before = await tools
    .get("perps_open")!
    .execute(ctx, cfg, { idempotencyKey: "k" });
  assert.equal(before.isError, false);

  policy = testPolicy({ windDownOnly: true });
  const after = await tools
    .get("perps_open")!
    .execute(ctx, cfg, { idempotencyKey: "k" });
  assert.equal(
    after.isError,
    true,
    "a policy change must take effect without rebuilding the toolset",
  );
  assert.ok(
    proposalOf(after.data).verdict.violations.some(
      (v) => v.code === "WIND_DOWN_ONLY",
    ),
  );
});

// ── registry shape ───────────────────────────────────────────────────────────

test("the toolset exposes exactly the five perps tools, correctly classified", () => {
  const tools = createPerpsTools(makeDeps(new FakePerpsVenue()));
  assert.deepEqual(tools.all.map((t) => t.name).sort(), [
    "perps_adjust",
    "perps_close",
    "perps_markets",
    "perps_open",
    "perps_positions",
  ]);
  for (const t of tools.all) assert.equal(t.category, "perps");

  // Reads carry no value-moving capability; proposals declare the full ceremony
  // even though they execute nothing — under-declaring is the dangerous direction.
  for (const t of tools.reads)
    assert.equal(movesValue(t.capabilities), false, t.name);
  for (const t of tools.proposals) {
    assert.equal(movesValue(t.capabilities), true, t.name);
    assert.equal(
      t.execPolicy.retries,
      0,
      `${t.name} must not retry a value-moving proposal`,
    );
    assert.equal(t.execPolicy.idempotent, false, t.name);
  }
  assert.equal(tools.get("nope"), undefined);
});

test("THE INVARIANT: no perps tool ever reached the trade gateway", () => {
  assert.equal(
    spy.calls,
    0,
    "a perps tool called TradeGateway.execute() — the model must never be able to move money",
  );
});
