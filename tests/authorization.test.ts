import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthorizationIssuer,
  AUTHORIZATION_PROTOCOL,
  HostAuthorizationVerifier,
  InMemoryReplayStore,
  type AuthorizationChecks,
  type AuthorizationEnvelope,
} from "../src/execution/authorization/index.js";
import { ExecutionGateway } from "../src/execution/gateway.js";
import {
  attachSignature,
  decodeTransaction,
} from "../src/signer/transaction.js";
import {
  loadSignPolicy,
  SignerService,
  unlockKeystore,
} from "../src/signer/index.js";
import { InMemoryReplayStore as SignerReplayStore } from "../src/signer/authorization.js";
import {
  CLUSTER,
  cleanupTempDirs,
  createTestWallet,
  envelopeSigner,
  envelopeVerifier,
  h,
  pubkey,
  systemTransfer,
  buildTransaction,
  tempDir,
  writePolicy,
} from "./signer-fixtures.js";
import {
  evidenceFor,
  LAST_VALID_BLOCK_HEIGHT,
  POLICY_HASH,
  simulationRequest,
} from "./execution-fixtures.js";

afterEach(() => cleanupTempDirs());

const refs = {
  quoteHash: h("quote"),
  policyHash: POLICY_HASH,
  policyVersion: 1,
  riskHash: h("risk"),
  reservationId: "reservation-1",
  approvalId: "approval-1",
  audience: "signer-prod",
};
const NOW = 1_000_000;

function setup(now = NOW, request = simulationRequest()) {
  const evidence = evidenceFor(request);
  const checks: AuthorizationChecks = {
    quote: async (x) => x === refs.quoteHash,
    policy: async (x) => x === refs.policyHash,
    risk: async (x) => x === refs.riskHash,
    reservation: async (x) => x === refs.reservationId,
    approval: async (x) => x === refs.approvalId,
    simulation: async (x) => x === evidence.hash,
    blockhash: async () => LAST_VALID_BLOCK_HEIGHT - 10,
  };
  const issuer = new AuthorizationIssuer({
    checks,
    signer: envelopeSigner,
    signerKeyId: "key-1",
    now: () => now,
    ttlMs: 5000,
  });
  return { request, evidence, issuer, checks, now };
}

const host = (overrides: Record<string, unknown> = {}) =>
  new HostAuthorizationVerifier({
    verifier: envelopeVerifier,
    replayStore: new InMemoryReplayStore(),
    now: () => NOW + 1,
    audience: refs.audience,
    ...overrides,
  });

/** Attach a deterministic 64-byte signature so the wire bytes are consistent. */
function signFake(transaction: string, byte = 1) {
  return attachSignature(
    decodeTransaction(transaction),
    new Uint8Array(64).fill(byte),
  );
}

describe("authorization issuance", () => {
  it("issues a short-lived envelope only after every current check passes", async () => {
    const { request, evidence, issuer } = setup();
    const { claims } = await issuer.issue(request, evidence, refs);
    expect(claims).toMatchObject({
      protocol: AUTHORIZATION_PROTOCOL,
      version: 1,
      signerKeyId: "key-1",
      cluster: CLUSTER,
      feePayer: request.feePayer,
      transaction: request.transaction,
      message: request.message,
      messageHash: request.messageHash,
      recentBlockhash: request.recentBlockhash,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      simulationHash: evidence.hash,
      approvalId: refs.approvalId,
      reservationId: refs.reservationId,
      audience: refs.audience,
      expiresAt: NOW + 5000,
    });
    expect(claims.programIds).toEqual(request.programIds);
    expect(claims.accountKeys).toEqual(request.accountKeys);
    expect(claims.instructions).toEqual(request.instructions);
    expect(claims.addressTableLookups).toEqual([]);
  });
  it("fails closed when any current check no longer holds", async () => {
    const { request, evidence } = setup();
    for (const name of [
      "quote",
      "policy",
      "risk",
      "reservation",
      "approval",
      "simulation",
      "blockhash",
    ] as const) {
      const { issuer, checks } = setup();
      (checks[name] as unknown) = async () => false;
      await expect(issuer.issue(request, evidence, refs)).rejects.toThrow(
        `authorization_${name}_invalid`,
      );
    }
  });
  it("refuses to authorize a blockhash the cluster has already passed", async () => {
    const { request, evidence, checks, issuer } = setup();
    checks.blockhash = async () => LAST_VALID_BLOCK_HEIGHT + 1;
    await expect(issuer.issue(request, evidence, refs)).rejects.toThrow(
      "authorization_blockhash_invalid",
    );
    // An observer that cannot see the height says so rather than guessing.
    checks.blockhash = async () => true;
    await expect(issuer.issue(request, evidence, refs)).resolves.toBeTruthy();
  });
  it("rejects unsafe TTL, policy divergence and recomputed evidence", async () => {
    const { request, evidence, checks } = setup();
    for (const ttlMs of [0, -1, 90_000])
      await expect(
        new AuthorizationIssuer({
          checks,
          signer: envelopeSigner,
          now: () => NOW,
          ttlMs,
        }).issue(request, evidence, refs),
      ).rejects.toThrow("authorization_ttl_invalid");
    await expect(
      setup().issuer.issue(request, evidence, {
        ...refs,
        policyHash: h("other"),
      }),
    ).rejects.toThrow("authorization_policy_invalid");
    await expect(
      setup().issuer.issue(
        request,
        { ...evidence, unitsConsumed: evidence.unitsConsumed + 1n },
        refs,
      ),
    ).rejects.toThrow("authorization_simulation_invalid");
    await expect(
      setup().issuer.issue(
        request,
        { ...evidence, messageHash: h("elsewhere") },
        refs,
      ),
    ).rejects.toThrow("authorization_simulation_invalid");
  });
  it("re-decodes the persisted bytes instead of trusting the stored projection", async () => {
    const { request, evidence, issuer } = setup();
    // A quote survives restarts on disk. If its projection is edited there,
    // the claims must not inherit the lie.
    await expect(
      issuer.issue({ ...request, feePayer: pubkey(8) }, evidence, refs),
    ).rejects.toThrow("authorization_transaction_invalid");
    await expect(
      issuer.issue({ ...request, programIds: [pubkey(8)] }, evidence, refs),
    ).rejects.toThrow("authorization_transaction_invalid");
  });
  it("aborts when the snapshot moved or the approval could not be consumed", async () => {
    const { request, evidence, checks } = setup();
    let version = 0;
    await expect(
      new AuthorizationIssuer({
        checks: { ...checks, snapshotVersion: async () => String(version++) },
        signer: envelopeSigner,
        now: () => NOW,
        ttlMs: 5000,
      }).issue(request, evidence, refs),
    ).rejects.toThrow("authorization_snapshot_changed");
    await expect(
      new AuthorizationIssuer({
        checks: { ...checks, consumeApprovalReservation: async () => false },
        signer: envelopeSigner,
        now: () => NOW,
        ttlMs: 5000,
      }).issue(request, evidence, refs),
    ).rejects.toThrow("authorization_consumption_invalid");
  });
});

describe("host authorization verification", () => {
  it("accepts an envelope that describes exactly the bytes it is shown", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs);
    const verified = await host().verify(request.transaction, envelope);
    expect(verified.transaction).toBe(request.transaction);
    expect(verified.envelope.claims.id).toBe(envelope.claims.id);
  });
  it("rejects a different transaction under the same envelope", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs);
    const other = simulationRequest({
      transaction: buildTransaction({
        payer: request.feePayer,
        instructions: [systemTransfer(request.feePayer, pubkey(9), 2_000n)],
      }),
    });
    await expect(host().verify(other.transaction, envelope)).rejects.toThrow(
      "envelope_transaction_mismatch",
    );
  });
  it("rejects expiry, future issuance, wrong audience, wrong cluster and a bad MAC", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs);
    for (const [overrides, error] of [
      [{ now: () => envelope.claims.expiresAt }, "envelope_expired"],
      [{ now: () => NOW - 1 }, "envelope_issued_in_future"],
      [{ audience: "other" }, "envelope_audience_mismatch"],
      [{ cluster: "devnet" }, "envelope_cluster_mismatch"],
    ] as const)
      await expect(
        host(overrides).verify(request.transaction, envelope),
      ).rejects.toThrow(error);
    await expect(
      host().verify(request.transaction, { ...envelope, signature: "bad" }),
    ).rejects.toThrow("envelope_signature_invalid");
  });
  it("burns the one-time authorization id", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs),
      replayStore = new InMemoryReplayStore(),
      verifier = host({ replayStore });
    await verifier.verify(request.transaction, envelope);
    expect(replayStore.states.get(envelope.claims.id)).toBe("claimed");
    await expect(
      verifier.verify(request.transaction, envelope),
    ).rejects.toThrow("envelope_replayed");
  });
  it("treats blockhash expiry as terminal and marks the authorization expired", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs),
      replayStore = new InMemoryReplayStore();
    await expect(
      host({
        replayStore,
        blockHeight: async () => LAST_VALID_BLOCK_HEIGHT + 1,
      }).verify(request.transaction, envelope),
    ).rejects.toThrow("envelope_blockhash_expired");
    expect(replayStore.states.get(envelope.claims.id)).toBe("expired");
    // Burned: the same envelope can never be presented again, expired or not.
    await expect(
      host({ replayStore }).verify(request.transaction, envelope),
    ).rejects.toThrow("envelope_replayed");
  });
  it("rejects a nonsense block height rather than assuming the fence passed", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs);
    await expect(
      host({ blockHeight: async () => Number.NaN }).verify(
        request.transaction,
        envelope,
      ),
    ).rejects.toThrow("block_height_invalid");
  });
  it("binds loaded policy identity and selects a rotated authorization key", async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs);
    const rotated = {
      verify: vi.fn(
        async (d: string, s: string, keyId?: string) =>
          keyId === "key-1" && envelopeVerifier.verify(d, s),
      ),
    };
    await expect(
      host({
        verifier: rotated,
        policyHash: refs.policyHash,
        policyVersion: 1,
        authorizationKeyIds: ["key-1", "key-2"],
      }).verify(request.transaction, envelope),
    ).resolves.toBeTruthy();
    expect(rotated.verify).toHaveBeenCalledWith(
      expect.any(String),
      envelope.signature,
      "key-1",
    );
    for (const p of [
      { policyHash: h("new"), policyVersion: 1 },
      { policyHash: refs.policyHash, policyVersion: 2 },
    ])
      await expect(
        host(p).verify(request.transaction, envelope),
      ).rejects.toThrow("envelope_policy_mismatch");
    await expect(
      host({
        verifier: rotated,
        authorizationKeyIds: ["key-2"],
      }).verify(request.transaction, envelope),
    ).rejects.toThrow("envelope_authorization_key_unknown");
    await expect(
      host({ signerKeyId: "wrong" }).verify(request.transaction, envelope),
    ).rejects.toThrow("envelope_signer_mismatch");
  });
});

describe("gateway execution", () => {
  const wire = async () => {
    const { request, evidence, issuer } = setup(),
      envelope = await issuer.issue(request, evidence, refs),
      replayStore = new InMemoryReplayStore(),
      signed = signFake(request.transaction);
    return { request, envelope, replayStore, signed };
  };
  it("verifies, signs, persists the signature and only then broadcasts", async () => {
    const { request, envelope, replayStore, signed } = await wire();
    const order: string[] = [];
    const gateway = new ExecutionGateway({
      simulate: async () => {
        throw Error("unused");
      },
      wireVerifier: host({ replayStore }),
      sign: async (transaction) => {
        expect(transaction).toBe(request.transaction);
        order.push("sign");
        return signed;
      },
      broadcast: async () => {
        // By the time the network sees anything, the signature is durable.
        expect(replayStore.states.get(envelope.claims.id)).toBe("signed");
        order.push("broadcast");
        return signed.signature;
      },
    });
    const result = await gateway.execute({
      transaction: request.transaction,
      envelope,
    });
    expect(order).toEqual(["sign", "broadcast"]);
    expect(result).toMatchObject({
      status: "BROADCAST",
      signature: signed.signature,
      messageHash: request.messageHash,
    });
    expect(replayStore.states.get(envelope.claims.id)).toBe("broadcast");
  });
  it("marks a failed signing attempt failed and never broadcasts", async () => {
    const { request, envelope, replayStore } = await wire();
    const broadcast = vi.fn(async () => "never");
    await expect(
      new ExecutionGateway({
        simulate: async () => {
          throw Error("unused");
        },
        wireVerifier: host({ replayStore }),
        sign: async () => {
          throw Error("signer_timeout");
        },
        broadcast,
      }).execute({ transaction: request.transaction, envelope }),
    ).rejects.toThrow("signer_timeout");
    expect(replayStore.states.get(envelope.claims.id)).toBe("failed");
    expect(broadcast).not.toHaveBeenCalled();
  });
  it("refuses a signer whose reported signature is not on the bytes it returned", async () => {
    const { request, envelope, replayStore, signed } = await wire();
    const broadcast = vi.fn(async () => "never");
    await expect(
      new ExecutionGateway({
        simulate: async () => {
          throw Error("unused");
        },
        wireVerifier: host({ replayStore }),
        sign: async () => ({
          transaction: signed.transaction,
          signature: signFake(request.transaction, 2).signature,
        }),
        broadcast,
      }).execute({ transaction: request.transaction, envelope }),
    ).rejects.toThrow("signer_signature_mismatch");
    expect(replayStore.states.get(envelope.claims.id)).toBe("failed");
    expect(broadcast).not.toHaveBeenCalled();
  });
  it.each([["", "other-signature"]].flat())(
    "moves a mismatched broadcast answer to reconciliation",
    async (returned) => {
      const { request, envelope, replayStore, signed } = await wire();
      await expect(
        new ExecutionGateway({
          simulate: async () => {
            throw Error("unused");
          },
          wireVerifier: host({ replayStore }),
          sign: async () => signed,
          broadcast: async () => returned,
        }).execute({ transaction: request.transaction, envelope }),
      ).rejects.toThrow("broadcast_signature_mismatch");
      expect(replayStore.states.get(envelope.claims.id)).toBe("reconciliation");
    },
  );
  it("moves a throwing broadcaster to reconciliation, not to failed", async () => {
    const { request, envelope, replayStore, signed } = await wire();
    await expect(
      new ExecutionGateway({
        simulate: async () => {
          throw Error("unused");
        },
        wireVerifier: host({ replayStore }),
        sign: async () => signed,
        broadcast: async () => {
          throw Error("rpc_down");
        },
      }).execute({ transaction: request.transaction, envelope }),
    ).rejects.toThrow("rpc_down");
    // The signature exists and may already have landed; only a reconciler
    // may decide what happened to it.
    expect(replayStore.states.get(envelope.claims.id)).toBe("reconciliation");
  });
  it("checks, rather than trusts, a signature the daemon broadcast itself", async () => {
    const { request, envelope, replayStore, signed } = await wire();
    const broadcast = vi.fn(async () => signed.signature);
    const result = await new ExecutionGateway({
      simulate: async () => {
        throw Error("unused");
      },
      wireVerifier: host({ replayStore }),
      sign: async () => ({ ...signed, broadcast: signed.signature }),
      broadcast,
    }).execute({ transaction: request.transaction, envelope });
    expect(result.signature).toBe(signed.signature);
    expect(broadcast).not.toHaveBeenCalled();
    expect(replayStore.states.get(envelope.claims.id)).toBe("broadcast");
    const second = await wire();
    await expect(
      new ExecutionGateway({
        simulate: async () => {
          throw Error("unused");
        },
        wireVerifier: host({ replayStore: second.replayStore }),
        sign: async () => ({ ...second.signed, broadcast: "different" }),
        broadcast,
      }).execute({
        transaction: second.request.transaction,
        envelope: second.envelope,
      }),
    ).rejects.toThrow("broadcast_signature_mismatch");
    expect(second.replayStore.states.get(second.envelope.claims.id)).toBe(
      "reconciliation",
    );
  });
});

describe("issuer and isolated signer agree on the wire", () => {
  it("produces an envelope the real SignerService accepts and signs", async () => {
    // The regression this exists for: the issuer and the signer are separate
    // processes with no shared runtime, so only a test that runs both can
    // prove their claim shapes still line up.
    const dir = tempDir("auth-signer-"),
      wallet = await createTestWallet(dir),
      account = await unlockKeystore(wallet.keystore, wallet.password),
      policy = await loadSignPolicy(await writePolicy(dir, wallet.publicKey)),
      transaction = buildTransaction({
        payer: wallet.publicKey,
        instructions: [systemTransfer(wallet.publicKey, pubkey(9), 1_000n)],
      });
    const request = simulationRequest({ transaction }),
      { issuer, evidence } = setup(NOW, request);
    const envelope: AuthorizationEnvelope = await issuer.issue(
      request,
      evidence,
      { ...refs, audience: "daemon" },
    );
    const replay = new SignerReplayStore(),
      service = new SignerService(account, replay, policy, {
        verifier: envelopeVerifier,
        audience: "daemon",
        cluster: CLUSTER,
        signerKeyId: "key-1",
        authorizationKeyIds: ["key-1"],
        now: () => NOW + 1,
        blockHeight: async () => LAST_VALID_BLOCK_HEIGHT - 1,
      });
    const signed = await service.signEnvelope(transaction, envelope);
    expect(decodeTransaction(signed.transaction).signatures[0]).toBe(
      signed.signature,
    );
    expect(replay.states.get(envelope.claims.id)).toBe("signed");
    // Same envelope, different bytes: the authorization already produced a
    // signature over one message and will not produce a second over another.
    await expect(
      service.signEnvelope(
        buildTransaction({
          payer: wallet.publicKey,
          instructions: [systemTransfer(wallet.publicKey, pubkey(9), 2_000n)],
        }),
        envelope,
      ),
    ).rejects.toThrow("authorization_request_mismatch");
    // Replaying the exact same request returns the stored signature rather
    // than signing again.
    expect(await service.signEnvelope(transaction, envelope)).toEqual(signed);
    account.lock();
  });
  it("is refused by the signer once the blockhash is past its last valid height", async () => {
    const dir = tempDir("auth-expiry-"),
      wallet = await createTestWallet(dir),
      account = await unlockKeystore(wallet.keystore, wallet.password),
      policy = await loadSignPolicy(await writePolicy(dir, wallet.publicKey)),
      transaction = buildTransaction({
        payer: wallet.publicKey,
        instructions: [systemTransfer(wallet.publicKey, pubkey(9), 1_000n)],
      });
    const one = setup(NOW, simulationRequest({ transaction })),
      envelope = await one.issuer.issue(one.request, one.evidence, {
        ...refs,
        audience: "daemon",
      });
    const replay = new SignerReplayStore(),
      service = new SignerService(account, replay, policy, {
        verifier: envelopeVerifier,
        audience: "daemon",
        cluster: CLUSTER,
        signerKeyId: "key-1",
        authorizationKeyIds: ["key-1"],
        now: () => NOW + 1,
        blockHeight: async () => LAST_VALID_BLOCK_HEIGHT + 1,
      });
    await expect(service.signEnvelope(transaction, envelope)).rejects.toThrow(
      "blockhash_expired",
    );
    expect(replay.states.get(envelope.claims.id)).toBe("expired");
    account.lock();
  });
});
