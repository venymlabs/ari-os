import { source } from '../data/source';
import type { DashboardSnapshot, StrategyView } from '../data/types';
import { ago, duration, fmtNum, fmtUnits, until } from '../lib/format';
import { IconHazard } from '../lib/icons';
import { Empty, Meter, Panel, ViewHead } from '../components/primitives';
import { pushToast, useNow } from '../state/store';

const KIND_LABEL: Record<StrategyView['kind'], string> = {
  dca: 'DCA',
  twap: 'TWAP',
  trailing_stop: 'Trailing stop',
  take_profit: 'Take profit',
};

function StatusPill({ status }: { readonly status: StrategyView['status'] }) {
  const tone = status === 'active' ? 'on' : status === 'errored' ? 'off' : 'idle';
  return (
    <span className={`pill mono ${tone}`}>
      <i />
      {status}
    </span>
  );
}

function Slices({ done, total }: { readonly done: number; readonly total: number }) {
  const cells = [];
  for (let i = 0; i < total; i += 1) {
    cells.push(<span key={i} className={i < done ? 'done' : i === done ? 'now' : ''} />);
  }
  return <div className="slices">{cells}</div>;
}

function StrategyCard({ s, now }: { readonly s: StrategyView; readonly now: number }) {
  const toggle = (): void => {
    const next = s.status === 'active' ? 'paused' : 'active';
    void source
      .setStrategyStatus(s.id, next)
      .then(() => pushToast(next === 'active', `${s.id} ${next}`));
  };

  return (
    <article className="strat">
      <div className="strat-top">
        <div>
          <div className="strat-kind">{KIND_LABEL[s.kind]}</div>
          <div className="strat-label">{s.label}</div>
        </div>
        <StatusPill status={s.status} />
      </div>

      <div className="strat-body">
        {s.progress ? (
          <div>
            <div
              className="mono-xs dimmer"
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <span>slices filled</span>
              <span>
                {s.progress.done} / {s.progress.total}
              </span>
            </div>
            <Slices done={s.progress.done} total={s.progress.total} />
          </div>
        ) : null}

        {s.trigger ? (
          <div>
            <div
              className="mono-xs dimmer"
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <span>{s.trigger.label}</span>
              <span>{fmtNum(s.trigger.distancePct, 2)}% away</span>
            </div>
            <div className="trigger">
              <div className="liqbar">
                <i style={{ width: `${Math.max(2, 100 - Math.min(100, s.trigger.distancePct * 4))}%` }} />
              </div>
              <span className="mono-xs">
                {fmtNum(s.trigger.current, 3)} <span className="dimmer">→</span>{' '}
                {fmtNum(s.trigger.target, 3)}
              </span>
            </div>
          </div>
        ) : null}

        {s.budget ? (
          <div>
            <div
              className="mono-xs dimmer"
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}
            >
              <span>budget spent</span>
              <span>
                {fmtUnits(s.budget.spent, s.budget.decimals, 2)} /{' '}
                {fmtUnits(s.budget.cap, s.budget.decimals, 2)} {s.budget.symbol}
              </span>
            </div>
            <Meter used={s.budget.spent} cap={s.budget.cap} />
          </div>
        ) : null}

        <dl className="kv">
          {s.params.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          <dt>runs</dt>
          <dd>
            {s.runs.toLocaleString('en-US')}
            {s.errors > 0 ? <span className="hazard"> · {s.errors} errored</span> : null}
          </dd>
          <dt>last run</dt>
          <dd>{s.lastRunAt ? ago(s.lastRunAt, now) : '—'}</dd>
          <dt>next run</dt>
          <dd className={s.nextRunAt ? 'acid' : 'dimmer'}>
            {s.nextRunAt ? `in ${until(s.nextRunAt, now)}` : 'not scheduled'}
          </dd>
          <dt>age</dt>
          <dd>{duration(now - s.createdAt)}</dd>
        </dl>

        {s.lastError ? (
          <div>
            <div className="hazard-band mono">
              <span>
                <IconHazard size={11} style={{ verticalAlign: '-1px', marginRight: 7 }} />
                last error
              </span>
            </div>
            <p className="mono-xs" style={{ margin: '9px 0 0', lineHeight: 1.7, color: 'var(--bone-3)' }}>
              {s.lastError}
            </p>
          </div>
        ) : null}
      </div>

      <div className="strat-foot">
        <span className="mono-xs dimmer">{s.id}</span>
        <button
          type="button"
          className="btn sm"
          onClick={toggle}
          disabled={s.status === 'done' || s.status === 'errored'}
        >
          {s.status === 'active' ? 'Pause runner' : 'Resume runner'}
        </button>
      </div>
    </article>
  );
}

export function StrategiesView({ snap }: { readonly snap: DashboardSnapshot }) {
  const now = useNow(1_000);
  const active = snap.strategies.filter((s) => s.status === 'active').length;
  const errored = snap.strategies.filter((s) => s.status === 'errored').length;

  return (
    <div className="view">
      <ViewHead
        idx="05"
        kicker="autonomous runners"
        title={
          <>
            SCHEDULES,
            <br />
            <em>not promises.</em>
          </>
        }
        sub="Runners survive restarts and emit intents like anything else. A slice that would breach a cap is refused at the same chokepoint a chat message would hit."
        aside={
          <>
            <span className="mono">
              {active} active · {snap.strategies.length - active} idle
            </span>
            <span className={`mono-xs ${errored > 0 ? 'hazard' : 'dimmer'}`}>
              {errored > 0 ? `${errored} halted on error` : 'no halted runners'}
            </span>
          </>
        }
      />

      {snap.strategies.length === 0 ? (
        <Empty>no strategy runners configured</Empty>
      ) : (
        <div className="grid g3">
          {snap.strategies.map((s) => (
            <StrategyCard key={s.id} s={s} now={now} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Panel title="runner contract" meta="the strategy layer has no privileges">
          <p className="mono-xs dimmer" style={{ margin: 0, lineHeight: 1.9 }}>
            A runner cannot sign. It builds the same TradeIntent a chat message would build, hands it
            to TradeGateway.execute(), and gets the same thirteen guards. Pausing a runner stops it
            proposing; it does not unwind anything it has already filled.
          </p>
        </Panel>
      </div>
    </div>
  );
}
