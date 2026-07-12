# Third-Party Notices and Provenance

Robinhood Agent OS is MIT licensed. Production dependencies are independently licensed:

| Package | License | Purpose |
|---|---|---|
| Fastify and `@fastify/cors` | MIT | HTTP server and CORS |
| viem | MIT | EVM RPC/types |
| yaml | ISC | YAML parsing |
| zod, zod-to-json-schema | MIT | Validation/schema conversion |

The authoritative inventory is `package-lock.json`; verify before each release with `npm query ':attr(type, prod)'` and `npm audit`. Transitive copyright notices remain in each package. No license here supersedes dependency terms.

Design terminology draws from common agent-runtime and Ethereum ecosystem patterns. No upstream source file is knowingly copied verbatim beyond material permitted by its license. Release operators must review dependency changes and regenerate this table.
