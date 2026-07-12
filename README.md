# Robinhood Agent OS

A testnet-first agent runtime and read-only market/execution-safety toolkit for Robinhood Chain. **Signing and transaction broadcast are disabled.**

## Quickstart

Requires Node.js 22+.

```bash
npm ci
npm run verify
npm start                       # http://127.0.0.1:8787
curl -fsS http://127.0.0.1:8787/readyz
npm run cli -- --help
npm run cli -- status           # set RAOS_API_URL=http://127.0.0.1:8787
npm run cli -- simulate @request.json
cat request.json | npm run cli -- simulate -
```

The package installs the `raos` binary. `raos --help` and `raos --version` are local and do not initialize model or Telegram providers. Machine output is JSON with stable `ok`, `result`, or `error` fields.

## Server topology

One Fastify listener serves operational endpoints and the versioned API on `HOST`/`PORT` (defaults `127.0.0.1:8787`). `/livez`, `/readyz`, `/metrics`, `/version`, and `/openapi.json` are unauthenticated for orchestrators. Put the service behind a TLS identity-aware reverse proxy before exposing it. Readiness is distinct from liveness; SIGTERM/SIGINT stop ingress gracefully.

## Telegram

Long polling uses a durable update offset and numeric allowlists. Both user identity and, when configured, chat identity must match; the empty allowlist denies everyone. Startup calls `getMe`. Telegram 429 responses honor bounded retry delays. Approval commands must be attached to the durable approval service; parsing a command never grants approval by itself. Do not use usernames as identity.

## Deployment and state

`Dockerfile` runs as non-root and supports a read-only root filesystem; writable state is `/var/lib/raos`. `compose.yaml` deliberately uses one SQLite-backed writer set and optional worker/Telegram profiles. Run migration once before services. Hardened units are under `deploy/systemd/`. Backup/restore and incident procedures are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Threat boundaries

- Testnet/read-only default; no signer, private-key account, broadcast, or hot-wallet claim.
- Provider/RPC/Telegram responses are untrusted and bounded.
- API identity, tenant scopes, durable approvals, simulation, reconciliation, and audit must all remain fail-closed.
- Never put secrets in source, images, CLI arguments, Telegram, or logs.
- Do not horizontally scale SQLite writers.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
