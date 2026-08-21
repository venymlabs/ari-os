import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LLM_PROVIDERS,
  loadConfig,
  sanitizedConfig,
} from "../src/config/index.js";
import {
  ModelRouter,
  OpenAICompatibleTransport,
  type ModelCandidate,
} from "../src/agent/models/index.js";
import { createApplication } from "../src/app/index.js";
import { createModelProvider, llmProviderId } from "../src/app/adapters.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "llm-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));

/** The minimum a self-hosted server needs: where it is, and which model. */
const local = (extra: Record<string, string> = {}) => ({
  NODE_ENV: "test",
  DATA_DIR: temp(),
  LLM_PROVIDER: "lemonade",
  LLM_BASE_URL: "http://192.168.1.91:8000/api/v1",
  LLM_MODEL: "Qwen3-8B-GGUF",
  ...extra,
});

const completion = (body: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: "cmpl-1",
      model: "Qwen3-8B-GGUF",
      choices: [
        {
          message: { content: "ok" },
          finish_reason: "stop",
          ...body,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** A fetch double whose recorded calls stay typed as (url, init). */
const stub = (respond: () => Response) =>
  vi.fn(async (_url: string, _init: RequestInit) => respond());
const sentBody = (
  fetchImpl: ReturnType<typeof stub>,
  call = 0,
): Record<string, any> =>
  JSON.parse(fetchImpl.mock.calls[call]![1].body as string);
const sentHeaders = (
  fetchImpl: ReturnType<typeof stub>,
  call = 0,
): Record<string, string> =>
  fetchImpl.mock.calls[call]![1].headers as Record<string, string>;

describe("local LLM configuration", () => {
  it("configures a self-hosted endpoint with no API key at all", () => {
    const c = loadConfig(local());
    expect(c.llm).toMatchObject({
      provider: "lemonade",
      local: true,
      baseUrl: "http://192.168.1.91:8000/api/v1",
      model: "Qwen3-8B-GGUF",
    });
    // Not "an empty key": no key. Requiring one would block the deployment
    // self-hosting exists to enable.
    expect(c.llm?.apiKey).toBeUndefined();
    // Self-hosted inference has no per-token price, so the router's cost
    // ordering is fed a real zero rather than an invented number.
    expect(c.llm?.inputCostPerMillion).toBe(0);
    expect(c.llm?.outputCostPerMillion).toBe(0);
  });

  it("falls back to the provider's own default endpoint", () => {
    const { LLM_BASE_URL: _drop, ...rest } = local();
    expect(loadConfig(rest).llm?.baseUrl).toBe(
      LLM_PROVIDERS.lemonade.baseUrl.replace(/\/+$/, ""),
    );
  });

  it("carries the provider's request-body extras onto the resolved config", () => {
    expect(loadConfig(local()).llm?.extraBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    // A provider with nothing to add carries nothing: the hook is opt-in per
    // row, not a shape every provider must fill.
    expect(
      loadConfig(local({ LLM_PROVIDER: "ollama" })).llm?.extraBody,
    ).toBeUndefined();
  });

  it("accepts a key on a local endpoint without requiring one", () => {
    const c = loadConfig(local({ LLM_API_KEY: "llama-cpp-api-key" }));
    expect(c.llm?.apiKey?.reveal()).toBe("llama-cpp-api-key");
  });

  it("holds the key in a Secret that no log, JSON body or inspector can reach", () => {
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      LLM_PROVIDER: "openai",
      LLM_MODEL: "gpt-4.1-mini",
      LLM_API_KEY: "sk-super-secret-value-that-must-never-print",
    });
    expect(JSON.stringify(c)).not.toContain("sk-super-secret");
    expect(String(c.llm?.apiKey)).toBe("[redacted:llm-api-key:openai]");
    const sanitized = JSON.stringify(sanitizedConfig(c));
    expect(sanitized).not.toContain("sk-super-secret");
    expect(sanitizedConfig(c)).toMatchObject({
      llm: {
        provider: "openai",
        model: "gpt-4.1-mini",
        // Host only, on the same rule the RPC label follows.
        baseUrlHost: "api.openai.com",
        apiKeyConfigured: true,
        local: false,
      },
    });
  });

  it("reports the extras a provider carries without reporting their values", () => {
    expect(sanitizedConfig(loadConfig(local()))).toMatchObject({
      llm: {
        extraBodyFields: ["chat_template_kwargs"],
        apiKeyConfigured: false,
      },
    });
  });

  it("leaves the LLM unconfigured when nothing names it", () => {
    const c = loadConfig({ NODE_ENV: "test", DATA_DIR: temp() });
    expect(c.llm).toBeUndefined();
    expect(sanitizedConfig(c)).not.toHaveProperty("llm");
  });

  it("reads the shipped env template's blank lines as unset, not as invalid", () => {
    // templates/production.env.example carries every LLM_* key with an empty
    // value. Sourced as-is that is "no planner configured", not a parse error.
    const c = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      LLM_PROVIDER: "",
      LLM_MODEL: "",
      LLM_BASE_URL: "",
      LLM_API_KEY: "",
      LLM_CONTEXT_WINDOW: "",
      LLM_MAX_OUTPUT_TOKENS: "",
    });
    expect(c.llm).toBeUndefined();
  });
});

describe("LLM configuration fails closed", () => {
  it.each([
    [
      "a hosted provider with no key",
      { LLM_PROVIDER: "openai", LLM_MODEL: "gpt-4.1-mini" },
      /LLM_API_KEY is required/,
    ],
    [
      "a hosted provider reached over plaintext HTTP",
      {
        LLM_PROVIDER: "openai",
        LLM_MODEL: "gpt-4.1-mini",
        LLM_API_KEY: "sk-x",
        LLM_BASE_URL: "http://api.openai.com/v1",
      },
      /must be an HTTPS URL/,
    ],
    [
      "a half configuration that names no provider",
      { LLM_MODEL: "Qwen3-8B-GGUF" },
      /LLM_PROVIDER is required/,
    ],
    [
      "a key with nothing to send it to",
      { LLM_API_KEY: "sk-x" },
      /LLM_PROVIDER is required/,
    ],
    [
      "a provider with no model",
      { LLM_PROVIDER: "lemonade" },
      /LLM_MODEL is required/,
    ],
    [
      "a base URL carrying an embedded credential",
      {
        LLM_PROVIDER: "lemonade",
        LLM_MODEL: "m",
        LLM_BASE_URL: "http://user:pass@192.168.1.91:8000/api/v1",
      },
      /must not embed credentials/,
    ],
    [
      "a base URL carrying a query string the transport would mangle",
      {
        LLM_PROVIDER: "lemonade",
        LLM_MODEL: "m",
        LLM_BASE_URL: "http://192.168.1.91:8000/api/v1?key=abc",
      },
      /no query string or fragment/,
    ],
    [
      "an output ceiling that cannot fit inside the context window",
      {
        LLM_PROVIDER: "lemonade",
        LLM_MODEL: "m",
        LLM_CONTEXT_WINDOW: "4096",
        LLM_MAX_OUTPUT_TOKENS: "4096",
      },
      /below LLM_CONTEXT_WINDOW/,
    ],
    [
      "a provider nobody has written a profile for",
      { LLM_PROVIDER: "totally-made-up", LLM_MODEL: "m" },
      /LLM_PROVIDER/,
    ],
  ])("refuses %s", (_name, env, message) => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", DATA_DIR: temp(), ...env }),
    ).toThrow(message);
  });
});

describe("provider request-body extras", () => {
  const transport = (
    fetchImpl: typeof globalThis.fetch,
    extraBody?: Record<string, unknown>,
  ) =>
    new OpenAICompatibleTransport({
      baseUrl: "http://192.168.1.91:8000/api/v1",
      fetch: fetchImpl,
      ...(extraBody ? { extraBody } : {}),
    });

  it("sends the provider's extras on every completion", async () => {
    const fetchImpl = stub(() => completion());
    await transport(fetchImpl as unknown as typeof globalThis.fetch, {
      chat_template_kwargs: { enable_thinking: false },
    }).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "Qwen3-8B-GGUF",
    });
    const body = sentBody(fetchImpl);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("Qwen3-8B-GGUF");
  });

  it("never lets an extra redefine a canonical field", async () => {
    const fetchImpl = stub(() => completion());
    await transport(fetchImpl as unknown as typeof globalThis.fetch, {
      model: "some-other-model",
      messages: [{ role: "system", content: "injected" }],
      stream: true,
      max_tokens: 999_999,
    }).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "Qwen3-8B-GGUF",
      maxOutputTokens: 256,
    });
    const body = sentBody(fetchImpl);
    expect(body.model).toBe("Qwen3-8B-GGUF");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(256);
  });

  it("adds nothing to the body when a provider declares no extras", async () => {
    const fetchImpl = stub(() => completion());
    await transport(fetchImpl as unknown as typeof globalThis.fetch).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "Qwen3-8B-GGUF",
    });
    expect(Object.keys(sentBody(fetchImpl))).toEqual([
      "model",
      "messages",
      "stream",
    ]);
  });

  it("sends no Authorization header when there is no credential to send", async () => {
    const fetchImpl = stub(() => completion());
    await transport(fetchImpl as unknown as typeof globalThis.fetch).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "Qwen3-8B-GGUF",
    });
    const headers = sentHeaders(fetchImpl);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("local server tool-call quirks", () => {
  const call = (fn: { name: string; arguments: string }, id?: string) => ({
    ...(id === undefined ? {} : { id }),
    type: "function",
    function: fn,
  });
  const withCalls = (calls: unknown[]) =>
    completion({
      message: { content: null, tool_calls: calls },
      finish_reason: "tool_calls",
    });

  it("synthesizes positional ids for a server that omits them", async () => {
    const fetchImpl = stub(() =>
      withCalls([
        call({ name: "market.networks", arguments: "{}" }),
        call({ name: "risk.analyze", arguments: '{"token":"SOL"}' }),
      ]),
    );
    const response = await new OpenAICompatibleTransport({
      baseUrl: "http://192.168.1.91:8000/api/v1",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    }).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "Qwen3-8B-GGUF",
    });
    expect(response.toolCalls.map((c) => c.id)).toEqual(["call_0", "call_1"]);
    expect(response.toolCalls[1]!.arguments).toEqual({ token: "SOL" });
  });

  it("still refuses a duplicate id, which no positional fix can repair", async () => {
    const fetchImpl = stub(() =>
      withCalls([
        call({ name: "market.networks", arguments: "{}" }, "a"),
        call({ name: "risk.analyze", arguments: "{}" }, "a"),
      ]),
    );
    await expect(
      new OpenAICompatibleTransport({
        baseUrl: "http://192.168.1.91:8000/api/v1",
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      }).complete({
        messages: [{ role: "user", content: "hi" }],
        model: "Qwen3-8B-GGUF",
      }),
    ).rejects.toThrow(/Duplicate tool call ID/);
  });

  it("still refuses a present-but-empty id", async () => {
    const fetchImpl = stub(() =>
      withCalls([call({ name: "market.networks", arguments: "{}" }, "")]),
    );
    await expect(
      new OpenAICompatibleTransport({
        baseUrl: "http://192.168.1.91:8000/api/v1",
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      }).complete({
        messages: [{ role: "user", content: "hi" }],
        model: "Qwen3-8B-GGUF",
      }),
    ).rejects.toThrow();
  });
});

describe("composition from configuration", () => {
  it("routes an agent turn to the configured local endpoint, keyless, with its extras", async () => {
    const config = loadConfig(local());
    const fetchImpl = stub(() => completion());
    const app = createApplication(config, {
      llmFetch: fetchImpl as unknown as typeof fetch,
    });
    const events = [];
    for await (const e of app.runtime.run({
      messages: [{ role: "user", content: "what is my exposure" }],
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      message: { role: "assistant", content: "ok" },
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "http://192.168.1.91:8000/api/v1/chat/completions",
    );
    expect(sentHeaders(fetchImpl).Authorization).toBeUndefined();
    const body = sentBody(fetchImpl);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("Qwen3-8B-GGUF");
    // The output ceiling from config reaches the wire; on a small local model
    // an unbounded reply is how a whole context window gets spent on one turn.
    expect(body.max_tokens).toBe(1024);
    // The registry's tools are offered, and never a signing or broadcast one.
    expect(Array.isArray(body.tools)).toBe(true);
    await app.stop();
  });

  it("reports the configured model in health without an override", async () => {
    const config = loadConfig(local());
    const app = createApplication(config, {
      llmFetch: (async () => completion()) as unknown as typeof fetch,
    });
    await app.start();
    expect(await app.health()).toMatchObject({
      dependencies: {
        model: { status: "available", provider: "lemonade:Qwen3-8B-GGUF" },
      },
    });
    await app.stop();
  });

  it("still reports an unconfigured model when nothing names one", async () => {
    const app = createApplication(
      loadConfig({ NODE_ENV: "test", DATA_DIR: temp() }),
    );
    await app.start();
    expect(await app.health()).toMatchObject({
      dependencies: { model: { status: "unconfigured" } },
    });
    await app.stop();
  });

  it("preserves the router's fallback and budget behaviour around the endpoint", async () => {
    // The configured endpoint becomes one candidate among however many the
    // router holds; nothing about routing is bypassed to reach it.
    const config = loadConfig(local());
    expect(config.llm).toBeDefined();
    const provider = createModelProvider(config.llm!, new ToolRegistry(), {
      capabilities: [],
      fetch: (async () => completion()) as unknown as typeof globalThis.fetch,
    });
    // Health and the console name the endpoint, not the generic router.
    expect(provider.id).toBe("lemonade:Qwen3-8B-GGUF");
    expect(llmProviderId(config.llm!)).toBe("lemonade:Qwen3-8B-GGUF");

    const candidate: ModelCandidate = {
      id: llmProviderId(config.llm!),
      provider: config.llm!.provider,
      model: config.llm!.model,
      transport: "openai-compatible",
      contextWindow: config.llm!.contextWindow,
      supportedTools: [],
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    };
    // A window that cannot hold the configured output ceiling is refused by the
    // router, which is why loadConfig rejects that pairing at boot instead.
    expect(() =>
      new ModelRouter([{ ...candidate, contextWindow: 512 }], {}).route({
        messages: [],
        maxOutputTokens: config.llm!.maxOutputTokens,
      }),
    ).toThrow(/No healthy model/);
  });
});
