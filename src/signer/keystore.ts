import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scrypt as scryptCallback,
  sign as ed25519Sign,
  timingSafeEqual,
} from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, parse, resolve as resolvePath } from "node:path";
import bs58 from "bs58";
import { enforceRealpathIdentity, permissionsAreUnsafe } from "../platform.js";

/**
 * scrypt N=2^15. Deliberately expensive so a stolen keystore file resists
 * offline guessing. The parameters are recorded in the file and re-validated
 * on unlock so a tampered file cannot downgrade the KDF.
 */
const KDF = { N: 32768, r: 8, p: 1, dkLen: 32 } as const;
export type KdfParams = { N: number; r: number; p: number; dkLen: number };
function validKdf(x: unknown): x is KdfParams {
  if (!x || typeof x !== "object") return false;
  const k = x as Record<string, unknown>;
  return (
    Number.isSafeInteger(k.N) &&
    (k.N as number) >= 16384 &&
    (k.N as number) <= 262144 &&
    ((k.N as number) & ((k.N as number) - 1)) === 0 &&
    Number.isSafeInteger(k.r) &&
    (k.r as number) >= 1 &&
    (k.r as number) <= 16 &&
    Number.isSafeInteger(k.p) &&
    (k.p as number) >= 1 &&
    (k.p as number) <= 4 &&
    k.dkLen === 32 &&
    128 * (k.N as number) * (k.r as number) <= 512 * 1024 * 1024
  );
}
const scrypt = (password: string, salt: Buffer, k: KdfParams = KDF) =>
  new Promise<Buffer>((ok, fail) =>
    scryptCallback(
      password,
      salt,
      k.dkLen,
      { N: k.N, r: k.r, p: k.p, maxmem: 512 * 1024 * 1024 },
      (error, key) => (error ? fail(error) : ok(key)),
    ),
  );

/** AES-256-GCM ciphertext, hex encoded. */
type Ciphertext = { iv: string; tag: string; ciphertext: string };
const HEX = /^[0-9a-f]+$/i;
function validCiphertext(x: unknown, bytes?: number): x is Ciphertext {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.iv === "string" &&
    c.iv.length === 24 &&
    HEX.test(c.iv) &&
    typeof c.tag === "string" &&
    c.tag.length === 32 &&
    HEX.test(c.tag) &&
    typeof c.ciphertext === "string" &&
    HEX.test(c.ciphertext) &&
    (bytes === undefined || c.ciphertext.length === bytes * 2)
  );
}
function encrypt(key: Buffer, plaintext: Buffer): Ciphertext {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}
function decrypt(key: Buffer, c: Ciphertext): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(c.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(c.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(c.ciphertext, "hex")),
    decipher.final(),
  ]);
}

/**
 * Envelope-encrypted Ed25519 keystore.
 *
 * A random 32-byte data key (DEK) encrypts the wallet secret; the DEK itself
 * is wrapped by a KEK derived from the passphrase via scrypt. The passphrase
 * is never stored — the wrapped DEK's GCM tag is what proves it correct.
 */
export type KeystoreFile = {
  version: 2;
  curve: "ed25519";
  publicKey: string;
  crypto: {
    cipher: "aes-256-gcm";
    kdf: "scrypt";
    kdfparams: KdfParams;
    salt: string;
    wrappedDek: Ciphertext;
    secretKey: Ciphertext;
  };
};

export async function assertPrivatePath(
  path: string,
  label: string,
  exists: boolean,
) {
  const absolute = resolvePath(path),
    root = parse(absolute).root,
    immediate = dirname(absolute);
  let current = immediate;
  while (current !== root) {
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw Error(`${label}_parent_symlink_forbidden`);
    if (!st.isDirectory()) throw Error(`${label}_parent_invalid`);
    const resolved = await realpath(current);
    if (enforceRealpathIdentity && resolved !== current)
      throw Error(`${label}_parent_symlink_forbidden`);
    if (current === immediate && permissionsAreUnsafe(st))
      throw Error(`${label}_parent_permissions_unsafe`);
    current = dirname(current);
  }
  if (exists) {
    const st = await lstat(absolute);
    if (st.isSymbolicLink()) throw Error(`${label}_symlink_forbidden`);
    if (!st.isFile()) throw Error(`${label}_format_invalid`);
    if (permissionsAreUnsafe(st)) throw Error(`${label}_permissions_unsafe`);
  }
}

/** PKCS#8 prefix for a raw 32-byte Ed25519 seed (RFC 8410 OID 1.3.101.112). */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
/** Derive the 32-byte Ed25519 public key from a 32-byte seed. */
function publicKeyFromSeed(seed: Buffer): Buffer {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    const spki = createPublicKey(
      createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
    ).export({ format: "der", type: "spki" });
    return Buffer.from(spki.subarray(spki.length - 32));
  } finally {
    der.fill(0);
  }
}

/**
 * Parse an operator-supplied Ed25519 secret into the canonical 64-byte
 * `seed || publicKey` form. Accepts the two formats real Solana tooling
 * emits — `solana-keygen`'s JSON byte array and wallet-exported base58 —
 * plus a bare 32-byte seed. Anything else is rejected rather than guessed.
 */
export function parseSecretKey(input: string): Uint8Array {
  const text = input.trim();
  let bytes: Buffer;
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Error("secret_key_invalid");
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)
    )
      throw Error("secret_key_invalid");
    bytes = Buffer.from(parsed as number[]);
  } else {
    try {
      bytes = Buffer.from(bs58.decode(text));
    } catch {
      throw Error("secret_key_invalid");
    }
  }
  if (bytes.length === 32) {
    const seed = bytes;
    const out = Buffer.concat([seed, publicKeyFromSeed(seed)]);
    seed.fill(0);
    return out;
  }
  if (bytes.length !== 64) {
    bytes.fill(0);
    throw Error("secret_key_invalid");
  }
  const seed = bytes.subarray(0, 32),
    claimed = bytes.subarray(32),
    derived = publicKeyFromSeed(seed);
  const consistent = derived.equals(claimed);
  derived.fill(0);
  if (!consistent) {
    bytes.fill(0);
    throw Error("secret_key_invalid");
  }
  return bytes;
}

/** Generate a fresh Ed25519 keypair. The secret never leaves this process. */
export function generateSecretKey(): Uint8Array {
  const seed = randomBytes(32),
    out = Buffer.concat([seed, publicKeyFromSeed(seed)]);
  seed.fill(0);
  return out;
}

/**
 * Write a new mode-0600 keystore. Refuses to overwrite an existing file and
 * zeroes every intermediate buffer. Returns the base58 public key.
 */
export async function createEncryptedKeystore(
  path: string,
  secretKey: Uint8Array,
  password: string,
): Promise<string> {
  if (secretKey.length !== 64) throw Error("secret_key_invalid");
  if (!password) throw Error("password_required");
  await assertPrivatePath(path, "keystore", false);
  const plain = Buffer.from(secretKey),
    salt = randomBytes(32),
    dek = randomBytes(32);
  let kek: Buffer | undefined;
  try {
    const derived = publicKeyFromSeed(plain.subarray(0, 32));
    if (!derived.equals(plain.subarray(32))) throw Error("secret_key_invalid");
    kek = await scrypt(password, salt);
    const body: KeystoreFile = {
      version: 2,
      curve: "ed25519",
      publicKey: bs58.encode(derived),
      crypto: {
        cipher: "aes-256-gcm",
        kdf: "scrypt",
        kdfparams: { ...KDF },
        salt: salt.toString("hex"),
        wrappedDek: encrypt(kek, dek),
        secretKey: encrypt(dek, plain),
      },
    };
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(body));
      await file.sync();
    } finally {
      await file.close();
    }
    return body.publicKey;
  } finally {
    plain.fill(0);
    dek.fill(0);
    kek?.fill(0);
  }
}

/**
 * An unlocked signing identity.
 *
 * Only the public key and the unwrapped DEK live in memory between calls; the
 * Ed25519 secret is decrypted inside `signMessage`, used once, and zeroed
 * immediately. It is never written anywhere and never appears in a log line.
 */
export interface SignerAccount {
  /** base58 Ed25519 public key */
  readonly publicKey: string;
  /** Raw 64-byte Ed25519 signature over `message`. */
  signMessage(message: Uint8Array): Uint8Array;
}

export class KeystoreAccount implements SignerAccount {
  #dek: Buffer | null;
  constructor(
    readonly publicKey: string,
    private readonly secret: Ciphertext,
    dek: Buffer,
  ) {
    this.#dek = dek;
  }
  get locked() {
    return this.#dek === null;
  }
  /** Drop the data key. Subsequent signing attempts fail closed. */
  lock() {
    this.#dek?.fill(0);
    this.#dek = null;
  }
  signMessage(message: Uint8Array): Uint8Array {
    const dek = this.#dek;
    if (!dek) throw Error("keystore_locked");
    const plain = decrypt(dek, this.secret);
    const der = Buffer.concat([
      PKCS8_ED25519_PREFIX,
      plain.subarray(0, 32),
    ]) as Buffer;
    try {
      // Node holds its own copy inside the KeyObject for the lifetime of the
      // handle; scoping it to this call is the tightest bound available
      // without a native secure-memory allocator.
      const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      return new Uint8Array(ed25519Sign(null, Buffer.from(message), key));
    } finally {
      der.fill(0);
      plain.fill(0);
    }
  }
}

/**
 * Open and unlock a keystore. Failures below the structural checks are
 * deliberately opaque: a wrong passphrase, a tampered ciphertext and a
 * corrupt file are indistinguishable to the caller.
 */
export async function unlockKeystore(
  path: string,
  password: string,
): Promise<KeystoreAccount> {
  let kek: Buffer | undefined,
    dek: Buffer | undefined,
    plain: Buffer | undefined;
  try {
    await assertPrivatePath(path, "keystore", true);
    const body = JSON.parse(await readFile(path, "utf8")) as KeystoreFile;
    if (
      body.version !== 2 ||
      body.curve !== "ed25519" ||
      body.crypto?.cipher !== "aes-256-gcm" ||
      body.crypto?.kdf !== "scrypt" ||
      typeof body.publicKey !== "string"
    )
      throw Error("keystore_format_invalid");
    if (!validKdf(body.crypto.kdfparams)) throw Error("keystore_kdf_invalid");
    if (
      !/^[0-9a-f]{64}$/i.test(body.crypto.salt) ||
      !validCiphertext(body.crypto.wrappedDek, 32) ||
      !validCiphertext(body.crypto.secretKey, 64)
    )
      throw Error("keystore_format_invalid");
    kek = await scrypt(
      password,
      Buffer.from(body.crypto.salt, "hex"),
      body.crypto.kdfparams,
    );
    dek = decrypt(kek, body.crypto.wrappedDek);
    plain = decrypt(dek, body.crypto.secretKey);
    const derived = publicKeyFromSeed(plain.subarray(0, 32)),
      claimed = bs58.decode(body.publicKey);
    if (
      claimed.length !== 32 ||
      !timingSafeEqual(derived, Buffer.from(claimed)) ||
      !derived.equals(plain.subarray(32))
    )
      throw Error("public key mismatch");
    return new KeystoreAccount(body.publicKey, body.crypto.secretKey, dek);
  } catch (error) {
    dek?.fill(0);
    if (
      error instanceof Error &&
      /permissions|format|symlink|kdf/.test(error.message)
    )
      throw error;
    // Deliberately opaque: decryption failures must not leak which stage
    // failed (wrong password, tampered ciphertext, corrupt file).
    // eslint-disable-next-line preserve-caught-error
    throw Error("keystore_decryption_failed");
  } finally {
    kek?.fill(0);
    plain?.fill(0);
  }
}
