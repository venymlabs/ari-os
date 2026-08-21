/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublicKey } from "@solana/web3.js";
import {
  associatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "../../chains/solana/spl.js";
import {
  BONDING_CURVE_DISCRIMINATOR,
  GLOBAL_DISCRIMINATOR,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SEED_BONDING_CURVE,
  SEED_CREATOR_VAULT,
  SEED_EVENT_AUTHORITY,
  SEED_FEE_CONFIG,
  SEED_GLOBAL,
  SEED_GLOBAL_VOLUME_ACCUMULATOR,
  SEED_USER_VOLUME_ACCUMULATOR,
} from "./constants.js";
import type { CurveReserves, FeeTier, Fees } from "./math.js";

/**
 * Account derivation and decoding for pump.fun's bonding curve.
 *
 * Decoding is written to survive the program's own history. Curve accounts grew
 * over time — 49 bytes originally, then +32 for `creator`, now 115 with the
 * mayhem/cashback flags and `quote_mint` — and old curves were never migrated. So
 * every field past `complete` is read only if the buffer is long enough, and its
 * absence is reported as `undefined` rather than defaulted to a lie.
 */

// ── PDAs ─────────────────────────────────────────────────────────────────────

export function globalPda(programId: PublicKey = PUMP_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_GLOBAL], programId)[0];
}

export function bondingCurvePda(
  mint: PublicKey,
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_BONDING_CURVE, mint.toBuffer()],
    programId,
  )[0];
}

export function creatorVaultPda(
  creator: PublicKey,
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_CREATOR_VAULT, creator.toBuffer()],
    programId,
  )[0];
}

export function eventAuthorityPda(
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_EVENT_AUTHORITY], programId)[0];
}

export function globalVolumeAccumulatorPda(
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_GLOBAL_VOLUME_ACCUMULATOR],
    programId,
  )[0];
}

export function userVolumeAccumulatorPda(
  user: PublicKey,
  programId: PublicKey = PUMP_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_USER_VOLUME_ACCUMULATOR, user.toBuffer()],
    programId,
  )[0];
}

/**
 * `fee_config` lives under the **fee** program, seeded by the *pump* program's
 * 32 bytes. Two program ids in one derivation is easy to get backwards, which is
 * why `curve.test.ts` pins the seed bytes against the published IDL constant.
 */
export function feeConfigPda(
  pumpProgramId: PublicKey = PUMP_PROGRAM_ID,
  feeProgramId: PublicKey = PUMP_FEE_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_FEE_CONFIG, pumpProgramId.toBuffer()],
    feeProgramId,
  )[0];
}

/** The curve's own token account — a plain ATA owned by the curve PDA. */
export function associatedBondingCurve(
  mint: PublicKey,
  curve: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return associatedTokenAddress(mint, curve, tokenProgramId);
}

export function associatedTokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return associatedTokenAddress(mint, owner, tokenProgramId);
}

// ── decoding ─────────────────────────────────────────────────────────────────

export class CurveDecodeError extends Error {}

function toBuffer(data: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function discriminatorMatches(buf: Buffer, expected: Uint8Array): boolean {
  if (buf.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++)
    if (buf[i] !== expected[i]) return false;
  return true;
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export interface BondingCurveAccount extends CurveReserves {
  /** Creator, needed to derive `creator_vault`. Undefined on pre-creator-fee curves. */
  readonly creator: string | undefined;
  readonly isMayhemMode: boolean | undefined;
  readonly isCashbackCoin: boolean | undefined;
  /**
   * `Pubkey::default()` (all zeroes) means SOL-paired. Any other value means the
   * coin is quoted in a different SPL token and needs `buy_v2`, which this package
   * does not build — the caller must refuse rather than mis-price it.
   */
  readonly quoteMint: string | undefined;
  readonly rawLength: number;
}

const SOL_PAIRED_SENTINEL = PublicKey.default.toBase58();

/**
 * Decode a `BondingCurve` account. Note the IDL names the SOL fields
 * `virtual_quote_reserves` / `real_quote_reserves` since the multi-quote upgrade;
 * for a SOL-paired coin they *are* the lamport reserves, and this decoder surfaces
 * them under the SOL names the maths module uses.
 */
export function decodeBondingCurve(
  data: Uint8Array | Buffer,
): BondingCurveAccount {
  const buf = toBuffer(data);
  if (!discriminatorMatches(buf, BONDING_CURVE_DISCRIMINATOR)) {
    throw new CurveDecodeError(
      "account is not a pump.fun BondingCurve (discriminator mismatch)",
    );
  }
  // 8 disc + 5×u64 + bool
  if (buf.length < 49)
    throw new CurveDecodeError(`BondingCurve too short: ${buf.length} bytes`);

  const virtualTokenReserves = buf.readBigUInt64LE(8);
  const virtualSolReserves = buf.readBigUInt64LE(16);
  const realTokenReserves = buf.readBigUInt64LE(24);
  const realSolReserves = buf.readBigUInt64LE(32);
  const tokenTotalSupply = buf.readBigUInt64LE(40);
  const complete = buf.readUInt8(48) !== 0;

  const creator =
    buf.length >= 81
      ? new PublicKey(buf.subarray(49, 81)).toBase58()
      : undefined;
  const isMayhemMode = buf.length >= 82 ? buf.readUInt8(81) !== 0 : undefined;
  const isCashbackCoin = buf.length >= 83 ? buf.readUInt8(82) !== 0 : undefined;
  const quoteMint =
    buf.length >= 115
      ? new PublicKey(buf.subarray(83, 115)).toBase58()
      : undefined;

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    rawLength: buf.length,
  };
}

/** True when the coin is quoted in native SOL (the only shape this package trades). */
export function isSolPaired(curve: BondingCurveAccount): boolean {
  return (
    curve.quoteMint === undefined || curve.quoteMint === SOL_PAIRED_SENTINEL
  );
}

export interface GlobalAccount {
  readonly authority: string;
  readonly feeRecipient: string;
  readonly initialVirtualTokenReserves: bigint;
  readonly initialVirtualSolReserves: bigint;
  readonly initialRealTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly feeBasisPoints: bigint;
  readonly creatorFeeBasisPoints: bigint | undefined;
  /** The 7 rotating fee recipients, when the account is long enough to hold them. */
  readonly feeRecipients: readonly string[];
}

const GLOBAL_OFF = {
  authority: 9,
  feeRecipient: 41,
  initialVirtualTokenReserves: 73,
  initialVirtualSolReserves: 81,
  initialRealTokenReserves: 89,
  tokenTotalSupply: 97,
  feeBasisPoints: 105,
  creatorFeeBasisPoints: 154,
  feeRecipients: 162,
} as const;

export function decodeGlobal(data: Uint8Array | Buffer): GlobalAccount {
  const buf = toBuffer(data);
  if (!discriminatorMatches(buf, GLOBAL_DISCRIMINATOR)) {
    throw new CurveDecodeError(
      "account is not a pump.fun Global (discriminator mismatch)",
    );
  }
  if (buf.length < GLOBAL_OFF.feeBasisPoints + 8)
    throw new CurveDecodeError(`Global too short: ${buf.length} bytes`);

  const feeRecipients: string[] = [];
  if (buf.length >= GLOBAL_OFF.feeRecipients + 7 * 32) {
    for (let i = 0; i < 7; i++) {
      const start = GLOBAL_OFF.feeRecipients + i * 32;
      const pk = new PublicKey(buf.subarray(start, start + 32)).toBase58();
      if (pk !== SOL_PAIRED_SENTINEL) feeRecipients.push(pk);
    }
  }

  return {
    authority: new PublicKey(
      buf.subarray(GLOBAL_OFF.authority, GLOBAL_OFF.authority + 32),
    ).toBase58(),
    feeRecipient: new PublicKey(
      buf.subarray(GLOBAL_OFF.feeRecipient, GLOBAL_OFF.feeRecipient + 32),
    ).toBase58(),
    initialVirtualTokenReserves: buf.readBigUInt64LE(
      GLOBAL_OFF.initialVirtualTokenReserves,
    ),
    initialVirtualSolReserves: buf.readBigUInt64LE(
      GLOBAL_OFF.initialVirtualSolReserves,
    ),
    initialRealTokenReserves: buf.readBigUInt64LE(
      GLOBAL_OFF.initialRealTokenReserves,
    ),
    tokenTotalSupply: buf.readBigUInt64LE(GLOBAL_OFF.tokenTotalSupply),
    feeBasisPoints: buf.readBigUInt64LE(GLOBAL_OFF.feeBasisPoints),
    creatorFeeBasisPoints:
      buf.length >= GLOBAL_OFF.creatorFeeBasisPoints + 8
        ? buf.readBigUInt64LE(GLOBAL_OFF.creatorFeeBasisPoints)
        : undefined,
    feeRecipients,
  };
}

export interface FeeConfigAccount {
  readonly flatFees: Fees;
  readonly feeTiers: readonly FeeTier[];
}

function readFees(buf: Buffer, offset: number): Fees {
  return {
    lpFeeBps: buf.readBigUInt64LE(offset),
    protocolFeeBps: buf.readBigUInt64LE(offset + 8),
    creatorFeeBps: buf.readBigUInt64LE(offset + 16),
  };
}

/** Decode the fee program's `FeeConfig`: `bump(1) admin(32) flat_fees(24) fee_tiers(vec)`. */
export function decodeFeeConfig(data: Uint8Array | Buffer): FeeConfigAccount {
  const buf = toBuffer(data);
  const FLAT = 8 + 1 + 32;
  const VEC_LEN = FLAT + 24;
  if (buf.length < VEC_LEN + 4)
    throw new CurveDecodeError(`FeeConfig too short: ${buf.length} bytes`);
  const flatFees = readFees(buf, FLAT);
  const count = buf.readUInt32LE(VEC_LEN);
  const tiers: FeeTier[] = [];
  const TIER_SIZE = 16 + 24;
  for (let i = 0; i < count; i++) {
    const off = VEC_LEN + 4 + i * TIER_SIZE;
    if (off + TIER_SIZE > buf.length) break; // truncated account: stop rather than read garbage.
    tiers.push({
      marketCapLamportsThreshold: readU128LE(buf, off),
      fees: readFees(buf, off + 16),
    });
  }
  return { flatFees, feeTiers: tiers };
}
