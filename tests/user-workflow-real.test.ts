import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserWorkflow } from "../src/cli/user-workflow.js";
import { createRemoteServices } from "../src/bin/robinhood-agent-os.js";
import { posixPermissions } from "./helpers.js";
const dirs: string[] = [];
afterEach(() =>
  Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  ),
);
const req = (action: string, args: Record<string, string | boolean>) => ({
  group: "trade" as const,
  action,
  args,
});
describe("real trading CLI workflow", () => {
  it("routes remote quote, approve, and submit through the production HTTP trading API", async () => {
    const d = await mkdtemp(join(tmpdir(), "raos-remote-"));
    dirs.push(d);
    await writeFile(join(d, "operator.key"), "operator-secret", {
      mode: 0o600,
    });
    const calls: { path: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: any, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      if (path.endsWith("/executions/e1"))
        return new Response(
          JSON.stringify({ challenge: "c", approvalRevision: 2 }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
    });
    const services = createRemoteServices(
      "https://raos.example",
      "token",
      fetch as any,
      d,
    );
    await services.user({
      group: "trade",
      action: "quote",
      args: {
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenOut: "0x0000000000000000000000000000000000000002",
        amountIn: "7",
        slippage: "25",
      },
    });
    await services.user({
      group: "trade",
      action: "approve",
      args: { id: "e1" },
    });
    await services.user({
      group: "trade",
      action: "submit",
      args: { id: "e1" },
    });
    expect(calls.map((x) => x.path)).toEqual([
      "/v1/trading/quote",
      "/v1/trading/executions/e1",
      "/v1/trading/executions/e1/approve",
      "/v1/trading/executions/e1/submit",
    ]);
    expect(
      calls.every(
        (x) => (x.init.headers as any).authorization === "Bearer token",
      ),
    ).toBe(true);
  });
  it("routes the complete lifecycle to the composed trading service with canonical schemas", async () => {
    const d = await mkdtemp(join(tmpdir(), "raos-real-"));
    dirs.push(d);
    const trading = {
      quote: vi.fn(async (x) => ({ id: "q1", ...x })),
      execute: vi.fn(async () => ({ id: "e1" })),
      approve: vi.fn(() => ({ state: "approved" })),
      deny: vi.fn(() => ({ state: "denied" })),
      submit: vi.fn(async () => ({ state: "broadcast" })),
      status: vi.fn(() => ({ id: "e1" })),
      reconcile: vi.fn(async () => ({ state: "finalized" })),
      portfolio: vi.fn(async () => ({ nativeBalance: 1n })),
    };
    const user = createUserWorkflow({
      dataDir: d,
      trading: trading as any,
      operatorProof: async (_id, decision) => ({
        operator: "ops",
        decision,
        challenge: "c",
        nonce: "n",
        expectedRevision: 0,
        timestamp: 1,
        proof: "p",
      }),
    });
    await user(
      req("quote", {
        side: "buy",
        tokenIn: "0x0000000000000000000000000000000000000001",
        tokenOut: "0x0000000000000000000000000000000000000002",
        amountIn: "7",
        slippage: "25",
      }),
    );
    expect(trading.quote).toHaveBeenCalledWith({
      side: "buy",
      tokenIn: "0x0000000000000000000000000000000000000001",
      tokenOut: "0x0000000000000000000000000000000000000002",
      amountIn: 7n,
      slippageBps: 25,
    });
    await user(
      req("buy", {
        quoteId: "q1",
        idempotencyKey: "k",
        actor: "bot",
        live: true,
      }),
    );
    expect(trading.execute).toHaveBeenCalledWith("q1", {
      idempotencyKey: "k",
      actor: "bot",
      dryRun: false,
    });
    await user(req("approve", { id: "e1" }));
    expect(trading.approve).toHaveBeenCalled();
    await user(req("deny", { id: "e2", reason: "no" }));
    expect(trading.deny).toHaveBeenCalled();
    await user(req("submit", { id: "e1" }));
    await user(req("status", { id: "e1" }));
    await user(req("reconcile", { id: "e1" }));
    await user({ group: "portfolio", action: "show", args: {} });
    expect(trading.portfolio).toHaveBeenCalled();
    expect(await stat(join(d, "trades.json")).catch(() => null)).toBeNull();
  });
  it("setup emits complete private credentials and valid policies without leaking secrets", async () => {
    const d = await mkdtemp(join(tmpdir(), "raos-setup-"));
    dirs.push(d);
    const user = createUserWorkflow({ dataDir: d });
    const out: any = await user({
      group: "setup",
      action: "init",
      args: { account: "0x0000000000000000000000000000000000000001" },
    });
    for (const f of [
      "config.json",
      "policy.json",
      "sign-policy.json",
      "signer.token",
      "api.token",
      "authorization.key",
      "operator.key",
    ]) {
      expect(out.files).toContain(f);
      if (posixPermissions)
        expect((await stat(join(d, f))).mode & 0o077).toBe(0);
    }
    const sign = JSON.parse(
      await readFile(join(d, "sign-policy.json"), "utf8"),
    );
    expect(sign).toMatchObject({
      version: 1,
      chainIds: [4663],
      accounts: ["0x0000000000000000000000000000000000000001"],
    });
    expect(JSON.stringify(out)).not.toContain(
      await readFile(join(d, "operator.key"), "utf8"),
    );
    expect(out.next.join(" ")).toMatch(/wallet create.*password-fd/);
  });
});
