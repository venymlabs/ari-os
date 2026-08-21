import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  canonicalClaims,
  createEncryptedKeystore,
  decodeTransaction,
  generateSecretKey,
  AUTHORIZATION_PROTOCOL,
  type AuthorizationClaims,
  type AuthorizationEnvelope,
} from "../src/signer/index.js";
import { removeDir } from "./helpers.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111";
export const MAC_KEY = "wire-test-key";
export const CLUSTER = "mainnet-beta";

/** Deterministic HMAC envelope signer/verifier pair used across signer tests. */
export const envelopeSigner = {
  sign: async (d: string) =>
    createHmac("sha256", MAC_KEY).update(d).digest("hex"),
};
export const envelopeVerifier = {
  verify: async (d: string, s: string) =>
    createHmac("sha256", MAC_KEY).update(d).digest("hex") === s,
};

export const h = (x: string) =>
  `0x${createHash("sha256").update(x).digest("hex")}`;
export const blockhash = (byte = 7) => bs58.encode(Buffer.alloc(32, byte));
export const pubkey = (byte: number) =>
  new PublicKey(Buffer.alloc(32, byte)).toBase58();

const dirs: string[] = [];
export function tempDir(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function cleanupTempDirs() {
  dirs.splice(0).forEach(removeDir);
}

export interface TestWallet {
  keystore: string;
  publicKey: string;
  password: string;
}
/** Create a real mode-0600 keystore; tests exercise the production path. */
export async function createTestWallet(
  dir: string,
  password = "correct horse battery staple",
): Promise<TestWallet> {
  const keystore = join(dir, "wallet.json"),
    secret = generateSecretKey();
  const publicKey = await createEncryptedKeystore(keystore, secret, password);
  secret.fill(0);
  return { keystore, publicKey, password };
}

/** System `transfer` — tag 2 (u32 LE) then lamports (u64 LE) at offset 4. */
export function systemTransfer(from: string, to: string, lamports: bigint) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return new TransactionInstruction({
    programId: new PublicKey(SYSTEM_PROGRAM),
    keys: [
      { pubkey: new PublicKey(from), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(to), isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** SPL `TransferChecked` — tag 12, amount (u64 LE) at 1, mint at account 1. */
export function transferChecked(opts: {
  source: string;
  mint: string;
  destination: string;
  owner: string;
  amount: bigint;
  decimals?: number;
}) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(opts.amount, 1);
  data.writeUInt8(opts.decimals ?? 6, 9);
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: new PublicKey(opts.source), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(opts.mint), isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey(opts.destination),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: new PublicKey(opts.owner), isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** ComputeBudget SetComputeUnitLimit (tag 2) / SetComputeUnitPrice (tag 3). */
export function setComputeUnitLimit(units: number) {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return new TransactionInstruction({
    programId: new PublicKey(COMPUTE_BUDGET_PROGRAM),
    keys: [],
    data,
  });
}
export function setComputeUnitPrice(microLamports: bigint) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(microLamports, 1);
  return new TransactionInstruction({
    programId: new PublicKey(COMPUTE_BUDGET_PROGRAM),
    keys: [],
    data,
  });
}

export function lookupTable(key: string, addresses: string[]) {
  return new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: addresses.map((a) => new PublicKey(a)),
    },
  });
}

/** Compile an unsigned transaction and return its base64 wire form. */
export function buildTransaction(opts: {
  payer: string;
  instructions: TransactionInstruction[];
  recentBlockhash?: string;
  legacy?: boolean;
  lookupTables?: AddressLookupTableAccount[];
}): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(opts.payer),
    recentBlockhash: opts.recentBlockhash ?? blockhash(),
    instructions: opts.instructions,
  });
  const compiled = opts.legacy
    ? message.compileToLegacyMessage()
    : message.compileToV0Message(opts.lookupTables ?? []);
  return Buffer.from(new VersionedTransaction(compiled).serialize()).toString(
    "base64",
  );
}

export interface EnvelopeOptions {
  id?: string;
  cluster?: string;
  audience?: string;
  signerKeyId?: string;
  policyHash?: string;
  policyVersion?: number;
  lastValidBlockHeight?: number;
  issuedAt?: number;
  ttlMs?: number;
  key?: string;
  mutate?: (claims: AuthorizationClaims) => AuthorizationClaims;
}

/**
 * Build an authorization envelope whose claims mirror an independent decode
 * of `transaction`. `mutate` lets a test make the claims lie about the bytes.
 */
export function makeEnvelope(
  transaction: string,
  options: EnvelopeOptions = {},
): AuthorizationEnvelope {
  const d = decodeTransaction(transaction),
    issuedAt = options.issuedAt ?? 1000,
    claims: AuthorizationClaims = {
      protocol: AUTHORIZATION_PROTOCOL,
      version: 1,
      id: options.id ?? "auth-1",
      cluster: options.cluster ?? CLUSTER,
      quoteHash: h("quote"),
      policyHash: options.policyHash ?? h("policy"),
      policyVersion: options.policyVersion ?? 1,
      riskHash: h("risk"),
      reservationId: "reservation",
      approvalId: "approval",
      audience: options.audience ?? "daemon",
      signerKeyId: options.signerKeyId ?? "wallet",
      feePayer: d.feePayer,
      transaction: d.wireBase64,
      message: d.messageBase64,
      messageHash: d.messageHash,
      recentBlockhash: d.recentBlockhash,
      lastValidBlockHeight: options.lastValidBlockHeight ?? 1_000,
      programIds: [...new Set(d.instructions.map((i) => i.programId))].sort(),
      accountKeys: [...d.staticAccountKeys],
      instructions: d.instructions.map((i) => ({
        programId: i.programId,
        accounts: [...i.accounts],
        data: i.dataHex,
      })),
      addressTableLookups: d.addressTableLookups.map((l) => l.accountKey),
      simulationHash: h("simulation"),
      issuedAt,
      expiresAt: issuedAt + (options.ttlMs ?? 5_000),
    };
  const final = options.mutate ? options.mutate(claims) : claims;
  return {
    claims: final,
    signature: createHmac("sha256", options.key ?? MAC_KEY)
      .update(canonicalClaims(final))
      .digest("hex"),
  };
}

export interface PolicyOverrides {
  cluster?: string;
  feePayers?: string[];
  programs?: unknown[];
  caps?: Record<string, string>;
  maxInstructions?: number;
  maxAccountKeys?: number;
  maxRequiredSignatures?: number;
  maxComputeUnitLimit?: number;
  maxComputeUnitPriceMicroLamports?: string;
  maxPriorityFeeLamports?: string;
  maxPriorityFeeBps?: number;
  addressLookupTables?: string[];
}

/** The default policy body: System transfer + SPL TransferChecked + fees. */
export function policyBody(
  feePayer: string,
  overrides: PolicyOverrides = {},
): Record<string, unknown> {
  return {
    version: 1,
    cluster: CLUSTER,
    feePayers: [feePayer],
    programs: [
      {
        programId: SYSTEM_PROGRAM,
        discriminator: "02000000",
        effect: "spend",
        spend: { asset: "native", amountOffset: 4, amountEncoding: "u64le" },
      },
      {
        programId: COMPUTE_BUDGET_PROGRAM,
        discriminator: "02",
        effect: "fee",
      },
      {
        programId: COMPUTE_BUDGET_PROGRAM,
        discriminator: "03",
        effect: "fee",
      },
    ],
    caps: { native: "1000000" },
    maxInstructions: 8,
    maxAccountKeys: 32,
    maxRequiredSignatures: 1,
    maxComputeUnitLimit: 400_000,
    maxComputeUnitPriceMicroLamports: "50000",
    maxPriorityFeeLamports: "15000",
    addressLookupTables: [],
    ...overrides,
  };
}

/** Write a mode-0600 policy file and return its path. */
export async function writePolicy(
  dir: string,
  feePayer: string,
  overrides: PolicyOverrides = {},
  name = "sign-policy.json",
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(policyBody(feePayer, overrides)), {
    mode: 0o600,
  });
  return path;
}
