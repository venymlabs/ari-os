/** Display helpers. Base-unit integers stay strings until the last possible moment. */

/** Format a base-unit integer string as a human decimal. */
export function fmtUnits(base: string, decimals: number, maxFrac = 4): string {
  const neg = base.startsWith('-');
  const digits = (neg ? base.slice(1) : base).replace(/\D/g, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const frac = decimals > 0 ? padded.slice(padded.length - decimals) : '';
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${trimmed ? `.${trimmed}` : ''}`;
}

/** Lossy — display and bar-width math only, never a safety input. */
export function unitsToNumber(base: string, decimals: number): number {
  const n = Number(base);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

/** 0..1 fill ratio of `used` against `cap`, computed in bigint then narrowed. */
export function capRatio(used: string, cap: string): number {
  try {
    const c = BigInt(cap);
    if (c <= 0n) return 0;
    const u = BigInt(used);
    if (u <= 0n) return 0;
    const scaled = (u * 10000n) / c;
    return Math.min(1, Number(scaled) / 10000);
  } catch {
    return 0;
  }
}

export function addUnits(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

export function fmtUsd(n: number, frac = 2): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
}

export function fmtSignedUsd(n: number): string {
  return `${n >= 0 ? '+' : '−'}${fmtUsd(Math.abs(n))}`;
}

export function fmtPct(n: number, frac = 2): string {
  return `${n.toFixed(frac)}%`;
}

export function fmtSignedPct(n: number, frac = 2): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(frac)}%`;
}

export function fmtNum(n: number, frac = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

const PAD = (n: number, w = 2): string => String(Math.floor(Math.abs(n))).padStart(w, '0');

/** UTC wall clock — machine state is always UTC. */
export function clockUtc(ts: number, withMs = false): string {
  const d = new Date(ts);
  const base = `${PAD(d.getUTCHours())}:${PAD(d.getUTCMinutes())}:${PAD(d.getUTCSeconds())}`;
  return withMs ? `${base}.${PAD(d.getUTCMilliseconds(), 3)}` : base;
}

export function dateUtc(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth() + 1)}-${PAD(d.getUTCDate())}`;
}

/** Compact elapsed duration, e.g. `4m 12s`, `2h 05m`, `3d 04h`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${PAD(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${PAD(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${PAD(h % 24)}h`;
}

export function ago(ts: number, now: number): string {
  return `${duration(now - ts)} ago`;
}

/** Countdown that never goes negative in text; caller checks the sign separately. */
export function until(ts: number, now: number): string {
  return ts <= now ? 'EXPIRED' : duration(ts - now);
}

export function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function lamportsToSol(lamports: string): string {
  return fmtUnits(lamports, 9, 6);
}

/** Stable pseudo-random in [0,1) from a numeric seed — deterministic fixtures. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
