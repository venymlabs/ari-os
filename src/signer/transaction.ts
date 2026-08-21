import { createHash } from "node:crypto";
import bs58 from "bs58";
import { VersionedTransaction, type VersionedMessage } from "@solana/web3.js";

/**
 * Independent Solana transaction decoding.
 *
 * The signer never trusts the host's description of what it is being asked to
 * sign. Everything the policy and the envelope check is read out of the wire
 * bytes here, by this process, before any signature exists.
 */

export interface DecodedInstruction {
  /** base58 program id — always a *static* account key (see `decodeTransaction`). */
  programId: string;
  programIdIndex: number;
  accountIndexes: readonly number[];
  /**
   * base58 account keys for this instruction. `null` marks an index that
   * resolves through an address lookup table and therefore cannot be
   * verified without trusting an external RPC.
   */
  accounts: readonly (string | null)[];
  data: Uint8Array;
  /** lowercase hex of `data`, for policy prefix matching and envelope binding. */
  dataHex: string;
}

export interface DecodedAddressTableLookup {
  accountKey: string;
  writableIndexes: readonly number[];
  readonlyIndexes: readonly number[];
}

export interface DecodedTransaction {
  version: "legacy" | number;
  /** base58 fee payer — static account key 0, the first required signer. */
  feePayer: string;
  recentBlockhash: string;
  numRequiredSignatures: number;
  staticAccountKeys: readonly string[];
  /** base58 signatures already present on the wire; `null` for empty slots. */
  signatures: readonly (string | null)[];
  addressTableLookups: readonly DecodedAddressTableLookup[];
  instructions: readonly DecodedInstruction[];
  /** the exact bytes an Ed25519 signature commits to */
  messageBytes: Uint8Array;
  messageBase64: string;
  /** `0x`-prefixed sha256 of `messageBytes` — the request identity handle. */
  messageHash: string;
  /** canonical re-serialization of the whole transaction */
  wireBase64: string;
  transaction: VersionedTransaction;
}

const EMPTY_SIGNATURE = (sig: Uint8Array) => sig.every((b) => b === 0);

export const sha256Hex = (bytes: Uint8Array): string =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

function messageBytesOf(message: VersionedMessage): Uint8Array {
  return Uint8Array.from(message.serialize());
}

/**
 * Decode a base64 Solana transaction.
 *
 * Rejects, before anything else happens:
 *  - anything that is not a well-formed `VersionedTransaction`
 *  - non-canonical encodings (the re-serialization must be byte-identical, so
 *    two different wire encodings can never map to one authorized message)
 *  - an instruction whose program id is not a *static* account key. A program
 *    id behind an address lookup table would be unverifiable here, so the
 *    signer refuses to sign it regardless of what the runtime would accept.
 *  - a message with no instructions, or with no account keys.
 */
export function decodeTransaction(wireBase64: string): DecodedTransaction {
  if (typeof wireBase64 !== "string" || !wireBase64)
    throw Error("transaction_invalid");
  let raw: Buffer;
  try {
    raw = Buffer.from(wireBase64, "base64");
  } catch {
    throw Error("transaction_invalid");
  }
  // Exact canonical base64. Node's decoder silently ignores whitespace and
  // trailing garbage, so two different wire strings could otherwise name the
  // same message; requiring the round trip removes that ambiguity entirely.
  if (!raw.length || raw.toString("base64") !== wireBase64)
    throw Error("transaction_encoding_invalid");
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Uint8Array.from(raw));
  } catch {
    throw Error("transaction_invalid");
  }
  let canonical: Uint8Array;
  try {
    canonical = tx.serialize();
  } catch {
    throw Error("transaction_invalid");
  }
  if (!Buffer.from(canonical).equals(raw))
    throw Error("transaction_encoding_invalid");

  const message = tx.message,
    staticKeys = message.staticAccountKeys.map((k) => k.toBase58()),
    header = message.header;
  if (!staticKeys.length) throw Error("transaction_accounts_invalid");
  if (
    !Number.isSafeInteger(header.numRequiredSignatures) ||
    header.numRequiredSignatures < 1 ||
    header.numRequiredSignatures > staticKeys.length
  )
    throw Error("transaction_signers_invalid");
  if (tx.signatures.length !== header.numRequiredSignatures)
    throw Error("transaction_signers_invalid");
  const compiled = message.compiledInstructions;
  if (!compiled.length) throw Error("transaction_instructions_empty");

  const lookups = message.addressTableLookups.map((l) => ({
    accountKey: l.accountKey.toBase58(),
    writableIndexes: [...l.writableIndexes],
    readonlyIndexes: [...l.readonlyIndexes],
  }));
  const lookedUp = lookups.reduce(
    (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
    0,
  );
  const totalKeys = staticKeys.length + lookedUp;

  const instructions: DecodedInstruction[] = compiled.map((ix) => {
    if (
      !Number.isSafeInteger(ix.programIdIndex) ||
      ix.programIdIndex < 0 ||
      ix.programIdIndex >= staticKeys.length
    )
      // A program id resolved through a lookup table cannot be checked here.
      throw Error("transaction_program_unresolvable");
    const data = Uint8Array.from(ix.data);
    return {
      programId: staticKeys[ix.programIdIndex]!,
      programIdIndex: ix.programIdIndex,
      accountIndexes: [...ix.accountKeyIndexes],
      accounts: ix.accountKeyIndexes.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= totalKeys)
          throw Error("transaction_accounts_invalid");
        return i < staticKeys.length ? staticKeys[i]! : null;
      }),
      data,
      dataHex: Buffer.from(data).toString("hex"),
    };
  });

  const messageBytes = messageBytesOf(message);
  return {
    version: message.version,
    feePayer: staticKeys[0]!,
    recentBlockhash: message.recentBlockhash,
    numRequiredSignatures: header.numRequiredSignatures,
    staticAccountKeys: staticKeys,
    signatures: tx.signatures.map((s) =>
      EMPTY_SIGNATURE(s) ? null : bs58.encode(s),
    ),
    addressTableLookups: lookups,
    instructions,
    messageBytes,
    messageBase64: Buffer.from(messageBytes).toString("base64"),
    messageHash: sha256Hex(messageBytes),
    wireBase64: Buffer.from(canonical).toString("base64"),
    transaction: tx,
  };
}

/**
 * Attach `signature` to `decoded` in the fee payer's slot and return the
 * base64 wire transaction plus its base58 signature.
 *
 * The signature is written only into the slot the signer owns; any co-signer
 * slot already present on the wire is preserved untouched.
 */
export function attachSignature(
  decoded: DecodedTransaction,
  signature: Uint8Array,
): { transaction: string; signature: string } {
  if (signature.length !== 64) throw Error("signature_invalid");
  const tx = new VersionedTransaction(
    decoded.transaction.message,
    decoded.transaction.signatures.map((s) => Uint8Array.from(s)),
  );
  tx.signatures[0] = Uint8Array.from(signature);
  const wire = tx.serialize();
  return {
    transaction: Buffer.from(wire).toString("base64"),
    signature: bs58.encode(signature),
  };
}

/** Read the base58 fee-payer signature off a signed wire transaction. */
export function signatureOf(wireBase64: string): string {
  const first = decodeTransaction(wireBase64).signatures[0];
  if (!first) throw Error("signature_missing");
  return first;
}

/** True when `value` is a well-formed base58 32-byte public key. */
export function isPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
