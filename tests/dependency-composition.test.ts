import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
import { registerBuiltInTools } from "../src/tools/index.js";
import { loadConfig, sanitizedConfig } from "../src/config/index.js";
import { createApplication } from "../src/app/index.js";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "compose-"));
  dirs.push(d);
  return d;
};
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
const invoke = (r: ToolRegistry, name: string, input: unknown = {}) =>
  r.invoke(name, input, {
    capabilities: [
      TRADING_CAPABILITIES.MARKET_DATA,
      TRADING_CAPABILITIES.RISK_ANALYSIS,
      TRADING_CAPABILITIES.ORDER_SIMULATE,
    ],
  });
describe("fail-closed built-in dependencies", () => {
  it("marks missing backends unavailable and invocation never returns synthetic empty/null results", async () => {
    const r = registerBuiltInTools(new ToolRegistry());
    expect(
      await r.available({
        capabilities: [
          TRADING_CAPABILITIES.MARKET_DATA,
          TRADING_CAPABILITIES.RISK_ANALYSIS,
          TRADING_CAPABILITIES.ORDER_SIMULATE,
        ],
      }),
    ).toEqual([]);
    for (const [name, input] of [
      ["market.networks", {}],
      ["noxa.launches", {}],
      ["risk.analyze", { token: "x" }],
      ["simulation.transaction", { transaction: {} }],
    ] as const)
      expect(await invoke(r, name, input)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
  });
  it("only exposes methods backed by injected dependencies", async () => {
    const networks = vi.fn(async () => ["testnet"]);
    const r = registerBuiltInTools(new ToolRegistry(), {
      market: { networks },
    });
    expect(
      (
        await r.available({ capabilities: [TRADING_CAPABILITIES.MARKET_DATA] })
      ).map((x) => x.name),
    ).toEqual(["market.networks"]);
    expect(await invoke(r, "market.networks")).toMatchObject({
      ok: true,
      data: { data: ["testnet"] },
    });
    expect(networks).toHaveBeenCalled();
  });
});
describe("validated read-only production composition", () => {
  it("validates URLs, chain/factory/start block and redacts configured URLs", () => {
    const d = temp();
    expect(() =>
      loadConfig({ NODE_ENV: "test", DATA_DIR: d, RPC_URL: "not-a-url" }),
    ).toThrow();
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: d,
        RPC_URL: "https://rpc.test",
        CHAIN_ID: "4663",
      }),
    ).toThrow(/chain/i);
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: d,
        NOXA_FACTORY_ADDRESS: "bad",
      }),
    ).toThrow();
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: d,
      RPC_URL: "https://user:secret@rpc.test/path?key=secret",
      CHAIN_ID: "46630",
      NOXA_FACTORY_START_BLOCK: "12",
      MARKET_PROVIDER_URLS: "https://market.test,https://other.test",
    });
    expect(c.rpc?.chainId).toBe(46630);
    expect(c.noxa.startBlock).toBe(12n);
    expect(c.marketProviderUrls).toHaveLength(2);
    expect(JSON.stringify(sanitizedConfig(c))).not.toMatch(
      /secret|rpc\.test|market\.test/,
    );
  });
  it("requires an explicit RPC URL for RPC-dependent processes", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", DATA_DIR: temp() }, process.cwd(), {
        requireRpc: true,
      }),
    ).toThrow(/RPC_URL/);
  });
  it("reports optional dependencies as unconfigured rather than healthy", async () => {
    const app = createApplication(
      loadConfig({ NODE_ENV: "test", DATA_DIR: temp() }),
    );
    await app.start();
    expect(await app.health()).toMatchObject({
      dependencies: {
        rpc: { status: "unconfigured" },
        noxa: { status: "unconfigured" },
        simulation: { status: "unconfigured" },
        market: { status: "unconfigured" },
      },
    });
    expect(app.ready()).toBe(true);
    await app.stop();
  });
  it("checks configured dependencies before reporting them available", async () => {
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      RPC_URL: "https://rpc.test",
      CHAIN_ID: "46630",
    });
    const fetch = vi.fn(async (_u: any, init: any) => {
      const { id, method } = JSON.parse(init.body);
      const result =
        method === "eth_chainId"
          ? "0xb626"
          : method === "eth_getBlockByNumber"
            ? { number: "0x10", hash: "0x" + "1".repeat(64) }
            : method === "eth_call"
              ? "0x"
              : method === "eth_estimateGas"
                ? "0x5208"
                : { gas: "0x5208", logs: [], stateDiffs: [], assetDeltas: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
    const app = createApplication(c, { rpcFetch: fetch as any });
    await app.start();
    expect(await app.health()).toMatchObject({
      status: "ok",
      dependencies: {
        rpc: { status: "available" },
        noxa: { status: "available" },
        simulation: { status: "available" },
        market: { status: "available" },
      },
    });
    expect(fetch).toHaveBeenCalled();
    expect(
      app.registry
        .listPrivileged()
        .every((t) => !/sign|broadcast/i.test(t.name)),
    ).toBe(true);
    await app.stop();
  });
  it("reports configured RPC-backed dependencies unhealthy when the endpoint fails", async () => {
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      RPC_URL: "https://rpc.test",
      CHAIN_ID: "46630",
    });
    const app = createApplication(c, {
      rpcFetch: vi.fn(async () => {
        throw new Error("credentials leaked here");
      }) as any,
    });
    await app.start();
    expect(await app.health()).toMatchObject({
      status: "unavailable",
      dependencies: {
        rpc: { status: "unhealthy" },
        noxa: { status: "unhealthy" },
        simulation: { status: "unhealthy" },
        market: { status: "available" },
      },
    });
    await app.stop();
  });
});
