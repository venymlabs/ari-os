import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  chmod,
  symlink,
  readFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildSimulationRequest,
  createSimulationEvidence,
} from "../src/execution/simulation.js";
import {
  AuthorizationIssuer,
  canonicalClaims,
} from "../src/execution/authorization/index.js";
import {
  createEncryptedKeystore,
  unlockKeystore,
  loadSignPolicy,
  SqliteReplayStore,
  SignerService,
  JsonFrameDecoder,
  reconcileTransactions,
  assertPrivatePath,
} from "../src/signer/index.js";
import { createSignerWireConfig } from "../src/bin/signer.js";
import { canSymlink, posixPermissions } from "./helpers.js";
const symlinksAvailable = canSymlink();

const h = (x: string) => `0x${createHash("sha256").update(x).digest("hex")}`;
const macKey = "wire-test-key";
const verifier = {
  verify: async (d: string, s: string) =>
    createHmac("sha256", macKey).update(d).digest("hex") === s,
};
const signer = {
  sign: async (d: string) =>
    createHmac("sha256", macKey).update(d).digest("hex"),
};

describe("production signer primitives", () => {
  it("binds the daemon wire verifier to the loaded policy and selected authorization key ID", async () => {
    const policyHash = h("loaded-policy"),
      wire = createSignerWireConfig("auth-secret", "daemon", "auth-key-2", {
        hash: policyHash,
        version: 1,
      });
    expect(wire).toMatchObject({
      audience: "daemon",
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
    const dir = await mkdtemp(join(tmpdir(), "kdf-")),
      p = join(dir, "wallet.json"),
      key = generatePrivateKey();
    await chmod(dir, 0o700);
    await createEncryptedKeystore(p, key, "password");
    const body = JSON.parse(await readFile(p, "utf8"));
    expect(body.crypto.kdfparams).toEqual({ N: 16384, r: 8, p: 1, dkLen: 32 });
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
    }
  });
  it.skipIf(!symlinksAvailable)(
    "rejects path substitution through symlinked parent components",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "path-")),
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
    const dir = await mkdtemp(join(tmpdir(), "policy-")),
      p = join(dir, "policy.json");
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        chainIds: [46630],
        accounts: ["0x0000000000000000000000000000000000000001"],
        to: ["0x0000000000000000000000000000000000000002"],
        maxValue: "10",
        maxGas: "100000",
        maxFeePerGas: "20",
        maxPriorityFeePerGas: "2",
        dataPrefixes: ["0x12345678"],
      }),
      { mode: 0o600 },
    );
    const loaded = await loadSignPolicy(p);
    expect(loaded.version).toBe(1);
    expect(loaded.hash).toMatch(/^0x[0-9a-f]{64}$/);
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
    const dir = await mkdtemp(join(tmpdir(), "wire-sign-")),
      key = generatePrivateKey(),
      account = privateKeyToAccount(key);
    const tx = {
      chainId: 46630,
      from: account.address,
      to: "0x0000000000000000000000000000000000000002" as const,
      data: "0x12345678" as const,
      value: 1n,
      gas: 100000n,
      nonce: 7,
      type: "eip1559" as const,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      accessList: [],
    };
    const req = buildSimulationRequest(tx, h("policy"));
    const sim = {
      success: true,
      blockNumber: 1n,
      blockHash: h("block"),
      transactionHash: req.transactionHash,
      gasUsed: 1n,
      stateDiffs: [],
      events: [],
      assetDeltas: [],
    };
    const evidence = createSimulationEvidence(req, sim);
    const refs = {
      quoteHash: h("q"),
      policyHash: h("policy"),
      policyVersion: 1,
      riskHash: h("r"),
      reservationId: "res",
      approvalId: "app",
      audience: "daemon",
      signerKeyId: "wallet",
    };
    const checks = {
      quote: async () => true,
      policy: async () => true,
      risk: async () => true,
      reservation: async () => true,
      approval: async () => true,
      simulation: async () => true,
      nonce: async () => 7,
    };
    const envelope = await new AuthorizationIssuer({
      checks,
      signer,
      now: () => 1000,
      ttlMs: 5000,
    }).issue(req, evidence, refs);
    const db = join(dir, "r.sqlite");
    let replay = new SqliteReplayStore(db);
    let svc = new SignerService(
      account,
      replay,
      {
        chainIds: [46630],
        accounts: [account.address],
        to: [tx.to],
        maxValue: 10n,
        maxGas: 100000n,
        maxFeePerGas: 20n,
        maxPriorityFeePerGas: 2n,
        dataPrefixes: ["0x12345678"],
      },
      {
        verifier,
        audience: "daemon",
        signerKeyId: "wallet",
        now: () => 1001,
        nonce: async () => 7,
      },
    );
    expect(await svc.signEnvelope(req.serialized, envelope)).toMatch(/^0x/);
    replay.close();
    replay = new SqliteReplayStore(db);
    svc = new SignerService(
      account,
      replay,
      {
        chainIds: [46630],
        accounts: [account.address],
        to: [tx.to],
        maxValue: 10n,
        maxGas: 100000n,
        maxFeePerGas: 20n,
        maxPriorityFeePerGas: 2n,
        dataPrefixes: ["0x12345678"],
      },
      {
        verifier,
        audience: "daemon",
        signerKeyId: "wallet",
        now: () => 1001,
        nonce: async () => 7,
      },
    );
    expect(await svc.signEnvelope(req.serialized, envelope)).toMatch(/^0x/);
    expect(canonicalClaims(envelope.claims)).not.toContain(key.slice(2));
    replay.close();
  });
  it("reconciles broadcast records using receipts then transaction lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reconcile-")),
      store = new SqliteReplayStore(join(dir, "r.sqlite"));
    await store.consume("a", 999);
    await store.transition("a", "claimed", "signed", "0xraw");
    await store.transition(
      "a",
      "signed",
      "broadcast",
      JSON.stringify({ hash: h("tx"), raw: "0xraw" }),
    );
    const calls: string[] = [];
    await reconcileTransactions(store, async (method) => {
      calls.push(method);
      return method === "eth_getTransactionReceipt"
        ? { status: "0x1", blockNumber: "0x2" }
        : null;
    });
    expect(store.get("a")?.state).toBe("confirmed");
    expect(calls).toEqual(["eth_getTransactionReceipt"]);
    store.close();
  });
});
