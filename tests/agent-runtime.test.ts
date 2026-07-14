import { describe, expect, it, vi } from "vitest";
import {
  AgentRuntime,
  AgentRuntimeError,
  type AgentEvent,
  type ModelProvider,
  type ToolDispatcher,
} from "../src/agent/runtime/index.js";

const user = { role: "user" as const, content: "quote ETH" };
const response = (
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [],
) => ({
  message: { role: "assistant" as const, content, toolCalls },
  usage: { inputTokens: 2, outputTokens: 3 },
});
async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function provider(
  outputs: Array<ReturnType<typeof response> | Error>,
  id = "p",
): ModelProvider {
  return {
    id,
    complete: vi.fn(async () => {
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected model call");
      return next;
    }),
  };
}

const dispatcher = (effect: "read" | "proposal" = "read"): ToolDispatcher => ({
  classify: vi.fn(() => ({ effect })),
  dispatch: vi.fn(async (call) => ({
    ok: true,
    toolCallId: call.id,
    name: call.name,
    data: { price: 3000 },
  })),
});

describe("AgentRuntime", () => {
  it("streams a canonical lifecycle through completion", async () => {
    const events = await collect(
      new AgentRuntime({ providers: [provider([response("done")])] }).run({
        messages: [user],
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "iteration.started",
      "model.requested",
      "model.responded",
      "run.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      message: { role: "assistant", content: "done" },
      iterations: 1,
      toolCalls: 0,
    });
  });

  it("persists the assistant tool request before dispatch and feeds results into the next iteration", async () => {
    const model = provider([
      response("", [
        { id: "c1", name: "market.quote", arguments: { symbol: "ETH" } },
      ]),
      response("3000"),
    ]);
    const tools = dispatcher();
    const order: string[] = [];
    (tools.dispatch as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push("dispatch");
        return { ok: true, toolCallId: "c1", name: "market.quote", data: 3000 };
      },
    );
    const persist = vi.fn(async (message) => {
      order.push(`persist:${message.role}`);
    });
    const events = await collect(
      new AgentRuntime({
        providers: [model],
        tools,
        persistMessage: persist,
      }).run({ messages: [user] }),
    );
    expect(order.slice(0, 2)).toEqual(["persist:assistant", "dispatch"]);
    expect(order).toEqual([
      "persist:assistant",
      "dispatch",
      "persist:tool",
      "persist:assistant",
    ]);
    expect(events.map((e) => e.type)).toContain("tool.started");
    expect(events.map((e) => e.type)).toContain("tool.completed");
    expect(model.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", toolCallId: "c1" }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("enforces iteration and tool-call budgets", async () => {
    const call = response("", [{ id: "c", name: "read", arguments: {} }]);
    const iterationEvents = await collect(
      new AgentRuntime({
        providers: [provider([call, call])],
        tools: dispatcher(),
        maxIterations: 1,
      }).run({ messages: [user] }),
    );
    expect(iterationEvents.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "ITERATION_BUDGET_EXCEEDED" },
    });
    const toolEvents = await collect(
      new AgentRuntime({
        providers: [
          provider([
            response("", [
              { id: "1", name: "a", arguments: {} },
              { id: "2", name: "b", arguments: {} },
            ]),
          ]),
        ],
        tools: dispatcher(),
        maxToolCalls: 1,
      }).run({ messages: [user] }),
    );
    expect(toolEvents.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "TOOL_BUDGET_EXCEEDED" },
    });
  });

  it("detects repeated tool-call loops", async () => {
    const call = response("", [
      { id: "different", name: "read", arguments: { x: 1 } },
    ]);
    const events = await collect(
      new AgentRuntime({
        providers: [provider([call, call, call])],
        tools: dispatcher(),
        maxRepeatedToolCalls: 2,
      }).run({ messages: [user] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "LOOP_DETECTED" },
    });
  });

  it("honors cancellation and deadlines", async () => {
    const hanging: ModelProvider = {
      id: "slow",
      complete: (_request, signal) =>
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    };
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(
      (
        await collect(
          new AgentRuntime({ providers: [hanging] }).run({
            messages: [user],
            signal: controller.signal,
          }),
        )
      ).at(-1),
    ).toMatchObject({ type: "run.cancelled" });
    expect(
      (
        await collect(
          new AgentRuntime({ providers: [hanging] }).run({
            messages: [user],
            deadline: Date.now() + 5,
          }),
        )
      ).at(-1),
    ).toMatchObject({
      type: "run.failed",
      error: { code: "DEADLINE_EXCEEDED" },
    });
  });

  it("falls back providers before tools but never after a tool side effect", async () => {
    const first = provider([new Error("down")], "first");
    const second = provider([response("ok")], "second");
    const events = await collect(
      new AgentRuntime({ providers: [first, second] }).run({
        messages: [user],
      }),
    );
    expect(events.filter((e) => e.type === "provider.failed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });

    const primary = provider(
      [
        response("", [{ id: "x", name: "proposal.trade", arguments: {} }]),
        new Error("lost"),
      ],
      "primary",
    );
    const fallback = provider([response("must not run")], "fallback");
    const afterTool = await collect(
      new AgentRuntime({
        providers: [primary, fallback],
        tools: dispatcher("proposal"),
      }).run({ messages: [user] }),
    );
    expect(afterTool.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "MODEL_ERROR" },
    });
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it("rejects signer/write tools because the runtime only permits read and proposal effects", async () => {
    const events = await collect(
      new AgentRuntime({
        providers: [
          provider([
            response("", [{ id: "x", name: "wallet.sign", arguments: {} }]),
          ]),
        ],
        tools: dispatcher("proposal"),
      }).run({ messages: [user] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "UNSAFE_TOOL" },
    });
    const writes = dispatcher("write" as "proposal");
    const denied = await collect(
      new AgentRuntime({
        providers: [
          provider([
            response("", [{ id: "x", name: "wallet.sign", arguments: {} }]),
          ]),
        ],
        tools: writes,
      }).run({ messages: [user] }),
    );
    expect(denied.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "UNSAFE_TOOL" },
    });
  });

  it("validates batches, provider responses, IDs, and exact repeat boundary", async () => {
    const tools = dispatcher();
    const mixed = response("", [
      { id: "a", name: "market.quote", arguments: {} },
      { id: "b", name: "wallet.broadcastRaw", arguments: {} },
    ]);
    const unsafe = await collect(
      new AgentRuntime({ providers: [provider([mixed])], tools }).run({
        messages: [user],
      }),
    );
    expect(unsafe.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "UNSAFE_TOOL" },
    });
    expect(tools.dispatch).not.toHaveBeenCalled();
    for (const bad of [
      { message: { role: "user", content: "bad" } },
      response("", [{ id: "", name: "read", arguments: {} }]),
      response("", [
        { id: "x", name: "read", arguments: {} },
        { id: "x", name: "read", arguments: {} },
      ]),
    ]) {
      const events = await collect(
        new AgentRuntime({
          providers: [provider([bad as ReturnType<typeof response>])],
          tools: dispatcher(),
        }).run({ messages: [user] }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        error: { code: "MODEL_ERROR" },
      });
    }
    const call = response("", [{ id: "x", name: "read", arguments: { n: 1 } }]);
    const repeated = await collect(
      new AgentRuntime({
        providers: [provider([call, call, call, call])],
        tools: dispatcher(),
        maxRepeatedToolCalls: 3,
      }).run({ messages: [user] }),
    );
    expect(repeated.filter((e) => e.type === "tool.completed")).toHaveLength(3);
    expect(repeated.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "LOOP_DETECTED" },
    });
  });

  it("hard-races noncooperative work and persists final/lifecycle state", async () => {
    const never = new Promise<never>(() => {});
    const deadline = await collect(
      new AgentRuntime({
        providers: [{ id: "slow", complete: () => never }],
      }).run({ messages: [user], deadline: Date.now() + 5 }),
    );
    expect(deadline.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    const tools = dispatcher();
    (tools.dispatch as ReturnType<typeof vi.fn>).mockReturnValue(never);
    const controller = new AbortController();
    setTimeout(() => controller.abort("stop"), 5);
    const cancelled = await collect(
      new AgentRuntime({
        providers: [
          provider([response("", [{ id: "x", name: "read", arguments: {} }])]),
        ],
        tools,
      }).run({ messages: [user], signal: controller.signal }),
    );
    expect(cancelled.at(-1)).toMatchObject({ type: "run.cancelled" });
    const statuses: string[] = [];
    const messages: string[] = [];
    await collect(
      new AgentRuntime({
        providers: [
          provider([
            response("", [{ id: "x", name: "read", arguments: {} }]),
            response("done"),
          ]),
        ],
        tools: dispatcher(),
        persistMessage: (m) => {
          messages.push(m.role);
        },
        persistToolLifecycle: (r) => {
          statuses.push(r.status);
        },
      }).run({ messages: [user] }),
    );
    expect(statuses).toEqual(["planned", "started", "succeeded"]);
    expect(messages).toEqual(["assistant", "tool", "assistant"]);
  });

  it("records reconciliation-required when post-execution persistence fails", async () => {
    const statuses: string[] = [];
    const events = await collect(
      new AgentRuntime({
        providers: [
          provider([response("", [{ id: "x", name: "read", arguments: {} }])]),
        ],
        tools: dispatcher(),
        persistMessage: (m) => {
          if (m.role === "tool") throw new Error("db");
        },
        persistToolLifecycle: (r) => {
          statuses.push(r.status);
        },
      }).run({ messages: [user] }),
    );
    expect(statuses).toEqual([
      "planned",
      "started",
      "succeeded",
      "reconciliation-required",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: { code: "RECONCILIATION_REQUIRED" },
    });
  });

  it("validates construction and exposes typed runtime errors", () => {
    expect(() => new AgentRuntime({ providers: [] })).toThrow(
      AgentRuntimeError,
    );
    expect(
      () => new AgentRuntime({ providers: [provider([])], maxIterations: 0 }),
    ).toThrow(/maxIterations/);
  });
});
