import { useState } from 'react';
import type { ActivityEntry, DashboardSnapshot } from '../data/types';
import { ago, clockUtc, dateUtc, duration } from '../lib/format';
import { Empty, Panel, ViewHead } from '../components/primitives';
import { useNow } from '../state/store';

const FILTERS = [
  { id: 'all', label: 'all events' },
  { id: 'guards', label: 'guards' },
  { id: 'trades', label: 'trade lifecycle' },
  { id: 'reconciler', label: 'reconciler' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

function matches(e: ActivityEntry, f: FilterId): boolean {
  if (f === 'all') return true;
  if (f === 'guards') return e.kind === 'guard.rejected' || e.kind === 'trade.failed';
  if (f === 'reconciler') return e.kind === 'reconciler.sweep';
  return e.kind.startsWith('trade.') || e.kind === 'intent.received';
}

export function ActivityView({ snap }: { readonly snap: DashboardSnapshot }) {
  const now = useNow(1_000);
  const [filter, setFilter] = useState<FilterId>('all');
  const rows = snap.activity.filter((e) => matches(e, filter));
  const failures = snap.activity.filter((e) => e.level === 'fail').length;

  return (
    <div className="view">
      <ViewHead
        idx="04"
        kicker="journal"
        title={
          <>
            EVERY
            <br />
            <em>transition.</em>
          </>
        }
        sub="An append-only record of intents, refusals, signatures, broadcasts and settlements. Caps and exposure are folded out of this, not stored beside it."
        aside={
          <>
            <span className="mono">
              {snap.activity.length} events · {failures} refused
            </span>
            <span className="mono-xs dimmer">{dateUtc(now)} · utc</span>
          </>
        }
      />

      <div className="grid g-2-1">
        <Panel
          title="event journal"
          meta={
            <span style={{ display: 'flex', gap: 12 }}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  style={{
                    background: 'none',
                    border: 0,
                    padding: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                    letterSpacing: 'inherit',
                    textTransform: 'uppercase',
                    color: filter === f.id ? 'var(--acid)' : 'var(--bone-4)',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </span>
          }
          flush
        >
          <div className="journal">
            {rows.length === 0 ? (
              <Empty>no events match this filter</Empty>
            ) : (
              rows.map((e) => (
                <div className={`j-row ${e.level}`} key={e.id}>
                  <span className="j-ts" title={new Date(e.at).toISOString()}>
                    {clockUtc(e.at)}
                  </span>
                  <span className="j-kind">{e.kind}</span>
                  <span className="j-text">{e.text}</span>
                  {e.fields.length > 0 || e.tradeId || e.signature ? (
                    <span className="j-fields">
                      {e.tradeId ? <span>trade {e.tradeId}</span> : null}
                      {e.signature ? <span>sig {e.signature.slice(0, 16)}…</span> : null}
                      {e.fields.map(([k, v]) => (
                        <span key={`${e.id}-${k}`}>
                          {k} {v}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Panel>

        <div className="stack">
          <Panel title="reconciler" meta="single writer of trade state">
            <dl className="kv">
              <dt>status</dt>
              <dd className={snap.system.reconciler.running ? 'acid' : 'hazard'}>
                {snap.system.reconciler.running ? 'running' : 'stopped'}
              </dd>
              <dt>last sweep</dt>
              <dd>{ago(snap.system.reconciler.lastSweepAt, now)}</dd>
              <dt>in flight</dt>
              <dd>{snap.system.reconciler.pending}</dd>
              <dt>block</dt>
              <dd>{snap.system.reconciler.blockHeight.toLocaleString('en-US')}</dd>
              <dt>slot</dt>
              <dd>{snap.system.reconciler.slot.toLocaleString('en-US')}</dd>
            </dl>
            <p className="mono-xs dimmer" style={{ marginTop: 12, lineHeight: 1.7 }}>
              The signed transaction is persisted before broadcast. A crash, a lost response, or a
              double-tap resumes from that record — never from a hopeful retry.
            </p>
          </Panel>

          <Panel title="in flight" meta={`${snap.inflight.length} open`}>
            {snap.inflight.length === 0 ? (
              <Empty>nothing in flight</Empty>
            ) : (
              snap.inflight.map((t) => (
                <div className="inflight-row" key={t.id}>
                  <div>
                    <div style={{ fontSize: 13, letterSpacing: '-0.03em' }}>{t.summary}</div>
                    <div className="mono-xs dimmer" style={{ marginTop: 4 }}>
                      {duration(now - t.since)} · {t.blockHeadroom} blocks headroom
                    </div>
                  </div>
                  <span className={`state-tag ${t.state}`}>{t.state}</span>
                </div>
              ))
            )}
          </Panel>

          <Panel title="lifecycle" meta="expired is terminal">
            <div className="smachine">
              <span className="node done">
                <i />
                reserved
              </span>
              <span className="arrow">→</span>
              <span className="node done">
                <i />
                sent
              </span>
              <span className="arrow">→</span>
              <span className="node now">
                <i />
                confirmed
              </span>
            </div>
            <p className="mono-xs dimmer" style={{ marginTop: 12, lineHeight: 1.7 }}>
              reserved → sent → confirmed | expired | errored, or reserved → rejected when a guard
              refuses before broadcast. The kernel never re-signs the same intent under a new
              blockhash — that is how you double-spend.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
