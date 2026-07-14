import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import {
  TRADING_CAPABILITIES,
  type ToolAuditEvent,
} from "../src/agent/types.js";

const quoteTool = {
  name: "market.quote",
  description: "Get a quote",
  inputSchema: z.object({ symbol: z.string() }),
  outputSchema: z.object({ price: z.number() }),
  capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
  effect: "read" as const,
  parallelSafe: true,
  execute: async ({ symbol }: { symbol: string }) => ({
    price: symbol === "ETH" ? 3000 : 0,
  }),
};

describe("capability-aware ToolRegistry", () => {
  it("registers tools and exposes deterministic model schemas and toolsets", () => {
    const registry = new ToolRegistry()
      .register(quoteTool)
      .defineToolset("research", ["market.quote"]);
    expect(registry.list()).toEqual([]);
    expect(registry.listPrivileged().map((tool) => tool.name)).toEqual([
      "market.quote",
    ]);
    expect(
      registry.list({
        toolset: "research",
        capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
      }),
    ).toHaveLength(1);
    expect(registry.schemas()).toEqual([]);
    expect(registry.schemasPrivileged()).toEqual([
      {
        name: "market.quote",
        description: "Get a quote",
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ type: "object" }),
      },
    ]);
    expect(() => registry.register(quoteTool)).toThrow(/already registered/);
    expect(() => registry.defineToolset("bad", ["missing"])).toThrow(
      /Unknown tool/,
    );
  });

  it("filters unavailable and unauthorized tools", async () => {
    const registry = new ToolRegistry().register({
      ...quoteTool,
      availability: async () => ({ available: false, reason: "feed down" }),
    });
    expect(
      await registry.available({
        capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
      }),
    ).toEqual([]);
    const denied = await registry.invoke(
      "market.quote",
      { symbol: "ETH" },
      { capabilities: [] },
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
  });

  it("validates input and output and returns stable success/error envelopes", async () => {
    const registry = new ToolRegistry().register(quoteTool);
    await expect(
      registry.invoke(
        "market.quote",
        {},
        {
          capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
          invocationId: "i1",
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      invocationId: "i1",
      tool: "market.quote",
      error: { code: "INVALID_INPUT" },
    });
    await expect(
      registry.invoke(
        "market.quote",
        { symbol: "ETH" },
        {
          capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
          invocationId: "i2",
        },
      ),
    ).resolves.toEqual({
      ok: true,
      invocationId: "i2",
      tool: "market.quote",
      data: { price: 3000 },
    });
    const broken = new ToolRegistry().register({
      ...quoteTool,
      name: "broken",
      execute: async () => ({ price: "bad" }) as unknown as { price: number },
    });
    expect(
      await broken.invoke(
        "broken",
        { symbol: "ETH" },
        { capabilities: [TRADING_CAPABILITIES.MARKET_DATA] },
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_OUTPUT" } });
  });

  it("enforces timeout and caller cancellation", async () => {
    const registry = new ToolRegistry().register({
      ...quoteTool,
      name: "slow",
      timeoutMs: 5,
      execute: async (_input, context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          ),
        ),
    });
    expect(
      await registry.invoke(
        "slow",
        { symbol: "ETH" },
        { capabilities: [TRADING_CAPABILITIES.MARKET_DATA] },
      ),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    const controller = new AbortController();
    controller.abort();
    expect(
      await registry.invoke(
        "slow",
        { symbol: "ETH" },
        {
          capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
          signal: controller.signal,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });

  it("hard-stops handlers that ignore abort and exports rich schemas", async () => {
    const registry = new ToolRegistry().register({
      ...quoteTool,
      name: "rich",
      timeoutMs: 5,
      inputSchema: z.object({
        side: z.enum(["buy", "sell"]).describe("side"),
        mode: z.literal("limit"),
        target: z.union([z.string(), z.number()]),
        note: z.string().nullable(),
        quantity: z.number().min(1).max(10).default(1),
        tag: z
          .string()
          .min(2)
          .max(8)
          .regex(/^[a-z]+$/),
      }),
      outputSchema: z.object({ status: z.enum(["open", "closed"]) }),
      execute: async () => new Promise<never>(() => undefined),
    });
    await expect(
      registry.invoke(
        "rich",
        { side: "buy", mode: "limit", target: 1, note: null, tag: "ok" },
        { capabilities: [TRADING_CAPABILITIES.MARKET_DATA] },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    const schema = registry.schemasPrivileged()[0]!;
    expect(schema.inputSchema).toMatchObject({
      properties: {
        side: { enum: ["buy", "sell"], description: "side" },
        mode: { const: "limit" },
        target: { type: ["string", "number"] },
        note: { type: ["string", "null"] },
        quantity: { minimum: 1, maximum: 10, default: 1 },
        tag: { minLength: 2, maxLength: 8, pattern: "^[a-z]+$" },
      },
    });
    expect(schema.outputSchema).toMatchObject({
      properties: { status: { enum: ["open", "closed"] } },
    });
  });

  it("contains availability exceptions and audits every rejection", async () => {
    const events: ToolAuditEvent[] = [];
    const broken = {
      ...quoteTool,
      name: "broken-availability",
      availability: async () => {
        throw new Error("feed exploded");
      },
    };
    const registry = new ToolRegistry({
      audit: (event) => {
        events.push(event);
      },
    })
      .register(quoteTool)
      .register(broken);
    await expect(
      registry.available({ capabilities: [TRADING_CAPABILITIES.MARKET_DATA] }),
    ).resolves.toEqual([quoteTool]);
    await registry.invoke(
      "missing",
      {},
      { capabilities: [], invocationId: "unknown" },
    );
    await registry.invoke(
      "market.quote",
      {},
      { capabilities: [], invocationId: "denied" },
    );
    await registry.invoke(
      "market.quote",
      {},
      {
        capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
        invocationId: "invalid",
      },
    );
    await expect(
      registry.invoke(
        "broken-availability",
        { symbol: "ETH" },
        {
          capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
          invocationId: "unavailable",
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "feed exploded" },
    });
    expect(
      events.filter((e) => e.phase === "finish").map((e) => e.errorCode),
    ).toEqual([
      "UNKNOWN_TOOL",
      "CAPABILITY_DENIED",
      "INVALID_INPUT",
      "UNAVAILABLE",
    ]);
  });

  it("emits audit hooks without allowing hook failures to alter results", async () => {
    const events: ToolAuditEvent[] = [];
    const registry = new ToolRegistry({
      audit: async (event) => {
        events.push(event);
        if (event.phase === "finish") throw new Error("sink down");
      },
    }).register(quoteTool);
    const result = await registry.invoke(
      "market.quote",
      { symbol: "ETH" },
      {
        capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
        invocationId: "audit-1",
      },
    );
    expect(result.ok).toBe(true);
    expect(events.map((event) => event.phase)).toEqual(["start", "finish"]);
    expect(events[0]).toMatchObject({
      invocationId: "audit-1",
      effect: "read",
      parallelSafe: true,
    });
  });

  it("classifies state-changing trading tools and prevents unsafe parallel batches", async () => {
    const place = {
      ...quoteTool,
      name: "orders.place",
      capabilities: [TRADING_CAPABILITIES.ORDER_WRITE],
      effect: "trade" as const,
      parallelSafe: false,
    };
    const admin = {
      ...quoteTool,
      name: "system.configure",
      effect: "admin" as const,
      parallelSafe: false,
    };
    const registry = new ToolRegistry()
      .register(quoteTool)
      .register(place)
      .register(admin);
    expect(registry.classify("orders.place")).toEqual({
      effect: "trade",
      parallelSafe: false,
    });
    expect(registry.classify("system.configure")).toEqual({
      effect: "admin",
      parallelSafe: false,
    });
    await expect(
      registry.invokeParallel(
        [{ name: "orders.place", input: { symbol: "ETH" } }],
        { capabilities: [TRADING_CAPABILITIES.ORDER_WRITE] },
      ),
    ).rejects.toThrow(/not parallel-safe/);
    const results = await registry.invokeParallel(
      [{ name: "market.quote", input: { symbol: "ETH" } }],
      { capabilities: [TRADING_CAPABILITIES.MARKET_DATA] },
    );
    expect(results[0]?.ok).toBe(true);
  });
});
