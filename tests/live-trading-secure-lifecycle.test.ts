import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256 } from "viem";
import { ERC20_ABI } from "../src/trading/index.js";
import {
  buildSimulationRequest,
  createSimulationEvidence,
} from "../src/execution/simulation.js";
import {
  ExecutionStore,
  TradingOrchestrator,
  type TradingRpc,
} from "../src/live-trading/index.js";
import { removeDir } from "./helpers.js";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "secure-trade-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));
const account = "0x0000000000000000000000000000000000000001" as const,
  router = "0x0000000000000000000000000000000000000002" as const,
  token = "0x0000000000000000000000000000000000000003" as const;
function fixture(db: string) {
  const tx = {
    chainId: 46630,
    from: account,
    to: router,
    data: "0x12345678" as const,
    value: 0n,
    gas: 100000n,
    nonce: 7,
    type: "eip1559" as const,
    maxFeePerGas: 20n,
    maxPriorityFeePerGas: 2n,
    accessList: [],
  };
  const request = buildSimulationRequest(tx, "policy-hash");
  const evidence = createSimulationEvidence(request, {
    success: true,
    blockNumber: 10n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: request.transactionHash,
    gasUsed: 90000n,
    stateDiffs: [],
    events: [],
    assetDeltas: [],
  });
  const rpc: TradingRpc = {
    balance: vi.fn(async () => 0n),
    quote: vi.fn(async () => ({
      amountOut: 90n,
      blockNumber: 10n,
      expiresAt: 20_000,
      request,
      evidence,
    })),
    simulate: vi.fn(async () => evidence),
    broadcast: vi.fn(async (raw) => keccak256(raw)),
    receipt: vi.fn(async () => null),
    blockHash: vi.fn(async () => evidence.blockHash as `0x${string}`),
  };
  const approvals = {
    request: vi.fn((x: any) => ({
      ...x,
      status: "pending",
      revision: 0,
      challenge: "challenge",
    })),
    get: vi.fn(() => ({
      status: "approved",
      revision: 1,
      challenge: "challenge",
    })),
    decide: vi.fn(),
    consume: vi.fn(),
  };
  const envelope = { claims: { id: "auth-1" }, signature: "sig" } as any;
  const issuer = { issue: vi.fn(async () => envelope) };
  const signer = {
    sign: vi.fn(async () => `0x${"aa".repeat(100)}` as `0x${string}`),
  };
  const store = new ExecutionStore(db);
  const orchestrator = new TradingOrchestrator({
    chainId: 46630,
    account,
    router,
    liveEnabled: true,
    policy: {
      version: 1,
      hash: "policy-hash",
      maxAmountIn: 100n,
      maxSlippageBps: 100,
      approvalRequired: true,
      finalityBlocks: 2,
    },
    rpc,
    store,
    signer,
    approvalEngine: approvals as any,
    authorizationIssuer: issuer as any,
    risk: { assess: async () => ({ hash: "risk-hash", allowed: true }) },
    reservations: {
      reserve: async () => "reservation-1",
      valid: async () => true,
      commit: async () => true,
      release: async () => true,
    },
    clock: () => 1000,
    audience: "daemon",
  });
  return {
    store,
    orchestrator,
    rpc,
    approvals,
    issuer,
    signer,
    request,
    evidence,
    envelope,
  };
}
describe("exact authorized trading lifecycle", () => {
  it("durably stores exact unsigned transaction and rejects approval substitution", async () => {
    const db = join(temp(), "trade.sqlite");
    let f = fixture(db);
    const q = await f.orchestrator.quote({
      side: "buy",
      tokenIn: token,
      tokenOut: router,
      amountIn: 10n,
      slippageBps: 50,
    });
    expect(q.serialized).toBe(f.request.serialized);
    f.store.close();
    f = fixture(db);
    expect(f.store.getQuote(q.id)?.transactionHash).toBe(
      f.request.transactionHash,
    );
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    expect(f.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        serializedTransaction: expect.objectContaining({
          serialized: f.request.serialized,
        }),
        simulationHash: f.evidence.hash,
        nonce: "7",
        calldata: "0x12345678",
      }),
      expect.anything(),
    );
    const mutated = {
      ...f.request,
      serialized: (f.request.serialized.slice(0, -2) + "00") as `0x${string}`,
    };
    expect(() => f.orchestrator.assertExact(x.id, mutated)).toThrow(
      /exact transaction mismatch/,
    );
    f.store.close();
  });
  it("issues an envelope, sends exact serialized+envelope+token, and fences duplicate submit", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const q = await f.orchestrator.quote({
      side: "buy",
      tokenIn: token,
      tokenOut: router,
      amountIn: 10n,
      slippageBps: 50,
    });
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    const sent = await f.orchestrator.submit(x.id);
    expect(f.issuer.issue).toHaveBeenCalledWith(
      f.request,
      f.evidence,
      expect.objectContaining({
        approvalId: x.approvalId,
        reservationId: "reservation-1",
      }),
    );
    expect(f.signer.sign).toHaveBeenCalledWith({
      serialized: f.request.serialized,
      envelope: f.envelope,
      authorizationToken: "auth-1",
    });
    expect(sent.state).toBe("broadcast");
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow(
      /not approved|in progress/,
    );
    f.store.close();
  });
  it("runs an allowance revoke through the full approval and signing pipeline", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [router, 0n],
    });
    const tx = {
      chainId: 46630,
      from: account,
      to: token,
      data,
      value: 0n,
      gas: 60000n,
      nonce: 7,
      type: "eip1559" as const,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      accessList: [],
    };
    const request = buildSimulationRequest(tx, "policy-hash");
    const evidence = createSimulationEvidence(request, {
      success: true,
      blockNumber: 10n,
      blockHash: `0x${"11".repeat(32)}`,
      transactionHash: request.transactionHash,
      gasUsed: 50000n,
      stateDiffs: [],
      events: [],
      assetDeltas: [],
    });
    f.rpc.revokeQuote = vi.fn(async () => ({
      amountOut: 0n,
      blockNumber: 10n,
      blockHash: `0x${"11".repeat(32)}` as `0x${string}`,
      expiresAt: 20_000,
      request,
      evidence,
    }));
    vi.mocked(f.rpc.simulate).mockResolvedValue(evidence);
    const x = await f.orchestrator.revoke(token, {
      idempotencyKey: "revoke-1",
      actor: "operator",
      dryRun: false,
    });
    expect(x.state).toBe("awaiting-approval");
    expect(f.rpc.revokeQuote).toHaveBeenCalledWith({
      token,
      spender: router,
    });
    expect(f.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        calldata: data,
        router: token,
        value: "0",
        serializedTransaction: expect.objectContaining({
          serialized: request.serialized,
        }),
      }),
      expect.anything(),
    );
    const again = await f.orchestrator.revoke(token, {
      idempotencyKey: "revoke-1",
      actor: "operator",
      dryRun: false,
    });
    expect(again.id).toBe(x.id);
    await f.orchestrator.refreshApproval(x.id);
    const sent = await f.orchestrator.submit(x.id);
    expect(sent.state).toBe("broadcast");
    expect(f.signer.sign).toHaveBeenCalledWith({
      serialized: request.serialized,
      envelope: f.envelope,
      authorizationToken: "auth-1",
    });
    f.store.close();
  });
  it("defaults revokes to dry-run and fails closed without revoke support", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    await expect(
      f.orchestrator.revoke(token, { idempotencyKey: "r", actor: "operator" }),
    ).rejects.toThrow("revoke_unsupported");
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [router, 0n],
    });
    const request = buildSimulationRequest(
      {
        chainId: 46630,
        from: account,
        to: token,
        data,
        value: 0n,
        gas: 60000n,
        nonce: 7,
        type: "eip1559",
        maxFeePerGas: 20n,
        maxPriorityFeePerGas: 2n,
        accessList: [],
      },
      "policy-hash",
    );
    const evidence = createSimulationEvidence(request, {
      success: true,
      blockNumber: 10n,
      blockHash: `0x${"11".repeat(32)}`,
      transactionHash: request.transactionHash,
      gasUsed: 50000n,
      stateDiffs: [],
      events: [],
      assetDeltas: [],
    });
    f.rpc.revokeQuote = vi.fn(async () => ({
      amountOut: 0n,
      blockNumber: 10n,
      blockHash: `0x${"11".repeat(32)}` as `0x${string}`,
      expiresAt: 20_000,
      request,
      evidence,
    }));
    vi.mocked(f.rpc.simulate).mockResolvedValue(evidence);
    await expect(
      f.orchestrator.revoke("not-an-address" as any, {
        idempotencyKey: "bad",
        actor: "operator",
      }),
    ).rejects.toThrow();
    const dry = await f.orchestrator.revoke(token, {
      idempotencyKey: "dry",
      actor: "operator",
    });
    expect(dry.state).toBe("dry-run");
    expect(dry.dryRun).toBe(true);
    f.store.close();
  });
  it("persists only the signed transaction hash in the API execution database", async () => {
    const db = join(temp(), "trade.sqlite"),
      f = fixture(db);
    const q = await f.orchestrator.quote({
      side: "buy",
      tokenIn: token,
      tokenOut: router,
      amountIn: 10n,
      slippageBps: 50,
    });
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "hash-only",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    await f.orchestrator.submit(x.id);
    const persisted = f.store.get(x.id)!;
    expect(persisted.rawTransactionHash).toMatch(/^0x/);
    expect(persisted).not.toHaveProperty("rawTransaction");
    expect(readFileSync(db)).not.toContain(Buffer.from("aa".repeat(100)));
    f.store.close();
  });
});
