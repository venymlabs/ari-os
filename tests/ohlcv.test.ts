import { describe, expect, it } from "vitest";
import {
  aggregateCandles,
  marketAnalytics,
  type MarketTrade,
} from "../src/market/ohlcv.js";

const trade = (
  id: string,
  timestamp: number,
  price: [bigint, bigint],
  base: bigint,
  quote: bigint,
): MarketTrade => ({
  id,
  timestamp,
  price: { numerator: price[0], denominator: price[1] },
  baseAmount: base,
  quoteAmount: quote,
  blockNumber: 1n,
  logIndex: 0,
});

describe("OHLCV aggregation", () => {
  it("sorts deterministically, aligns UTC buckets and computes exact rational OHLC and volumes", () => {
    const candles = aggregateCandles(
      [
        trade("b", 119, [3n, 1n], 2n, 6n),
        trade("a", 61, [2n, 1n], 1n, 2n),
        trade("c", 120, [5n, 2n], 4n, 10n),
      ],
      60,
    );
    expect(candles).toEqual([
      {
        start: 60,
        end: 120,
        open: { numerator: 2n, denominator: 1n },
        high: { numerator: 3n, denominator: 1n },
        low: { numerator: 2n, denominator: 1n },
        close: { numerator: 3n, denominator: 1n },
        baseVolume: 3n,
        quoteVolume: 8n,
        trades: 2,
      },
      {
        start: 120,
        end: 180,
        open: { numerator: 5n, denominator: 2n },
        high: { numerator: 5n, denominator: 2n },
        low: { numerator: 5n, denominator: 2n },
        close: { numerator: 5n, denominator: 2n },
        baseVolume: 4n,
        quoteVolume: 10n,
        trades: 1,
      },
    ]);
  });

  it("deduplicates reorg IDs and rejects invalid inputs", () => {
    const t = trade("same", 60, [1n, 1n], 2n, 2n);
    expect(aggregateCandles([t, t], 60)[0]?.trades).toBe(1);
    expect(() =>
      aggregateCandles([trade("x", 1, [0n, 1n], 1n, 1n)], 60),
    ).toThrow(/price/i);
    expect(() => aggregateCandles([], 0)).toThrow(/interval/i);
  });

  it("computes VWAP, exact range, counts and active-liquidity metrics", () => {
    expect(
      marketAnalytics(
        [trade("a", 1, [2n, 1n], 2n, 4n), trade("b", 2, [4n, 1n], 1n, 4n)],
        1_000n,
      ),
    ).toEqual({
      tradeCount: 2,
      baseVolume: 3n,
      quoteVolume: 8n,
      vwap: { numerator: 8n, denominator: 3n },
      low: { numerator: 2n, denominator: 1n },
      high: { numerator: 4n, denominator: 1n },
      activeLiquidity: 1_000n,
      quotePerLiquidity: { numerator: 1n, denominator: 125n },
    });
    expect(() => marketAnalytics([], -1n)).toThrow(/liquidity/i);
  });
});
