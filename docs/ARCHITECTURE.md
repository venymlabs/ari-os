# Architecture

## Control plane

User/strategy → typed intent → deterministic planner → quote freshness check → simulation → policy kernel → signer policy → broadcaster → receipt reconciler.

The LLM is outside the trusted computing base. It can request typed tools but cannot submit calldata, choose unrestricted targets, bypass limits, or access signing material.

## Data plane

RPC/WebSocket + Blockscout + protocol adapters → reorg-aware canonical event store → token/pool index → pricing/OHLCV → risk features → strategy observations.

Every adapter reports provenance, block number, finality status, timestamp, and confidence. Conflicting market sources fail closed for execution.

## Security plane

Principal authentication, scoped session capabilities, allowlists, spend/position limits, simulation, approval hygiene, isolated signing, audit journal, circuit breakers, and emergency revocation are independent controls. No single model/tool compromise should move unrestricted funds.

## Tool families

- Chain: health, balances, blocks, receipts, gas, simulation
- Discovery: factories, pools, launches, trending, holders, liquidity
- Analysis: price, OHLCV, flow, concentration, tax/honeypot/proxy risk
- Portfolio: positions, P&L, exposure, reconciliation
- Execution: quote, approve-exact, swap, cancel/replace, revoke
- Safety: policy explain, dry-run, pause, revoke-session, emergency exit

Protocol-specific execution adapters for NOXA/Bags remain blocked until their canonical contracts and APIs are independently verified.
