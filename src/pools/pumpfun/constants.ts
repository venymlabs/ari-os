/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublicKey } from "@solana/web3.js";

/**
 * pump.fun program constants, taken verbatim from the published IDL at
 * `github.com/pump-fun/pump-public-docs` (`idl/pump.json`, `idl/pump_fees.json`).
 *
 * Everything here is data, not behaviour, so the layout can be re-pinned to a new
 * program version by editing this file alone. That matters more than usual: pump
 * has changed the `buy`/`sell` account lists at least three times (creator vaults,
 * then volume accumulators, then the dynamic fee program), and a stale account
 * list does not fail loudly — it fails as a mangled transaction.
 */

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);

/** Anchor sighashes. NB: PumpSwap (the post-migration AMM) reuses these — the program id disambiguates. */
export const BUY_DISCRIMINATOR = Uint8Array.from([
  102, 6, 61, 18, 1, 218, 235, 234,
]);
export const SELL_DISCRIMINATOR = Uint8Array.from([
  51, 230, 133, 164, 1, 127, 131, 173,
]);

/** Account discriminators (`sha256("account:<Name>")[0..8]`). */
export const BONDING_CURVE_DISCRIMINATOR = Uint8Array.from([
  23, 183, 248, 55, 96, 216, 172, 96,
]);
export const GLOBAL_DISCRIMINATOR = Uint8Array.from([
  167, 232, 232, 177, 200, 108, 114, 127,
]);

export const SEED_GLOBAL = Buffer.from("global");
export const SEED_BONDING_CURVE = Buffer.from("bonding-curve");
export const SEED_CREATOR_VAULT = Buffer.from("creator-vault");
export const SEED_EVENT_AUTHORITY = Buffer.from("__event_authority");
export const SEED_GLOBAL_VOLUME_ACCUMULATOR = Buffer.from(
  "global_volume_accumulator",
);
export const SEED_USER_VOLUME_ACCUMULATOR = Buffer.from(
  "user_volume_accumulator",
);
export const SEED_FEE_CONFIG = Buffer.from("fee_config");

/**
 * Total supply minted by every standard pump.fun launch: 1,000,000,000 tokens at
 * 6 decimals. Used only as a sanity check on a decoded curve — a mint whose
 * `tokenTotalSupply` disagrees is not a standard launch and gets refused.
 */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;
export const PUMP_TOKEN_DECIMALS = 6;

/**
 * Fallback fee split used only when the on-chain `FeeConfig` cannot be read. Since
 * the September 2025 change the real split is tiered by market cap, so this is a
 * *ceiling-ish* stand-in: 1% protocol + 0.05% creator was the pre-tier flat rate.
 * The maths module always prefers real tiers when they are supplied.
 */
export const FALLBACK_PROTOCOL_FEE_BPS = 100;
export const FALLBACK_CREATOR_FEE_BPS = 5;
