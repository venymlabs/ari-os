import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
import { registerBuiltInTools } from "../src/tools/index.js";
import { loadConfig, sanitizedConfig } from "../src/config/index.js";
import { createApplication } from "../src/app/index.js";
import { CLUSTER_GENESIS_HASHES } from "../src/execution/rpc-simulator.js";
import { removeDir } from "./helpers.js";
import { pubkey } from "./signer-fixtures.js";
const MINT_A = pubkey(1),
  MINT_B = pubkey(2);
const DEVNET_GENESIS = CLUSTER_GENESIS_HASHES.devnet!;
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "compose-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));
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
  it("validates URLs, derives the cluster from the network and redacts configured URLs", () => {
    const d = temp();
    expect(() =>
      loadConfig({ NODE_ENV: "test", DATA_DIR: d, RPC_URL: "not-a-url" }),
    ).toThrow();
    // The cluster is derived from NETWORK, never configured alongside it: an
    // operator who could name it independently could point a mainnet process at
    // devnet, or the reverse. `testnet` selects devnet, the cluster operators
    // actually rehearse on.
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: d,
      RPC_URL: "https://user:secret@rpc.test/path?key=secret",
      MARKET_PROVIDER_URLS: "https://market.test,https://other.test",
    });
    expect(c.rpc?.cluster).toBe("devnet");
    expect(c.marketProviderUrls).toHaveLength(2);
    expect(JSON.stringify(sanitizedConfig(c))).not.toMatch(
      /secret|rpc\.test|market\.test/,
    );
  });
  it("refuses a trading account or allowlist entry that is not a base58 key", () => {
    const base = {
      NODE_ENV: "test",
      NETWORK: "mainnet",
      MAINNET_ENABLED: "true",
      MAINNET_ACKNOWLEDGE_RISK: "I_ACKNOWLEDGE_MAINNET_RISK",
      RPC_URL: "https://rpc.test",
      TRADING_MAX_AMOUNT_IN: "1",
    };
    // Previously these accepted a checksummed EVM address as well. There is no
    // EVM path left, so an `0x` address is now simply not a wallet.
    expect(() =>
      loadConfig({
        ...base,
        DATA_DIR: temp(),
        TRADING_ACCOUNT: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/TRADING_ACCOUNT/);
    expect(() =>
      loadConfig({
        ...base,
        DATA_DIR: temp(),
        TRADING_ACCOUNT: MINT_A,
        TRADING_ALLOWED_TOKENS: `${MINT_A},0xdeadbeef`,
      }),
    ).toThrow(/TRADING_ALLOWED_TOKENS/);
    const ok = loadConfig({
      ...base,
      DATA_DIR: temp(),
      TRADING_ACCOUNT: MINT_A,
      TRADING_ALLOWED_TOKENS: `${MINT_A},${MINT_B}`,
    });
    expect(ok.trading?.account).toBe(MINT_A);
    expect(ok.trading?.allowedTokens).toEqual([MINT_A, MINT_B]);
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
    });
    const probed: string[] = [];
    const fetch = vi.fn(async (_u: any, init: any) => {
      const { id, method } = JSON.parse(init.body);
      probed.push(method);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: method === "getGenesisHash" ? DEVNET_GENESIS : null,
        }),
      );
    });
    const app = createApplication(c, { rpcFetch: fetch as any });
    await app.start();
    expect(await app.health()).toMatchObject({
      status: "ok",
      dependencies: {
        rpc: { status: "available" },
        simulation: { status: "available" },
        market: { status: "available" },
      },
    });
    // Readiness is a Solana cluster-identity probe, not an EVM chain-id probe:
    // the genesis hash is the only self-describing cluster identity Solana has.
    expect(probed).toContain("getGenesisHash");
    expect(probed.every((m) => !m.startsWith("eth_"))).toBe(true);
    expect(
      app.registry
        .listPrivileged()
        .every((t) => !/sign|broadcast/i.test(t.name)),
    ).toBe(true);
    await app.stop();
  });
  it("refuses readiness when the endpoint answers for a different cluster", async () => {
    // The endpoint is up and well formed; it is simply not the cluster this
    // process was configured for. That has to fail closed, or a devnet URL left
    // in a mainnet deployment reads as healthy.
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      RPC_URL: "https://rpc.test",
    });
    const app = createApplication(c, {
      rpcFetch: vi.fn(
        async (_u: any, init: any) =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: JSON.parse(init.body).id,
              result: CLUSTER_GENESIS_HASHES["mainnet-beta"],
            }),
          ),
      ) as any,
    });
    await app.start();
    expect(app.ready()).toBe(false);
    expect(await app.health()).toMatchObject({
      status: "unavailable",
      dependencies: { rpc: { status: "unhealthy" } },
    });
    await app.stop();
  });
  it("reports configured RPC-backed dependencies unhealthy when the endpoint fails", async () => {
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      RPC_URL: "https://rpc.test",
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
        simulation: { status: "unhealthy" },
        market: { status: "available" },
      },
    });
    await app.stop();
  });
});
