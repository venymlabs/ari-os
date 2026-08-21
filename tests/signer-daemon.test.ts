import { afterEach, describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPrivatePath,
  createEncryptedKeystore,
  decodeTransaction,
  generateSecretKey,
  JsonFrameDecoder,
  loadSignPolicy,
  reconcileTransactions,
  SignerService,
  SqliteReplayStore,
  broadcastSigned,
  unlockKeystore,
  type AuthorizationClaims,
  type LoadedSignPolicy,
} from "../src/signer/index.js";
import { createSignerWireConfig } from "../src/bin/signer.js";
import { canSymlink, posixPermissions } from "./helpers.js";
import {
  buildTransaction,
  cleanupTempDirs,
  CLUSTER,
  createTestWallet,
  envelopeVerifier,
  h,
  makeEnvelope,
  pubkey,
  systemTransfer,
  tempDir,
  writePolicy,
  type TestWallet,
} from "./signer-fixtures.js";

const symlinksAvailable = canSymlink();
const DESTINATION = pubkey(9);
afterEach(cleanupTempDirs);

interface Harness {
  wallet: TestWallet;
  policy: LoadedSignPolicy;
  store: SqliteReplayStore;
  service: SignerService;
  db: string;
  transaction: string;
}
async function harness(
  dir: string,
  options: { blockHeight?: number; lamports?: bigint } = {},
): Promise<Harness> {
  const wallet = await createTestWallet(dir),
    account = await unlockKeystore(wallet.keystore, wallet.password),
    policy = await loadSignPolicy(await writePolicy(dir, wallet.publicKey)),
    db = join(dir, "replay.sqlite"),
    store = new SqliteReplayStore(db);
  const blockHeight = options.blockHeight ?? 100;
  return {
    wallet,
    policy,
    store,
    db,
    transaction: buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        systemTransfer(wallet.publicKey, DESTINATION, options.lamports ?? 1n),
      ],
    }),
    service: new SignerService(account, store, policy, {
      verifier: envelopeVerifier,
      audience: "daemon",
      cluster: CLUSTER,
      signerKeyId: "wallet",
      policyHash: policy.hash,
      policyVersion: policy.version,
      now: () => 1001,
      blockHeight: async () => blockHeight,
    }),
  };
}

describe("production signer primitives", () => {
  it("binds the daemon wire verifier to the loaded policy, cluster and authorization key ID", async () => {
    const policyHash = h("loaded-policy"),
      wire = createSignerWireConfig("auth-secret", "daemon", "auth-key-2", {
        hash: policyHash,
        version: 1,
        cluster: CLUSTER,
      });
    expect(wire).toMatchObject({
      audience: "daemon",
      cluster: CLUSTER,
      signerKeyId: "auth-key-2",
      authorizationKeyIds: ["auth-key-2"],
      policyHash,
      policyVersion: 1,
    });
    const claims = "signed claims",
      signature = createHmac("sha256", "auth-secret")
        .update(claims)
        .digest("hex");
    expect(await wire.verifier.verify(claims, signature, "auth-key-2")).toBe(
      true,
    );
    expect(await wire.verifier.verify(claims, signature, "auth-key-1")).toBe(
      false,
    );
  });

  it("rejects unsafe keystore KDF encodings and unsafe parent directories", async () => {
    const dir = tempDir("kdf-"),
      p = join(dir, "wallet.json"),
      secret = generateSecretKey();
    await chmod(dir, 0o700);
    await createEncryptedKeystore(p, secret, "password");
    secret.fill(0);
    const body = JSON.parse(await readFile(p, "utf8"));
    expect(body.crypto.kdfparams).toEqual({ N: 32768, r: 8, p: 1, dkLen: 32 });
    for (const mutation of [
      { N: 1 << 22, r: 8, p: 1, dkLen: 32 },
      { N: 16384, r: 0, p: 1, dkLen: 32 },
      { N: 16384, r: 8, p: 1, dkLen: 64 },
    ]) {
      body.crypto.kdfparams = mutation;
      await writeFile(p, JSON.stringify(body), { mode: 0o600 });
      await expect(unlockKeystore(p, "password")).rejects.toThrow(
        "keystore_kdf_invalid",
      );
    }
    if (posixPermissions) {
      await chmod(dir, 0o755);
      await expect(assertPrivatePath(p, "keystore", true)).rejects.toThrow(
        "keystore_parent_permissions_unsafe",
      );
      await chmod(dir, 0o700);
    }
  });

  it.skipIf(!symlinksAvailable)(
    "rejects path substitution through symlinked parent components",
    async () => {
      const root = tempDir("path-"),
        real = join(root, "real"),
        link = join(root, "link");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, link);
      await expect(
        assertPrivatePath(join(link, "wallet.json"), "keystore", false),
      ).rejects.toThrow("keystore_parent_symlink_forbidden");
    },
  );

  it("bounds newline JSON frames and rejects malformed input", () => {
    const d = new JsonFrameDecoder(32);
    expect(d.push(Buffer.from('{"a":1}\n'))).toEqual([{ a: 1 }]);
    expect(() => d.push(Buffer.from("{"))).not.toThrow();
    expect(() => d.push(Buffer.alloc(33, 1))).toThrow("frame_too_large");
    expect(() => new JsonFrameDecoder().push(Buffer.from("nope\n"))).toThrow(
      "frame_json_invalid",
    );
  });

  it("loads only regular mode-0600 policy files and exposes a stable hash", async () => {
    const dir = tempDir("policy-"),
      wallet = await createTestWallet(dir),
      p = await writePolicy(dir, wallet.publicKey);
    const loaded = await loadSignPolicy(p);
    expect(loaded.version).toBe(1);
    expect(loaded.cluster).toBe(CLUSTER);
    expect(loaded.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await loadSignPolicy(p)).hash).toBe(loaded.hash);
    if (posixPermissions) {
      await chmod(p, 0o644);
      await expect(loadSignPolicy(p)).rejects.toThrow(
        "policy_permissions_unsafe",
      );
      await chmod(p, 0o600);
    }
    if (symlinksAvailable) {
      const link = join(dir, "link");
      await symlink(p, link);
      await expect(loadSignPolicy(link)).rejects.toThrow(
        "policy_symlink_forbidden",
      );
    }
  });

  it("verifies the exact authorization envelope before signing and survives replay-store restart", async () => {
    const dir = tempDir("wire-sign-"),
      x = await harness(dir);
    const envelope = makeEnvelope(x.transaction, {
      policyHash: x.policy.hash,
      lastValidBlockHeight: 500,
    });
    const signed = await x.service.signEnvelope(x.transaction, envelope);
    expect(signed.transaction).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodeTransaction(signed.transaction).signatures[0]).toBe(
      signed.signature,
    );
    expect(x.store.get("auth-1")?.state).toBe("signed");
    x.store.close();

    // A restart re-reads the durable record and returns the same bytes
    // instead of producing a second signature.
    const reopened = new SqliteReplayStore(x.db),
      account = await unlockKeystore(x.wallet.keystore, x.wallet.password),
      again = new SignerService(account, reopened, x.policy, {
        verifier: envelopeVerifier,
        audience: "daemon",
        cluster: CLUSTER,
        signerKeyId: "wallet",
        policyHash: x.policy.hash,
        policyVersion: x.policy.version,
        now: () => 1001,
        blockHeight: async () => 100,
      });
    expect(await again.signEnvelope(x.transaction, envelope)).toEqual(signed);
    reopened.close();
  });

  it("refuses every way an envelope can disagree with the bytes it authorizes", async () => {
    const dir = tempDir("envelope-mismatch-"),
      x = await harness(dir);
    const other = buildTransaction({
      payer: x.wallet.publicKey,
      instructions: [systemTransfer(x.wallet.publicKey, DESTINATION, 2n)],
    });
    const decodedOther = decodeTransaction(other);
    const mutations: [
      string,
      (c: AuthorizationClaims) => AuthorizationClaims,
    ][] = [
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, transaction: decodedOther.wireBase64 }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, message: decodedOther.messageBase64 }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, messageHash: h("not-the-message") }),
      ],
      ["envelope_transaction_mismatch", (c) => ({ ...c, feePayer: pubkey(3) })],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, recentBlockhash: pubkey(31) }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, accountKeys: [...c.accountKeys].reverse() }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, programIds: [pubkey(2)] }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({
          ...c,
          instructions: c.instructions.map((i) => ({
            ...i,
            data: `${i.data.slice(0, -2)}ff`,
          })),
        }),
      ],
      [
        "envelope_transaction_mismatch",
        (c) => ({ ...c, addressTableLookups: [pubkey(20)] }),
      ],
      ["envelope_cluster_mismatch", (c) => ({ ...c, cluster: "devnet" })],
      ["envelope_audience_mismatch", (c) => ({ ...c, audience: "other" })],
      ["envelope_signer_mismatch", (c) => ({ ...c, signerKeyId: "other" })],
      ["envelope_policy_mismatch", (c) => ({ ...c, policyHash: h("x") })],
      ["envelope_policy_mismatch", (c) => ({ ...c, policyVersion: 2 })],
      ["envelope_version_invalid", (c) => ({ ...c, protocol: "evm" })],
      ["envelope_version_invalid", (c) => ({ ...c, version: 2 })],
      ["envelope_expired", (c) => ({ ...c, expiresAt: 1001 })],
      ["envelope_expired", (c) => ({ ...c, issuedAt: 0, expiresAt: 100_000 })],
      [
        "envelope_issued_in_future",
        (c) => ({ ...c, issuedAt: 5000, expiresAt: 6000 }),
      ],
      [
        "envelope_blockhash_invalid",
        (c) => ({ ...c, lastValidBlockHeight: -1 }),
      ],
    ];
    for (const [error, mutate] of mutations) {
      const envelope = makeEnvelope(x.transaction, {
        id: crypto.randomUUID(),
        policyHash: x.policy.hash,
        mutate,
      });
      await expect(
        x.service.signEnvelope(x.transaction, envelope),
      ).rejects.toThrow(error);
    }
    // A forged signature over otherwise-perfect claims.
    const forged = makeEnvelope(x.transaction, {
      id: crypto.randomUUID(),
      policyHash: x.policy.hash,
      key: "not-the-authorization-key",
    });
    await expect(x.service.signEnvelope(x.transaction, forged)).rejects.toThrow(
      "envelope_signature_invalid",
    );
    // Nothing above may have burned an authorization or produced a signature.
    expect(x.store.list(["claimed", "signed"])).toHaveLength(0);
    x.store.close();
  });

  it("consumes an envelope exactly once and never re-signs an expired blockhash", async () => {
    const dir = tempDir("envelope-replay-"),
      x = await harness(dir, { blockHeight: 1_000 });
    const live = makeEnvelope(x.transaction, {
      id: "live",
      policyHash: x.policy.hash,
      lastValidBlockHeight: 5_000,
    });
    await x.service.signEnvelope(x.transaction, live);
    // Replaying the same envelope returns the stored bytes, not a new signature.
    const repeat = await x.service.signEnvelope(x.transaction, live);
    expect(repeat.signature).toBe(
      decodeTransaction(repeat.transaction).signatures[0],
    );
    // A different envelope id over the same bytes is a fresh authorization.
    const second = makeEnvelope(x.transaction, {
      id: "second",
      policyHash: x.policy.hash,
      lastValidBlockHeight: 5_000,
    });
    expect(await x.service.signEnvelope(x.transaction, second)).toEqual(repeat);

    // Blockhash already dead: burned, terminal, and never re-signed.
    const dead = makeEnvelope(x.transaction, {
      id: "dead",
      policyHash: x.policy.hash,
      lastValidBlockHeight: 900,
    });
    await expect(x.service.signEnvelope(x.transaction, dead)).rejects.toThrow(
      "blockhash_expired",
    );
    expect(x.store.get("dead")?.state).toBe("expired");
    await expect(x.service.signEnvelope(x.transaction, dead)).rejects.toThrow(
      "authorization_expired",
    );
    // Re-issuing the same id with a longer claimed validity changes nothing.
    const revived = makeEnvelope(x.transaction, {
      id: "dead",
      policyHash: x.policy.hash,
      lastValidBlockHeight: 9_000,
    });
    await expect(
      x.service.signEnvelope(x.transaction, revived),
    ).rejects.toThrow("authorization_expired");
    x.store.close();
  });

  it("never consumes an authorization the signer's own policy rejects", async () => {
    const dir = tempDir("envelope-policy-"),
      x = await harness(dir, { lamports: 2_000_000n });
    const envelope = makeEnvelope(x.transaction, {
      id: "over-cap",
      policyHash: x.policy.hash,
    });
    await expect(
      x.service.signEnvelope(x.transaction, envelope),
    ).rejects.toThrow("policy_spend_cap");
    expect(x.store.get("over-cap")).toBeUndefined();
    x.store.close();
  });

  it("persists signed bytes before broadcast and treats a mismatched signature as unresolved", async () => {
    const dir = tempDir("broadcast-"),
      x = await harness(dir);
    const envelope = makeEnvelope(x.transaction, {
      policyHash: x.policy.hash,
      lastValidBlockHeight: 500,
    });
    const signed = await x.service.signEnvelope(x.transaction, envelope);
    expect(x.store.get("auth-1")?.state).toBe("signed");
    await expect(
      broadcastSigned(x.store, "auth-1", signed.transaction, async () =>
        pubkey(30),
      ),
    ).rejects.toThrow("broadcast_signature_mismatch");
    expect(x.store.get("auth-1")?.state).toBe("reconciliation");
    x.store.close();
  });

  it("broadcasts once and records the cluster-returned signature", async () => {
    const dir = tempDir("broadcast-ok-"),
      x = await harness(dir);
    const envelope = makeEnvelope(x.transaction, {
      policyHash: x.policy.hash,
      lastValidBlockHeight: 500,
    });
    const signed = await x.service.signEnvelope(x.transaction, envelope);
    const calls: string[] = [];
    const returned = await broadcastSigned(
      x.store,
      "auth-1",
      signed.transaction,
      async (method) => {
        calls.push(method);
        return signed.signature;
      },
    );
    expect(returned).toBe(signed.signature);
    expect(calls).toEqual(["sendTransaction"]);
    expect(x.store.get("auth-1")?.state).toBe("broadcast");
    // A second broadcast cannot re-send: the record is no longer `signed`.
    await expect(
      broadcastSigned(
        x.store,
        "auth-1",
        signed.transaction,
        async () => signed.signature,
      ),
    ).rejects.toThrow("broadcast_state_invalid");
    x.store.close();
  });

  it("reconciles broadcast records from signature statuses and block height", async () => {
    const store = new SqliteReplayStore(
      join(tempDir("reconcile-"), "r.sqlite"),
    );
    const record = async (id: string, data: Record<string, unknown>) => {
      await store.consume(id, 999);
      await store.transition(id, "claimed", "signed", JSON.stringify(data));
      await store.transition(id, "signed", "broadcast", JSON.stringify(data));
    };
    await record("confirmed", {
      signature: pubkey(41),
      lastValidBlockHeight: 500,
    });
    await record("failed", {
      signature: pubkey(42),
      lastValidBlockHeight: 500,
    });
    await record("gone", { signature: pubkey(43), lastValidBlockHeight: 500 });
    await record("pending", {
      signature: pubkey(44),
      lastValidBlockHeight: 5_000,
    });

    const calls: string[] = [];
    await reconcileTransactions(store, async (method, params) => {
      calls.push(method);
      if (method === "getBlockHeight") return 1_000;
      const signature = (params[0] as string[])[0];
      if (signature === pubkey(41))
        return { value: [{ err: null, confirmationStatus: "finalized" }] };
      if (signature === pubkey(42))
        return {
          value: [
            {
              err: { InstructionError: [0, "Custom"] },
              confirmationStatus: "confirmed",
            },
          ],
        };
      return { value: [null] };
    });
    expect(store.get("confirmed")?.state).toBe("confirmed");
    expect(store.get("failed")?.state).toBe("reverted");
    // Never seen and its blockhash is dead: terminal, and never re-signed.
    expect(store.get("gone")?.state).toBe("dropped");
    // Never seen but still landable: left alone.
    expect(store.get("pending")?.state).toBe("broadcast");
    expect(calls.filter((c) => c === "getSignatureStatuses")).toHaveLength(4);
    store.close();
  });

  it("promotes an unresolved broadcast back once the cluster reports the signature", async () => {
    const store = new SqliteReplayStore(join(tempDir("promote-"), "r.sqlite"));
    await store.consume("a", 999);
    await store.transition("a", "claimed", "signed", "{}");
    await store.transition(
      "a",
      "signed",
      "reconciliation",
      JSON.stringify({ expected: pubkey(45), lastValidBlockHeight: 500 }),
    );
    await reconcileTransactions(store, async () => ({
      value: [{ err: null, confirmationStatus: "processed" }],
    }));
    expect(store.get("a")?.state).toBe("broadcast");
    store.close();
  });
});
