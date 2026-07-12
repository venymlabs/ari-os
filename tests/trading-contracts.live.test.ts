import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "../src/chain.js";
import { tradingContracts } from "../src/trading/contracts.js";

describe("verified trading contracts", () => {
  it("codifies only contracts verified for each network", () => {
    expect(tradingContracts.mainnet.chainId).toBe(4663);
    expect(tradingContracts.mainnet.tokens.weth).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    expect(tradingContracts.mainnet.tokens.usdg).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(tradingContracts.mainnet.uniswapV3.factory).toBe("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
    expect(tradingContracts.mainnet.uniswapV3.swapRouter02).toBe("0xcaf681a66d020601342297493863e78c959e5cb2");
    expect(tradingContracts.mainnet.uniswapV3.quoterV2).toBe("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(tradingContracts.mainnet.uniswapV3.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(tradingContracts.mainnet.noxa.launchFactory).toBe("0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB");
    expect(tradingContracts.testnet).toEqual({ chainId: 46630, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" });
  });
});

const live = process.env.ROBINHOOD_LIVE_READ_TESTS === "1" ? describe : describe.skip;
live("Robinhood public RPC live reads (no transactions)", () => {
  it.each([
    ["mainnet", robinhoodMainnet, tradingContracts.mainnet],
    ["testnet", robinhoodTestnet, tradingContracts.testnet],
  ] as const)("verifies %s chain identity and deployed bytecode", async (_name, chain, contracts) => {
    const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
    expect(await client.getChainId()).toBe(contracts.chainId);
    const addresses = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) addresses.add(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(contracts);
    for (const address of addresses) {
      const code = await client.getCode({ address: address as `0x${string}` });
      expect(code, `${address} must have deployed bytecode`).toBeDefined();
      expect(code, `${address} must not be an EOA`).not.toBe("0x");
    }
  }, 30_000);
});
