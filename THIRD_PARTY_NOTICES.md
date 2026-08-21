# Third-Party Notices and Provenance

Robinhood Agent OS is MIT licensed. Production dependencies are independently licensed:

| Package | License | Purpose |
|---|---|---|
| Fastify and `@fastify/cors` | MIT | HTTP server and CORS |
| viem | MIT | EVM RPC/types |
| `@solana/web3.js` | MIT | Solana RPC/types, transaction wire format |
| `@solana/spl-token` | Apache-2.0 | SPL Token / Token-2022 program ids and account layouts |
| bs58 | MIT | base58 signature and key encoding |
| yaml | ISC | YAML parsing |
| zod, zod-to-json-schema | MIT | Validation/schema conversion |

The authoritative inventory is `package-lock.json`; verify before each release with `npm query ':attr(type, prod)'` and `npm audit`. Transitive copyright notices remain in each package. No license here supersedes dependency terms.

## Incorporated source: Aetheria (Apache-2.0)

`src/kernel/`, `src/vault/` and `src/chains/solana/` incorporate source derived from
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
