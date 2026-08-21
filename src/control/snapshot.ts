/**
 * Projects the daemon's real runtime into one {@link DashboardSnapshot}.
 *
 * The rule this module is written to: **never invent a number**. Where a source
 * exists in this repo it is read; where one does not, the field carries an
 * explicit empty/unavailable value and {@link SnapshotSources} says so on the
 * wire, so an operator can tell "nothing is happening" apart from "nothing is
 * wired". A console that quietly renders zeros for data it cannot see is worse
 * than one that renders nothing.
 *
 * Backed by real runtime state today:
 *   · system policy      — the live `PolicyConfig` the TradeGateway re-reads
 *   · caps               — `SpendCaps` + `KernelStore.usage()` per bucket
 *   · activity           — the kernel journal (`KernelStore.recentJournal`)
 *   · inflight           — kernel trades still in `reserved` / `sent`
 *   · wallet / spot      — `SolanaReader.getTokenHoldings`, when custody is
 *                          mounted (the default daemon mounts none)
 *
 * Explicitly unavailable, because no source exists in this repo yet:
 *   · approvals          — the kernel has NO pending-approval queue.
 *                          `TradeGatewayImpl` takes `confirmedByUser` per call
 *                          and the composition leaves it unwired, so there is
 *                          nothing to queue and nothing to decide.
 *   · strategies         — the runners are unported Aetheria packages.
 *   · signals            — the PumpPortal tape is an unported Aetheria package.
 *   · perp / DLMM legs   — `PerpsVenue.getPositions` exists but needs the
 *                          optional Drift SDK peer and live RPC; no lister is
 *                          mounted for the console.
 *   · USD valuation      — there is no price oracle in this repo. Every `usd`
 *                          field is 0 and `SnapshotSources.valuation` is false.
 *   · block height/slot  — no chain-height port is mounted, so blockhash
 *                          headroom is reported as 0 rather than guessed.
 */

import type { JournalEvent, PolicyConfig } from "../kernel/contracts.js";
import type { SolanaReader } from "../kernel/contracts.js";
import type { KernelStore, TradeRow } from "../kernel/store.js";
import {
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MINT,
  USDT_MINT,
  WSOL_MINT,
} from "../kernel/money.js";
import { TOKEN_2022_PROGRAM_ID } from "../chains/solana/spl.js";
import type { PolicyController } from "./policy.js";
import type {
  ActivityEntry,
  ActivityKind,
  Amount,
  AgentPhase,
  CapLedger,
  DashboardSnapshot,
  Holding,
  InflightTrade,
  TradeStateView,
} from "./view.js";

/** Which panels of a snapshot are backed by a real source in this build. */
export interface SnapshotSources {
  readonly kernel: boolean;
  readonly wallet: boolean;
  readonly valuation: boolean;
  readonly approvals: boolean;
  readonly strategies: boolean;
  readonly signals: boolean;
  readonly perps: boolean;
  readonly dlmm: boolean;
  readonly chainHeight: boolean;
}

export interface ControlRuntime {
  readonly network: string;
  readonly rpcLabel: string;
  readonly modelLabel: string;
  readonly bootedAt: number;
  /** base58 pubkey of the mounted wallet, or null when custody is unmounted. */
  readonly walletAddress: string | null;
  readonly policy: PolicyController;
  /** The kernel store, opened on demand. Undefined when it cannot be opened. */
  kernel(): KernelStore | undefined;
  /** Read-side chain view, when custody mounts one. */
  balances?: SolanaReader | undefined;
  now?: () => number;
}

const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  [WSOL_MINT]: { symbol: "SOL", decimals: SOL_DECIMALS },
  [USDC_MINT]: { symbol: "USDC", decimals: USDC_DECIMALS },
  [USDT_MINT]: { symbol: "USDT", decimals: USDC_DECIMALS },
};

function symbolFor(mint: string, fallbackDecimals: number): Amount {
  const known = KNOWN[mint];
  return {
    mint,
    symbol: known?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
    decimals: known?.decimals ?? fallbackDecimals,
    base: "0",
  };
}

const ACTIVITY_LEVEL: Record<JournalEvent["type"], ActivityEntry["level"]> = {
  "intent.received": "info",
  "guard.rejected": "fail",
  "trade.reserved": "info",
  "trade.simulated": "pass",
  "trade.signed": "info",
  "trade.sent": "info",
  "trade.confirmed": "pass",
  "trade.failed": "fail",
  "trade.dryrun": "warn",
};

function activityText(event: JournalEvent): string {
  switch (event.type) {
    case "intent.received":
      return event.summary || `intent received from ${event.source}`;
    case "guard.rejected":
      return `${event.code} — ${event.message}`;
    case "trade.reserved":
      return event.bucket
        ? `reserved ${event.amount} base units against the ${event.bucket} cap`
        : "reserved (no quote bucket — no spend cap applies)";
    case "trade.simulated":
      return event.ok ? "simulation passed" : "simulation failed";
    case "trade.signed":
      return "signed and persisted before broadcast";
    case "trade.sent":
      return "broadcast to the cluster";
    case "trade.confirmed":
      return `confirmed — effective slippage ${event.effectiveSlippageBps}bps`;
    case "trade.failed":
      return `${event.code} — ${event.message}`;
    case "trade.dryrun":
      return `dry run — ${event.summary}`;
  }
}

function activityFields(
  event: JournalEvent,
): readonly (readonly [string, string])[] {
  const skip = new Set(["type", "tradeId", "at"]);
  return Object.entries(event as Record<string, unknown>)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const);
}

function signatureOf(event: JournalEvent): string | null {
  return "signature" in event && typeof event.signature === "string"
    ? event.signature
    : null;
}

function capLedger(
  bucket: "sol" | "usdc",
  policy: PolicyConfig,
  used: { hour: bigint; day: bigint } | undefined,
): CapLedger {
  const caps = bucket === "sol" ? policy.capsSol : policy.capsUsdc;
  return {
    bucket,
    symbol: bucket === "sol" ? "SOL" : "USDC",
    decimals: bucket === "sol" ? SOL_DECIMALS : USDC_DECIMALS,
    meters: [
      // The kernel's windows are ROLLING: every reservation ages out on its own
      // clock, so there is no single instant at which a window "resets".
      // `resetsAt` is null rather than a plausible-looking guess.
      {
        window: "perTrade",
        cap: caps.perTrade.toString(),
        used: "0",
        resetsAt: null,
      },
      {
        window: "perHour",
        cap: caps.perHour.toString(),
        used: (used?.hour ?? 0n).toString(),
        resetsAt: null,
      },
      {
        window: "perDay",
        cap: caps.perDay.toString(),
        used: (used?.day ?? 0n).toString(),
        resetsAt: null,
      },
    ],
  };
}

function summaryOf(row: TradeRow): string {
  try {
    const intent = JSON.parse(row.intent_json) as { summary?: unknown };
    if (typeof intent.summary === "string" && intent.summary) {
      return intent.summary;
    }
  } catch {
    // A journal row we cannot parse is still a trade the operator must see.
  }
  return `${row.input_mint.slice(0, 4)}… → ${row.output_mint.slice(0, 4)}…`;
}

function phaseOf(
  policy: PolicyConfig,
  inflight: readonly InflightTrade[],
  enforced: boolean,
): AgentPhase {
  if (policy.killSwitch || !enforced) return "halted";
  if (inflight.some((t) => t.state === "sent")) return "settling";
  if (inflight.some((t) => t.state === "reserved")) return "executing";
  return "idle";
}

/** Holdings read straight off the chain, with no valuation attached. */
async function readHoldings(
  runtime: ControlRuntime,
  policy: PolicyConfig,
): Promise<readonly Holding[]> {
  const { balances, walletAddress } = runtime;
  if (!balances || !walletAddress) return [];
  const pinned = new Set(policy.mintAllowlist ?? []);
  const rows: Holding[] = [];
  const lamports = await balances.getSolLamports(walletAddress);
  if (lamports > 0n) {
    rows.push({
      amount: { ...symbolFor(WSOL_MINT, SOL_DECIMALS), base: String(lamports) },
      usd: 0,
      costUsd: null,
      pnlPct: null,
      provenance: "user",
      token2022: false,
    });
  }
  for (const holding of await balances.getTokenHoldings(walletAddress)) {
    if (holding.amount <= 0n) continue;
    rows.push({
      amount: {
        mint: holding.mint,
        symbol:
          holding.symbol ??
          KNOWN[holding.mint]?.symbol ??
          `${holding.mint.slice(0, 4)}…${holding.mint.slice(-4)}`,
        decimals: holding.decimals,
        base: String(holding.amount),
      },
      usd: 0,
      costUsd: null,
      pnlPct: null,
      // Provenance is about how a mint entered the safety path. The only
      // deterministic pin this process owns is the operator's allowlist; with
      // no allowlist configured nothing is pinned, and the honest answer for
      // an arbitrary token that arrived in the wallet is `untrusted`.
      provenance: pinned.has(holding.mint) ? "user" : "untrusted",
      token2022: holding.programId === TOKEN_2022_PROGRAM_ID.toBase58(),
    });
  }
  return rows;
}

export function snapshotSources(runtime: ControlRuntime): SnapshotSources {
  return {
    kernel: !!runtime.kernel(),
    wallet: !!runtime.balances && !!runtime.walletAddress,
    valuation: false,
    approvals: false,
    strategies: false,
    signals: false,
    perps: false,
    dlmm: false,
    chainHeight: false,
  };
}

export async function buildSnapshot(
  runtime: ControlRuntime,
): Promise<DashboardSnapshot> {
  const now = (runtime.now ?? Date.now)();
  const policy = runtime.policy.get();
  const store = runtime.kernel();

  const trades = store ? store.recentTrades(100) : [];
  const inflight: InflightTrade[] = trades
    .filter((t) => t.state === "reserved" || t.state === "sent")
    .map((t) => ({
      id: t.id,
      state: t.state as TradeStateView,
      signature: t.signature,
      summary: summaryOf(t),
      since: t.updated_at,
      // No chain-height port is mounted, so headroom is unknowable rather than
      // zero-and-therefore-dead. Reported as 0 and flagged via
      // `SnapshotSources.chainHeight`.
      blockHeadroom: 0,
    }));

  const activity: ActivityEntry[] = (store?.recentJournal(200) ?? []).map(
    ({ seq, event }) => ({
      id: `j${seq}`,
      at: event.at,
      kind: event.type as ActivityKind,
      tradeId: event.tradeId ?? null,
      level: ACTIVITY_LEVEL[event.type],
      text: activityText(event),
      signature: signatureOf(event),
      fields: activityFields(event),
    }),
  );

  const holdings = await readHoldings(runtime, policy).catch(() => []);

  return {
    generatedAt: now,
    system: {
      executionEnabled: policy.executionEnabled,
      killSwitch: policy.killSwitch,
      agentPhase: phaseOf(policy, inflight, runtime.policy.enforced),
      maxSlippageBps: policy.maxSlippageBps,
      priorityFeeMaxLamports: policy.priorityFeeMaxLamports.toString(),
      priorityFeeMaxBps: policy.priorityFeeMaxBps,
      allowToken2022: policy.allowToken2022,
      mintAllowlistSize: policy.mintAllowlist?.length ?? null,
      mintDenylistSize: policy.mintDenylist.length,
      network: runtime.network,
      rpcLabel: runtime.rpcLabel,
      modelLabel: runtime.modelLabel,
      bootedAt: runtime.bootedAt,
      lastHeartbeatAt: now,
      reconciler: {
        // The kernel's `Reconciler` is boot-time crash recovery; nothing
        // schedules a periodic sweep in this build, so `running` is false and
        // `lastSweepAt` is 0. `pending` is real.
        running: false,
        lastSweepAt: 0,
        pending: inflight.length,
        blockHeight: 0,
        slot: 0,
      },
    },
    wallet: {
      address: runtime.walletAddress ?? "",
      label: runtime.walletAddress ? "OPERATOR WALLET" : "NO CUSTODY MOUNTED",
      // No price oracle exists in this repo; see the header.
      totalUsd: 0,
      change24hPct: 0,
      holdings,
    },
    caps: [
      capLedger("sol", policy, store?.usage("sol", now)),
      capLedger("usdc", policy, store?.usage("usdc", now)),
    ],
    positions: {
      spot: holdings,
      perps: [],
      dlmm: [],
      totalExposureUsd: 0,
      openRiskUsd: 0,
    },
    approvals: [],
    activity,
    inflight,
    strategies: [],
    signals: {
      windowMs: 0,
      feedLabel: "UNAVAILABLE",
      connected: false,
      tape: [],
      tokens: [],
    },
  };
}
