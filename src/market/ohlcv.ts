/**
 * An exact price, kept as a reduced fraction.
 *
 * Candles are aggregated in integer arithmetic end to end: a mid price of one
 * base unit against another has no exact float representation, and rounding at
 * aggregation time would make the open/high/low/close of a bucket depend on the
 * order the trades arrived in.
 */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}
const abs = (x: bigint) => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => {
  a = abs(a);
  b = abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
};
/** Reduces to lowest terms so equal prices compare equal by value. */
export function rational(n: bigint, d: bigint): Rational {
  if (d <= 0n) throw new RangeError("denominator must be positive");
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
}

/**
 * One executed trade on a pair.
 *
 * `slot` and `sequence` are the deterministic tie-break for trades sharing a
 * timestamp: the cluster slot the trade landed in, then its position within
 * that slot.
 */
export interface MarketTrade {
  id: string;
  timestamp: number;
  price: Rational;
  baseAmount: bigint;
  quoteAmount: bigint;
  slot: bigint;
  sequence: number;
}
export interface Candle {
  start: number;
  end: number;
  open: Rational;
  high: Rational;
  low: Rational;
  close: Rational;
  baseVolume: bigint;
  quoteVolume: bigint;
  trades: number;
}
const valid = (r: Rational) => r.numerator > 0n && r.denominator > 0n;
const compare = (a: Rational, b: Rational) =>
  a.numerator * b.denominator - b.numerator * a.denominator;
const canonical = (r: Rational) => rational(r.numerator, r.denominator);

/** Aggregates sparse candles; no synthetic gap candles are emitted. Duplicate IDs are ignored. */
export function aggregateCandles(
  input: readonly MarketTrade[],
  intervalSeconds: number,
): Candle[] {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0)
    throw new RangeError("interval must be a positive integer");
  const seen = new Set<string>();
  const trades = input
    .filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    })
    .sort((a, b) => {
      const time = a.timestamp - b.timestamp;
      if (time) return time;
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
      return a.sequence - b.sequence || a.id.localeCompare(b.id);
    });
  const out: Candle[] = [];
  for (const t of trades) {
    if (!Number.isSafeInteger(t.timestamp) || t.timestamp < 0)
      throw new RangeError("timestamp must be non-negative");
    if (!valid(t.price)) throw new RangeError("price must be positive");
    if (t.baseAmount < 0n || t.quoteAmount < 0n)
      throw new RangeError("volumes must be non-negative");
    const start = Math.floor(t.timestamp / intervalSeconds) * intervalSeconds;
    let c = out.at(-1);
    const p = canonical(t.price);
    if (!c || c.start !== start) {
      c = {
        start,
        end: start + intervalSeconds,
        open: p,
        high: p,
        low: p,
        close: p,
        baseVolume: 0n,
        quoteVolume: 0n,
        trades: 0,
      };
      out.push(c);
    }
    if (compare(p, c.high) > 0) c.high = p;
    if (compare(p, c.low) < 0) c.low = p;
    c.close = p;
    c.baseVolume += t.baseAmount;
    c.quoteVolume += t.quoteAmount;
    c.trades++;
  }
  return out;
}
export function marketAnalytics(
  trades: readonly MarketTrade[],
  activeLiquidity: bigint,
) {
  if (activeLiquidity < 0n)
    throw new RangeError("liquidity must be non-negative");
  let baseVolume = 0n,
    quoteVolume = 0n;
  let low: Rational | undefined, high: Rational | undefined;
  const seen = new Set<string>();
  let tradeCount = 0;
  for (const t of trades) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (!valid(t.price)) throw new RangeError("price must be positive");
    baseVolume += t.baseAmount;
    quoteVolume += t.quoteAmount;
    tradeCount++;
    if (!low || compare(t.price, low) < 0) low = canonical(t.price);
    if (!high || compare(t.price, high) > 0) high = canonical(t.price);
  }
  return {
    tradeCount,
    baseVolume,
    quoteVolume,
    vwap: baseVolume ? rational(quoteVolume, baseVolume) : null,
    low: low ?? null,
    high: high ?? null,
    activeLiquidity,
    quotePerLiquidity: activeLiquidity
      ? rational(quoteVolume, activeLiquidity)
      : null,
  };
}
