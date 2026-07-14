import { describe, expect, it, vi } from "vitest";
import {
  TelegramChannel,
  sessionKey,
  chunkTelegramText,
  type InboundEnvelope,
} from "../src/gateway/channels/index.js";

const update = (id = 7, text = "hello") => ({
  update_id: id,
  message: {
    message_id: 9,
    date: 100,
    text,
    chat: { id: -20, type: "supergroup" },
    from: { id: 10, username: "alice" },
    message_thread_id: 3,
  },
});
describe("TelegramChannel", () => {
  it("normalizes authorized updates and deterministically routes topics", async () => {
    const c = new TelegramChannel({
      authorize: async (u) => u.userId === "10",
      fetch: vi.fn(),
    });
    const x = await c.receive(update());
    expect(x).toMatchObject({
      id: "telegram:7",
      channel: "telegram",
      text: "hello",
      sessionKey: "telegram:-20:3",
      replyTo: { chatId: "-20", threadId: "3" },
      actor: { id: "10" },
    } satisfies Partial<InboundEnvelope>);
  });
  it("rejects unauthorized and duplicate update ids", async () => {
    const c = new TelegramChannel({ authorize: () => false, fetch: vi.fn() });
    expect(await c.receive(update())).toBeUndefined();
    const d = new TelegramChannel({ authorize: () => true, fetch: vi.fn() });
    expect(await d.receive(update())).toBeTruthy();
    expect(await d.receive(update())).toBeUndefined();
  });
  it("parses approval commands as typed requests without executing", async () => {
    const c = new TelegramChannel({ authorize: () => true, fetch: vi.fn() });
    expect((await c.receive(update(8, "/approve apr_123")))?.command).toEqual({
      type: "approval",
      action: "approve",
      approvalId: "apr_123",
    });
    expect((await c.receive(update(9, "/reject apr_456")))?.command).toEqual({
      type: "approval",
      action: "reject",
      approvalId: "apr_456",
    });
    expect(
      (await c.receive(update(10, "/approve bad id")))?.command,
    ).toBeUndefined();
  });
  it("uses host supplied route and chunks Telegram messages", async () => {
    const calls: Array<[string, { body: string }]> = [];
    const fetch = async (url: string, init: { body: string }) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const c = new TelegramChannel({
      token: "secret",
      authorize: () => true,
      fetch,
      maxMessageLength: 5,
    });
    await c.send({
      channel: "telegram",
      route: { chatId: "42", threadId: "8" },
      text: "abcdefgh",
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]![1].body)).toEqual({
      chat_id: "42",
      message_thread_id: 8,
      text: "abcde",
    });
    expect(calls[0]![0]).toContain("secret");
  });
});
it("session keys and chunks are stable", () => {
  expect(sessionKey("telegram", "1")).toBe("telegram:1");
  expect(chunkTelegramText("a\nbc", 2)).toEqual(["a\n", "bc"]);
});
