/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: Aetheria's mcp
 * package had no tests. These are new, and are written to run with the OPTIONAL
 * `@modelcontextprotocol/sdk` peer dependency ABSENT — which is how CI runs,
 * since keeping it out of the lockfile is the point.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
import type { Capability } from "../src/agent/types.js";
import {
  createMcpServer,
  loadMcpModule,
  loadStdioTransport,
  MCP_SDK_PACKAGE,
  McpSdkMissingError,
  mcpToolDescriptors,
} from "../src/mcp/index.js";

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "market.price",
    description: "Read a mint's last price.",
    inputSchema: z.object({ mint: z.string().min(32) }),
    outputSchema: z.object({ price: z.number() }),
    capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
    effect: "read",
    parallelSafe: true,
    execute: (input) => ({ price: input.mint.length }),
  });
  r.register({
    name: "order.submit",
    description: "Move value. Requires a write capability.",
    inputSchema: z.object({ size: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
    capabilities: [TRADING_CAPABILITIES.ORDER_WRITE],
    effect: "write",
    parallelSafe: false,
    execute: () => ({ ok: true }),
  });
  return r;
}

const readOnly: readonly Capability[] = [TRADING_CAPABILITIES.MARKET_DATA];

describe("mcp tool catalogue", () => {
  it("advertises only tools the granted capability set covers", () => {
    const tools = mcpToolDescriptors({
      registry: registry(),
      capabilities: readOnly,
    });
    expect(tools.map((t) => t.name)).toEqual(["market.price"]);
    // The write tool is not merely un-invocable — it is not even listed, so an
    // MCP client cannot see a capability it does not have.
    expect(tools.map((t) => t.name)).not.toContain("order.submit");
  });

  it("exposes nothing when no capabilities are granted", () => {
    expect(mcpToolDescriptors({ registry: registry() })).toEqual([]);
  });

  it("emits an object-shaped JSON Schema with the required list", () => {
    const [tool] = mcpToolDescriptors({
      registry: registry(),
      capabilities: readOnly,
    });
    expect(tool?.inputSchema.type).toBe("object");
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("mint");
    expect(tool?.inputSchema.required).toContain("mint");
  });
});

describe("optional SDK dependency", () => {
  it("names the install command rather than throwing a module-not-found", async () => {
    // `@modelcontextprotocol/sdk` is an OPTIONAL peer dependency and is NOT
    // installed here. That is the state CI runs in, and the point of the
    // choice: it stays out of `npm audit --omit=dev`.
    await expect(loadMcpModule()).rejects.toThrow(McpSdkMissingError);
    await expect(loadMcpModule()).rejects.toThrow(
      new RegExp(`npm install ${MCP_SDK_PACKAGE.replace("/", "\\/")}`),
    );
    await expect(loadMcpModule()).rejects.toThrow(/OPTIONAL peer dependency/);
  });

  it("refuses to build a server without the SDK, with the same guidance", async () => {
    await expect(
      createMcpServer({ registry: registry(), capabilities: readOnly }),
    ).rejects.toThrow(McpSdkMissingError);
  });

  it("reports the same for the stdio transport", async () => {
    await expect(loadStdioTransport()).rejects.toThrow(McpSdkMissingError);
  });

  it("is not a production dependency of this package", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(pkg.dependencies[MCP_SDK_PACKAGE]).toBeUndefined();
    expect(pkg.peerDependencies[MCP_SDK_PACKAGE]).toBeDefined();
    expect(pkg.peerDependenciesMeta[MCP_SDK_PACKAGE]?.optional).toBe(true);
  });
});

describe("mcp diagnostics", () => {
  it("never writes to stdout — stdout is the JSON-RPC channel", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const file of ["server.ts", "stdio.ts", "sdk.ts", "index.ts"]) {
      const src = await readFile(
        join(process.cwd(), "src", "mcp", file),
        "utf8",
      );
      // A single console.log here inserts a non-JSON-RPC line into the stream
      // and desynchronises the client.
      expect(src).not.toMatch(/console\.(log|info|debug)\s*\(/);
      expect(src).not.toMatch(/process\.stdout\.write/);
    }
    const bin = await readFile(
      join(process.cwd(), "src", "bin", "mcp.ts"),
      "utf8",
    );
    expect(bin).not.toMatch(/console\.(log|info|debug)\s*\(/);
    expect(bin).toMatch(/console\.error\(/);
  });

  it("the stdio bin grants read-only capabilities only", async () => {
    const { MCP_CAPABILITIES } = await import("../src/bin/mcp.js");
    expect(MCP_CAPABILITIES).not.toContain(TRADING_CAPABILITIES.ORDER_WRITE);
    expect(MCP_CAPABILITIES).not.toContain(TRADING_CAPABILITIES.POSITION_WRITE);
    expect(MCP_CAPABILITIES).toContain(TRADING_CAPABILITIES.MARKET_DATA);
  });
});
