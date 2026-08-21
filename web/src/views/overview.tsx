import { source } from '../data/source';
import type { DashboardSnapshot } from '../data/types';
import { ago, duration, fmtSignedPct, fmtUnits, fmtUsd, until } from '../lib/format';
import { IconHazard } from '../lib/icons';
import { Empty, Meter, Panel, ViewHead } from '../components/primitives';
import { pushToast, useNow } from '../state/store';

const NODES = ['observe', 'propose', 'approve', 'reserve', 'sign', 'broadcast', 'confirm'] as const;

const PHASE_INDEX: Record<string, number> = {
  idle: 0,
  observing: 0,
  proposing: 1,
  awaiting_approval: 2,
  executing: 4,
  settling: 6,
  halted: -1,
};

export function OverviewView({ snap }: { readonly snap: DashboardSnapshot }) {
  const now = useNow(1_000);
  const { system, wallet, positions, caps, inflight, approvals } = snap;
  const halted = system.killSwitch;
  const blocked = approvals.filter((a) => a.verdict === 'blocked').length;
  const active = PHASE_INDEX[system.agentPhase] ?? 0;

  const setKill = (engaged: boolean): void => {
    void source
      .setKillSwitch(engaged)
      .then(() =>
        pushToast(!engaged, engaged ? 'KILL SWITCH ENGAGED — every intent is now refused' : 'kill switch released'),
      );
  };

  const setExec = (enabled: boolean): void => {
    void source
      .setExecutionEnabled(enabled)
      .then(() => pushToast(enabled, enabled ? 'execution armed' : 'execution disarmed — dry-run only'));
  };

  return (
    <div className="view">
      <ViewHead
        idx="01"
        kicker="system overview"
        title={
          <>
            AUTONOMY
            <br />
            WITHOUT <em>custody.</em>
          </>
        }
        sub="The agent runs on your machine and holds your keys. Everything below is what it is allowed to do next — and the exact width of the leash."
        aside={
          <>
            <span className="mono">
              up {duration(now - system.bootedAt)} · heartbeat {Math.max(0, Math.round((now - system.lastHeartbeatAt) / 1000))}s
            </span>
            <span className="mono-xs dimmer">{system.modelLabel}</span>
          </>
        }
      />

      <div className="figures">
        <article>
          <span className="fig-v">{fmtUsd(wallet.totalUsd, 0)}</span>
          <span className={`fig-note ${wallet.change24hPct >= 0 ? 'acid' : 'hazard'}`}>
            {fmtSignedPct(wallet.change24hPct)} / 24h
          </span>
          <span className="fig-k">
            wallet balance
            <br />
            spot, on-machine key
          </span>
        </article>
        <article>
          <span className="fig-v">{fmtUsd(positions.totalExposureUsd, 0)}</span>
          <span className="fig-note dim">
            spot + {positions.perps.length} perp · {positions.dlmm.length} pools
          </span>
          <span className="fig-k">
            total exposure
            <br />
            all venues
          </span>
        </article>
        <article>
          <span className="fig-v">{fmtUsd(positions.openRiskUsd, 0)}</span>
          <span className="fig-note dim">margin posted + pooled liquidity</span>
          <span className="fig-k">
            open risk
            <br />
            capital that can be lost
          </span>
        </article>
        <article>
          <span className="fig-v">
            {String(approvals.length).padStart(2, '0')}
            <small>pending</small>
          </span>
          <span className={`fig-note ${blocked > 0 ? 'hazard' : 'dim'}`}>
            {blocked > 0 ? `${blocked} refused by a guard` : 'none refused'}
          </span>
          <span className="fig-k">
            approval queue
            <br />
            waiting on a human
          </span>
        </article>
      </div>

      <div className="grid g-2-1" style={{ marginTop: 14 }}>
        <Panel title="system control" meta="policy · read at the metal">
          <div className="stack">
            <div>
              <div className="mono-xs dimmer" style={{ marginBottom: 8 }}>
                execution — master arm
              </div>
              <div className="control">
                <button
                  type="button"
                  className={!system.executionEnabled ? 'sel hold' : ''}
                  onClick={() => setExec(false)}
                >
                  <b>Dry-run</b>
                  <span>simulate only · nothing signs</span>
                </button>
                <button
                  type="button"
                  className={system.executionEnabled ? 'sel go' : ''}
                  onClick={() => setExec(true)}
                >
                  <b>Armed</b>
                  <span>approved intents will sign</span>
                </button>
              </div>
            </div>

            <div>
              <div className="mono-xs dimmer" style={{ marginBottom: 8 }}>
                kill switch — hard stop
              </div>
              <div className="control">
                <button type="button" className={!halted ? 'sel go' : ''} onClick={() => setKill(false)}>
                  <b>Released</b>
                  <span>intents may reach the gateway</span>
                </button>
                <button type="button" className={halted ? 'sel stop' : ''} onClick={() => setKill(true)}>
                  <b>Engaged</b>
                  <span>every value-moving action refused</span>
                </button>
              </div>
            </div>

            {halted ? (
              <div className="hazard-band mono">
                <span>
                  <IconHazard size={11} style={{ verticalAlign: '-1px', marginRight: 7 }} />
                  hard stop engaged
                </span>
                <span>{approvals.length} pending intents re-failed</span>
              </div>
            ) : (
              <p className="mono-xs dimmer" style={{ margin: 0, lineHeight: 1.7 }}>
                Both switches live in the kernel, not in a prompt. Engaging the hard stop re-fails
                the KILL_SWITCH guard on every pending intent immediately — approval becomes
                impossible, not merely discouraged.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="agent state" meta={system.agentPhase.replace('_', ' ')}>
          <div className="stack">
            <div className="smachine">
              {NODES.map((n, i) => (
                <span
                  key={n}
                  className={`node${halted ? ' stopped' : i === active ? ' now' : i < active ? ' done' : ''}`}
                >
                  <i />
                  {n}
                </span>
              ))}
            </div>

            <dl className="kv">
              <dt>phase</dt>
              <dd>{halted ? 'HALTED' : system.agentPhase.replace('_', ' ')}</dd>
              <dt>reconciler</dt>
              <dd>
                {system.reconciler.running ? 'running' : 'stopped'} · {system.reconciler.pending} in
                flight
              </dd>
              <dt>last sweep</dt>
              <dd>{ago(system.reconciler.lastSweepAt, now)}</dd>
              <dt>block</dt>
              <dd>{system.reconciler.blockHeight.toLocaleString('en-US')}</dd>
              <dt>slot</dt>
              <dd>{system.reconciler.slot.toLocaleString('en-US')}</dd>
              <dt>slippage clamp</dt>
              <dd>{system.maxSlippageBps} bps hard cap</dd>
              <dt>fee ceiling</dt>
              <dd>
                {fmtUnits(system.priorityFeeMaxLamports, 9, 6)} SOL / {system.priorityFeeMaxBps} bps
              </dd>
              <dt>token-2022</dt>
              <dd>{system.allowToken2022 ? 'allowed' : 'refused (not mis-accounted)'}</dd>
              <dt>mint policy</dt>
              <dd>
                {system.mintAllowlistSize === null
                  ? 'open allowlist'
                  : `${system.mintAllowlistSize} allowed`}{' '}
                · {system.mintDenylistSize} denied
              </dd>
            </dl>
          </div>
        </Panel>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        {caps.map((ledger) => (
          <Panel
            key={ledger.bucket}
            title={`spend caps · ${ledger.symbol}`}
            meta="denominated in what leaves the wallet"
          >
            {ledger.meters.map((m) => (
              <div className="caprow" key={m.window}>
                <span className="cr-k">{m.window}</span>
                <Meter used={m.used} cap={m.cap} />
                <span className="cr-n">
                  {fmtUnits(m.used, ledger.decimals, 3)} / {fmtUnits(m.cap, ledger.decimals, 3)}
                  {m.resetsAt ? (
                    <span className="dimmer"> · rolls {until(m.resetsAt, now)}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </Panel>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <Panel title="in flight" meta="the reconciler is the single writer of these states">
          {inflight.length === 0 ? (
            <Empty>nothing in flight</Empty>
          ) : (
            inflight.map((t) => (
              <div className="inflight-row" key={t.id}>
                <div>
                  <div style={{ fontSize: 13.5, letterSpacing: '-0.03em' }}>{t.summary}</div>
                  <div className="mono-xs dimmer" style={{ marginTop: 4 }}>
                    {t.id} · {t.signature ? `${t.signature.slice(0, 18)}…` : 'unsigned'} · opened{' '}
                    {ago(t.since, now)} · {t.blockHeadroom} blocks of headroom
                  </div>
                </div>
                <span className={`state-tag ${t.state}`}>{t.state}</span>
              </div>
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}
