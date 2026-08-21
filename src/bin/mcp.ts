#!/usr/bin/env node
/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: Aetheria's bin
 * threw on every `tools/call` because it had no way to build a real tool
 * context; ARI OS composes the same `Application` the daemon does, so calls are
 * live against whatever that composition actually mounts.
 * SPDX-License-Identifier: Apache-2.0
 */

import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/index.js";
import { createApplication } from "../app/index.js";
import { TRADING_CAPABILITIES } from "../agent/types.js";
import type { Capability } from "../agent/types.js";
import { createMcpServer, runStdio } from "../mcp/index.js";

/**
 * Stdio entry point: point an MCP client at this binary and it exposes ARI OS's
 * read-side tools.
 *
 * **Read-only by default, and not by accident.** The granted capability set
 * below is market data, risk analysis, simulation and portfolio reads —
 * everything that answers a question and nothing that moves value. An MCP
 * client is an IDE talking to a process over a pipe; it is not the operator
 * console, it has no session, no scope check and no approvals path, so it does
 * not get `ORDER_WRITE` or `POSITION_WRITE`. Widening this is a deliberate
 * edit to this file by whoever runs the daemon, not a flag a client can pass.
 *
 * Custody is likewise not mounted here: `createApplication` is called with no
 * wallet, so the venue toolsets are not registered at all.
 *
 * Every diagnostic goes to stderr — stdout is the JSON-RPC channel.
 */
export const MCP_CAPABILITIES: readonly Capability[] = [
  TRADING_CAPABILITIES.MARKET_DATA,
  TRADING_CAPABILITIES.RISK_ANALYSIS,
  TRADING_CAPABILITIES.ORDER_SIMULATE,
  TRADING_CAPABILITIES.PORTFOLIO_READ,
];

export async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const app = createApplication(config);
  await app.start();
  try {
    const server = await createMcpServer({
      registry: app.registry,
      capabilities: MCP_CAPABILITIES,
      version: process.env.npm_package_version ?? "0.1.0",
    });
    console.error(
      `[ari-os mcp] stdio transport ready — ${config.network}, read-only capabilities`,
    );
    await runStdio(server);
    console.error("[ari-os mcp] stdio transport closed.");
    return 0;
  } finally {
    await app.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      "[ari-os mcp] fatal:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
