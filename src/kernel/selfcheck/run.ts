/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt.
 *
 * Modified for ARI OS: the harness now returns a structured report instead of
 * only printing, so the same invariants run both as a script
 * (`node dist/kernel/selfcheck/run.js`) and inside the vitest suite
 * (`tests/kernel-invariants.test.ts`). The invariants themselves are unchanged.
 * SPDX-License-Identifier: Apache-2.0
 */

import { pathToFileURL } from "node:url";
import { systemClock } from "../clock.js";
import type { LandMode, PolicyConfig, TradeIntent } from "../contracts.js";
import { defaultPolicy } from "../defaults.js";
import { newIdempotencyKey, newTradeId } from "../ids.js";
import { WSOL_MINT } from "../money.js";
import { Reconciler } from "../reconciler.js";
import { KernelStore } from "../store.js";
import { TradeGatewayImpl } from "../trade-gateway.js";
import {
  MockBalances,
  MockBroadcaster,
  MockChain,
  MockConfirmer,
  MockMints,
  MockSimulator,
  MockWallet,
} from "./mocks.js";

const BONK = "BonkMint11111111111111111111111111111111111";

export interface SelfcheckCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SelfcheckReport {
  readonly total: number;
  readonly failures: number;
  readonly checks: readonly SelfcheckCheck[];
}

interface EnvOpts {
  policy?: Partial<PolicyConfig>;
  token2022?: string[];
}

function makeEnv(opts: EnvOpts = {}) {
  const chain = new MockChain();
  const store = new KernelStore(":memory:");
  let policy: PolicyConfig = {
    ...defaultPolicy(),
    executionEnabled: true,
    ...opts.policy,
  };
  const broadcaster = new MockBroadcaster(chain);
  const broadcasters: Record<LandMode, MockBroadcaster> = {
    "jupiter-ultra": broadcaster,
    "self-rpc": broadcaster,
  };
  const gateway = new TradeGatewayImpl({
    store,
    wallet: new MockWallet(),
    policy: () => policy,
    mints: new MockMints(opts.token2022),
    balances: new MockBalances(chain),
    simulator: new MockSimulator(chain),
    broadcasters,
    confirmer: new MockConfirmer(chain),
    clock: systemClock,
  });
  return {
    chain,
    store,
    gateway,
    clock: systemClock,
    setPolicy: (p: Partial<PolicyConfig>) => {
      policy = { ...policy, ...p };
    },
  };
}

function swapIntent(o: {
  inputAmount: bigint;
  inputMint?: string;
  outputMint?: string;
  outAmount?: bigint;
  slippageBps?: number;
  priorityFeeLamports?: number;
  inputProvenance?: TradeIntent["inputProvenance"];
  outputProvenance?: TradeIntent["outputProvenance"];
}): TradeIntent {
  const inputMint = o.inputMint ?? WSOL_MINT;
  const outputMint = o.outputMint ?? BONK;
  const outAmount = o.outAmount ?? o.inputAmount * 1000n;
  const slippageBps = o.slippageBps ?? 50;
  const minOutAmount = outAmount - (outAmount * BigInt(slippageBps)) / 10_000n;
  return {
    kind: "swap",
    source: "swap_jupiter",
    input: {
      mint: inputMint,
      amount: o.inputAmount,
      decimals: inputMint === WSOL_MINT ? 9 : 6,
    },
    output: { mint: outputMint, decimals: outputMint === WSOL_MINT ? 9 : 6 },
    inputProvenance: o.inputProvenance ?? "user",
    outputProvenance: o.outputProvenance ?? "user",
    unsignedTxBase64: "AQAB",
    recentBlockhash: "SoMeBlockHash1111111111111111111111111111111",
    lastValidBlockHeight: 1000,
    landMode: "self-rpc",
    landHandle: undefined,
    priorityFeeLamports: o.priorityFeeLamports ?? 100_000,
    quote: {
      inAmount: o.inputAmount,
      outAmount,
      minOutAmount,
      priceImpactPct: 0.5,
      routeLabel: "Mock",
      slippageBps,
      contextSlot: undefined,
    },
    summary: `swap ${o.inputAmount} ${inputMint} -> ${outputMint}`,
  };
}

const HALF_SOL = 500_000_000n;
const TWO_SOL = 2_000_000_000n;

/**
 * Drive the chokepoint over synthetic state and assert every kernel invariant.
 * Never throws for a failing invariant — the report carries the outcome.
 */
export async function runSelfcheck(): Promise<SelfcheckReport> {
  const checks: SelfcheckCheck[] = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
  };
  const stores: KernelStore[] = [];
  const env = (opts: EnvOpts = {}) => {
    const made = makeEnv(opts);
    stores.push(made.store);
    return made;
  };

  try {
    // 1. Happy path: a swap within caps confirms and consumes the cap.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 1_000_000n,
      };
      const r = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "happy path confirms",
        r.state === "confirmed" && !r.error,
        r.error?.code ?? r.state,
      );
      check(
        "happy path reports the real fill",
        r.fill?.outputDelta === 1_000_000n && r.fill?.inputDelta === -HALF_SOL,
      );
      check(
        "happy path consumes input-leg cap",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }

    // 2. Per-trade cap: an oversized trade is refused and reserves nothing.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, 100n * TWO_SOL);
      const r = await e.gateway.execute(swapIntent({ inputAmount: TWO_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "per-trade cap rejects",
        r.error?.code === "CAP_EXCEEDED",
        r.error?.code ?? "",
      );
      check(
        "rejected trade reserves nothing",
        e.store.usage("sol", e.clock.now()).day === 0n,
      );
    }

    // 3. Idempotency: the same key cannot execute twice.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 1_000_000n,
      };
      const key = newIdempotencyKey();
      const intent = swapIntent({
        inputAmount: HALF_SOL,
        outAmount: 1_000_000n,
      });
      const first = await e.gateway.execute(intent, { idempotencyKey: key });
      const second = await e.gateway.execute(intent, { idempotencyKey: key });
      check("first execution confirms", first.state === "confirmed");
      check(
        "duplicate key is refused",
        second.error?.code === "DUPLICATE_INTENT",
        second.error?.code ?? "",
      );
      check(
        "duplicate does not double-spend the cap",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }

    // 4. Slippage clamp.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      const r = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, slippageBps: 250 }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "slippage over the clamp is refused",
        r.error?.code === "SLIPPAGE_EXCEEDED",
        r.error?.code ?? "",
      );
    }

    // 5. Token-2022 detection.
    {
      const e = env({ token2022: [BONK] });
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      const r = await e.gateway.execute(swapIntent({ inputAmount: HALF_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "token-2022 mint is refused",
        r.error?.code === "TOKEN2022_UNSUPPORTED",
        r.error?.code ?? "",
      );
    }

    // 6. Untrusted provenance requires explicit confirmation.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      const intent = swapIntent({
        inputAmount: HALF_SOL,
        outputProvenance: "untrusted",
      });
      const noConfirm = await e.gateway.execute(intent, {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "untrusted mint without confirmation is refused",
        noConfirm.error?.code === "MINT_NOT_PINNED",
        noConfirm.error?.code ?? "",
      );
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 1_000_000n,
      };
      const confirmed = await e.gateway.execute(
        swapIntent({
          inputAmount: HALF_SOL,
          outAmount: 1_000_000n,
          outputProvenance: "untrusted",
        }),
        { idempotencyKey: newIdempotencyKey(), confirmedByUser: true },
      );
      check(
        "untrusted mint WITH confirmation proceeds",
        confirmed.state === "confirmed",
        confirmed.error?.code ?? confirmed.state,
      );
    }

    // 7. Disarmed (executionEnabled = false) refuses live execution.
    {
      const e = env({ policy: { executionEnabled: false } });
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      const r = await e.gateway.execute(swapIntent({ inputAmount: HALF_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "disarmed engine refuses to execute",
        r.error?.code === "EXECUTION_DISABLED",
        r.error?.code ?? "",
      );
    }

    // 8. Blockhash expiry is terminal AND releases the reservation.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      e.chain.confirmStatus = "expired";
      const r = await e.gateway.execute(swapIntent({ inputAmount: HALF_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "expiry is reported as a timeout",
        r.error?.code === "CONFIRM_TIMEOUT",
        r.error?.code ?? "",
      );
      check(
        "expiry releases the reservation",
        e.store.usage("sol", e.clock.now()).day === 0n,
      );
      check(
        "expired trade is terminal and never re-signed",
        e.store.getTrade(r.tradeId)?.state === "expired",
        e.store.getTrade(r.tradeId)?.state ?? "missing",
      );
    }

    // 9. Per-day cap accumulates across trades.
    {
      const e = env({
        policy: {
          capsSol: {
            perTrade: HALF_SOL,
            perHour: TWO_SOL,
            perDay: 600_000_000n,
          },
        },
      });
      e.chain.balances.set(WSOL_MINT, 100n * TWO_SOL);
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 1_000_000n,
      };
      const first = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      const second = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "first trade within day cap confirms",
        first.state === "confirmed",
        first.error?.code ?? "",
      );
      check(
        "second trade exceeding day cap is refused",
        second.error?.code === "CAP_EXCEEDED",
        second.error?.code ?? "",
      );
      check(
        "day usage reflects only the consumed trade",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }

    // 10. Concurrency: two intents racing one shared cap — exactly one wins.
    {
      const e = env({
        policy: {
          capsSol: {
            perTrade: HALF_SOL,
            perHour: TWO_SOL,
            perDay: 600_000_000n,
          },
        },
      });
      e.chain.balances.set(WSOL_MINT, 100n * TWO_SOL);
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 1_000_000n,
      };
      const a = e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      const b = e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      const [ra, rb] = await Promise.all([a, b]);
      const confirmed = [ra, rb].filter((r) => r.state === "confirmed").length;
      const capped = [ra, rb].filter(
        (r) => r.error?.code === "CAP_EXCEEDED",
      ).length;
      check(
        "concurrent race: exactly one trade confirms",
        confirmed === 1,
        `confirmed=${confirmed}`,
      );
      check(
        "concurrent race: the loser is cap-rejected",
        capped === 1,
        `capped=${capped}`,
      );
      check(
        "concurrent race: cap counted once (no double-spend)",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }

    // 11. Simulation failure releases the reservation and never broadcasts.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      e.chain.simOk = false;
      const r = await e.gateway.execute(swapIntent({ inputAmount: HALF_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "failed simulation is refused",
        r.error?.code === "SIMULATION_FAILED",
        r.error?.code ?? "",
      );
      check(
        "failed simulation releases the reservation",
        e.store.usage("sol", e.clock.now()).day === 0n,
      );
      check(
        "failed simulation never persists a signed tx",
        e.store.getTrade(r.tradeId)?.signed_wire == null,
      );
    }

    // 12. Broadcast failure is terminal and releases the reservation.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      e.chain.broadcastError = "rpc send failed";
      const r = await e.gateway.execute(swapIntent({ inputAmount: HALF_SOL }), {
        idempotencyKey: newIdempotencyKey(),
      });
      check(
        "broadcast failure is reported",
        r.error?.code === "BROADCAST_FAILED",
        r.error?.code ?? "",
      );
      check(
        "broadcast failure releases the reservation",
        e.store.usage("sol", e.clock.now()).day === 0n,
      );
      check(
        "signed wire is persisted before broadcast is attempted",
        typeof e.store.getTrade(r.tradeId)?.signed_wire === "string",
      );
    }

    // 13. Partial fill: settles confirmed but flags the shortfall, still consuming the cap.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      // minOut for outAmount 1_000_000 @ 50bps ≈ 995_000; deliver less.
      e.chain.fill = {
        inMint: WSOL_MINT,
        inAmt: HALF_SOL,
        outMint: BONK,
        outAmt: 900_000n,
      };
      const r = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, outAmount: 1_000_000n }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "partial fill still confirms on-chain",
        r.state === "confirmed",
        r.state,
      );
      check(
        "partial fill flags SETTLE_SHORTFALL",
        r.error?.code === "SETTLE_SHORTFALL",
        r.error?.code ?? "",
      );
      check(
        "partial fill consumes the cap (spend happened)",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }

    // 14. Priority-fee ceiling: absolute and bps-of-notional bounds are both enforced.
    {
      const e = env();
      e.chain.balances.set(WSOL_MINT, TWO_SOL);
      // Default ceiling is 0.005 SOL = 5_000_000 lamports; ask for 6_000_000.
      const overAbsolute = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, priorityFeeLamports: 6_000_000 }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "priority fee over the absolute cap is refused",
        overAbsolute.error?.code === "PRIORITY_FEE_EXCEEDED",
        overAbsolute.error?.code ?? "",
      );
      // bps cap: 50bps of HALF_SOL (500_000_000) = 2_500_000; 3_000_000 is under
      // the absolute ceiling but over the bps one.
      const overBps = await e.gateway.execute(
        swapIntent({ inputAmount: HALF_SOL, priorityFeeLamports: 3_000_000 }),
        { idempotencyKey: newIdempotencyKey() },
      );
      check(
        "priority fee over the bps-of-notional cap is refused",
        overBps.error?.code === "PRIORITY_FEE_EXCEEDED",
        overBps.error?.code ?? "",
      );
    }

    // 15. Reconciler: a crash-interrupted 'sent' trade is resolved ONCE, never re-signed.
    {
      // 15a. It actually confirmed on-chain → consume the reservation.
      const e = env();
      seedSentTrade(e.store, HALF_SOL);
      e.chain.confirmStatus = "confirmed";
      const rec = new Reconciler({
        store: e.store,
        confirmer: new MockConfirmer(e.chain),
        clock: e.clock,
      });
      const summary = await rec.recover();
      check(
        "reconciler confirms a landed sent-trade",
        summary.confirmed === 1 && summary.checked === 1,
        JSON.stringify(summary),
      );
      check(
        "reconciler consumes the cap for a confirmed trade",
        e.store.usage("sol", e.clock.now()).day === HALF_SOL,
      );
    }
    {
      // 15b. It expired → release the reservation, mark terminal.
      const e = env();
      seedSentTrade(e.store, HALF_SOL);
      e.chain.confirmStatus = "expired";
      const rec = new Reconciler({
        store: e.store,
        confirmer: new MockConfirmer(e.chain),
        clock: e.clock,
      });
      const summary = await rec.recover();
      check(
        "reconciler fails an expired sent-trade",
        summary.failed === 1 && summary.checked === 1,
        JSON.stringify(summary),
      );
      check(
        "reconciler releases the cap for an expired trade",
        e.store.usage("sol", e.clock.now()).day === 0n,
      );
    }
  } finally {
    for (const store of stores) store.close();
  }

  return {
    total: checks.length,
    failures: checks.filter((c) => !c.ok).length,
    checks,
  };
}

/** Seed a trade left in 'sent' (crash-interrupted, after broadcast) with a live reservation. */
function seedSentTrade(store: KernelStore, amount: bigint): string {
  const now = systemClock.now();
  const tradeId = newTradeId();
  const key = newIdempotencyKey();
  store.claimIdempotency(key, tradeId, now);
  const outcome = store.reserve({
    bucket: "sol",
    amount,
    caps: { perTrade: amount, perHour: amount * 10n, perDay: amount * 10n },
    tradeId,
    now,
  });
  if (!outcome.ok) throw new Error("seed reservation failed");
  store.insertTrade(
    {
      id: tradeId,
      idempotencyKey: key,
      intentJson: "{}",
      inputMint: WSOL_MINT,
      outputMint: BONK,
      inputAmount: amount,
      lastValidBlockHeight: 1000,
      now,
    },
    outcome.reservationId,
  );
  store.persistSigned(tradeId, "AQAB", `seedsig_${tradeId}`, now);
  store.setState(tradeId, "sent", now);
  return outcome.reservationId;
}

/** Print the report. Kept out of {@link runSelfcheck} so the harness stays silent under vitest. */
export function printSelfcheck(report: SelfcheckReport): void {
  console.log(
    "ARI OS kernel selfcheck — driving the chokepoint over synthetic state\n",
  );
  for (const c of report.checks) {
    console.log(
      `  [${c.ok ? "PASS" : "FAIL"}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
    );
  }
  console.log(
    `\n${report.total} checks · ${
      report.failures === 0
        ? "ALL INVARIANTS HELD"
        : `${report.failures} INVARIANT(S) FAILED`
    }`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runSelfcheck()
    .then((report) => {
      printSelfcheck(report);
      if (report.failures > 0) process.exitCode = 1;
    })
    .catch((err: unknown) => {
      console.error("selfcheck crashed:", err);
      process.exitCode = 1;
    });
}
