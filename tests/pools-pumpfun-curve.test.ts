/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  BONDING_CURVE_DISCRIMINATOR,
  GLOBAL_DISCRIMINATOR,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_TOTAL_SUPPLY,
} from "../src/pools/pumpfun/constants.js";
import {
  associatedBondingCurve,
  associatedTokenAccount,
  bondingCurvePda,
  creatorVaultPda,
  CurveDecodeError,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeGlobal,
  eventAuthorityPda,
  feeConfigPda,
  globalPda,
  globalVolumeAccumulatorPda,
  isSolPaired,
  userVolumeAccumulatorPda,
} from "../src/pools/pumpfun/curve.js";

const MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const CREATOR = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const USER = new PublicKey("11111111111111111111111111111112");

/**
 * The exact byte array the published IDL pins as the second `fee_config` seed.
 * It must equal the pump program's own 32 bytes: `fee_config` lives under the FEE
 * program but is seeded by the PUMP program id, and getting those two backwards
 * derives a real-looking address that simply does not exist on chain.
 */
const IDL_FEE_CONFIG_SEED = [
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
  137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
];

test("the fee_config seed is the pump program id, and the PDA lives under the fee program", () => {
  assert.deepEqual([...PUMP_PROGRAM_ID.toBytes()], IDL_FEE_CONFIG_SEED);
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), Buffer.from(IDL_FEE_CONFIG_SEED)],
    PUMP_FEE_PROGRAM_ID,
  )[0];
  assert.equal(feeConfigPda().toBase58(), expected.toBase58());
  // Swapping the two program ids must NOT produce the same address.
  const swapped = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), PUMP_FEE_PROGRAM_ID.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
  assert.notEqual(feeConfigPda().toBase58(), swapped.toBase58());
});

test("PDAs are deterministic, distinct, and off-curve", () => {
  const curve = bondingCurvePda(MINT);
  assert.equal(curve.toBase58(), bondingCurvePda(MINT).toBase58());
  assert.notEqual(curve.toBase58(), bondingCurvePda(CREATOR).toBase58());
  assert.equal(PublicKey.isOnCurve(curve.toBytes()), false);

  const all = [
    globalPda(),
    curve,
    creatorVaultPda(CREATOR),
    eventAuthorityPda(),
    globalVolumeAccumulatorPda(),
    userVolumeAccumulatorPda(USER),
    feeConfigPda(),
  ].map((p) => p.toBase58());
  assert.equal(new Set(all).size, all.length, "every PDA must be distinct");
});

test("the curve token account is a plain ATA owned by the curve PDA", () => {
  const curve = bondingCurvePda(MINT);
  assert.equal(
    associatedBondingCurve(MINT, curve).toBase58(),
    associatedTokenAccount(MINT, curve).toBase58(),
  );
  assert.notEqual(
    associatedTokenAccount(MINT, curve).toBase58(),
    associatedTokenAccount(MINT, USER).toBase58(),
  );
});

// ── BondingCurve decoding ────────────────────────────────────────────────────

interface CurveFields {
  virtualToken?: bigint;
  virtualSol?: bigint;
  realToken?: bigint;
  realSol?: bigint;
  supply?: bigint;
  complete?: boolean;
  creator?: PublicKey;
  mayhem?: boolean;
  cashback?: boolean;
  quoteMint?: PublicKey;
  length?: number;
}

/** Build a BondingCurve account at any of the three historical lengths. */
function curveBuf(f: CurveFields = {}): Buffer {
  const len = f.length ?? 115;
  const buf = Buffer.alloc(len);
  Buffer.from(BONDING_CURVE_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(f.virtualToken ?? 1_073_000_000_000_000n, 8);
  buf.writeBigUInt64LE(f.virtualSol ?? 30_000_000_000n, 16);
  buf.writeBigUInt64LE(f.realToken ?? 793_100_000_000_000n, 24);
  buf.writeBigUInt64LE(f.realSol ?? 0n, 32);
  buf.writeBigUInt64LE(f.supply ?? PUMP_TOTAL_SUPPLY, 40);
  buf.writeUInt8(f.complete ? 1 : 0, 48);
  if (len >= 81) (f.creator ?? CREATOR).toBuffer().copy(buf, 49);
  if (len >= 82) buf.writeUInt8(f.mayhem ? 1 : 0, 81);
  if (len >= 83) buf.writeUInt8(f.cashback ? 1 : 0, 82);
  if (len >= 115) (f.quoteMint ?? PublicKey.default).toBuffer().copy(buf, 83);
  return buf;
}

test("a full 115-byte curve decodes every field", () => {
  const c = decodeBondingCurve(curveBuf({ realSol: 12_345n, complete: true }));
  assert.equal(c.virtualTokenReserves, 1_073_000_000_000_000n);
  assert.equal(c.virtualSolReserves, 30_000_000_000n);
  assert.equal(c.realTokenReserves, 793_100_000_000_000n);
  assert.equal(c.realSolReserves, 12_345n);
  assert.equal(c.tokenTotalSupply, PUMP_TOTAL_SUPPLY);
  assert.equal(c.complete, true);
  assert.equal(c.creator, CREATOR.toBase58());
  assert.equal(c.isMayhemMode, false);
  assert.equal(c.isCashbackCoin, false);
  assert.equal(c.quoteMint, PublicKey.default.toBase58());
  assert.equal(c.rawLength, 115);
  assert.equal(isSolPaired(c), true);
});

test("older, shorter curve accounts degrade to undefined rather than to a wrong value", () => {
  const legacy = decodeBondingCurve(curveBuf({ length: 49 }));
  assert.equal(
    legacy.creator,
    undefined,
    "a pre-creator-fee curve has no creator to invent",
  );
  assert.equal(legacy.isMayhemMode, undefined);
  assert.equal(legacy.quoteMint, undefined);
  assert.equal(isSolPaired(legacy), true, "no quote mint means SOL-paired");
  assert.equal(
    legacy.virtualSolReserves,
    30_000_000_000n,
    "the reserves still decode",
  );

  const withCreator = decodeBondingCurve(curveBuf({ length: 81 }));
  assert.equal(withCreator.creator, CREATOR.toBase58());
  assert.equal(withCreator.isMayhemMode, undefined);
});

test("a non-SOL quote mint is detected, so the caller can refuse the legacy instruction", () => {
  const c = decodeBondingCurve(curveBuf({ quoteMint: MINT }));
  assert.equal(c.quoteMint, MINT.toBase58());
  assert.equal(isSolPaired(c), false);
});

test("the mayhem and cashback flags round-trip", () => {
  const c = decodeBondingCurve(curveBuf({ mayhem: true, cashback: true }));
  assert.equal(c.isMayhemMode, true);
  assert.equal(c.isCashbackCoin, true);
});

test("a wrong discriminator or a truncated account is rejected, not guessed", () => {
  const bad = curveBuf();
  bad.writeUInt8(0xff, 0);
  assert.throws(() => decodeBondingCurve(bad), CurveDecodeError);
  assert.throws(
    () => decodeBondingCurve(curveBuf().subarray(0, 40)),
    CurveDecodeError,
  );
  assert.throws(() => decodeBondingCurve(Buffer.alloc(0)), CurveDecodeError);
});

// ── Global decoding ──────────────────────────────────────────────────────────

function globalBuf(
  over: {
    feeBps?: bigint;
    creatorFeeBps?: bigint;
    recipients?: PublicKey[];
    length?: number;
  } = {},
): Buffer {
  const buf = Buffer.alloc(over.length ?? 386);
  Buffer.from(GLOBAL_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt8(1, 8); // initialized
  CREATOR.toBuffer().copy(buf, 9); // authority
  MINT.toBuffer().copy(buf, 41); // fee_recipient
  buf.writeBigUInt64LE(1_073_000_000_000_000n, 73);
  buf.writeBigUInt64LE(30_000_000_000n, 81);
  buf.writeBigUInt64LE(793_100_000_000_000n, 89);
  buf.writeBigUInt64LE(PUMP_TOTAL_SUPPLY, 97);
  buf.writeBigUInt64LE(over.feeBps ?? 95n, 105);
  if ((over.length ?? 386) >= 162)
    buf.writeBigUInt64LE(over.creatorFeeBps ?? 5n, 154);
  const recipients = over.recipients ?? [USER, CREATOR];
  recipients.forEach((r, i) => {
    if (162 + i * 32 + 32 <= buf.length) r.toBuffer().copy(buf, 162 + i * 32);
  });
  return buf;
}

test("Global decodes the fee split and the rotating recipient list", () => {
  const g = decodeGlobal(globalBuf());
  assert.equal(g.authority, CREATOR.toBase58());
  assert.equal(g.feeRecipient, MINT.toBase58());
  assert.equal(g.feeBasisPoints, 95n);
  assert.equal(g.creatorFeeBasisPoints, 5n);
  assert.equal(g.initialRealTokenReserves, 793_100_000_000_000n);
  // Zero-filled slots are skipped, not returned as the system program.
  assert.deepEqual(g.feeRecipients, [USER.toBase58(), CREATOR.toBase58()]);
});

test("a Global too short for the newer fields reports them as undefined", () => {
  const g = decodeGlobal(globalBuf({ length: 120 }));
  assert.equal(g.feeBasisPoints, 95n);
  assert.equal(g.creatorFeeBasisPoints, undefined);
  assert.deepEqual(g.feeRecipients, []);
});

test("Global rejects a bad discriminator or a stub too short to hold the fee", () => {
  const bad = globalBuf();
  bad.writeUInt8(0xff, 0);
  assert.throws(() => decodeGlobal(bad), CurveDecodeError);
  assert.throws(
    () => decodeGlobal(globalBuf().subarray(0, 100)),
    CurveDecodeError,
  );
});

// ── FeeConfig decoding ───────────────────────────────────────────────────────

function feeConfigBuf(
  tiers: { threshold: bigint; lp: bigint; protocol: bigint; creator: bigint }[],
  truncateTiers = 0,
): Buffer {
  const HEAD = 8 + 1 + 32 + 24 + 4;
  const buf = Buffer.alloc(HEAD + (tiers.length - truncateTiers) * 40);
  buf.writeUInt8(255, 8); // bump
  CREATOR.toBuffer().copy(buf, 9);
  buf.writeBigUInt64LE(20n, 41); // flat lp
  buf.writeBigUInt64LE(95n, 49); // flat protocol
  buf.writeBigUInt64LE(5n, 57); // flat creator
  buf.writeUInt32LE(tiers.length, 65); // declared count (may exceed what fits)
  tiers.slice(0, tiers.length - truncateTiers).forEach((t, i) => {
    const off = HEAD + i * 40;
    buf.writeBigUInt64LE(t.threshold & 0xffff_ffff_ffff_ffffn, off);
    buf.writeBigUInt64LE(t.threshold >> 64n, off + 8);
    buf.writeBigUInt64LE(t.lp, off + 16);
    buf.writeBigUInt64LE(t.protocol, off + 24);
    buf.writeBigUInt64LE(t.creator, off + 32);
  });
  return buf;
}

test("FeeConfig decodes flat fees and the u128-thresholded tier vector", () => {
  const cfg = decodeFeeConfig(
    feeConfigBuf([
      { threshold: 0n, lp: 0n, protocol: 100n, creator: 5n },
      { threshold: 2n ** 70n, lp: 0n, protocol: 50n, creator: 5n },
    ]),
  );
  assert.equal(cfg.flatFees.protocolFeeBps, 95n);
  assert.equal(cfg.flatFees.creatorFeeBps, 5n);
  assert.equal(cfg.feeTiers.length, 2);
  assert.equal(cfg.feeTiers[0]?.marketCapLamportsThreshold, 0n);
  assert.equal(
    cfg.feeTiers[1]?.marketCapLamportsThreshold,
    2n ** 70n,
    "thresholds exceed u64 and must not wrap",
  );
  assert.equal(cfg.feeTiers[1]?.fees.protocolFeeBps, 50n);
});

test("a truncated tier vector stops at the last whole tier instead of reading garbage", () => {
  const cfg = decodeFeeConfig(
    feeConfigBuf(
      [
        { threshold: 0n, lp: 0n, protocol: 100n, creator: 5n },
        { threshold: 1_000n, lp: 0n, protocol: 50n, creator: 5n },
      ],
      1,
    ),
  );
  assert.equal(cfg.feeTiers.length, 1);
  assert.throws(() => decodeFeeConfig(Buffer.alloc(20)), CurveDecodeError);
});
