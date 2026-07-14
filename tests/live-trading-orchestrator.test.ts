import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionStore,
  TradingOrchestrator,
  type TradingRpc,
} from "../src/live-trading/index.js";
import { removeDir } from "./helpers.js";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "trade-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((x) => removeDir(x)));
const A = "0x0000000000000000000000000000000000000001" as const,
  T = "0x0000000000000000000000000000000000000002" as const;
function rpc(): TradingRpc {
  return {
    balance: vi.fn(async () => 10n),
    quote: vi.fn(async () => ({
      amountOut: 90n,
      blockNumber: 10n,
      expiresAt: 2000,
    })),
    simulate: vi.fn(async () => ({
      success: true,
      blockNumber: 10n,
      simulationHash: "0xsim",
    })),
    broadcast: vi.fn(async () => "0xhash" as const),
    receipt: vi.fn(async () => null),
    blockHash: vi.fn(async () => "0xaaa" as const),
  };
}
describe("live trading orchestration", () => {
  it("defaults to dry-run and persists an exact approval-bound execution", async () => {
    const store = new ExecutionStore(join(temp(), "x.sqlite"));
    const o = new TradingOrchestrator({
      chainId: 46630,
      account: A,
      router: T,
      policy: {
        version: 1,
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        approvalRequired: true,
        finalityBlocks: 2,
      },
      rpc: rpc(),
      store,
      clock: () => 1000,
    });
    const q = await o.quote({
      side: "buy",
      tokenIn: A,
      tokenOut: T,
      amountIn: 10n,
      slippageBps: 50,
    });
    const x = await o.execute(q.id, { idempotencyKey: "k", actor: "agent" });
    expect(x.state).toBe("dry-run");
    expect(x.dryRun).toBe(true);
    expect(store.byIdempotency("k")?.id).toBe(x.id);
    store.close();
  });
  it("rejects legacy live quotes that lack an exact transaction and evidence", async () => {
    const signer = { sign: vi.fn(async () => "0xsigned" as const) };
    const r = rpc();
    const store = new ExecutionStore(join(temp(), "x.sqlite"));
    const o = new TradingOrchestrator({
      chainId: 46630,
      account: A,
      router: T,
      liveEnabled: true,
      policy: {
        version: 1,
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        approvalRequired: true,
        finalityBlocks: 2,
      },
      rpc: r,
      signer,
      store,
      clock: () => 1000,
    });
    const q = await o.quote({
      side: "sell",
      tokenIn: A,
      tokenOut: T,
      amountIn: 10n,
      slippageBps: 50,
    });
    await expect(
      o.execute(q.id, {
        idempotencyKey: "k",
        actor: "agent",
        dryRun: false,
      }),
    ).rejects.toThrow("exact_transaction_required");
    expect(signer.sign).not.toHaveBeenCalled();
    expect(r.broadcast).not.toHaveBeenCalled();
    store.close();
  });
  it("reconciles confirmed, finalized, and reorged receipts durably", async () => {
    const r = rpc();
    const store = new ExecutionStore(join(temp(), "x.sqlite"));
    const o = new TradingOrchestrator({
      chainId: 46630,
      account: A,
      router: T,
      policy: {
        version: 1,
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        approvalRequired: false,
        finalityBlocks: 2,
      },
      rpc: r,
      store,
      clock: () => 1000,
    });
    const id = store.create({
      quoteId: "q",
      intentHash: "i",
      actor: "a",
      dryRun: false,
      idempotencyKey: "r",
    }).id;
    store.update(id, { state: "broadcast", txHash: "0xhash" });
    vi.mocked(r.receipt).mockResolvedValue({
      blockNumber: 10n,
      blockHash: "0xaaa",
      status: "success",
      confirmations: 1,
    });
    expect((await o.reconcile(id)).state).toBe("confirmed");
    vi.mocked(r.receipt).mockResolvedValue({
      blockNumber: 10n,
      blockHash: "0xaaa",
      status: "success",
      confirmations: 2,
    });
    expect((await o.reconcile(id)).state).toBe("finalized");
    vi.mocked(r.blockHash).mockResolvedValue("0xbbb");
    expect((await o.reconcile(id)).state).toBe("reconciliation-required");
    store.close();
  });
  it("rejects policy violations and arbitrary transaction fields", async () => {
    const o = new TradingOrchestrator({
      chainId: 46630,
      account: A,
      router: T,
      policy: {
        version: 1,
        maxAmountIn: 5n,
        maxSlippageBps: 10,
        approvalRequired: false,
        finalityBlocks: 2,
      },
      rpc: rpc(),
      store: new ExecutionStore(join(temp(), "x.sqlite")),
    });
    await expect(
      o.quote({
        side: "buy",
        tokenIn: A,
        tokenOut: T,
        amountIn: 10n,
        slippageBps: 1,
      }),
    ).rejects.toThrow(/amount/);
    await expect(
      o.quote({
        side: "buy",
        tokenIn: A,
        tokenOut: T,
        amountIn: 1n,
        slippageBps: 1,
        target: T,
      } as any),
    ).rejects.toThrow(/field/);
  });
});
