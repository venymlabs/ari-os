# Robinhood Agent OS Implementation Plan

> **For Hermes:** Implement task-by-task with test-first development.

**Goal:** Build a testnet-first, non-custodial agent operating system for secure discovery, analysis, risk control, simulation, and execution on Robinhood Chain.

**Architecture:** TypeScript monorepo with strict domain boundaries. LLMs may propose intents but never construct or sign arbitrary transactions. A deterministic policy kernel converts validated intents into constrained execution plans, simulates them, applies risk and allowlist controls, and routes approved payloads to isolated signer adapters. Market ingestion is event-driven and reorg-aware; all decisions are hash-chained into a tamper-evident audit journal.

**Tech Stack:** Node 22, TypeScript, pnpm workspaces, viem, Zod, Vitest, Fastify, Pino, OpenTelemetry-compatible interfaces, Docker Compose.

---

## Milestone 1 — Verified vertical slice

1. Create workspace, strict TypeScript configuration, package boundaries, and CI scripts.
2. Write failing tests for Robinhood testnet chain configuration and live RPC health.
3. Implement verified testnet chain configuration (chain ID 46630) and JSON-RPC client.
4. Write failing tests for typed trade intents and rejection of arbitrary calldata.
5. Implement intent schemas and deterministic intent normalization.
6. Write failing tests for policy limits, token/target allowlists, expiry, nonce, slippage, and spend ceilings.
7. Implement deny-by-default policy kernel.
8. Write failing tests for hash-chained audit journal and tamper detection.
9. Implement append-only tamper-evident audit journal.
10. Write failing tests for transaction simulation gate and signer isolation.
11. Implement simulation-first executor with a read-only/dry-run signer default.
12. Build a CLI that checks the Robinhood testnet RPC and runs a safe dry-run policy demo.
13. Run unit, integration, typecheck, lint, and build; preserve real output.

## Milestone 2 — Market intelligence

14. Implement reorg-aware Blockscout/RPC ingestion with finalized/provisional states.
15. Add token factory/launchpad adapters for NOXA and Bags after contract/API verification.
16. Add Uniswap V2/V3 pool discovery, swap decoding, reserve/liquidity snapshots, OHLCV aggregation, and websocket streaming.
17. Add honeypot/tax/ownership/proxy/liquidity concentration checks and confidence-scored token metadata.
18. Add watchlists, alerts, strategy inputs, and a real-time terminal/API.

## Milestone 3 — Production custody and execution

19. Implement signer adapters for hardware wallets, Safe multisig/modules, and managed MPC/HSM providers; never persist seed phrases.
20. Add EIP-712 intent signing, session keys with scoped permissions, dual control, withdrawal delays, and emergency revocation.
21. Add Uniswap/NOXA execution adapters, quote comparison, MEV-aware submission, approval hygiene, and post-trade reconciliation.
22. Add portfolio, P&L, tax lots, limits, circuit breakers, dead-man switch, and incident response.
23. Complete threat modeling, dependency/SBOM scanning, fuzz/property tests, fork tests, chaos tests, audit preparation, and staged mainnet rollout.

## Security invariants

- The model cannot access key material, signer credentials, raw signing methods, or unrestricted RPC write methods.
- No arbitrary destination, calldata, permit, approval, delegatecall, upgrade, bridge, transfer, or token launch is executable without an explicit typed tool and policy.
- Every state-changing action requires: authenticated principal → typed intent → deterministic planner → fresh quote → simulation → policy decision → signer policy → broadcast → receipt reconciliation.
- Default mode is read-only. Testnet signing is opt-in. Mainnet requires a separate configuration, independent credentials, explicit deployment approval, and minimum-value canary.
- “Military-grade” is not a security property. Claims must name concrete controls, assumptions, audits, and residual risks.
