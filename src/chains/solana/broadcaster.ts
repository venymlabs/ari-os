/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Connection } from "@solana/web3.js";
import type { Broadcaster, SignedTx } from "../../kernel/contracts.js";
import { SolanaRpc } from "./rpc.js";

/** Lands a signed tx straight to the configured RPC. Preflight is skipped (the kernel already simulated). */
export class SelfRpcBroadcaster implements Broadcaster {
  #connection: Connection;

  constructor(rpc: SolanaRpc | Connection) {
    this.#connection = rpc instanceof SolanaRpc ? rpc.connection : rpc;
  }

  async broadcast(
    signed: SignedTx,
    _landHandle: string | undefined,
  ): Promise<{ signature: string }> {
    const signature = await this.#connection.sendRawTransaction(
      Buffer.from(signed.wireBase64, "base64"),
      { skipPreflight: true, maxRetries: 3 },
    );
    return { signature };
  }
}
