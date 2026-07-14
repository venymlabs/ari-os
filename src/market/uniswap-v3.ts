import { decodeEventLog, type Address, type Hex } from "viem";

export const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const UNISWAP_V3_POOL_ABI = [
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token1",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint24" }],
  },
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount0", type: "int256" },
      { indexed: false, name: "amount1", type: "int256" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "liquidity", type: "uint128" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
] as const;

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
export function rational(n: bigint, d: bigint): Rational {
  if (d <= 0n) throw new RangeError("denominator must be positive");
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
}
function decimals(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new RangeError("decimals must be an integer from 0 to 255");
}

/** Exact integer TickMath port; rounds up exactly as the V3 core contract does. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    throw new RangeError("tick outside Uniswap V3 range");
  const a = tick < 0 ? -tick : tick;
  let r =
    a & 1
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const factors: [[number, bigint]] | Array<[number, bigint]> = [
    [2, 0xfff97272373d413259a46990580e213an],
    [4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [16, 0xffcb9843d60f6159c9db58835c926644n],
    [32, 0xff973b41fa98c081472e6896dfb254c0n],
    [64, 0xff2ea16466c96a3843ec78b326b52861n],
    [128, 0xfe5dee046a99a2a811c461f1969c3053n],
    [256, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [512, 0xf987a7253ac413176f2b074cf7815e54n],
    [1024, 0xf3392b0822b70005940c7a398e4b70f3n],
    [2048, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [4096, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [8192, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [16384, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [32768, 0x31be135f97d08fd981231505542fcfa6n],
    [65536, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [131072, 0x5d6af8dedb81196699c329225ee604n],
    [262144, 0x2216e584f5fa1ea926041bedfe98n],
    [524288, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, f] of factors) if (a & bit) r = (r * f) >> 128n;
  if (tick > 0) r = ((1n << 256n) - 1n) / r;
  return (r >> 32n) + (r % (1n << 32n) === 0n ? 0n : 1n);
}
export function priceFromSqrtPriceX96(
  sqrt: bigint,
  d0: number,
  d1: number,
): Rational {
  if (sqrt <= 0n) throw new RangeError("sqrtPriceX96 must be positive");
  decimals(d0);
  decimals(d1);
  return rational(sqrt * sqrt * 10n ** BigInt(d0), Q192 * 10n ** BigInt(d1));
}
export const priceFromTick = (tick: number, d0: number, d1: number) =>
  priceFromSqrtPriceX96(sqrtRatioAtTick(tick), d0, d1);

export interface PoolClient {
  readContract(args: {
    address: Address;
    abi: typeof UNISWAP_V3_POOL_ABI;
    functionName: "token0" | "token1" | "fee" | "slot0" | "liquidity";
    blockNumber: bigint;
  }): Promise<unknown>;
}
export async function readV3PoolState(
  client: PoolClient,
  address: Address,
  blockNumber: bigint,
) {
  if (blockNumber < 0n)
    throw new RangeError("blockNumber must be non-negative");
  const read = (
    functionName: "token0" | "token1" | "fee" | "slot0" | "liquidity",
  ) =>
    client.readContract({
      address,
      abi: UNISWAP_V3_POOL_ABI,
      functionName,
      blockNumber,
    });
  const [token0, token1, fee, slot0, liquidity] = await Promise.all([
    read("token0"),
    read("token1"),
    read("fee"),
    read("slot0"),
    read("liquidity"),
  ]);
  const slot = slot0 as readonly [
    bigint,
    number,
    number,
    number,
    number,
    number,
    boolean,
  ];
  if (slot[0] <= 0n) throw new Error("pool returned invalid sqrtPriceX96");
  return {
    address,
    token0: token0 as Address,
    token1: token1 as Address,
    fee: Number(fee),
    sqrtPriceX96: slot[0],
    tick: slot[1],
    observationIndex: slot[2],
    observationCardinality: slot[3],
    observationCardinalityNext: slot[4],
    feeProtocol: slot[5],
    unlocked: slot[6],
    liquidity: liquidity as bigint,
    blockNumber,
  };
}

export interface RawSwap {
  address: Address;
  sender: Address;
  recipient: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  blockNumber: bigint;
  transactionHash: Hex;
  blockHash: Hex;
  logIndex: number;
}
export function decodeV3SwapLog(log: {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  blockHash: Hex;
  logIndex: number;
}): RawSwap {
  const decoded = decodeEventLog({
    abi: UNISWAP_V3_POOL_ABI,
    eventName: "Swap",
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  });
  return { ...log, ...decoded.args } as RawSwap;
}
export function normalizeV3Swap(
  s: RawSwap,
  p: {
    address: Address;
    token0: Address;
    token1: Address;
    token0Decimals: number;
    token1Decimals: number;
  },
  timestamp: number,
) {
  decimals(p.token0Decimals);
  decimals(p.token1Decimals);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new RangeError("timestamp must be a non-negative integer");
  if (!(
    (s.amount0 > 0n && s.amount1 < 0n) ||
    (s.amount0 < 0n && s.amount1 > 0n)
  ))
    throw new Error("swap amounts must have opposite signs");
  const baseAmount = abs(s.amount0),
    quoteAmount = abs(s.amount1);
  return {
    id: `${s.blockHash.slice(2)}:${s.logIndex}`,
    pool: p.address,
    token0: p.token0,
    token1: p.token1,
    side: s.amount0 > 0n ? ("token0In" as const) : ("token1In" as const),
    baseAmount,
    quoteAmount,
    price: rational(
      quoteAmount * 10n ** BigInt(p.token0Decimals),
      baseAmount * 10n ** BigInt(p.token1Decimals),
    ),
    timestamp,
    blockNumber: s.blockNumber,
    transactionHash: s.transactionHash,
    blockHash: s.blockHash,
    logIndex: s.logIndex,
    sqrtPriceX96: s.sqrtPriceX96,
    tick: s.tick,
    liquidity: s.liquidity,
  };
}
