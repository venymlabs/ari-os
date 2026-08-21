/*
 * SPDX-License-Identifier: MIT
 *
 * Pins `src/chains/solana/spl.ts` — our replacement for the four things ARI OS
 * used from `@solana/spl-token` before that package was dropped over the
 * unpatched `bigint-buffer` advisory.
 *
 * Every expected value below was captured from `@solana/spl-token@0.4.15` while
 * it was still installed, by calling `getAssociatedTokenAddressSync` and
 * `createAssociatedTokenAccountIdempotentInstruction` and printing the result.
 * They are literals on purpose: this is transaction-building code, so the test
 * must fail if a constant, an account ordinal, a signer/writable flag or a data
 * byte ever changes, rather than recomputing the same mistake as the source.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src/chains/solana/spl.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Fixed, well-known mainnet addresses used purely as derivation inputs.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SRM = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("program ids match the published on-chain addresses", () => {
  assert.equal(
    TOKEN_PROGRAM_ID.toBase58(),
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  assert.equal(
    TOKEN_2022_PROGRAM_ID.toBase58(),
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  );
  assert.equal(
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
});

/**
 * mint, owner, token program, expected ATA — captured from the upstream library.
 * Every mint appears under both token programs so a regression that ignores the
 * token-program seed cannot pass.
 */
const ATA_VECTORS: ReadonlyArray<readonly [string, string, PublicKey, string]> =
  [
    [
      USDC,
      WALLET,
      TOKEN_PROGRAM_ID,
      "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
    ],
    [
      USDC,
      WALLET,
      TOKEN_2022_PROGRAM_ID,
      "GdjpegrtGwU3pgtzPivYVViSA8rmGL248qBVKzsrU3DD",
    ],
    [
      USDC,
      WSOL,
      TOKEN_PROGRAM_ID,
      "DHe62eeQVEnNK7vg5xUpDkJm7tuqHadjhvmPRFBG9UPo",
    ],
    [
      USDC,
      WSOL,
      TOKEN_2022_PROGRAM_ID,
      "taYqGwEHpcdcznSxzJVnctU3PV2XFzZq8zvyeK2KG9P",
    ],
    [
      WSOL,
      WALLET,
      TOKEN_PROGRAM_ID,
      "8LjUgMjzZuHj8VdyxzkmLLQVmW4C3gd56md1nLd76TNW",
    ],
    [
      WSOL,
      WALLET,
      TOKEN_2022_PROGRAM_ID,
      "DSEcUmCSeNX75D53mJSj2kxvbJYSoAxcLfVcEifzuTV1",
    ],
    [
      WSOL,
      WSOL,
      TOKEN_PROGRAM_ID,
      "5o9nTwSiofKC5DnLiv2gsjPYmGNgh2hAjieyAzyUuwi2",
    ],
    [
      WSOL,
      WSOL,
      TOKEN_2022_PROGRAM_ID,
      "BCduZwNgUqK9S2jKbRnTm2iWwLY5hyDNaWHgmTmreG6A",
    ],
    [
      SRM,
      WALLET,
      TOKEN_PROGRAM_ID,
      "GXanGGy8srBiAVt8Fvj7ZuSQ9tqTZtRVZ9uUGq5RZc9e",
    ],
    [
      SRM,
      WALLET,
      TOKEN_2022_PROGRAM_ID,
      "BNKf8JbpYQmqXE7DZMs6cSFhzVxpz5cLEqmsdSKaq2Bv",
    ],
    [
      SRM,
      WSOL,
      TOKEN_PROGRAM_ID,
      "96mybJFKBHwTU5Qb9JdTHukfKUgb5RTZKwriGqkrw1EB",
    ],
    [
      SRM,
      WSOL,
      TOKEN_2022_PROGRAM_ID,
      "C5UdBwryddssFs2jauwiGi8TVXPLg75QGeb2towBxRYR",
    ],
  ];

test("associatedTokenAddress reproduces the library's derived addresses", () => {
  for (const [mint, owner, tokenProgram, expected] of ATA_VECTORS) {
    assert.equal(
      associatedTokenAddress(
        new PublicKey(mint),
        new PublicKey(owner),
        tokenProgram,
      ).toBase58(),
      expected,
      `ATA for mint=${mint} owner=${owner} program=${tokenProgram.toBase58()}`,
    );
  }
});

test("the token program is a seed, so Token-2022 derives a different ATA", () => {
  for (const [mint, owner] of ATA_VECTORS) {
    const legacy = associatedTokenAddress(
      new PublicKey(mint),
      new PublicKey(owner),
      TOKEN_PROGRAM_ID,
    );
    const token2022 = associatedTokenAddress(
      new PublicKey(mint),
      new PublicKey(owner),
      TOKEN_2022_PROGRAM_ID,
    );
    assert.notEqual(legacy.toBase58(), token2022.toBase58());
  }
});

test("associatedTokenAddress defaults to the legacy token program", () => {
  assert.equal(
    associatedTokenAddress(
      new PublicKey(USDC),
      new PublicKey(WALLET),
    ).toBase58(),
    "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
  );
});

/** Flattens an instruction to the exact shape that gets serialised and signed. */
function wire(ix: {
  programId: PublicKey;
  data: Buffer | Uint8Array;
  keys: ReadonlyArray<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>;
}) {
  return {
    programId: ix.programId.toBase58(),
    data: [...ix.data],
    keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  };
}

test("CreateIdempotent serialises byte-for-byte as the library did (legacy)", () => {
  const ata = associatedTokenAddress(
    new PublicKey(USDC),
    new PublicKey(WALLET),
    TOKEN_PROGRAM_ID,
  );
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    ata,
    new PublicKey(WALLET),
    new PublicKey(USDC),
    TOKEN_PROGRAM_ID,
  );

  assert.deepEqual(wire(ix), {
    programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    // 1 = CreateIdempotent. 0 would be plain Create, which reverts on an
    // account that already exists.
    data: [1],
    keys: [
      [WALLET, true, true], // 0 payer      — signer, writable
      ["FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B", false, true], // 1 ATA — writable
      [WALLET, false, false], // 2 owner
      [USDC, false, false], // 3 mint
      [SYSTEM_PROGRAM, false, false], // 4 system program
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false], // 5 token program
    ],
  });
});

test("CreateIdempotent serialises byte-for-byte as the library did (Token-2022)", () => {
  const ata = associatedTokenAddress(
    new PublicKey(USDC),
    new PublicKey(WSOL),
    TOKEN_2022_PROGRAM_ID,
  );
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    ata,
    new PublicKey(WSOL),
    new PublicKey(USDC),
    TOKEN_2022_PROGRAM_ID,
  );

  assert.deepEqual(wire(ix), {
    programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    data: [1],
    keys: [
      [WALLET, true, true],
      ["taYqGwEHpcdcznSxzJVnctU3PV2XFzZq8zvyeK2KG9P", false, true],
      [WSOL, false, false],
      [USDC, false, false],
      [SYSTEM_PROGRAM, false, false],
      ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", false, false],
    ],
  });
});

test("payer is the only signer and only payer+ATA are writable", () => {
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    associatedTokenAddress(new PublicKey(SRM), new PublicKey(WSOL)),
    new PublicKey(WSOL),
    new PublicKey(SRM),
  );
  assert.equal(ix.keys.length, 6);
  assert.deepEqual(
    ix.keys.map((k) => k.isSigner),
    [true, false, false, false, false, false],
  );
  assert.deepEqual(
    ix.keys.map((k) => k.isWritable),
    [true, true, false, false, false, false],
  );
  assert.equal(ix.data.length, 1);
});

test("account 4 is the real System Program id", () => {
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    associatedTokenAddress(new PublicKey(USDC), new PublicKey(WALLET)),
    new PublicKey(WALLET),
    new PublicKey(USDC),
  );
  assert.equal(
    ix.keys[4]!.pubkey.toBase58(),
    SystemProgram.programId.toBase58(),
  );
  assert.equal(ix.keys[4]!.pubkey.toBase58(), SYSTEM_PROGRAM);
});

test("defaults: legacy token program and the ATA program", () => {
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    associatedTokenAddress(new PublicKey(USDC), new PublicKey(WALLET)),
    new PublicKey(WALLET),
    new PublicKey(USDC),
  );
  assert.equal(ix.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(ix.keys[5]!.pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
});

test("the ATA program id argument is honoured when overridden", () => {
  const other = new PublicKey(SRM);
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    new PublicKey(WALLET),
    associatedTokenAddress(new PublicKey(USDC), new PublicKey(WALLET)),
    new PublicKey(WALLET),
    new PublicKey(USDC),
    TOKEN_PROGRAM_ID,
    other,
  );
  assert.equal(ix.programId.toBase58(), other.toBase58());
});

test("off-curve owners derive an ATA (a PDA can hold one)", () => {
  // A pump.fun bonding curve is a PDA and is never on the ed25519 curve; the
  // library's `allowOwnerOffCurve` path must be the one we reproduce.
  const curve = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(USDC).toBuffer()],
    new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  )[0];
  assert.equal(PublicKey.isOnCurve(curve.toBytes()), false);
  assert.doesNotThrow(() =>
    associatedTokenAddress(new PublicKey(USDC), curve, TOKEN_PROGRAM_ID),
  );
});
