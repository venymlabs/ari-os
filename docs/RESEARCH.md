# Verified Robinhood Chain Integration Research

Verified July 2026 against official Robinhood documentation, live RPCs, Blockscout, and primary NOXA documentation.

## Networks

| Property | Mainnet | Testnet |
|---|---|---|
| Chain ID | `4663` | `46630` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Gas | ETH | Test ETH |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Faucet | — | `https://faucet.testnet.chain.robinhood.com/` |

Official configuration: https://docs.robinhood.com/chain/connecting/

Robinhood Chain is an Arbitrum Nitro Ethereum L2 using Ethereum blobs for data availability. Official documentation currently describes BoLD dispute resolution through a **permissioned validator set**. Sequencer topology, upgrade governance, validator identities, and Robinhood-specific audit reports remain unknown.

## NOXA Fun

NOXA launches are immediately tradeable through permanently locked, single-sided Uniswap V3 concentrated liquidity at the 1% fee tier. “Graduation” is a net-buying/liquidity threshold, not a later migration from a proprietary curve. Robinhood’s documented target is 4.2 ETH.

### Verified deployment

| Component | Address |
|---|---|
| Launch Factory | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` |
| Permanent LP Locker | `0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85` |
| Fee Router | `0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417` |
| WETH/pair token | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Factory start block | `61688` |

Canonical discovery uses the factory `TokenLaunched` event, followed by `getLaunchedToken(token)` and token-side `launchFactory()` verification. Index each emitted V3 pool’s `Swap`, `Mint`, `Burn`, and `Collect` events. Simulate early trades because launch-block and restriction-window reverts are intentional and must not be mislabeled as honeypots.

Primary docs:

- https://docs.noxa.fi/launchpad/overview/
- https://docs.noxa.fi/contracts/noxa-fun/
- https://docs.noxa.fi/integrations/launchpad/

## Data sources

1. Direct RPC/factory logs — canonical discovery.
2. V3 event index + `slot0`/`liquidity`/Multicall3 — trading state.
3. Self-hosted indexer/Postgres — history and candles.
4. Blockscout — ABI/source, holders, transfers, reconciliation.
5. DEX Screener and GeckoTerminal — independent enrichment/cross-check.
6. NOXA frontend REST — optional and non-authoritative; unpublished API, no SLA.

## Bags status

A Robinhood Chain Bags deployment could not be independently verified. No canonical factory, router, API, WebSocket, transaction, or EVM mechanics were found. The adapter remains disabled until a primary announcement and deployed factory transaction are available. We will not invent a Bags integration based on Solana assumptions.

## Stock Tokens

Stock Tokens are 18-decimal, non-rebasing ERC-20 tokenized debt securities providing economic exposure—not shareholder ownership. Launch execution is documented as RFQ-based, so a Chainlink feed is not an executable quote and continuous AMM liquidity must not be assumed. Eligibility restrictions and sequencer/oracle freshness checks are mandatory. Public RFQ, redemption, eligibility, and corporate-action APIs remain unresolved dependencies.
