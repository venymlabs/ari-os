import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  defaultKdfParams,
  deriveKek,
  Keystore,
  WALLET_SECRET_ID,
} from "../src/vault/index.js";
import { posixPermissions, removeDir } from "./helpers.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "vault-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));

const PASSPHRASE = "correct horse battery staple";

describe("vault crypto", () => {
  it("round-trips AES-256-GCM and fails the auth tag under the wrong key", () => {
    const kdf = defaultKdfParams();
    const key = deriveKek(PASSPHRASE, kdf);
    const ct = aesGcmEncrypt(key, Buffer.from("payload"));
    expect(aesGcmDecrypt(key, ct).toString()).toBe("payload");
    const wrong = deriveKek("different passphrase", kdf);
    expect(() => aesGcmDecrypt(wrong, ct)).toThrow();
  });

  it("uses a deliberately expensive scrypt cost and a fresh salt each time", () => {
    const a = defaultKdfParams();
    const b = defaultKdfParams();
    expect(a.N).toBe(32768);
    expect(a.keylen).toBe(32);
    expect(a.salt).not.toBe(b.salt);
  });
});

describe("keystore", () => {
  it("creates, locks, unlocks and refuses the wrong passphrase", () => {
    const path = join(temp(), "keystore.json");
    expect(Keystore.exists(path)).toBe(false);
    const ks = Keystore.init(path, PASSPHRASE);
    expect(Keystore.exists(path)).toBe(true);
    ks.put("llm.key", "llm_key", "k".repeat(40));
    expect(ks.locked).toBe(false);
    ks.lock();
    expect(ks.locked).toBe(true);
    expect(() => ks.reveal("llm.key")).toThrow(/locked/);

    const reopened = Keystore.unlock(path, PASSPHRASE);
    expect(reopened.reveal("llm.key").reveal()).toBe("k".repeat(40));
    expect(() => Keystore.unlock(path, "wrong passphrase")).toThrow(
      /incorrect passphrase/,
    );
  });

  it("refuses to clobber an existing keystore or accept a weak passphrase", () => {
    const path = join(temp(), "keystore.json");
    Keystore.init(path, PASSPHRASE);
    expect(() => Keystore.init(path, PASSPHRASE)).toThrow(/already exists/);
    expect(() => Keystore.init(join(temp(), "k.json"), "short")).toThrow(
      /at least 8/,
    );
    expect(() =>
      Keystore.unlock(join(temp(), "missing.json"), PASSPHRASE),
    ).toThrow(/no keystore/);
  });

  it("never writes plaintext to disk and zeroes the buffer handed to the callback", () => {
    const path = join(temp(), "keystore.json");
    const ks = Keystore.init(path, PASSPHRASE);
    const material = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    ks.put(WALLET_SECRET_ID, "wallet", Buffer.from(material));

    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("0123456789abcdef");
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1 });

    let escaped: Buffer | undefined;
    const seen = ks.use(WALLET_SECRET_ID, (bytes) => {
      escaped = bytes;
      return bytes.toString("utf8");
    });
    expect(seen).toBe(material.toString("utf8"));
    expect(escaped?.every((b) => b === 0)).toBe(true);
  });

  it("lists items with a last4 only for high-entropy strings", () => {
    const path = join(temp(), "keystore.json");
    const ks = Keystore.init(path, PASSPHRASE);
    ks.put("long", "service_key", "z".repeat(40));
    ks.put("short", "service_key", "abc");
    expect(ks.has("long")).toBe(true);
    expect(ks.has("absent")).toBe(false);
    const listed = Object.fromEntries(ks.list().map((i) => [i.id, i.last4]));
    expect(listed).toEqual({ long: "zzzz", short: undefined });
    expect(() => ks.use("absent", (b) => b)).toThrow(/no secret/);
  });

  it.skipIf(!posixPermissions)(
    "persists the keystore file private to the owner",
    () => {
      const path = join(temp(), "keystore.json");
      Keystore.init(path, PASSPHRASE);
      expect(statSync(path).mode & 0o077).toBe(0);
    },
  );
});
