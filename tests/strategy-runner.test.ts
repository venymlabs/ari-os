/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: `node:test` +
 * `node:assert/strict` replaced with vitest, `SwapRequest` replaced with the
 * locally-declared `StrategySwap`, and the chokepoint cases (the whole
 * `gatewayExecutor` block below) are NEW — Aetheria's runner called an
 * engine-level swap and there was nothing to assert about the money path.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  gatewayExecutor,
  STRATEGY_SOURCE,
  StrategyRunner,
  StrategyStore,
  strategyView,
  type StrategyKind,
  type StrategySwap,
} from "../src/strategy/index.js";
import type {
  ExecuteOptions,
  ExecuteResult,
  JupiterClient,
  SolanaReader,
  TradeIntent,
} from "../src/kernel/contracts.js";
import { SOL_DECIMALS, WSOL_MINT } from "../src/kernel/money.js";

const TOKEN = "BonkMint11111111111111111111111111111111111";
const OWNER = "OwnerPubkey1111111111111111111111111111111";

interface Captured {
  reqs: StrategySwap[];
}

function makeRunner(
  opts: { ok?: boolean; price?: () => number | undefined } = {},
) {
  const store = new StrategyStore(":memory:");
  const cap: Captured = { reqs: [] };
  const runner = new StrategyRunner(
    store,
    {
      swap: async (req) => {
        cap.reqs.push(req);
        return opts.ok === false
          ? { ok: false, text: "boom" }
          : { ok: true, text: "ok", signature: "sig" };
      },
      ...(opts.price ? { price: async () => opts.price?.() } : {}),
    },
    10_000,
  );
  return { store, runner, cap };
}

function create(
  store: StrategyStore,
  kind: StrategyKind,
  params: Record<string, unknown>,
) {
  return store.create(1, kind, params, Date.now());
}

/** Force a strategy due again so a follow-up tick processes it. */
function forceDue(store: StrategyStore, id: string): void {
  const row = store.get(id);
  if (!row) throw new Error(`no strategy ${id}`);
  row.nextRunAt = Date.now() - 1000;
  store.save(row);
}

describe("strategy runner", () => {
  it("DCA buys each step and completes when the budget is spent", async () => {
    const { store, runner, cap } = makeRunner();
    const s = create(store, "dca", {
      token: TOKEN,
      amountUiPerStep: 0.1,
      totalBudgetUi: 0.3,
      spentUi: 0,
      intervalSec: 15,
    });

    for (let i = 0; i < 5; i++) {
      forceDue(store, s.id);
      await runner.tick();
    }

    expect(cap.reqs).toHaveLength(3); // exactly 3 buys of 0.1 to spend 0.3
    expect(
      cap.reqs.every(
        (r) =>
          r.kind === "buy" &&
          r.inputMint === WSOL_MINT &&
          r.outputMint === TOKEN,
      ),
    ).toBe(true);
    expect(store.get(s.id)?.status).toBe("done");
    store.close();
  });

  it("TWAP fires `slices` times then completes", async () => {
    const { store, runner, cap } = makeRunner();
    const s = create(store, "twap", {
      token: TOKEN,
      totalUi: 0.6,
      slices: 3,
      doneSlices: 0,
      side: "buy",
      intervalSec: 15,
    });

    for (let i = 0; i < 5; i++) {
      forceDue(store, s.id);
      await runner.tick();
    }

    expect(cap.reqs).toHaveLength(3);
    expect(cap.reqs.every((r) => Math.abs(r.amountUi - 0.2) < 1e-9)).toBe(true);
    expect(store.get(s.id)?.status).toBe("done");
    store.close();
  });

  it("trailing_stop only sells once price falls through the trailing peak", async () => {
    let px = 1.0;
    const { store, runner, cap } = makeRunner({ price: () => px });
    const s = create(store, "trailing_stop", {
      token: TOKEN,
      dropPct: 10,
      sizeUi: 5,
      intervalSec: 15,
    });

    forceDue(store, s.id);
    await runner.tick(); // px 1.0, peak 1.0 → no sell
    expect(cap.reqs).toHaveLength(0);

    px = 0.85; // 15% below the 1.0 peak → sell
    forceDue(store, s.id);
    await runner.tick();
    expect(cap.reqs).toHaveLength(1);
    expect(cap.reqs[0]?.kind).toBe("sell");
    expect(store.get(s.id)?.status).toBe("done");
    store.close();
  });

  it("take_profit sells once the gain target is hit", async () => {
    let px = 1.0;
    const { store, runner, cap } = makeRunner({ price: () => px });
    const s = create(store, "take_profit", {
      token: TOKEN,
      gainPct: 50,
      sizeUi: 3,
      entryPrice: 1.0,
      intervalSec: 15,
    });

    forceDue(store, s.id);
    await runner.tick(); // +0% → hold
    expect(cap.reqs).toHaveLength(0);

    px = 1.6; // +60% ≥ +50% → sell
    forceDue(store, s.id);
    await runner.tick();
    expect(cap.reqs).toHaveLength(1);
    expect(cap.reqs[0]?.kind).toBe("sell");
    store.close();
  });

  it("skips a price-triggered strategy when no price source is mounted", async () => {
    const { store, runner, cap } = makeRunner(); // no price fn
    const s = create(store, "trailing_stop", {
      token: TOKEN,
      dropPct: 10,
      sizeUi: 5,
      intervalSec: 15,
    });
    forceDue(store, s.id);
    await runner.tick();
    // Skipped, not guessed: an unpriced stop must never fire on fiction.
    expect(cap.reqs).toHaveLength(0);
    expect(store.get(s.id)?.status).toBe("active");
    store.close();
  });

  it("auto-pauses a strategy after repeated execution errors", async () => {
    const { store, runner } = makeRunner({ ok: false });
    const s = create(store, "dca", {
      token: TOKEN,
      amountUiPerStep: 0.1,
      totalBudgetUi: 1,
      spentUi: 0,
      intervalSec: 15,
    });

    for (let i = 0; i < 3; i++) {
      forceDue(store, s.id);
      await runner.tick();
    }
    expect(store.get(s.id)?.status).toBe("paused");
    store.close();
  });

  it("derives a replay-safe idempotency key from the strategy and its run count", async () => {
    const store = new StrategyStore(":memory:");
    const keys: string[] = [];
    const runner = new StrategyRunner(store, {
      swap: async (_req, key) => {
        keys.push(key);
        return { ok: true, text: "ok" };
      },
    });
    const s = create(store, "twap", {
      token: TOKEN,
      totalUi: 0.4,
      slices: 2,
      intervalSec: 15,
    });
    for (let i = 0; i < 2; i++) {
      forceDue(store, s.id);
      await runner.tick();
    }
    expect(keys).toEqual([`strat_${s.id}_0`, `strat_${s.id}_1`]);
    store.close();
  });
});

describe("strategy store", () => {
  it("reports whether a status change hit a row (node:sqlite changes is a bigint)", () => {
    const store = new StrategyStore(":memory:");
    const s = create(store, "dca", { token: TOKEN, amountUiPerStep: 0.1 });
    expect(store.setStatus(s.id, "paused")).toBe(true);
    expect(store.get(s.id)?.status).toBe("paused");
    expect(store.setStatus("no-such-id", "paused")).toBe(false);
    store.close();
  });

  it("survives a params blob it cannot parse", () => {
    const store = new StrategyStore(":memory:");
    const s = create(store, "dca", { token: TOKEN });
    const row = store.get(s.id);
    expect(row).toBeDefined();
    expect(row?.params.token).toBe(TOKEN);
    store.close();
  });

  it("projects a row onto the console's strategy view", () => {
    const store = new StrategyStore(":memory:");
    const s = create(store, "twap", {
      token: TOKEN,
      totalUi: 0.6,
      slices: 3,
      doneSlices: 1,
      side: "buy",
    });
    const view = strategyView(store.get(s.id)!);
    expect(view.kind).toBe("twap");
    expect(view.progress).toEqual({ done: 1, total: 3 });
    // No price reading has been taken, so there is no trigger to report.
    expect(view.trigger).toBeNull();
    expect(view.label).toContain("TWAP");
    store.close();
  });

  it("reports no budget meter when a DCA has no budget", () => {
    const store = new StrategyStore(":memory:");
    const s = create(store, "dca", { token: TOKEN, amountUiPerStep: 0.1 });
    expect(strategyView(store.get(s.id)!).budget).toBeNull();
    store.close();
  });
});

// ── The chokepoint ──────────────────────────────────────────────────────────

const QUOTE = {
  inputMint: WSOL_MINT,
  outputMint: TOKEN,
  inAmount: 100_000_000n,
  outAmount: 4_200n,
  otherAmountThreshold: 4_100n,
  priceImpactPct: 0.4,
  slippageBps: 100,
  routeLabel: "Raydium",
  contextSlot: 12345,
  raw: null,
};

function fakeJupiter(): JupiterClient {
  return {
    quote: async () => QUOTE,
    buildSwap: async () => ({
      swapTransactionB64: "AQID",
      recentBlockhash: "BlockHash1111111111111111111111111111111111",
      lastValidBlockHeight: 999,
      prioritizationFeeLamports: 200_000,
    }),
  };
}

function fakeSolana(decimals = 6): SolanaReader {
  return {
    getSolLamports: async () => 0n,
    getTokenHoldings: async () => [],
    getMintInfo: async (mint: string) => ({
      mint,
      decimals,
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      isToken2022: false,
      freezeAuthority: null,
      mintAuthority: null,
    }),
  };
}

/** A gateway that records every intent and refuses to move anything. */
function recordingGateway(intents: TradeIntent[]) {
  return {
    execute: async (
      intent: TradeIntent,
      opts: ExecuteOptions,
    ): Promise<ExecuteResult> => {
      intents.push(intent);
      return {
        tradeId: "t1",
        state: "confirmed",
        signature: "sig",
        simulated: false,
        summary: `executed via gateway with key ${opts.idempotencyKey}`,
        fill: undefined,
        error: undefined,
      };
    },
  };
}

describe("strategies reach value only through TradeGateway", () => {
  it("turns a scheduled swap into a TradeIntent handed to gateway.execute", async () => {
    const intents: TradeIntent[] = [];
    const exec = gatewayExecutor({
      gateway: recordingGateway(intents),
      jupiter: fakeJupiter(),
      solana: fakeSolana(),
      ownerWallet: OWNER,
      pinnedMints: () => [WSOL_MINT, TOKEN],
    });

    const store = new StrategyStore(":memory:");
    const runner = new StrategyRunner(store, exec);
    const s = create(store, "dca", {
      token: TOKEN,
      amountUiPerStep: 0.1,
      totalBudgetUi: 0.1,
      intervalSec: 15,
    });
    forceDue(store, s.id);
    await runner.tick();

    // ONE call, through the one chokepoint, carrying a real intent.
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.kind).toBe("swap");
    expect(intent.source).toBe(STRATEGY_SOURCE);
    // The input leg — what leaves the wallet — is what the caps bind to.
    expect(intent.input.mint).toBe(WSOL_MINT);
    expect(intent.input.decimals).toBe(SOL_DECIMALS);
    expect(intent.input.amount).toBe(100_000_000n); // 0.1 SOL
    expect(intent.output.mint).toBe(TOKEN);
    expect(intent.quote.minOutAmount).toBe(QUOTE.otherAmountThreshold);
    expect(intent.unsignedTxBase64).toBe("AQID");
    store.close();
  });

  it("never asserts confirmedByUser on the operator's behalf", async () => {
    const seen: ExecuteOptions[] = [];
    const exec = gatewayExecutor({
      gateway: {
        execute: async (_i, opts) => {
          seen.push(opts);
          return {
            tradeId: "t",
            state: "confirmed",
            signature: undefined,
            simulated: false,
            summary: "ok",
            fill: undefined,
            error: undefined,
          };
        },
      },
      jupiter: fakeJupiter(),
      solana: fakeSolana(),
      ownerWallet: OWNER,
    });
    await exec.swap(
      {
        kind: "buy",
        amountUi: 0.1,
        inputMint: WSOL_MINT,
        outputMint: TOKEN,
        slippageBps: undefined,
      },
      "key-1",
    );
    expect(seen).toHaveLength(1);
    // Nobody pressed Confirm, so the flag that means "a human did" is unset.
    expect(seen[0]?.confirmedByUser).toBeUndefined();
    expect(seen[0]?.idempotencyKey).toBe("key-1");
  });

  it("marks an unpinned mint untrusted, so the kernel refuses it", async () => {
    const intents: TradeIntent[] = [];
    const exec = gatewayExecutor({
      gateway: recordingGateway(intents),
      jupiter: fakeJupiter(),
      solana: fakeSolana(),
      ownerWallet: OWNER,
      pinnedMints: () => null, // no allowlist configured
    });
    await exec.swap(
      {
        kind: "buy",
        amountUi: 0.1,
        inputMint: WSOL_MINT,
        outputMint: TOKEN,
        slippageBps: undefined,
      },
      "key-2",
    );
    expect(intents[0]?.inputProvenance).toBe("user"); // WSOL is a quote asset
    expect(intents[0]?.outputProvenance).toBe("untrusted");
  });

  it("surfaces a gateway refusal as a non-throwing failure the breaker counts", async () => {
    const exec = gatewayExecutor({
      gateway: {
        execute: async () => ({
          tradeId: "t",
          state: "rejected",
          signature: undefined,
          simulated: false,
          summary: "refused",
          fill: undefined,
          error: { code: "CAP_EXCEEDED", message: "daily cap reached" },
        }),
      },
      jupiter: fakeJupiter(),
      solana: fakeSolana(),
      ownerWallet: OWNER,
    });
    const out = await exec.swap(
      {
        kind: "buy",
        amountUi: 0.1,
        inputMint: WSOL_MINT,
        outputMint: TOKEN,
        slippageBps: undefined,
      },
      "key-3",
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("CAP_EXCEEDED");
  });

  it("refuses a non-positive or sub-base-unit slice before it reaches the gateway", async () => {
    const intents: TradeIntent[] = [];
    const exec = gatewayExecutor({
      gateway: recordingGateway(intents),
      jupiter: fakeJupiter(),
      solana: fakeSolana(),
      ownerWallet: OWNER,
    });
    const zero = await exec.swap(
      {
        kind: "buy",
        amountUi: 0,
        inputMint: WSOL_MINT,
        outputMint: TOKEN,
        slippageBps: undefined,
      },
      "key-4",
    );
    expect(zero.ok).toBe(false);
    expect(zero.text).toMatch(/must be positive/i);
    expect(intents).toHaveLength(0);
  });

  it("has no execution path of its own: gatewayExecutor is the only swap route", async () => {
    // A structural assertion, deliberately blunt. If someone adds a signer, a
    // broadcaster or an RPC write to the strategy directory, this fails.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const files = [
      "runner.ts",
      "executor.ts",
      "store.ts",
      "view.ts",
      "index.ts",
    ];
    for (const file of files) {
      const src = await readFile(
        join(process.cwd(), "src", "strategy", file),
        "utf8",
      );
      expect(src).not.toMatch(/\bsendTransaction\b|\bbroadcast\w*\(/);
      expect(src).not.toMatch(/\bKeypair\b|\bsign\s*\(/);
      // Only the executor may name the gateway at all.
      if (file !== "executor.ts" && file !== "index.ts")
        expect(src).not.toMatch(/gateway\.execute/);
    }
    const executor = await readFile(
      join(process.cwd(), "src", "strategy", "executor.ts"),
      "utf8",
    );
    // Exactly one real call site (prose mentions of `gateway.execute()` in the
    // doc comments are not prefixed with `deps.`).
    expect(executor.match(/deps\.gateway\.execute\(/g) ?? []).toHaveLength(1);
  });
});
