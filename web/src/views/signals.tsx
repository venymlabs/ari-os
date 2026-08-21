import type { DashboardSnapshot, TokenSignalView } from '../data/types';
import { clockUtc, fmtNum, shortAddr } from '../lib/format';
import { Chip, Panel, ViewHead } from '../components/primitives';
import { useNow } from '../state/store';

const MOUNTED_AT = Date.now();

function heatClass(score: number): string {
  if (score < 25) return 'cool';
  if (score < 60) return 'warm';
  return 'hot';
}

function TokenCard({ t }: { readonly t: TokenSignalView }) {
  const cls = heatClass(t.rugHeat.score);
  const buyPct = Math.max(0, Math.min(100, t.volumeWeightedBuyPressurePct));

  return (
    <article className="panel">
      <div className="panel-head">
        <span className="mono">
          {t.symbol} <span className="dimmer">· {t.name}</span>
        </span>
        {t.watched ? <Chip tone="ok">watchlist</Chip> : <Chip tone="warn">unpinned</Chip>}
      </div>

      <div className="panel-body">
        <div className={`heat ${cls}`}>
          <span className="heat-score">{String(t.rugHeat.score).padStart(2, '0')}</span>
          <div>
            <div className="mono-xs dimmer" style={{ marginBottom: 7 }}>
              rug heat · 0 normal → 100 multiple tells
            </div>
            <div className="heat-dial">
              <i style={{ width: `${t.rugHeat.score}%` }} />
            </div>
            <ul className="reasons">
              {t.rugHeat.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>

        <hr className="rule" style={{ margin: '14px 0' }} />

        <div
          className="mono-xs dimmer"
          style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}
        >
          <span className="acid">buy {fmtNum(buyPct, 1)}%</span>
          <span>volume-weighted pressure</span>
          <span className="hazard">sell {fmtNum(100 - buyPct, 1)}%</span>
        </div>
        <div className="pressure">
          <i style={{ width: `${buyPct}%` }} />
          <u />
        </div>

        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>trades</dt>
          <dd>
            {t.trades.toLocaleString('en-US')}{' '}
            <span className="dimmer">
              ({t.buys.toLocaleString('en-US')} buy / {t.sells.toLocaleString('en-US')} sell)
            </span>
          </dd>
          <dt>net flow</dt>
          <dd className={t.netSolFlow >= 0 ? 'acid' : 'hazard'}>
            {t.netSolFlow >= 0 ? '+' : '−'}
            {fmtNum(Math.abs(t.netSolFlow), 2)} SOL
          </dd>
          <dt>volume</dt>
          <dd>{fmtNum(t.volumeSol, 1)} SOL</dd>
          <dt>uniques</dt>
          <dd>
            {t.uniqueBuyers} buyers / {t.uniqueSellers} sellers
          </dd>
          <dt>largest</dt>
          <dd>{fmtNum(t.largestTradeSol, 2)} SOL</dd>
          <dt>price</dt>
          <dd className={t.priceChangePct === null ? 'dimmer' : t.priceChangePct >= 0 ? 'acid' : 'hazard'}>
            {t.priceChangePct === null
              ? 'no priced trades in window'
              : `${t.priceChangePct >= 0 ? '+' : '−'}${fmtNum(Math.abs(t.priceChangePct), 1)}%`}
          </dd>
          <dt>mint</dt>
          <dd>{shortAddr(t.mint, 6, 6)}</dd>
        </dl>
      </div>
    </article>
  );
}

export function SignalsView({ snap }: { readonly snap: DashboardSnapshot }) {
  useNow(1_000);
  const { signals } = snap;
  const maxSol = Math.max(1, ...signals.tape.map((r) => r.solAmount));

  return (
    <div className="view">
      <ViewHead
        idx="06"
        kicker="market microstructure"
        title={
          <>
            THE TAPE
            <br />
            <em>does not lie.</em>
          </>
        }
        sub="Raw fills as they print, and the heuristics folded out of them. This feeds the model — it never feeds the safety path. A high rug-heat number is a reason to look, not a reason the kernel refuses."
        aside={
          <>
            <span className={`pill mono ${signals.connected ? 'on' : 'off'}`}>
              <i />
              {signals.feedLabel}
            </span>
            <span className="mono-xs dimmer">
              window {Math.round(signals.windowMs / 60_000)}m · {signals.tape.length} prints buffered
            </span>
          </>
        }
      />

      <div className="grid g-1-2">
        <Panel title="trade tape" meta="live · newest first" flush>
          <div className="tape">
            {signals.tape.map((r) => (
              <div
                key={r.id}
                className={`tape-row ${r.isBuy ? 'buy' : 'sell'}${r.ts > MOUNTED_AT + 500 ? ' fresh' : ''}`}
              >
                <span>{clockUtc(r.ts)}</span>
                <span className="tp-sym">{r.symbol}</span>
                <span
                  className="tp-bar"
                  style={{ width: `${Math.max(2, (r.solAmount / maxSol) * 100)}%` }}
                />
                <span className="tp-sol">
                  {r.isBuy ? '+' : '−'}
                  {fmtNum(r.solAmount, 3)}
                </span>
                <span className="tp-trader">{r.trader}</span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="grid g2" style={{ alignContent: 'start' }}>
          {signals.tokens.map((t) => (
            <TokenCard key={t.mint} t={t} />
          ))}
        </div>
      </div>

      <div className="marquee">
        <div className="ticker">
          <span>
            SIZE-WEIGHTED PRESSURE — UNIQUE BUYER CONCENTRATION — DEPLOYER FLOW — THIN VOLUME —
            ONE-SIDED DUMPS — NOT FINANCIAL ADVICE — SIGNALS FEED THE MODEL, NEVER THE GUARDS —
          </span>
          <span>
            SIZE-WEIGHTED PRESSURE — UNIQUE BUYER CONCENTRATION — DEPLOYER FLOW — THIN VOLUME —
            ONE-SIDED DUMPS — NOT FINANCIAL ADVICE — SIGNALS FEED THE MODEL, NEVER THE GUARDS —
          </span>
        </div>
      </div>
    </div>
  );
}
