import { describe, it, expect, vi } from "vitest";
import { getAddress } from "viem";
import {
  buildRoutedSwapIntent,
  buildSwapTransaction,
  simulateUnsignedTransaction,
  discoverPools,
  decodeSwapReceipt,
  positionDeltas,
  validateNoxaTrade,
  validateQuoteFreshness,
} from "../src/trading/index.js";
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const A = a(1),
  B = a(2),
  C = a(3),
  O = a(4),
  R = a(5),
  F = a(6),
  P = a(7);
const routed = (multi = false) =>
  buildRoutedSwapIntent({
    chainId: 4663,
    owner: O,
    router: R,
    recipient: O,
    path: {
      tokens: multi ? [A, C, B] : [A, B],
      fees: multi ? [500, 3000] : [500],
    },
    amountIn: 10n,
    quotedAmountOut: 20n,
    now: 1n,
  });
describe("funded trading correctness regressions", () => {
  it("uses SwapRouter02 deadline-less selectors", () => {
    expect(
      buildSwapTransaction(routed(), {
        nonce: 0,
        gas: 1n,
        gasPrice: 1n,
      }).transaction.data.slice(0, 10),
    ).toBe("0x04e45aaf");
    expect(
      buildSwapTransaction(routed(true), {
        nonce: 0,
        gas: 1n,
        gasPrice: 1n,
      }).transaction.data.slice(0, 10),
    ).toBe("0xb858183f");
  });
  it("simulates exact multihop calldata and complete envelope", async () => {
    const seen: any[] = [];
    const c: any = {
      estimateGas: async (x: any) => (seen.push(x), 10n),
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 5n,
        maxPriorityFeePerGas: 2n,
      }),
      call: async (x: any) => (seen.push(x), { data: "0x" }),
    };
    const r = await simulateUnsignedTransaction(c, routed(true), { nonce: 3 });
    expect(seen[0].data).toBe(r.transaction.data);
    expect(seen[1]).toMatchObject({
      data: r.transaction.data,
      nonce: 3,
      gas: 10n,
      maxFeePerGas: 5n,
      maxPriorityFeePerGas: 2n,
    });
  });
  it("rejects incomplete, mixed, negative, or inverted fee envelopes", () => {
    const i = routed();
    for (const f of [
      { nonce: 0, gas: 1n },
      { nonce: 0, gas: 1n, gasPrice: -1n },
      { nonce: 0, gas: 1n, gasPrice: 1n, maxFeePerGas: 2n },
      { nonce: 0, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n },
    ] as any[])
      expect(() => buildSwapTransaction(i, f)).toThrow();
  });
  it("disables unproven native input rather than double spending", () => {
    expect(() =>
      buildRoutedSwapIntent({
        chainId: 4663,
        owner: O,
        router: R,
        recipient: O,
        path: { tokens: [A, B], fees: [500] },
        amountIn: 10n,
        quotedAmountOut: 20n,
        now: 1n,
        nativeInput: true,
        weth: A,
      }),
    ).toThrow(/native input disabled/i);
  });
  it("verifies pool code, factory, canonical tokens, fee and liquidity", async () => {
    const readContract = vi.fn(async (x: any) =>
      x.functionName === "getPool"
        ? P
        : x.functionName === "factory"
          ? F
          : x.functionName === "token0"
            ? A
            : x.functionName === "token1"
              ? B
              : x.functionName === "fee"
                ? 500
                : 1n,
    );
    const pools = await discoverPools(
      { readContract, getCode: async () => "0x12" } as any,
      { factory: F, tokenA: B, tokenB: A, feeTiers: [500], blockNumber: 12n },
    );
    expect(pools).toEqual([
      { token0: A, token1: B, fee: 500, pool: P, liquidity: 1n },
    ]);
  });
  it("pins quote block hash and enforces head distance and canonicality", () => {
    expect(() =>
      validateQuoteFreshness({
        quoteBlockNumber: 10n,
        quoteBlockHash: `0x${"1".repeat(64)}`,
        headNumber: 13n,
        canonicalHash: `0x${"1".repeat(64)}`,
        maxHeadDistance: 2n,
      }),
    ).toThrow(/stale/);
    expect(() =>
      validateQuoteFreshness({
        quoteBlockNumber: 10n,
        quoteBlockHash: `0x${"1".repeat(64)}`,
        headNumber: 10n,
        canonicalHash: `0x${"2".repeat(64)}`,
        maxHeadDistance: 2n,
      }),
    ).toThrow(/reorg/);
  });
  it("receipt accepts only expected tokens/router flow and verified balance deltas", () => {
    expect(() =>
      decodeSwapReceipt(
        {
          transactionHash: `0x${"1".repeat(64)}`,
          blockNumber: 3n,
          blockHash: `0x${"2".repeat(64)}`,
          status: "success",
          gasUsed: 1n,
          effectiveGasPrice: 1n,
          logs: [],
        } as any,
        O,
        {
          router: R,
          tokenIn: A,
          tokenOut: B,
          balanceDeltas: { [A]: -5n, [B]: 7n },
          canonicalBlockHash: `0x${"2".repeat(64)}`,
          finalizedBlockNumber: 3n,
        },
      ),
    ).not.toThrow();
    expect(() =>
      decodeSwapReceipt(
        {
          transactionHash: `0x${"1".repeat(64)}`,
          blockNumber: 3n,
          blockHash: `0x${"2".repeat(64)}`,
          status: "success",
          gasUsed: 1n,
          effectiveGasPrice: 1n,
          logs: [],
        } as any,
        O,
        {
          router: R,
          tokenIn: A,
          tokenOut: B,
          balanceDeltas: { [A]: -5n, [B]: 0n },
          canonicalBlockHash: `0x${"2".repeat(64)}`,
          finalizedBlockNumber: 3n,
        },
      ),
    ).toThrow(/output/);
  });
  it("does not label swap flow as P&L and requires decimals/prices", () => {
    expect(
      positionDeltas([{ token: A, delta: -5n }], { [A]: 2n } as any),
    ).toEqual({ deltas: [{ token: A, delta: -5n }], pnl: null });
  });
  it("binds NOXA route to launch factory and exact pool", () => {
    const record: any = {
      exists: true,
      token: B,
      pairedToken: A,
      poolFee: 500,
      pool: P,
      factory: F,
      restrictionsEndBlock: 10n,
    };
    expect(() =>
      validateNoxaTrade({
        token: B,
        path: { tokens: [A, B], fees: [500] },
        blockNumber: 10n,
        pool: P,
        factory: a(9),
        record,
      } as any),
    ).toThrow(/factory/);
    expect(
      validateNoxaTrade({
        token: B,
        path: { tokens: [A, B], fees: [500] },
        blockNumber: 10n,
        pool: P,
        factory: F,
        record,
      } as any).verified,
    ).toBe(true);
  });
});
