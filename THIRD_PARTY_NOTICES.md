# Third-Party Notices and Provenance

Robinhood Agent OS is MIT licensed. Production dependencies are independently licensed:

| Package | License | Purpose |
|---|---|---|
| Fastify and `@fastify/cors` | MIT | HTTP server and CORS |
| viem | MIT | EVM RPC/types |
| `@solana/web3.js` | MIT | Solana RPC/types, transaction wire format |
| bs58 | MIT | base58 signature and key encoding |
| yaml | ISC | YAML parsing |
| zod, zod-to-json-schema | MIT | Validation/schema conversion |

The authoritative inventory is `package-lock.json`; verify before each release with `npm query ':attr(type, prod)'` and `npm audit`. Transitive copyright notices remain in each package. No license here supersedes dependency terms.

### Removed: `@solana/spl-token`

ARI OS used exactly four things from `@solana/spl-token` — the `TOKEN_PROGRAM_ID`,
`TOKEN_2022_PROGRAM_ID` and `ASSOCIATED_TOKEN_PROGRAM_ID` addresses, and
`createAssociatedTokenAccountIdempotentInstruction`. The package reaches
`bigint-buffer` through `@solana/buffer-layout-utils`, and `bigint-buffer` carries an
unpatched high-severity buffer-overflow advisory
([GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)) whose latest
published release is still the vulnerable one — there is nothing to upgrade to.

Those four are now `src/chains/solana/spl.ts`: a clean-room implementation carrying no
upstream source. The program ids are public on-chain addresses (verified against the
`declare_id!` literals in the `solana-program/{token,token-2022,associated-token-account}`
interface crates), and the instruction is built from the ATA program's documented wire
format. `tests/solana-spl.test.ts` pins the derived addresses and the exact serialised
instruction against values captured from `@solana/spl-token@0.4.15` before removal.

### `overrides`

`jayson` (via `@solana/web3.js`) declares `uuid: ^8.3.2`, and `uuid` below `11.1.1`
carries [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — a
missing buffer bounds check in `v3`/`v5`/`v6` when a `buf` argument is supplied.
`jayson` only ever calls `v4()` with no arguments, for JSON-RPC request ids, so the
advisory is unreachable through this dependency path; the override is defence in depth
rather than a fix for live exposure. `uuid@11` still ships a CommonJS entry point, so
`jayson`'s `require('uuid').v4` resolves unchanged — verified by driving a
`@solana/web3.js` `Connection` through a real HTTP round-trip and asserting the emitted
request id.

### Optional peer dependencies (not installed, not in the lockfile)

| Package | License | Purpose |
|---|---|---|
| `@drift-labs/sdk` | Apache-2.0 | Drift v2 perpetuals — required only to run `src/perps` against Drift |
| `@meteora-ag/dlmm` | MIT | Meteora DLMM — required only to run `src/pools` against a live pool |

Both are declared `optional` in `peerDependenciesMeta`, so npm does not install
them, they add nothing to `npm audit --omit=dev`, and they are absent from the
published tarball. `src/perps/drift/drift-venue.ts` and
`src/pools/meteora/sdk-port.ts` load them through a variable specifier at first
use and fail closed with the install command when they are missing. An operator
who installs either one takes on its license terms and its audit surface.

## Incorporated source: Aetheria (Apache-2.0)

`src/kernel/`, `src/vault/`, `src/chains/solana/`, `src/perps/` and `src/pools/`
incorporate source derived from
**Aetheria** (<https://github.com/venymlabs/aetheria>), Copyright 2026 Venym Labs,
licensed under the Apache License, Version 2.0.

- The full license text ships at `licenses/APACHE-2.0.txt`.
- `NOTICE` at the repository root lists every derived file, its upstream path, and
  the modifications made to it, as required by Apache-2.0 §4(b)–(d).
- Apache-2.0 permits this inclusion in an MIT-licensed distribution, but the Apache
  terms — attribution, the express patent grant, and the patent-litigation
  termination clause in §3 — continue to govern those files. The MIT license in
  `LICENSE` does not supersede them.
- Derived files carry an `SPDX-License-Identifier: Apache-2.0` header pointing at
  `NOTICE`. Do not strip those headers; do not relicense those files.

Downstream redistributors must ship `NOTICE` and `licenses/APACHE-2.0.txt` alongside
the code. Both are listed in the package `files` array so `npm pack` includes them.

Aside from the material identified above, design terminology draws from common
agent-runtime, Ethereum and Solana ecosystem patterns, and no upstream source file is
knowingly copied verbatim beyond material permitted by its license. Release operators
must review dependency changes and regenerate this table.
