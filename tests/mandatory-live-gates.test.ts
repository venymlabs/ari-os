import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/index.js";
import {
  ExecutionStore,
  TradingOrchestrator,
} from "../src/live-trading/index.js";
import { CLUSTER, pubkey } from "./signer-fixtures.js";
const FEE_PAYER = pubkey(1);
function files() {
  const d = mkdtempSync(join(tmpdir(), "gates-"));
  for (const n of ["token", "policy", "approval", "auth"])
    writeFileSync(join(d, n), "secret", { mode: 0o600 });
  return d;
}
function env(d: string): any {
  return {
    NODE_ENV: "test",
    DATA_DIR: d,
    NETWORK: "mainnet",
    RPC_URL: "http://localhost",
    EXECUTION_MODE: "live",
    MAINNET_ENABLED: "true",
    MAINNET_ACKNOWLEDGE_RISK: "I_ACKNOWLEDGE_MAINNET_RISK",
    LIVE_TRADING_ENABLED: "true",
    LIVE_TRADING_ACKNOWLEDGE_RISK: "I_ACKNOWLEDGE_LIVE_TRADING_RISK",
    TRADING_ACCOUNT: FEE_PAYER,
    TRADING_MAX_AMOUNT_IN: "10",
    SIGNER_SOCKET_PATH: join(d, "sock"),
    SIGNER_TOKEN_PATH: join(d, "token"),
    SIGNER_POLICY_PATH: join(d, "policy"),
    APPROVAL_OPERATOR_IDS: "ops",
    APPROVAL_OPERATOR_KEY_IDS: "ops-v1",
    APPROVAL_OPERATOR_KEY_PATHS: join(d, "approval"),
    AUTHORIZATION_KEY_ID: "auth-v1",
    AUTHORIZATION_KEY_PATH: join(d, "auth"),
  };
}
describe("mandatory live gates", () => {
  it("requires configured approval proof and authorization keys in live mode", () => {
    const d = files(),
      e = env(d);
    delete e.APPROVAL_OPERATOR_IDS;
    expect(() => loadConfig(e)).toThrow(/APPROVAL_OPERATOR_IDS/);
    expect(loadConfig(env(d)).trading?.authorizationKeyId).toBe("auth-v1");
  });
  it("never promotes an execution when its approval record is missing", () => {
    const store = new ExecutionStore(":memory:"),
      x = store.create({
        quoteId: "q",
        intentHash: "i",
        actor: "agent",
        dryRun: false,
        idempotencyKey: "k",
        approvalId: "missing",
      });
    const o = new TradingOrchestrator({
      cluster: CLUSTER,
      account: FEE_PAYER,
      policy: {
        version: 1,
        maxAmountIn: 1n,
        maxSlippageBps: 1,
        approvalRequired: true,
        finalityCommitment: "finalized",
      },
      rpc: {} as any,
      store,
      approvalEngine: { get: vi.fn(() => undefined) } as any,
    });
    expect(() => o.refreshApproval(x.id)).toThrow(/approval.*missing/i);
    expect(store.get(x.id)?.state).toBe("awaiting-approval");
  });
});
