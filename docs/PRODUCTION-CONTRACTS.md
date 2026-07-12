# Production trading contracts and RPC behavior

Verified **2026-07-12 UTC** from primary documentation and non-transactional reads against the public RPCs. Addresses appear in `src/trading/contracts.ts` only when an official source named the deployment and `eth_getCode` returned non-empty runtime bytecode. **Do not copy same-address deployments from another EVM network.**

## Networks and RPC behavior

| Property | Mainnet | Testnet |
|---|---|---|
| Chain ID (`eth_chainId`) | `4663` (`0x1237`) | `46630` (`0xb626`) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Sequencer endpoint | `https://sequencer.mainnet.chain.robinhood.com` | `https://sequencer.testnet.chain.robinhood.com` |
| Native gas token | ETH, 18 decimals | ETH, 18 decimals |

Robinhood calls the public endpoints rate-limited and unsuitable for production. Use a paid/provider endpoint and an archive endpoint for historical indexing. Both public RPCs answered standard `eth_blockNumber`, `eth_getCode`, `eth_call`, `eth_getLogs`, `eth_feeHistory`, `eth_getBlockReceipts`, and block-tag reads for `safe` and `finalized` during verification.

Observed snapshots (not protocol constants): mainnet latest/safe/finalized were `7,540,047 / 7,535,295 / 7,531,125`; testnet were `89,569,665 / 89,566,552 / 89,566,552`. A 100-block sample spanned about 10 seconds on mainnet and 30 seconds on testnet, with multiple blocks sharing timestamps. Do not encode a fixed block time or confirmation count. Pin simulations to a block hash/number and choose a confirmation/finality policy appropriate to the action.

Source: [Robinhood Connecting](https://docs.robinhood.com/chain/connecting/). Robinhood describes the chain as an Arbitrum L2 using Ethereum blobs for data availability.

## Mainnet tokens

| Contract | Address | Live read |
|---|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `name=WETH`, `symbol=WETH`, `decimals=18`; bytecode present |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `name=Global Dollar`, `symbol=USDG`, `decimals=6`; proxy bytecode present |

Source: [Robinhood Token Contracts](https://docs.robinhood.com/chain/contracts/). This page names **USDG**, not USDC/USDT, as the canonical stablecoin. No other stablecoin is codified here.

## Canonical Uniswap V3 mainnet deployment

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| UniswapInterfaceMulticall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` |
| TickLens | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| NonfungiblePositionManager | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| NonfungibleTokenPositionDescriptor | `0x6f84dae9c064ff453e5c8af51efb819f8f610225` |
| NFTDescriptor | `0x2e9d45bb7b30549f5216813ada9a6b7982c5b3ed` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |

Every address returned runtime bytecode. Factory reads returned owner `0x2BAD8182C09F50c8318d769245beA52C32Be46CD` and tick spacing `200` for fee tier `10000`. Source: [official Uniswap Robinhood Chain deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments). Uniswap recommends UniversalRouter as the current entry point; SwapRouter02 remains the standard V3 router. Quote with QuoterV2 via `eth_call`—its quote functions are intentionally not Solidity `view` functions.

## NOXA Fun mainnet

| Contract | Address |
|---|---|
| LauncherFactory | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` |
| Launch Locker | `0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85` |
| Pair token (WETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Factory deployment/start block | `61688` |

Sources: [NOXA Fun contracts](https://docs.noxa.fi/contracts/noxa-fun/) and [NOXA integration guide](https://docs.noxa.fi/integrations/launchpad/). Runtime bytecode was present at all four addresses. The factory `owner()` read returned `0x7E035Fb048a31e0481b88074557415b1C187242B`.

There is no proprietary NOXA Fun swap router or bonding-curve trading method. A launch targets a V3 DEX and is traded through that DEX's normal router/quoter. Discover `TokenLaunched(...)` logs, then verify `getLaunchedToken(token).exists`, optionally corroborating token `launchFactory()`. The token exposes `liquidityPool()`, `pairToken()`, and `poolFee()` (currently documented as `10000`). Public buys from the pool are blocked in the launch block; while `launchBlock < block.number <= restrictionEndBlock`, max-wallet and max-transaction restrictions can revert transfers. On Arbitrum, NOXA documents `block.number` as the L1 height for this restriction check.

The separate [NOXA DEX contracts page](https://docs.noxa.fi/contracts/noxa-dex/) does **not** list chain 4663. Therefore no NOXA DEX factory/router/quoter is claimed for Robinhood Chain. NOXA launches whose event `dexFactory` equals the canonical Uniswap factory use the Uniswap contracts above; integrations must branch on the emitted factory rather than assume it.

## Testnet status

The official Robinhood network page verifies chain `46630`, RPC, explorer, and feed. The official Robinhood token page, Uniswap Robinhood deployment page, and NOXA contract pages do not publish testnet trading deployments. Live `eth_getCode` returned `0x` on testnet for every mainnet WETH, USDG, Uniswap, and NOXA address probed. Those addresses are consequently **not** exported as testnet contracts. Canonical Multicall3 `0xcA11…CA11` does have runtime bytecode and is the sole codified testnet utility.

## Reproduce safely

Run deterministic address tests normally; opt into public-RPC reads explicitly:

```bash
npm test -- tests/trading-contracts.live.test.ts
ROBINHOOD_LIVE_READ_TESTS=1 npm test -- tests/trading-contracts.live.test.ts
```

The live suite performs only `eth_chainId` and `eth_getCode`. It never signs, sends, or broadcasts a transaction. RPC observations are point-in-time evidence; re-run before enabling funded execution and monitor official notices for upgrades.

## Aggregate reservation accounting

Aggregate caps use one explicit quote denomination and decimal precision for the entire ledger. `ReservationLedger.reserveWithin` checks every active reservation inside the same `BEGIN IMMEDIATE` transaction; a row with a missing valuation/evidence, a different denomination, or a different precision blocks the new aggregate reservation. Legacy migration rows without valuation therefore fail closed until they expire, are released, or are reconciled. Configure `aggregateQuote` on the ledger to pin the deployment-wide denomination and precision; values in another unit are never treated as a separate bucket.
