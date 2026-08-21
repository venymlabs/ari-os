# ARI OS — Solana unification

**Decided 2026-08-21.** ARI OS becomes a Solana-only autonomous trading agent OS.
The Robinhood Chain / EVM path is retired. `venymlabs/aetheria` is absorbed and
archived. One codebase, one kernel, one story.

This plan supersedes `docs/INTEGRATION-CHECKLIST.md`, which is a pre-build audit
from 2026-07-12 and no longer describes reality.

## Why

Two codebases independently implemented the same idea against different chains:

| Concern | ARI OS | Aetheria |
|---|---|---|
| Chokepoint | `execution/gateway.ts` + authorization envelopes | `kernel/trade-gateway.ts` |
| Policy | `execution/control` | `kernel/policy-engine.ts` |
| Recovery | ExecutionStore + reconciler | `kernel/reconciler.ts` |
| Custody | isolated signer daemon, **separate process** | in-process vault (scrypt→AES-256-GCM) |
| Spend caps | native-unit reservations | **input-leg denominated** |

Neither dominates. The merged kernel keeps **ARI OS's process architecture** and
adopts **Aetheria's input-leg cap semantics**.

The input-leg rule is the one non-obvious decision worth stating plainly: caps are
denominated in the asset *leaving* the wallet, so no price oracle sits in the
safety path and no oracle manipulation can widen a limit.

## Scope of the EVM retirement

17 files import `viem`. They fall into three groups.

**Delete — EVM-only, no Solana analogue:**

- `src/market/uniswap-v3.ts` — replaced by Jupiter + Meteora readers
- `src/indexers/noxa.ts`, `src/noxa.ts` — RH Chain launchpad, no Solana meaning
- `src/trading/contracts.ts` — RH Chain contract addresses
- `src/chain.ts` — EVM chain definitions
- `src/demo.ts` — EVM read-only demo

**Rewrite — the concept survives, the chain mechanics do not:**

- `src/signer/index.ts` + `src/bin/signer.ts` — secp256k1 → Ed25519. The isolated
  process boundary, one-time envelopes, and policy re-check all survive unchanged;
  only key handling and transaction decoding are replaced.
- `src/execution/rpc-simulator.ts` — the deepest rewrite. EVM pinned-block
  `eth_call` / EIP-1898 / `debug_traceCall` / state overrides have no Solana
  equivalent. Solana uses `simulateTransaction` with account returns,
  `replaceRecentBlockhash`, and `getFeeForMessage`.
- `src/execution/authorization/index.ts` — envelopes bind to tx identity + nonce.
  Solana has no account nonce; recent-blockhash expiry replaces it.
  **Blockhash expiry is terminal — never re-sign.** Aetheria already implements
  this; port that semantic directly.
- `src/execution/gateway.ts`, `src/execution/simulation.ts`, `src/live-trading/`,
  `src/tools/`, `src/config/`, `src/app/index.ts`, `src/cli/user-workflow.ts`

**Keep — already chain-agnostic:**

`src/risk`, `src/adapters`, `src/agent`, `src/api`, `src/autonomy`, `src/cognition`,
`src/gateway`, `src/observability`, `src/plugins`, `src/storage`, `src/workers`

## Port in from Aetheria

Aetheria's Solana coupling is only 5 files — the rest is chain-agnostic and moves
as-is.

- **Solana adapters (5 files):** `integrations/{rpc,broadcaster,jupiter}.ts`,
  `wallet/{local-wallet,smoke}.ts` → `src/chains/solana/`
- **Kernel semantics:** input-leg cap denomination, blockhash-expiry-is-terminal,
  idempotency ledger, persist-signed-tx-before-broadcast
- **Chain-agnostic packages:** `channel-telegram`, `mcp`, `memory`, `strategy`,
  `data` (PumpPortal trade tape + rug-heat signals)

## New capability packages

Built in parallel, each self-contained with its own tests, ported in as `src/`
subdirectories:

- `src/perps/` — venue-agnostic `PerpsVenue` port + Drift v2 adapter. Guards:
  leverage cap, notional/collateral caps in the input leg, minimum liquidation
  distance, funding sanity, portfolio exposure cap. All fail-closed.
- `src/pools/` — Meteora DLMM (bin-step semantics, position ranges, distribution
  strategies) + rebalancer (drift threshold, min interval, daily cap, IL-vs-fees
  accounting) + pump.fun bonding curve, delegating post-migration tokens to Jupiter.
- `web/` — dashboard in the ARI OS design language (obsidian `#050706`, bone
  `#eef1e9`, acid `#b6ff36`; Inter 500 `-0.05em`, Instrument Serif italic, IBM Plex
  Mono for machine state). Approvals queue is the centrepiece.

## Structure

ARI OS stays a **single npm package**. It already organises by `src/execution`,
`src/signer`, `src/market`, `src/risk` — Solana lands as `src/chains/solana/` and
the new work as `src/perps/`, `src/pools/`. Converting to pnpm+turbo would be churn
without benefit.

## Known hazards

- **Deploy files are asserted byte-for-byte by tests** (`compose.yaml`, `deploy/`).
  Docs strings (`TRADING.md`, README command lists) are also test-asserted. This
  refactor changes both; the assertions must be updated deliberately, never
  reformatted casually.
- **Licence.** ARI OS is MIT, Aetheria is Apache-2.0. Apache code may be included
  under MIT but carries attribution and patent-grant terms — the merged repo needs
  a NOTICE and `THIRD_PARTY_NOTICES.md` entries. Cannot be done silently.
- **Dependency budget.** Production deps are currently four libraries (`fastify`,
  `viem`, `zod`, `yaml`). Dropping `viem` but adding `@solana/web3.js`,
  `@drift-labs/sdk`, and `@meteora-ag/dlmm` is a large net expansion under a CI
  gate that runs `npm audit --omit=dev`. Expect the audit surface to grow.
- **Test suite.** 54 files / 401 tests are written against EVM semantics. A large
  fraction must be rewritten, not merely adjusted.

## Sequencing

1. Land the pending lockfile fix so CI is green before the refactor begins.
2. Introduce `src/chains/solana/` and port the Aetheria adapters.
3. Rewrite signer (Ed25519) and simulator (`simulateTransaction`) behind the
   existing execution interfaces.
4. Port the chain-agnostic Aetheria packages.
5. Port `perps`, `pools`, `web`.
6. Delete the EVM modules and drop `viem`, once nothing imports them.
7. Rewrite the affected tests, deploy assertions, and docs.
8. Archive `venymlabs/aetheria` with a README pointing here.

Step 6 comes late deliberately: keeping the EVM path importable until the Solana
path is proven means the tree stays buildable throughout.
