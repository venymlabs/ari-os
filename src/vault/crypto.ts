/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface KdfParams {
  readonly salt: string; // base64
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

export interface Ciphertext {
  readonly iv: string; // base64
  readonly authTag: string; // base64
  readonly data: string; // base64
}

/** scrypt N=2^15 — a deliberately expensive KDF so a stolen keystore file resists offline guessing. */
export function defaultKdfParams(): KdfParams {
  return {
    salt: randomBytes(16).toString("base64"),
    N: 32768,
    r: 8,
    p: 1,
    keylen: 32,
  };
}

export function deriveKek(passphrase: string, kdf: KdfParams): Buffer {
  const salt = Buffer.from(kdf.salt, "base64");
  return scryptSync(passphrase, salt, kdf.keylen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    data: data.toString("base64"),
  };
}

/** Decrypt. A wrong key (wrong passphrase) fails the GCM auth tag and throws. */
export function aesGcmDecrypt(key: Buffer, ct: Ciphertext): Buffer {
  const iv = Buffer.from(ct.iv, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(ct.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct.data, "base64")),
    decipher.final(),
  ]);
}
