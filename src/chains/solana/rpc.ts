/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./spl.js";
import {
  Connection,
  type ParsedAccountData,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import type {
  BalanceReader,
  ConfirmOutcome,
  Confirmer,
  MintInfo,
  MintInspector,
  SimOutcome,
  Simulator,
  SolanaReader,
  TokenHolding,
} from "../../kernel/contracts.js";
import { WSOL_MINT } from "../../kernel/money.js";

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 1_500;

interface TokenAccInfo {
  mint: string;
  tokenAmount: { amount: string; decimals: number };
}

function tokenInfoOf(data: ParsedAccountData): TokenAccInfo | undefined {
  const parsed = (data as { parsed?: { info?: unknown } }).parsed;
  return parsed?.info as TokenAccInfo | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One Connection wrapper that satisfies every read-side kernel port. */
export class SolanaRpc
  implements SolanaReader, MintInspector, BalanceReader, Simulator, Confirmer
{
  readonly connection: Connection;

  constructor(rpcUrl: string | Connection) {
    this.connection =
      typeof rpcUrl === "string" ? new Connection(rpcUrl, "confirmed") : rpcUrl;
  }

  async getSolLamports(owner: string): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(owner)));
  }

  async getMintInfo(mint: string): Promise<MintInfo> {
    if (mint === WSOL_MINT) {
      return {
        mint,
        decimals: 9,
        programId: TOKEN_PROGRAM_ID.toBase58(),
        isToken2022: false,
        freezeAuthority: null,
        mintAuthority: null,
      };
    }
    const res = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    const value = res.value;
    if (!value) throw new Error(`mint ${mint} not found`);
    const data = value.data;
    if (
      data instanceof Buffer ||
      !("parsed" in data) ||
      data.parsed?.type !== "mint"
    ) {
      throw new Error(`account ${mint} is not an SPL mint`);
    }
    const info = data.parsed.info as {
      decimals: number;
      freezeAuthority?: string | null;
      mintAuthority?: string | null;
    };
    return {
      mint,
      decimals: info.decimals,
      programId: value.owner.toBase58(),
      isToken2022: value.owner.equals(TOKEN_2022_PROGRAM_ID),
      freezeAuthority: info.freezeAuthority ?? null,
      mintAuthority: info.mintAuthority ?? null,
    };
  }

  async inspect(mint: string): Promise<MintInfo> {
    return this.getMintInfo(mint);
  }

  async getTokenHoldings(owner: string): Promise<TokenHolding[]> {
    const ownerPk = new PublicKey(owner);
    const holdings: TokenHolding[] = [];
    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.connection.getParsedTokenAccountsByOwner(ownerPk, {
        programId,
      });
      for (const { account } of res.value) {
        const info = tokenInfoOf(account.data);
        if (!info) continue;
        const amount = BigInt(info.tokenAmount.amount);
        if (amount === 0n) continue;
        holdings.push({
          mint: info.mint,
          amount,
          decimals: info.tokenAmount.decimals,
          programId: programId.toBase58(),
          symbol: undefined,
        });
      }
    }
    return holdings;
  }

  async readBalance(owner: string, mint: string): Promise<bigint> {
    if (mint === WSOL_MINT) return this.getSolLamports(owner);
    const ownerPk = new PublicKey(owner);
    const mintPk = new PublicKey(mint);
    let total = 0n;
    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.connection
        .getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk, programId })
        .catch(() => null);
      if (!res) continue;
      for (const { account } of res.value) {
        const info = tokenInfoOf(account.data);
        if (info) total += BigInt(info.tokenAmount.amount);
      }
    }
    return total;
  }

  /**
   * Preflight sanity only. Solana has no pinned-block `eth_call` equivalent, so
   * this is `simulateTransaction` against current state with signature
   * verification off and the built blockhash left in place — a stale blockhash
   * must surface as a failure here rather than be silently replaced.
   */
  async simulate(wireBase64: string): Promise<SimOutcome> {
    const tx = VersionedTransaction.deserialize(
      Buffer.from(wireBase64, "base64"),
    );
    const r = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
    });
    return {
      ok: !r.value.err,
      err: r.value.err ?? undefined,
      logs: r.value.logs ?? undefined,
      unitsConsumed: r.value.unitsConsumed ?? undefined,
    };
  }

  /**
   * Poll until the signature lands or its blockhash expires. Expiry is TERMINAL:
   * the caller releases the reservation and fails the trade. Nothing re-signs.
   */
  async confirm(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<ConfirmOutcome> {
    const start = Date.now();
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      const status = (await this.connection.getSignatureStatuses([signature]))
        .value[0];
      if (status) {
        if (status.err) {
          return {
            status: "failed",
            slot: status.slot ?? undefined,
            err: status.err,
          };
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return {
            status: "confirmed",
            slot: status.slot ?? undefined,
            err: undefined,
          };
        }
      }
      const height = await this.connection.getBlockHeight("confirmed");
      if (height > lastValidBlockHeight) {
        return { status: "expired", slot: undefined, err: undefined };
      }
      await sleep(CONFIRM_POLL_MS);
    }
    return { status: "expired", slot: undefined, err: undefined };
  }
}
