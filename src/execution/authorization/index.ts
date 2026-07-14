import { randomUUID } from "node:crypto";
import { keccak256, parseTransaction } from "viem";
import {
  simulationEvidenceHash,
  type SimulationEvidence,
  type SimulationRequest,
} from "../simulation.js";
export interface AuthorizationReferences {
  quoteHash: string;
  policyHash: string;
  policyVersion: number;
  riskHash: string;
  reservationId: string;
  approvalId: string;
  audience: string;
  signerKeyId?: string;
}
export interface AuthorizationClaims extends AuthorizationReferences {
  protocol: string;
  version: number;
  id: string;
  chainId: number;
  account: `0x${string}`;
  nonce: number;
  serialized: `0x${string}`;
  transactionHash: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  gas: string;
  type: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  accessList: readonly unknown[];
  simulationHash: `0x${string}`;
  issuedAt: number;
  expiresAt: number;
}
export interface AuthorizationEnvelope {
  claims: AuthorizationClaims;
  signature: string;
}
export interface AuthorizationChecks {
  quote: (hash: string) => Promise<boolean>;
  policy: (hash: string) => Promise<boolean>;
  risk: (hash: string) => Promise<boolean>;
  reservation: (id: string) => Promise<boolean>;
  approval: (id: string) => Promise<boolean>;
  simulation: (hash: string) => Promise<boolean>;
  nonce: (chainId: number, account: string) => Promise<number | boolean>;
  consumeApprovalReservation?: (
    approval: string,
    reservation: string,
    authorizationId: string,
  ) => Promise<boolean>;
  snapshotVersion?: () => Promise<string>;
}
export interface EnvelopeSigner {
  sign: (canonicalClaims: string) => Promise<string>;
}
export interface EnvelopeVerifier {
  verify: (
    canonicalClaims: string,
    signature: string,
    keyId?: string,
  ) => Promise<boolean>;
}
const normalize = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
export const canonicalClaims = (c: AuthorizationClaims) =>
  JSON.stringify(normalize(c));
export class AuthorizationIssuer {
  get signerKeyId() {
    return this.dependencies.signerKeyId;
  }
  constructor(
    readonly dependencies: {
      checks: AuthorizationChecks;
      signer: EnvelopeSigner;
      signerKeyId?: string;
      now?: () => number;
      ttlMs?: number;
      maxTtlMs?: number;
    },
  ) {}
  async issue(
    r: SimulationRequest,
    e: SimulationEvidence,
    refs: AuthorizationReferences,
  ) {
    const ttl = this.dependencies.ttlMs ?? 30_000;
    if (
      !Number.isSafeInteger(ttl) ||
      ttl <= 0 ||
      ttl > (this.dependencies.maxTtlMs ?? 60_000)
    )
      throw Error("authorization_ttl_invalid");
    if (refs.policyHash !== r.policyHash)
      throw Error("authorization_policy_invalid");
    const { hash, ...body } = e;
    if (
      hash !== simulationEvidenceHash(body) ||
      e.transactionHash !== r.transactionHash
    )
      throw Error("authorization_simulation_invalid");
    const c = this.dependencies.checks,
      start = await c.snapshotVersion?.();
    const validations: [string, Promise<boolean>][] = [
      ["quote", c.quote(refs.quoteHash)],
      ["policy", c.policy(refs.policyHash)],
      ["risk", c.risk(refs.riskHash)],
      ["reservation", c.reservation(refs.reservationId)],
      ["approval", c.approval(refs.approvalId)],
      ["simulation", c.simulation(e.hash)],
      [
        "nonce",
        c
          .nonce(r.transaction.chainId, r.transaction.from)
          .then((n) => n === true || n === r.transaction.nonce),
      ],
    ];
    for (const [n, p] of validations)
      if (!(await p)) throw Error(`authorization_${n}_invalid`);
    if (start !== undefined && start !== (await c.snapshotVersion?.()))
      throw Error("authorization_snapshot_changed");
    const issuedAt = (this.dependencies.now ?? Date.now)(),
      t = r.transaction,
      id = randomUUID();
    if (
      c.consumeApprovalReservation &&
      !(await c.consumeApprovalReservation(
        refs.approvalId,
        refs.reservationId,
        id,
      ))
    )
      throw Error("authorization_consumption_invalid");
    const claims: AuthorizationClaims = {
      ...refs,
      ...(this.signerKeyId ? { signerKeyId: this.signerKeyId } : {}),
      protocol: "robinhood-execution-authorization",
      version: 1,
      id,
      chainId: t.chainId,
      account: t.from,
      nonce: t.nonce,
      serialized: r.serialized,
      transactionHash: r.transactionHash,
      to: t.to,
      data: t.data,
      value: String(t.value),
      gas: String(t.gas),
      type: t.type ?? "legacy",
      ...(t.gasPrice === undefined ? {} : { gasPrice: String(t.gasPrice) }),
      ...(t.maxFeePerGas === undefined
        ? {}
        : { maxFeePerGas: String(t.maxFeePerGas) }),
      ...(t.maxPriorityFeePerGas === undefined
        ? {}
        : { maxPriorityFeePerGas: String(t.maxPriorityFeePerGas) }),
      accessList: t.accessList ?? [],
      simulationHash: e.hash,
      issuedAt,
      expiresAt: issuedAt + ttl,
    };
    return {
      claims,
      signature: await this.dependencies.signer.sign(canonicalClaims(claims)),
    };
  }
}
export type ExecutionState =
  | "issued"
  | "claimed"
  | "signing"
  | "signed"
  | "broadcast"
  | "reconciliation"
  | "confirmed"
  | "reverted"
  | "dropped"
  | "failed";
export interface ReplayStore {
  consume(id: string, expiresAt: number): Promise<boolean>;
  transition?(
    id: string,
    from: ExecutionState,
    to: ExecutionState,
    data?: string,
  ): Promise<boolean>;
}
export class InMemoryReplayStore implements ReplayStore {
  readonly states = new Map<string, ExecutionState>();
  async consume(id: string) {
    if (this.states.has(id)) return false;
    this.states.set(id, "claimed");
    return true;
  }
  async transition(id: string, from: ExecutionState, to: ExecutionState) {
    if (this.states.get(id) !== from) return false;
    this.states.set(id, to);
    return true;
  }
}
export class SignerWireVerifier {
  constructor(
    private readonly dependencies: {
      verifier: EnvelopeVerifier;
      replayStore: ReplayStore;
      now?: () => number;
      audience: string;
      signerKeyId?: string;
      authorizationKeyIds?: readonly string[];
      policyHash?: string;
      policyVersion?: number;
      nonce?: (chainId: number, account: string) => Promise<number>;
    },
  ) {}
  async verify(serialized: `0x${string}`, envelope: AuthorizationEnvelope) {
    const c = envelope.claims,
      now = (this.dependencies.now ?? Date.now)();
    if (c.protocol !== "robinhood-execution-authorization" || c.version !== 1)
      throw Error("envelope_version_invalid");
    if (c.issuedAt > now) throw Error("envelope_issued_in_future");
    if (now >= c.expiresAt || c.expiresAt - c.issuedAt > 60_000)
      throw Error("envelope_expired");
    if (c.audience !== this.dependencies.audience)
      throw Error("envelope_audience_mismatch");
    if (
      this.dependencies.signerKeyId &&
      c.signerKeyId !== this.dependencies.signerKeyId
    )
      throw Error("envelope_signer_mismatch");
    if (
      (this.dependencies.policyHash &&
        c.policyHash.toLowerCase() !==
          this.dependencies.policyHash.toLowerCase()) ||
      (this.dependencies.policyVersion !== undefined &&
        c.policyVersion !== this.dependencies.policyVersion)
    )
      throw Error("envelope_policy_mismatch");
    if (
      (this.dependencies.authorizationKeyIds && !c.signerKeyId) ||
      (this.dependencies.authorizationKeyIds &&
        c.signerKeyId &&
        !this.dependencies.authorizationKeyIds.includes(c.signerKeyId))
    )
      throw Error("envelope_authorization_key_unknown");
    if (
      !(await this.dependencies.verifier.verify(
        canonicalClaims(c),
        envelope.signature,
        c.signerKeyId,
      ))
    )
      throw Error("envelope_signature_invalid");
    let d: any;
    try {
      d = parseTransaction(serialized);
    } catch {
      throw Error("envelope_transaction_invalid");
    }
    const eq = (a: unknown, b: unknown) =>
      JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
    if (
      serialized.toLowerCase() !== c.serialized.toLowerCase() ||
      keccak256(serialized).toLowerCase() !== c.transactionHash.toLowerCase() ||
      d.chainId !== c.chainId ||
      d.nonce !== c.nonce ||
      d.to?.toLowerCase() !== c.to.toLowerCase() ||
      (d.data ?? "0x").toLowerCase() !== c.data.toLowerCase() ||
      String(d.value ?? 0) !== c.value ||
      String(d.gas ?? 0) !== c.gas ||
      d.type !== c.type ||
      !eq(d.accessList ?? [], c.accessList) ||
      String(d.gasPrice ?? "") !== (c.gasPrice ?? "") ||
      String(d.maxFeePerGas ?? "") !== (c.maxFeePerGas ?? "") ||
      String(d.maxPriorityFeePerGas ?? "") !== (c.maxPriorityFeePerGas ?? "")
    )
      throw Error("envelope_transaction_mismatch");
    if (
      this.dependencies.nonce &&
      (await this.dependencies.nonce(c.chainId, c.account)) !== c.nonce
    )
      throw Error("envelope_nonce_changed");
    if (!(await this.dependencies.replayStore.consume(c.id, c.expiresAt)))
      throw Error("envelope_replayed");
    return {
      serialized,
      envelope,
      decoded: d,
      replayStore: this.dependencies.replayStore,
    };
  }
}
