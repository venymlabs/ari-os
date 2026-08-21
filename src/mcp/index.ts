/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ARI OS's tool registry, exposed over the Model Context Protocol via stdio.
 *
 * Two properties worth stating up front:
 *
 *  · **Authority comes from the composition root.** The capability set a
 *    `tools/call` runs under is fixed when the server is built. An MCP client
 *    cannot request more, and every invocation still goes through
 *    `ToolRegistry.invoke()` — same validation, same capability check, same
 *    timeout, same audit event. For anything that moves value,
 *    `TradeGateway.execute()` is still the only route to a signature.
 *
 *  · **stdout is the protocol.** Diagnostics go to stderr. See `stdio.ts`.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL peer dependency, loaded lazily, so
 * a deployment that does not speak MCP neither installs nor audits it.
 */

export {
  createMcpServer,
  mcpToolDescriptors,
  MCP_SERVER_NAME,
} from "./server.js";
export type { McpServerOptions } from "./server.js";
export { runStdio } from "./stdio.js";
export {
  loadMcpModule,
  loadStdioTransport,
  MCP_SDK_PACKAGE,
  McpSdkMissingError,
} from "./sdk.js";
export type {
  McpModule,
  McpRequest,
  McpServer,
  McpToolDescriptor,
  McpToolResult,
} from "./sdk.js";
