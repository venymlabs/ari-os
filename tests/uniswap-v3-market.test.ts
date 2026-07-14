import { describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import {
  Q96,
  UNISWAP_V3_POOL_ABI,
  decodeV3SwapLog,
  priceFromSqrtPriceX96,
  priceFromTick,
  readV3PoolState,
  sqrtRatioAtTick,
  normalizeV3Swap,
} from "../src/market/uniswap-v3.js";

const pool = "0x00000000000000000000000000000000000000aa" as const;
const token0 = "0x0000000000000000000000000000000000000001" as const;
const token1 = "0x0000000000000000000000000000000000000002" as const;

describe("Uniswap V3 pricing", () => {
  it("computes exact canonical sqrt ratios and decimal-adjusted prices", () => {
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    expect(sqrtRatioAtTick(1)).toBe(79232123823359799118286999568n);
    expect(priceFromSqrtPriceX96(Q96, 6, 18)).toEqual({
      numerator: 1n,
      denominator: 1_000_000_000_000n,
    });
    expect(priceFromTick(0, 18, 6)).toEqual({
      numerator: 1_000_000_000_000n,
      denominator: 1n,
    });
  });

  it("rejects invalid ticks, square roots and decimals", () => {
    expect(() => sqrtRatioAtTick(887273)).toThrow(/tick/i);
    expect(() => priceFromSqrtPriceX96(0n, 18, 18)).toThrow(/sqrt/i);
    expect(() => priceFromTick(0, -1, 18)).toThrow(/decimals/i);
  });
});

describe("pool reads and Swap decoding", () => {
  it("reads immutable and live state at one deterministic block", async () => {
    const values: Record<string, unknown> = {
      token0,
      token1,
      fee: 3000,
      slot0: [Q96, 0, 1, 2, 3, 4, true],
      liquidity: 99n,
    };
    const client = {
      readContract: vi.fn(async ({ functionName, blockNumber }: any) => {
        expect(blockNumber).toBe(123n);
        return values[functionName];
      }),
    };
    await expect(readV3PoolState(client, pool, 123n)).resolves.toMatchObject({
      address: pool,
      token0,
      token1,
      fee: 3000,
      sqrtPriceX96: Q96,
      tick: 0,
      liquidity: 99n,
      blockNumber: 123n,
    });
    expect(client.readContract).toHaveBeenCalledTimes(5);
  });

  it("decodes signed amounts and normalizes both trade directions with stable reorg IDs", () => {
    const event = UNISWAP_V3_POOL_ABI.find(
      (x) => x.type === "event" && x.name === "Swap",
    )!;
    const sender = "0x0000000000000000000000000000000000000011" as const;
    const recipient = "0x0000000000000000000000000000000000000012" as const;
    const topics = encodeEventTopics({
      abi: [event],
      eventName: "Swap",
      args: { sender, recipient },
    });
    const data = encodeAbiParameters(
      event.inputs.filter((x) => !("indexed" in x) || !x.indexed),
      [1_000_000n, -500_000_000_000_000_000n, Q96, 100n, 0],
    );
    const decoded = decodeV3SwapLog({
      address: pool,
      topics: topics as readonly `0x${string}`[],
      data,
      blockNumber: 10n,
      transactionHash: `0x${"ab".repeat(32)}`,
      logIndex: 2,
      blockHash: `0x${"cd".repeat(32)}`,
    });
    const trade = normalizeV3Swap(
      decoded,
      { address: pool, token0, token1, token0Decimals: 6, token1Decimals: 18 },
      1_700_000_000,
    );
    expect(trade).toMatchObject({
      side: "token0In",
      baseAmount: 1_000_000n,
      quoteAmount: 500_000_000_000_000_000n,
      timestamp: 1_700_000_000,
    });
    expect(trade.id).toBe(`${"cd".repeat(32)}:2`);
    expect(trade.price).toEqual({ numerator: 1n, denominator: 2n });
  });

  it("rejects malformed swaps and timestamps", () => {
    expect(() =>
      normalizeV3Swap(
        { amount0: 1n, amount1: 1n } as any,
        {
          address: pool,
          token0,
          token1,
          token0Decimals: 18,
          token1Decimals: 18,
        },
        1,
      ),
    ).toThrow(/opposite signs/i);
    expect(() =>
      normalizeV3Swap(
        { amount0: 0n, amount1: 0n } as any,
        {
          address: pool,
          token0,
          token1,
          token0Decimals: 18,
          token1Decimals: 18,
        },
        -1,
      ),
    ).toThrow(/timestamp/i);
  });
});
