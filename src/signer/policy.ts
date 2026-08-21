import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { permissionsAreUnsafe } from "../platform.js";
import { isPublicKey, type DecodedTransaction } from "./transaction.js";

/**
 * Signer-side policy, re-checked inside the signer for every transaction.
 *
 * This is the Solana port of the EVM policy the isolated signer used to
 * enforce. The mapping is deliberate:
 *
 *   chainId              -> cluster            (bound through the envelope)
 *   from allowlist       -> feePayers
 *   `to` allowlist       -> program allowlist
 *   calldata prefixes    -> instruction discriminators, scoped per program
 *   maxValue             -> caps, denominated in the *input leg*
 *   maxGas / fee ceiling -> compute unit limit / price / priority-fee ceilings
 *
 * Caps are denominated in the asset leaving the wallet, so no price oracle
 * sits in the safety path and no oracle manipulation can widen a limit.
 */

export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
/** Solana's per-instruction default compute limit, and the per-tx maximum. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
const MAX_UNITS_PER_TRANSACTION = 1_400_000;
/** ComputeBudget instruction tags that actually move the fee. */
const SET_UNIT_LIMIT = "02";
const SET_UNIT_PRICE = "03";
/** The literal asset key used for lamport-denominated caps. */
export const NATIVE_ASSET = "native";

export type AmountEncoding = "u64le" | "u32le";

export interface SignerSpendRule {
  /** `native`, or the base58 mint whose base units this instruction moves. */
  asset: string;
  /** byte offset of the input amount within the instruction data */
  amountOffset: number;
  amountEncoding: AmountEncoding;
  /**
   * Index into the instruction's own account list holding the mint. When set,
   * the signer verifies that account equals `asset` — so the operator's
   * pinned asset and the instruction's actual asset cannot diverge.
   */
  mintAccountIndex?: number;
}

/**
 * One allowed (program, instruction) pair.
 *
 * `effect` is mandatory and exhaustive: every allowed instruction is either
 * declared value-moving (`spend`, with a rule saying how to read the input
 * leg), declared fee-moving (`fee`, ComputeBudget only), or explicitly
 * declared incapable of moving value (`none`). There is no default — an
 * instruction the operator has not classified is refused.
 */
export type SignerProgramRule = {
  programId: string;
  /** lowercase hex prefix of the instruction data */
  discriminator: string;
} & (
  | { effect: "none" }
  | { effect: "fee" }
  | { effect: "spend"; spend: SignerSpendRule }
);

export interface SignPolicy {
  cluster: string;
  feePayers: readonly string[];
  programs: readonly SignerProgramRule[];
  /** asset -> maximum total base units that may leave the wallet per tx */
  caps: Readonly<Record<string, bigint>>;
  maxInstructions: number;
  maxAccountKeys: number;
  maxRequiredSignatures: number;
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
  maxPriorityFeeLamports: bigint;
  /**
   * Optional second priority-fee ceiling expressed in bps of the native input
   * leg, mirroring Aetheria. Only applied when the transaction actually has a
   * native input leg, so it never depends on a price.
   */
  maxPriorityFeeBps?: number;
  /**
   * Address lookup tables this policy permits. Empty (the default) means any
   * transaction carrying a lookup is refused, because the signer cannot
   * resolve looked-up addresses without trusting an external RPC.
   */
  addressLookupTables: readonly string[];
}
export interface LoadedSignPolicy extends SignPolicy {
  version: number;
  hash: string;
}

export interface PolicyEvaluation {
  /** total base units of each asset leaving the wallet */
  spend: ReadonlyMap<string, bigint>;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  priorityFeeLamports: bigint;
}

const HEX_PREFIX = /^(?:[0-9a-f]{2})+$/;

function readAmount(
  data: Uint8Array,
  offset: number,
  encoding: AmountEncoding,
): bigint {
  const width = encoding === "u64le" ? 8 : 4;
  if (offset < 0 || offset + width > data.length)
    throw Error("policy_spend_unreadable");
  const view = Buffer.from(data.subarray(offset, offset + width));
  return encoding === "u64le"
    ? view.readBigUInt64LE(0)
    : BigInt(view.readUInt32LE(0));
}

/** Most specific (longest) matching discriminator wins. */
function matchRule(
  policy: SignPolicy,
  programId: string,
  dataHex: string,
): { rule: SignerProgramRule | undefined; programAllowed: boolean } {
  let best: SignerProgramRule | undefined,
    programAllowed = false;
  for (const rule of policy.programs) {
    if (rule.programId !== programId) continue;
    programAllowed = true;
    if (!dataHex.startsWith(rule.discriminator)) continue;
    if (!best || rule.discriminator.length > best.discriminator.length)
      best = rule;
  }
  return { rule: best, programAllowed };
}

/**
 * Re-check a decoded transaction against the signer's own policy.
 *
 * Throws `policy_*` on the first violation. The host cannot talk the signer
 * into signing something this function rejects: every input is read out of
 * the wire bytes, and every limit comes from the operator's mode-0600 policy
 * file, not from the request.
 */
export function evaluatePolicy(
  decoded: DecodedTransaction,
  policy: SignPolicy,
  expectedFeePayer: string,
): PolicyEvaluation {
  if (
    decoded.feePayer !== expectedFeePayer ||
    !policy.feePayers.includes(decoded.feePayer)
  )
    throw Error("policy_fee_payer");
  if (decoded.numRequiredSignatures > policy.maxRequiredSignatures)
    throw Error("policy_signers");
  if (decoded.staticAccountKeys.length > policy.maxAccountKeys)
    throw Error("policy_account_keys");
  if (decoded.instructions.length > policy.maxInstructions)
    throw Error("policy_instruction_count");
  for (const lookup of decoded.addressTableLookups)
    if (!policy.addressLookupTables.includes(lookup.accountKey))
      throw Error("policy_address_table_lookup");

  const spend = new Map<string, bigint>();
  let explicitLimit: number | undefined, unitPrice: bigint | undefined;
  for (const ix of decoded.instructions) {
    const { rule, programAllowed } = matchRule(
      policy,
      ix.programId,
      ix.dataHex,
    );
    if (!programAllowed) throw Error("policy_program");
    if (!rule) throw Error("policy_instruction");
    if (rule.effect === "none") continue;
    if (rule.effect === "fee") {
      // The runtime rejects duplicate compute-budget instructions; so does
      // the signer, rather than guessing which one the cluster would honour.
      if (rule.discriminator === SET_UNIT_LIMIT) {
        if (explicitLimit !== undefined) throw Error("policy_compute_units");
        explicitLimit = Number(readAmount(ix.data, 1, "u32le"));
      } else if (rule.discriminator === SET_UNIT_PRICE) {
        if (unitPrice !== undefined) throw Error("policy_compute_unit_price");
        unitPrice = readAmount(ix.data, 1, "u64le");
      }
      continue;
    }
    const { asset, amountOffset, amountEncoding, mintAccountIndex } =
      rule.spend;
    if (mintAccountIndex !== undefined) {
      const account = ix.accounts[mintAccountIndex];
      if (account === undefined) throw Error("policy_spend_mint_missing");
      // `null` means the account resolves through a lookup table, so the
      // signer cannot confirm the asset it is capping.
      if (account === null || account !== asset)
        throw Error("policy_spend_mint_mismatch");
    }
    const amount = readAmount(ix.data, amountOffset, amountEncoding);
    spend.set(asset, (spend.get(asset) ?? 0n) + amount);
  }

  const computeUnitLimit =
    explicitLimit ??
    Math.min(
      DEFAULT_UNITS_PER_INSTRUCTION * decoded.instructions.length,
      MAX_UNITS_PER_TRANSACTION,
    );
  if (
    !Number.isSafeInteger(computeUnitLimit) ||
    computeUnitLimit < 0 ||
    computeUnitLimit > policy.maxComputeUnitLimit
  )
    throw Error("policy_compute_units");
  const microLamports = unitPrice ?? 0n;
  if (microLamports > policy.maxComputeUnitPriceMicroLamports)
    throw Error("policy_compute_unit_price");
  // ceil(limit * microLamports / 1e6) — the lamports actually at risk.
  const priorityFeeLamports =
    (BigInt(computeUnitLimit) * microLamports + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > policy.maxPriorityFeeLamports)
    throw Error("policy_priority_fee");
  if (policy.maxPriorityFeeBps !== undefined) {
    const nativeLeg = spend.get(NATIVE_ASSET);
    if (nativeLeg !== undefined && nativeLeg > 0n) {
      const ceiling = (nativeLeg * BigInt(policy.maxPriorityFeeBps)) / 10_000n;
      if (priorityFeeLamports > ceiling) throw Error("policy_priority_fee");
    }
  }

  for (const [asset, total] of spend) {
    const cap = Object.prototype.hasOwnProperty.call(policy.caps, asset)
      ? policy.caps[asset]
      : undefined;
    if (typeof cap !== "bigint") throw Error("policy_cap_missing");
    if (total > cap) throw Error("policy_spend_cap");
  }
  return {
    spend,
    computeUnitLimit,
    computeUnitPriceMicroLamports: microLamports,
    priorityFeeLamports,
  };
}

function parseUnsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw Error(`policy_${label}_invalid`);
  return BigInt(value);
}
function parseCount(value: unknown, label: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    throw Error(`policy_${label}_invalid`);
  return value as number;
}

function parseProgramRule(x: unknown): SignerProgramRule {
  if (!x || typeof x !== "object") throw Error("policy_program_invalid");
  const r = x as Record<string, unknown>;
  if (!isPublicKey(r.programId)) throw Error("policy_program_invalid");
  if (
    typeof r.discriminator !== "string" ||
    !HEX_PREFIX.test(r.discriminator) ||
    r.discriminator.length > 32
  )
    throw Error("policy_discriminator_invalid");
  const base = { programId: r.programId, discriminator: r.discriminator };
  if (r.effect === "none") return { ...base, effect: "none" };
  if (r.effect === "fee") {
    if (r.programId !== COMPUTE_BUDGET_PROGRAM_ID)
      throw Error("policy_fee_effect_invalid");
    if (
      r.discriminator !== SET_UNIT_LIMIT &&
      r.discriminator !== SET_UNIT_PRICE
    )
      throw Error("policy_fee_effect_invalid");
    return { ...base, effect: "fee" };
  }
  if (r.effect !== "spend") throw Error("policy_effect_invalid");
  const s = r.spend as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") throw Error("policy_spend_invalid");
  if (s.asset !== NATIVE_ASSET && !isPublicKey(s.asset))
    throw Error("policy_spend_invalid");
  if (s.amountEncoding !== "u64le" && s.amountEncoding !== "u32le")
    throw Error("policy_spend_invalid");
  const spend: SignerSpendRule = {
    asset: s.asset as string,
    amountOffset: parseCount(s.amountOffset, "spend", 1024),
    amountEncoding: s.amountEncoding,
    ...(s.mintAccountIndex === undefined
      ? {}
      : { mintAccountIndex: parseCount(s.mintAccountIndex, "spend", 255) }),
  };
  if (spend.mintAccountIndex !== undefined && spend.asset === NATIVE_ASSET)
    throw Error("policy_spend_invalid");
  return { ...base, effect: "spend", spend };
}

/**
 * Load and validate the signer policy from a mode-0600 regular file.
 *
 * The returned `hash` is the sha256 of the exact file bytes; the daemon binds
 * authorization envelopes to it so a policy swap invalidates in-flight
 * authorizations instead of silently widening what may be signed.
 */
export async function loadSignPolicy(path: string): Promise<LoadedSignPolicy> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw Error("policy_symlink_forbidden");
  if (!st.isFile()) throw Error("policy_format_invalid");
  if (permissionsAreUnsafe(st)) throw Error("policy_permissions_unsafe");
  const raw = await readFile(path, "utf8");
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(raw);
  } catch {
    throw Error("policy_format_invalid");
  }
  if (
    x.version !== 1 ||
    typeof x.cluster !== "string" ||
    !x.cluster ||
    !Array.isArray(x.feePayers) ||
    !x.feePayers.length ||
    !x.feePayers.every(isPublicKey) ||
    !Array.isArray(x.programs) ||
    !x.programs.length ||
    !x.caps ||
    typeof x.caps !== "object" ||
    Array.isArray(x.caps) ||
    !Array.isArray(x.addressLookupTables) ||
    !x.addressLookupTables.every(isPublicKey)
  )
    throw Error("policy_format_invalid");

  const programs = x.programs.map(parseProgramRule),
    seen = new Set<string>();
  for (const p of programs) {
    const key = `${p.programId}:${p.discriminator}`;
    if (seen.has(key)) throw Error("policy_program_duplicate");
    seen.add(key);
  }
  const caps: Record<string, bigint> = {};
  for (const [asset, value] of Object.entries(
    x.caps as Record<string, unknown>,
  )) {
    if (asset !== NATIVE_ASSET && !isPublicKey(asset))
      throw Error("policy_cap_invalid");
    caps[asset] = parseUnsigned(value, "cap");
  }
  return {
    version: 1,
    cluster: x.cluster,
    feePayers: [...(x.feePayers as string[])],
    programs,
    caps,
    maxInstructions: parseCount(x.maxInstructions, "max_instructions", 64),
    maxAccountKeys: parseCount(x.maxAccountKeys, "max_account_keys", 256),
    maxRequiredSignatures: parseCount(
      x.maxRequiredSignatures,
      "max_required_signatures",
      8,
    ),
    maxComputeUnitLimit: parseCount(
      x.maxComputeUnitLimit,
      "max_compute_unit_limit",
      MAX_UNITS_PER_TRANSACTION,
    ),
    maxComputeUnitPriceMicroLamports: parseUnsigned(
      x.maxComputeUnitPriceMicroLamports,
      "max_compute_unit_price",
    ),
    maxPriorityFeeLamports: parseUnsigned(
      x.maxPriorityFeeLamports,
      "max_priority_fee",
    ),
    ...(x.maxPriorityFeeBps === undefined
      ? {}
      : {
          maxPriorityFeeBps: parseCount(
            x.maxPriorityFeeBps,
            "max_priority_fee_bps",
            10_000,
          ),
        }),
    addressLookupTables: [...(x.addressLookupTables as string[])],
    hash: `0x${createHash("sha256").update(raw).digest("hex")}`,
  };
}
