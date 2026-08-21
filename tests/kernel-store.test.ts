import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../src/kernel/clock.js";
import type { ConfirmOutcome, Confirmer } from "../src/kernel/contracts.js";
import { newIdempotencyKey, newTradeId } from "../src/kernel/ids.js";
import { LockHeldError, ProcessLock } from "../src/kernel/lock.js";
import { WSOL_MINT } from "../src/kernel/money.js";
import { Reconciler } from "../src/kernel/reconciler.js";
import { KernelStore } from "../src/kernel/store.js";
import { removeDir } from "./helpers.js";

const BONK = "BonkMint11111111111111111111111111111111111";
const HALF_SOL = 500_000_000n;
const CAPS = {
  perTrade: HALF_SOL,
  perHour: 2_000_000_000n,
  perDay: 4_000_000_000n,
};

const stores: KernelStore[] = [];
const dirs: string[] = [];
const store = () => {
  const s = new KernelStore(":memory:");
  stores.push(s);
  return s;
};
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "kernel-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => removeDir(d));
});

function seedSent(s: KernelStore, now: number, amount = HALF_SOL) {
  const tradeId = newTradeId();
  const key = newIdempotencyKey();
  s.claimIdempotency(key, tradeId, now);
  const outcome = s.reserve({
    bucket: "sol",
    amount,
    caps: CAPS,
    tradeId,
    now,
  });
  if (!outcome.ok) throw new Error("seed reservation failed");
  s.insertTrade(
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
  s.persistSigned(tradeId, "AQAB", `seedsig_${tradeId}`, now);
  s.setState(tradeId, "sent", now);
  return { tradeId, reservationId: outcome.reservationId };
}

const confirmerReturning = (outcome: ConfirmOutcome): Confirmer => ({
  confirm: async () => outcome,
});

describe("kernel store — input-leg reservations", () => {
  it("counts reserved and consumed spend, but not released spend", () => {
    const s = store();
    const now = 1_700_000_000_000;
    const a = s.reserve({
      bucket: "sol",
      amount: HALF_SOL,
      caps: CAPS,
      tradeId: "t1",
      now,
    });
    expect(a.ok).toBe(true);
    expect(s.usage("sol", now).day).toBe(HALF_SOL);
    if (!a.ok) return;
    s.consumeReservation(a.reservationId);
    expect(s.usage("sol", now).day).toBe(HALF_SOL);

    const b = s.reserve({
      bucket: "sol",
      amount: HALF_SOL,
      caps: CAPS,
      tradeId: "t2",
      now,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    s.releaseReservation(b.reservationId);
    expect(s.usage("sol", now).day).toBe(HALF_SOL);
  });

  it("denies with the specific window that was breached and reserves nothing", () => {
    const s = store();
    const now = 1_700_000_000_000;
    const tooBig = s.reserve({
      bucket: "sol",
      amount: HALF_SOL + 1n,
      caps: CAPS,
      tradeId: "t1",
      now,
    });
    expect(tooBig).toMatchObject({ ok: false, reason: "perTrade" });
    expect(s.usage("sol", now).day).toBe(0n);

    const caps = { perTrade: HALF_SOL, perHour: HALF_SOL, perDay: 10n ** 12n };
    expect(
      s.reserve({ bucket: "sol", amount: HALF_SOL, caps, tradeId: "t2", now }),
    ).toMatchObject({ ok: true });
    expect(
      s.reserve({ bucket: "sol", amount: HALF_SOL, caps, tradeId: "t3", now }),
    ).toMatchObject({ ok: false, reason: "perHour" });
  });

  it("keeps SOL and USDC caps in separate buckets", () => {
    const s = store();
    const now = 1_700_000_000_000;
    s.reserve({
      bucket: "sol",
      amount: HALF_SOL,
      caps: CAPS,
      tradeId: "t1",
      now,
    });
    expect(s.usage("sol", now).day).toBe(HALF_SOL);
    expect(s.usage("usdc", now).day).toBe(0n);
  });

  it("rolls the hour window off before the day window", () => {
    const s = store();
    const now = 1_700_000_000_000;
    s.reserve({
      bucket: "sol",
      amount: HALF_SOL,
      caps: CAPS,
      tradeId: "t1",
      now,
    });
    const later = now + 3_600_001;
    expect(s.usage("sol", later).hour).toBe(0n);
    expect(s.usage("sol", later).day).toBe(HALF_SOL);
    expect(s.usage("sol", now + 86_400_001).day).toBe(0n);
  });

  it("claims an idempotency key exactly once", () => {
    const s = store();
    const key = newIdempotencyKey();
    expect(s.claimIdempotency(key, "t1", 1)).toBe(true);
    expect(s.claimIdempotency(key, "t2", 2)).toBe(false);
  });

  it("journals a trade in order and round-trips the payload", () => {
    const s = store();
    s.appendJournal({
      type: "intent.received",
      tradeId: "t1",
      at: 1,
      idempotencyKey: "k",
      source: "swap_jupiter",
      summary: "s",
    });
    s.appendJournal({
      type: "trade.simulated",
      tradeId: "t1",
      at: 2,
      ok: true,
    });
    s.appendJournal({
      type: "trade.sent",
      tradeId: "t2",
      at: 3,
      signature: "other",
    });
    expect(s.readJournal("t1").map((e) => e.type)).toEqual([
      "intent.received",
      "trade.simulated",
    ]);
    expect(s.readJournal("t2")).toHaveLength(1);
  });

  it("persists the signed wire before broadcast so a crash is recoverable", () => {
    const s = store();
    const { tradeId } = seedSent(s, systemClock.now());
    const row = s.getTrade(tradeId);
    expect(row?.signed_wire).toBe("AQAB");
    expect(row?.state).toBe("sent");
    expect(s.pendingSent().map((t) => t.id)).toEqual([tradeId]);
    expect(s.recentTrades(5).map((t) => t.id)).toEqual([tradeId]);
  });
});

describe("reconciler — resolve once, never re-sign", () => {
  it("consumes the reservation for a trade that actually landed", async () => {
    const s = store();
    const now = systemClock.now();
    seedSent(s, now);
    const summary = await new Reconciler({
      store: s,
      confirmer: confirmerReturning({
        status: "confirmed",
        slot: 1,
        err: undefined,
      }),
      clock: systemClock,
    }).recover();
    expect(summary).toEqual({ checked: 1, confirmed: 1, failed: 0 });
    expect(s.usage("sol", now).day).toBe(HALF_SOL);
    expect(s.pendingSent()).toHaveLength(0);
  });

  it("treats blockhash expiry as terminal and releases the reservation", async () => {
    const s = store();
    const now = systemClock.now();
    const { tradeId } = seedSent(s, now);
    const summary = await new Reconciler({
      store: s,
      confirmer: confirmerReturning({
        status: "expired",
        slot: undefined,
        err: undefined,
      }),
      clock: systemClock,
    }).recover();
    expect(summary).toEqual({ checked: 1, confirmed: 0, failed: 1 });
    expect(s.usage("sol", now).day).toBe(0n);
    const row = s.getTrade(tradeId);
    expect(row?.state).toBe("expired");
    expect(row?.error).toBe("RECONCILE_EXPIRED");
  });

  it("is idempotent — a second pass finds nothing left to do", async () => {
    const s = store();
    seedSent(s, systemClock.now());
    const deps = {
      store: s,
      confirmer: confirmerReturning({
        status: "expired" as const,
        slot: undefined,
        err: undefined,
      }),
      clock: systemClock,
    };
    await new Reconciler(deps).recover();
    expect(await new Reconciler(deps).recover()).toEqual({
      checked: 0,
      confirmed: 0,
      failed: 0,
    });
  });
});

describe("process lock — one writer per home dir", () => {
  it("acquires, releases and re-acquires", () => {
    const path = join(temp(), "kernel.lock");
    const a = new ProcessLock(path);
    a.acquire();
    a.release();
    const b = new ProcessLock(path);
    b.acquire();
    b.release();
  });

  it("refuses a second live holder", () => {
    const path = join(temp(), "kernel.lock");
    const a = new ProcessLock(path);
    a.acquire();
    try {
      expect(() => new ProcessLock(path).acquire()).toThrow(LockHeldError);
    } finally {
      a.release();
    }
  });

  it("reclaims a lock left behind by a dead pid", () => {
    const path = join(temp(), "kernel.lock");
    // 2147483646 is a pid that will not exist; the signal-0 probe reports it dead.
    writeFileSync(path, "2147483646\n");
    const lock = new ProcessLock(path);
    lock.acquire();
    lock.release();
  });

  it("treats an unreadable pid as stale rather than wedging forever", () => {
    const path = join(temp(), "kernel.lock");
    writeFileSync(path, "not-a-pid\n");
    const lock = new ProcessLock(path);
    lock.acquire();
    lock.release();
  });

  it("is idempotent on release and tolerates a missing file", () => {
    const path = join(temp(), "kernel.lock");
    const lock = new ProcessLock(path);
    lock.acquire();
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});
