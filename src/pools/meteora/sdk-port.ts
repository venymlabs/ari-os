/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PoolGuardError } from "../errors.js";
import type { LiquidityShape, PriceLevel } from "../types.js";

/**
 * The DLMM SDK, behind a port.
 *
 * `@meteora-ag/dlmm` is a heavy dependency that drags in Anchor, `BN`, `Decimal`
 * and a second copy of the SPL token stack. Rather than let those types leak into
 * every layer above, this file declares the *shape* of what is actually needed —
 * eight methods — and loads the real package lazily at first use.
 *
 * That buys three things:
 *   - the module typechecks and its tests run with the SDK **absent** — it is an
 *     optional peer dependency, so it is not in the lockfile and adds nothing to
 *     `npm audit --omit=dev` until an operator installs it deliberately;
 *   - every test drives a hand-written fake instead of mocking Anchor;
 *   - a second CLMM venue can implement the same port without inheriting Meteora's
 *     vocabulary.
 *
 * Nothing in this port signs. Builders return instructions plus any extra signer
 * the SDK demands; deciding what to do about that signer is `intent.ts`'s job.
 */

/** Raw position as the SDK reports it, already reduced to primitives. */
export interface SdkPosition {
  readonly publicKey: string;
  readonly owner: string;
  readonly lowerBinId: PriceLevel;
  readonly upperBinId: PriceLevel;
  /** Base-unit totals across the position's bins. `x` is token X, `y` is token Y. */
  readonly totalXAmount: bigint;
  readonly totalYAmount: bigint;
  readonly feeX: bigint;
  readonly feeY: bigint;
  readonly lastUpdatedAt: number | undefined;
}

export interface SdkPoolState {
  readonly address: string;
  readonly binStep: number;
  readonly activeBinId: PriceLevel;
  readonly tokenXMint: string;
  readonly tokenXDecimals: number;
  readonly tokenXProgramId: string;
  readonly tokenYMint: string;
  readonly tokenYDecimals: number;
  readonly tokenYProgramId: string;
  readonly baseFeeBps: number;
  readonly reserveX: bigint;
  readonly reserveY: bigint;
}

/** What a builder hands back: instructions, plus any signer beyond the wallet. */
export interface SdkTxParts {
  readonly instructions: readonly TransactionInstruction[];
  /** Base58 pubkeys of additional required signers (e.g. a new position keypair). */
  readonly extraSigners: readonly string[];
  readonly description: string;
}

export interface AddLiquidityArgs {
  readonly owner: string;
  /** Omit to initialise a brand-new position (which requires an extra signer). */
  readonly positionAddress?: string;
  readonly lowerBinId: PriceLevel;
  readonly upperBinId: PriceLevel;
  readonly totalXAmount: bigint;
  readonly totalYAmount: bigint;
  readonly shape: LiquidityShape;
}

export interface RemoveLiquidityArgs {
  readonly owner: string;
  readonly positionAddress: string;
  readonly fromBinId: PriceLevel;
  readonly toBinId: PriceLevel;
  /** 0..10_000 of each bin's liquidity. */
  readonly bpsToRemove: number;
  readonly claimAndClose: boolean;
}

export interface DlmmPoolHandle {
  readonly state: SdkPoolState;
  refresh(): Promise<SdkPoolState>;
  positionsOf(owner: string): Promise<readonly SdkPosition[]>;
  buildAddLiquidity(args: AddLiquidityArgs): Promise<SdkTxParts>;
  buildRemoveLiquidity(args: RemoveLiquidityArgs): Promise<SdkTxParts>;
  buildClaimFees(args: {
    readonly owner: string;
    readonly positionAddress: string;
  }): Promise<SdkTxParts>;
}

export interface DlmmSdk {
  openPool(poolAddress: string): Promise<DlmmPoolHandle>;
  positionsOfUser(
    owner: string,
  ): Promise<readonly { pool: string; position: SdkPosition }[]>;
}

export const DLMM_PACKAGE = "@meteora-ag/dlmm";

/**
 * Load `@meteora-ag/dlmm` at runtime.
 *
 * The specifier is held in a variable so TypeScript treats the import as `any`
 * rather than failing to resolve a module that is intentionally not a build-time
 * dependency. A missing package produces `POOL_SDK_MISSING` naming the install
 * command — not a stack trace from deep inside Anchor.
 */
export async function loadDlmmModule(): Promise<Record<string, unknown>> {
  const specifier = DLMM_PACKAGE;
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (e) {
    throw new PoolGuardError(
      "POOL_SDK_MISSING",
      `${DLMM_PACKAGE} is not installed. Run "npm install ${DLMM_PACKAGE}" ` +
        "to enable Meteora liquidity actions — it is an OPTIONAL peer dependency, " +
        "deliberately kept out of the production install so it adds no audit surface " +
        "to a deployment that does not use it.",
      { cause: e instanceof Error ? e.message : String(e) },
    );
  }
}

/** SDK `StrategyType` names for our venue-agnostic shapes. */
export const STRATEGY_NAME: Readonly<Record<LiquidityShape, string>> = {
  spot: "Spot",
  curve: "Curve",
  "bid-ask": "BidAsk",
};

/**
 * Compile instructions into an unsigned v0 transaction, base64 wire.
 *
 * The SDK emits legacy `Transaction` objects; recompiling their instructions to v0
 * keeps one wire format across this whole package and matches what the kernel's
 * simulator and signer already handle. No address-lookup tables are resolved,
 * which caps how many bins fit in one transaction — the `maxLevelSpan` guard is
 * what stops a caller walking into that wall.
 */
export function compileV0(args: {
  readonly payer: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly recentBlockhash: string;
}): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(args.payer),
    recentBlockhash: args.recentBlockhash,
    instructions: [...args.instructions],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}
