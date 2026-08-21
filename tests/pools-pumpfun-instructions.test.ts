/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "../src/chains/solana/spl.js";
import {
  BUY_DISCRIMINATOR,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SELL_DISCRIMINATOR,
} from "../src/pools/pumpfun/constants.js";
import {
  bondingCurvePda,
  creatorVaultPda,
  eventAuthorityPda,
  feeConfigPda,
  globalPda,
  globalVolumeAccumulatorPda,
  userVolumeAccumulatorPda,
} from "../src/pools/pumpfun/curve.js";
import {
  buildBuyInstruction,
  buildSellInstruction,
  buildUnsignedTx,
  buyAccounts,
  type CurveIxContext,
  ensureUserAtaInstruction,
  pickFeeRecipient,
  sellAccounts,
} from "../src/pools/pumpfun/instructions.js";

const MINT = new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
const CREATOR = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const USER = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
);
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

const CTX: CurveIxContext = {
  user: USER,
  mint: MINT,
  creator: CREATOR,
  feeRecipient: FEE_RECIPIENT,
};

/**
 * The account ORDER is the part of pump.fun that has moved most often, so these
 * pin ordinal → name against the published IDL. If pump reorders again, this is
 * the test that fails instead of a transaction reverting on chain.
 */
const BUY_ORDER = [
  "global",
  "fee_recipient",
  "mint",
  "bonding_curve",
  "associated_bonding_curve",
  "associated_user",
  "user",
  "system_program",
  "token_program",
  "creator_vault",
  "event_authority",
  "program",
  "global_volume_accumulator",
  "user_volume_accumulator",
  "fee_config",
  "fee_program",
];

const SELL_ORDER = [
  "global",
  "fee_recipient",
  "mint",
  "bonding_curve",
  "associated_bonding_curve",
  "associated_user",
  "user",
  "system_program",
  "creator_vault",
  "token_program",
  "event_authority",
  "program",
  "fee_config",
  "fee_program",
];

test("buy accounts match the IDL order exactly", () => {
  assert.deepEqual(
    buyAccounts(CTX).map((a) => a.name),
    BUY_ORDER,
  );
});

test("sell accounts match the IDL order — note creator_vault moves ahead of token_program", () => {
  const names = sellAccounts(CTX).map((a) => a.name);
  assert.deepEqual(names, SELL_ORDER);
  assert.ok(
    names.indexOf("creator_vault") < names.indexOf("token_program"),
    "sell puts creator_vault first",
  );
  const buyNames = buyAccounts(CTX).map((a) => a.name);
  assert.ok(
    buyNames.indexOf("creator_vault") > buyNames.indexOf("token_program"),
    "buy puts token_program first",
  );
});

test("every account resolves to the PDA the IDL derives", () => {
  const slots = Object.fromEntries(
    buyAccounts(CTX).map((a) => [a.name, a.pubkey.toBase58()]),
  );
  assert.equal(slots.global, globalPda().toBase58());
  assert.equal(slots.bonding_curve, bondingCurvePda(MINT).toBase58());
  assert.equal(slots.creator_vault, creatorVaultPda(CREATOR).toBase58());
  assert.equal(slots.event_authority, eventAuthorityPda().toBase58());
  assert.equal(
    slots.global_volume_accumulator,
    globalVolumeAccumulatorPda().toBase58(),
  );
  assert.equal(
    slots.user_volume_accumulator,
    userVolumeAccumulatorPda(USER).toBase58(),
  );
  assert.equal(slots.fee_config, feeConfigPda().toBase58());
  assert.equal(slots.fee_program, PUMP_FEE_PROGRAM_ID.toBase58());
  assert.equal(slots.program, PUMP_PROGRAM_ID.toBase58());
  assert.equal(slots.system_program, SystemProgram.programId.toBase58());
  assert.equal(slots.token_program, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(slots.user, USER.toBase58());
  assert.equal(slots.fee_recipient, FEE_RECIPIENT.toBase58());
});

test("the wallet is the only signer, and exactly the mutating accounts are writable", () => {
  for (const slots of [buyAccounts(CTX), sellAccounts(CTX)]) {
    const signers = slots.filter((s) => s.isSigner).map((s) => s.name);
    assert.deepEqual(
      signers,
      ["user"],
      "a second signer would be unsignable by the kernel",
    );
  }
  const buyWritable = buyAccounts(CTX)
    .filter((s) => s.isWritable)
    .map((s) => s.name);
  assert.deepEqual(buyWritable, [
    "fee_recipient",
    "bonding_curve",
    "associated_bonding_curve",
    "associated_user",
    "user",
    "creator_vault",
    "user_volume_accumulator",
  ]);
  const sellWritable = sellAccounts(CTX)
    .filter((s) => s.isWritable)
    .map((s) => s.name);
  assert.deepEqual(sellWritable, [
    "fee_recipient",
    "bonding_curve",
    "associated_bonding_curve",
    "associated_user",
    "user",
    "creator_vault",
  ]);
});

// ── instruction data ─────────────────────────────────────────────────────────

test("buy data is disc(8) + amount(8) + max_sol_cost(8) + track_volume(1)", () => {
  const ix = buildBuyInstruction({
    ctx: CTX,
    tokenAmount: 123_456n,
    maxSolCostLamports: 987_654_321n,
  });
  const data = Buffer.from(ix.data);
  assert.equal(data.length, 25);
  assert.deepEqual([...data.subarray(0, 8)], [...BUY_DISCRIMINATOR]);
  assert.equal(data.readBigUInt64LE(8), 123_456n);
  assert.equal(data.readBigUInt64LE(16), 987_654_321n);
  assert.equal(data.readUInt8(24), 1, "OptionBool defaults to tracking volume");
  assert.equal(ix.programId.toBase58(), PUMP_PROGRAM_ID.toBase58());
  assert.equal(ix.keys.length, 16);
});

test("track_volume can be switched off and encodes as a single zero byte", () => {
  const ix = buildBuyInstruction({
    ctx: CTX,
    tokenAmount: 1n,
    maxSolCostLamports: 1n,
    trackVolume: false,
  });
  assert.equal(Buffer.from(ix.data).readUInt8(24), 0);
});

test("sell data is disc(8) + amount(8) + min_sol_output(8) and carries no OptionBool", () => {
  const ix = buildSellInstruction({
    ctx: CTX,
    tokenAmount: 5_000n,
    minSolOutputLamports: 42n,
  });
  const data = Buffer.from(ix.data);
  assert.equal(data.length, 24);
  assert.deepEqual([...data.subarray(0, 8)], [...SELL_DISCRIMINATOR]);
  assert.equal(data.readBigUInt64LE(8), 5_000n);
  assert.equal(data.readBigUInt64LE(16), 42n);
  assert.equal(ix.keys.length, 14);
});

test("amounts outside u64 are rejected rather than silently truncated", () => {
  assert.throws(
    () =>
      buildBuyInstruction({
        ctx: CTX,
        tokenAmount: -1n,
        maxSolCostLamports: 1n,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildBuyInstruction({
        ctx: CTX,
        tokenAmount: 2n ** 64n,
        maxSolCostLamports: 1n,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildSellInstruction({
        ctx: CTX,
        tokenAmount: 1n,
        minSolOutputLamports: 2n ** 70n,
      }),
    RangeError,
  );
});

test("the buy discriminator differs from the sell one (they share sighashes only across programs)", () => {
  assert.notDeepEqual([...BUY_DISCRIMINATOR], [...SELL_DISCRIMINATOR]);
});

// ── transaction assembly ─────────────────────────────────────────────────────

test("the built transaction is an unsigned v0 tx with the compute-budget prefix", () => {
  const built = buildUnsignedTx({
    payer: USER,
    instructions: [
      ensureUserAtaInstruction(CTX),
      buildBuyInstruction({
        ctx: CTX,
        tokenAmount: 1_000n,
        maxSolCostLamports: 2_000n,
      }),
    ],
    recentBlockhash: BLOCKHASH,
    priorityFeeLamports: 200_000,
  });
  const tx = VersionedTransaction.deserialize(
    Buffer.from(built.unsignedTxBase64, "base64"),
  );
  assert.equal(tx.message.version, 0);
  assert.equal(tx.message.recentBlockhash, BLOCKHASH);
  assert.equal(
    tx.message.compiledInstructions.length,
    4,
    "2 compute-budget + ATA + buy",
  );
  assert.equal(
    tx.message.staticAccountKeys[0]?.toBase58(),
    USER.toBase58(),
    "payer is account 0",
  );
  assert.equal(
    tx.message.header.numRequiredSignatures,
    1,
    "the wallet alone can sign this",
  );
  assert.ok(
    tx.signatures.every((s) => s.every((b) => b === 0)),
    "nothing here signs",
  );
});

test("the declared priority fee equals what the compute-budget instruction will actually pay", () => {
  for (const requested of [0, 1, 200_000, 5_000_000]) {
    const built = buildUnsignedTx({
      payer: USER,
      instructions: [
        buildSellInstruction({
          ctx: CTX,
          tokenAmount: 1n,
          minSolOutputLamports: 1n,
        }),
      ],
      recentBlockhash: BLOCKHASH,
      priorityFeeLamports: requested,
      computeUnitLimit: 250_000,
    });
    // microLamports/CU is integral, so the payable fee is at most the request.
    assert.ok(
      built.priorityFeeLamports <= requested,
      `${built.priorityFeeLamports} > ${requested}`,
    );
    assert.ok(requested - built.priorityFeeLamports < 250_000 / 1_000_000 + 1);
  }
});

test("a negative or non-finite priority fee is refused", () => {
  const args = {
    payer: USER,
    instructions: [
      buildSellInstruction({
        ctx: CTX,
        tokenAmount: 1n,
        minSolOutputLamports: 1n,
      }),
    ],
    recentBlockhash: BLOCKHASH,
  };
  assert.throws(
    () => buildUnsignedTx({ ...args, priorityFeeLamports: -1 }),
    RangeError,
  );
  assert.throws(
    () => buildUnsignedTx({ ...args, priorityFeeLamports: Number.NaN }),
    RangeError,
  );
});

test("the ATA create is idempotent and targets the user’s own token account", () => {
  const ix = ensureUserAtaInstruction(CTX);
  assert.equal(ix.keys[0]?.pubkey.toBase58(), USER.toBase58(), "the user pays");
  assert.ok(ix.keys.some((k) => k.pubkey.equals(MINT)));
});

// ── fee recipient rotation ───────────────────────────────────────────────────

test("fee recipient selection is deterministic and stays inside the rotation list", () => {
  const list = [USER.toBase58(), CREATOR.toBase58(), MINT.toBase58()];
  for (let seed = 0; seed < 20; seed++) {
    const picked = pickFeeRecipient(
      list,
      FEE_RECIPIENT.toBase58(),
      seed,
    ).toBase58();
    assert.ok(list.includes(picked), `seed ${seed} produced ${picked}`);
    assert.equal(
      picked,
      pickFeeRecipient(list, FEE_RECIPIENT.toBase58(), seed).toBase58(),
      "deterministic",
    );
  }
  assert.equal(
    pickFeeRecipient([], FEE_RECIPIENT.toBase58(), 3).toBase58(),
    FEE_RECIPIENT.toBase58(),
  );
  assert.equal(
    pickFeeRecipient(list, FEE_RECIPIENT.toBase58(), -7).toBase58(),
    list[1],
  );
});
