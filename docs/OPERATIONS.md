# Operator Runbook

## Security boundary

This release is **read-only/testnet-first**. Signing, key custody, broadcast, and mainnet execution are absent. Never place private keys in environment files, CLI arguments, Telegram, logs, or the data directory. API authentication belongs at a trusted TLS reverse proxy until a production identity adapter is configured. Telegram is default-deny and identifies actors only by numeric user/chat IDs.

## Install and start

Use Node 22 and `npm ci && npm run verify && npm start`. State defaults to `DATA_DIR`; production should use `/var/lib/raos` mode 0700. Check `/livez`, `/readyz`, `/metrics`, `/version`, and `/openapi.json`. Stop with SIGTERM; the listener closes gracefully.

## Backup and restore

Stop ingress/workers, checkpoint every SQLite WAL (`PRAGMA wal_checkpoint(TRUNCATE)`), then copy the complete data directory with ownership/mode preserved. Restore only while all services are stopped, run integrity/schema checks, then start one API instance and verify readiness before workers. Never copy only a `.sqlite` file while writers are active.

## Incidents

- **Readiness down:** inspect dependency health and disk space; do not bypass it.
- **Database corruption:** stop all processes, preserve evidence, restore the latest verified backup, run integrity checks.
- **Dead letters:** inspect payload without exposing secrets; replay only after fixing cause and verifying idempotency.
- **Provider outage/429:** allow bounded retry/backoff; do not switch networks or weaken policy.
- **Telegram compromise:** remove numeric allowlist entry, rotate bot token, stop Telegram profile, inspect durable offsets/audit.
- **Forced shutdown:** if graceful deadline expires, preserve DB/WAL files and reconcile unfinished side-effect-capable work before restart.

## Containers/systemd

Run migrations as one explicit job before API. Compose worker/indexer/Telegram profiles are optional and must not be horizontally scaled while sharing SQLite. Containers support read-only root filesystems with only `/var/lib/raos` and `/tmp` writable. Systemd units use the `raos` account and `/etc/raos/raos.env`.

## Release gate

Clean install; full verify; `npm pack --dry-run`; install tarball in an empty directory; CLI help/version; API start/readiness/shutdown; migration empty/upgrade tests; container build/config/smoke; systemd verification; dependency/license/secret/vulnerability scans. Signing remains disabled.
