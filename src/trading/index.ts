import {
  decodeEventLog,
  encodeFunctionData,
  encodePacked,
  getAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;
export const UNISWAP_V3_QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { type: "uint256" },
      { type: "uint160" },
      { type: "uint32" },
      { type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes" }, { type: "uint256" }],
    outputs: [
      { type: "uint256" },
      { type: "uint160[]" },
      { type: "uint32[]" },
      { type: "uint256" },
    ],
  },
] as const;
export const UNISWAP_V3_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
export const WETH_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }],
    outputs: [],
  },
] as const;
export const V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

const UINT256 = (1n << 256n) - 1n;
const positive = (v: bigint, n: string) => {
  if (typeof v !== "bigint" || v <= 0n || v > UINT256)
    throw new RangeError(`${n} must be a positive uint256`);
};
const amount = (v: bigint, n: string) => {
  if (typeof v !== "bigint" || v < 0n || v > UINT256)
    throw new RangeError(`${n} must be a uint256`);
};
const address = (v: Address) => getAddress(v);
export interface ReadClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
}
export async function portfolio(
  client: ReadClient,
  input: {
    owner: Address;
    tokens: readonly Address[];
    spenders?: readonly Address[];
    nativeBalance?: bigint;
  },
) {
  const owner = address(input.owner),
    spenders = (input.spenders ?? []).map(address);
  const tokens = await Promise.all(
    input.tokens.map(async (token) => {
      token = address(token);
      const read = (functionName: string, args?: readonly unknown[]) =>
        client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName,
          ...(args ? { args } : {}),
        });
      const [balance, decimals, symbol, name, allowances] = await Promise.all([
        read("balanceOf", [owner]),
        read("decimals"),
        read("symbol"),
        read("name"),
        Promise.all(
          spenders.map(async (spender) => ({
            spender,
            amount: (await read("allowance", [owner, spender])) as bigint,
          })),
        ),
      ]);
      return {
        address: token,
        balance: balance as bigint,
        decimals: Number(decimals),
        symbol: String(symbol),
        name: String(name),
        allowances,
      };
    }),
  );
  return { owner, nativeBalance: input.nativeBalance ?? 0n, tokens };
}
export type ApprovalIntent = {
  kind: "approve" | "revoke";
  chainId: number;
  owner: Address;
  token: Address;
  spender: Address;
  amount: bigint;
};
export function approvalIntent(
  i: Omit<ApprovalIntent, "kind">,
): ApprovalIntent {
  amount(i.amount, "amount");
  return {
    ...i,
    owner: address(i.owner),
    token: address(i.token),
    spender: address(i.spender),
    kind: i.amount === 0n ? "revoke" : "approve",
  };
}
export const allowanceIntent = approvalIntent;
type Fees = {
  nonce: number;
  gas: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};
function envelope(
  chainId: number,
  to: Address,
  data: Hex,
  value: bigint,
  fees: Fees,
) {
  if (!Number.isSafeInteger(fees.nonce) || fees.nonce < 0)
    throw new RangeError("invalid nonce");
  positive(fees.gas, "gas");
  const legacy = fees.gasPrice !== undefined,
    eip =
      fees.maxFeePerGas !== undefined ||
      fees.maxPriorityFeePerGas !== undefined;
  if (legacy === eip)
    throw new RangeError("fee envelope must be exactly legacy or EIP-1559");
  if (legacy) positive(fees.gasPrice!, "gasPrice");
  else {
    positive(fees.maxFeePerGas!, "maxFeePerGas");
    amount(fees.maxPriorityFeePerGas!, "maxPriorityFeePerGas");
    if (fees.maxPriorityFeePerGas! > fees.maxFeePerGas!)
      throw new RangeError("fee priority exceeds max fee");
  }
  const transaction = {
    chainId,
    to,
    data,
    value,
    nonce: fees.nonce,
    gas: fees.gas,
    ...(legacy
      ? { gasPrice: fees.gasPrice!, type: "legacy" as const }
      : {
          maxFeePerGas: fees.maxFeePerGas!,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
          type: "eip1559" as const,
        }),
  };
  return { transaction, serialized: serializeTransaction(transaction) };
}
export function buildApprovalTransaction(i: ApprovalIntent, fees: Fees) {
  return envelope(
    i.chainId,
    i.token,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [i.spender, i.amount],
    }),
    0n,
    fees,
  );
}
export interface V3Path {
  tokens: readonly Address[];
  fees: readonly number[];
}
function validFee(f: number) {
  if (!Number.isInteger(f) || f <= 0 || f > 0xffffff)
    throw new RangeError("invalid fee");
}
export function encodeV3Path(p: V3Path): Hex {
  if (p.tokens.length < 2 || p.fees.length !== p.tokens.length - 1)
    throw new RangeError("path token/fee length mismatch");
  const types: string[] = ["address"],
    values: (Address | number)[] = [address(p.tokens[0]!)];
  p.fees.forEach((f, j) => {
    validFee(f);
    types.push("uint24", "address");
    values.push(f, address(p.tokens[j + 1]!));
  });
  return encodePacked(types as any, values as any);
}
export async function quoteExactInputSingle(
  client: ReadClient,
  i: {
    quoter: Address;
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    amountIn: bigint;
    sqrtPriceLimitX96?: bigint;
  },
) {
  positive(i.amountIn, "amountIn");
  validFee(i.fee);
  const r = (await client.readContract({
    address: address(i.quoter),
    abi: UNISWAP_V3_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: address(i.tokenIn),
        tokenOut: address(i.tokenOut),
        amountIn: i.amountIn,
        fee: i.fee,
        sqrtPriceLimitX96: i.sqrtPriceLimitX96 ?? 0n,
      },
    ],
  })) as readonly [bigint, bigint, number, bigint];
  return {
    amountOut: r[0],
    sqrtPriceX96After: r[1],
    initializedTicksCrossed: r[2],
    gasEstimate: r[3],
  };
}
export async function quoteExactInput(
  client: ReadClient,
  i: { quoter: Address; path: V3Path; amountIn: bigint },
) {
  positive(i.amountIn, "amountIn");
  const r = (await client.readContract({
    address: address(i.quoter),
    abi: UNISWAP_V3_QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    args: [encodeV3Path(i.path), i.amountIn],
  })) as readonly [bigint, readonly bigint[], number, bigint];
  return {
    amountOut: r[0],
    sqrtPriceX96AfterList: r[1],
    initializedTicksCrossed: r[2],
    gasEstimate: r[3],
  };
}
export async function discoverBestRoute(
  paths: readonly V3Path[],
  quote: (p: V3Path) => Promise<bigint>,
) {
  if (!paths.length) throw new Error("no candidate routes");
  const quotes = await Promise.all(
    paths.map(async (path, index) => ({
      path,
      index,
      amountOut: await quote(path),
    })),
  );
  quotes.forEach((q) => amount(q.amountOut, "quote"));
  quotes.sort((a, b) =>
    a.amountOut === b.amountOut
      ? a.index - b.index
      : a.amountOut > b.amountOut
        ? -1
        : 1,
  );
  return quotes[0]!;
}
export type SwapIntent = {
  kind: "uniswap-v3-exact-input-single" | "uniswap-v3-exact-input";
  chainId: number;
  owner: Address;
  router: Address;
  recipient: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  path?: V3Path;
  amountIn: bigint;
  quotedAmountOut: bigint;
  amountOutMinimum: bigint;
  slippageBps: number;
  deadline: bigint;
  value: bigint;
  preTransactions?: readonly { to: Address; data: Hex; value: bigint }[];
};
type SwapInput = Omit<SwapIntent, "kind" | "amountOutMinimum" | "value"> & {
  now: bigint;
  value?: bigint;
  noxaToken?: Address;
};
function makeSwap(i: SwapInput): SwapIntent {
  positive(i.amountIn, "amountIn");
  positive(i.quotedAmountOut, "quotedAmountOut");
  validFee(i.fee);
  if (
    !Number.isInteger(i.slippageBps) ||
    i.slippageBps < 0 ||
    i.slippageBps > 10_000
  )
    throw new RangeError("slippage out of bounds");
  if (address(i.recipient) !== address(i.owner))
    throw new Error("recipient must equal intent owner");
  if (i.deadline <= i.now) throw new Error("deadline must be in the future");
  const min = (i.quotedAmountOut * BigInt(10_000 - i.slippageBps)) / 10_000n;
  return {
    kind: "uniswap-v3-exact-input-single",
    chainId: i.chainId,
    owner: address(i.owner),
    router: address(i.router),
    recipient: address(i.recipient),
    tokenIn: address(i.tokenIn),
    tokenOut: address(i.tokenOut),
    fee: i.fee,
    amountIn: i.amountIn,
    quotedAmountOut: i.quotedAmountOut,
    amountOutMinimum: min,
    slippageBps: i.slippageBps,
    deadline: i.deadline,
    value: i.value ?? 0n,
  };
}
export function swapIntent(i: SwapInput): SwapIntent;
export function swapIntent(
  i: SwapInput,
  o: { verifyNoxaToken: (token: Address) => Promise<boolean> },
): Promise<SwapIntent>;
export function swapIntent(
  i: SwapInput,
  o?: { verifyNoxaToken: (token: Address) => Promise<boolean> },
): SwapIntent | Promise<SwapIntent> {
  const intent = makeSwap(i);
  if (!o) return intent;
  if (!i.noxaToken) throw new Error("NOXA token required");
  return o.verifyNoxaToken(address(i.noxaToken)).then((ok) => {
    if (!ok) throw new Error("NOXA token contract not verified");
    return intent;
  });
}
export function buildSwapTransaction(i: SwapIntent, fees: Fees) {
  const data =
    i.kind === "uniswap-v3-exact-input"
      ? encodeFunctionData({
          abi: UNISWAP_V3_ROUTER_ABI,
          functionName: "exactInput",
          args: [
            {
              path: encodeV3Path(i.path!),
              recipient: i.recipient,
              amountIn: i.amountIn,
              amountOutMinimum: i.amountOutMinimum,
            },
          ],
        })
      : encodeFunctionData({
          abi: UNISWAP_V3_ROUTER_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: i.tokenIn,
              tokenOut: i.tokenOut,
              fee: i.fee,
              recipient: i.recipient,
              amountIn: i.amountIn,
              amountOutMinimum: i.amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
  return envelope(i.chainId, i.router, data, i.value, fees);
}
export interface TxClient {
  estimateGas(a: Record<string, unknown>): Promise<bigint>;
  estimateFeesPerGas(): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  }>;
  call(a: Record<string, unknown>): Promise<unknown>;
}
export async function simulateUnsignedTransaction(
  client: TxClient,
  intent: SwapIntent,
  input: { nonce: number },
) {
  const probe = buildSwapTransaction(intent, {
    nonce: input.nonce,
    gas: 1n,
    gasPrice: 1n,
  });
  const estimateRequest = {
    account: intent.owner,
    to: intent.router,
    data: probe.transaction.data,
    value: intent.value,
    nonce: input.nonce,
  };
  const [gas, fees] = await Promise.all([
    client.estimateGas(estimateRequest),
    client.estimateFeesPerGas(),
  ]);
  const fee = fees.maxFeePerGas ?? fees.gasPrice;
  if (fee === undefined) throw new Error("fee estimate unavailable");
  const tx = buildSwapTransaction(intent, {
    nonce: input.nonce,
    gas,
    ...(fees.gasPrice !== undefined
      ? { gasPrice: fees.gasPrice }
      : {
          maxFeePerGas: fees.maxFeePerGas!,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas!,
        }),
  });
  const request = { account: intent.owner, ...tx.transaction };
  try {
    await client.call(request);
    return { ...tx, success: true as const, gas, maxCost: gas * fee };
  } catch (error) {
    return { ...tx, success: false as const, gas, maxCost: gas * fee, error };
  }
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const V3_POOL_ABI = [
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
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
] as const;
export async function discoverPools(
  client: ReadClient & {
    getCode?(x: {
      address: Address;
      blockNumber?: bigint;
    }): Promise<Hex | undefined>;
  },
  i: {
    factory: Address;
    tokenA: Address;
    tokenB: Address;
    feeTiers?: readonly number[];
    blockNumber: bigint;
  },
) {
  const [token0, token1] = [address(i.tokenA), address(i.tokenB)].sort() as [
    Address,
    Address,
  ];
  const factory = address(i.factory),
    tiers = i.feeTiers ?? [100, 500, 3000, 10000];
  const found = [];
  for (const fee of tiers) {
    validFee(fee);
    const pool = address(
      (await client.readContract({
        address: factory,
        abi: V3_FACTORY_ABI,
        functionName: "getPool",
        args: [token0, token1, fee],
        blockNumber: i.blockNumber,
      })) as Address,
    );
    if (pool === ZERO) continue;
    if (!client.getCode) throw new Error("pool bytecode verifier required");
    const code = await client.getCode({
      address: pool,
      blockNumber: i.blockNumber,
    });
    if (!code || code === "0x") throw new Error("pool has no bytecode");
    const read = (functionName: string) =>
      client.readContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName,
        blockNumber: i.blockNumber,
      });
    const [actualFactory, t0, t1, actualFee, liquidity] = await Promise.all([
      read("factory"),
      read("token0"),
      read("token1"),
      read("fee"),
      read("liquidity"),
    ]);
    if (
      address(actualFactory as Address) !== factory ||
      address(t0 as Address) !== token0 ||
      address(t1 as Address) !== token1 ||
      Number(actualFee) !== fee
    )
      throw new Error("pool identity mismatch");
    if ((liquidity as bigint) <= 0n) throw new Error("pool has no liquidity");
    found.push({ token0, token1, fee, pool, liquidity: liquidity as bigint });
  }
  return found;
}

export function buildRoutedSwapIntent(i: {
  chainId: number;
  owner: Address;
  router: Address;
  recipient: Address;
  path: V3Path;
  amountIn: bigint;
  quotedAmountOut: bigint;
  now: bigint;
  slippageBps?: number;
  deadlineSeconds?: bigint;
  nativeInput?: boolean;
  weth?: Address;
}) {
  encodeV3Path(i.path);
  if (i.nativeInput)
    throw new Error(
      "native input disabled until exact SwapRouter02 multicall semantics are proven",
    );
  const slippageBps = i.slippageBps ?? 100,
    deadline = i.now + (i.deadlineSeconds ?? 300n);
  const base = makeSwap({
    chainId: i.chainId,
    owner: i.owner,
    router: i.router,
    recipient: i.recipient,
    tokenIn: i.path.tokens[0]!,
    tokenOut: i.path.tokens.at(-1)!,
    fee: i.path.fees[0]!,
    path: i.path,
    amountIn: i.amountIn,
    quotedAmountOut: i.quotedAmountOut,
    slippageBps,
    deadline,
    now: i.now,
  });
  const multi = i.path.tokens.length > 2;
  return {
    ...base,
    ...(multi ? { path: i.path } : {}),
    kind: multi ? ("uniswap-v3-exact-input" as const) : base.kind,
  };
}

export function approvalPlan(i: {
  chainId: number;
  owner: Address;
  token: Address;
  spender: Address;
  currentAllowance: bigint;
  requiredAmount: bigint;
  zeroReset?: boolean;
}) {
  amount(i.currentAllowance, "currentAllowance");
  positive(i.requiredAmount, "requiredAmount");
  if (i.currentAllowance === i.requiredAmount) return [];
  const make = (v: bigint) =>
    approvalIntent({
      chainId: i.chainId,
      owner: i.owner,
      token: i.token,
      spender: i.spender,
      amount: v,
    });
  return i.zeroReset && i.currentAllowance > 0n
    ? [make(0n), make(i.requiredAmount)]
    : [make(i.requiredAmount)];
}
export async function preflightAllowance(
  client: ReadClient,
  i: {
    owner: Address;
    token: Address;
    spender: Address;
    requiredAmount: bigint;
  },
) {
  const allowance = (await client.readContract({
    address: address(i.token),
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address(i.owner), address(i.spender)],
  })) as bigint;
  if (allowance < i.requiredAmount)
    throw new Error(`insufficient allowance: ${allowance}`);
  return allowance;
}

export async function quoteRoutesAtBlock(
  client: ReadClient & { getBlockNumber(): Promise<bigint> },
  i: {
    quoter: Address;
    paths: readonly V3Path[];
    amountIn: bigint;
    blockNumber?: bigint;
  },
) {
  const blockNumber = i.blockNumber ?? (await client.getBlockNumber());
  const quotes = await Promise.all(
    i.paths.map(async (path, index) => {
      const single = path.tokens.length === 2;
      const r = (await client.readContract(
        single
          ? {
              address: address(i.quoter),
              abi: UNISWAP_V3_QUOTER_V2_ABI,
              functionName: "quoteExactInputSingle",
              args: [
                {
                  tokenIn: address(path.tokens[0]!),
                  tokenOut: address(path.tokens[1]!),
                  amountIn: i.amountIn,
                  fee: path.fees[0]!,
                  sqrtPriceLimitX96: 0n,
                },
              ],
              blockNumber,
            }
          : {
              address: address(i.quoter),
              abi: UNISWAP_V3_QUOTER_V2_ABI,
              functionName: "quoteExactInput",
              args: [encodeV3Path(path), i.amountIn],
              blockNumber,
            },
      )) as readonly [bigint, ...unknown[]];
      return { path, index, amountOut: r[0], blockNumber };
    }),
  );
  const best = await discoverBestRoute(
    i.paths,
    async (p) => quotes.find((q) => q.path === p)!.amountOut,
  );
  return { blockNumber, quotes, best };
}

const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;
export function decodeSwapReceipt(
  receipt: {
    transactionHash: Hex;
    blockNumber: bigint;
    blockHash?: Hex;
    status: string;
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
  },
  owner: Address,
  expected?: {
    router: Address;
    tokenIn: Address;
    tokenOut: Address;
    balanceDeltas: Record<string, bigint>;
    canonicalBlockHash: Hex;
    finalizedBlockNumber: bigint;
  },
) {
  if (receipt.status !== "success") throw new Error("swap receipt failed");
  if (expected) {
    if (
      !receipt.blockHash ||
      receipt.blockHash.toLowerCase() !==
        expected.canonicalBlockHash.toLowerCase()
    )
      throw new Error("receipt is not canonical");
    if (receipt.blockNumber > expected.finalizedBlockNumber)
      throw new Error("receipt is not finalized");
    const input = expected.balanceDeltas[address(expected.tokenIn)] ?? 0n,
      output = expected.balanceDeltas[address(expected.tokenOut)] ?? 0n;
    if (input >= 0n) throw new Error("expected input balance decrease");
    if (output <= 0n) throw new Error("expected output balance increase");
    return {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasCost: receipt.gasUsed * receipt.effectiveGasPrice,
      deltas: [
        { token: address(expected.tokenIn), delta: input },
        { token: address(expected.tokenOut), delta: output },
      ],
    };
  }
  const deltas = new Map<Address, bigint>(),
    who = address(owner);
  for (const log of receipt.logs) {
    try {
      const d = decodeEventLog({
        abi: TRANSFER_ABI,
        eventName: "Transfer",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }).args;
      const token = address(log.address);
      let v = deltas.get(token) ?? 0n;
      if (address(d.from) === who) v -= d.value;
      if (address(d.to) === who) v += d.value;
      deltas.set(token, v);
    } catch {
      continue;
    }
  }
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    gasCost: receipt.gasUsed * receipt.effectiveGasPrice,
    deltas: [...deltas]
      .filter(([, delta]) => delta !== 0n)
      .map(([token, delta]) => ({ token, delta })),
  };
}
export function positionDeltas(
  deltas: readonly { token: Address; delta: bigint }[],
  _prices: Record<string, bigint>,
) {
  return { deltas: [...deltas], pnl: null };
}

export function validateNoxaTrade(i: {
  token: Address;
  path: V3Path;
  blockNumber: bigint;
  pool?: Address;
  factory?: Address;
  record: {
    exists: boolean;
    token: Address;
    pairedToken: Address;
    poolFee: number;
    pool?: Address;
    factory?: Address;
    restrictionsEndBlock: bigint;
  };
}) {
  if (!i.record.exists || address(i.record.token) !== address(i.token))
    throw new Error("NOXA token not verified");
  if (i.blockNumber < i.record.restrictionsEndBlock)
    throw new Error("NOXA token is restricted");
  if (
    i.record.factory &&
    (!i.factory || address(i.factory) !== address(i.record.factory))
  )
    throw new Error("NOXA factory mismatch");
  if (i.record.pool && (!i.pool || address(i.pool) !== address(i.record.pool)))
    throw new Error("NOXA pool mismatch");
  const index = i.path.tokens.findIndex((t) => address(t) === address(i.token));
  if (index < 0) throw new Error("NOXA token absent from route");
  const peer = i.path.tokens[index === 0 ? 1 : index - 1];
  const fee = i.path.fees[index === 0 ? 0 : index - 1];
  if (
    !peer ||
    address(peer) !== address(i.record.pairedToken) ||
    fee !== i.record.poolFee
  )
    throw new Error("NOXA route does not match launch record");
  return { verified: true as const, blockNumber: i.blockNumber };
}

export function validateQuoteFreshness(i: {
  quoteBlockNumber: bigint;
  quoteBlockHash: Hex;
  headNumber: bigint;
  canonicalHash: Hex;
  maxHeadDistance: bigint;
}) {
  if (i.headNumber - i.quoteBlockNumber > i.maxHeadDistance)
    throw new Error("stale quote block");
  if (i.quoteBlockHash.toLowerCase() !== i.canonicalHash.toLowerCase())
    throw new Error("quote block reorg detected");
  return true;
}

export async function createRobinhoodTradingClient(i: {
  client: {
    getChainId(): Promise<number>;
    getCode(x: { address: Address }): Promise<Hex | undefined>;
  };
  contracts?: readonly Address[];
}) {
  if ((await i.client.getChainId()) !== 4663)
    throw new Error("expected Robinhood mainnet chain 4663");
  for (const contract of i.contracts ?? []) {
    const code = await i.client.getCode({ address: address(contract) });
    if (!code || code === "0x")
      throw new Error(`verified contract has no bytecode: ${contract}`);
  }
  return Object.freeze({ chainId: 4663 as const, client: i.client });
}
