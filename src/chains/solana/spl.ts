/*
 * SPDX-License-Identifier: MIT
 *
 * Clean-room reimplementation of the four things ARI OS used from
 * `@solana/spl-token`. No upstream source is incorporated here: the program ids
 * are public on-chain addresses, and the instruction is built from the
 * Associated Token Account program's documented wire format.
 *
 * Why this file exists: `@solana/spl-token` drags in `@solana/buffer-layout-utils`,
 * which depends on `bigint-buffer`, which carries an unpatched high-severity
 * buffer-overflow advisory (GHSA-3gc7-fjrx-p6mg) with no fixed release. We used
 * three constants and one instruction builder out of that whole subtree, so the
 * subtree is gone and the four things live here instead.
 *
 * `tests/solana-spl.test.ts` pins every byte this module emits — the derived
 * addresses and the exact serialised instruction — against values captured from
 * the upstream library before it was removed. Treat those fixtures as the
 * contract: this is transaction-building code, and a wrong constant or a
 * reordered account is a misdirected transaction, not a type error.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/** SPL Token program (legacy). */
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** SPL Token-2022 program (Token Extensions). */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/** SPL Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * ATA program instruction discriminator, encoded as a single byte.
 *
 * The enum is `Create = 0`, `CreateIdempotent = 1`, `RecoverNested = 2`. We only
 * ever want `1`: a buy that races another buy for the same mint must not revert
 * on an account that is already there, which is exactly what `Create` would do.
 */
const ATA_IX_CREATE_IDEMPOTENT = 1;

/**
 * Derives an associated token account address.
 *
 * The token program is a **seed**, not just the eventual owner, so a Token-2022
 * mint derives a different ATA than a legacy one for the same wallet. Callers
 * that support both must pass the mint's actual program — defaulting to legacy
 * on a Token-2022 mint silently produces an address the token program will
 * refuse to initialise.
 *
 * Uses `findProgramAddressSync`, matching the library's `allowOwnerOffCurve`
 * behaviour: the owner is not required to be a system-owned (on-curve) address,
 * which is what lets a PDA such as a pump.fun bonding curve hold an ATA.
 */
export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Builds an ATA `CreateIdempotent` instruction.
 *
 * Argument order and defaults mirror the upstream helper this replaces, so call
 * sites did not have to change. `associatedToken` is passed in rather than
 * derived so the caller keeps one address for both the instruction and the
 * account list of the transaction it is being prepended to.
 */
export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: associatedTokenProgramId,
    data: Buffer.from([ATA_IX_CREATE_IDEMPOTENT]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
  });
}
