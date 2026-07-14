import { describe, expect, it, vi } from "vitest";
import {
  ModelHttpError,
  ModelRouter,
  RateLimitHealthTracker,
  OpenAICompatibleTransport,
  classifyModelError,
  type ModelCandidate,
  type ModelRequest,
} from "../src/agent/models/index.js";

const request: ModelRequest = {
  messages: [{ role: "user", content: "hello" }],
  requiredTools: ["search"],
  contextTokens: 8_000,
};
const candidate = (
  id: string,
  overrides: Partial<ModelCandidate> = {},
): ModelCandidate => ({
  id,
  provider: "compatible",
  model: id,
  transport: id,
  contextWindow: 16_000,
  supportedTools: ["search"],
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
  ...overrides,
});
const canonical = {
  id: "r",
  provider: "x",
  model: "x",
  content: "ok",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
};

class AbortLikeError extends Error {
  name = "AbortError";
}

describe("provider-neutral model routing", () => {
  it("enforces context plus output and orders by estimated request cost", () => {
    const router = new ModelRouter(
      [
        candidate("output-overflow", {
          contextWindow: 9_000,
          inputCostPerMillion: 0,
        }),
        candidate("cheap-for-request", {
          inputCostPerMillion: 2,
          outputCostPerMillion: 1,
        }),
        candidate("bad-blended-price", {
          inputCostPerMillion: 1,
          outputCostPerMillion: 20,
        }),
      ],
      {},
    );
    expect(
      router.route({ ...request, contextTokens: 8_000, maxOutputTokens: 2_000 })
        .id,
    ).toBe("cheap-for-request");
  });

  it("validates candidate configuration including duplicate IDs", () => {
    expect(() => new ModelRouter([candidate("x"), candidate("x")], {})).toThrow(
      /duplicate/i,
    );
    expect(
      () => new ModelRouter([candidate("x", { contextWindow: -1 })], {}),
    ).toThrow(/context/i);
    expect(
      () =>
        new ModelRouter(
          [candidate("x", { inputCostPerMillion: Number.NaN })],
          {},
        ),
    ).toThrow(/cost/i);
    expect(
      () => new ModelRouter([], {}, undefined, { maxRetries: -1 }),
    ).toThrow(/retr/i);
  });

  it("reports a missing configured transport", async () => {
    await expect(
      new ModelRouter([candidate("x")], {}).complete(request),
    ).rejects.toThrow(/transport.*x/i);
  });

  it("rate limits block immediate same-candidate retry and honor injected clock", async () => {
    let now = 1_000;
    const health = new RateLimitHealthTracker(() => now);
    const a = vi.fn().mockRejectedValue(new ModelHttpError("busy", 429, 2_000));
    const b = vi.fn().mockResolvedValue(canonical);
    const router = new ModelRouter(
      [candidate("a"), candidate("b", { inputCostPerMillion: 2 })],
      { a: { complete: a }, b: { complete: b } },
      health,
      { maxRetries: 3, now: () => now },
    );
    await expect(router.complete(request)).resolves.toMatchObject({
      model: "b",
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(health.isHealthy("a")).toBe(false);
    now = 3_001;
    expect(health.isHealthy("a")).toBe(true);
  });

  it("uses injectable sleep and jitter for transient retries", async () => {
    const a = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue(canonical);
    const sleep = vi.fn(async () => undefined);
    const router = new ModelRouter(
      [candidate("a")],
      { a: { complete: a } },
      undefined,
      { maxRetries: 1, sleep, jitter: () => 0 },
    );
    await router.complete(request);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("never retries or falls back after abort before dispatch or during fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const a = vi.fn();
    await expect(
      new ModelRouter([candidate("a")], { a: { complete: a } }).complete({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(a).not.toHaveBeenCalled();
    const during = vi.fn().mockRejectedValue(new AbortLikeError("aborted"));
    const fallback = vi.fn().mockResolvedValue(canonical);
    await expect(
      new ModelRouter(
        [candidate("a"), candidate("b", { inputCostPerMillion: 2 })],
        { a: { complete: during }, b: { complete: fallback } },
        undefined,
        { maxRetries: 2 },
      ).complete(request),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(during).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("classifies protocol failures for fallback and transient HTTP statuses", () => {
    expect(classifyModelError({ status: 408 })).toMatchObject({
      retryable: true,
      fallback: true,
    });
    expect(classifyModelError({ status: 425 })).toMatchObject({
      retryable: true,
      fallback: true,
    });
    expect(
      classifyModelError(new SyntaxError("bad provider JSON")),
    ).toMatchObject({ retryable: false, fallback: true });
    expect(classifyModelError(new AbortLikeError())).toEqual({
      retryable: false,
      fallback: false,
      rateLimited: false,
    });
  });
});

describe("OpenAI-compatible transport", () => {
  const valid = {
    id: "cmpl",
    model: "gpt-x",
    choices: [
      {
        message: {
          content: "done",
          tool_calls: [
            {
              id: "tc",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  };

  it("maps canonical tool history, required tools, headers, signal, and trailing slashes", async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe("https://models.test/v1/chat/completions");
        expect(init?.signal).toBe(signal);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer sekret",
          "X-Test": "yes",
          "content-type": "application/json",
        });
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toEqual([
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "search", arguments: '{"q":"x"}' },
              },
            ],
          },
          {
            role: "tool",
            content: "result",
            tool_call_id: "call-1",
            name: "search",
          },
        ]);
        expect(body.tool_choice).toBe("required");
        return new Response(JSON.stringify(valid), { status: 200 });
      },
    );
    const transport = new OpenAICompatibleTransport({
      baseUrl: "https://models.test/v1///",
      credential: { id: "ref", resolve: async () => "sekret" },
      defaultHeaders: { "X-Test": "yes" },
      fetch,
    });
    const result = await transport.complete({
      model: "gpt-x",
      signal,
      requiredTools: ["search"],
      tools: [{ name: "search", inputSchema: { type: "object" } }],
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "search", arguments: { q: "x" } }],
        },
        {
          role: "tool",
          content: "result",
          toolCallId: "call-1",
          name: "search",
        },
      ],
    });
    expect(result.toolCalls[0]?.arguments).toEqual({ q: "x" });
  });

  it.each([
    ["empty choices", { ...valid, choices: [] }],
    [
      "wrong usage",
      {
        ...valid,
        usage: { prompt_tokens: "4", completion_tokens: 3, total_tokens: 7 },
      },
    ],
    [
      "duplicate tool IDs",
      {
        ...valid,
        choices: [
          {
            ...valid.choices[0],
            message: {
              content: null,
              tool_calls: [
                valid.choices[0]!.message.tool_calls[0],
                valid.choices[0]!.message.tool_calls[0],
              ],
            },
          },
        ],
      },
    ],
    [
      "invalid tool arguments",
      {
        ...valid,
        choices: [
          {
            ...valid.choices[0],
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tc",
                  type: "function",
                  function: { name: "search", arguments: "{" },
                },
              ],
            },
          },
        ],
      },
    ],
  ])("rejects malformed successful response: %s", async (_name, body) => {
    const transport = new OpenAICompatibleTransport({
      baseUrl: "https://x",
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    await expect(
      transport.complete({ ...request, model: "x" }),
    ).rejects.toThrow();
  });

  it("malformed JSON permits router fallback", async () => {
    const bad = new OpenAICompatibleTransport({
      baseUrl: "https://x",
      fetch: async () => new Response("not-json", { status: 200 }),
    });
    const good = { complete: vi.fn().mockResolvedValue(canonical) };
    await expect(
      new ModelRouter(
        [candidate("bad"), candidate("good", { inputCostPerMillion: 2 })],
        { bad, good },
      ).complete(request),
    ).resolves.toMatchObject({ model: "good" });
  });

  it.each([
    { "retry-after": "2" },
    { "retry-after": "Sun, 12 Jul 2026 00:00:03 GMT" },
    {},
  ])("parses Retry-After safely: %j", async (headers) => {
    const transport = new OpenAICompatibleTransport({
      baseUrl: "https://x",
      now: () => Date.parse("2026-07-12T00:00:00Z"),
      fetch: async () => new Response("busy", { status: 429, headers }),
    });
    const rejection = expect(
      transport.complete({ ...request, model: "x" }),
    ).rejects;
    if ("retry-after" in headers)
      await rejection.toMatchObject({
        retryAfterMs: headers["retry-after"] === "2" ? 2000 : 3000,
      });
    else await rejection.toMatchObject({ retryAfterMs: undefined });
  });

  it("bounds and redacts HTTP error bodies", async () => {
    const transport = new OpenAICompatibleTransport({
      baseUrl: "https://x",
      fetch: async () =>
        new Response(
          `Bearer abc123 api_key=supersecret ${"x".repeat(10_000)}`,
          { status: 500 },
        ),
    });
    try {
      await transport.complete({ ...request, model: "x" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelHttpError);
      const message = (error as Error).message;
      expect(message.length).toBeLessThan(1200);
      expect(message).not.toContain("abc123");
      expect(message).not.toContain("supersecret");
    }
  });

  it("does not dispatch when credential resolution fails", async () => {
    const fetch = vi.fn();
    const transport = new OpenAICompatibleTransport({
      baseUrl: "https://x",
      credential: {
        id: "secret-ref",
        resolve: async () => {
          throw new Error("credential unavailable");
        },
      },
      fetch,
    });
    await expect(
      transport.complete({ ...request, model: "x" }),
    ).rejects.toThrow("credential unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
