import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  NOXA_FACTORY_ADDRESS,
  NOXA_FACTORY_START_BLOCK,
  NOXA_WETH_ADDRESS,
  tokenLaunchedEvent,
  createNoxaTokenRegistry,
} from "../src/noxa.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const deployer = "0x2222222222222222222222222222222222222222" as Address;
const dexFactory = "0x3333333333333333333333333333333333333333" as Address;
const pool = "0x4444444444444444444444444444444444444444" as Address;
const txHash = `0x${"aa".repeat(32)}` as Hex;
const blockHash = `0x${"bb".repeat(32)}` as Hex;

function launchLog(blockNumber = 100n, logIndex = 2, removed = false) {
  const topics = encodeEventTopics({ abi: [tokenLaunchedEvent], eventName: "TokenLaunched", args: { token, deployer, dexFactory } });
  const data = encodeAbiParameters(
    parseAbiParameters("address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount"),
    [NOXA_WETH_ADDRESS, pool, 7n, 8n, 9n, 110n, 12n],
  );
  return { address: NOXA_FACTORY_ADDRESS, topics, data, blockNumber, blockHash, transactionHash: txHash, logIndex, removed };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(105n),
    getLogs: vi.fn().mockResolvedValue([launchLog()]),
    readContract: vi.fn(),
    ...overrides,
  } as any;
}

describe("NOXA token registry", () => {
  it("pins verified Robinhood mainnet deployment constants", () => {
    expect(NOXA_FACTORY_ADDRESS).toBe("0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB");
    expect(NOXA_FACTORY_START_BLOCK).toBe(61688n);
    expect(NOXA_WETH_ADDRESS).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  });

  it("backfills in inclusive chunks and decodes TokenLaunched", async () => {
    const c = client({ getLogs: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([launchLog(103n)]) });
    const result = await createNoxaTokenRegistry(c, { chunkSize: 3n }).discover({ fromBlock: 100n, toBlock: 105n });
    expect(c.getLogs.mock.calls.map((x: any[]) => [x[0].fromBlock, x[0].toBlock])).toEqual([[100n, 102n], [103n, 105n]]);
    expect(result).toEqual([{ id: `${blockHash}:${txHash}:2`, token, deployer, dexFactory, pairToken: NOXA_WETH_ADDRESS, pool, dexId: 7n, launchConfigId: 8n, positionId: 9n, restrictionsEndBlock: 110n, initialBuyAmount: 12n, blockNumber: 103n, blockHash, transactionHash: txHash, logIndex: 2 }]);
  });

  it("uses a confirmation-safe tip by default", async () => {
    const c = client({ getBlockNumber: vi.fn().mockResolvedValue(100n), getLogs: vi.fn().mockResolvedValue([]) });
    await createNoxaTokenRegistry(c, { confirmations: 5n }).discover({ fromBlock: 90n });
    expect(c.getLogs).toHaveBeenCalledWith(expect.objectContaining({ toBlock: 95n }));
  });

  it("retries transient log failures without skipping the chunk", async () => {
    const getLogs = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce([launchLog()]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await createNoxaTokenRegistry(client({ getLogs }), { retries: 1, retryDelayMs: 10, sleep }).discover({ fromBlock: 100n, toBlock: 100n });
    expect(result).toHaveLength(1);
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("drops removed logs and deduplicates canonical event ids", async () => {
    const c = client({ getLogs: vi.fn().mockResolvedValue([launchLog(), launchLog(), launchLog(100n, 3, true)]) });
    expect(await createNoxaTokenRegistry(c).discover({ fromBlock: 100n, toBlock: 100n })).toHaveLength(1);
  });

  it("verifies both factory registration and token launchFactory", async () => {
    const tuple = [token, deployer, NOXA_WETH_ADDRESS, dexFactory, 9n, 7n, 8n, 110n, 1_000n, false, 10_000, true, 12n] as const;
    const c = client({ readContract: vi.fn().mockResolvedValueOnce(tuple).mockResolvedValueOnce(NOXA_FACTORY_ADDRESS) });
    const verified = await createNoxaTokenRegistry(c).verifyToken(token);
    expect(verified.verified).toBe(true);
    expect(verified.record.exists).toBe(true);
    expect(c.readContract).toHaveBeenCalledTimes(2);
  });

  it("rejects absent records without trusting token-side claims", async () => {
    const tuple = [token, deployer, NOXA_WETH_ADDRESS, dexFactory, 9n, 7n, 8n, 110n, 1_000n, false, 10_000, false, 12n] as const;
    const c = client({ readContract: vi.fn().mockResolvedValue(tuple) });
    const verified = await createNoxaTokenRegistry(c).verifyToken(token);
    expect(verified).toMatchObject({ verified: false, reason: "factory-record-missing" });
    expect(c.readContract).toHaveBeenCalledTimes(1);
  });
});
