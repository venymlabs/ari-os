/**
 * The SERVER half of the dashboard view-model contract.
 *
 * `web/src/data/types.ts` is the browser half, and its header explains why the
 * two mirror rather than share: `web/` is its own npm package with its own
 * dependency budget, and the kernel's contracts carry `bigint`, node types and
 * Solana SDK imports that have no business in a browser bundle.
 *
 * This file is the third copy of that shape and the only one the server can
 * typecheck against, so the same warning applies twice over: NOTHING ENFORCES
 * THIS MIRROR. When you touch `src/kernel/contracts.ts`, come here AND to
 * `web/src/data/types.ts`. `tests/control-plane.test.ts` at least pins the
 * wire-level field names a rendered snapshot must carry.
 *
 * MONEY RULE (identical to the browser half): token quantities are never
 * `number`. They are base-unit integers carried as decimal strings, paired with
 * `decimals`. Only USD estimates — already lossy — are `number`.
 *
 * Reconciled against `web/src/data/types.ts` on 2026-08-21.
 */

export interface Amount {
  readonly mint: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly base: string;
}

export type QuoteBucketView = "sol" | "usdc";
export type Provenance = "user" | "watchlist" | "untrusted";
export type TradeStateView =
  "reserved" | "sent" | "confirmed" | "expired" | "errored" | "rejected";

/**
 * The 17 guard codes the browser mirror knows about, in kernel order.
 *
 * `src/kernel/errors.ts` has since grown SETTLE_UNVERIFIABLE and
 * SETTLE_UNVERIFIED, which the browser mirror does not carry. Neither is
 * evaluable before a human decides — both are post-decision settle outcomes —
 * so they surface in the Activity journal as text rather than as a guard chip.
 */
export type GuardCodeView =
  | "EXECUTION_DISABLED"
  | "KILL_SWITCH"
  | "INVALID_INTENT"
  | "MINT_NOT_PINNED"
  | "MINT_DENIED"
  | "TOKEN2022_UNSUPPORTED"
  | "CAP_EXCEEDED"
  | "INSUFFICIENT_BALANCE"
  | "SLIPPAGE_EXCEEDED"
  | "PRIORITY_FEE_EXCEEDED"
  | "PRIORITY_FEE_INVALID"
  | "SIMULATION_FAILED"
  | "MIN_OUT_MISMATCH"
  | "DUPLICATE_INTENT"
  | "BROADCAST_FAILED"
  | "CONFIRM_TIMEOUT"
  | "SETTLE_SHORTFALL";

export type AgentPhase =
  | "idle"
  | "observing"
  | "proposing"
  | "awaiting_approval"
  | "executing"
  | "settling"
  | "halted";

export interface ReconcilerState {
  readonly running: boolean;
  readonly lastSweepAt: number;
  readonly pending: number;
  readonly blockHeight: number;
  readonly slot: number;
}

export interface SystemState {
  readonly executionEnabled: boolean;
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

export type CapWindow = "perTrade" | "perHour" | "perDay";

export interface CapMeter {
  readonly window: CapWindow;
  readonly cap: string;
  readonly used: string;
  readonly resetsAt: number | null;
}

export interface CapLedger {
  readonly bucket: QuoteBucketView;
  readonly symbol: string;
  readonly decimals: number;
  readonly meters: readonly CapMeter[];
}

export interface PerpPositionView {
  readonly id: string;
  readonly venue: string;
  readonly market: string;
  readonly side: "long" | "short";
  readonly sizeUsd: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly leverage: number;
  readonly liquidationPrice: number;
  readonly liquidationDistancePct: number;
  readonly marginUsd: number;
  readonly unrealizedUsd: number;
  readonly fundingRateBps1h: number;
  readonly fundingPaidUsd: number;
  readonly openedAt: number;
}

export interface DlmmPositionView {
  readonly id: string;
  readonly pool: string;
  readonly venue: string;
  readonly binStep: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly activeBinId: number;
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
  readonly perps: readonly PerpPositionView[];
  readonly dlmm: readonly DlmmPositionView[];
  readonly totalExposureUsd: number;
  readonly openRiskUsd: number;
}

export type IntentKindView =
  | "swap"
  | "perp_open"
  | "perp_increase"
  | "perp_reduce"
  | "perp_close"
  | "lp_add"
  | "lp_remove";

export interface IntentView {
  readonly kind: IntentKindView;
  readonly summary: string;
  readonly input: Amount;
  readonly output: Amount;
  readonly minOut: Amount;
  readonly inputProvenance: Provenance;
  readonly outputProvenance: Provenance;
  readonly routeLabel: string;
  readonly priceImpactPct: number;
  readonly slippageBps: number;
  readonly priorityFeeLamports: string;
  readonly landMode: "jupiter-ultra" | "self-rpc";
  readonly landHandle: string | null;
  readonly unsignedTxDigest: string;
  readonly unsignedTxBytes: number;
  readonly recentBlockhash: string;
  readonly quoteContextSlot: number | null;
  readonly legs: readonly (readonly [string, string])[];
}

export interface GuardCheck {
  readonly code: GuardCodeView;
  readonly label: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
  readonly observed: string | null;
  readonly limit: string | null;
}

export interface CapCheck {
  readonly window: CapWindow;
  readonly bucket: QuoteBucketView;
  readonly symbol: string;
  readonly decimals: number;
  readonly cap: string;
  readonly used: string;
  readonly would: string;
  readonly ok: boolean;
}

export interface SimulationView {
  readonly ok: boolean;
  readonly unitsConsumed: number | null;
  readonly atSlot: number | null;
  readonly err: string | null;
  readonly logs: readonly string[];
}

export interface ExpiryView {
  readonly lastValidBlockHeight: number;
  readonly currentBlockHeight: number;
  readonly expiresAt: number;
}

export interface PendingApproval {
  readonly id: string;
  readonly tradeId: string;
  readonly idempotencyKey: string;
  readonly receivedAt: number;
  readonly source: string;
  readonly rationale: string;
  readonly modelLabel: string;
  readonly intent: IntentView;
  readonly guards: readonly GuardCheck[];
  readonly capChecks: readonly CapCheck[];
  readonly simulation: SimulationView;
  readonly expiry: ExpiryView;
  readonly verdict: "clear" | "blocked";
}

export type ActivityKind =
  | "intent.received"
  | "guard.rejected"
  | "trade.reserved"
  | "trade.simulated"
  | "trade.signed"
  | "trade.sent"
  | "trade.confirmed"
  | "trade.failed"
  | "trade.dryrun"
  | "reconciler.sweep";

export interface ActivityEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: ActivityKind;
  readonly tradeId: string | null;
  readonly level: "info" | "pass" | "warn" | "fail";
  readonly text: string;
  readonly signature: string | null;
  readonly fields: readonly (readonly [string, string])[];
}

export interface InflightTrade {
  readonly id: string;
  readonly state: TradeStateView;
  readonly signature: string | null;
  readonly summary: string;
  readonly since: number;
  readonly blockHeadroom: number;
}

export type StrategyKind = "dca" | "twap" | "trailing_stop" | "take_profit";
export type StrategyStatus = "active" | "paused" | "done" | "errored";

export const STRATEGY_STATUSES: readonly StrategyStatus[] = [
  "active",
  "paused",
  "done",
  "errored",
];

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
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly trigger: {
    readonly label: string;
    readonly current: number;
    readonly target: number;
    readonly distancePct: number;
  } | null;
  readonly budget: {
    readonly spent: string;
    readonly cap: string;
    readonly symbol: string;
    readonly decimals: number;
  } | null;
}

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
  readonly rugHeat: { readonly score: number; readonly reasons: string[] };
  readonly watched: boolean;
}

export interface SignalsView {
  readonly windowMs: number;
  readonly feedLabel: string;
  readonly connected: boolean;
  readonly tape: readonly TapeRow[];
  readonly tokens: readonly TokenSignalView[];
}

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

export type ApprovalDecision = "approve" | "reject";

export interface DecisionResult {
  readonly ok: boolean;
  readonly tradeId: string;
  readonly message: string;
}
