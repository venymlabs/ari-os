/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  DEFAULT_KEYSTORE_FILE,
  Keystore,
  WALLET_SECRET_ID,
} from "./keystore.js";
export type { SecretKind } from "./keystore.js";
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  defaultKdfParams,
  deriveKek,
} from "./crypto.js";
export type { Ciphertext, KdfParams } from "./crypto.js";
