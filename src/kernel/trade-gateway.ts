/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BalanceReader,
  Broadcaster,
  Clock,
  Confirmer,
  ExecuteOptions,
  ExecuteResult,
  LandMode,
  MintInspector,
  PerpPositionRef,
  PolicyConfig,
  PositionReader,
  Simulator,
  TradeGateway,
  TradeIntent,
  WalletProvider,
} from "./contracts.js";
import { settleModeFor } from "./contracts.js";
import { GuardError, isGuardError } from "./errors.js";
import { newTradeId } from "./ids.js";
import { quoteBucketFor, slippageBps } from "./money.js";
import { staticGuards } from "./policy-engine.js";
import type { KernelStore } from "./store.js";

/** ~0.003 SOL headroom for base + priority fee + ATA rent on a SOL-input trade. */
const FEE_BUFFER_LAMPORTS = 3_000_000n;

/** JSON replacer so the audit copy of an intent (with bigint amounts) serializes losslessly as strings. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export interface TradeGatewayDeps {
  readonly store: KernelStore;
  readonly wallet: WalletProvider;
  /** A getter so the gateway always reads the CURRENT policy (e.g. after arming). */
  readonly policy: () => PolicyConfig;
  readonly mints: MintInspector;
  readonly balances: BalanceReader;
  readonly simulator: Simulator;
  readonly broadcasters: Readonly<Record<LandMode, Broadcaster>>;
  readonly confirmer: Confirmer;
  readonly clock: Clock;
  /**
   * Required only to execute perp kinds — a perp fill is verified against the
   * venue position, not a token balance. Leaving it unmounted does not make
   * perps unchecked, it makes them impossible: the gateway refuses a perp
   * intent it cannot verify, before broadcast.
   */
  readonly positions?: PositionReader;
}

/**
 * The single deterministic money path. Re-validates every intent from scratch,
 * reserves the input-leg cap atomically, persists the signed tx before
 * broadcast, and releases the reservation on every non-confirmed terminal state.
 * Non-throwing: failures come back as ExecuteResult.error.
 *
 * The wallet seam is a {@link WalletProvider}; ARI OS satisfies it either with
 * the in-process keystore-backed wallet or with the isolated signer daemon, so
 * key custody stays outside this module either way.
 */
export class TradeGatewayImpl implements TradeGateway {
  #d: TradeGatewayDeps;

  constructor(deps: TradeGatewayDeps) {
    this.#d = deps;
  }

  async execute(
    intent: TradeIntent,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return opts.dryRun ? this.#preview(intent, opts) : this.#live(intent, opts);
  }

  /** Read-only validation for a quote card / armed-check. Touches no idempotency or trade rows. */
  async #preview(
    intent: TradeIntent,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const tradeId = newTradeId();
    try {
      const policy = this.#d.policy();
      staticGuards(policy, intent, {
        dryRun: true,
        confirmedByUser: opts.confirmedByUser === true,
      });
      this.#assertSettleable(intent);
      await this.#assertMintsSupported(policy, intent);

      const bucket = quoteBucketFor(intent.input.mint);
      if (bucket) {
        const caps = bucket === "sol" ? policy.capsSol : policy.capsUsdc;
        const used = this.#d.store.usage(bucket, this.#d.clock.now());
        this.#assertWithinCaps(bucket, intent.input.amount, caps, used);
      }

      const sim = await this.#d.simulator.simulate(intent.unsignedTxBase64);
      if (!sim.ok) {
        throw new GuardError(
          "SIMULATION_FAILED",
          "preflight simulation failed",
          { err: String(sim.err ?? "unknown") },
        );
      }
      return result(tradeId, "reserved", {
        simulated: true,
        summary: intent.summary,
      });
    } catch (err) {
      return this.#errorResult(tradeId, err, true);
    }
  }

  async #live(
    intent: TradeIntent,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const { store, clock } = this.#d;
    const now = clock.now();
    const tradeId = newTradeId();

    // 1. Idempotency — claim before anything that could move money.
    if (!store.claimIdempotency(opts.idempotencyKey, tradeId, now)) {
      const prior = store.getTradeByIdempotency(opts.idempotencyKey);
      return result(prior?.id ?? tradeId, prior?.state ?? "rejected", {
        signature: prior?.signature ?? undefined,
        summary: "duplicate request — this idempotency key was already used",
        error: {
          code: "DUPLICATE_INTENT",
          message: "idempotency key already used",
        },
      });
    }

    let reservationId: string | null = null;
    let inserted = false;
    try {
      const policy = this.#d.policy();
      staticGuards(policy, intent, {
        dryRun: false,
        confirmedByUser: opts.confirmedByUser === true,
      });
      this.#assertSettleable(intent);
      await this.#assertMintsSupported(policy, intent);

      // 2. Reserve the input-leg cap (only when the input is a quote asset;
      //    a sell receives quote rather than spending it, so no cap applies).
      const bucket = quoteBucketFor(intent.input.mint);
      if (bucket) {
        const caps = bucket === "sol" ? policy.capsSol : policy.capsUsdc;
        const outcome = store.reserve({
          bucket,
          amount: intent.input.amount,
          caps,
          tradeId,
          now,
        });
        if (!outcome.ok) {
          throw new GuardError(
            "CAP_EXCEEDED",
            `${bucket.toUpperCase()} ${outcome.reason} cap exceeded`,
            {
              reason: outcome.reason,
              cap: outcome.cap.toString(),
              would: outcome.would.toString(),
            },
          );
        }
        reservationId = outcome.reservationId;
      }

      // 3. Balance check (input leg + fee headroom for SOL). For a perp kind we
      //    also snapshot the venue position HERE, before anything is signed —
      //    it is the baseline the fill is measured against, and reading it
      //    after broadcast would measure the wrong thing.
      const pre = await this.#readPair(intent);
      const prePosition = await this.#readPosition(intent);
      const need =
        intent.input.amount + (bucket === "sol" ? FEE_BUFFER_LAMPORTS : 0n);
      if (pre.input < need) {
        throw new GuardError(
          "INSUFFICIENT_BALANCE",
          "wallet balance cannot cover this trade plus fees",
          { have: pre.input.toString(), need: need.toString() },
        );
      }

      // 4. Persist the trade row + journal.
      store.insertTrade(
        {
          id: tradeId,
          idempotencyKey: opts.idempotencyKey,
          intentJson: JSON.stringify(intent, bigintReplacer),
          inputMint: intent.input.mint,
          outputMint: intent.output.mint,
          inputAmount: intent.input.amount,
          lastValidBlockHeight: intent.lastValidBlockHeight,
          now,
        },
        reservationId,
      );
      inserted = true;
      store.appendJournal({
        type: "intent.received",
        tradeId,
        at: now,
        idempotencyKey: opts.idempotencyKey,
        source: intent.source,
        summary: intent.summary,
      });
      if (reservationId) {
        store.appendJournal({
          type: "trade.reserved",
          tradeId,
          at: now,
          bucket,
          amount: intent.input.amount.toString(),
        });
      }

      // 5. Simulate (preflight sanity, NOT a price guarantee).
      const sim = await this.#d.simulator.simulate(intent.unsignedTxBase64);
      store.appendJournal({
        type: "trade.simulated",
        tradeId,
        at: clock.now(),
        ok: sim.ok,
      });
      if (!sim.ok) {
        throw new GuardError(
          "SIMULATION_FAILED",
          "preflight simulation failed",
          { err: String(sim.err ?? "unknown") },
        );
      }

      // 6. Sign, then PERSIST the signed wire BEFORE broadcast.
      const signed = await this.#d.wallet.sign(intent.unsignedTxBase64);
      store.persistSigned(
        tradeId,
        signed.wireBase64,
        signed.signature,
        clock.now(),
      );
      store.appendJournal({
        type: "trade.signed",
        tradeId,
        at: clock.now(),
        signature: signed.signature,
      });

      // 7. Broadcast.
      const broadcaster: Broadcaster | undefined =
        this.#d.broadcasters[intent.landMode];
      if (!broadcaster) {
        throw new GuardError(
          "BROADCAST_FAILED",
          `no broadcaster for land mode '${intent.landMode}'`,
        );
      }
      let signature: string;
      try {
        ({ signature } = await broadcaster.broadcast(
          signed,
          intent.landHandle,
        ));
      } catch (e) {
        throw new GuardError(
          "BROADCAST_FAILED",
          e instanceof Error ? e.message : String(e),
        );
      }
      store.setSignature(tradeId, signature, clock.now());
      store.setState(tradeId, "sent", clock.now());
      store.appendJournal({
        type: "trade.sent",
        tradeId,
        at: clock.now(),
        signature,
      });

      // 8. Confirm. Blockhash expiry is TERMINAL — release + fail, never re-sign.
      const conf = await this.#d.confirmer.confirm(
        signature,
        intent.lastValidBlockHeight,
      );
      if (conf.status !== "confirmed") {
        const code =
          conf.status === "expired" ? "CONFIRM_TIMEOUT" : "BROADCAST_FAILED";
        if (reservationId) store.releaseReservation(reservationId);
        store.fail(
          tradeId,
          conf.status === "expired" ? "expired" : "errored",
          code,
          clock.now(),
        );
        store.appendJournal({
          type: "trade.failed",
          tradeId,
          at: clock.now(),
          code,
          message: `confirmation ${conf.status}`,
        });
        return this.#errorResult(
          tradeId,
          new GuardError(
            code,
            `transaction ${conf.status} before confirmation`,
          ),
          false,
        );
      }

      // 9. Settle — the real fill. Consume the reservation (the spend happened).
      const post = await this.#readPair(intent);
      const inputDelta = post.input - pre.input; // negative
      const outputDelta = post.output - pre.output; // positive
      const settle = await this.#settle(intent, outputDelta, prePosition);
      if (reservationId) store.consumeReservation(reservationId);
      store.setState(tradeId, "confirmed", clock.now());
      store.appendJournal({
        type: "trade.confirmed",
        tradeId,
        at: clock.now(),
        signature,
        inputDelta: inputDelta.toString(),
        outputDelta: outputDelta.toString(),
        effectiveSlippageBps: settle.effectiveSlippageBps,
        ...(settle.positionDelta === undefined
          ? {}
          : { positionDelta: settle.positionDelta.toString() }),
      });

      return result(tradeId, "confirmed", {
        signature,
        summary: settle.problem
          ? `${intent.summary} — WARNING: ${settle.problem.message}`
          : intent.summary,
        fill: {
          inputDelta,
          outputDelta,
          effectiveSlippageBps: settle.effectiveSlippageBps,
          ...(settle.positionDelta === undefined
            ? {}
            : { positionDelta: settle.positionDelta }),
        },
        error: settle.problem,
      });
    } catch (err) {
      if (reservationId) store.releaseReservation(reservationId);
      if (inserted) {
        const code = isGuardError(err) ? err.code : "INTERNAL";
        store.fail(tradeId, "errored", code, clock.now());
        store.appendJournal({
          type: "trade.failed",
          tradeId,
          at: clock.now(),
          code: isGuardError(err) ? err.code : "INVALID_INTENT",
          message: err instanceof Error ? err.message : String(err),
        });
      } else {
        store.appendJournal({
          type: "guard.rejected",
          tradeId,
          at: clock.now(),
          code: isGuardError(err) ? err.code : "INVALID_INTENT",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return this.#errorResult(tradeId, err, false);
    }
  }

  /**
   * Refuse, before anything is signed, any intent whose fill this composition
   * cannot verify. Today that is exactly one case: a perp kind with no
   * {@link PositionReader} mounted. Fail closed rather than execute blind.
   */
  #assertSettleable(intent: TradeIntent): void {
    if (settleModeFor(intent.kind) !== "venue-position") return;
    if (!this.#d.positions) {
      throw new GuardError(
        "SETTLE_UNVERIFIABLE",
        `no position reader is mounted for venue '${intent.perp?.venue ?? "unknown"}' — ` +
          "a perp fill cannot be verified from a token balance, so this intent is refused",
      );
    }
  }

  /** The venue position this intent targets, or `undefined` for a non-perp kind. */
  #positionRef(intent: TradeIntent): PerpPositionRef | undefined {
    const perp = intent.perp;
    if (!perp || settleModeFor(intent.kind) !== "venue-position")
      return undefined;
    return {
      venue: perp.venue,
      market: perp.market,
      owner: this.#d.wallet.pubkey,
      subAccountId: perp.accountSubId,
    };
  }

  async #readPosition(intent: TradeIntent): Promise<bigint | undefined> {
    const ref = this.#positionRef(intent);
    if (!ref) return undefined;
    // `positions` is guaranteed by #assertSettleable, which runs first.
    return this.#d.positions!.readPosition(ref);
  }

  /**
   * Verify the fill of a CONFIRMED transaction.
   *
   * `token-delta` — the swap-shaped default: the wallet's balance of the output
   * mint must have grown by at least the route's committed min-out.
   *
   * `venue-position` — a perp. Collateral leaving the wallet on an open makes
   * the output-mint delta go NEGATIVE (the collateral mint is both legs), so
   * the balance check would fire a shortfall on every successful open and
   * verify nothing on a close. Instead we diff the venue position across the
   * transaction and require it to move in the ORDER's direction by at least
   * `perp.minBaseAmount` — the perps analogue of min-out. A close of a long is
   * a 'short' order, so the same signed comparison covers all four kinds.
   *
   * A position read that fails here is reported as `SETTLE_UNVERIFIED`, never
   * as a failed trade: the transaction is already confirmed on-chain and
   * unwinding the row over an RPC hiccup would be a lie.
   */
  async #settle(
    intent: TradeIntent,
    outputDelta: bigint,
    prePosition: bigint | undefined,
  ): Promise<{
    effectiveSlippageBps: number;
    positionDelta: bigint | undefined;
    problem: { code: string; message: string } | undefined;
  }> {
    const perp = intent.perp;
    const ref = this.#positionRef(intent);
    if (!ref || !perp || prePosition === undefined) {
      const effectiveSlippageBps = slippageBps(
        intent.quote.outAmount,
        outputDelta > 0n ? outputDelta : 0n,
      );
      return {
        effectiveSlippageBps,
        positionDelta: undefined,
        problem:
          outputDelta < intent.quote.minOutAmount
            ? {
                code: "SETTLE_SHORTFALL",
                message: "received less than committed min-out",
              }
            : undefined,
      };
    }

    let postPosition: bigint;
    try {
      postPosition = await this.#d.positions!.readPosition(ref);
    } catch (e) {
      return {
        effectiveSlippageBps: 0,
        positionDelta: undefined,
        problem: {
          code: "SETTLE_UNVERIFIED",
          message: `confirmed on-chain, but the ${perp.venue} position could not be read back: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      };
    }

    const positionDelta = postPosition - prePosition;
    const filled = perp.side === "long" ? positionDelta : -positionDelta;
    const effectiveSlippageBps = slippageBps(
      perp.expectedBaseAmount,
      filled > 0n ? filled : 0n,
    );
    return {
      effectiveSlippageBps,
      positionDelta,
      problem:
        filled < perp.minBaseAmount
          ? {
              code: "SETTLE_SHORTFALL",
              message: `${perp.market} position moved ${filled} base units, below the committed minimum ${perp.minBaseAmount}`,
            }
          : undefined,
    };
  }

  async #assertMintsSupported(
    policy: PolicyConfig,
    intent: TradeIntent,
  ): Promise<void> {
    const [inInfo, outInfo] = await Promise.all([
      this.#d.mints.inspect(intent.input.mint),
      this.#d.mints.inspect(intent.output.mint),
    ]);
    if (!policy.allowToken2022 && (inInfo.isToken2022 || outInfo.isToken2022)) {
      throw new GuardError(
        "TOKEN2022_UNSUPPORTED",
        "Token-2022 mint detected; refused (transfer fees / hooks are not accounted for)",
      );
    }
  }

  #assertWithinCaps(
    bucket: string,
    amount: bigint,
    caps: { perTrade: bigint; perHour: bigint; perDay: bigint },
    used: { hour: bigint; day: bigint },
  ): void {
    if (amount > caps.perTrade) {
      throw new GuardError(
        "CAP_EXCEEDED",
        `${bucket.toUpperCase()} per-trade cap exceeded`,
      );
    }
    if (used.hour + amount > caps.perHour) {
      throw new GuardError(
        "CAP_EXCEEDED",
        `${bucket.toUpperCase()} per-hour cap exceeded`,
      );
    }
    if (used.day + amount > caps.perDay) {
      throw new GuardError(
        "CAP_EXCEEDED",
        `${bucket.toUpperCase()} per-day cap exceeded`,
      );
    }
  }

  async #readPair(
    intent: TradeIntent,
  ): Promise<{ input: bigint; output: bigint }> {
    const owner = this.#d.wallet.pubkey;
    const [input, output] = await Promise.all([
      this.#d.balances.readBalance(owner, intent.input.mint),
      this.#d.balances.readBalance(owner, intent.output.mint),
    ]);
    return { input, output };
  }

  #errorResult(
    tradeId: string,
    err: unknown,
    simulated: boolean,
  ): ExecuteResult {
    const code = isGuardError(err) ? err.code : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    return result(tradeId, "rejected", {
      simulated,
      summary: message,
      error: { code, message },
    });
  }
}

function result(
  tradeId: string,
  state: ExecuteResult["state"],
  extra: Partial<Omit<ExecuteResult, "tradeId" | "state">> = {},
): ExecuteResult {
  return {
    tradeId,
    state,
    signature: extra.signature,
    simulated: extra.simulated ?? false,
    summary: extra.summary ?? "",
    fill: extra.fill,
    error: extra.error,
  };
}
