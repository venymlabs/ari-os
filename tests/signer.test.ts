import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTransactionAddress } from "viem";
import {
  createEncryptedKeystore,
  unlockKeystore,
  SqliteReplayStore,
  SignerService,
  type SignPolicy,
} from "../src/signer/index.js";
import { posixPermissions } from "./helpers.js";

const policy: SignPolicy = {
  chainIds: [46630],
  accounts: [],
  to: ["0x0000000000000000000000000000000000000002"],
  maxValue: 10n,
  maxGas: 100000n,
  maxFeePerGas: 20n,
  maxPriorityFeePerGas: 2n,
  dataPrefixes: ["0x12345678"],
};
const tx = {
  chainId: 46630,
  to: policy.to[0]!,
  data: "0x12345678" as const,
  value: 1n,
  gas: 100000n,
  nonce: 7,
  type: "eip1559" as const,
  maxFeePerGas: 20n,
  maxPriorityFeePerGas: 2n,
  accessList: [],
} as const;

describe("isolated signer", () => {
  it("writes an authenticated encrypted mode-0600 keystore and rejects wrong passwords or tampering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "signer-")),
      path = join(dir, "wallet.json"),
      key = generatePrivateKey();
    const address = await createEncryptedKeystore(path, key, "correct horse");
    expect(address).toBe(privateKeyToAccount(key).address);
    if (posixPermissions) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toContain(
      key.slice(2),
    );
    await expect(unlockKeystore(path, "wrong")).rejects.toThrow(
      "keystore_decryption_failed",
    );
    const json = JSON.parse(await readFile(path, "utf8"));
    json.crypto.ciphertext = json.crypto.ciphertext.replace(
      /.$/,
      json.crypto.ciphertext.endsWith("0") ? "1" : "0",
    );
    await writeFile(path, JSON.stringify(json));
    await expect(unlockKeystore(path, "correct horse")).rejects.toThrow(
      "keystore_decryption_failed",
    );
  });
  it("durably consumes once and fences state transitions across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replay-")),
      path = join(dir, "replay.sqlite");
    let a = new SqliteReplayStore(path);
    expect(await a.consume("id", 9999)).toBe(true);
    expect(await a.transition("id", "claimed", "signed", "0xabc")).toBe(true);
    a.close();
    a = new SqliteReplayStore(path);
    expect(await a.consume("id", 9999)).toBe(false);
    expect(await a.transition("id", "claimed", "failed")).toBe(false);
    expect(await a.transition("id", "signed", "broadcast", "0xdef")).toBe(true);
    expect(a.get("id")?.state).toBe("broadcast");
    a.close();
  });
  it("signs only exact authorized bytes and returns the durable result idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "service-")),
      key = generatePrivateKey(),
      account = privateKeyToAccount(key),
      db = join(dir, "r.sqlite"),
      p = { ...policy, accounts: [account.address] };
    let replay = new SqliteReplayStore(db),
      service = new SignerService(account, replay, p);
    const signed = await service.sign("auth-1", tx, account.address);
    expect(
      (
        await recoverTransactionAddress({
          serializedTransaction: signed as `0x02${string}`,
        })
      ).toLowerCase(),
    ).toBe(account.address.toLowerCase());
    replay.close();
    replay = new SqliteReplayStore(db);
    service = new SignerService(account, replay, p);
    expect(await service.sign("auth-1", tx, account.address)).toBe(signed);
    await expect(
      service.sign("auth-1", { ...tx, nonce: 8 }, account.address),
    ).rejects.toThrow("authorization_request_mismatch");
    for (const bad of [
      { ...tx, chainId: 1 },
      { ...tx, to: "0x0000000000000000000000000000000000000003" as const },
      { ...tx, value: 11n },
      { ...tx, nonce: -1 },
      { ...tx, maxFeePerGas: 21n },
      { ...tx, data: "0xdeadbeef" as const },
    ])
      await expect(
        service.sign(crypto.randomUUID(), bad, account.address),
      ).rejects.toThrow("policy_");
    replay.close();
  });
  it("never consumes replay authorization when policy validation fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-")),
      key = generatePrivateKey(),
      account = privateKeyToAccount(key),
      replay = new SqliteReplayStore(join(dir, "r.sqlite"));
    const service = new SignerService(account, replay, {
      ...policy,
      accounts: [account.address],
    });
    await expect(
      service.sign("same", { ...tx, chainId: 1 }, account.address),
    ).rejects.toThrow("policy_chain");
    expect(await service.sign("same", tx, account.address)).toMatch(/^0x/);
    replay.close();
  });
});
