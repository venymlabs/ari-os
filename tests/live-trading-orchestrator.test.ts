import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionStore,
  TradingOrchestrator,
  type TradingPolicy,
  type TradingRpc,
} from "../src/live-trading/index.js";
import { removeDir } from "./helpers.js";
import { CLUSTER, pubkey } from "./signer-fixtures.js";
import { FEE_PAYER, MINT } from "./execution-fixtures.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "trade-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((x) => removeDir(x)));

const OUT = pubkey(4);
const policy: TradingPolicy = {
  version: 1,
  maxAmountIn: 100n,
  maxSlippageBps: 100,
  approvalRequired: true,
  finalityCommitment: "finalized",
};

function rpc(): TradingRpc {
  return {
    balance: vi.fn(async () => 10n),
    quote: vi.fn(async () => ({
      amountOut: 90n,
      slot: 10n,
      lastValidBlockHeight: 500,
      expiresAt: 2000,
    })),
    simulate: vi.fn(async () => ({
      success: true,
      slot: 10n,
      simulationHash: "0xsim",
    })),
    broadcast: vi.fn(async () => "signature"),
    status: vi.fn(async () => null),
    blockHeight: vi.fn(async () => 400),
  };
}

const orchestrator = (
  store: ExecutionStore,
  overrides: Record<string, unknown> = {},
) =>
  new TradingOrchestrator({
    cluster: CLUSTER,
    account: FEE_PAYER,
    policy,
    rpc: rpc(),
    store,
    clock: () => 1000,
    ...overrides,
  });

describe("live trading orchestration", () => {
  it("defaults to dry-run and persists an idempotent execution", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store);
    const q = await o.quote({
      side: "buy",
      inputMint: MINT,
      outputMint: OUT,
      amountIn: 10n,
      slippageBps: 50,
    });
    expect(q.cluster).toBe(CLUSTER);
    expect(q.lastValidBlockHeight).toBe(500);
    const x = await o.execute(q.id, { idempotencyKey: "k", actor: "agent" });
    expect(x.state).toBe("dry-run");
    expect(x.dryRun).toBe(true);
    expect(store.byIdempotency("k")?.id).toBe(x.id);
    expect(
      (await o.execute(q.id, { idempotencyKey: "k", actor: "agent" })).id,
    ).toBe(x.id);
    store.close();
  });
  it("rejects live quotes that lack an exact transaction and evidence", async () => {
    const r = rpc(),
      signer = { sign: vi.fn() },
      store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, { rpc: r, signer, liveEnabled: true });
    const q = await o.quote({
      side: "sell",
      inputMint: MINT,
      outputMint: OUT,
      amountIn: 10n,
      slippageBps: 50,
    });
    await expect(
      o.execute(q.id, { idempotencyKey: "k", actor: "agent", dryRun: false }),
    ).rejects.toThrow("exact_transaction_required");
    expect(signer.sign).not.toHaveBeenCalled();
    expect(r.broadcast).not.toHaveBeenCalled();
    store.close();
  });
  it("refuses to go live at all without the live gate", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store);
    const q = await o.quote({
      side: "buy",
      inputMint: MINT,
      outputMint: OUT,
      amountIn: 10n,
      slippageBps: 50,
    });
    await expect(
      o.execute(q.id, { idempotencyKey: "k", actor: "a", dryRun: false }),
    ).rejects.toThrow("live_trading_disabled");
    store.close();
  });
  it("expires a quote by wall clock before touching the chain", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, { clock: () => 9_999 });
    const q = await o.quote({
      side: "buy",
      inputMint: MINT,
      outputMint: OUT,
      amountIn: 10n,
      slippageBps: 50,
    });
    await expect(
      o.execute(q.id, { idempotencyKey: "k", actor: "a" }),
    ).rejects.toThrow("quote_expired");
    store.close();
  });
  it("reconciles confirmed, finalized and dropped signatures durably", async () => {
    const r = rpc(),
      store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, { rpc: r });
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "r",
      signature: "sig-1",
      lastValidBlockHeight: 500,
    }).id;
    store.update(id, { state: "broadcast" });
    vi.mocked(r.status).mockResolvedValue({
      slot: 11n,
      confirmationStatus: "confirmed",
      err: null,
    });
    expect((await o.reconcile(id)).state).toBe("confirmed");
    vi.mocked(r.status).mockResolvedValue({
      slot: 11n,
      confirmationStatus: "finalized",
      err: null,
    });
    const done = await o.reconcile(id);
    expect(done.state).toBe("finalized");
    expect(done.slot).toBe(11n);
    store.close();
  });
  it("treats an unseen signature past its last valid height as terminally dropped", async () => {
    const r = rpc(),
      release = vi.fn(async () => true),
      store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, {
        rpc: r,
        reservations: {
          reserve: async () => "res",
          valid: async () => true,
          commit: async () => true,
          release,
        },
      });
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "d",
      signature: "sig-1",
      reservationId: "res",
      lastValidBlockHeight: 500,
    }).id;
    store.update(id, { state: "broadcast" });
    // Still alive: the cluster simply has not seen it yet.
    vi.mocked(r.blockHeight).mockResolvedValue(499);
    expect((await o.reconcile(id)).state).toBe("reconciliation-required");
    // Past the fence it can never land, and nothing re-signs it.
    vi.mocked(r.blockHeight).mockResolvedValue(501);
    expect((await o.reconcile(id)).state).toBe("dropped");
    expect(release).toHaveBeenCalledWith("res");
    store.close();
  });
  it("records a signature the cluster rejected as failed", async () => {
    const r = rpc(),
      store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, { rpc: r });
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "f",
      signature: "sig-1",
      lastValidBlockHeight: 500,
    }).id;
    store.update(id, { state: "broadcast" });
    vi.mocked(r.status).mockResolvedValue({
      slot: 11n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    });
    expect((await o.reconcile(id)).state).toBe("failed");
    store.close();
  });
  it("honours a policy that finalizes at confirmed commitment", async () => {
    const r = rpc(),
      store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, {
        rpc: r,
        policy: { ...policy, finalityCommitment: "confirmed" },
      });
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "c",
      signature: "sig-1",
      lastValidBlockHeight: 500,
    }).id;
    store.update(id, { state: "broadcast" });
    vi.mocked(r.status).mockResolvedValue({
      slot: 11n,
      confirmationStatus: "confirmed",
      err: null,
    });
    expect((await o.reconcile(id)).state).toBe("finalized");
    store.close();
  });
  it("refuses to reconcile something that was never broadcast", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store);
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "n",
    }).id;
    store.update(id, { state: "broadcast" });
    await expect(o.reconcile(id)).rejects.toThrow("transaction_not_broadcast");
    store.close();
  });
  it("migrates legacy execution databases to indexed columns in place", async () => {
    const path = join(temp(), "legacy.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TABLE executions(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);CREATE TABLE quotes(id TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    raw.prepare("INSERT INTO executions VALUES(?,?,?)").run(
      "e1",
      "k1",
      JSON.stringify({
        id: "e1",
        version: 0,
        quoteId: "q1",
        intentHash: "i",
        actor: "a",
        dryRun: false,
        idempotencyKey: "k1",
        state: "broadcast",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    raw
      .prepare("INSERT INTO quotes VALUES(?,?)")
      .run(
        "q1",
        JSON.stringify({ id: "q1", quoteHash: "qh-1", intentHash: "i" }),
      );
    raw.close();
    const store = new ExecutionStore(path);
    expect(store.findQuoteByHash("qh-1")?.id).toBe("q1");
    expect(store.list(["broadcast"]).map((x) => x.id)).toEqual(["e1"]);
    expect(
      store.transition("e1", "broadcast", { state: "confirmed" }).state,
    ).toBe("confirmed");
    expect(store.list(["broadcast"])).toEqual([]);
    expect(store.list(["confirmed"]).map((x) => x.id)).toEqual(["e1"]);
    store.close();
  });
  it("rejects policy violations, unknown fields and non-base58 mints", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, {
        policy: { ...policy, maxAmountIn: 5n, maxSlippageBps: 10 },
      });
    const base = {
      side: "buy" as const,
      inputMint: MINT,
      outputMint: OUT,
      amountIn: 1n,
      slippageBps: 1,
    };
    await expect(o.quote({ ...base, amountIn: 10n })).rejects.toThrow(/amount/);
    await expect(o.quote({ ...base, amountIn: 0n })).rejects.toThrow(/amount/);
    await expect(o.quote({ ...base, slippageBps: 99 })).rejects.toThrow(
      /slippage/,
    );
    await expect(o.quote({ ...base, side: "swap" } as never)).rejects.toThrow(
      /side/,
    );
    await expect(o.quote({ ...base, program: OUT } as never)).rejects.toThrow(
      /field/,
    );
    await expect(o.quote({ ...base, inputMint: "0xdeadbeef" })).rejects.toThrow(
      /inputMint/,
    );
    store.close();
  });
  it("enforces the mint allowlist in both legs", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite")),
      o = orchestrator(store, {
        policy: { ...policy, allowedMints: [MINT] },
      });
    await expect(
      o.quote({
        side: "buy",
        inputMint: MINT,
        outputMint: OUT,
        amountIn: 1n,
        slippageBps: 1,
      }),
    ).rejects.toThrow("mint denied");
    store.close();
  });
});
