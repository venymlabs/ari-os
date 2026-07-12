# Independent Robinhood Agent OS Implementation Plan

> **For Hermes:** Execute with strict TDD and independent review gates.

**Goal:** Turn the Robinhood market/execution toolkit into a standalone, persistent, extensible agent operating system comparable to Hermes/OpenClaw but purpose-built for autonomous trading.

**Architecture:** A TypeScript monorepo separates the probabilistic agent runtime from deterministic market, policy, simulation, and signing services. The runtime gets provider routing, typed tool registry, durable sessions, memory, skills, context compression, jobs, delegation, gateways, checkpoints, and observability. Trading remains behind a capability-restricted execution gateway.

**Tech Stack:** Node 22, TypeScript, pnpm workspaces, Fastify, SQLite/Postgres adapters, Zod, Viem, Vitest, OpenTelemetry interfaces.

---

## Runtime foundation

1. Create `packages/core` with provider-neutral model/message/tool types.
2. Create a capability-aware tool registry with schemas, toolsets, requirements, timeouts, cancellation, and audit hooks.
3. Build the agent loop with iteration/token/cost budgets and parallel read-only tool execution.
4. Add provider adapters for OpenAI-compatible, Anthropic, OpenRouter, and local endpoints.
5. Add retry/fallback routing, credential references, model metadata, and usage accounting.
6. Add deterministic tool-result envelopes, large-result storage, and prompt-injection provenance labels.

## Persistence and intelligence

7. Build SQLite session/message/tool-call store with FTS5 search, branches, titles, and resumability.
8. Add append-only event journal and startup reconciliation.
9. Add user memory and operational memory stores with atomic mutation and size limits.
10. Add filesystem skills with discovery, versioning, linked assets, and explicit loading.
11. Add context files and prompt assembly with stable prompt caching.
12. Add token-aware context compression that preserves tool-call/result integrity and financial decisions.
13. Add checkpoints/rollback for non-chain filesystem work; explicitly label chain actions irreversible.

## Autonomous operation

14. Build durable job queue with retries, leases, heartbeats, cancellation, and dead-letter state.
15. Add bounded subagents with isolated contexts, budgets, tool capability manifests, and result verification.
16. Add cron schedules, webhooks, market-event triggers, and continuable deliveries.
17. Add background process registry with output capture, readiness patterns, termination, and orphan cleanup.
18. Add event bus for launches, swaps, liquidity changes, alerts, policy violations, and execution lifecycle events.
19. Add workflow state machines for research, monitoring, simulation, approval, execution, reconciliation, and incident response.

## Interfaces

20. Build CLI commands for chat, models, tools, skills, sessions, jobs, status, wallet, markets, and simulation.
21. Build HTTP/SSE/WebSocket agent API with authenticated sessions and streamed tool progress.
22. Build Telegram gateway first, with Discord/Slack adapter interfaces afterward.
23. Build a web terminal/dashboard consuming the existing Birdeye-style utility API and agent event stream.
24. Add approval inbox with typed decoded transactions, simulation state diffs, policy hashes, expiry, and quorum.

## Plugin and security architecture

25. Define signed plugin manifests, permissions, tool capabilities, filesystem scopes, and network egress scopes.
26. Run third-party plugins in worker threads or containers with no signer credentials.
27. Add URL/path/command safety, secret redaction, SSRF protection, dependency/SBOM scanning, and plugin provenance.
28. Add independent policy/risk/simulation services and exact-byte signer verification.
29. Add global/per-strategy kill switches, rate/notional/exposure/drawdown limits, and emergency session revocation.
30. Add structured logs, traces, metrics, audit-root export, health checks, and incident alerts.

## Acceptance gates

- A session can survive restart and resume with tool-call integrity.
- The runtime can switch model providers without changing tools or session state.
- Skills and memories persist independently and are explicitly auditable.
- Background jobs recover from process death without duplicate execution.
- Every trading action follows typed intent → risk → policy → exact simulation → approval/signing policy → reconciliation.
- No model/plugin process can access private keys or unrestricted signing.
- Market discovery, charts, holders, risk, and simulation function without real funds.
- Full unit, property, integration, chaos, and adversarial tests pass before mainnet signing is enabled.
