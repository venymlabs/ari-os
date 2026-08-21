# Architecture

## Control plane

User/strategy → typed intent → deterministic planner → quote freshness and blockhash-liveness check → `simulateTransaction` → policy kernel → signer policy → broadcaster → signature-status reconciler.

The LLM is outside the trusted computing base. It can request typed tools but cannot submit raw instruction data, invoke an unpinned program, bypass limits, or access signing material.

## Data plane

Solana JSON-RPC + Jupiter + venue adapters → canonical event store → pricing/OHLCV → risk features → strategy observations.

Every adapter reports provenance, slot, commitment level, timestamp, and confidence. Conflicting market sources fail closed for execution.

There is no launchpad indexer in this repo. The reorg-correction machinery in `src/autonomy/events` survives because a `processed`-commitment read can still be superseded, but nothing currently produces chain events into it.

## Security plane

Principal authentication, scoped session capabilities, allowlists, spend/position limits, simulation, approval hygiene, isolated signing, audit journal, circuit breakers, and emergency revocation are independent controls. No single model/tool compromise should move unrestricted funds.

## Tool families

- Chain: health, SOL and SPL balances, slots, signature statuses, simulation
- Discovery: pools, trending, holders, liquidity
- Analysis: price, OHLCV, flow, concentration, mint-authority and rug-heat risk
- Portfolio: positions, exposure, reconciliation
- Execution: quote, swap, revoke delegate
- Safety: policy explain, dry-run, kill switch, emergency exit

Only the swap family is mounted in the shipped daemon. The perps, DLMM and bonding-curve toolsets require a `WalletProvider`, and the composition root supplies none until a bridge exists from the isolated signer's envelope interface to a raw-bytes wallet. Unmounted means the tools do not exist at runtime, which is the intended fail-closed default.
