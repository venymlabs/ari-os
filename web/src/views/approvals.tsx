/**
 * APPROVALS — the boundary made visible.
 *
 * Left of the rule: what the model asked for, in its own words, on the blue of
 * the untrusted zone. Right of the rule: what the kernel actually re-read and
 * decided, in mono, with the numbers it checked against. Between them, the one
 * thing the model cannot cross.
 */

import { useState } from 'react';
import { source } from '../data/source';
import type { CapCheck, DashboardSnapshot, GuardCheck, PendingApproval } from '../data/types';
import { ago, bpsToPct, fmtNum, fmtUnits, lamportsToSol, until } from '../lib/format';
import { IconArrow, IconHazard, IconLock } from '../lib/icons';
import { BoundaryColumn, Chip, Empty, GuardMark, Meter, ViewHead } from '../components/primitives';
import { pushToast, useNow } from '../state/store';

function GuardRow({ g }: { readonly g: GuardCheck }) {
  return (
    <div className={`guard ${g.status}`}>
      <span className="g-mark">
        <GuardMark status={g.status} />
      </span>
      <span className="g-code">{g.code}</span>
      <span className="g-num">
        {g.observed ? (
          <>
            {g.observed}
            {g.limit ? <span className="dimmer"> / {g.limit}</span> : null}
          </>
        ) : (
          <span className="dimmer">{g.status === 'skipped' ? 'not reached' : 'ok'}</span>
        )}
      </span>
      <span className="g-detail">{g.detail}</span>
    </div>
  );
}

function CapRow({ c }: { readonly c: CapCheck }) {
  return (
    <div className={`capcheck${c.ok ? '' : ' bad'}`}>
      <span className="cc-k">{c.window}</span>
      <Meter used={c.used} cap={c.cap} would={c.would} />
      <span className="cc-n">
        {fmtUnits(c.would, c.decimals, 3)} / {fmtUnits(c.cap, c.decimals, 3)} {c.symbol}
      </span>
    </div>
  );
}

function ApprovalCard({
  a,
  now,
  focus,
  busy,
  onDecide,
}: {
  readonly a: PendingApproval;
  readonly now: number;
  readonly focus: boolean;
  readonly busy: boolean;
  readonly onDecide: (id: string, d: 'approve' | 'reject') => void;
}) {
  const blocked = a.verdict === 'blocked';
  const failing = a.guards.filter((g) => g.status === 'fail');
  const passing = a.guards.filter((g) => g.status === 'pass').length;
  const remaining = a.expiry.expiresAt - now;
  const span = Math.max(1, a.expiry.expiresAt - a.receivedAt);
  const left = Math.max(0, Math.min(1, remaining / span));
  const urgent = remaining < 30_000;
  const capBucket = a.capChecks[0]?.symbol ?? a.intent.input.symbol;

  return (
    <article className={`approval${focus ? ' focus' : ''}${blocked ? ' blocked' : ''}`}>
      <div className="appr-top">
        <div className="at-l">
          <span className="mono">{a.tradeId}</span>
          <span className="mono-xs dimmer">key {a.idempotencyKey}</span>
          <span className="mono-xs dimmer">via {a.source}</span>
        </div>
        <div className="at-r">
          <span className="mono-xs dimmer">received {ago(a.receivedAt, now)}</span>
          {blocked ? (
            <Chip tone="warn">
              refused · {failing.length} guard{failing.length === 1 ? '' : 's'} failed
            </Chip>
          ) : (
            <Chip tone="ok">clear · {passing} of {a.guards.length} guards pass</Chip>
          )}
        </div>
      </div>

      <div className="appr-stage">
        {/* ── the ask ─────────────────────────────────────────────────── */}
        <div className="zone-model">
          <div className="mz">
            <div className="mz-head">
              <span className="zone-label">untrusted / probabilistic</span>
              <span className="zone-label">{a.modelLabel}</span>
            </div>

            <p className="mz-kind">the model asks · {a.intent.kind.replace('_', ' ')}</p>

            <div className="mz-flow">
              <span className="mz-amt">
                {fmtUnits(a.intent.input.base, a.intent.input.decimals, 4)}
                <small>{a.intent.input.symbol}</small>
              </span>
              <span className="mz-arrow">
                <IconArrow size={20} />
              </span>
              <span className="mz-amt">
                {fmtUnits(a.intent.output.base, a.intent.output.decimals, 2)}
                <small>{a.intent.output.symbol}</small>
              </span>
            </div>

            <p className="mz-rationale">“{a.rationale}”</p>
            <p className="mz-attrib">model rationale — narration only, never a safety input</p>

            <div className="mz-chips">
              <Chip tone={a.intent.inputProvenance === 'untrusted' ? 'warn' : 'neutral'}>
                in · {a.intent.inputProvenance}
              </Chip>
              <Chip tone={a.intent.outputProvenance === 'untrusted' ? 'warn' : 'neutral'}>
                out · {a.intent.outputProvenance}
              </Chip>
              <Chip>{a.intent.landMode}</Chip>
              <Chip>{a.intent.routeLabel}</Chip>
            </div>

            <dl className="kv mz-kv">
              <dt>min out</dt>
              <dd>
                {fmtUnits(a.intent.minOut.base, a.intent.minOut.decimals, 2)} {a.intent.minOut.symbol}
              </dd>
              <dt>price impact</dt>
              <dd>{fmtNum(a.intent.priceImpactPct, 2)}%</dd>
              <dt>slippage</dt>
              <dd>{bpsToPct(a.intent.slippageBps)} ({a.intent.slippageBps} bps)</dd>
              <dt>priority fee</dt>
              <dd>{lamportsToSol(a.intent.priorityFeeLamports)} SOL</dd>
              <dt>quote slot</dt>
              <dd>
                {a.intent.quoteContextSlot === null
                  ? 'unpriced'
                  : a.intent.quoteContextSlot.toLocaleString('en-US')}
              </dd>
              {a.intent.landHandle === null ? null : (
                <>
                  <dt>land handle</dt>
                  <dd>{a.intent.landHandle}</dd>
                </>
              )}
              <dt>blockhash</dt>
              <dd>{a.intent.recentBlockhash}</dd>
            </dl>

            {a.intent.legs.length > 0 ? (
              <dl className="kv mz-kv">
                {a.intent.legs.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>

        <BoundaryColumn />

        {/* ── the verdict ─────────────────────────────────────────────── */}
        <div className="zone-host">
          <div className="hz">
            <div className="hz-head">
              <span className="zone-label">host / deterministic</span>
              <span className="zone-label">re-validated from scratch</span>
            </div>

            <div className="hz-block">
              <div className="hz-k">
                <span>guard ledger</span>
                <span>{passing} / {a.guards.length} pass</span>
              </div>
              {a.guards.map((g) => (
                <GuardRow key={g.code} g={g} />
              ))}
            </div>

            <div className="hz-block">
              <div className="hz-k">
                <span>input-leg spend caps · {capBucket}</span>
                <span>what leaves the wallet</span>
              </div>
              {a.capChecks.map((c) => (
                <CapRow key={c.window} c={c} />
              ))}
              <p className="mono-xs dimmer" style={{ marginTop: 10, lineHeight: 1.6 }}>
                {a.capChecks.length === 0
                  ? `The input leg is ${a.intent.input.symbol}, not a quote asset — this intent draws from no spend ledger. Caps bound what leaves the wallet in SOL or USDC; a sell spends neither.`
                  : 'Caps are denominated in the input leg, so no price oracle sits in the safety path. The white marker is where this intent would land.'}
              </p>
            </div>

            <div className="hz-block">
              <div className="hz-k">
                <span>simulation</span>
                <span>
                  {a.simulation.ok
                    ? `${a.simulation.unitsConsumed?.toLocaleString('en-US') ?? '—'} CU · slot ${a.simulation.atSlot?.toLocaleString('en-US') ?? '—'}`
                    : a.simulation.atSlot === null
                      ? 'not reached'
                      : `failed at slot ${a.simulation.atSlot.toLocaleString('en-US')}`}
                </span>
              </div>
              {a.simulation.err ? (
                <p
                  className="mono-xs"
                  style={{ margin: '9px 0 0', lineHeight: 1.7, color: 'var(--hazard)' }}
                >
                  {a.simulation.err}
                </p>
              ) : null}
              <div className="simlog">
                {a.simulation.logs.map((line, i) => (
                  <div key={`${a.id}-log-${i}`}>
                    {line.startsWith('Program log: swap succeeded') ? <b>{line}</b> : line}
                  </div>
                ))}
              </div>
              {a.intent.quoteContextSlot !== null && a.simulation.atSlot !== null ? (
                <p className="mono-xs dimmer" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  quote priced at slot {a.intent.quoteContextSlot.toLocaleString('en-US')} ·
                  simulated {(a.simulation.atSlot - a.intent.quoteContextSlot).toLocaleString('en-US')}{' '}
                  slots later. A wide gap is a stale route, not a failed guard — the kernel will not
                  refuse it for you.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {blocked ? (
        <div className="hazard-band mono">
          <span>
            <IconHazard size={11} style={{ verticalAlign: '-1px', marginRight: 7 }} />
            refused at the chokepoint
          </span>
          <span>{failing.map((f) => f.code).join('  ·  ')}</span>
          <span>approval cannot override a failed guard</span>
        </div>
      ) : null}

      <div className="appr-foot">
        <div>
          <p className="bind">
            <IconLock size={11} style={{ verticalAlign: '-1px', marginRight: 7 }} />
            approval binds one operator to one exact transaction — digest{' '}
            <b>{a.intent.unsignedTxDigest.slice(0, 16)}</b> · {a.intent.unsignedTxBytes} bytes
          </p>
          <div className={`expiry${urgent ? ' urgent' : ''}`}>
            <i style={{ width: `${left * 100}%` }} />
          </div>
          <p className="bind">
            blockhash expires in <b>{until(a.expiry.expiresAt, now)}</b> at height{' '}
            <b>{a.expiry.lastValidBlockHeight.toLocaleString('en-US')}</b> · expiry is terminal, the
            kernel will not re-sign
          </p>
        </div>

        <div className="appr-actions">
          <button
            type="button"
            className="btn reject"
            disabled={busy}
            onClick={() => onDecide(a.id, 'reject')}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn approve"
            disabled={blocked || busy}
            onClick={() => onDecide(a.id, 'approve')}
          >
            {blocked ? 'Approval blocked' : 'Approve & sign'}
          </button>
        </div>
      </div>
    </article>
  );
}

export function ApprovalsView({ snap }: { readonly snap: DashboardSnapshot }) {
  const now = useNow(1_000);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = (id: string, d: 'approve' | 'reject'): void => {
    setBusy(id);
    void source
      .decide(id, d)
      .then((r) => pushToast(r.ok, r.message))
      .catch((e: unknown) => pushToast(false, e instanceof Error ? e.message : 'decision failed'))
      .finally(() => setBusy(null));
  };

  const blocked = snap.approvals.filter((a) => a.verdict === 'blocked').length;

  return (
    <div className="view">
      <ViewHead
        idx="03"
        kicker="pending intents"
        title={
          <>
            A HUMAN
            <br />
            <em>decides.</em>
          </>
        }
        sub="The agent can ask. It cannot execute. Every intent below has already been decoded, re-validated against policy read from the kernel, and simulated as exact bytes. What is left is the one thing a machine is not allowed to do on your behalf."
        aside={
          <>
            <span className="mono">
              {snap.approvals.length} pending · {blocked} refused
            </span>
            <span className="mono-xs dimmer">chokepoint · TradeGateway.execute()</span>
          </>
        }
      />

      <div className="appr-lede">
        <h2>
          One intent. <em>Thirteen trials.</em>
        </h2>
        <span className="mono-xs dimmer" style={{ maxWidth: 380, lineHeight: 1.7, textAlign: 'right' }}>
          nothing on the right-hand side of the rule is sourced from model output. Policy is re-read
          at the metal, inside the gateway, on every single call.
        </span>
      </div>

      {snap.approvals.length === 0 ? (
        <Empty>queue empty — the agent is observing</Empty>
      ) : (
        snap.approvals.map((a, i) => (
          <ApprovalCard
            key={a.id}
            a={a}
            now={now}
            focus={i === 0}
            busy={busy === a.id}
            onDecide={decide}
          />
        ))
      )}
    </div>
  );
}
