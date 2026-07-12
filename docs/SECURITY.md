# Security Doctrine

“Military-grade” is marketing language, not a measurable guarantee. This system targets auditable, defense-in-depth custody and execution.

## Wallet guidance

1. Generate long-term keys only on a hardware wallet or audited MPC/HSM system. Never paste a seed into an agent, website, shell, chat, `.env`, cloud secret, or source repository.
2. Record the recovery phrase offline; use two geographically separated, tamper-evident backups. Test recovery with an empty wallet before funding.
3. Use a Safe-style multisig/vault for treasury funds. Give the agent a low-value execution wallet or scoped session key—not the treasury key.
4. Enforce per-transaction, per-token, daily, drawdown, destination, function-selector, chain, and expiry limits outside the model.
5. Require simulation and policy approval for every state change. Require human/multisig approval for withdrawals, new targets, unlimited approvals, upgrades, bridges, or limit increases.
6. Separate testnet and mainnet credentials, RPCs, databases, policies, and deployment identities. Mainnet configuration must not be inferred from environment defaults.
7. Revoke token approvals and session keys after use. Monitor balances and approvals from an independent watcher.

## Threats explicitly addressed

Prompt/tool injection, arbitrary calldata, malicious token metadata, compromised RPC/indexer, stale quotes, chain reorgs, nonce races, sandwich/MEV, approval theft, signer compromise, dependency compromise, replay, policy drift, audit tampering, and runaway strategies.

## Residual risk

Smart-contract exploits, chain/sequencer failures, bridge risk, oracle manipulation, hardware/MPC vendor compromise, governance upgrades, and novel attacks cannot be eliminated. Production requires external audits, continuous monitoring, incident drills, capped canary capital, and insurance/operational reserves where appropriate.
