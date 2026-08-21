import type { ReactNode } from 'react';
import type { DashboardSnapshot, DlmmPosition, Holding, PerpPosition } from '../data/types';
import { duration, fmtNum, fmtSignedPct, fmtSignedUsd, fmtUnits, fmtUsd } from '../lib/format';
import { IconHazard } from '../lib/icons';
import { Chip, Empty, Panel, ViewHead } from '../components/primitives';
import { useNow } from '../state/store';

function SpotTable({ rows }: { readonly rows: readonly Holding[] }) {
  return (
    <div className="tablewrap">
      <table className="ledger">
        <thead>
          <tr>
            <th>asset</th>
            <th>provenance</th>
            <th className="r">balance</th>
            <th className="r">value</th>
            <th className="r">cost basis</th>
            <th className="r">unrealised</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.amount.mint}>
              <td>
                <span className="sym">{h.amount.symbol}</span>
                <div className="mono-xs dimmer" style={{ marginTop: 3 }}>
                  {h.amount.mint.slice(0, 6)}…{h.amount.mint.slice(-4)}
                  {h.token2022 ? ' · token-2022' : ''}
                </div>
              </td>
              <td>
                <Chip tone={h.provenance === 'untrusted' ? 'warn' : h.provenance === 'user' ? 'ok' : 'neutral'}>
                  {h.provenance}
                </Chip>
              </td>
              <td className="n r">{fmtUnits(h.amount.base, h.amount.decimals, 4)}</td>
              <td className="n r">{fmtUsd(h.usd)}</td>
              <td className="n r dim">{h.costUsd === null ? '—' : fmtUsd(h.costUsd)}</td>
              <td className={`n r ${h.pnlPct === null ? 'dim' : h.pnlPct >= 0 ? 'acid' : 'hazard'}`}>
                {h.pnlPct === null ? '—' : fmtSignedPct(h.pnlPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerpTable({ rows, now }: { readonly rows: readonly PerpPosition[]; readonly now: number }) {
  return (
    <div className="tablewrap">
      <table className="ledger">
        <thead>
          <tr>
            <th>market</th>
            <th>side</th>
            <th className="r">size</th>
            <th className="r">lev</th>
            <th className="r">entry → mark</th>
            <th className="r">unrealised</th>
            <th className="r">liquidation</th>
            <th>distance</th>
            <th className="r">funding 1h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const warn = p.liquidationDistancePct < 12;
            const fill = Math.min(1, p.liquidationDistancePct / 50);
            return (
              <tr key={p.id}>
                <td>
                  <span className="sym">{p.market}</span>
                  <div className="mono-xs dimmer" style={{ marginTop: 3 }}>
                    {p.venue} · open {duration(now - p.openedAt)}
                  </div>
                </td>
                <td>
                  <span className={`side-tag ${p.side}`}>{p.side}</span>
                </td>
                <td className="n r">{fmtUsd(p.sizeUsd, 0)}</td>
                <td className="n r">{fmtNum(p.leverage, 2)}×</td>
                <td className="n r">
                  {fmtNum(p.entryPrice, p.entryPrice < 10 ? 4 : 2)}
                  <span className="dimmer"> → </span>
                  {fmtNum(p.markPrice, p.markPrice < 10 ? 4 : 2)}
                </td>
                <td className={`n r ${p.unrealizedUsd >= 0 ? 'acid' : 'hazard'}`}>
                  {fmtSignedUsd(p.unrealizedUsd)}
                </td>
                <td className="n r">{fmtNum(p.liquidationPrice, p.liquidationPrice < 10 ? 4 : 2)}</td>
                <td>
                  <div className={`liqbar${warn ? ' warn' : ''}`}>
                    <i style={{ width: `${fill * 100}%` }} />
                  </div>
                  <div className={`mono-xs ${warn ? 'hazard' : 'dimmer'}`} style={{ marginTop: 4 }}>
                    {fmtNum(p.liquidationDistancePct, 2)}% away
                  </div>
                </td>
                <td className={`n r ${p.fundingRateBps1h <= 0 ? 'acid' : 'dim'}`}>
                  {p.fundingRateBps1h >= 0 ? '+' : '−'}
                  {fmtNum(Math.abs(p.fundingRateBps1h), 2)} bps
                  <div className="mono-xs dimmer" style={{ marginTop: 3 }}>
                    paid {fmtSignedUsd(p.fundingPaidUsd)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Bins({ p }: { readonly p: DlmmPosition }) {
  const lo = Math.min(p.lowerBinId, p.activeBinId) - 3;
  const hi = Math.max(p.upperBinId, p.activeBinId) + 3;
  const mid = (p.lowerBinId + p.upperBinId) / 2;
  const half = Math.max(1, (p.upperBinId - p.lowerBinId) / 2);
  const cells: ReactNode[] = [];

  for (let id = lo; id <= hi; id += 1) {
    const inside = id >= p.lowerBinId && id <= p.upperBinId;
    const isActive = id === p.activeBinId;
    const t = Math.abs(id - mid) / half;
    const h = inside ? 26 + 74 * Math.max(0.14, 1 - t * t) : 9;
    cells.push(
      <span
        key={id}
        className={isActive ? 'act' : inside ? 'in' : ''}
        style={{ height: `${isActive ? Math.max(h, 100) : h}%` }}
      />,
    );
  }

  return <div className={`bins${p.inRange ? '' : ' out'}`}>{cells}</div>;
}

function DlmmCard({ p, now }: { readonly p: DlmmPosition; readonly now: number }) {
  return (
    <article className="dlmm">
      <div className="dlmm-top">
        <div>
          <span className="dlmm-pool">{p.pool}</span>
          <div className="mono-xs dimmer" style={{ marginTop: 4 }}>
            {p.venue} · bin step {p.binStep} · open {duration(now - p.openedAt)}
          </div>
        </div>
        {p.inRange ? (
          <Chip tone="ok">in range · earning</Chip>
        ) : (
          <Chip tone="warn">
            <IconHazard size={10} />
            out of range · idle
          </Chip>
        )}
      </div>

      <div className="dlmm-body">
        <Bins p={p} />
        <div className="bins-scale">
          <span>{fmtNum(p.lowerPrice, p.lowerPrice < 1 ? 5 : 2)}</span>
          <span className={p.inRange ? 'acid' : 'hazard'}>
            active {fmtNum(p.currentPrice, p.currentPrice < 1 ? 5 : 2)}
          </span>
          <span>{fmtNum(p.upperPrice, p.upperPrice < 1 ? 5 : 2)}</span>
        </div>

        <dl className="kv">
          <dt>bins</dt>
          <dd>
            {p.lowerBinId} → {p.upperBinId} · active {p.activeBinId}
            {p.inRange ? '' : ` (${p.activeBinId > p.upperBinId ? 'above' : 'below'} range)`}
          </dd>
          <dt>liquidity</dt>
          <dd>{fmtUsd(p.liquidityUsd)}</dd>
          <dt>fees earned</dt>
          <dd className="acid">{fmtUsd(p.feesEarnedUsd)}</dd>
          <dt>unclaimed</dt>
          <dd>
            {p.feesUnclaimed
              .map((f) => `${fmtUnits(f.base, f.decimals, 4)} ${f.symbol}`)
              .join('  ·  ')}
          </dd>
        </dl>

        {!p.inRange ? (
          <div className="hazard-band mono">
            <span>price left the range</span>
            <span>fees have stopped accruing</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function PositionsView({ snap }: { readonly snap: DashboardSnapshot }) {
  const now = useNow(5_000);
  const { positions } = snap;
  const outOfRange = positions.dlmm.filter((d) => !d.inRange).length;

  return (
    <div className="view">
      <ViewHead
        idx="02"
        kicker="book"
        title={
          <>
            EVERYTHING
            <br />
            <em>at risk.</em>
          </>
        }
        sub="Spot, perpetuals and concentrated liquidity, read from chain rather than from the agent's memory of what it did."
        aside={
          <>
            <span className="mono">
              {fmtUsd(positions.totalExposureUsd, 0)} exposure · {fmtUsd(positions.openRiskUsd, 0)} at risk
            </span>
            <span className={`mono-xs ${outOfRange > 0 ? 'hazard' : 'dimmer'}`}>
              {outOfRange > 0 ? `${outOfRange} pool position out of range` : 'all pool positions in range'}
            </span>
          </>
        }
      />

      <div className="stack">
        <Panel title="spot" meta={`${positions.spot.length} holdings · on-machine key`} flush>
          {positions.spot.length === 0 ? <Empty>no spot holdings</Empty> : <SpotTable rows={positions.spot} />}
        </Panel>

        <Panel
          title="perpetuals"
          meta={`${positions.perps.length} open · liquidation distance is the only number that matters`}
          flush
        >
          {positions.perps.length === 0 ? (
            <Empty>no perpetual positions</Empty>
          ) : (
            <PerpTable rows={positions.perps} now={now} />
          )}
        </Panel>

        <div>
          <div className="panel-head" style={{ border: '1px solid var(--line)', borderBottom: 0 }}>
            <span className="mono">meteora dlmm</span>
            <span className="mono-xs">
              {positions.dlmm.length} positions · a drifted active bin earns nothing
            </span>
          </div>
          <div className="grid g3" style={{ gap: 0 }}>
            {positions.dlmm.map((p) => (
              <DlmmCard key={p.id} p={p} now={now} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
