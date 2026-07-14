import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionStore,
  TradingOrchestrator,
} from "../src/live-trading/index.js";
import { registerTradingApi } from "../src/live-trading/api.js";
import { removeDir } from "./helpers.js";

const A = "0x0000000000000000000000000000000000000001" as const;
describe("automatic durable recovery and operational defaults", () => {
  it("recovers and reconciles all restart-sensitive states as a bounded error-isolated batch", async () => {
    const d = mkdtempSync(join(tmpdir(), "recover-")),
      store = new ExecutionStore(join(d, "e.sqlite")),
      receipt = vi.fn(async () => null);
    try {
      const o = new TradingOrchestrator({
        chainId: 1,
        account: A,
        router: A,
        policy: {
          version: 1,
          maxAmountIn: 1n,
          maxSlippageBps: 1,
          approvalRequired: true,
          finalityBlocks: 2,
        },
        store,
        rpc: {
          balance: async () => 0n,
          quote: async () => {
            throw Error();
          },
          simulate: async () => {
            throw Error();
          },
          broadcast: async () => {
            throw Error();
          },
          receipt,
          blockHash: async () => null,
        },
      });
      const xs = [
        "signing",
        "submitting",
        "reconciliation-required",
        "broadcast",
        "confirmed",
      ].map((state, i) =>
        store.create(
          {
            quoteId: "q",
            intentHash: "i",
            actor: "a",
            dryRun: false,
            idempotencyKey: String(i),
          },
          state as any,
        ),
      );
      const result = await o.recoverAndReconcile();
      expect(result).toEqual({
        scanned: 5,
        recovered: 1,
        reconciled: 0,
        failed: 4,
      });
      expect(store.get(xs[0]!.id)?.state).toBe("signing");
      expect(store.get(xs[1]!.id)?.state).toBe("reconciliation-required");
    } finally {
      store.close();
      removeDir(d);
    }
  });
  it("exposes reconciliation only to its exact scope", async () => {
    const trading = {
      recoverAndReconcile: vi.fn(async () => ({
        scanned: 1,
        recovered: 0,
        reconciled: 1,
        failed: 0,
      })),
    };
    const app = Fastify();
    registerTradingApi(app, {
      trading: trading as any,
      principal: (q: any) => ({
        subject: "u",
        scopes: String(q.headers["x-scopes"] ?? "").split(","),
      }),
    });
    expect(
      (await app.inject({ method: "POST", url: "/v1/trading/reconcile" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/trading/reconcile",
          headers: { "x-scopes": "trading:reconcile" },
        })
      ).statusCode,
    ).toBe(202);
    await app.close();
  });
  it("ships recovery, identity and exact trading scope defaults in deployment assets", () => {
    const compose = readFileSync("compose.yaml", "utf8"),
      pkg = JSON.parse(readFileSync("package.json", "utf8")),
      signer = readFileSync("deploy/systemd/raos-signer.service", "utf8");
    for (const x of [
      "trading:quote",
      "trading:execute",
      "trading:approve",
      "trading:submit",
      "trading:read",
      "trading:reconcile",
      "API_TENANT_ID",
      "TRADING_RECONCILE_INTERVAL_MS",
    ])
      expect(compose).toContain(x);
    expect(compose).toContain("--key-id");
    expect(signer).toContain("--key-id");
    expect(signer).toContain("--reconcile-interval-ms");
    expect(pkg.scripts.verify.indexOf("build")).toBeLessThan(
      pkg.scripts.verify.indexOf("test"),
    );
  });
});
