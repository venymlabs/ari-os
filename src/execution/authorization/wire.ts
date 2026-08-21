import type { LoadedSignPolicy, SignerService } from "../../signer/index.js";
import type { AuthorizationEnvelope } from "../../signer/authorization.js";

/**
 * The signer daemon's local-socket protocol, as types both sides share.
 *
 * This module exists because of a specific incident shape. The daemon
 * (`src/bin/signer.ts`) reads its requests out of parsed JSON typed `any` and
 * writes its responses through `JSON.stringify`, so nothing structural crossed
 * the socket. When the daemon moved from secp256k1 to Ed25519 its request and
 * response shapes changed completely — `{serialized}` became
 * `{transaction, envelope}`, `{raw, hash}` became `{transaction, signature}` —
 * and the host-side client kept compiling green while being wrong at every
 * field. A wire protocol with no shared types does not fail in CI; it fails
 * with money in flight.
 *
 * Every type below is *derived* from the signer's own implementation rather
 * than re-declared. `SignerSignRequest["transaction"]` is literally the
 * parameter type of `SignerService.signEnvelope`, and `SignerResultResponse` is
 * literally its `result()` return type. If custody changes either signature,
 * this module stops compiling and every caller stops compiling with it.
 *
 * `src/bin/signer.ts` should narrow its `any` request handling against
 * {@link SignerRequest} so the daemon is checked against the same types; that
 * is a change inside the custody boundary and is tracked separately.
 */

type SignEnvelopeParameters = Parameters<SignerService["signEnvelope"]>;
type ResultParameters = Parameters<SignerService["result"]>;

/** Frame every request carries: the daemon authenticates before dispatch. */
export interface SignerRequestBase {
  token: string;
}

export interface SignerStatusRequest extends SignerRequestBase {
  method: "status";
}

export interface SignerSignRequest extends SignerRequestBase {
  method: "sign";
  /** base64 unsigned wire transaction */
  transaction: SignEnvelopeParameters[0];
  envelope: SignEnvelopeParameters[1];
  /**
   * Ask the daemon to broadcast after it has durably persisted the signature.
   * The signed bytes reach storage before they reach the network, so a crash
   * between the two can be recovered without producing a second signature.
   */
  broadcast?: boolean;
}

export interface SignerResultRequest extends SignerRequestBase {
  method: "result";
  authorizationId: ResultParameters[0];
  /** `0x` sha256 of the message bytes — NOT a transaction hash */
  messageHash: ResultParameters[1];
  recoverRaw?: ResultParameters[2];
}

export type SignerRequest =
  SignerStatusRequest | SignerSignRequest | SignerResultRequest;

export interface SignerStatusResponse {
  /** base58 fee-payer public key the daemon holds */
  account: string;
  cluster: LoadedSignPolicy["cluster"];
  policyHash: LoadedSignPolicy["hash"];
  policyVersion: LoadedSignPolicy["version"];
  authorizationKeyId: string;
  serviceVersion: string;
}

/**
 * Exactly what `SignerService.signEnvelope` produces, plus the base58 signature
 * the daemon reports when it also broadcast.
 */
export type SignerSignResponse = Awaited<
  ReturnType<SignerService["signEnvelope"]>
> & { broadcast?: string };

/**
 * Exactly what `SignerService.result` returns.
 *
 * `expired` is terminal: the blockhash died before a signature existed, so the
 * authorization is burned. `signed` always carries the signature — withholding
 * it would strand an execution whose transaction may already have landed —
 * while `transaction` is released to exactly one caller.
 */
export type SignerResultResponse = ReturnType<SignerService["result"]>;

export type SignerResponseFor<Q extends SignerRequest> = Q extends {
  method: "status";
}
  ? SignerStatusResponse
  : Q extends { method: "sign" }
    ? SignerSignResponse
    : SignerResultResponse;

/** The daemon's envelope around every response. */
export type SignerFrame<T> =
  { ok: true; result: T } | { ok: false; error: string };

/**
 * The host-side view of the isolated signer.
 *
 * Implemented over the local socket by `UnixSignerClient`, and in tests by
 * anything that honours the same contract. `result` is optional because an
 * operator may deploy a daemon build without durable recovery; the orchestrator
 * fails closed rather than re-signing when it is missing.
 */
export interface IsolatedSigner {
  sign(
    request: Omit<SignerSignRequest, "method" | "token">,
  ): Promise<SignerSignResponse>;
  result?(
    request: Omit<SignerResultRequest, "method" | "token">,
  ): Promise<SignerResultResponse>;
}

export type { AuthorizationEnvelope };
