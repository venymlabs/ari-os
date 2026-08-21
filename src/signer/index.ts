import {
  SignerWireVerifier,
  type AuthorizationEnvelope,
  type EnvelopeVerifier,
  type ReplayStore,
} from "./authorization.js";
import type { SignerAccount } from "./keystore.js";
import { evaluatePolicy, type SignPolicy } from "./policy.js";
import { SqliteReplayStore } from "./replay.js";
import {
  attachSignature,
  decodeTransaction,
  signatureOf,
  type DecodedTransaction,
} from "./transaction.js";

export * from "./authorization.js";
export * from "./keystore.js";
export * from "./policy.js";
export * from "./replay.js";
export * from "./transaction.js";

/** A signature the signer has already produced and durably recorded. */
interface StoredSignature {
  requestHash: string;
  transaction: string;
  signature: string;
  lastValidBlockHeight?: number;
}
export interface SignResult {
  /** base64 signed wire transaction */
  transaction: string;
  /** base58 fee-payer signature */
  signature: string;
}

/**
 * The custody boundary.
 *
 * Everything this class checks, it checks against bytes it decoded itself.
 * The host supplies a transaction and an authorization envelope; the signer
 * decodes the transaction, proves the envelope describes exactly that
 * transaction, re-applies its own policy, fences the one-time authorization
 * id, fences the recent blockhash, and only then produces a signature.
 */
export class SignerService {
  constructor(
    private account: SignerAccount,
    private replay: ReplayStore,
    private policy: SignPolicy,
    private wire?: {
      verifier: EnvelopeVerifier;
      audience: string;
      cluster?: string;
      signerKeyId?: string;
      authorizationKeyIds?: readonly string[];
      policyHash?: string;
      policyVersion?: number;
      now?: () => number;
      /** current cluster block height, used to fence blockhash expiry */
      blockHeight?: () => Promise<number>;
    },
  ) {}

  private stored(id: string, requestHash: string): StoredSignature | undefined {
    if (typeof requestHash !== "string" || !requestHash)
      throw Error("request_hash_invalid");
    const row = this.replay.get?.(id);
    if (!row) return undefined;
    // Terminal: the blockhash was already dead when signing was attempted.
    if (row.state === "expired") throw Error("authorization_expired");
    let data: unknown;
    try {
      data = JSON.parse(row.data ?? "");
    } catch {
      return undefined;
    }
    if (!data || typeof data !== "object") return undefined;
    const stored = data as Partial<StoredSignature>;
    if (stored.requestHash?.toLowerCase() !== requestHash.toLowerCase())
      throw Error("authorization_request_mismatch");
    if (row.state !== "signed" || !stored.transaction)
      throw Error("authorization_in_progress");
    return stored as StoredSignature;
  }

  /**
   * Blockhash expiry is the Solana replay fence and it is TERMINAL.
   *
   * If the transaction's blockhash can no longer land, the authorization is
   * burned rather than re-signed. Producing a signature over a fresh
   * blockhash for an already-authorized intent is how double-spends happen,
   * so the only recovery is a brand-new authorization from the control plane.
   */
  private async fenceBlockhash(id: string, lastValidBlockHeight?: number) {
    if (lastValidBlockHeight === undefined || !this.wire?.blockHeight) return;
    const height = await this.wire.blockHeight();
    if (!Number.isSafeInteger(height) || height < 0)
      throw Error("block_height_invalid");
    if (height <= lastValidBlockHeight) return;
    await this.replay.transition?.(
      id,
      "claimed",
      "expired",
      JSON.stringify({ lastValidBlockHeight, blockHeight: height }),
    );
    throw Error("blockhash_expired");
  }

  /**
   * Low-level path: sign a transaction against policy alone, with no
   * authorization envelope. Used by operator tooling and tests; the daemon
   * itself always goes through `signEnvelope`.
   */
  async sign(
    authorizationId: string,
    transaction: string,
    claimedFeePayer: string,
    lastValidBlockHeight?: number,
  ): Promise<SignResult> {
    const decoded = decodeTransaction(transaction);
    evaluatePolicy(decoded, this.policy, this.account.publicKey);
    if (decoded.feePayer !== claimedFeePayer) throw Error("policy_fee_payer");
    const prior = this.stored(authorizationId, decoded.messageHash);
    if (prior)
      return { transaction: prior.transaction, signature: prior.signature };
    if (!(await this.replay.consume(authorizationId, Date.now() + 60_000)))
      throw Error("envelope_replayed");
    await this.fenceBlockhash(authorizationId, lastValidBlockHeight);
    return this.signClaimed(authorizationId, decoded, lastValidBlockHeight);
  }

  private async signClaimed(
    id: string,
    decoded: DecodedTransaction,
    lastValidBlockHeight?: number,
  ): Promise<SignResult> {
    try {
      const raw = this.account.signMessage(decoded.messageBytes),
        result = attachSignature(decoded, raw),
        data = JSON.stringify({
          requestHash: decoded.messageHash,
          ...result,
          ...(lastValidBlockHeight === undefined
            ? {}
            : { lastValidBlockHeight }),
        });
      if (
        this.replay.transition &&
        !(await this.replay.transition(id, "claimed", "signed", data))
      )
        throw Error("replay_fencing_lost");
      return result;
    } catch (e) {
      await this.replay.transition?.(id, "claimed", "failed");
      throw e;
    }
  }

  /**
   * Durable result lookup. A signature that already exists always stays
   * retrievable — withholding it would strand an execution whose transaction
   * may already have landed. `recoverRaw` releases the signed bytes to
   * exactly one caller.
   */
  result(id: string, requestHash: string, recoverRaw = false) {
    if (this.replay.get?.(id)?.state === "expired")
      return { state: "expired" as const };
    const data = this.stored(id, requestHash);
    if (!data) return { state: "not_found" as const };
    const result: {
      state: "signed";
      signature: string;
      transaction?: string;
    } = { state: "signed", signature: data.signature };
    if (recoverRaw) {
      const claimed = (
        this.replay as {
          recoverSigned?: (id: string) => { data: string } | undefined;
        }
      ).recoverSigned?.(id);
      if (claimed) {
        let recovered: Partial<StoredSignature>;
        try {
          recovered = JSON.parse(claimed.data);
        } catch {
          throw Error("signed_result_invalid");
        }
        if (!recovered.transaction) throw Error("signed_result_invalid");
        result.transaction = recovered.transaction;
      }
    }
    return result;
  }

  /**
   * The daemon path. Order is deliberate: decode, prove the envelope matches
   * the decode, re-check policy — and only then burn the one-time
   * authorization. A request rejected by policy never consumes its
   * authorization id.
   */
  async signEnvelope(
    transaction: string,
    envelope: AuthorizationEnvelope,
  ): Promise<SignResult> {
    if (!this.wire) throw Error("wire_verifier_required");
    const decoded = decodeTransaction(transaction);
    const id = envelope?.claims?.id;
    if (typeof id !== "string" || !id) throw Error("envelope_invalid");
    const prior = this.stored(id, decoded.messageHash);
    await new SignerWireVerifier(this.wire).verify(decoded, envelope);
    evaluatePolicy(decoded, this.policy, this.account.publicKey);
    if (prior)
      return { transaction: prior.transaction, signature: prior.signature };
    if (!(await this.replay.consume(id, envelope.claims.expiresAt)))
      throw Error("envelope_replayed");
    await this.fenceBlockhash(id, envelope.claims.lastValidBlockHeight);
    return this.signClaimed(id, decoded, envelope.claims.lastValidBlockHeight);
  }
}

/** Newline-delimited JSON framing for the local socket protocol. */
export class JsonFrameDecoder {
  private pending = Buffer.alloc(0);
  constructor(private max = 1024 * 1024) {}
  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > this.max && !this.pending.includes(10))
      throw Error("frame_too_large");
    const out: unknown[] = [];
    for (;;) {
      const i = this.pending.indexOf(10);
      if (i < 0) break;
      if (i > this.max) throw Error("frame_too_large");
      const line = this.pending.subarray(0, i);
      this.pending = this.pending.subarray(i + 1);
      if (!line.length) continue;
      try {
        out.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw Error("frame_json_invalid");
      }
    }
    return out;
  }
}

export type RpcCall = (method: string, params: unknown[]) => Promise<any>;

/**
 * Broadcast an already-signed, already-persisted transaction.
 *
 * The signed bytes reach durable storage before they reach the network, and
 * the returned signature must equal the one this process computed — an RPC
 * that answers with a different signature is treated as an unresolved
 * broadcast, never as a success.
 */
export async function broadcastSigned(
  store: SqliteReplayStore,
  id: string,
  transaction: string,
  rpc: RpcCall,
) {
  const expected = signatureOf(transaction);
  let lastValidBlockHeight: number | undefined;
  try {
    const prior = JSON.parse(
      store.get(id)?.data ?? "{}",
    ) as Partial<StoredSignature>;
    lastValidBlockHeight = prior.lastValidBlockHeight;
  } catch {
    lastValidBlockHeight = undefined;
  }
  const returned = await rpc("sendTransaction", [
    transaction,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    },
  ]);
  if (typeof returned !== "string" || returned !== expected) {
    await store.transition(
      id,
      "signed",
      "reconciliation",
      JSON.stringify({ expected, returned, lastValidBlockHeight }),
    );
    throw Error("broadcast_signature_mismatch");
  }
  if (
    !(await store.transition(
      id,
      "signed",
      "broadcast",
      JSON.stringify({
        signature: returned,
        transaction,
        lastValidBlockHeight,
      }),
    ))
  )
    throw Error("broadcast_state_invalid");
  return returned;
}

/**
 * Settle durable broadcast records without ever signing or resubmitting.
 *
 * A status with an error is `reverted`; a confirmed/finalized status is
 * `confirmed`. A signature the cluster has never seen once its blockhash is
 * past `lastValidBlockHeight` is `dropped` — terminal, because that
 * transaction can no longer land and must not be re-signed.
 */
export async function reconcileTransactions(
  store: SqliteReplayStore,
  rpc: RpcCall,
) {
  for (const row of store.list(["broadcast", "reconciliation"])) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(row.data ?? "{}");
    } catch {
      continue;
    }
    const signature = data.signature ?? data.expected;
    if (typeof signature !== "string" || !signature) continue;
    const response = await rpc("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = response?.value?.[0] ?? null;
    if (status) {
      const settled = status.err
        ? "reverted"
        : status.confirmationStatus === "finalized" ||
            status.confirmationStatus === "confirmed"
          ? "confirmed"
          : row.state === "reconciliation"
            ? "broadcast"
            : undefined;
      if (settled)
        await store.transition(
          row.id,
          row.state,
          settled,
          JSON.stringify({
            signature,
            status,
            ...(data.transaction ? { transaction: data.transaction } : {}),
            ...(data.lastValidBlockHeight === undefined
              ? {}
              : { lastValidBlockHeight: data.lastValidBlockHeight }),
          }),
        );
      continue;
    }
    if (!Number.isSafeInteger(data.lastValidBlockHeight)) continue;
    const height = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
    if (Number.isSafeInteger(height) && height > data.lastValidBlockHeight)
      await store.transition(
        row.id,
        row.state,
        "dropped",
        JSON.stringify({
          signature,
          lastValidBlockHeight: data.lastValidBlockHeight,
          blockHeight: height,
        }),
      );
  }
}
