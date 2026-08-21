/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Connection, PublicKey } from "@solana/web3.js";

/**
 * The narrow slice of chain access this package needs, expressed as a port.
 *
 * `src/chains/solana` already owns the real `Connection` and the kernel's
 * read ports, and this package must not reach into it (that would invert the
 * dependency and drag the whole integration surface in). Instead: three methods,
 * trivially fakeable, so every test in here runs with zero network.
 */

export interface AccountSnapshot {
  readonly address: string;
  /** base58 program id that owns the account. */
  readonly owner: string;
  readonly data: Uint8Array;
  readonly lamports: bigint;
}

export interface Blockhash {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface ChainReader {
  getAccount(address: string): Promise<AccountSnapshot | null>;
  getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (AccountSnapshot | null)[]>;
  getLatestBlockhash(): Promise<Blockhash>;
  /** Base-unit balance of `mint` held by `owner`. Used only for the base-leg guard. */
  getTokenBalance(owner: string, mint: string): Promise<bigint>;
}

/** `ChainReader` over a web3.js `Connection`. Accepts anything Connection-shaped. */
export class RpcChainReader implements ChainReader {
  #connection: Connection;

  constructor(connectionOrUrl: Connection | string) {
    this.#connection =
      typeof connectionOrUrl === "string"
        ? new Connection(connectionOrUrl, "confirmed")
        : connectionOrUrl;
  }

  async getAccount(address: string): Promise<AccountSnapshot | null> {
    const info = await this.#connection.getAccountInfo(
      new PublicKey(address),
      "confirmed",
    );
    if (!info) return null;
    return {
      address,
      owner: info.owner.toBase58(),
      data: Uint8Array.from(info.data),
      lamports: BigInt(info.lamports),
    };
  }

  async getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (AccountSnapshot | null)[]> {
    if (addresses.length === 0) return [];
    const infos = await this.#connection.getMultipleAccountsInfo(
      addresses.map((a) => new PublicKey(a)),
      "confirmed",
    );
    return infos.map((info, i) =>
      info
        ? {
            address: addresses[i] as string,
            owner: info.owner.toBase58(),
            data: Uint8Array.from(info.data),
            lamports: BigInt(info.lamports),
          }
        : null,
    );
  }

  async getLatestBlockhash(): Promise<Blockhash> {
    const r = await this.#connection.getLatestBlockhash("confirmed");
    return {
      blockhash: r.blockhash,
      lastValidBlockHeight: r.lastValidBlockHeight,
    };
  }

  async getTokenBalance(owner: string, mint: string): Promise<bigint> {
    const res = await this.#connection.getParsedTokenAccountsByOwner(
      new PublicKey(owner),
      { mint: new PublicKey(mint) },
    );
    let total = 0n;
    for (const { account } of res.value) {
      const data = account.data;
      if (data instanceof Buffer || !("parsed" in data)) continue;
      const info = (
        data.parsed as { info?: { tokenAmount?: { amount?: string } } }
      ).info;
      const amount = info?.tokenAmount?.amount;
      if (amount) total += BigInt(amount);
    }
    return total;
  }
}
