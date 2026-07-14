# Production trading runbook

> Live trading moves real funds. Use a dedicated, minimally funded wallet, verify every address and limit, and keep the signer on the same host behind its Unix socket. The API/model process never receives the private key. Passing the test suite is not a security audit.

## 1. Clone, verify, and initialize

Requires Node.js 22+, npm, a Robinhood Chain mainnet RPC, and a dedicated Unix account.

```bash
git clone https://github.com/venymlabs/ari-os.git robinhood-agent-os
cd robinhood-agent-os
npm ci
npm run verify
umask 077
export DATA_DIR="$HOME/.local/state/robinhood-agent-os"
install -d -m 0700 "$DATA_DIR"
npm run setup:trading -- --account 0xYourDedicatedWallet --rpc https://YOUR_MAINNET_RPC
```

Setup creates mode-0600 `config.json`, `policy.json`, `sign-policy.json`, `signer.token`, `api.token`, `authorization.key`, and `operator.key`. It refuses to overwrite them unless `--force` is explicitly supplied. The JSON files are setup artifacts for operator review; runtime settings are supplied through the environment described below.

If the package is installed globally, `raos` and `raos-signer` may replace `npm run cli --` and `npm run signer --`. Commands below use npm scripts so they work directly after cloning.

## 2. Create or import the signer wallet

Secrets are read from inherited file descriptors, not command-line arguments. Interactive creation reads the password from stdin:

```bash
npm run signer -- create --keystore "$DATA_DIR/wallet.json" --password-fd 0
npm run signer -- status --keystore "$DATA_DIR/wallet.json"
```

For noninteractive import, create private input files without putting either secret in shell history:

```bash
install -m 0600 /dev/null "$DATA_DIR/password.in"
install -m 0600 /dev/null "$DATA_DIR/key.in"
# Populate password.in and the 0x-prefixed key.in using a trusted editor.
npm run signer -- import --keystore "$DATA_DIR/wallet.json" \
  --password-fd 3 --key-fd 4 \
  3<"$DATA_DIR/password.in" 4<"$DATA_DIR/key.in"
shred -u "$DATA_DIR/key.in"
npm run signer -- status --keystore "$DATA_DIR/wallet.json"
```

Keep `password.in` only if a supervisor needs it to start the signer; otherwise remove it securely. Never put a private key, password, mnemonic, signer token, or authorization key in an argument, environment variable, `.env`, chat, ticket, or log.

Confirm that the address printed by `status` is exactly `TRADING_ACCOUNT`. Fund it only with the intended trade assets and enough ETH for gas.

## 3. Review the two policies

`policy.json` controls the trading orchestrator. Runtime equivalents are `TRADING_MAX_AMOUNT_IN`, `TRADING_ALLOWED_TOKENS`, `TRADING_MAX_SLIPPAGE_BPS`, and `TRADING_FINALITY_BLOCKS`. Amounts are base-unit decimal integers; token allowlists are comma-separated addresses. `TRADING_MAX_AMOUNT_IN` is enforced independently in each token's native units; raw units from different tokens or decimal scales are never summed. Aggregate exposure is disabled unless the adapter supplies a single quote denomination with explicit decimals and price/valuation evidence.

`sign-policy.json` is independently enforced by the signer. It binds chain ID, account, destination router, value, gas/fee ceilings, and calldata selectors. Setup currently allows the verified Robinhood Chain SwapRouter02 at `0xcaf681a66d020601342297493863e78c959e5cb2` and only its deadline-less `exactInputSingle` (`0x04e45aaf`) and `exactInput` (`0xb858183f`) selectors. Verify those methods and all limits against the exact intended trading flow before funding. Do not broaden `dataPrefixes` to `0x` for unattended production.

Contract provenance and current addresses are in [PRODUCTION-CONTRACTS.md](PRODUCTION-CONTRACTS.md). Re-run its live read-only checks before deployment.

## 4. Configure live mode and approval proof keys

The API and signer share `authorization.key`; the signer verifies authorization envelopes using HMAC-SHA256. The CLI reads `operator.key` to construct the approval/denial proof from the durable approval challenge. The API independently verifies that proof. Both are random mode-0600 files created by setup.

Use one stable key ID for each key and keep the signer key ID equal to `AUTHORIZATION_KEY_ID`:

```bash
export RPC_URL=https://YOUR_AUTHENTICATED_MAINNET_RPC
export NETWORK=mainnet
export CHAIN_ID=4663
export EXECUTION_MODE=live
export MAINNET_ENABLED=true
export MAINNET_ACKNOWLEDGE_RISK=I_ACKNOWLEDGE_MAINNET_RISK
export LIVE_TRADING_ENABLED=true
export LIVE_TRADING_ACKNOWLEDGE_RISK=I_ACKNOWLEDGE_LIVE_TRADING_RISK

export TRADING_ACCOUNT=0xYourDedicatedWallet
export TRADING_MAX_AMOUNT_IN=1000000
export TRADING_ALLOWED_TOKENS=0xInputToken,0xOutputToken
export TRADING_MAX_SLIPPAGE_BPS=50
export TRADING_FINALITY_BLOCKS=12
export TRADING_RECONCILE_INTERVAL_MS=15000

export SIGNER_SOCKET_PATH="$DATA_DIR/signer.sock"
export SIGNER_TOKEN_PATH="$DATA_DIR/signer.token"
export SIGNER_POLICY_PATH="$DATA_DIR/sign-policy.json"
export APPROVAL_OPERATOR_IDS=operator
export APPROVAL_OPERATOR_KEY_IDS=operator-v1
export APPROVAL_OPERATOR_KEY_PATHS="$DATA_DIR/operator.key"
export APPROVAL_OPERATOR_CONFIG_VERSION=1
export AUTHORIZATION_KEY_ID=authorization-v1
export AUTHORIZATION_KEY_PATH="$DATA_DIR/authorization.key"

export API_BEARER_TOKEN="$(tr -d '\n' < "$DATA_DIR/api.token")"
export API_SCOPES=agent:read,agent:write,tool:read,tool:invoke,simulation:invoke,trading:quote,trading:execute,trading:approve,trading:submit,trading:read,trading:reconcile
```

All key/token/policy paths must be absolute regular files with no group/other permissions. `DATA_DIR` must be absolute and remains mode 0700.

## 5. Start signer and API

The signer reads its password from FD 3. Its replay database must be durable and must never be deleted merely to clear an error.

```bash
npm run signer -- serve \
  --keystore "$DATA_DIR/wallet.json" --password-fd 3 \
  --socket "$SIGNER_SOCKET_PATH" --token "$SIGNER_TOKEN_PATH" \
  --policy "$SIGNER_POLICY_PATH" --db "$DATA_DIR/signer.sqlite" \
  --authorization-key "$AUTHORIZATION_KEY_PATH" \
  --key-id "$AUTHORIZATION_KEY_ID" --audience signer \
  --rpc "$RPC_URL" --reconcile-interval-ms "$TRADING_RECONCILE_INTERVAL_MS" \
  3<"$DATA_DIR/password.in"
```

In a second supervised process:

```bash
npm start
curl -fsS http://127.0.0.1:8787/livez
curl -fsS http://127.0.0.1:8787/readyz
```

Startup probes chain identity, verified contract bytecode, and the signer; it also recovers/reconciles durable executions and schedules periodic reconciliation. A non-ready service must not receive trading traffic.

## 6. Clone-to-trade CLI flow

The local CLI opens the same durable state and uses the configured RPC/signer composition. Quote IDs expire after 30 seconds, so complete review/approval promptly. Every amount is in token base units.

```bash
# Quote and create a REAL execution. Omitting --live creates a dry-run execution.
npm run cli -- trade quote --side buy \
  --token-in 0xInputToken --token-out 0xOutputToken \
  --amount-in 1000000 --slippage 50
npm run cli -- trade buy --quote-id <quoteId> \
  --idempotency-key buy-001 --actor strategy --live

# Inspect the exact execution and its approval challenge/revision.
npm run cli -- trade status --id <executionId>

# Creates an HMAC proof from $DATA_DIR/operator.key; no key is passed in argv.
npm run cli -- trade approve --id <executionId>
npm run cli -- trade submit --id <executionId>
npm run cli -- trade reconcile --id <executionId>
npm run cli -- trade status --id <executionId>
```

For a sell, use `trade quote --side sell`, then `trade sell ... --live`. To reject an awaiting execution:

```bash
npm run cli -- trade deny --id <executionId> --reason "operator rejected"
```

To clear a router allowance, use `trade revoke`. It pins the exact
`approve(router, 0)` transaction for the token and pushes it through the
same lifecycle as a swap: risk assessment, exact-transaction operator
approval, a one-time authorization envelope, and the isolated signer.

```bash
npm run cli -- trade revoke --token <tokenAddress> \
  --idempotency-key revoke-001 --live
npm run cli -- trade approve --id <executionId>
npm run cli -- trade submit --id <executionId>
```

Without `--live` the revoke is a dry run. Two policy prerequisites for a
live revoke: the signer policy's `dataPrefixes` must include the ERC-20
approve selector `0x095ea7b3` (the default `setup` policy now includes
it), and the token contract address must be listed in the signer
policy's `to` allowlist — the signer refuses to call contracts that are
not explicitly allowed. Verify the cleared allowance on-chain after
finalization. If the control plane itself may be compromised, still
prefer a separately trusted wallet.

Never retry an uncertain order with a new idempotency key. Query its execution ID and reconcile it first. Local `trade reconcile` requires `--id`; automatic startup/interval recovery scans all pending durable executions.

## 7. Authenticated HTTP flow

The same lifecycle is exposed at:

- `POST /v1/trading/quote`
- `POST /v1/trading/execute` (requires `Idempotency-Key`)
- `POST /v1/trading/revoke` (requires `Idempotency-Key`)
- `GET /v1/trading/executions/:id`
- `POST /v1/trading/executions/:id/approve` (requires proof and `Idempotency-Key`)
- `POST /v1/trading/executions/:id/submit` (requires `Idempotency-Key`)
- `POST /v1/trading/reconcile`

Use `Authorization: Bearer …` and the corresponding `trading:*` scope. Treat the API token as a secret. Approval requests must contain the decision, challenge, nonce, expected revision, timestamp, and proof produced by a trusted operator-side client. The API never manufactures approval proof.

## 8. Emergency pause and recovery

1. Stop API/worker ingress immediately; preserve databases and logs.
2. Stop the signer to remove signing/broadcast capability: `sudo systemctl stop raos-api raos-worker raos-signer` when using systemd.
3. Remove network exposure and rotate API/signer/approval/authorization credentials if compromise is suspected. Rotation requires coordinated API and signer configuration.
4. Revoke router allowances: `trade revoke` when the control plane is still trusted, or a separately trusted wallet when control-plane compromise is possible.
5. Restart the signer and one API instance, require `/readyz`, then reconcile every uncertain execution before restoring ingress.

Manual signer-side reconciliation checks its durable broadcast records without signing or resubmitting:

```bash
npm run signer -- reconcile \
  --keystore "$DATA_DIR/wallet.json" --password-fd 3 \
  --policy "$SIGNER_POLICY_PATH" --db "$DATA_DIR/signer.sqlite" \
  --rpc "$RPC_URL" 3<"$DATA_DIR/password.in"
```

Compare receipts, pending account nonce, balances, allowances, API execution records, and signer replay/broadcast records. Never resubmit when outcome is uncertain.

## 9. Backup and restore

Stop API, workers, and signer. Checkpoint every SQLite WAL, then copy the entire data directory with ownership and modes preserved. Encrypt backups; store the encrypted keystore and its password separately. Never copy only a live `.sqlite` file.

Restore only while all services are stopped. Enforce directory mode 0700 and secret-file mode 0600, run `npm run db:integrity`, start the signer, then one API instance, verify `/readyz`, and reconcile before enabling ingress. A backup is not valid until a restore drill succeeds.
