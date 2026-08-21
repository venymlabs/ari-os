# Security Doctrine

“Military-grade” is marketing language, not a measurable guarantee. This system targets auditable, defense-in-depth custody and execution.

## Wallet guidance

1. Generate long-term keys only on a hardware wallet or audited MPC/HSM system. Never paste a seed into an agent, website, shell, chat, `.env`, cloud secret, or source repository.
2. Record the recovery phrase offline; use two geographically separated, tamper-evident backups. Test recovery with an empty wallet before funding.
3. Use a Safe-style multisig/vault for treasury funds. Give the agent a low-value execution wallet or scoped session key—not the treasury key.
4. Enforce per-transaction, per-token, daily, drawdown, program-ID, instruction-discriminator, cluster, and expiry limits outside the model. Denominate spend caps in the input leg — the asset leaving the wallet — so no price oracle sits in the safety path.
5. Require simulation and policy approval for every state change. Require human/multisig approval for withdrawals, new targets, unlimited approvals, upgrades, bridges, or limit increases.
6. Separate devnet and mainnet-beta credentials, RPCs, databases, policies, and deployment identities. Mainnet configuration must not be inferred from environment defaults; readiness re-checks the cluster genesis hash so an endpoint for the wrong cluster fails closed rather than serving.
7. Revoke SPL delegates and session keys after use. Monitor balances and delegations from an independent watcher.

## Threats explicitly addressed

Prompt/tool injection, arbitrary instruction data, malicious token metadata, compromised RPC or quote provider, stale quotes, cluster forks below finality, blockhash-expiry re-signing, sandwich/MEV, delegation theft, signer compromise, dependency compromise, replay, policy drift, audit tampering, and runaway strategies.

## Residual risk

Program exploits, cluster outages and forks, bridge risk, oracle manipulation, hardware/MPC vendor compromise, program upgrades under a live upgrade authority, and novel attacks cannot be eliminated. Production requires external audits, continuous monitoring, incident drills, capped canary capital, and insurance/operational reserves where appropriate.
