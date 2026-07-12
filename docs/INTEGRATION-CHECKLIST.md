# Standalone Executable-System Integration Checklist

> **For Hermes:** Implement in order with strict TDD. Do not enable signing or mainnet execution merely because the read-only system boots.

**Goal:** Turn the currently tested library modules into one installable, configurable, persistent, observable, standalone Robinhood Agent OS with API, CLI, Telegram, workers, event/indexing loops, simulation, and dashboard entry points.

**Audit baseline (2026-07-12):** `npm run verify` does **not** pass: 26 suites / 238 tests pass, while `tests/observability.test.ts` cannot import missing `src/observability/index.ts` and `tests/plugins.test.ts` does not compile because `await` occurs in a non-`async` callback. Typecheck/build were consequently not reached. The repository directory has no `.git` metadata. No Dockerfile, Compose file, systemd unit, `.env.example`, dashboard application, package `bin`, root executable, or project license was found.

## What is implemented but disconnected

- Agent loop, OpenAI-compatible transport/router, capability tool registry, SQLite session store, cognition stores/skills/context, durable jobs, event bus/triggers, delegation, approvals, execution controls, gateway primitives, API factories, Telegram adapter, intelligence adapters, Uniswap V3 readers, OHLCV analytics, NOXA discovery, and simulation evidence primitives exist as independently tested modules.
- `src/demo.ts` is the only executable-style module. It performs a fixed read-only RPC demo; it is not a composition root.
- `src/api/index.ts` and `src/gateway/api/index.ts` return Fastify instances but nothing calls `listen()`.
- `src/cli/index.ts` only parses/dispatches against injected services; package metadata has no `bin` and no process entry invokes it.
- Telegram only maps updates and sends messages. There is no polling/webhook startup, offset persistence, dispatch into sessions/runtime, or graceful stop.
- Database schemas are created inline by constructors. There is no shared data-directory policy, migration command, backup/restore procedure, or migration lock/version registry across stores.
- Runtime/model/tool/session types are duplicated and incompatible at their seams. No adapter wires `ModelRouter` to `AgentRuntime`, `ToolRegistry` to the runtime dispatcher, or runtime persistence callbacks to `SessionStore`.
- Market/intelligence functions are not `ToolDefinition`s and are not registered in a production registry.
- `createNoxaTokenRegistry()` can scan a supplied range but has no checkpointed live indexer, canonical storage, polling/subscription loop, reorg rollback, event publication, or trigger connection.
- Simulation builds and validates evidence but has no live RPC simulation adapter. It does not call pinned-block `eth_call`, estimate gas, request traces/state diffs, use state overrides, decode revert data/logs, or derive asset deltas.
- The architecture mentions a dashboard, but no frontend source/build/serve path exists.

---

## Ordered implementation checklist

### 0. Restore a trustworthy green baseline

- [ ] Fix `tests/plugins.test.ts` so its verification callback is syntactically valid (make the callback async or import `verify` at module scope).
- [ ] Implement the missing `src/observability/index.ts` contract required by `tests/observability.test.ts`, or remove the test only if the observability requirement is explicitly withdrawn.
- [ ] Add `npm run clean` and make build remove stale `dist/` first; stale output currently masks missing source modules.
- [ ] Add `npm run test:unit`, `test:integration`, `test:smoke`, `lint` (or an explicit no-linter decision), `start`, `dev`, `cli`, `worker`, `indexer`, `dashboard:build`, `db:migrate`, and `db:check` scripts.
- [ ] Pin package-manager behavior (`packageManager`) and use `npm ci` in acceptance/CI.

**Acceptance**

```bash
cd /home/d/robinhood-agent-os
rm -rf dist node_modules
npm ci
npm run verify
# expected: all test files pass; typecheck exits 0; clean build exits 0
find dist -type f -name '*.js' | sort
# expected: only files generated from current src, including all executable entry points added below
```

### 1. Define validated configuration and filesystem layout

- [ ] Create `src/config/index.ts` with a strict Zod schema and a single `loadConfig(env, cwd)` function. Reject unknown/invalid security-critical values and report all missing required values without printing secrets.
- [ ] Define modes (`development`, `test`, `production`), network (`testnet` default; mainnet requires an explicit second opt-in), bind host/ports, auth, provider candidates, RPC/Blockscout URLs, Telegram mode, worker/indexer intervals, finality confirmations, trigger thresholds, CORS allowlist, log level, and shutdown timeout.
- [ ] Resolve one absolute `DATA_DIR` (default `${XDG_STATE_HOME:-~/.local/state}/robinhood-agent-os`) and create mode `0700`; use explicit child paths for `sessions.sqlite`, `jobs.sqlite`, `events.sqlite`, `triggers.sqlite`, `indexer.sqlite`, `memory/`, `skills/`, `logs/`, and `audit/`.
- [ ] Disallow `:memory:` outside tests and reject database paths outside `DATA_DIR` unless an explicit unsafe development override is set.
- [ ] Create `.env.example` containing names and safe placeholders only. Document which variables are required per process. Never include a private key; signer configuration must be a remote/HSM reference.
- [ ] Add startup preflight: Node >=22, writable data directory, RPC chain-ID match, required provider credentials, API auth secret/reference, Telegram allowlist/token when enabled, and no signing capability in read-only mode.

**Acceptance**

```bash
cp .env.example /tmp/raos.env
DATA_DIR=/tmp/raos-state NODE_ENV=test npm run config:check -- --env-file /tmp/raos.env
# expected: sanitized configuration summary and exit 0
DATA_DIR=relative npm run config:check -- --env-file /tmp/raos.env
# expected: non-zero with a precise absolute-path validation error
```

### 2. Centralize schema migrations and lifecycle

- [ ] Create versioned SQL migrations under `src/storage/migrations/{sessions,jobs,events,indexer}/` and a migration runner with transactional application, checksums, forward-only versioning, and an inter-process migration lock.
- [ ] Refactor store constructors to open already-migrated databases; do not silently mutate schemas during arbitrary API requests or worker startup.
- [ ] Add `db:migrate`, `db:status`, `db:integrity`, and documented backup/restore commands. Run `PRAGMA foreign_keys=ON`, WAL, busy timeout, integrity check, and WAL checkpoint intentionally.
- [ ] Make startup fail on newer/unknown schema versions or checksum drift. Define retention/vacuum policy without deleting immutable financial evidence/audit records.
- [ ] Add lifecycle ownership: exactly one composition object closes SessionStore, JobQueue, EventBus, trigger/indexer stores, Fastify, Telegram, and RPC watchers on SIGTERM/SIGINT.

**Acceptance**

```bash
rm -rf /tmp/raos-state && mkdir -m 700 /tmp/raos-state
DATA_DIR=/tmp/raos-state npm run db:migrate
DATA_DIR=/tmp/raos-state npm run db:migrate
DATA_DIR=/tmp/raos-state npm run db:status
DATA_DIR=/tmp/raos-state npm run db:integrity
# expected: second migration is a no-op; every schema current; integrity_check=ok
```

### 3. Build the composition root

- [ ] Create `src/app/index.ts` exporting `createApplication(config, overrides?)` and an `Application` lifecycle (`start`, `ready`, `stop`, dependency health).
- [ ] Instantiate shared clock/ID/logger/metrics, RPC clients, intelligence clients, stores, event bus, trigger engine, registry, model router, runtime/session service, approvals/execution services, jobs, NOXA indexer, API servers, and optional Telegram channel exactly once.
- [ ] Register event consumers and job handlers before accepting traffic. Run migrations and recovery before readiness becomes true.
- [ ] Separate liveness from readiness; readiness must fail for required DB/RPC/model dependencies and while recovery/migrations are incomplete.
- [ ] Add signal handling with idempotent shutdown: stop ingress, drain runs/jobs, checkpoint indexers, flush audit/logs, close DBs, and force exit non-zero after the configured deadline.
- [ ] Keep signing/broadcast dependencies absent by default. Composition must not import a local private-key account.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state NODE_ENV=test npm run smoke:composition
# expected: migrations -> recovery -> ready -> graceful stop, with no open-handle warning
```

### 4. Unify model, runtime, registry, and durable sessions

- [ ] Create explicit adapters rather than casting between duplicate interfaces: `ModelRouterProvider` maps model messages/responses/usage to runtime types; `RegistryDispatcher` maps runtime calls to `ToolRegistry.invoke`; define one authoritative effect mapping (`read`, `proposal`, `write/trade/admin`) that fails closed.
- [ ] Pass registry schemas to model requests and only expose tools allowed by tenant/session capabilities and current mode.
- [ ] Implement a session service that creates/resumes sessions, persists user/assistant/tool messages and runs, preserves tool-call IDs/arguments/results, and marks terminal run state on success/failure/cancel.
- [ ] Wire runtime `persistMessage` and `persistToolLifecycle` to atomic durable operations. Recover unfinished runs on startup into `failed`, `cancelled`, or `reconciliation-required` according to whether side effects may have occurred.
- [ ] Add cancellation controllers keyed by tenant/run ID and remove them on completion. API cancellation must reflect the actual runtime result, not unconditionally label a completed run cancelled.
- [ ] Replace `MemoryRunStore` in production with a tenant-scoped durable adapter; preserve idempotency keys and SSE sequence across restart.
- [ ] Enforce provider timeout, token/output/iteration/tool/cost budgets from config and persist usage. Verify provider fallback never occurs after a proposal side effect.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state npm run test:integration -- runtime-session
DATA_DIR=/tmp/raos-state npm run smoke:chat -- --message 'Reply with exactly READY'
# restart process
DATA_DIR=/tmp/raos-state npm run cli -- sessions
# expected: same session, user/assistant exchange, completed run, and usage are present
```

### 5. Register production market and safety tools

- [ ] Create `src/tools/market.ts`, `src/tools/noxa.ts`, `src/tools/risk.ts`, `src/tools/simulation.ts`, and a `registerBuiltInTools()` function.
- [ ] Wrap networks/search/trending/new pairs/token/pair/OHLCV/trades/holders, Uniswap pool state/swaps, NOXA launches/token verification, risk analysis, and simulation in strict Zod `ToolDefinition`s.
- [ ] Mark discovery/analysis tools `read`; mark simulation `proposal`; do not register sign/broadcast/wallet-secret tools in the agent registry.
- [ ] Assign minimum capabilities, bounded result sizes, explicit timeouts, provenance, observed block/time/finality, confidence, and upstream errors. Avoid returning unbounded `raw` provider payloads to the model.
- [ ] Define toolsets (`market-read`, `research`, `simulation`) only after all named tools are registered. Availability checks must validate configured dependencies.
- [ ] Add integration tests proving the model receives schemas, permitted market calls dispatch, denied capabilities dispatch nothing, and malformed/provider-conflicting data fails safely.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state npm run cli -- tools
DATA_DIR=/tmp/raos-state npm run cli -- markets
npm run test:integration -- tool-wiring
# expected: named built-ins with effects/capabilities/availability; no signing/broadcast tool
```

### 6. Implement the real RPC simulation adapter

- [ ] Create `src/execution/rpc-simulator.ts` implementing the existing `simulate(request)` dependency against the configured Robinhood RPC.
- [ ] Pin a block number/hash first, verify chain ID, and simulate the exact transaction fields represented by the request. Document the unavoidable distinction between unsigned serialized hash and an eventual signed transaction hash.
- [ ] Call `eth_call` at the pinned block. Support EIP-1898 block hash where the node accepts it; detect and fail closed on a changed canonical hash.
- [ ] Support configurable state overrides (`eth_call` third parameter) for balances/allowances only when explicitly requested and record the complete override provenance in evidence. Never silently substitute state.
- [ ] Probe `debug_traceCall`/`trace_call`; when available, derive gas used, calls, logs/state diffs, and ERC-20/native asset deltas. When unavailable, return a capability error rather than fabricating empty safety evidence required by policy.
- [ ] Decode standard `Error(string)`, `Panic(uint256)`, and custom ABI errors; bound trace/result size and timeout; redact secrets and RPC credentials.
- [ ] Compare simulation result to allowlisted targets/selectors/assets, current block lag, policy hash, and exact request identity. Persist immutable evidence before approval.
- [ ] Add mocked JSON-RPC tests plus an opt-in live testnet test; include unsupported state override/trace, revert, stale/reorged block, timeout, mismatched chain/hash, unexpected asset, and oversized trace cases.

**Acceptance**

```bash
RPC_URL="$ROBINHOOD_TESTNET_RPC_URL" npm run test:live -- simulation
DATA_DIR=/tmp/raos-state npm run cli -- simulate @tests/fixtures/testnet-simulation.json
# expected: pinned block hash, successful eth_call/trace capability, gas, deltas, policy hash, immutable evidence hash
```

### 7. Make NOXA a checkpointed live indexer

- [ ] Create `src/indexers/noxa.ts` and `src/storage/noxa-index.ts`. Persist cursor block/hash, launch identity, verification state, canonical/orphaned state, and timestamps.
- [ ] On first start backfill from `NOXA_FACTORY_START_BLOCK` in bounded chunks through `head-confirmations`; on restart continue from the persisted checkpoint.
- [ ] Poll or watch new blocks, enforce one active leader/lease, retry with jitter, rate-limit RPC, and never advance checkpoint past an uncommitted batch.
- [ ] Validate parent/hash ancestry over a configurable reorg window. On mismatch find the common ancestor, mark orphaned launches, emit correction events, and rescan.
- [ ] Verify each launched token against factory/token contracts; publish versioned `market.noxa.launch` envelopes with real token address/symbol fields (do not rely on payload `token === "NOXA"`, which does not match the current address-oriented registry).
- [ ] Connect launch events to `SqliteEventBus`, then `MarketTriggerEngine`, then durable jobs. Persist trigger dedupe/cooldown state.
- [ ] Expose indexer lag, checkpoint, last successful RPC, reorg count, and poison/dead-letter status through health/metrics/API.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state npm run indexer -- --once --to-block 61688
DATA_DIR=/tmp/raos-state npm run indexer -- --once --to-block 61688
# expected: second run inserts no duplicate launch/events
npm run test:integration -- noxa-reorg
# expected: orphan correction emitted and canonical checkpoint restored
```

### 8. Wire event triggers, schedules, and workers

- [ ] Define a job-handler registry with Zod payload schemas for agent runs, market refresh, NOXA verification, trigger actions, simulation, reconciliation, and notifications.
- [ ] Implement `src/workers/jobs.ts`: claim loop, heartbeat shorter than lease, abort on cancellation/lost fencing, complete/fail with durable result references, bounded concurrency, jittered idle polling, and graceful drain.
- [ ] Add a scheduler loop that persists recurring schedule definitions and next-fire times. `nextScheduleTime()` alone is not a scheduler.
- [ ] Subscribe event consumers with stable names/versioned definitions. Trigger consumers enqueue jobs transactionally/idempotently using event ID + handler version.
- [ ] Start event delivery/retry continuously; expose dead letters and a controlled replay command. Do not silently swallow permanent event failures.
- [ ] Add crash/restart tests proving lease recovery and no duplicate external side effect; jobs that may have crossed a side-effect boundary must become reconciliation-required.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state npm run worker & WORKER_PID=$!
DATA_DIR=/tmp/raos-state npm run cli -- jobs
kill -TERM "$WORKER_PID"; wait "$WORKER_PID"
# expected: worker ready, processes fixture job once, drains and exits 0
npm run test:integration -- worker-crash event-trigger-schedule
```

### 9. Bootstrap authenticated API servers

- [ ] Create `src/server.ts` with a shebang-compatible executable entry that loads config, creates the app, listens, logs the bound address, and exits non-zero on bootstrap failure.
- [ ] Decide whether utility and agent routes share one Fastify instance/prefix or separate ports; document and test the chosen topology. Register plugins with `await`, not ignored promises.
- [ ] Replace placeholder authentication with production JWT/JWKS or a documented reverse-proxy identity scheme. Enforce tenant/scopes on every session, search, run, approval, market, and admin endpoint.
- [ ] Persist idempotency/run events; implement genuinely streaming SSE with heartbeat, disconnect cleanup, event replay window, and backpressure. Add WebSocket only if required by the dashboard.
- [ ] Add `/livez`, `/readyz`, `/metrics`, version/build metadata, OpenAPI JSON, request IDs, structured audit logs, strict CORS, secure headers, body/rate limits, and trusted-proxy configuration.
- [ ] Correct lifecycle races: cancellation and completion must be compare-and-set terminal transitions; approval endpoints require scope and replay-safe decisions.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state npm start & SERVER_PID=$!
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8787/readyz && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/openapi.json >/tmp/openapi.json
curl -fsS -H "Authorization: Bearer $TEST_API_TOKEN" http://127.0.0.1:8787/v1/health
kill -TERM "$SERVER_PID"; wait "$SERVER_PID"
# expected: readiness 200 only after recovery; OpenAPI valid; shutdown 0
```

### 10. Ship an actual CLI binary

- [ ] Create `src/bin/robinhood-agent-os.ts` with `#!/usr/bin/env node`, process argument handling, exit code propagation, help/version, signal handling, and JSON/text output modes.
- [ ] Add package `bin: { "raos": "dist/bin/robinhood-agent-os.js" }`, include distributable files, and ensure the emitted file is executable (or use an npm bin shim).
- [ ] Implement `CliServices` against either local composition or authenticated API, chosen explicitly via config. Add missing `models`, `db`, `events`, `indexer`, and dead-letter/replay administration commands.
- [ ] Support `simulate @file.json` (the current parser accepts only inline JSON), stdin where appropriate, stable machine-readable errors, and no secret values in status/config output.
- [ ] Ensure commands that only inspect state do not instantiate model providers or Telegram unnecessarily.

**Acceptance**

```bash
npm pack --dry-run
npm link
raos --help
raos status
raos tools
raos chat --session smoke 'Reply with READY'
# expected: binary resolves from package metadata, correct exit codes, durable smoke session
```

### 11. Start Telegram safely

- [ ] Add a Telegram runner supporting either long polling (`getUpdates`) with a persisted update offset or an HTTPS webhook with secret-token verification. Never use the in-memory `seen` set as restart dedupe.
- [ ] Validate bot token presence without logging it; call `getMe` during readiness. Persist channel message ID/idempotency and map session keys to durable tenant/session records.
- [ ] Route authorized inbound messages into the same session/runtime service as API/CLI and send streamed/final responses with retry/backoff and Telegram 429 handling.
- [ ] Store user/chat/thread allowlists and tenant mapping in validated config/storage. Default deny. Do not trust usernames as identity.
- [ ] Wire `/approve` and `/reject` to the durable approval service with actor authorization, expiry/quorum/replay checks—not merely parse a command object.
- [ ] Bound update/body size, escape or deliberately select parse mode, persist outbound delivery status, and dead-letter failed notifications.
- [ ] Stop polling/webhook ingress before runtime/worker drain on shutdown.

**Acceptance**

```bash
DATA_DIR=/tmp/raos-state TELEGRAM_ENABLED=true npm run telegram:check
npm run test:integration -- telegram-restart telegram-approval telegram-rate-limit
# expected: getMe succeeds; duplicate update after restart does not rerun; unauthorized actor denied
```

### 12. Build and integrate the dashboard

- [ ] Create a real frontend workspace (for example `dashboard/`) with its own package/build/test configuration and committed lockfile policy, or explicitly remove dashboard claims from architecture.
- [ ] Implement authenticated views for health/dependencies, model/tool availability, sessions/runs and streamed events, markets/token/pool/OHLCV/risk, NOXA indexer lag/launches, jobs/dead letters, approvals with decoded simulation evidence, and audit/metrics summaries.
- [ ] Consume documented API endpoints only; do not embed provider keys, RPC secrets, Telegram tokens, or signing data in browser bundles.
- [ ] Add API endpoints currently missing for dashboard data (jobs, indexer, market history, evidence, dependency health) with tenant/admin authorization and pagination.
- [ ] Configure strict CSP, same-origin/proxied API or exact CORS allowlist, production asset hashing/cache rules, error/loading/empty states, BigInt-safe serialization, and reconnecting SSE cursors.
- [ ] Serve static assets from Fastify or a separate web server and add an end-to-end smoke test.

**Acceptance**

```bash
npm run dashboard:build
npm run dashboard:test
npm run test:e2e -- dashboard
# expected: production assets build; authenticated smoke traverses health -> market -> run -> approval without console errors
```

### 13. Complete observability, audit, and operational safety

- [ ] Finish the missing observability implementation required by tests: structured redacting logger, bounded metrics, dependency health registry, and audit-root batching/export.
- [ ] Instrument API latency/errors, model requests/usage/fallback, tools, active runs, DB contention, queue depth/lease loss/dead letters, event lag/retries, indexer lag/reorgs, RPC failures, Telegram delivery, and simulation capability/failure.
- [ ] Persist or export tamper-evident audit roots and provide a verification command. Logs are observational; financial lifecycle/evidence must remain durable independently.
- [ ] Add startup build/version/schema/config fingerprints (without secret values), clock-skew indicator, disk-space alert, and operator runbooks for DB corruption, reorg, dead letters, provider outage, and forced shutdown.
- [ ] Keep execution disabled unless simulator, policy, approvals, isolated signer verifier, broadcaster, and receipt reconciler are all healthy. The current code has no complete receipt/finality/reorg reconciliation service; implement it before any hot-wallet claim.

**Acceptance**

```bash
curl -fsS http://127.0.0.1:8787/metrics | grep -E 'raos_(runs|jobs|indexer|rpc)'
DATA_DIR=/tmp/raos-state npm run audit:verify
npm run test:integration -- redaction audit-root readiness-degradation
```

### 14. Package containers and system services

- [ ] Add a multi-stage `Dockerfile` using Node 22, `npm ci`, clean build, non-root runtime user, read-only root filesystem compatibility, writable `/var/lib/raos`, init/signal handling, healthcheck, and no build secrets.
- [ ] Add `.dockerignore`; exclude `.env`, data DB/WAL/SHM files, logs, credentials, node_modules, and test artifacts.
- [ ] Add `compose.yaml` with separate `api`, `worker`, `indexer`, and optional `telegram` services sharing the data volume only where SQLite locking semantics are validated. Do not horizontally scale SQLite writers without an explicit design.
- [ ] Add hardened systemd templates under `deploy/systemd/`: dedicated user/group, `EnvironmentFile`, `StateDirectory`, `WorkingDirectory`, restart policy/backoff, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, scoped `ReadWritePaths`, resource limits, and ordered graceful stop.
- [ ] Add container/systemd migration strategy: one migration job or `ExecStartPre`, never every replica racing implicitly.
- [ ] Add image SBOM/vulnerability/license scan and provenance/signing in CI.

**Acceptance**

```bash
docker build -t robinhood-agent-os:local .
docker compose config
docker compose up -d
curl -fsS http://127.0.0.1:8787/readyz
docker compose down --timeout 30
systemd-analyze verify deploy/systemd/*.service
```

### 15. Documentation, licensing, and release gate

- [ ] Add a project `LICENSE` and set `package.json.license` consistently. The repository README references upstream MIT material but the project itself currently has no license file; perform provenance review before choosing terms.
- [ ] Generate third-party notices/license inventory from production dependencies and document upstream-derived code attribution.
- [ ] Rewrite README quickstart around the real server/CLI, environment setup, testnet-only default, data/backup paths, API/Telegram/dashboard startup, and explicit signing limitations.
- [ ] Add threat model, operator runbook, migration/backup/restore, API/CLI reference, and release checklist. Remove stale claims and broken doc references.
- [ ] Add CI gates: clean install, tests, typecheck, clean build, package smoke, migrations from empty and previous schema, API/CLI/container smoke, dashboard build/e2e, dependency/license/secret scan, and opt-in live testnet checks.
- [ ] Produce an npm tarball and container from a clean checkout; install/run them in an empty environment. A source-tree `dist/` is not release evidence.

**Final acceptance (read-only/testnet standalone)**

```bash
cd /home/d/robinhood-agent-os
rm -rf node_modules dist /tmp/raos-release-state
npm ci
npm run verify
npm run db:migrate -- --data-dir /tmp/raos-release-state
npm run build
npm pack

docker build -t robinhood-agent-os:acceptance .
docker run --rm -d --name raos-acceptance \
  --read-only --tmpfs /tmp -p 8787:8787 \
  -v /tmp/raos-release-state:/var/lib/raos \
  --env-file .env.acceptance robinhood-agent-os:acceptance
curl -fsS http://127.0.0.1:8787/readyz
npm run smoke:api -- --base-url http://127.0.0.1:8787
npm run smoke:cli
npm run test:live -- noxa simulation

docker stop --time 30 raos-acceptance
docker run --rm -d --name raos-restart -p 8787:8787 \
  -v /tmp/raos-release-state:/var/lib/raos \
  --env-file .env.acceptance robinhood-agent-os:acceptance
npm run smoke:recovery -- --base-url http://127.0.0.1:8787
docker stop --time 30 raos-restart
# expected: persisted session/events/indexer cursor survive; no duplicate job/launch/trigger; audit verifies
```

## Release blockers by severity

**P0 — not executable:** no composition root/config loader/server listener/bin/production service adapters; runtime-model-registry-session seams are unwired; baseline verification is red.

**P0 — financial safety:** no live exact-state RPC simulator, no complete receipt/finality reconciliation, no live durable NOXA indexer/reorg loop, and no isolated production signer integration. Signing must remain disabled.

**P1 — autonomous operation:** no job worker/scheduler/event-delivery process, no trigger-to-job wiring, no Telegram ingress runner, and production API run/event state is in memory.

**P1 — operations:** inline migrations lack centralized lifecycle, no unified data-path policy, no observability source implementation, no deployment artifacts, env template, backup/restore, or readiness bootstrap.

**P2 — product/release:** no dashboard, package bin/start scripts, project license/third-party notices, clean-package/container smoke, or operator documentation.
