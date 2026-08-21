import type { ReactNode } from 'react';
import { capRatio } from '../lib/format';
import { IconCheck, IconCross, IconMinus } from '../lib/icons';

export function SectionIndex({ idx, label }: { readonly idx: string; readonly label: string }) {
  return (
    <div className="sindex mono">
      <span>{idx}</span>
      <span>{label}</span>
    </div>
  );
}

export function ViewHead({
  idx,
  kicker,
  title,
  sub,
  aside,
}: {
  readonly idx: string;
  readonly kicker: string;
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <header className="view-head">
      <div>
        <SectionIndex idx={idx} label={kicker} />
        <h1>{title}</h1>
        {sub ? <p className="view-sub">{sub}</p> : null}
      </div>
      {aside ? <div className="vh-aside">{aside}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  meta,
  flush,
  children,
  className,
}: {
  readonly title: string;
  readonly meta?: ReactNode;
  readonly flush?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      <div className="panel-head">
        <span className="mono">{title}</span>
        {meta ? <span className="mono-xs">{meta}</span> : null}
      </div>
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Pill({
  state,
  children,
}: {
  readonly state: 'on' | 'off' | 'idle';
  readonly children: ReactNode;
}) {
  return (
    <span className={`pill mono ${state}`}>
      <i />
      {children}
    </span>
  );
}

export function Chip({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'ok' | 'warn';
  readonly children: ReactNode;
}) {
  return <span className={`chip${tone === 'neutral' ? '' : ` ${tone}`}`}>{children}</span>;
}

/**
 * A capacity bar. `used` fills, `would` (optional) draws the projection this
 * intent would push it to, and the marker is where the cap sits.
 */
export function Meter({
  used,
  cap,
  would,
}: {
  readonly used: string;
  readonly cap: string;
  readonly would?: string;
}) {
  const usedR = capRatio(used, cap);
  const wouldR = would ? capRatio(would, cap) : 0;
  const over = would ? (() => {
    try {
      return BigInt(would) > BigInt(cap);
    } catch {
      return false;
    }
  })() : false;

  return (
    <div className={`meter${over ? ' over' : ''}`} role="presentation">
      {would && wouldR > usedR ? (
        <u style={{ width: `${Math.min(100, wouldR * 100)}%` }} />
      ) : null}
      <i style={{ width: `${Math.min(100, usedR * 100)}%` }} />
      {would ? <b style={{ left: `${Math.min(100, wouldR * 100)}%` }} /> : null}
    </div>
  );
}

/** The vertical rule the model cannot cross. Reused wherever the two zones meet. */
export function BoundaryColumn({ label = 'capability boundary' }: { readonly label?: string }) {
  return (
    <div className="boundary-col" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <span>{label}</span>
    </div>
  );
}

export function GuardMark({ status }: { readonly status: 'pass' | 'fail' | 'skipped' }) {
  if (status === 'pass') return <IconCheck size={11} />;
  if (status === 'fail') return <IconCross size={11} />;
  return <IconMinus size={11} />;
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
