import type { ReactNode } from 'react';
import type { DashboardSnapshot } from '../data/types';
import { source } from '../data/source';
import { clockUtc, shortAddr } from '../lib/format';
import { IconGauge, IconHazard, IconLayers, IconLoop, IconPulse, IconShield, IconWave } from '../lib/icons';
import { VIEWS, navigate } from '../state/router';
import type { ViewId } from '../state/router';
import { useNow, useToasts } from '../state/store';
import { IconCheck, IconCross } from '../lib/icons';

const ICONS: Record<ViewId, (p: { readonly size?: number }) => ReactNode> = {
  overview: IconGauge,
  positions: IconLayers,
  approvals: IconShield,
  activity: IconPulse,
  strategies: IconLoop,
  signals: IconWave,
};

const PHASE_LABEL: Record<string, string> = {
  idle: 'idle',
  observing: 'observing',
  proposing: 'proposing',
  awaiting_approval: 'awaiting approval',
  executing: 'executing',
  settling: 'settling',
  halted: 'halted',
};

export function Rail({ view, snap }: { readonly view: ViewId; readonly snap: DashboardSnapshot | null }) {
  const pending = snap?.approvals.length ?? 0;
  const blocked = snap?.approvals.some((a) => a.verdict === 'blocked') ?? false;

  return (
    <nav className="rail" aria-label="Console sections">
      {/* The mark is the ARI OS site's: A, an Instrument Serif italic acid R, I. */}
      <div className="rail-brand">
        <span className="wordmark">
          A<em>R</em>I
        </span>
        <span className="wordmark-sup">OS · CONTROL</span>
      </div>

      <div className="rail-nav">
        {VIEWS.map((v) => {
          const Icon = ICONS[v.id];
          const on = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              className={`rail-link${on ? ' on' : ''}`}
              onClick={() => navigate(v.id)}
              aria-current={on ? 'page' : undefined}
            >
              <span className="rl-idx">{v.idx}</span>
              <span className="rl-label">
                <Icon size={13} />
                {v.label}
              </span>
              {v.id === 'approvals' && pending > 0 ? (
                <span className={`rl-count${blocked ? ' warn' : ''}`}>{pending}</span>
              ) : (
                <span />
              )}
            </button>
          );
        })}
      </div>

      <div className="rail-thesis">
        <p>
          The model
          <br />
          proposes.
          <br />
          The kernel <em>disposes.</em>
        </p>
      </div>

      <div className="rail-foot">
        <span className="mono-xs">source · {source.label}</span>
        <span className="mono-xs">{snap?.system.network ?? '—'}</span>
        <span className="mono-xs">{snap?.system.rpcLabel ?? '—'}</span>
      </div>
    </nav>
  );
}

export function SystemStrip({
  snap,
  onIntro,
}: {
  readonly snap: DashboardSnapshot | null;
  readonly onIntro: () => void;
}) {
  const now = useNow(1_000);
  const sys = snap?.system;
  const halted = sys?.killSwitch ?? false;
  const pending = snap?.approvals.length ?? 0;

  return (
    <div className={`strip${halted ? ' halted' : ''}`}>
      <div className="sc">
        <span className="sc-k">execution</span>
        <span className="sc-v">
          {sys ? (
            <span className={`pill mono ${sys.executionEnabled && !halted ? 'on' : 'off'}`}>
              <i />
              {halted ? 'halted' : sys.executionEnabled ? 'armed' : 'dry-run'}
            </span>
          ) : (
            '—'
          )}
        </span>
      </div>

      <div className="sc">
        <span className="sc-k">kill switch</span>
        <span className="sc-v">{halted ? 'ENGAGED' : 'RELEASED'}</span>
      </div>

      <div className="sc">
        <span className="sc-k">agent</span>
        <span className="sc-v">{sys ? (PHASE_LABEL[sys.agentPhase] ?? sys.agentPhase).toUpperCase() : '—'}</span>
      </div>

      <div className="sc">
        <span className="sc-k">queue</span>
        <span className="sc-v">
          {pending} PENDING
        </span>
      </div>

      <div className="sc">
        <span className="sc-k">wallet</span>
        <span className="sc-v">{snap ? shortAddr(snap.wallet.address, 6, 6) : '—'}</span>
      </div>

      <div className="sc">
        <span className="sc-k">block</span>
        <span className="sc-v">{sys ? sys.reconciler.blockHeight.toLocaleString('en-US') : '—'}</span>
      </div>

      <div className="sc push">
        <span className="sc-k">utc</span>
        <span className="sc-v">{clockUtc(now)}</span>
      </div>

      <button type="button" className="sc-btn" onClick={onIntro}>
        <IconHazard size={12} />
        What is this?
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.ok ? 'ok' : 'no'}`}>
          <span className="t-mark">{t.ok ? <IconCheck size={12} /> : <IconCross size={12} />}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
