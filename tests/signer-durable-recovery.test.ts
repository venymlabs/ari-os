import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachSignature,
  decodeTransaction,
  loadSignPolicy,
  SqliteReplayStore,
  SignerService,
  unlockKeystore,
} from "../src/signer/index.js";
import {
  buildSimulationRequest,
  createSimulationEvidence,
} from "../src/execution/simulation.js";
import {
  ExecutionStore,
  TradingOrchestrator,
  type IsolatedSigner,
  type TradingRpc,
} from "../src/live-trading/index.js";
import { removeDir } from "./helpers.js";
import {
  buildTransaction,
  CLUSTER,
  createTestWallet,
  pubkey,
  systemTransfer,
  writePolicy,
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
  const d = mkdtempSync(join(tmpdir(), "durable-sign-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));

const OUT = pubkey(4);

const transaction = buildTransaction({
  payer: FEE_PAYER,
  instructions: [systemTransfer(FEE_PAYER, OUT, 1_000n)],
});
const request = buildSimulationRequest(prepared({ transaction }), "policy");
const evidence = createSimulationEvidence(request, okResult(request));
const signed = attachSignature(
  decodeTransaction(transaction),
  new Uint8Array(64).fill(1),
);

/**
 * One execution that reached `signing` and then lost its signing response.
 *
 * This is the case that must never produce a second signature: the daemon may
 * already have signed, so recovery is a *lookup*, not a retry.
 */
async function stranded(signer: IsolatedSigner) {
  const db = join(temp(), "trading.sqlite");
  const rpc: TradingRpc = {
    balance: async () => 0n,
    quote: async () => ({
      amountOut: 9n,
      slot: 10n,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      expiresAt: 20_000,
      request,
      evidence,
    }),
    simulate: async () => evidence,
    broadcast: vi.fn(async () => signed.signature),
    status: async () => null,
    blockHeight: async () => LAST_VALID_BLOCK_HEIGHT - 100,
  };
  const issuer = {
      issue: vi.fn(async () => ({
        claims: { id: "auth-1" },
        signature: "sig",
      })),
    },
    reservations = {
      reserve: async () => "reservation",
      valid: async () => true,
      commit: vi.fn(async () => true),
      release: vi.fn(async () => true),
    };
  const make = (store: ExecutionStore) =>
    new TradingOrchestrator({
      cluster: CLUSTER,
      account: FEE_PAYER,
      liveEnabled: true,
      policy: {
        version: 1,
        hash: "policy",
        maxAmountIn: 100n,
        maxSlippageBps: 100,
        approvalRequired: true,
        finalityCommitment: "finalized",
      },
      rpc,
      store,
      signer,
      approvalEngine: {
        request: vi.fn(),
        get: vi.fn(() => ({ status: "approved" })),
        decide: vi.fn(),
        consume: vi.fn(),
      } as never,
      authorizationIssuer: issuer as never,
      risk: { assess: async () => ({ hash: "risk", allowed: true }) },
      reservations,
      clock: () => 1000,
    });
  const store = new ExecutionStore(db),
    o = make(store);
  const q = await o.quote({
    side: "buy",
    inputMint: MINT,
    outputMint: OUT,
    amountIn: 10n,
    slippageBps: 1,
  });
  const x = await o.execute(q.id, {
    idempotencyKey: "once",
    actor: "agent",
    dryRun: false,
  });
  await o.refreshApproval(x.id);
  await expect(o.submit(x.id)).rejects.toThrow("dropped_response");
  expect(store.get(x.id)).toMatchObject({
    state: "signing",
    authorizationId: "auth-1",
  });
  // Restart: a fresh store and orchestrator over the same database.
  store.close();
  const restarted = new ExecutionStore(db);
  return {
    id: x.id,
    store: restarted,
    o: make(restarted),
    rpc,
    issuer,
    reservations,
  };
}

const dropped = () =>
  vi.fn(async () => {
    throw Error("dropped_response");
  });

describe("durable signer result recovery", () => {
  it("atomically releases signed bytes to exactly one concurrent result caller", async () => {
    const dir = temp(),
      wallet = await createTestWallet(dir),
      owner = await unlockKeystore(wallet.keystore, wallet.password),
      policy = await loadSignPolicy(await writePolicy(dir, wallet.publicKey)),
      tx = buildTransaction({
        payer: wallet.publicKey,
        instructions: [systemTransfer(wallet.publicKey, pubkey(9), 1n)],
      }),
      messageHash = decodeTransaction(tx).messageHash,
      store = new SqliteReplayStore(join(dir, "signer.sqlite")),
      service = new SignerService(owner, store, policy);
    const result = await service.sign("auth", tx, wallet.publicKey);
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => service.result("auth", messageHash, true)),
      Promise.resolve().then(() => service.result("auth", messageHash, true)),
    ]);
    // The signed bytes are released to exactly one caller; both learn the
    // signature so neither is left guessing whether signing happened.
    expect(
      [a, b].filter((x) => "transaction" in x && x.transaction),
    ).toHaveLength(1);
    expect([a, b].map((x) => "signature" in x && x.signature)).toEqual([
      result.signature,
      result.signature,
    ]);
    expect(a.state).toBe("signed");
    expect(b.state).toBe("signed");
    store.close();
  });

  it("recovers a dropped signing response after restart and broadcasts exactly once", async () => {
    const sign = dropped(),
      result = vi.fn(async () => ({
        state: "signed" as const,
        signature: signed.signature,
        transaction: signed.transaction,
      }));
    const f = await stranded({ sign, result });
    expect(await f.o.recoverAndReconcile()).toMatchObject({
      recovered: 1,
      failed: 0,
    });
    expect(result).toHaveBeenCalledWith({
      authorizationId: "auth-1",
      messageHash: request.messageHash,
      recoverRaw: true,
    });
    // No second authorization and no second signature — only a lookup.
    expect(f.issuer.issue).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f.rpc.broadcast).toHaveBeenCalledTimes(1);
    expect(f.store.get(f.id)).toMatchObject({
      state: "broadcast",
      signature: signed.signature,
      messageHash: request.messageHash,
    });
    expect(f.reservations.commit).toHaveBeenCalledWith("reservation");
    f.store.close();
  });

  it("burns an execution whose authorization the signer already expired", async () => {
    const sign = dropped(),
      result = vi.fn(async () => ({ state: "expired" as const }));
    const f = await stranded({ sign, result });
    expect(await f.o.recoverAndReconcile()).toMatchObject({
      recovered: 0,
      failed: 1,
    });
    // Blockhash expiry inside custody is terminal on this side too.
    expect(f.store.get(f.id)?.state).toBe("expired");
    expect(f.reservations.release).toHaveBeenCalledWith("reservation");
    expect(f.rpc.broadcast).not.toHaveBeenCalled();
    f.store.close();
  });

  it("refuses to broadcast recovered bytes that do not carry the reported signature", async () => {
    const sign = dropped(),
      result = vi.fn(async () => ({
        state: "signed" as const,
        signature: "a-different-signature",
        transaction: signed.transaction,
      }));
    const f = await stranded({ sign, result });
    expect(await f.o.recoverAndReconcile()).toMatchObject({ failed: 1 });
    expect(f.store.get(f.id)?.state).toBe("signing");
    expect(f.rpc.broadcast).not.toHaveBeenCalled();
    f.store.close();
  });

  it("refuses to re-sign when the signer cannot report a prior result", async () => {
    const sign = dropped();
    const f = await stranded({ sign });
    expect(await f.o.recoverAndReconcile()).toMatchObject({ failed: 1 });
    expect(f.store.get(f.id)?.state).toBe("signing");
    expect(sign).toHaveBeenCalledTimes(1);
    f.store.close();
  });

  it("reports a signer that has no record of the authorization at all", async () => {
    const sign = dropped(),
      result = vi.fn(async () => ({ state: "not_found" as const }));
    const f = await stranded({ sign, result });
    expect(await f.o.recoverAndReconcile()).toMatchObject({ failed: 1 });
    expect(f.store.get(f.id)?.state).toBe("signing");
    f.store.close();
  });
});
