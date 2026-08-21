/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "../src/chains/solana/spl.js";
import { newIdempotencyKey } from "../src/kernel/ids.js";
import { SOL_DECIMALS, WSOL_MINT, toBaseUnits } from "../src/kernel/money.js";
import type { RugHeat } from "../src/pools/signals.js";
import { isPoolGuardError, type PoolGuardCode } from "../src/pools/errors.js";
import { defaultPoolGuardConfig } from "../src/pools/guards.js";
import { MeteoraDataApi } from "../src/pools/meteora/dlmm-api.js";
import {
  MeteoraDlmmVenue,
  summaryFromApi,
} from "../src/pools/meteora/venue.js";
import type {
  SdkPoolState,
  SdkPosition,
} from "../src/pools/meteora/sdk-port.js";
import { PumpFunClient } from "../src/pools/pumpfun/client.js";
import {
  bondingCurvePda,
  feeConfigPda,
  globalPda,
} from "../src/pools/pumpfun/curve.js";
import { defaultRebalancePolicy } from "../src/pools/rebalance/decide.js";
import { RebalanceLedger } from "../src/pools/rebalance/ledger.js";
import {
  cleanMintInfo,
  curveAccountBuffer,
  FakeChainReader,
  FakeDlmmSdk,
  fakeToolContext,
  globalAccountBuffer,
  mintAccountBuffer,
} from "../src/pools/testing.js";
import {
  makePoolsTools,
  POOL_TOOL_NAMES,
} from "../src/pools/tools/registry.js";

const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const POSITION = "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq";
const CLEAN: RugHeat = {
  score: 10,
  reasons: ["no strong rug tells in window"],
};

function poolState(over: Partial<SdkPoolState> = {}): SdkPoolState {
  return {
    address: POOL,
    binStep: 25,
    activeBinId: 1_000,
    tokenXMint: TOKEN,
    tokenXDecimals: 6,
    tokenXProgramId: TOKEN_PROGRAM_ID.toBase58(),
    tokenYMint: WSOL_MINT,
    tokenYDecimals: SOL_DECIMALS,
    tokenYProgramId: TOKEN_PROGRAM_ID.toBase58(),
    baseFeeBps: 25,
    reserveX: 1_000_000_000_000n,
    reserveY: toBaseUnits(500, SOL_DECIMALS),
    ...over,
  };
}

function sdkPosition(over: Partial<SdkPosition> = {}): SdkPosition {
  return {
    publicKey: POSITION,
    owner: OWNER,
    lowerBinId: 990,
    upperBinId: 1_010,
    totalXAmount: 0n,
    totalYAmount: toBaseUnits(1, SOL_DECIMALS),
    feeX: 0n,
    feeY: toBaseUnits(0.01, SOL_DECIMALS),
    lastUpdatedAt: undefined,
    ...over,
  };
}

interface HarnessOptions {
  poolState?: Partial<SdkPoolState>;
  positions?: readonly SdkPosition[];
  requireExtraSignerOnNewPosition?: boolean;
  curve?: Parameters<typeof curveAccountBuffer>[0] | null;
  rugHeat?: RugHeat | null;
  guards?: Partial<ReturnType<typeof defaultPoolGuardConfig>>;
  rebalancePolicy?: Partial<ReturnType<typeof defaultRebalancePolicy>>;
  tokenBalance?: bigint;
  now?: number;
  /** Wire a stub data API so the rebalancer has a fee-APR to project from. */
  feeApr24hPct?: number;
}

function harness(opts: HarnessOptions = {}) {
  const chain = new FakeChainReader();
  const sdk = new FakeDlmmSdk();
  sdk.addPool({
    state: poolState(opts.poolState),
    positions: opts.positions ?? [],
    requireExtraSignerOnNewPosition: opts.requireExtraSignerOnNewPosition,
  });

  if (opts.curve !== null) {
    const mint = TOKEN;
    chain.set(
      bondingCurvePda(new PublicKey(mint)).toBase58(),
      curveAccountBuffer(opts.curve ?? {}),
    );
    chain.set(globalPda().toBase58(), globalAccountBuffer());
    chain.set(mint, mintAccountBuffer(6));
  }
  chain.setBalance(OWNER, TOKEN, opts.tokenBalance ?? 0n);

  const api =
    opts.feeApr24hPct === undefined
      ? undefined
      : new MeteoraDataApi({
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({
                address: POOL,
                name: "BONK-SOL",
                token_x: { address: TOKEN, decimals: 6 },
                token_y: { address: WSOL_MINT, decimals: 9 },
                pool_config: { bin_step: 25, base_fee_pct: 0.25 },
                apr: opts.feeApr24hPct,
                fees: { "24h": 1_000 },
                volume: { "24h": 500_000 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch,
        });

  const venue = new MeteoraDlmmVenue({ sdk, chain, ...(api ? { api } : {}) });
  const toolset = makePoolsTools({
    venue,
    curve: new PumpFunClient(chain),
    chain,
    guards: { ...defaultPoolGuardConfig(), ...opts.guards },
    rebalancePolicy: { ...defaultRebalancePolicy(), ...opts.rebalancePolicy },
    ledger: new RebalanceLedger(),
    signals:
      opts.rugHeat === null
        ? undefined
        : { rugHeatScore: () => opts.rugHeat ?? CLEAN },
    now: () => opts.now ?? 1_700_000_000_000,
  });

  const ctx = fakeToolContext({
    ownerWallet: OWNER,
    mints: {
      [TOKEN]: cleanMintInfo(TOKEN, 6),
      [WSOL_MINT]: cleanMintInfo(WSOL_MINT, 9),
    },
  });
  return { chain, sdk, venue, toolset, ctx };
}

async function expectRefusal(
  fn: () => Promise<unknown>,
  code: PoolGuardCode,
): Promise<void> {
  try {
    await fn();
    assert.fail(`expected ${code}, but the call succeeded`);
  } catch (e) {
    assert.ok(
      isPoolGuardError(e),
      `expected a PoolGuardError, got ${String(e)}`,
    );
    assert.equal(e.code, code, e.message);
  }
}

// ── registry ─────────────────────────────────────────────────────────────────

test("the toolset exposes exactly the documented eight tools, reads before spends", () => {
  const { toolset } = harness();
  assert.deepEqual(
    toolset.tools.map((t) => t.name),
    [...POOL_TOOL_NAMES],
  );
  const firstSpend = toolset.tools.findIndex((t) =>
    t.capabilities.includes("spend"),
  );
  const lastRead = toolset.tools
    .map((t) => t.capabilities.includes("spend"))
    .lastIndexOf(false);
  assert.ok(
    lastRead < firstSpend,
    "read tools must all precede the spend tools",
  );
});

test("every spend tool declares sign+spend, zero retries, and non-idempotent execution", () => {
  const { toolset } = harness();
  for (const t of toolset.tools.filter((x) =>
    x.capabilities.includes("spend"),
  )) {
    assert.ok(t.capabilities.includes("sign"), t.name);
    assert.equal(t.execPolicy.retries, 0, t.name);
    assert.equal(t.execPolicy.idempotent, false, t.name);
  }
});

// ── pools_position ───────────────────────────────────────────────────────────

test("pools_position reports the range and flags an out-of-range position", async () => {
  const { toolset, ctx } = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_500 },
  });
  const r = await toolset
    .get("pools_position")!
    .execute(ctx, {}, { idempotencyKey: newIdempotencyKey() });
  assert.equal(r.isError, false);
  assert.match(r.text, /OUT OF RANGE/);
  assert.match(r.text, /bins 990\.\.1010/);
});

test("pools_position says so plainly when there is nothing open", async () => {
  const { toolset, ctx } = harness();
  const r = await toolset
    .get("pools_position")!
    .execute(ctx, {}, { idempotencyKey: newIdempotencyKey() });
  assert.match(r.text, /No open liquidity positions/);
});

// ── pools_open ───────────────────────────────────────────────────────────────

test("opening a NEW DLMM position is refused: it needs a signer the kernel will not provide", async () => {
  const { toolset, ctx } = harness({ requireExtraSignerOnNewPosition: true });
  await expectRefusal(
    () =>
      toolset
        .get("pools_open")!
        .simulate(ctx, { poolAddress: POOL, quoteAmountUi: 0.2 }),
    "POOL_EXTRA_SIGNER",
  );
});

test("adding to an existing position builds a real, unsigned, single-signer intent", async () => {
  const { toolset, ctx } = harness({ positions: [sdkPosition()] });
  const preview = await toolset.get("pools_open")!.simulate(ctx, {
    poolAddress: POOL,
    quoteAmountUi: 0.2,
    positionAddress: POSITION,
  });
  const intent = preview.intent;
  assert.ok(
    intent,
    "a preview must carry the exact intent the kernel would see",
  );
  assert.equal(
    intent.kind,
    "lp_add",
    "the journal records the real action, not a flattened swap",
  );
  assert.equal(intent.source, "pools_open");
  assert.equal(
    intent.input.mint,
    WSOL_MINT,
    "the quote leg is what the kernel caps",
  );
  assert.equal(intent.input.amount, toBaseUnits(0.2, SOL_DECIMALS));
  assert.equal(intent.output.mint, TOKEN);
  // Nothing lands in spot balance, so out and min-out are both zero and consistent.
  assert.equal(intent.quote.outAmount, 0n);
  assert.equal(intent.quote.minOutAmount, 0n);

  const tx = VersionedTransaction.deserialize(
    Buffer.from(intent.unsignedTxBase64, "base64"),
  );
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(
    tx.signatures.every((s) => s.every((b) => b === 0)),
    "the tool must not sign",
  );
  assert.equal(tx.message.recentBlockhash, intent.recentBlockhash);
});

test("pools_open hands the intent to the gateway and nowhere else", async () => {
  const { toolset, ctx } = harness({ positions: [sdkPosition()] });
  const key = newIdempotencyKey();
  const r = await toolset
    .get("pools_open")!
    .execute(
      ctx,
      { poolAddress: POOL, quoteAmountUi: 0.2, positionAddress: POSITION },
      { idempotencyKey: key, confirmedByUser: true },
    );
  assert.equal(r.isError, false);
  assert.equal(ctx.gateway.executions.length, 1);
  assert.equal(ctx.gateway.executions[0]?.idempotencyKey, key);
  assert.equal(ctx.gateway.executions[0]?.confirmedByUser, true);
  assert.equal(ctx.gateway.executions[0]?.intent.source, "pools_open");
});

test("pools_open is gated by every guard before a transaction is ever built", async () => {
  const overSpend = harness({ positions: [sdkPosition()] });
  await expectRefusal(
    () =>
      overSpend.toolset.get("pools_open")!.simulate(overSpend.ctx, {
        poolAddress: POOL,
        quoteAmountUi: 5,
        positionAddress: POSITION,
      }),
    "POOL_SPEND_CAP",
  );

  const hot = harness({
    positions: [sdkPosition()],
    rugHeat: { score: 90, reasons: ["dump"] },
  });
  await expectRefusal(
    () =>
      hot.toolset.get("pools_open")!.simulate(hot.ctx, {
        poolAddress: POOL,
        quoteAmountUi: 0.2,
        positionAddress: POSITION,
      }),
    "POOL_RUG_HEAT",
  );

  const noSignals = harness({ positions: [sdkPosition()], rugHeat: null });
  await expectRefusal(
    () =>
      noSignals.toolset.get("pools_open")!.simulate(noSignals.ctx, {
        poolAddress: POOL,
        quoteAmountUi: 0.2,
        positionAddress: POSITION,
      }),
    "POOL_RUG_HEAT",
  );

  const thin = harness({
    positions: [sdkPosition()],
    poolState: { reserveY: toBaseUnits(1, SOL_DECIMALS) },
  });
  await expectRefusal(
    () =>
      thin.toolset.get("pools_open")!.simulate(thin.ctx, {
        poolAddress: POOL,
        quoteAmountUi: 0.2,
        positionAddress: POSITION,
      }),
    "POOL_LIQUIDITY_FLOOR",
  );
});

test("a two-sided deposit is bounded by holdings and warns that the kernel only caps one leg", async () => {
  const ok = harness({
    positions: [sdkPosition()],
    tokenBalance: 1_000_000_000n,
  });
  const preview = await ok.toolset.get("pools_open")!.simulate(ok.ctx, {
    poolAddress: POOL,
    quoteAmountUi: 0.2,
    baseAmountUi: 100, // 100e6 base units = 10% of holdings
    positionAddress: POSITION,
  });
  assert.ok(preview.warnings.some((w) => /two-sided/.test(w)));

  const tooBig = harness({
    positions: [sdkPosition()],
    tokenBalance: 1_000_000_000n,
  });
  await expectRefusal(
    () =>
      tooBig.toolset.get("pools_open")!.simulate(tooBig.ctx, {
        poolAddress: POOL,
        quoteAmountUi: 0.2,
        baseAmountUi: 500, // 50% of holdings, above the 25% default
        positionAddress: POSITION,
      }),
    "POOL_BASE_LEG_CAP",
  );
});

// ── pools_close ──────────────────────────────────────────────────────────────

test("pools_close declares the transaction cost as its input leg, not a fake spend", async () => {
  const { toolset, ctx } = harness({ positions: [sdkPosition()] });
  const preview = await toolset
    .get("pools_close")!
    .simulate(ctx, { poolAddress: POOL, positionAddress: POSITION });
  const intent = preview.intent;
  assert.ok(intent);
  assert.equal(intent.input.mint, WSOL_MINT);
  // priority fee + one signature's base fee — small, positive, and bounded.
  assert.ok(intent.input.amount > 0n);
  assert.ok(
    intent.input.amount < toBaseUnits(0.01, SOL_DECIMALS),
    `input leg ${intent.input.amount} is too large for a withdraw`,
  );
  assert.ok(preview.warnings.some((w) => /transaction cost/.test(w)));
});

test("pools_close refuses a position this wallet does not own", async () => {
  const { toolset, ctx } = harness({
    positions: [
      sdkPosition({ owner: "SomebodyElse111111111111111111111111111111" }),
    ],
  });
  await expectRefusal(
    () =>
      toolset
        .get("pools_close")!
        .simulate(ctx, { poolAddress: POOL, positionAddress: POSITION }),
    "POOL_VENUE_ERROR",
  );
});

// ── pools_rebalance ──────────────────────────────────────────────────────────

test("pools_rebalance holds a centred position and builds nothing", async () => {
  const { toolset, ctx } = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_000 },
  });
  const preview = await toolset
    .get("pools_rebalance")!
    .simulate(ctx, { poolAddress: POOL, positionAddress: POSITION });
  assert.equal(
    preview.intent,
    undefined,
    "a hold must not produce a spendable intent",
  );
  assert.match(preview.summary, /Decision: HOLD/);
  assert.match(preview.summary, /REBALANCE_NOT_DRIFTED|comfortably inside/);
});

test("a drifted position produces the exit intent plus the step-2 re-open config", async () => {
  const { toolset, ctx } = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_100 },
    rebalancePolicy: { requireIlRecovery: false },
    feeApr24hPct: 400,
  });
  const preview = await toolset
    .get("pools_rebalance")!
    .simulate(ctx, { poolAddress: POOL, positionAddress: POSITION });
  assert.match(preview.summary, /Decision: REBALANCE/);
  assert.ok(preview.intent, "the exit half must be a real intent");
  assert.equal(preview.intent?.source, "pools_rebalance");
  assert.ok(preview.warnings.some((w) => /EXIT half/.test(w)));
  const data = preview.data as {
    followUp?: { config?: { belowBins?: number; aboveBins?: number } };
  };
  assert.equal(data.followUp?.config?.belowBins, 10);
  assert.equal(data.followUp?.config?.aboveBins, 10);
});

test("dryRun reports the decision without building an exit transaction", async () => {
  const { toolset, ctx } = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_100 },
    rebalancePolicy: { requireIlRecovery: false },
    feeApr24hPct: 400,
  });
  const preview = await toolset.get("pools_rebalance")!.simulate(ctx, {
    poolAddress: POOL,
    positionAddress: POSITION,
    dryRun: true,
  });
  assert.equal(preview.intent, undefined);
  assert.match(preview.summary, /Decision: REBALANCE/);
});

test("executing a rebalance records it, so the daily cap and interval start counting", async () => {
  const h = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_100 },
    rebalancePolicy: { requireIlRecovery: false },
    feeApr24hPct: 400,
  });
  await h.toolset
    .get("pools_rebalance")!
    .execute(
      h.ctx,
      { poolAddress: POOL, positionAddress: POSITION },
      { idempotencyKey: newIdempotencyKey(), confirmedByUser: true },
    );
  assert.equal(h.ctx.gateway.executions.length, 1);
  assert.equal(
    h.toolset.deps.ledger.history(POSITION, 1_700_000_000_000).countInWindow,
    1,
  );

  // Immediately after, the interval brake holds the next attempt.
  const again = await h.toolset
    .get("pools_rebalance")!
    .simulate(h.ctx, { poolAddress: POOL, positionAddress: POSITION });
  assert.match(again.summary, /Decision: HOLD/);
  assert.match(again.summary, /minimum interval/);
});

test("without the data API there is no fee projection, so a drifted position is still held", async () => {
  const { toolset, ctx } = harness({
    positions: [sdkPosition()],
    poolState: { activeBinId: 1_100 },
    rebalancePolicy: { requireIlRecovery: false },
  });
  const preview = await toolset
    .get("pools_rebalance")!
    .simulate(ctx, { poolAddress: POOL, positionAddress: POSITION });
  assert.match(preview.summary, /Decision: HOLD/);
  assert.match(preview.summary, /economic inputs incomplete/);
  assert.equal(preview.intent, undefined);
});

// ── pumpfun_curve ────────────────────────────────────────────────────────────

test("pumpfun_curve reads reserves, fee source, progress and the routing verdict", async () => {
  const { toolset, ctx } = harness();
  const r = await toolset
    .get("pumpfun_curve")!
    .execute(ctx, { mint: TOKEN }, { idempotencyKey: newIdempotencyKey() });
  assert.equal(r.isError, false);
  assert.match(r.text, /route: bonding-curve/);
  assert.match(r.text, /progress /);
  const data = r.data as { curve?: { feeSource?: string; complete?: boolean } };
  // No fee_config account in the fake chain → it falls back to Global's fields.
  assert.equal(data.curve?.feeSource, "global");
  assert.equal(data.curve?.complete, false);
});

test("pumpfun_curve warms the trade tape so the next rug-heat read has data", async () => {
  const watched: string[] = [];
  const chain = new FakeChainReader();
  chain.set(
    bondingCurvePda(new PublicKey(TOKEN)).toBase58(),
    curveAccountBuffer(),
  );
  chain.set(globalPda().toBase58(), globalAccountBuffer());
  chain.set(TOKEN, mintAccountBuffer(6));
  const sdk = new FakeDlmmSdk();
  sdk.addPool({ state: poolState() });
  const toolset = makePoolsTools({
    venue: new MeteoraDlmmVenue({ sdk, chain }),
    curve: new PumpFunClient(chain),
    chain,
    watch: (m) => watched.push(m),
  });
  await toolset
    .get("pumpfun_curve")!
    .execute(
      fakeToolContext(),
      { mint: TOKEN },
      { idempotencyKey: newIdempotencyKey() },
    );
  assert.deepEqual(watched, [TOKEN]);
});

test("a mint with no curve account is reported as Jupiter’s problem, not an error", async () => {
  const { toolset, ctx } = harness({ curve: null });
  const r = await toolset
    .get("pumpfun_curve")!
    .execute(ctx, { mint: TOKEN }, { idempotencyKey: newIdempotencyKey() });
  assert.match(r.text, /no pump\.fun bonding curve/);
});

// ── pumpfun_buy ──────────────────────────────────────────────────────────────

test("a live curve buy produces an exact-token intent whose slippage lives on the input leg", async () => {
  const { toolset, ctx } = harness();
  const preview = await toolset
    .get("pumpfun_buy")!
    .simulate(ctx, { mint: TOKEN, amountUi: 0.1 });
  const intent = preview.intent;
  assert.ok(intent);
  assert.equal(intent.source, "pumpfun_buy");
  assert.equal(intent.input.mint, WSOL_MINT);
  assert.equal(intent.output.mint, TOKEN);
  // The curve commits to an exact token amount, so min-out == out and the kernel's
  // min-out consistency check sees zero implied slippage.
  assert.ok(intent.quote.outAmount > 0n);
  assert.equal(intent.quote.minOutAmount, intent.quote.outAmount);
  // The capped input leg is the WORST case (max_sol_cost), not the nominal budget.
  assert.ok(intent.input.amount >= toBaseUnits(0.1, SOL_DECIMALS));
  assert.equal(intent.quote.slippageBps, 100);

  const tx = VersionedTransaction.deserialize(
    Buffer.from(intent.unsignedTxBase64, "base64"),
  );
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.equal(
    tx.message.compiledInstructions.length,
    4,
    "2 compute-budget + ATA create + buy",
  );
});

test("a migrated curve delegates to swap_jupiter instead of building anything", async () => {
  const { toolset, ctx } = harness({ curve: { complete: true } });
  const r = await toolset
    .get("pumpfun_buy")!
    .execute(
      ctx,
      { mint: TOKEN, amountUi: 0.1 },
      { idempotencyKey: newIdempotencyKey() },
    );
  assert.equal(
    r.isError,
    true,
    "the caller must be redirected, not silently no-opped",
  );
  assert.match(r.text, /swap_jupiter/);
  const data = r.data as {
    delegateTo?: string;
    config?: { inputMint?: string; outputMint?: string; amountUi?: number };
  };
  assert.equal(data.delegateTo, "swap_jupiter");
  assert.equal(data.config?.inputMint, WSOL_MINT);
  assert.equal(data.config?.outputMint, TOKEN);
  assert.equal(data.config?.amountUi, 0.1);
  assert.equal(ctx.gateway.executions.length, 0);
});

test("a curve quoted in a non-SOL asset is refused rather than mis-priced", async () => {
  const { toolset, ctx } = harness({
    curve: { quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  });
  await expectRefusal(
    () =>
      toolset.get("pumpfun_buy")!.simulate(ctx, { mint: TOKEN, amountUi: 0.1 }),
    "POOL_UNSUPPORTED_CURVE",
  );
});

test("a pre-creator-fee curve is refused: creator_vault cannot be derived", async () => {
  const { toolset, ctx } = harness({ curve: { length: 49 } });
  await expectRefusal(
    () =>
      toolset.get("pumpfun_buy")!.simulate(ctx, { mint: TOKEN, amountUi: 0.1 }),
    "POOL_UNSUPPORTED_CURVE",
  );
});

test("a mayhem coin is refused: it needs pump’s buy_v2 account layout", async () => {
  const { toolset, ctx } = harness({ curve: { isMayhemMode: true } });
  await expectRefusal(
    () =>
      toolset.get("pumpfun_buy")!.simulate(ctx, { mint: TOKEN, amountUi: 0.1 }),
    "POOL_UNSUPPORTED_CURVE",
  );
});

test("curve buys respect the spend cap, the liquidity floor and the slippage bound", async () => {
  const big = harness();
  await expectRefusal(
    () =>
      big.toolset
        .get("pumpfun_buy")!
        .simulate(big.ctx, { mint: TOKEN, amountUi: 5 }),
    "POOL_SPEND_CAP",
  );

  const thin = harness({
    curve: { realSolReserves: toBaseUnits(0.5, SOL_DECIMALS) },
  });
  await expectRefusal(
    () =>
      thin.toolset
        .get("pumpfun_buy")!
        .simulate(thin.ctx, { mint: TOKEN, amountUi: 0.1 }),
    "POOL_LIQUIDITY_FLOOR",
  );

  const slippy = harness();
  await expectRefusal(
    () =>
      slippy.toolset.get("pumpfun_buy")!.simulate(slippy.ctx, {
        mint: TOKEN,
        amountUi: 0.1,
        slippageBps: 4_000,
      }),
    "POOL_SLIPPAGE",
  );
});

// ── pumpfun_sell ─────────────────────────────────────────────────────────────

test("a curve sell puts the token on the input leg and SOL min-out on the output", async () => {
  const { toolset, ctx } = harness({ tokenBalance: 1_000_000_000n });
  const preview = await toolset
    .get("pumpfun_sell")!
    .simulate(ctx, { mint: TOKEN, amountUi: 500 });
  const intent = preview.intent;
  assert.ok(intent);
  assert.equal(intent.input.mint, TOKEN);
  assert.equal(intent.input.amount, toBaseUnits(500, 6));
  assert.equal(intent.output.mint, WSOL_MINT);
  assert.ok(intent.quote.minOutAmount > 0n);
  assert.ok(
    intent.quote.minOutAmount < intent.quote.outAmount,
    "min-out must sit below the quote",
  );

  const tx = VersionedTransaction.deserialize(
    Buffer.from(intent.unsignedTxBase64, "base64"),
  );
  assert.equal(
    tx.message.compiledInstructions.length,
    3,
    "2 compute-budget + sell (no ATA create needed)",
  );
});

test("selling by percentage reads the real holding and never exceeds it", async () => {
  const { toolset, ctx } = harness({ tokenBalance: 1_000_000_000n });
  const preview = await toolset
    .get("pumpfun_sell")!
    .simulate(ctx, { mint: TOKEN, percent: 50 });
  assert.equal(preview.intent?.input.amount, 500_000_000n);

  const empty = harness({ tokenBalance: 0n });
  await expectRefusal(
    () =>
      empty.toolset
        .get("pumpfun_sell")!
        .simulate(empty.ctx, { mint: TOKEN, percent: 100 }),
    "POOL_SPEND_CAP",
  );

  const over = harness({ tokenBalance: 100n });
  await expectRefusal(
    () =>
      over.toolset
        .get("pumpfun_sell")!
        .simulate(over.ctx, { mint: TOKEN, amountUi: 500 }),
    "POOL_SPEND_CAP",
  );
});

test("an exit is not blocked by rug-heat — that is exactly when you need out", async () => {
  const { toolset, ctx } = harness({
    tokenBalance: 1_000_000_000n,
    rugHeat: { score: 100, reasons: ["rugging now"] },
  });
  const preview = await toolset
    .get("pumpfun_sell")!
    .simulate(ctx, { mint: TOKEN, percent: 100 });
  assert.ok(preview.intent, "the sell must still build");
});

test("selling a migrated token delegates the whole position size to swap_jupiter", async () => {
  const { toolset, ctx } = harness({
    curve: { complete: true },
    tokenBalance: 1_000_000_000n,
  });
  const r = await toolset
    .get("pumpfun_sell")!
    .execute(
      ctx,
      { mint: TOKEN, percent: 100 },
      { idempotencyKey: newIdempotencyKey() },
    );
  const data = r.data as {
    delegateTo?: string;
    config?: { amountUi?: number; inputMint?: string };
  };
  assert.equal(data.delegateTo, "swap_jupiter");
  assert.equal(data.config?.inputMint, TOKEN);
  assert.equal(data.config?.amountUi, 1_000);
});

// ── data API mapping ─────────────────────────────────────────────────────────

test("a data-API pool maps to a summary with a price-derived active bin", () => {
  const summary = summaryFromApi({
    address: POOL,
    name: "SOL-USDC",
    token_x: { address: WSOL_MINT, decimals: 9, symbol: "SOL" },
    token_y: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      symbol: "USDC",
    },
    token_y_amount: 3_961_943.278287,
    pool_config: { bin_step: 4, base_fee_pct: 0.04 },
    tvl: 5_800_253,
    current_price: 90.18,
    apr: 0.36,
    volume: { "24h": 54_788_127 },
    fees: { "24h": 21_385 },
  });
  assert.equal(summary.baseMint, WSOL_MINT, "token X is the base");
  assert.equal(summary.levelStepBps, 4);
  assert.equal(summary.baseFeeBps, 4, "0.04% → 4bps");
  assert.equal(summary.liquidityQuote, toBaseUnits("3961943.278287", 6));
  assert.ok(
    Math.abs(summary.activePrice - 90.18) / 90.18 < 0.001,
    `derived price ${summary.activePrice}`,
  );
  assert.equal(summary.fees24hUsd, 21_385);
});

test("a data-API pool with no bin step degrades to bin 0 rather than throwing", () => {
  const summary = summaryFromApi({
    address: POOL,
    token_x: { address: TOKEN, decimals: 6 },
    token_y: { address: WSOL_MINT, decimals: 9 },
  });
  assert.equal(summary.activeLevel, 0);
  assert.equal(summary.liquidityQuote, undefined);
});

// ── the pump.fun client's own reads ──────────────────────────────────────────

test("the curve client asks for exactly the four accounts a quote needs", async () => {
  const { chain, toolset, ctx } = harness();
  await toolset
    .get("pumpfun_curve")!
    .execute(ctx, { mint: TOKEN }, { idempotencyKey: newIdempotencyKey() });
  assert.ok(
    chain.calls.includes("getMultipleAccounts:4"),
    chain.calls.join(","),
  );
  // And it derives the fee config under the fee program, not the pump program.
  assert.notEqual(feeConfigPda().toBase58(), globalPda().toBase58());
});
