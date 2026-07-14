import { describe, expect, it, vi } from "vitest";
import {
  DelegationManager,
  DelegationError,
  type ChildRuntime,
  type ChildRuntimeInput,
} from "../src/autonomy/delegation/index.js";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const base = {
  task: "research",
  parentSessionId: "parent",
  parentCapabilities: ["market:read", "memory:write", "execution:trade"],
  requestedCapabilities: ["market:read", "memory:write"],
};

describe("bounded read-only delegation", () => {
  it("hard-cancels a non-cooperative runtime, releases its lane, and absorbs a late rejection", async () => {
    const late = deferred<any>();
    let calls = 0;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: () =>
          ++calls === 1
            ? late.promise
            : Promise.resolve({ summary: "next", iterations: 1, costUsd: 0 }),
      }),
      limits: { concurrency: 1, deadlineMs: 10 },
    });
    const first = manager.spawn(base),
      second = manager.spawn({ ...base, parentSessionId: "other" });
    await expect(first.result).resolves.toMatchObject({
      status: "cancelled",
      error: "deadline exceeded",
    });
    await expect(second.result).resolves.toMatchObject({ status: "completed" });
    late.resolve({ summary: "too late", iterations: 1, costUsd: 0 });
    await Promise.resolve();
    expect(first.status).toBe("cancelled");
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("rejects unknown and mutating capability aliases using a closed allowlist", () => {
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async () => ({ summary: "x", iterations: 1, costUsd: 0 }),
      }),
    });
    for (const capability of [
      "orders:place",
      "funds:transfer",
      "network:post",
      "market:lookup-but-write",
    ])
      expect(() =>
        manager.spawn({
          ...base,
          parentCapabilities: [capability],
          requestedCapabilities: [capability],
        }),
      ).toThrow(/read-only/i);
  });

  it("rejects uncloneable boundaries rather than sharing nested state", () => {
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async () => ({ summary: "x", iterations: 1, costUsd: 0 }),
      }),
    });
    expect(() =>
      manager.spawn({ ...base, context: { nested: { x: 1 }, fn: () => 0 } }),
    ).toThrow(/clone/i);
  });

  it("settles and records hook failures without lying about archive or announce", async () => {
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async () => ({ summary: "x", iterations: 1, costUsd: 0 }),
      }),
      announce: async () => {
        throw new Error("announce boom");
      },
      archive: async () => {
        throw new Error("archive boom");
      },
    });
    await expect(manager.spawn(base).result).resolves.toMatchObject({
      status: "completed",
      announced: false,
      archived: false,
      error: expect.stringMatching(/announce boom.*archive boom/),
    });
  });

  it("deep-freezes runtime and public result boundaries", async () => {
    let input!: ChildRuntimeInput;
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async (i) => (
          (input = i),
          {
            summary: "x",
            iterations: 1,
            costUsd: 0,
            details: { nested: { x: 1 } },
          }
        ),
      }),
    });
    const result = await manager.spawn({
      ...base,
      context: { nested: { x: 1 } },
    }).result;
    expect(Object.isFrozen(input.context)).toBe(true);
    expect(Object.isFrozen((input.context as any).nested)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result.details as any).nested)).toBe(true);
  });

  it("recursively cancels descendants", async () => {
    const manager = new DelegationManager({
      runtimeFactory: () => ({ run: () => new Promise(() => {}) }),
      limits: { concurrency: 3 },
    });
    const child = manager.spawn(base);
    const grandchild = manager.spawn({
      ...base,
      parentSessionId: child.sessionId,
      depth: 1,
    });
    manager.cancelParent("parent", "cascade");
    await expect(child.result).resolves.toMatchObject({ status: "cancelled" });
    await expect(grandchild.result).resolves.toMatchObject({
      status: "cancelled",
    });
  });
  it("spawns nonblocking with fresh isolated context, session metadata, and capability intersection", async () => {
    const gate = deferred<{
      summary: string;
      iterations: number;
      costUsd: number;
    }>();
    const seen: ChildRuntimeInput[] = [];
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async (input) => {
          seen.push(input);
          return gate.promise;
        },
      }),
      limits: {
        maxDepth: 2,
        maxChildren: 2,
        maxIterations: 4,
        deadlineMs: 1000,
        maxCostUsd: 2,
        concurrency: 1,
      },
    });
    const context = { facts: ["x"] };
    const model = { id: "parent-model" };
    const handle = manager.spawn({ ...base, context, model });
    expect(handle.status).toBe("queued");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({
      task: "research",
      capabilities: ["market:read"],
      maxIterations: 4,
      metadata: { parentSessionId: "parent", depth: 1 },
    });
    expect(seen[0]!.sessionId).not.toBe("parent");
    expect(seen[0]!.context).toEqual({ facts: ["x"] });
    expect(seen[0]!.model).not.toBe(model);
    expect(() =>
      (seen[0]!.context as { facts: string[] }).facts.push("child"),
    ).toThrow();
    expect(context).toEqual({ facts: ["x"] });
    gate.resolve({ summary: "done", iterations: 2, costUsd: 0.5 });
    await expect(handle.result).resolves.toMatchObject({
      status: "completed",
      summary: "done",
      parentSessionId: "parent",
      announced: true,
      archived: true,
    });
  });

  it.each([
    "memory:write",
    "skills:install",
    "jobs:create",
    "cron:schedule",
    "approval:request",
    "wallet:sign",
    "tx:broadcast",
    "execution:run",
  ])("permanently denies %s", async (capability) => {
    const factory = vi.fn(() => ({ run: vi.fn() }));
    const manager = new DelegationManager({ runtimeFactory: factory });
    expect(() =>
      manager.spawn({
        ...base,
        parentCapabilities: [capability],
        requestedCapabilities: [capability],
      }),
    ).toThrowError(DelegationError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("enforces depth and per-parent child limits", () => {
    const runtime: ChildRuntime = { run: () => new Promise(() => {}) };
    const manager = new DelegationManager({
      runtimeFactory: () => runtime,
      limits: { maxDepth: 1, maxChildren: 1 },
    });
    manager.spawn({ ...base, depth: 0 });
    expect(() => manager.spawn({ ...base, depth: 0 })).toThrow(/children/i);
    expect(() =>
      manager.spawn({ ...base, parentSessionId: "other", depth: 1 }),
    ).toThrow(/depth/i);
  });

  it("queues by concurrency lane and starts the next child after completion", async () => {
    const gates = [deferred<any>(), deferred<any>()];
    let calls = 0;
    const manager = new DelegationManager({
      runtimeFactory: () => ({ run: () => gates[calls++]!.promise }),
      limits: { concurrency: 1 },
    });
    const first = manager.spawn(base);
    const second = manager.spawn({ ...base, parentSessionId: "p2" });
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(second.status).toBe("queued");
    gates[0]!.resolve({ summary: "one", iterations: 1, costUsd: 0 });
    await first.result;
    await vi.waitFor(() => expect(calls).toBe(2));
    gates[1]!.resolve({ summary: "two", iterations: 1, costUsd: 0 });
    await second.result;
  });

  it("fails and archives results exceeding iteration or cost budgets and invokes verification", async () => {
    const verify = vi.fn(async () => false);
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async () => ({ summary: "claim", iterations: 3, costUsd: 2 }),
      }),
      verifyResult: verify,
      limits: { maxIterations: 2, maxCostUsd: 1 },
    });
    const result = await manager.spawn(base).result;
    expect(result).toMatchObject({
      status: "failed",
      archived: true,
      announced: false,
      error: "budget exceeded",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires result verification before announcing a structured summary", async () => {
    const announce = vi.fn();
    const archive = vi.fn();
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: async () => ({ summary: "claim", iterations: 1, costUsd: 0 }),
      }),
      verifyResult: async () => false,
      announce,
      archive,
    });
    const result = await manager.spawn(base).result;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/verification/i);
    expect(announce).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledOnce();
  });

  it("cascades parent cancellation to running and queued descendants", async () => {
    const aborted: string[] = [];
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: (input) =>
          new Promise((_r, reject) =>
            input.signal.addEventListener(
              "abort",
              () => {
                aborted.push(input.sessionId);
                reject(input.signal.reason);
              },
              { once: true },
            ),
          ),
      }),
      limits: { concurrency: 1 },
    });
    const a = manager.spawn(base),
      b = manager.spawn({ ...base, parentSessionId: "parent" });
    await vi.waitFor(() => expect(a.status).toBe("running"));
    manager.cancelParent("parent", "stop");
    await expect(a.result).resolves.toMatchObject({
      status: "cancelled",
      archived: true,
    });
    await expect(b.result).resolves.toMatchObject({
      status: "cancelled",
      archived: true,
    });
    expect(aborted).toHaveLength(1);
  });

  it("cancels at the child deadline", async () => {
    vi.useFakeTimers();
    const manager = new DelegationManager({
      runtimeFactory: () => ({
        run: (input) =>
          new Promise((_r, reject) =>
            input.signal.addEventListener(
              "abort",
              () => reject(input.signal.reason),
              { once: true },
            ),
          ),
      }),
      limits: { deadlineMs: 10 },
    });
    const handle = manager.spawn(base);
    await vi.advanceTimersByTimeAsync(11);
    await expect(handle.result).resolves.toMatchObject({
      status: "cancelled",
      error: "deadline exceeded",
      archived: true,
    });
    vi.useRealTimers();
  });
});
