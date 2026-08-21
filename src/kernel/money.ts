/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/** Wrapped SOL — also the sentinel mint for native SOL throughout the kernel. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** The assets in which spend caps are denominated (the "input leg"). */
export const SOL_QUOTE_MINTS: readonly string[] = [WSOL_MINT];
export const USDC_QUOTE_MINTS: readonly string[] = [USDC_MINT, USDT_MINT];

export type QuoteBucket = "sol" | "usdc";

/**
 * Returns the cap bucket an input mint draws from, or null when it is not a
 * quote asset (i.e. a sell, which receives quote rather than spending it).
 */
export function quoteBucketFor(mint: string): QuoteBucket | null {
  if (SOL_QUOTE_MINTS.includes(mint)) return "sol";
  if (USDC_QUOTE_MINTS.includes(mint)) return "usdc";
  return null;
}

export interface TokenAmount {
  readonly mint: string;
  readonly amount: bigint; // base units
  readonly decimals: number;
}

/**
 * Parse a UI amount (e.g. 1.5 SOL) to base units WITHOUT float drift.
 * Accepts a number or a decimal string; rejects exponent / negative / junk.
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const s =
    typeof amount === "number" ? amount.toFixed(decimals) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new RangeError(
      `invalid amount for ${decimals} decimals: ${String(amount)}`,
    );
  }
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole ?? "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")
  );
}

/** base units → JS number (display only; never use the result for cap math). */
export function fromBaseUnits(amount: bigint, decimals: number): number {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const frac = magnitude % base;
  const value = Number(whole) + Number(frac) / Number(base);
  return negative ? -value : value;
}

export function formatAmount(
  amount: bigint,
  decimals: number,
  maxFractionDigits = 6,
): string {
  return fromBaseUnits(amount, decimals).toLocaleString("en-US", {
    maximumFractionDigits: maxFractionDigits,
  });
}

/** Effective slippage in bps between an expected and an actual (received) amount. */
export function slippageBps(expected: bigint, actual: bigint): number {
  if (expected <= 0n) return 0;
  const diff = expected - actual; // positive = received less than expected
  return Number((diff * 10_000n) / expected);
}
