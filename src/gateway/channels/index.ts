export interface ReplyRoute {
  chatId: string;
  threadId?: string;
}
export interface ApprovalCommand {
  type: "approval";
  action: "approve" | "reject";
  approvalId: string;
}
export interface InboundEnvelope {
  id: string;
  channel: string;
  text: string;
  sessionKey: string;
  replyTo: ReplyRoute;
  actor: { id: string; username?: string };
  receivedAt: number;
  command?: ApprovalCommand;
  raw: unknown;
}
export interface OutboundEnvelope {
  channel: string;
  route: ReplyRoute;
  text: string;
}
export interface ChannelAdapter {
  receive(input: unknown): Promise<InboundEnvelope | undefined>;
  send(output: OutboundEnvelope): Promise<void>;
}
export const sessionKey = (
  channel: string,
  conversationId: string,
  threadId?: string,
) =>
  [channel, conversationId, threadId].filter((x) => x !== undefined).join(":");
export function chunkTelegramText(text: string, max = 4096) {
  if (!Number.isInteger(max) || max < 1)
    throw new Error("Invalid message length");
  const out: string[] = [];
  for (let rest = text; rest;) {
    if (rest.length <= max) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    else cut++;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}
type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  message_thread_id?: number;
  chat: { id: number | string };
  from?: { id: number | string; username?: string };
};
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
export class TelegramChannel implements ChannelAdapter {
  private seen = new Set<number>();
  private fetch: Fetch;
  private authorize: (x: {
    userId: string;
    chatId: string;
    username?: string;
  }) => boolean | Promise<boolean>;
  private token: string;
  private max: number;
  constructor(o: {
    token?: string;
    fetch: Fetch;
    authorize: (x: {
      userId: string;
      chatId: string;
      username?: string;
    }) => boolean | Promise<boolean>;
    maxMessageLength?: number;
  }) {
    this.token = o.token ?? "";
    this.fetch = o.fetch;
    this.authorize = o.authorize;
    this.max = o.maxMessageLength ?? 4096;
  }
  async receive(input: unknown) {
    if (!input || typeof input !== "object") return undefined;
    const u = input as TelegramUpdate;
    if (!Number.isSafeInteger(u.update_id) || this.seen.has(u.update_id))
      return undefined;
    this.seen.add(u.update_id);
    const m = u.message ?? u.edited_message;
    if (!m?.text || !m.from) return undefined;
    const userId = String(m.from.id),
      chatId = String(m.chat.id),
      username = m.from.username;
    if (
      !(await this.authorize({
        userId,
        chatId,
        ...(username === undefined ? {} : { username }),
      }))
    )
      return undefined;
    const threadId =
        m.message_thread_id === undefined
          ? undefined
          : String(m.message_thread_id),
      route: ReplyRoute = {
        chatId,
        ...(threadId === undefined ? {} : { threadId }),
      };
    const match = /^\/(approve|reject)\s+([A-Za-z][A-Za-z0-9_-]{2,127})$/.exec(
      m.text.trim(),
    );
    const actor = {
      id: userId,
      ...(username === undefined ? {} : { username }),
    };
    return {
      id: `telegram:${u.update_id}`,
      channel: "telegram",
      text: m.text,
      sessionKey: sessionKey("telegram", chatId, threadId),
      replyTo: route,
      actor,
      receivedAt: m.date * 1000,
      ...(match
        ? {
            command: {
              type: "approval" as const,
              action: match[1] as "approve" | "reject",
              approvalId: match[2]!,
            },
          }
        : {}),
      raw: input,
    };
  }
  async send(o: OutboundEnvelope) {
    if (o.channel !== "telegram") throw new Error("Invalid outbound channel");
    for (const text of chunkTelegramText(o.text, this.max)) {
      const body = {
        chat_id: o.route.chatId,
        ...(o.route.threadId === undefined
          ? {}
          : { message_thread_id: Number(o.route.threadId) }),
        text,
      };
      const r = await this.fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw new Error("Telegram send failed");
    }
  }
}
