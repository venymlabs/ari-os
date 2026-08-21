/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the tool set is
 * ARI OS's `ToolRegistry` (which already owns validation, capability checks,
 * timeouts and the audit trail) rather than Aetheria's `AnyTool[]`, so the
 * handler delegates to `registry.invoke()` instead of re-validating and calling
 * `tool.execute()` itself. Aetheria's hand-rolled zod→JSON-Schema shim is NOT
 * ported: ARI OS already depends on `zod-to-json-schema`, and the registry's
 * `schemas()` emits the JSON Schema this advertises.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolRegistry } from "../agent/tools/registry.js";
import type { Capability } from "../agent/types.js";
import {
  loadMcpModule,
  type McpRequest,
  type McpServer,
  type McpToolDescriptor,
  type McpToolResult,
} from "./sdk.js";

export const MCP_SERVER_NAME = "ari-os";

export interface McpServerOptions {
  readonly registry: ToolRegistry;
  /**
   * The capability set every `tools/call` runs under.
   *
   * This is the authority boundary of the whole surface and it is set by the
   * COMPOSITION ROOT, never by the MCP client. An IDE connecting over stdio
   * gets exactly what the operator started the process with — it cannot ask for
   * more, and there is no request field it could ask with. Omit it and the
   * server exposes nothing, because a tool whose capabilities are not all
   * granted is neither listed nor invocable.
   */
  readonly capabilities?: readonly Capability[];
  /** Restrict to a named toolset. Omitted, every registered tool is eligible. */
  readonly toolset?: string;
  readonly version?: string;
  /**
   * Diagnostics sink. Defaults to `console.error` — **stderr, never stdout**,
   * because stdout is the JSON-RPC channel and a single stray `console.log`
   * corrupts the protocol stream.
   */
  readonly log?: (message: string) => void;
}

/** The default sink. stderr, deliberately: stdout belongs to the protocol. */
const stderrLog = (message: string): void => {
  console.error(message);
};

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** Render a registry result as the text an MCP client shows. */
function renderResult(
  result: Awaited<ReturnType<ToolRegistry["invoke"]>>,
): McpToolResult {
  if (!result.ok) {
    const detail =
      result.error.details === undefined
        ? ""
        : ` ${safeJson(result.error.details)}`;
    return textResult(
      `${result.tool} failed: ${result.error.code} — ${result.error.message}${detail}`,
      true,
    );
  }
  return textResult(safeJson(result.data));
}

function safeJson(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * The tool descriptors this server advertises, without needing the SDK.
 *
 * Exported so the catalogue can be inspected — and tested — with the optional
 * peer dependency absent, which is how CI runs.
 */
export function mcpToolDescriptors(
  options: Pick<McpServerOptions, "registry" | "capabilities" | "toolset">,
): McpToolDescriptor[] {
  const filter = {
    ...(options.toolset ? { toolset: options.toolset } : {}),
    capabilities: options.capabilities ?? [],
  };
  return options.registry.schemas(filter).map((schema) => {
    const input = schema.inputSchema as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    const properties = input.properties ?? {};
    const required = input.required ?? [];
    return {
      name: schema.name,
      description: schema.description,
      inputSchema:
        required.length > 0
          ? { type: "object" as const, properties, required }
          : { type: "object" as const, properties },
    };
  });
}

/**
 * Build an MCP server that advertises ARI OS's tool registry.
 *
 * `tools/list` returns each eligible tool's name, description and JSON Schema;
 * `tools/call` hands the arguments to `registry.invoke()`, which validates the
 * input against the tool's own zod schema, checks capabilities, enforces the
 * timeout and emits the audit event. Nothing is re-implemented here, so the MCP
 * surface cannot drift from what the agent itself is allowed to do — and, for
 * anything that moves value, `ctx.gateway.execute()` is still the only route.
 *
 * The handler never throws on a tool failure: it returns `isError: true`
 * content so the IDE can render it and the session survives.
 */
export async function createMcpServer(
  options: McpServerOptions,
): Promise<McpServer> {
  const log = options.log ?? stderrLog;
  const capabilities = options.capabilities ?? [];
  const sdk = await loadMcpModule();
  const server = sdk.createServer(
    { name: MCP_SERVER_NAME, version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(sdk.listToolsSchema, () => {
    const tools = mcpToolDescriptors(options);
    log(`[ari-os mcp] tools/list → ${tools.length} tool(s)`);
    return { tools };
  });

  server.setRequestHandler(
    sdk.callToolSchema,
    async (request: McpRequest): Promise<McpToolResult> => {
      const name = request.params?.name;
      if (typeof name !== "string" || !name) {
        return textResult("tools/call is missing a tool name", true);
      }
      // stderr. A `console.log` here would inject a line into the JSON-RPC
      // stream and desynchronise the client.
      log(`[ari-os mcp] tools/call ${name}`);
      try {
        const result = await options.registry.invoke(
          name,
          request.params?.arguments ?? {},
          { capabilities },
        );
        return renderResult(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`[ari-os mcp] tools/call ${name} threw: ${message}`);
        return textResult(`'${name}' failed: ${message}`, true);
      }
    },
  );

  return server;
}
