#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/index.js";
import { FileTelegramOffsetStore, TelegramRunner } from "../telegram/runner.js";

const ids = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
export async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw Error("TELEGRAM_BOT_TOKEN is required");
  const config = loadConfig(process.env);
  const api =
    process.env.RAOS_API_URL ?? `http://${config.host}:${config.port}`;
  const runner = new TelegramRunner({
    token,
    store: new FileTelegramOffsetStore(join(config.dataDir, "telegram.offset")),
    fetch: globalThis.fetch as any,
    allowedUserIds: ids(process.env.TELEGRAM_ALLOWED_USER_IDS),
    allowedChatIds: ids(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    dispatch: async (inbound) => {
      const response = await fetch(
        new URL("v1/chat", api.endsWith("/") ? api : `${api}/`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.RAOS_API_TOKEN
              ? { authorization: `Bearer ${process.env.RAOS_API_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({ message: inbound.text }),
        },
      );
      const body: any = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Error(
          typeof body.error === "string"
            ? body.error
            : (body.error?.message ??
                `API request failed (${response.status})`),
        );
      return String(body.result ?? body.message ?? body.output ?? "");
    },
  });
  if (!(await runner.check())) throw Error("Telegram bot token check failed");
  const stop = () => runner.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runner.run();
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Telegram runner failed",
    );
    process.exitCode = 1;
  });
