/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { SignedTx, WalletProvider } from "../../kernel/contracts.js";
import { Keystore, WALLET_SECRET_ID } from "../../vault/index.js";

export interface GeneratedWallet {
  readonly pubkey: string;
  readonly secretKey: Uint8Array;
}

/** Generate a fresh Solana keypair locally. The secret never leaves this process. */
export function generateWallet(): GeneratedWallet {
  const kp = Keypair.generate();
  return { pubkey: kp.publicKey.toBase58(), secretKey: kp.secretKey };
}

/** Persist a generated wallet's secret key into the (unlocked) keystore, then zero the source. */
export function storeWallet(ks: Keystore, secretKey: Uint8Array): void {
  const buf = Buffer.from(secretKey);
  ks.put(WALLET_SECRET_ID, "wallet", buf);
  buf.fill(0);
}

/**
 * The in-process {@link WalletProvider}. It holds only the public key; the
 * private key is loaded transiently from the keystore inside `sign()` and zeroed
 * immediately after. One canonical representation is used throughout — base64
 * wire — via web3.js `VersionedTransaction`, which round-trips both legacy and
 * v0 transactions (what Jupiter and the other aggregators emit).
 *
 * This is the lower-assurance custody option. ARI OS's stronger posture keeps
 * key material in the separate signer process; both satisfy the same
 * `WalletProvider` seam, so the kernel is indifferent to which is wired in.
 */
export class LocalWallet implements WalletProvider {
  readonly pubkey: string;
  #ks: Keystore;

  constructor(ks: Keystore, pubkey: string) {
    this.#ks = ks;
    this.pubkey = pubkey;
  }

  /** Derive the provider from a keystore that already holds a wallet secret. */
  static fromKeystore(ks: Keystore): LocalWallet {
    const pubkey = ks.use(WALLET_SECRET_ID, (bytes) =>
      Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58(),
    );
    return new LocalWallet(ks, pubkey);
  }

  async sign(unsignedTxBase64: string): Promise<SignedTx> {
    return this.#ks.use(WALLET_SECRET_ID, (bytes) => {
      const kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
      const tx = VersionedTransaction.deserialize(
        Buffer.from(unsignedTxBase64, "base64"),
      );
      tx.sign([kp]);
      const wireBase64 = Buffer.from(tx.serialize()).toString("base64");
      const sig = tx.signatures[0];
      if (!sig || sig.length === 0) {
        throw new Error("transaction has no signature after signing");
      }
      return { wireBase64, signature: bs58.encode(sig) };
    });
  }
}
