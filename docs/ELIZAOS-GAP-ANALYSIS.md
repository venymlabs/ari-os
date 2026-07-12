# ElizaOS Gap Analysis

Inspected upstream ElizaOS commit `12502f6aa5a0bf8885a45fd7f0beee1ab64829c5` (2026-07-11), MIT licensed.

## What is worth retaining

`AgentRuntime` and its actions, providers, evaluators, services, routes, models, and event handlers are useful as the probabilistic reasoning and integration plane. Wallet backend abstraction, Viem support, confirmation UX, dry-run modes, prompt-injection guards, rate limiting, and the early spending-policy work are useful foundations.

## Why it cannot own the transaction boundary

- Local mode materializes private-key accounts inside the agent process.
- Missing EVM keys may be generated and persisted as `EVM_PRIVATE_KEY`.
- Wallet export exists.
- Autonomous limits are in-memory trade counts rather than durable notional, exposure, or loss controls.
- Policy state and purported immutable logs are in-memory and not tamper-evident.
- Prepare/dry-run does not consistently simulate the exact serialized transaction.
- Conversation confirmation is UX, not high-assurance authorization.
- Plugins execute in the runtime trust domain and can potentially access secrets, networking, and signing APIs.

## Our boundary

ElizaOS may propose a versioned `TradeIntent`. It gets no raw signer, arbitrary calldata, unrestricted RPC writes, secret material, policy mutation, nonce replay, or transaction retry authority.

The independent deterministic plane owns:

1. Canonical intent normalization and idempotency.
2. Independent quote and market validation.
3. Durable risk and policy evaluation.
4. Audited ABI/calldata construction.
5. Exact-byte simulation against pinned state.
6. Approval workflow.
7. Isolated HSM/MPC/Safe signing.
8. Nonce-fenced broadcast.
9. Receipt/finality/reorg reconciliation.
10. Tamper-evident audit and independent telemetry.

Execution lifecycle:

`PROPOSED → VALIDATED → RISK_APPROVED → BUILT → SIMULATED → AUTHORIZED → SIGNED → BROADCAST → INCLUDED → FINALIZED`

Terminal states include `REJECTED`, `EXPIRED`, `CANCELLED`, `REPLACED`, `REORGED`, and `RECONCILIATION_REQUIRED`.

The result is not “ElizaOS with a safer wallet.” It is a deterministic financial control plane where AI has bounded proposal authority.
