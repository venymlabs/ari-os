/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Secret } from "../kernel/secret.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type Ciphertext,
  defaultKdfParams,
  deriveKek,
  type KdfParams,
} from "./crypto.js";

export const WALLET_SECRET_ID = "wallet.primary";
export const DEFAULT_KEYSTORE_FILE = "keystore.json";

export type SecretKind = "wallet" | "llm_key" | "service_key";

interface KeystoreItem {
  readonly kind: SecretKind;
  readonly ct: Ciphertext;
  readonly last4: string | undefined;
  readonly createdAt: number;
}

interface KeystoreFile {
  readonly version: 1;
  readonly kdf: KdfParams;
  readonly wrappedDek: Ciphertext; // the data key, wrapped by the passphrase-derived KEK
  items: Record<string, KeystoreItem>;
}

/**
 * The on-machine, passphrase-locked keystore.
 *
 * Envelope encryption: a random 32-byte data key (DEK) encrypts every secret;
 * the DEK itself is wrapped by a KEK derived from the user's passphrase via
 * scrypt. Unlocking unwraps the DEK once and caches it in memory; per-secret
 * operations are local AES-256-GCM. The passphrase is never stored; the wrapped
 * DEK's GCM tag is what validates a correct passphrase. Nothing here ever leaves
 * the machine.
 */
export class Keystore {
  #path: string;
  #file: KeystoreFile;
  #dek: Buffer | null = null;

  private constructor(path: string, file: KeystoreFile) {
    this.#path = path;
    this.#file = file;
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }

  /** Create a brand-new keystore protected by `passphrase`. Throws if one already exists. */
  static init(path: string, passphrase: string): Keystore {
    if (existsSync(path)) throw new Error(`keystore already exists at ${path}`);
    assertPassphraseStrength(passphrase);
    const kdf = defaultKdfParams();
    const kek = deriveKek(passphrase, kdf);
    const dek = randomBytes(32);
    const wrappedDek = aesGcmEncrypt(kek, dek);
    kek.fill(0);
    const ks = new Keystore(path, { version: 1, kdf, wrappedDek, items: {} });
    ks.#dek = dek;
    ks.#persist();
    return ks;
  }

  /** Open an existing keystore and unlock it. A wrong passphrase fails the GCM tag and throws. */
  static unlock(path: string, passphrase: string): Keystore {
    if (!existsSync(path)) throw new Error(`no keystore at ${path}`);
    const file = JSON.parse(readFileSync(path, "utf8")) as KeystoreFile;
    const kek = deriveKek(passphrase, file.kdf);
    let dek: Buffer;
    try {
      dek = aesGcmDecrypt(kek, file.wrappedDek);
    } catch {
      throw new Error("incorrect passphrase");
    } finally {
      kek.fill(0);
    }
    const ks = new Keystore(path, file);
    ks.#dek = dek;
    return ks;
  }

  get locked(): boolean {
    return this.#dek === null;
  }

  lock(): void {
    if (this.#dek) {
      this.#dek.fill(0);
      this.#dek = null;
    }
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#file.items, id);
  }

  list(): { id: string; kind: SecretKind; last4: string | undefined }[] {
    return Object.entries(this.#file.items).map(([id, item]) => ({
      id,
      kind: item.kind,
      last4: item.last4,
    }));
  }

  put(id: string, kind: SecretKind, plaintext: Buffer | string): void {
    const dek = this.#requireDek();
    const buf =
      typeof plaintext === "string"
        ? Buffer.from(plaintext, "utf8")
        : plaintext;
    const ct = aesGcmEncrypt(dek, buf);
    const last4 =
      typeof plaintext === "string" && plaintext.length >= 32
        ? plaintext.slice(-4)
        : undefined;
    this.#file.items[id] = { kind, ct, last4, createdAt: Date.now() };
    this.#persist();
    if (typeof plaintext !== "string") buf.fill(0);
  }

  /** Decrypt a secret, run `fn` with the plaintext bytes, then zero them. Minimizes plaintext lifetime. */
  use<T>(id: string, fn: (bytes: Buffer) => T): T {
    const dek = this.#requireDek();
    const item = this.#file.items[id];
    if (!item) throw new Error(`no secret '${id}' in keystore`);
    const bytes = aesGcmDecrypt(dek, item.ct);
    try {
      return fn(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** Reveal a string secret as a Secret<string> (e.g. a BYOK key handed to a client). */
  reveal(id: string): Secret {
    return this.use(id, (bytes) => new Secret(bytes.toString("utf8"), id));
  }

  #requireDek(): Buffer {
    if (!this.#dek) throw new Error("keystore is locked");
    return this.#dek;
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

function assertPassphraseStrength(passphrase: string): void {
  if (passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }
}
