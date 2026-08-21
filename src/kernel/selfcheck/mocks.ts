/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type {
  BalanceReader,
  Broadcaster,
  ConfirmOutcome,
  Confirmer,
  ConfirmStatus,
  MintInfo,
  MintInspector,
  SignedTx,
  SimOutcome,
  Simulator,
  WalletProvider,
} from "../contracts.js";
import { WSOL_MINT } from "../money.js";

/** A tiny in-memory "chain" the mock ports share, so a broadcast actually moves mock balances. */
export class MockChain {
  readonly balances = new Map<string, bigint>();
  fill: {
    inMint: string;
    inAmt: bigint;
    outMint: string;
    outAmt: bigint;
  } | null = null;
  confirmStatus: ConfirmStatus = "confirmed";
  simOk = true;
  /** When set, MockBroadcaster.broadcast throws — models an RPC send failure. */
  broadcastError: string | null = null;

  applyFill(): void {
    if (!this.fill) return;
    const f = this.fill;
    this.balances.set(f.inMint, (this.balances.get(f.inMint) ?? 0n) - f.inAmt);
    this.balances.set(
      f.outMint,
      (this.balances.get(f.outMint) ?? 0n) + f.outAmt,
    );
  }
}

export class MockMints implements MintInspector {
  #token2022: Set<string>;
  constructor(token2022: string[] = []) {
    this.#token2022 = new Set(token2022);
  }
  async inspect(mint: string): Promise<MintInfo> {
    const is = this.#token2022.has(mint);
    return {
      mint,
      decimals: mint === WSOL_MINT ? 9 : 6,
      programId: is ? "TokenzQdBJM (token-2022)" : "TokenkegQfeZ (spl-token)",
      isToken2022: is,
      freezeAuthority: null,
      mintAuthority: null,
    };
  }
}

export class MockBalances implements BalanceReader {
  #chain: MockChain;
  constructor(chain: MockChain) {
    this.#chain = chain;
  }
  async readBalance(_owner: string, mint: string): Promise<bigint> {
    return this.#chain.balances.get(mint) ?? 0n;
  }
}

export class MockSimulator implements Simulator {
  #chain: MockChain;
  constructor(chain: MockChain) {
    this.#chain = chain;
  }
  async simulate(_wireBase64: string): Promise<SimOutcome> {
    return {
      ok: this.#chain.simOk,
      err: this.#chain.simOk ? undefined : "sim failed",
      logs: undefined,
      unitsConsumed: undefined,
    };
  }
}

export class MockBroadcaster implements Broadcaster {
  #chain: MockChain;
  constructor(chain: MockChain) {
    this.#chain = chain;
  }
  async broadcast(
    signed: SignedTx,
    _landHandle: string | undefined,
  ): Promise<{ signature: string }> {
    if (this.#chain.broadcastError) throw new Error(this.#chain.broadcastError);
    if (this.#chain.confirmStatus === "confirmed") this.#chain.applyFill();
    return { signature: signed.signature };
  }
}

export class MockConfirmer implements Confirmer {
  #chain: MockChain;
  constructor(chain: MockChain) {
    this.#chain = chain;
  }
  async confirm(
    _signature: string,
    _lastValidBlockHeight: number,
  ): Promise<ConfirmOutcome> {
    return { status: this.#chain.confirmStatus, slot: 1, err: undefined };
  }
}

export class MockWallet implements WalletProvider {
  readonly pubkey = "MockWa11et1111111111111111111111111111111111";
  async sign(unsignedTxBase64: string): Promise<SignedTx> {
    return {
      wireBase64: unsignedTxBase64,
      signature: `mocksig_${randomUUID()}`,
    };
  }
}
