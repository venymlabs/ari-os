import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  attachSignature,
  decodeTransaction,
} from "../src/signer/transaction.js";
import {
  buildSimulationRequest,
  createSimulationEvidence,
} from "../src/execution/simulation.js";
import {
  ExecutionStore,
  TradingOrchestrator,
  type TradingRpc,
} from "../src/live-trading/index.js";
import type { SignerSignResponse } from "../src/execution/authorization/wire.js";
import { removeDir } from "./helpers.js";
import {
  buildTransaction,
  CLUSTER,
  pubkey,
  systemTransfer,
  TOKEN_PROGRAM,
} from "./signer-fixtures.js";
import {
  FEE_PAYER,
  LAST_VALID_BLOCK_HEIGHT,
  MINT,
  okResult,
  prepared,
} from "./execution-fixtures.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "secure-trade-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));

const OUT = pubkey(4);
const TOKEN_ACCOUNT = pubkey(5);
const POLICY_HASH = "policy-hash";

/** SPL Token `Revoke` — tag 5, clears the delegate on a token account. */
function tokenRevoke(source: string, owner: string) {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([5]),
  });
}

const sign = (transaction: string, byte = 1) =>
  attachSignature(
    decodeTransaction(transaction),
    new Uint8Array(64).fill(byte),
  );

function exact(transaction: string) {
  const request = buildSimulationRequest(
    prepared({ transaction }),
    POLICY_HASH,
  );
  return {
    request,
    evidence: createSimulationEvidence(request, okResult(request)),
    signed: sign(transaction),
  };
}

function fixture(db: string, overrides: Record<string, unknown> = {}) {
  const swap = exact(
    buildTransaction({
      payer: FEE_PAYER,
      instructions: [systemTransfer(FEE_PAYER, OUT, 1_000n)],
    }),
  );
  const rpc: TradingRpc = {
    balance: vi.fn(async () => 0n),
    quote: vi.fn(async () => ({
      amountOut: 90n,
      slot: 10n,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      expiresAt: 20_000,
      request: swap.request,
      evidence: swap.evidence,
    })),
    simulate: vi.fn(async () => swap.evidence),
    broadcast: vi.fn(
      async (wire: string) => decodeTransaction(wire).signatures[0]!,
    ),
    status: vi.fn(async () => null),
    blockHeight: vi.fn(async () => LAST_VALID_BLOCK_HEIGHT - 100),
  };
  const approvals = {
    request: vi.fn((x: Record<string, unknown>) => ({
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
  const envelope = { claims: { id: "auth-1" }, signature: "sig" };
  const issuer = { issue: vi.fn(async () => envelope) };
  const signer = {
    sign: vi.fn(async (): Promise<SignerSignResponse> => swap.signed),
  };
  const reservations = {
    reserve: async () => "reservation-1",
    valid: async () => true,
    commit: vi.fn(async () => true),
    release: vi.fn(async () => true),
  };
  const store = new ExecutionStore(db);
  const orchestrator = new TradingOrchestrator({
    cluster: CLUSTER,
    account: FEE_PAYER,
    liveEnabled: true,
    policy: {
      version: 1,
      hash: POLICY_HASH,
      maxAmountIn: 100n,
      maxSlippageBps: 100,
      approvalRequired: true,
      finalityCommitment: "finalized",
    },
    rpc,
    store,
    signer,
    approvalEngine: approvals as never,
    authorizationIssuer: issuer as never,
    risk: { assess: async () => ({ hash: "risk-hash", allowed: true }) },
    reservations,
    clock: () => 1000,
    audience: "daemon",
    ...overrides,
  });
  return {
    store,
    orchestrator,
    rpc,
    approvals,
    issuer,
    signer,
    reservations,
    envelope,
    ...swap,
  };
}

const buy = (o: TradingOrchestrator) =>
  o.quote({
    side: "buy",
    inputMint: MINT,
    outputMint: OUT,
    amountIn: 10n,
    slippageBps: 50,
  });

describe("exact authorized trading lifecycle", () => {
  it("durably stores the exact unsigned transaction and rejects substitution", async () => {
    const db = join(temp(), "trade.sqlite");
    let f = fixture(db);
    const q = await buy(f.orchestrator);
    expect(q.transaction).toBe(f.request.transaction);
    f.store.close();
    // The exact bytes must survive a restart, not be rebuilt from a quote.
    f = fixture(db);
    expect(f.store.getQuote(q.id)?.messageHash).toBe(f.request.messageHash);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    expect(f.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: CLUSTER,
        account: FEE_PAYER,
        simulationHash: f.evidence.hash,
        nonce: f.request.recentBlockhash,
        calldata: f.request.message,
        serializedTransaction: expect.objectContaining({
          messageHash: f.request.messageHash,
          transaction: f.request.transaction,
        }),
      }),
      expect.anything(),
    );
    expect(() =>
      f.orchestrator.assertExact(x.id, {
        ...f.request,
        transaction: exact(
          buildTransaction({
            payer: FEE_PAYER,
            instructions: [systemTransfer(FEE_PAYER, OUT, 2_000n)],
          }),
        ).request.transaction,
      }),
    ).toThrow(/exact transaction mismatch/);
    f.store.close();
  });

  it("issues an envelope, sends exactly {transaction, envelope}, and fences duplicate submit", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const q = await buy(f.orchestrator);
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
        audience: "daemon",
        policyVersion: 1,
      }),
    );
    // The wire shape the daemon actually speaks — not `{serialized}`.
    expect(f.signer.sign).toHaveBeenCalledWith({
      transaction: f.request.transaction,
      envelope: f.envelope,
    });
    expect(sent.state).toBe("broadcast");
    expect(sent.signature).toBe(f.signed.signature);
    expect(sent.messageHash).toBe(f.request.messageHash);
    expect(f.reservations.commit).toHaveBeenCalledWith("reservation-1");
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow(
      /not approved|in progress/,
    );
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
    f.store.close();
  });

  it("burns the execution when the blockhash dies, and never asks for a signature", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const q = await buy(f.orchestrator);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    vi.mocked(f.rpc.blockHeight).mockResolvedValue(LAST_VALID_BLOCK_HEIGHT + 1);
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow(
      "blockhash_expired",
    );
    // Terminal. A fresh blockhash is different bytes and needs a new decision.
    expect(f.store.get(x.id)?.state).toBe("expired");
    expect(f.reservations.release).toHaveBeenCalledWith("reservation-1");
    expect(f.signer.sign).not.toHaveBeenCalled();
    expect(f.issuer.issue).not.toHaveBeenCalled();
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow("not approved");
    f.store.close();
  });

  it("refuses to queue an approval for a transaction that can no longer land", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const q = await buy(f.orchestrator);
    vi.mocked(f.rpc.blockHeight).mockResolvedValue(LAST_VALID_BLOCK_HEIGHT + 1);
    await expect(
      f.orchestrator.execute(q.id, {
        idempotencyKey: "once",
        actor: "agent",
        dryRun: false,
      }),
    ).rejects.toThrow("blockhash_expired");
    expect(f.approvals.request).not.toHaveBeenCalled();
    f.store.close();
  });

  it("rejects a signer whose bytes do not carry the signature it reported", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    f.signer.sign.mockResolvedValue({
      transaction: f.signed.transaction,
      signature: sign(f.request.transaction, 2).signature,
    });
    const q = await buy(f.orchestrator);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow(
      "invalid_signer_response",
    );
    expect(f.rpc.broadcast).not.toHaveBeenCalled();
    expect(f.store.get(x.id)?.state).toBe("signing");
    f.store.close();
  });

  it("moves a mismatched broadcast answer to reconciliation with the signature kept", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    vi.mocked(f.rpc.broadcast).mockResolvedValue("some-other-signature");
    const q = await buy(f.orchestrator);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    await expect(f.orchestrator.submit(x.id)).rejects.toThrow(
      "broadcast_signature_mismatch",
    );
    const row = f.store.get(x.id)!;
    expect(row.state).toBe("reconciliation-required");
    // The signature was durable before the broadcast, so a reconciler can
    // still find out whether the transaction landed.
    expect(row.signature).toBe(f.signed.signature);
    expect(f.reservations.commit).not.toHaveBeenCalled();
    f.store.close();
  });

  it("accepts a signature the daemon broadcast itself", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    f.signer.sign.mockResolvedValue({
      ...f.signed,
      broadcast: f.signed.signature,
    });
    const q = await buy(f.orchestrator);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "once",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    expect((await f.orchestrator.submit(x.id)).state).toBe("broadcast");
    expect(f.rpc.broadcast).not.toHaveBeenCalled();
    f.store.close();
  });

  it("runs an SPL Token revoke through the full approval and signing pipeline", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const revoke = exact(
      buildTransaction({
        payer: FEE_PAYER,
        instructions: [tokenRevoke(TOKEN_ACCOUNT, FEE_PAYER)],
      }),
    );
    f.rpc.revokeQuote = vi.fn(async () => ({
      amountOut: 0n,
      slot: 10n,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      expiresAt: 20_000,
      request: revoke.request,
      evidence: revoke.evidence,
    }));
    vi.mocked(f.rpc.simulate).mockResolvedValue(revoke.evidence);
    f.signer.sign.mockResolvedValue(revoke.signed);
    const x = await f.orchestrator.revoke(TOKEN_ACCOUNT, {
      idempotencyKey: "revoke-1",
      actor: "operator",
      dryRun: false,
    });
    expect(x.state).toBe("awaiting-approval");
    expect(f.rpc.revokeQuote).toHaveBeenCalledWith({
      tokenAccount: TOKEN_ACCOUNT,
      owner: FEE_PAYER,
    });
    expect(f.approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        router: TOKEN_PROGRAM,
        value: "0",
        calldata: revoke.request.message,
      }),
      expect.anything(),
    );
    // Idempotent: the same key returns the same execution, not a second one.
    expect(
      (
        await f.orchestrator.revoke(TOKEN_ACCOUNT, {
          idempotencyKey: "revoke-1",
          actor: "operator",
          dryRun: false,
        })
      ).id,
    ).toBe(x.id);
    await f.orchestrator.refreshApproval(x.id);
    expect((await f.orchestrator.submit(x.id)).state).toBe("broadcast");
    expect(f.signer.sign).toHaveBeenCalledWith({
      transaction: revoke.request.transaction,
      envelope: f.envelope,
    });
    f.store.close();
  });

  it("defaults revokes to dry-run and fails closed without revoke support", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    await expect(
      f.orchestrator.revoke(TOKEN_ACCOUNT, {
        idempotencyKey: "r",
        actor: "operator",
      }),
    ).rejects.toThrow("revoke_unsupported");
    const revoke = exact(
      buildTransaction({
        payer: FEE_PAYER,
        instructions: [tokenRevoke(TOKEN_ACCOUNT, FEE_PAYER)],
      }),
    );
    f.rpc.revokeQuote = vi.fn(async () => ({
      amountOut: 0n,
      slot: 10n,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      expiresAt: 20_000,
      request: revoke.request,
      evidence: revoke.evidence,
    }));
    vi.mocked(f.rpc.simulate).mockResolvedValue(revoke.evidence);
    await expect(
      f.orchestrator.revoke("not-a-pubkey", {
        idempotencyKey: "bad",
        actor: "operator",
      }),
    ).rejects.toThrow(/tokenAccount/);
    const dry = await f.orchestrator.revoke(TOKEN_ACCOUNT, {
      idempotencyKey: "dry",
      actor: "operator",
    });
    expect(dry.state).toBe("dry-run");
    expect(dry.dryRun).toBe(true);
    f.store.close();
  });

  it("persists only the signature, never the signed bytes", async () => {
    const db = join(temp(), "trade.sqlite"),
      f = fixture(db);
    const q = await buy(f.orchestrator);
    const x = await f.orchestrator.execute(q.id, {
      idempotencyKey: "signature-only",
      actor: "agent",
      dryRun: false,
    });
    await f.orchestrator.refreshApproval(x.id);
    await f.orchestrator.submit(x.id);
    const persisted = f.store.get(x.id)!;
    expect(persisted.signature).toBe(f.signed.signature);
    expect(persisted.messageHash).toBe(f.request.messageHash);
    expect(persisted).not.toHaveProperty("signedTransaction");
    // The only copy of the signed bytes lives inside the signer's own store.
    expect(readFileSync(db, "utf8")).not.toContain(f.signed.transaction);
    f.store.close();
  });

  it("rejects evidence that describes a different message", async () => {
    const f = fixture(join(temp(), "trade.sqlite"));
    const other = exact(
      buildTransaction({
        payer: FEE_PAYER,
        instructions: [systemTransfer(FEE_PAYER, OUT, 7_000n)],
      }),
    );
    vi.mocked(f.rpc.simulate).mockResolvedValue(other.evidence);
    const q = await buy(f.orchestrator);
    await expect(
      f.orchestrator.execute(q.id, {
        idempotencyKey: "once",
        actor: "agent",
        dryRun: false,
      }),
    ).rejects.toThrow("simulation_transaction_mismatch");
    f.store.close();
  });
});
