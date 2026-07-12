import {
  decodeEventLog,
  getAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";

export const NOXA_FACTORY_ADDRESS = "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB" as const;
export const NOXA_FACTORY_START_BLOCK = 61_688n;
export const NOXA_WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

export const tokenLaunchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
);

export const noxaFactoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount))",
]);

export const noxaTokenAbi = parseAbi(["function launchFactory() view returns (address)"]);

type RpcLog = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  removed?: boolean;
};

/** Minimal injected viem PublicClient surface, intentionally read-only. */
export interface NoxaPublicClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: Record<string, unknown>): Promise<readonly RpcLog[]>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

export interface NoxaLaunch {
  id: string;
  token: Address;
  deployer: Address;
  dexFactory: Address;
  pairToken: Address;
  pool: Address;
  dexId: bigint;
  launchConfigId: bigint;
  positionId: bigint;
  restrictionsEndBlock: bigint;
  initialBuyAmount: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export interface LaunchedTokenRecord {
  token: Address;
  deployer: Address;
  pairedToken: Address;
  positionManager: Address;
  positionId: bigint;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  supply: bigint;
  isToken0: boolean;
  poolFee: number;
  exists: boolean;
  initialBuyAmount: bigint;
}

export type TokenVerification =
  | { verified: true; record: LaunchedTokenRecord }
  | { verified: false; reason: "factory-record-missing" | "factory-record-token-mismatch" | "token-factory-mismatch"; record: LaunchedTokenRecord };

export interface RegistryOptions {
  chunkSize?: bigint;
  confirmations?: bigint;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const sameAddress = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

export function createNoxaTokenRegistry(client: NoxaPublicClient, options: RegistryOptions = {}) {
  const chunkSize = options.chunkSize ?? 10_000n;
  const confirmations = options.confirmations ?? 0n;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  if (chunkSize <= 0n) throw new RangeError("chunkSize must be positive");
  if (confirmations < 0n) throw new RangeError("confirmations cannot be negative");
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be a non-negative integer");

  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(retryDelayMs * 2 ** attempt++);
      }
    }
  }

  async function discover(range: { fromBlock?: bigint; toBlock?: bigint } = {}): Promise<NoxaLaunch[]> {
    const fromBlock = range.fromBlock ?? NOXA_FACTORY_START_BLOCK;
    const latest = range.toBlock ?? await retry(() => client.getBlockNumber());
    const toBlock = range.toBlock === undefined
      ? (latest > confirmations ? latest - confirmations : 0n)
      : latest;
    if (fromBlock > toBlock) return [];

    const launches = new Map<string, NoxaLaunch>();
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = start + chunkSize - 1n < toBlock ? start + chunkSize - 1n : toBlock;
      const logs = await retry(() => client.getLogs({
        address: NOXA_FACTORY_ADDRESS,
        event: tokenLaunchedEvent,
        fromBlock: start,
        toBlock: end,
        strict: true,
      }));
      for (const log of logs) {
        if (log.removed) continue;
        if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
          throw new Error("TokenLaunched log is pending or missing canonical identifiers");
        }
        const topics = log.topics as [Hex, ...Hex[]];
        const decoded = decodeEventLog({ abi: [tokenLaunchedEvent], eventName: "TokenLaunched", data: log.data, topics });
        const args = decoded.args;
        const id = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
        launches.set(id, {
          id,
          token: getAddress(args.token),
          deployer: getAddress(args.deployer),
          dexFactory: getAddress(args.dexFactory),
          pairToken: getAddress(args.pairToken),
          pool: getAddress(args.pool),
          dexId: args.dexId,
          launchConfigId: args.launchConfigId,
          positionId: args.positionId,
          restrictionsEndBlock: args.restrictionsEndBlock,
          initialBuyAmount: args.initialBuyAmount,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
    }
    return [...launches.values()].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
  }

  async function getLaunchedToken(token: Address): Promise<LaunchedTokenRecord> {
    const value = await retry(() => client.readContract({ address: NOXA_FACTORY_ADDRESS, abi: noxaFactoryAbi, functionName: "getLaunchedToken", args: [getAddress(token)] }));
    const tuple = value as readonly [Address, Address, Address, Address, bigint, bigint, bigint, bigint, bigint, boolean, number, boolean, bigint];
    return {
      token: getAddress(tuple[0]), deployer: getAddress(tuple[1]), pairedToken: getAddress(tuple[2]), positionManager: getAddress(tuple[3]),
      positionId: tuple[4], dexId: tuple[5], launchConfigId: tuple[6], restrictionsEndBlock: tuple[7], supply: tuple[8],
      isToken0: tuple[9], poolFee: tuple[10], exists: tuple[11], initialBuyAmount: tuple[12],
    };
  }

  async function verifyToken(token: Address): Promise<TokenVerification> {
    const requested = getAddress(token);
    const record = await getLaunchedToken(requested);
    if (!record.exists) return { verified: false, reason: "factory-record-missing", record };
    if (!sameAddress(record.token, requested)) return { verified: false, reason: "factory-record-token-mismatch", record };
    const factory = await retry(() => client.readContract({ address: requested, abi: noxaTokenAbi, functionName: "launchFactory" })) as Address;
    if (!sameAddress(factory, NOXA_FACTORY_ADDRESS)) return { verified: false, reason: "token-factory-mismatch", record };
    return { verified: true, record };
  }

  return Object.freeze({ discover, getLaunchedToken, verifyToken });
}
