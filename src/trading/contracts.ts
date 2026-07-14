import type { Address } from "viem";

/**
 * Trading addresses with primary-source provenance and live bytecode verification.
 * See docs/PRODUCTION-CONTRACTS.md. Absence is intentional: never infer deployments.
 */
export const tradingContracts = Object.freeze({
  mainnet: Object.freeze({
    chainId: 4663,
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
    tokens: Object.freeze({
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
    }),
    uniswapV3: Object.freeze({
      factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as Address,
      interfaceMulticall:
        "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3" as Address,
      tickLens: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468" as Address,
      quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
      nonfungiblePositionManager:
        "0x73991a25c818bf1f1128deaab1492d45638de0d3" as Address,
      nonfungibleTokenPositionDescriptor:
        "0x6f84dae9c064ff453e5c8af51efb819f8f610225" as Address,
      nftDescriptor: "0x2e9d45bb7b30549f5216813ada9a6b7982c5b3ed" as Address,
      swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as Address,
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
      universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
    }),
    noxa: Object.freeze({
      launchFactory: "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB" as Address,
      launchLocker: "0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85" as Address,
      factoryStartBlock: 61_688n,
    }),
  }),
  // No official Robinhood/Uniswap/NOXA trading deployment was located on testnet.
  // Multicall3 is the sole tested, deployed utility address.
  testnet: Object.freeze({
    chainId: 46630,
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  }),
});
