import { createHash } from "node:crypto";
import {
  decodeTransaction,
  isPublicKey,
  type DecodedTransaction,
} from "../signer/transaction.js";

/**
 * Solana simulation vocabulary.
 *
 * The EVM version of this module pinned an exact block (`eth_call` at a block
 * hash) and derived asset movement from a call trace. Solana has neither: a
 * simulation runs against whatever state the node currently holds, and the only
 * account movement it can report is the post-execution state of accounts you
 * asked for by name. So the mapping is:
 *
 *   block hash pin      -> none. Slot drift is bounded and *recorded*, never
 *                          claimed as a pin.
 *   nonce               -> recent blockhash + `lastValidBlockHeight`
 *   gasUsed             -> compute units consumed
 *   gas price ceiling   -> `getFeeForMessage` lamports
 *   trace asset deltas  -> pre/post account balances (native lamports and SPL
 *                          token amounts) around the simulation
 *   revert reason       -> `simulateTransaction`'s `err`
 *
 * Because several of those are things a node may simply decline to provide,
 * every result carries an explicit {@link SimulationCapabilities} record and
 * {@link assertSimulationSafe} refuses to pass a result whose evidence was not
 * actually collected. An empty `assetDeltas` array means "nothing moved"; it
 * must never be reachable by a node that could not tell us.
 */

export const SIMULATION_EVIDENCE_DOMAIN = "ari-solana-simulation-evidence/v1";

/** The literal asset key used for lamport-denominated movement. */
export const NATIVE_ASSET = "native";

/** What the caller hands the gateway: an already-built unsigned transaction. */
export interface PreparedTransaction {
  cluster: string;
  /** base64 unsigned wire transaction */
  transaction: string;
  /**
   * The block height past which `recentBlockhash` can no longer land. Solana
   * has no account nonce; this is the replay fence, and crossing it is
   * terminal — the intent is re-quoted from scratch, never re-signed.
   */
  lastValidBlockHeight: number;
}

export interface InstructionSummary {
  programId: string;
  /** base58 account keys; `null` where an address lookup table is involved */
  accounts: readonly (string | null)[];
  /** lowercase hex instruction data */
  data: string;
}

/**
 * A fully decoded, JSON-round-trippable description of one exact transaction.
 *
 * Every field is read out of the wire bytes by {@link decodeTransaction} — the
 * same decoder the isolated signer runs on its own side of the process
 * boundary — so an authorization built from this request describes exactly what
 * the signer will independently decode.
 */
export interface SimulationRequest {
  cluster: string;
  /** base64 canonical wire transaction */
  transaction: string;
  /** base64 message bytes — exactly what an Ed25519 signature commits to */
  message: string;
  /** `0x` sha256 of the message bytes — the request identity handle */
  messageHash: string;
  feePayer: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  /** sorted unique program ids the transaction invokes */
  programIds: readonly string[];
  /** static account keys, in message order */
  accountKeys: readonly string[];
  instructions: readonly InstructionSummary[];
  /** address lookup table accounts referenced by the message */
  addressTableLookups: readonly string[];
  policyHash: string;
}

/** Signed base-unit movement of one asset for one owner. */
export interface AssetDelta {
  /** `native`, or the base58 mint */
  asset: string;
  /** base58 owner (for `native`, the account whose lamports moved) */
  owner: string;
  /** post - pre, in base units */
  amount: bigint;
}

/** Post-execution state of an account the simulation was asked to return. */
export interface AccountState {
  address: string;
  lamports: bigint;
  owner: string;
  /** base64 account data, or `null` when the account does not exist */
  data: string | null;
}

/**
 * What the node was actually able to tell us.
 *
 * These flags are part of the hashed evidence body, so a downgraded endpoint
 * can never produce evidence that hashes the same as a fully-observed run.
 */
export interface SimulationCapabilities {
  /** pre and post account state were both read, so `assetDeltas` is real */
  balances: boolean;
  /** program logs were returned */
  logs: boolean;
  /** `getFeeForMessage` answered, so `feeLamports` is real */
  fee: boolean;
  /** no address lookup table referenced by the message was left unresolved */
  addressTableLookups: boolean;
}

export interface SimulationResult {
  success: boolean;
  /** context slot the simulation observed */
  slot: bigint;
  /** the recent blockhash the transaction was simulated with */
  blockhash: string;
  messageHash: string;
  unitsConsumed: bigint;
  feeLamports: bigint;
  logs: readonly string[];
  accountStates: readonly AccountState[];
  assetDeltas: readonly AssetDelta[];
  capabilities: SimulationCapabilities;
  /** decoded `simulateTransaction` error, when `success` is false */
  err?: string;
}

export interface SimulationEvidence {
  hash: string;
  messageHash: string;
  slot: bigint;
  blockhash: string;
  unitsConsumed: bigint;
  feeLamports: bigint;
  logs: readonly string[];
  accountStates: readonly AccountState[];
  assetDeltas: readonly AssetDelta[];
  capabilities: SimulationCapabilities;
}

export interface SafetyContext {
  expectedMessageHash: string;
  /** how many slots the simulation may lag the current tip */
  maxSlotLag: bigint;
  currentSlot: bigint;
  /** asset keys (`native` or base58 mints) the trade is allowed to move */
  allowedAssets: ReadonlySet<string>;
  /**
   * Current cluster block height. Supplied together with
   * `lastValidBlockHeight`, this is the blockhash-expiry fence: past it the
   * transaction can never land and the intent is dead, not retryable.
   */
  currentBlockHeight?: number;
  lastValidBlockHeight?: number;
}

const sha256 = (value: string) =>
  `0x${createHash("sha256").update(value).digest("hex")}`;

/**
 * Decode an exact unsigned transaction into a simulation request.
 *
 * The decode is deliberately the signer's own decoder: it rejects non-canonical
 * encodings and program ids hidden behind lookup tables, so nothing that the
 * signer would later refuse can be quoted, simulated and approved first.
 */
export function buildSimulationRequest(
  t: PreparedTransaction,
  policyHash: string,
): SimulationRequest {
  if (
    !Number.isSafeInteger(t.lastValidBlockHeight) ||
    t.lastValidBlockHeight < 0
  )
    throw Error("prepared_last_valid_block_height_invalid");
  if (typeof t.cluster !== "string" || !t.cluster)
    throw Error("prepared_cluster_invalid");
  return simulationRequestOf(
    decodeTransaction(t.transaction),
    t.cluster,
    t.lastValidBlockHeight,
    policyHash,
  );
}

/** The same projection, when the caller already holds a decode. */
export function simulationRequestOf(
  d: DecodedTransaction,
  cluster: string,
  lastValidBlockHeight: number,
  policyHash: string,
): SimulationRequest {
  return {
    cluster,
    transaction: d.wireBase64,
    message: d.messageBase64,
    messageHash: d.messageHash,
    feePayer: d.feePayer,
    recentBlockhash: d.recentBlockhash,
    lastValidBlockHeight,
    programIds: [...new Set(d.instructions.map((i) => i.programId))].sort(),
    accountKeys: [...d.staticAccountKeys],
    instructions: d.instructions.map((i) => ({
      programId: i.programId,
      accounts: [...i.accounts],
      data: i.dataHex,
    })),
    addressTableLookups: d.addressTableLookups.map((l) => l.accountKey),
    policyHash,
  };
}

const canonical = (value: unknown): unknown =>
  typeof value === "bigint"
    ? value.toString()
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;

const evidenceBody = (result: SimulationResult) => ({
  domain: SIMULATION_EVIDENCE_DOMAIN,
  messageHash: result.messageHash,
  slot: result.slot,
  blockhash: result.blockhash,
  unitsConsumed: result.unitsConsumed,
  feeLamports: result.feeLamports,
  logs: [...result.logs],
  accountStates: [...result.accountStates],
  assetDeltas: [...result.assetDeltas],
  capabilities: result.capabilities,
});

export function createSimulationEvidence(
  request: SimulationRequest,
  result: SimulationResult,
): SimulationEvidence {
  if (result.messageHash.toLowerCase() !== request.messageHash.toLowerCase())
    throw Error("simulation_transaction_mismatch");
  const body = evidenceBody(result);
  return { ...body, hash: sha256(JSON.stringify(canonical(body))) };
}

export function simulationEvidenceHash(
  e: Omit<SimulationEvidence, "hash">,
): string {
  return sha256(
    JSON.stringify(canonical({ domain: SIMULATION_EVIDENCE_DOMAIN, ...e })),
  );
}

/**
 * Refuse anything that is not positive, current, complete evidence of a safe
 * transaction.
 *
 * The capability checks come first and are not negotiable: a node that could
 * not read balances produces `balances: false`, and an empty `assetDeltas`
 * array from such a node is silence, not proof that nothing moved. Treating the
 * two as the same is exactly the failure this function exists to prevent.
 */
export function assertSimulationSafe(
  result: SimulationResult,
  context: SafetyContext,
): void {
  if (!result.success)
    throw Error(`simulation_failed${result.err ? `:${result.err}` : ""}`);
  const c = result.capabilities;
  if (!c || typeof c !== "object")
    throw Error("simulation_capabilities_absent");
  if (!c.balances) throw Error("simulation_balances_unavailable");
  if (!c.fee) throw Error("simulation_fee_unavailable");
  if (!c.logs) throw Error("simulation_logs_unavailable");
  if (!c.addressTableLookups)
    throw Error("simulation_address_table_lookup_unresolved");
  if (!isPublicKey(result.blockhash))
    throw Error("simulation_blockhash_invalid");
  if (
    result.messageHash.toLowerCase() !==
    context.expectedMessageHash.toLowerCase()
  )
    throw Error("simulation_transaction_mismatch");
  if (
    result.slot > context.currentSlot ||
    context.currentSlot - result.slot > context.maxSlotLag
  )
    throw Error("simulation_stale_slot");
  // Blockhash expiry is terminal. Checking it here means an expired intent is
  // refused before an authorization is ever issued for it.
  if (
    context.currentBlockHeight !== undefined &&
    context.lastValidBlockHeight !== undefined &&
    context.currentBlockHeight > context.lastValidBlockHeight
  )
    throw Error("simulation_blockhash_expired");
  const seen = new Set<string>();
  for (const d of result.assetDeltas) {
    const k = `${d.asset}:${d.owner}`;
    if (seen.has(k)) throw Error("simulation_duplicate_asset_delta");
    seen.add(k);
    if (!context.allowedAssets.has(d.asset))
      throw Error(`unexpected_asset_delta:${d.asset}`);
  }
}
