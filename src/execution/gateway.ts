import {
  assertSimulationSafe,
  buildSimulationRequest,
  type PreparedTransaction,
  type SimulationRequest,
  type SimulationResult,
} from "./simulation.js";
import { signatureOf } from "../signer/transaction.js";
import type {
  AuthorizationEnvelope,
  HostAuthorizationVerifier,
} from "./authorization/index.js";
import type { SignerSignResponse } from "./authorization/wire.js";

interface Dependencies {
  simulate: (request: SimulationRequest) => Promise<SimulationResult>;
  wireVerifier?: HostAuthorizationVerifier;
  /** Cross the custody boundary. Returns the signed wire plus its signature. */
  sign?: (
    transaction: string,
    envelope: AuthorizationEnvelope,
  ) => Promise<SignerSignResponse>;
  broadcast?: (signed: string) => Promise<string>;
}
interface ExecutionContext {
  policyHash: string;
  currentSlot: bigint;
  maxSlotLag: bigint;
  allowedAssets: ReadonlySet<string>;
  /** current cluster block height, for the blockhash-expiry fence */
  currentBlockHeight?: number;
}
export interface AuthorizedExecution {
  /** base64 unsigned wire transaction */
  transaction: string;
  envelope: AuthorizationEnvelope;
}

/**
 * The execution chokepoint.
 *
 * Two rules survive the move from EVM to Solana unchanged, because neither was
 * ever about the chain:
 *
 *  - **Simulate before approve.** `prepare` is the only way to obtain the
 *    evidence an authorization can be issued against, and it refuses to return
 *    anything a safety check rejected.
 *  - **Persist signed bytes before broadcast.** The signature reaches durable
 *    storage before it reaches the network, so a crash in between is
 *    recoverable by *looking up* the signature rather than producing a second
 *    one.
 *
 * What changes is the identity being fenced. There is no account nonce to
 * compare, so the fence is the recent blockhash and its last valid block
 * height, and crossing it is terminal.
 */
export class ExecutionGateway {
  constructor(private readonly dependencies: Dependencies) {}

  async prepare(transaction: PreparedTransaction, context: ExecutionContext) {
    const request = buildSimulationRequest(transaction, context.policyHash),
      simulation = await this.dependencies.simulate(request);
    assertSimulationSafe(simulation, {
      expectedMessageHash: request.messageHash,
      currentSlot: context.currentSlot,
      maxSlotLag: context.maxSlotLag,
      allowedAssets: context.allowedAssets,
      ...(context.currentBlockHeight === undefined
        ? {}
        : {
            currentBlockHeight: context.currentBlockHeight,
            lastValidBlockHeight: request.lastValidBlockHeight,
          }),
    });
    return {
      status: "SIMULATED" as const,
      messageHash: request.messageHash,
      request,
      simulation,
    };
  }

  async execute(input: AuthorizedExecution) {
    if (!input?.envelope || !input.transaction)
      throw Error("authorization_envelope_required");
    const { wireVerifier, sign, broadcast } = this.dependencies;
    if (!wireVerifier || !sign || !broadcast) throw Error("signing_disabled");
    const verified = await wireVerifier.verify(
        input.transaction,
        input.envelope,
      ),
      id = input.envelope.claims.id;

    let signed: SignerSignResponse;
    try {
      signed = await sign(verified.transaction, input.envelope);
    } catch (error) {
      await verified.replayStore.transition?.(
        id,
        "claimed",
        "failed",
        String(error),
      );
      throw error;
    }
    // The signature the signer reports must be the one actually attached to the
    // bytes it returned. A mismatch means the two are not the same
    // transaction, and neither may be trusted.
    let attached: string;
    try {
      attached = signatureOf(signed.transaction);
    } catch {
      attached = "";
    }
    if (!attached || attached !== signed.signature) {
      await verified.replayStore.transition?.(
        id,
        "claimed",
        "failed",
        "signer_signature_mismatch",
      );
      throw Error("signer_signature_mismatch");
    }
    await verified.replayStore.transition?.(
      id,
      "claimed",
      "signed",
      JSON.stringify({
        signature: signed.signature,
        transaction: signed.transaction,
      }),
    );

    // The daemon can broadcast on the host's behalf, having already persisted
    // the signature on its own side. Its answer is still checked, never taken.
    if (signed.broadcast !== undefined) {
      if (signed.broadcast !== signed.signature) {
        await verified.replayStore.transition?.(
          id,
          "signed",
          "reconciliation",
          signed.broadcast,
        );
        throw Error("broadcast_signature_mismatch");
      }
      await verified.replayStore.transition?.(
        id,
        "signed",
        "broadcast",
        signed.signature,
      );
      return {
        status: "BROADCAST" as const,
        messageHash: input.envelope.claims.messageHash,
        signature: signed.signature,
      };
    }

    let signature: string;
    try {
      signature = await broadcast(signed.transaction);
    } catch (error) {
      await verified.replayStore.transition?.(
        id,
        "signed",
        "reconciliation",
        String(error),
      );
      throw error;
    }
    if (signature !== signed.signature) {
      await verified.replayStore.transition?.(
        id,
        "signed",
        "reconciliation",
        String(signature),
      );
      throw Error("broadcast_signature_mismatch");
    }
    await verified.replayStore.transition?.(
      id,
      "signed",
      "broadcast",
      signature,
    );
    return {
      status: "BROADCAST" as const,
      messageHash: input.envelope.claims.messageHash,
      signature,
    };
  }
}
