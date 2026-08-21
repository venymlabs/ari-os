/**
 * The simulated source. Implements `DashboardSource` entirely in the browser so
 * the whole UI — including the decision path and the kill switch — is live and
 * exercisable before `src/perps/` and `src/pools/` exist.
 *
 * It is deliberately opinionated about behaviour the real kernel guarantees:
 *   · engaging the kill switch re-fails the KILL_SWITCH guard on every pending
 *     intent, immediately and visibly — approval becomes impossible, not just
 *     discouraged;
 *   · a blockhash that runs out is TERMINAL. The intent is not re-signed; the
 *     agent has to propose a brand-new one with a new id and idempotency key.
 */

import { mulberry32 } from '../lib/format';
import {
  BASE_BLOCK_HEIGHT,
  BASE_SLOT,
  DLMM,
  MIN,
  PERPS,
  TOKEN_SIGNALS,
  WALLET,
  makeActivity,
  makeApprovals,
  makeCaps,
  makeInflight,
  makeStrategies,
  makeSystem,
  makeTape,
  makeTapeRow,
} from './fixtures';
import type {
  ActivityEntry,
  ApprovalDecision,
  CapLedger,
  DashboardSnapshot,
  DashboardSource,
  DecisionResult,
  GuardCheck,
  InflightTrade,
  PendingApproval,
  StrategyStatus,
  StrategyView,
  SystemState,
  TapeRow,
} from './types';

const TAPE_MAX = 60;
const ACTIVITY_MAX = 90;

function reapplyPolicy(a: PendingApproval, sys: SystemState): PendingApproval {
  const guards: GuardCheck[] = a.guards.map((guard) => {
    if (guard.code === 'EXECUTION_DISABLED') {
      return sys.executionEnabled
        ? { ...guard, status: 'pass', detail: 'policy.executionEnabled = true' }
        : {
            ...guard,
            status: 'fail',
            detail: 'the kernel is in dry-run. Nothing signs until execution is armed.',
            observed: 'executionEnabled = false',
            limit: 'true',
          };
    }
    if (guard.code === 'KILL_SWITCH') {
      return sys.killSwitch
        ? {
            ...guard,
            status: 'fail',
            detail: 'hard stop engaged — every value-moving action is refused at the chokepoint.',
            observed: 'killSwitch = true',
            limit: 'false',
          }
        : { ...guard, status: 'pass', detail: 'policy.killSwitch = false' };
    }
    return guard;
  });
  const blocked = guards.some((x) => x.status === 'fail');
  return { ...a, guards, verdict: blocked ? 'blocked' : 'clear' };
}

let seq = 0;
const nextId = (p: string): string => {
  seq += 1;
  return `${p}-${seq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
};

export function createFixtureSource(): DashboardSource {
  const now0 = Date.now();
  const rand = mulberry32(0xa17e);

  let blockHeight = BASE_BLOCK_HEIGHT;
  let slot = BASE_SLOT;
  let system = makeSystem(now0, blockHeight, slot);
  let caps: readonly CapLedger[] = makeCaps(now0);
  let approvals: readonly PendingApproval[] = makeApprovals(now0, blockHeight, slot).map((a) =>
    reapplyPolicy(a, system),
  );
  let activity: readonly ActivityEntry[] = makeActivity(now0);
  let inflight: readonly InflightTrade[] = makeInflight(now0);
  let strategies: readonly StrategyView[] = makeStrategies(now0);
  let tape: readonly TapeRow[] = makeTape(now0, 34);

  /** Templates keyed by their original id, so an expired intent can be re-proposed fresh. */
  const templates = new Map(makeApprovals(now0, blockHeight, slot).map((a) => [a.id, a]));
  const pendingReproposals: { at: number; templateId: string }[] = [];

  const listeners = new Set<(s: DashboardSnapshot) => void>();

  function log(entry: Omit<ActivityEntry, 'id' | 'at'> & { at?: number }): void {
    activity = [
      { id: nextId('act'), at: entry.at ?? Date.now(), ...entry, fields: entry.fields ?? [] },
      ...activity,
    ].slice(0, ACTIVITY_MAX);
  }

  function snapshot(): DashboardSnapshot {
    const totalExposureUsd =
      WALLET.totalUsd +
      PERPS.reduce((n, p) => n + p.sizeUsd, 0) +
      DLMM.reduce((n, d) => n + d.liquidityUsd, 0);
    const openRiskUsd =
      PERPS.reduce((n, p) => n + p.marginUsd, 0) + DLMM.reduce((n, d) => n + d.liquidityUsd, 0);

    return {
      generatedAt: Date.now(),
      system,
      wallet: WALLET,
      caps,
      positions: {
        spot: WALLET.holdings,
        perps: PERPS,
        dlmm: DLMM,
        totalExposureUsd,
        openRiskUsd,
      },
      approvals,
      activity,
      inflight,
      strategies,
      signals: {
        windowMs: 5 * MIN,
        feedLabel: 'pumpportal · ws',
        connected: true,
        tape,
        tokens: TOKEN_SIGNALS,
      },
    };
  }

  function emit(): void {
    const s = snapshot();
    for (const l of listeners) l(s);
  }

  // ── clock: chain height, heartbeat, expiry, re-proposals ─────────────────
  const chainTimer = setInterval(() => {
    const now = Date.now();
    blockHeight += 2;
    slot += 5;

    const sweep = now - system.reconciler.lastSweepAt > 12_000;
    system = {
      ...system,
      lastHeartbeatAt: now,
      reconciler: {
        ...system.reconciler,
        blockHeight,
        slot,
        pending: inflight.length,
        lastSweepAt: sweep ? now : system.reconciler.lastSweepAt,
      },
    };

    if (sweep) {
      log({
        kind: 'reconciler.sweep',
        level: 'info',
        tradeId: null,
        text: `sweep · ${inflight.length} in flight · store consistent`,
        signature: null,
        fields: [['height', blockHeight.toLocaleString('en-US')]],
      });
    }

    // an expired blockhash is terminal — never re-signed
    const dead = approvals.filter((a) => a.expiry.expiresAt <= now);
    if (dead.length > 0) {
      approvals = approvals.filter((a) => a.expiry.expiresAt > now);
      for (const a of dead) {
        log({
          kind: 'trade.failed',
          level: 'warn',
          tradeId: a.tradeId,
          text: `CONFIRM_TIMEOUT — blockhash expired at height ${a.expiry.lastValidBlockHeight.toLocaleString('en-US')} while awaiting approval. Terminal: the kernel will not re-sign this intent.`,
          signature: null,
          fields: [['guard', 'CONFIRM_TIMEOUT']],
        });
        const templateId = a.id.split('#')[0] ?? a.id;
        pendingReproposals.push({ at: now + 9_000 + Math.floor(rand() * 6_000), templateId });
      }
    }

    // the agent re-proposes as a brand-new intent (new id, new key, new blockhash)
    for (let i = pendingReproposals.length - 1; i >= 0; i -= 1) {
      const job = pendingReproposals[i];
      if (!job || job.at > now) continue;
      pendingReproposals.splice(i, 1);
      const tpl = templates.get(job.templateId);
      if (!tpl) continue;
      const fresh: PendingApproval = reapplyPolicy(
        {
          ...tpl,
          id: `${job.templateId}#${nextId('r')}`,
          tradeId: `trd_${nextId('x').toUpperCase().replace(/-/g, '')}`.slice(0, 20),
          idempotencyKey: `idm_${nextId('k').replace(/-/g, '')}`.slice(0, 22),
          receivedAt: now,
          expiry: {
            lastValidBlockHeight: blockHeight + 150,
            currentBlockHeight: blockHeight,
            expiresAt: now + 150_000 + Math.floor(rand() * 110_000),
          },
        },
        system,
      );
      approvals = [fresh, ...approvals];
      log({
        kind: 'intent.received',
        level: 'info',
        tradeId: fresh.tradeId,
        text: `${fresh.source} re-proposed: ${fresh.intent.summary}`,
        signature: null,
        fields: [['source', fresh.source], ['blockhash', 'fresh']],
      });
    }

    system = {
      ...system,
      agentPhase: system.killSwitch
        ? 'halted'
        : approvals.length > 0
          ? 'awaiting_approval'
          : inflight.length > 0
            ? 'executing'
            : 'observing',
    };

    emit();
  }, 1_000);

  // ── the tape ─────────────────────────────────────────────────────────────
  const tapeTimer = setInterval(() => {
    const n = 1 + (rand() > 0.72 ? 1 : 0);
    const fresh: TapeRow[] = [];
    for (let i = 0; i < n; i += 1) fresh.push(makeTapeRow(Date.now() - i * 40, rand, nextId('tp')));
    tape = [...fresh, ...tape].slice(0, TAPE_MAX);
    emit();
  }, 1_150);

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      clearInterval(chainTimer);
      clearInterval(tapeTimer);
    });
  }

  return {
    id: 'fixture',
    label: 'simulated',
    simulated: true,

    async getSnapshot() {
      return snapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },

    async decide(approvalId: string, decision: ApprovalDecision): Promise<DecisionResult> {
      const target = approvals.find((a) => a.id === approvalId);
      if (!target) return { ok: false, tradeId: approvalId, message: 'intent is no longer pending' };

      if (decision === 'approve' && target.verdict === 'blocked') {
        return {
          ok: false,
          tradeId: target.tradeId,
          message: 'refused at the chokepoint — a guard failed; approval cannot override it',
        };
      }

      approvals = approvals.filter((a) => a.id !== approvalId);
      const now = Date.now();

      if (decision === 'reject') {
        log({
          kind: 'guard.rejected',
          level: 'fail',
          tradeId: target.tradeId,
          text: `rejected by operator — ${target.intent.summary}`,
          signature: null,
          fields: [['operator', 'local'], ['digest', target.intent.unsignedTxDigest.slice(0, 12)]],
        });
        emit();
        return { ok: true, tradeId: target.tradeId, message: `${target.tradeId} rejected` };
      }

      const cap = target.capChecks[0];
      log({
        kind: 'trade.reserved',
        level: 'info',
        tradeId: target.tradeId,
        text: `reserved ${target.intent.input.symbol} against every rolling window`,
        signature: null,
        fields: cap ? [['bucket', cap.bucket]] : [],
      });
      log({
        kind: 'trade.signed',
        level: 'info',
        tradeId: target.tradeId,
        text: 'operator proof bound to this exact transaction · one-time signing envelope consumed',
        signature: null,
        fields: [['digest', target.intent.unsignedTxDigest.slice(0, 12)], ['bytes', String(target.intent.unsignedTxBytes)]],
      });
      log({
        kind: 'trade.sent',
        level: 'info',
        tradeId: target.tradeId,
        text: `broadcast accepted — ${target.intent.summary}`,
        signature: nextId('sig'),
        fields: [['land', target.intent.landMode]],
      });

      inflight = [
        {
          id: target.tradeId,
          state: 'sent',
          signature: nextId('sig'),
          summary: target.intent.summary,
          since: now,
          blockHeadroom: target.expiry.lastValidBlockHeight - blockHeight,
        },
        ...inflight,
      ];

      // settle it a beat later so the Activity view actually moves
      setTimeout(() => {
        inflight = inflight.filter((t) => t.id !== target.tradeId);
        log({
          kind: 'trade.confirmed',
          level: 'pass',
          tradeId: target.tradeId,
          text: `confirmed · ${target.intent.summary} filled above the committed floor`,
          signature: nextId('sig'),
          fields: [['slot', (slot + 12).toLocaleString('en-US')], ['slippage', '41 bps']],
        });
        // burn the spend against the rolling windows
        caps = caps.map((ledger) =>
          ledger.bucket !== target.capChecks[0]?.bucket
            ? ledger
            : {
                ...ledger,
                meters: ledger.meters.map((m) => {
                  const chk = target.capChecks.find((c) => c.window === m.window);
                  return chk && m.window !== 'perTrade' ? { ...m, used: chk.would } : m;
                }),
              },
        );
        emit();
      }, 4_200);

      emit();
      return { ok: true, tradeId: target.tradeId, message: `${target.tradeId} signed and broadcast` };
    },

    async setKillSwitch(engaged: boolean) {
      system = { ...system, killSwitch: engaged, agentPhase: engaged ? 'halted' : 'observing' };
      approvals = approvals.map((a) => reapplyPolicy(a, system));
      log({
        kind: engaged ? 'guard.rejected' : 'intent.received',
        level: engaged ? 'fail' : 'pass',
        tradeId: null,
        text: engaged
          ? 'KILL_SWITCH engaged — every value-moving action is now refused at the chokepoint'
          : 'kill switch released — the chokepoint accepts intents again',
        signature: null,
        fields: [['operator', 'local']],
      });
      emit();
    },

    async setExecutionEnabled(enabled: boolean) {
      system = { ...system, executionEnabled: enabled };
      approvals = approvals.map((a) => reapplyPolicy(a, system));
      log({
        kind: enabled ? 'intent.received' : 'trade.dryrun',
        level: enabled ? 'pass' : 'warn',
        tradeId: null,
        text: enabled
          ? 'execution armed — the kernel will sign approved intents'
          : 'execution disarmed — dry-run only, nothing will be signed',
        signature: null,
        fields: [['operator', 'local']],
      });
      emit();
    },

    async setStrategyStatus(strategyId: string, status: StrategyStatus) {
      strategies = strategies.map((s) =>
        s.id === strategyId
          ? { ...s, status, nextRunAt: status === 'active' ? Date.now() + 60_000 : null }
          : s,
      );
      emit();
    },
  };
}
