/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VIEW-MODEL CONTRACT — this file is the whole seam.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything the dashboard renders comes from `DashboardSnapshot`, and every
 * action it can take goes through `DashboardSource`. Nothing in `src/views`,
 * `src/components` or `src/state` imports a fixture or a fetch call directly.
 *
 * To go live, edit exactly one file — `src/data/source.ts` — and point it at a
 * real implementation of `DashboardSource`. `src/data/http-source.ts` is that
 * implementation for a REST/SSE control-plane; `src/data/fixture-source.ts` is
 * the in-browser simulation used until the backend exists.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠ THIS IS A HAND-MAINTAINED MIRROR. IT CAN SILENTLY DRIFT.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * These shapes MIRROR rather than import `../../../src/kernel/contracts.ts`.
 * That is deliberate: `web/` is its own npm package with its own dependency
 * budget and its own audit, and the kernel's contracts carry `bigint`, node
 * types and (transitively) Solana SDK imports that have no business in a
 * browser bundle. Importing them would drag the server package's dependency
 * graph across the wire.
 *
 * The cost of that decision is that NOTHING ENFORCES THIS MIRROR. There is no
 * shared type, no structural test, no build step that fails when the kernel
 * changes. A field added to `TradeIntent`, a new `GuardCode`, a renamed
 * `TradeState` — the dashboard keeps compiling and quietly stops telling the
 * operator the truth. On a screen whose whole job is binding a human to an
 * exact transaction, that is a safety defect, not a papercut.
 *
 * So: WHEN YOU TOUCH `src/kernel/contracts.ts`, `src/kernel/errors.ts` OR
 * `src/kernel/money.ts`, COME BACK HERE. Every block below names its source of
 * truth. Reconciled against the kernel on 2026-08-21.
 *
 * Known, deliberate divergences as of that reconciliation:
 *
 *   · `IntentKind` here carries the perp/LP kinds; the kernel's is `"swap"`
 *     only and `staticGuards()` throws INVALID_INTENT on anything else. The
 *     extra kinds are ahead of `src/perps/` and `src/pools/` landing, and the
 *     approval card already renders their decoded legs.
 *   · `ActivityKind` = every `JournalEventType` PLUS `reconciler.sweep`, which
 *     is a UI-only synthetic — the reconciler does not append a journal event.
 *   · `priorityFeeLamports` is a decimal string on both the intent and the
 *     policy ceiling. The kernel types the intent-side fee as `number` and the
 *     policy ceiling as `bigint`; the mirror normalises both to the money rule
 *     rather than importing the kernel's inconsistency.
 *   · `MintInfo.freezeAuthority` / `.mintAuthority` are NOT mirrored. No guard
 *     reads them today. If one ever does, they belong on `Holding`.
 *   · `ExpiryView.expiresAt` has no kernel field behind it — the kernel owns
 *     `lastValidBlockHeight` (a block height), and wall-clock expiry is a
 *     control-plane estimate derived from slot time. Treat it as advisory; the
 *     height is the authority.
 *   · A SELL has no quote bucket. `quoteBucketFor()` returns null when the
 *     input leg is not SOL/USDC, so `capChecks` is legitimately EMPTY and no
 *     spend cap applies. An empty array is a real state, not missing data.
 *
 * MONEY RULE: token quantities are never `number`. They are base-unit integers
 * carried as decimal strings (the same way `JournalEvent` serializes bigints),
 * paired with `decimals`. Only USD estimates — which are already lossy — are
 * `number`. See `src/lib/format.ts` for the display helpers.
 */

// ── money ───────────────────────────────────────────────────────────────────

/** A token quantity. `base` is a base-unit integer as a decimal string. */
export interface Amount {
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly base: string;
}

/** Which spend-cap ledger an input leg is denominated in. Mirrors `QuoteBucket` in kernel/money.ts. */
export type QuoteBucket = 'sol' | 'usdc';

// ── system state ────────────────────────────────────────────────────────────

/** Mirrors `MintProvenance` in kernel/contracts.ts. */
export type Provenance = 'user' | 'watchlist' | 'untrusted';

/** Mirrors `TRADE_STATES` / `TradeState` in kernel/contracts.ts. `expired` is TERMINAL. */
export type TradeState = 'reserved' | 'sent' | 'confirmed' | 'expired' | 'errored' | 'rejected';

/**
 * Mirrors `GuardCode` in kernel/errors.ts — all 17, in kernel order.
 *
 * Only 13 of these can be evaluated before a human decides; the approval card
 * renders exactly those. PRIORITY_FEE_INVALID is a structural reject the
 * gateway raises before an intent is ever queued, and BROADCAST_FAILED /
 * CONFIRM_TIMEOUT / SETTLE_SHORTFALL are post-decision outcomes that surface in
 * the Activity journal instead.
 */
export type GuardCode =
  | 'EXECUTION_DISABLED'
  | 'KILL_SWITCH'
  | 'INVALID_INTENT'
  | 'MINT_NOT_PINNED'
  | 'MINT_DENIED'
  | 'TOKEN2022_UNSUPPORTED'
  | 'CAP_EXCEEDED'
  | 'INSUFFICIENT_BALANCE'
  | 'SLIPPAGE_EXCEEDED'
  | 'PRIORITY_FEE_EXCEEDED'
  | 'PRIORITY_FEE_INVALID'
  | 'SIMULATION_FAILED'
  | 'MIN_OUT_MISMATCH'
  | 'DUPLICATE_INTENT'
  | 'BROADCAST_FAILED'
  | 'CONFIRM_TIMEOUT'
  | 'SETTLE_SHORTFALL';

/** What the agent loop is doing right now. Display-only; the kernel is the authority. */
export type AgentPhase =
  | 'idle'
  | 'observing'
  | 'proposing'
  | 'awaiting_approval'
  | 'executing'
  | 'settling'
  | 'halted';

export interface ReconcilerState {
  readonly running: boolean;
  readonly lastSweepAt: number;
  /** Trades still in `reserved` or `sent` — the reconciler owns their lifecycle. */
  readonly pending: number;
  readonly blockHeight: number;
  readonly slot: number;
}

/** Mirrors `PolicyConfig` in kernel/contracts.ts, flattened for display. */
export interface SystemState {
  /** Master arm. False = dry-run; the kernel refuses to move value. */
  readonly executionEnabled: boolean;
  /** Hard stop. True = every value-moving action is refused. */
  readonly killSwitch: boolean;
  readonly agentPhase: AgentPhase;
  readonly maxSlippageBps: number;
  readonly priorityFeeMaxLamports: string;
  readonly priorityFeeMaxBps: number;
  readonly allowToken2022: boolean;
  readonly mintAllowlistSize: number | null;
  readonly mintDenylistSize: number;
  readonly network: string;
  readonly rpcLabel: string;
  readonly modelLabel: string;
  readonly bootedAt: number;
  readonly lastHeartbeatAt: number;
  readonly reconciler: ReconcilerState;
}

// ── wallet & holdings ───────────────────────────────────────────────────────

export interface Holding {
  readonly amount: Amount;
  readonly usd: number;
  readonly costUsd: number | null;
  readonly pnlPct: number | null;
  readonly provenance: Provenance;
  readonly token2022: boolean;
}

export interface WalletView {
  readonly address: string;
  readonly label: string;
  readonly totalUsd: number;
  readonly change24hPct: number;
  readonly holdings: readonly Holding[];
}

// ── spend caps (input-leg denominated — the thing the kernel actually enforces) ──

/** The keys of `SpendCaps` in kernel/contracts.ts, which are also `ReserveDenyReason`. */
export type CapWindow = 'perTrade' | 'perHour' | 'perDay';

export interface CapMeter {
  readonly window: CapWindow;
  /** base units, decimal string */
  readonly cap: string;
  readonly used: string;
  /** epoch ms when the rolling window rolls over; null for perTrade. */
  readonly resetsAt: number | null;
}

export interface CapLedger {
  readonly bucket: QuoteBucket;
  readonly symbol: string;
  readonly decimals: number;
  readonly meters: readonly CapMeter[];
}

// ── positions ───────────────────────────────────────────────────────────────

export interface PerpPosition {
  readonly id: string;
  readonly venue: string;
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly sizeUsd: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly leverage: number;
  readonly liquidationPrice: number;
  /** How far mark can move against you before liquidation, as a % of mark. */
  readonly liquidationDistancePct: number;
  readonly marginUsd: number;
  readonly unrealizedUsd: number;
  /** Signed hourly funding in bps. Negative = you are being paid. */
  readonly fundingRateBps1h: number;
  readonly fundingPaidUsd: number;
  readonly openedAt: number;
}

export interface DlmmPosition {
  readonly id: string;
  readonly pool: string;
  readonly venue: string;
  readonly binStep: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly activeBinId: number;
  /** False when the active bin has drifted outside [lower, upper] — position is idle. */
  readonly inRange: boolean;
  readonly lowerPrice: number;
  readonly upperPrice: number;
  readonly currentPrice: number;
  readonly liquidityUsd: number;
  readonly feesEarnedUsd: number;
  readonly feesUnclaimed: readonly Amount[];
  readonly openedAt: number;
}

export interface PositionsView {
  readonly spot: readonly Holding[];
  readonly perps: readonly PerpPosition[];
  readonly dlmm: readonly DlmmPosition[];
  readonly totalExposureUsd: number;
  readonly openRiskUsd: number;
}

// ── approvals: the pending-intent queue ─────────────────────────────────────

/**
 * AHEAD OF THE KERNEL. `IntentKind` in kernel/contracts.ts is `"swap"` only —
 * `staticGuards()` throws INVALID_INTENT on anything else. The perp and LP
 * kinds are here for `src/perps/` and `src/pools/`, which are being built in
 * parallel; the approval card already renders their decoded legs.
 */
export type IntentKind =
  | 'swap'
  | 'perp_open'
  | 'perp_increase'
  | 'perp_reduce'
  | 'perp_close'
  | 'lp_add'
  | 'lp_remove';

/**
 * The decoded intent, exactly as the kernel re-read it — never as the model
 * described it. Mirrors `TradeIntent` + its `QuoteSummary` in
 * kernel/contracts.ts, minus `unsignedTxBase64` (replaced by a digest + a byte
 * count, so the whole wire blob never rides in a snapshot) and minus `source`
 * (which lives on `PendingApproval`, next to the rest of the queue metadata).
 */
export interface IntentView {
  readonly kind: IntentKind;
  readonly summary: string;
  /** What LEAVES the wallet — the leg every cap is denominated in. */
  readonly input: Amount;
  /** Expected out. */
  readonly output: Amount;
  /** Worst case the route guarantees (otherAmountThreshold). */
  readonly minOut: Amount;
  readonly inputProvenance: Provenance;
  readonly outputProvenance: Provenance;
  readonly routeLabel: string;
  readonly priceImpactPct: number;
  readonly slippageBps: number;
  /**
   * Mirrors `TradeIntent.priorityFeeLamports`, which the kernel types as
   * `number` while typing the policy ceiling it is checked against as `bigint`.
   * Lamports are base units, so the money rule applies: decimal string here.
   */
  readonly priorityFeeLamports: string;
  readonly landMode: 'jupiter-ultra' | 'self-rpc';
  /**
   * Mirrors `TradeIntent.landHandle` — the opaque per-land-mode handle, e.g. a
   * Jupiter Ultra requestId. Never secret, and never trusted by the kernel, but
   * it is part of what an approval binds to: the operator should be able to see
   * which submission handle their signature is about to be spent on.
   */
  readonly landHandle: string | null;
  /** Digest of the serialized unsigned tx — what an approval actually binds to. */
  readonly unsignedTxDigest: string;
  readonly unsignedTxBytes: number;
  readonly recentBlockhash: string;
  /**
   * Mirrors `QuoteSummary.contextSlot` — the slot the aggregator priced this
   * route at. The gap between this and the simulation slot is how stale the
   * quote is; a wide gap is a reason to reject even when every guard passes.
   */
  readonly quoteContextSlot: number | null;
  /** Extra decoded legs for non-swap intents (perp/LP), as label/value rows. */
  readonly legs: readonly (readonly [string, string])[];
}

export interface GuardCheck {
  readonly code: GuardCode;
  readonly label: string;
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly detail: string;
  /** Numeric evidence, pre-formatted for display. */
  readonly observed: string | null;
  readonly limit: string | null;
}

/**
 * One rolling window checked against this intent's input leg. Derived from
 * `KernelStore.usage()` + `SpendCaps`; `would` is `used` + the input leg.
 *
 * An intent whose input leg is not a quote asset (a SELL) draws from no bucket
 * at all — `quoteBucketFor()` returns null — and carries ZERO cap checks.
 */
export interface CapCheck {
  readonly window: CapWindow;
  readonly bucket: QuoteBucket;
  readonly symbol: string;
  readonly decimals: number;
  readonly cap: string;
  readonly used: string;
  /** used + this intent's input leg. */
  readonly would: string;
  readonly ok: boolean;
}

/** Mirrors `SimOutcome` in kernel/contracts.ts. */
export interface SimulationView {
  readonly ok: boolean;
  readonly unitsConsumed: number | null;
  readonly atSlot: number | null;
  /**
   * Mirrors `SimOutcome.err`, rendered to a string by the control plane. When
   * simulation fails this is the actual reason; the logs alone often are not.
   */
  readonly err: string | null;
  readonly logs: readonly string[];
}

/**
 * The blockhash lifecycle the kernel owns. `lastValidBlockHeight` mirrors the
 * field of the same name on `TradeIntent` and is the AUTHORITY — expiry is a
 * block height, not a timestamp. `expiresAt` has no kernel field behind it: it
 * is a control-plane estimate from slot time, for the countdown bar only.
 *
 * Expiry is TERMINAL. The kernel never re-signs an intent under a new
 * blockhash; the agent must propose a fresh one with a new idempotency key.
 */
export interface ExpiryView {
  readonly lastValidBlockHeight: number;
  readonly currentBlockHeight: number;
  /** Wall-clock estimate for the blockhash dying. After this the intent is terminal. */
  readonly expiresAt: number;
}

export interface PendingApproval {
  readonly id: string;
  readonly tradeId: string;
  readonly idempotencyKey: string;
  readonly receivedAt: number;
  /** Tool that built the intent, e.g. `swap_jupiter`. */
  readonly source: string;
  /** What the model said it wanted. Untrusted narration — never a safety input. */
  readonly rationale: string;
  readonly modelLabel: string;
  readonly intent: IntentView;
  readonly guards: readonly GuardCheck[];
  readonly capChecks: readonly CapCheck[];
  readonly simulation: SimulationView;
  readonly expiry: ExpiryView;
  /** `blocked` = at least one guard failed; approval is impossible, not just discouraged. */
  readonly verdict: 'clear' | 'blocked';
}

// ── activity ────────────────────────────────────────────────────────────────

/**
 * Every `JournalEventType` in kernel/contracts.ts, PLUS `reconciler.sweep`,
 * which is a UI-only synthetic — the reconciler reports a `ReconcileSummary`
 * and does not append a journal event.
 */
export type ActivityKind =
  | 'intent.received'
  | 'guard.rejected'
  | 'trade.reserved'
  | 'trade.simulated'
  | 'trade.signed'
  | 'trade.sent'
  | 'trade.confirmed'
  | 'trade.failed'
  | 'trade.dryrun'
  | 'reconciler.sweep';

export interface ActivityEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: ActivityKind;
  readonly tradeId: string | null;
  readonly level: 'info' | 'pass' | 'warn' | 'fail';
  readonly text: string;
  readonly signature: string | null;
  readonly fields: readonly (readonly [string, string])[];
}

export interface InflightTrade {
  readonly id: string;
  readonly state: TradeState;
  readonly signature: string | null;
  readonly summary: string;
  readonly since: number;
  /** Blocks left before the blockhash expires. Negative = already dead. */
  readonly blockHeadroom: number;
}

// ── strategies ──────────────────────────────────────────────────────────────

/**
 * NOT YET IN THIS REPO. The strategy runners are part of the chain-agnostic
 * Aetheria packages still to be ported (see the unification plan, step 4).
 * Reconcile these against `src/strategy/` the moment it lands.
 */
export type StrategyKind = 'dca' | 'twap' | 'trailing_stop' | 'take_profit';
export type StrategyStatus = 'active' | 'paused' | 'done' | 'errored';

export interface StrategyView {
  readonly id: string;
  readonly kind: StrategyKind;
  readonly label: string;
  readonly status: StrategyStatus;
  readonly params: readonly (readonly [string, string])[];
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly createdAt: number;
  readonly runs: number;
  readonly errors: number;
  readonly lastError: string | null;
  /** Slice progress for DCA/TWAP; null for reactive strategies. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Trigger state for trailing-stop / take-profit. */
  readonly trigger: {
    readonly label: string;
    readonly current: number;
    readonly target: number;
    readonly distancePct: number;
  } | null;
  readonly budget: { readonly spent: string; readonly cap: string; readonly symbol: string; readonly decimals: number } | null;
}

// ── signals: the pump.fun tape + rug heat ───────────────────────────────────

/** NOT YET IN THIS REPO — mirrors the PumpPortal trade tape in the unported `data` package. */
export interface TapeRow {
  readonly id: string;
  readonly ts: number;
  readonly mint: string;
  readonly symbol: string;
  readonly isBuy: boolean;
  readonly solAmount: number;
  readonly trader: string;
  readonly priceSol: number | null;
}

/** NOT YET IN THIS REPO — mirrors `TokenSignals` + `RugHeat` in the unported `data` package. */
export interface TokenSignalView {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly trades: number;
  readonly buys: number;
  readonly sells: number;
  readonly netSolFlow: number;
  readonly volumeSol: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  readonly buyPressurePct: number;
  readonly volumeWeightedBuyPressurePct: number;
  readonly largestTradeSol: number;
  readonly priceChangePct: number | null;
  readonly rugHeat: { readonly score: number; readonly reasons: readonly string[] };
  readonly watched: boolean;
}

export interface SignalsView {
  readonly windowMs: number;
  readonly feedLabel: string;
  readonly connected: boolean;
  readonly tape: readonly TapeRow[];
  readonly tokens: readonly TokenSignalView[];
}

// ── the snapshot ────────────────────────────────────────────────────────────

export interface DashboardSnapshot {
  readonly generatedAt: number;
  readonly system: SystemState;
  readonly wallet: WalletView;
  readonly caps: readonly CapLedger[];
  readonly positions: PositionsView;
  readonly approvals: readonly PendingApproval[];
  readonly activity: readonly ActivityEntry[];
  readonly inflight: readonly InflightTrade[];
  readonly strategies: readonly StrategyView[];
  readonly signals: SignalsView;
}

// ── the port ────────────────────────────────────────────────────────────────

export type ApprovalDecision = 'approve' | 'reject';

/**
 * The control plane's fold of the kernel's `ExecuteResult`. Deliberately lossy:
 * `state`, `simulated` and `fill` are dropped here because the authoritative
 * record of what happened is the journal, which arrives on the next snapshot —
 * this is only what the toast says. A control plane MUST NOT report `ok: true`
 * for an intent the gateway refused.
 */
export interface DecisionResult {
  readonly ok: boolean;
  readonly tradeId: string;
  readonly message: string;
}

/**
 * The single port the UI talks to. Implement this against the real control
 * plane and swap it in `src/data/source.ts` — that is the entire integration.
 *
 * `subscribe` is push-based so a live implementation can back it with SSE or a
 * WebSocket without any change above this line. Implementations must call the
 * listener with a full snapshot; the UI does not merge partials.
 */
export interface DashboardSource {
  /** Short id shown in the status strip, e.g. `fixture` / `http`. */
  readonly id: string;
  /** Human label for the connection, e.g. `SIMULATED` or the API origin. */
  readonly label: string;
  /** True when this source is a simulation and the UI should say so loudly. */
  readonly simulated: boolean;

  /** Current snapshot. Called once on mount. */
  getSnapshot(): Promise<DashboardSnapshot>;
  /** Push updates. Returns an unsubscribe. */
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;

  /** Approve or reject one pending intent. Binds one operator to one exact tx. */
  decide(approvalId: string, decision: ApprovalDecision): Promise<DecisionResult>;
  /** Engage / release the hard stop. */
  setKillSwitch(engaged: boolean): Promise<void>;
  /** Arm / disarm execution (dry-run toggle). */
  setExecutionEnabled(enabled: boolean): Promise<void>;
  /** Pause / resume a strategy runner. */
  setStrategyStatus(strategyId: string, status: StrategyStatus): Promise<void>;
}
