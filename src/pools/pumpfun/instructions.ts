/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "../../chains/solana/spl.js";
import {
  BUY_DISCRIMINATOR,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_DISCRIMINATOR,
} from "./constants.js";
import {
  associatedBondingCurve,
  associatedTokenAccount,
  bondingCurvePda,
  creatorVaultPda,
  eventAuthorityPda,
  feeConfigPda,
  globalPda,
  globalVolumeAccumulatorPda,
  userVolumeAccumulatorPda,
} from "./curve.js";

/**
 * Bonding-curve `buy` / `sell` instruction construction.
 *
 * The account list is the volatile part of pump.fun — it has been extended three
 * times without a version bump in the instruction name — so it is expressed as an
 * ordered, named table rather than an inline array of `PublicKey`s. When pump
 * moves an account, you edit one row here and the tests that pin ordinal ↔ name
 * tell you immediately whether anything else shifted.
 *
 * This builds the **legacy `buy`/`sell`** pair, which covers SOL-paired coins on
 * the classic SPL Token program — the overwhelming majority of live curves. Coins
 * that need `buy_v2` (Token-2022 base mint, a non-SOL quote mint, mayhem or
 * cashback variants) are detected upstream and refused, never approximated.
 */

export interface PumpAccountSlot {
  readonly name: string;
  readonly pubkey: PublicKey;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface CurveIxContext {
  readonly user: PublicKey;
  readonly mint: PublicKey;
  /** `bonding_curve.creator`; required to derive `creator_vault`. */
  readonly creator: PublicKey;
  /** One of the `Global` account's fee recipients. */
  readonly feeRecipient: PublicKey;
  readonly programId?: PublicKey | undefined;
  readonly feeProgramId?: PublicKey;
  readonly tokenProgramId?: PublicKey;
}

interface Derived {
  readonly programId: PublicKey;
  readonly feeProgramId: PublicKey;
  readonly tokenProgramId: PublicKey;
  readonly global: PublicKey;
  readonly curve: PublicKey;
  readonly curveAta: PublicKey;
  readonly userAta: PublicKey;
  readonly creatorVault: PublicKey;
  readonly eventAuthority: PublicKey;
  readonly globalVolume: PublicKey;
  readonly userVolume: PublicKey;
  readonly feeConfig: PublicKey;
}

function derive(ctx: CurveIxContext): Derived {
  const programId = ctx.programId ?? PUMP_PROGRAM_ID;
  const feeProgramId = ctx.feeProgramId ?? PUMP_FEE_PROGRAM_ID;
  const tokenProgramId = ctx.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const curve = bondingCurvePda(ctx.mint, programId);
  return {
    programId,
    feeProgramId,
    tokenProgramId,
    global: globalPda(programId),
    curve,
    curveAta: associatedBondingCurve(ctx.mint, curve, tokenProgramId),
    userAta: associatedTokenAccount(ctx.mint, ctx.user, tokenProgramId),
    creatorVault: creatorVaultPda(ctx.creator, programId),
    eventAuthority: eventAuthorityPda(programId),
    globalVolume: globalVolumeAccumulatorPda(programId),
    userVolume: userVolumeAccumulatorPda(ctx.user, programId),
    feeConfig: feeConfigPda(programId, feeProgramId),
  };
}

/** `buy` account order, per `idl/pump.json`. Indices are load-bearing. */
export function buyAccounts(ctx: CurveIxContext): readonly PumpAccountSlot[] {
  const d = derive(ctx);
  return [
    { name: "global", pubkey: d.global, isSigner: false, isWritable: false },
    {
      name: "fee_recipient",
      pubkey: ctx.feeRecipient,
      isSigner: false,
      isWritable: true,
    },
    { name: "mint", pubkey: ctx.mint, isSigner: false, isWritable: false },
    {
      name: "bonding_curve",
      pubkey: d.curve,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "associated_bonding_curve",
      pubkey: d.curveAta,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "associated_user",
      pubkey: d.userAta,
      isSigner: false,
      isWritable: true,
    },
    { name: "user", pubkey: ctx.user, isSigner: true, isWritable: true },
    {
      name: "system_program",
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "token_program",
      pubkey: d.tokenProgramId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "creator_vault",
      pubkey: d.creatorVault,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "event_authority",
      pubkey: d.eventAuthority,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "program",
      pubkey: d.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "global_volume_accumulator",
      pubkey: d.globalVolume,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "user_volume_accumulator",
      pubkey: d.userVolume,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "fee_config",
      pubkey: d.feeConfig,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "fee_program",
      pubkey: d.feeProgramId,
      isSigner: false,
      isWritable: false,
    },
  ];
}

/** `sell` account order. Note `creator_vault` sits **before** `token_program` here but after it in `buy`. */
export function sellAccounts(ctx: CurveIxContext): readonly PumpAccountSlot[] {
  const d = derive(ctx);
  return [
    { name: "global", pubkey: d.global, isSigner: false, isWritable: false },
    {
      name: "fee_recipient",
      pubkey: ctx.feeRecipient,
      isSigner: false,
      isWritable: true,
    },
    { name: "mint", pubkey: ctx.mint, isSigner: false, isWritable: false },
    {
      name: "bonding_curve",
      pubkey: d.curve,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "associated_bonding_curve",
      pubkey: d.curveAta,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "associated_user",
      pubkey: d.userAta,
      isSigner: false,
      isWritable: true,
    },
    { name: "user", pubkey: ctx.user, isSigner: true, isWritable: true },
    {
      name: "system_program",
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "creator_vault",
      pubkey: d.creatorVault,
      isSigner: false,
      isWritable: true,
    },
    {
      name: "token_program",
      pubkey: d.tokenProgramId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "event_authority",
      pubkey: d.eventAuthority,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "program",
      pubkey: d.programId,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "fee_config",
      pubkey: d.feeConfig,
      isSigner: false,
      isWritable: false,
    },
    {
      name: "fee_program",
      pubkey: d.feeProgramId,
      isSigner: false,
      isWritable: false,
    },
  ];
}

function u64le(v: bigint): Buffer {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn)
    throw new RangeError(`value out of u64 range: ${v}`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function toKeys(slots: readonly PumpAccountSlot[]) {
  return slots.map((s) => ({
    pubkey: s.pubkey,
    isSigner: s.isSigner,
    isWritable: s.isWritable,
  }));
}

/**
 * `buy(amount: u64, max_sol_cost: u64, track_volume: OptionBool)`.
 * `OptionBool` is a single-field tuple struct, i.e. one byte on the wire.
 */
export function buildBuyInstruction(args: {
  readonly ctx: CurveIxContext;
  readonly tokenAmount: bigint;
  readonly maxSolCostLamports: bigint;
  readonly trackVolume?: boolean;
}): TransactionInstruction {
  const slots = buyAccounts(args.ctx);
  const data = Buffer.concat([
    Buffer.from(BUY_DISCRIMINATOR),
    u64le(args.tokenAmount),
    u64le(args.maxSolCostLamports),
    Buffer.from([args.trackVolume === false ? 0 : 1]),
  ]);
  return {
    programId: args.ctx.programId ?? PUMP_PROGRAM_ID,
    keys: toKeys(slots),
    data,
  } as TransactionInstruction;
}

/** `sell(amount: u64, min_sol_output: u64)`. */
export function buildSellInstruction(args: {
  readonly ctx: CurveIxContext;
  readonly tokenAmount: bigint;
  readonly minSolOutputLamports: bigint;
}): TransactionInstruction {
  const slots = sellAccounts(args.ctx);
  const data = Buffer.concat([
    Buffer.from(SELL_DISCRIMINATOR),
    u64le(args.tokenAmount),
    u64le(args.minSolOutputLamports),
  ]);
  return {
    programId: args.ctx.programId ?? PUMP_PROGRAM_ID,
    keys: toKeys(slots),
    data,
  } as TransactionInstruction;
}

/** Idempotent ATA create for the user's token account — a no-op when it exists. */
export function ensureUserAtaInstruction(
  ctx: CurveIxContext,
): TransactionInstruction {
  const tokenProgramId = ctx.tokenProgramId ?? TOKEN_PROGRAM_ID;
  return createAssociatedTokenAccountIdempotentInstruction(
    ctx.user,
    associatedTokenAccount(ctx.mint, ctx.user, tokenProgramId),
    ctx.user,
    ctx.mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export interface BuiltTx {
  readonly unsignedTxBase64: string;
  readonly recentBlockhash: string;
  readonly priorityFeeLamports: number;
  readonly computeUnitLimit: number;
}

const DEFAULT_CU_LIMIT = 250_000;

/**
 * Wrap instructions into an unsigned v0 transaction, base64 wire format — the one
 * canonical representation the kernel signs, persists and broadcasts.
 *
 * The priority fee is expressed as an exact lamport total and converted to a
 * per-CU micro-lamport price against the CU limit, so the number the intent
 * declares is the number the transaction actually pays. The kernel re-caps it
 * against policy anyway; this just means the two agree.
 */
export function buildUnsignedTx(args: {
  readonly payer: PublicKey;
  readonly instructions: readonly TransactionInstruction[];
  readonly recentBlockhash: string;
  readonly priorityFeeLamports: number;
  readonly computeUnitLimit?: number;
}): BuiltTx {
  const cuLimit = args.computeUnitLimit ?? DEFAULT_CU_LIMIT;
  if (
    !Number.isFinite(args.priorityFeeLamports) ||
    args.priorityFeeLamports < 0
  ) {
    throw new RangeError("priorityFeeLamports must be finite and non-negative");
  }
  // microLamports per CU = lamports · 1e6 / CU
  const microLamports = Math.floor(
    (args.priorityFeeLamports * 1_000_000) / cuLimit,
  );
  const actualFeeLamports = Math.floor((microLamports * cuLimit) / 1_000_000);

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...args.instructions,
  ];
  const message = new TransactionMessage({
    payerKey: args.payer,
    recentBlockhash: args.recentBlockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return {
    unsignedTxBase64: Buffer.from(tx.serialize()).toString("base64"),
    recentBlockhash: args.recentBlockhash,
    priorityFeeLamports: actualFeeLamports,
    computeUnitLimit: cuLimit,
  };
}

/** Deterministic fee-recipient pick from `Global`. Falls back to the primary when the rotation list is empty. */
export function pickFeeRecipient(
  recipients: readonly string[],
  primary: string,
  seed: number,
): PublicKey {
  if (recipients.length === 0) return new PublicKey(primary);
  const idx = Math.abs(Math.floor(seed)) % recipients.length;
  return new PublicKey(recipients[idx] as string);
}
