/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the transport is
 * loaded lazily (the SDK is an optional peer dependency here) instead of
 * imported statically.
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadStdioTransport, type McpServer } from "./sdk.js";

/**
 * Connect an MCP server to stdio and keep it running.
 *
 * The client (Claude Code, Cursor, …) spawns this process and speaks JSON-RPC
 * over stdin/stdout. **stdout is the protocol channel**: every diagnostic,
 * every log line, every warning must go to stderr via `console.error`. One
 * `console.log` anywhere in the process — including inside a tool — inserts a
 * non-JSON-RPC line into the stream and the client desynchronises.
 *
 * Resolves when the transport closes.
 */
export async function runStdio(server: McpServer): Promise<void> {
  const transport = await loadStdioTransport();
  await server.connect(transport);
}
