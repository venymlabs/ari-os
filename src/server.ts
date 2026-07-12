#!/usr/bin/env node
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "./config/index.js";
import { createApplication } from "./app/index.js";
import { SessionStore } from "./storage/session-store.js";
import { TRADING_CAPABILITIES } from "./agent/types.js";
import { registerTradingApi } from "./live-trading/api.js";
export interface ServerOptions {
  ready: () => boolean | Promise<boolean>;
  health: () => unknown | Promise<unknown>;
  version?: string;
  build?: string;
  signing?: boolean;
  apiToken?: string;
  resources?: { sessions?: () => unknown | Promise<unknown> };
}
export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const version = o.version ?? process.env.npm_package_version ?? "0.0.0",
    build = o.build ?? process.env.RAOS_BUILD_SHA ?? "unknown";
  app.get("/livez", async () => ({ status: "ok" }));
  app.get("/readyz", async (_q, r) => {
    const ready = await o.ready();
    return r
      .code(ready ? 200 : 503)
      .send({
        status: ready ? "ready" : "not-ready",
        dependencies: await o.health(),
      });
  });
  app.get("/metrics", async (_q, r) =>
    r.type("text/plain").send(`raos_ready ${(await o.ready()) ? 1 : 0}\n`),
  );
  app.get("/version", async () => ({
    name: "robinhood-agent-os",
    version,
    build,
    node: process.version,
    signing: o.signing ?? false,
  }));
  app.get("/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Robinhood Agent OS", version },
    paths: {},
  }));
  app.get("/v1/health", async () => ({
    status: (await o.ready()) ? "ok" : "degraded",
    dependencies: await o.health(),
    signing: o.signing ?? false,
  }));
  if (o.resources?.sessions)
    app.get("/v1/sessions", async (q, r) => {
      if (o.apiToken && q.headers.authorization !== `Bearer ${o.apiToken}`)
        return r
          .code(401)
          .send({
            error: { code: "UNAUTHORIZED", message: "Authentication required" },
          });
      return o.resources!.sessions!();
    });
  return app;
}
export async function createStandaloneServer(
  config: AppConfig,
  overrides: { rpcFetch?: typeof fetch } = {},
) {
  const application = createApplication(config, overrides);
  await application.start();
  const app = createServer({
    ready: () => application.ready(),
    health: async () => application.health(),
    signing: config.execution === "live" && !!config.trading?.signerSocketPath,
  });
  const auth = (v: unknown) => {
    const token = String(v ?? "").replace(/^Bearer /, "");
    const expected =
      config.auth.bearerTokenSha256 ??
      (config.auth.bearerToken
        ? createHash("sha256").update(config.auth.bearerToken).digest("hex")
        : undefined);
    if (!expected || !String(v).startsWith("Bearer ")) return false;
    const a = Buffer.from(
        createHash("sha256").update(token).digest("hex"),
        "hex",
      ),
      b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const guard = (q: any, r: any, s: string) =>
    auth(q.headers.authorization)
      ? config.auth.scopes.includes(s) ||
        config.auth.scopes.includes("agent:admin")
        ? true
        : (r
            .code(403)
            .send({ error: { code: "FORBIDDEN", message: "Missing scope" } }),
          false)
      : (r
          .code(401)
          .send({
            error: { code: "UNAUTHORIZED", message: "Authentication required" },
          }),
        false);
  if (application.trading)
    registerTradingApi(app, {
      trading: application.trading,
      principal: (q) => {
        const authenticated = auth(q.headers.authorization);
        return {
          subject: config.auth.tenantId,
          scopes: authenticated ? [...config.auth.scopes] : [],
          authenticated,
        };
      },
    });
  app.get("/v1/tools", async (q, r) =>
    guard(q, r, "tool:read")
      ? {
          items: application.registry.schemas({
            capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
          }),
        }
      : undefined,
  );
  app.post("/v1/tools/:name/invoke", async (q: any, r) => {
    if (!guard(q, r, "tool:invoke")) return;
    const name = String(q.params.name);
    if (!name.startsWith("market."))
      return r
        .code(403)
        .send({
          error: {
            code: "CAPABILITY_DENIED",
            message: "Only market tools may be invoked",
          },
        });
    const result = await application.registry.invoke(name, q.body ?? {}, {
      capabilities: [TRADING_CAPABILITIES.MARKET_DATA],
      invocationId: randomUUID(),
    });
    return r
      .code(!result.ok && result.error.code === "UNAVAILABLE" ? 503 : 200)
      .send(result);
  });
  app.get("/v1/sessions", async (q, r) => {
    if (!guard(q, r, "agent:read")) return;
    const store = new SessionStore(config.paths.sessions);
    try {
      return { items: store.listUnfinishedRuns() };
    } finally {
      store.close();
    }
  });
  app.get("/v1/skills", async (q, r) => {
    if (!guard(q, r, "tool:read")) return;
    try {
      return {
        items: (await readdir(config.paths.skills, { withFileTypes: true }))
          .filter((x) => x.isDirectory() || x.isFile())
          .map((x) => x.name),
      };
    } catch {
      return { items: [] };
    }
  });
  app.get("/v1/markets", async (q, r) => {
    if (!guard(q, r, "tool:read")) return;
    return {
      items: application.registry
        .listPrivileged()
        .filter((x) => x.name.startsWith("market."))
        .map((x) => x.name),
    };
  });
  app.get("/v1/jobs", async (q, r) => {
    if (!guard(q, r, "agent:write")) return;
    const db = new DatabaseSync(config.paths.jobs);
    try {
      const exists = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .get();
      return {
        items: exists
          ? db
              .prepare(
                "SELECT id,type,status,scheduled_at scheduledAt,attempt_count attemptCount,max_attempts maxAttempts FROM jobs ORDER BY created_at DESC LIMIT 100",
              )
              .all()
          : [],
      };
    } finally {
      db.close();
    }
  });
  app.post("/v1/simulate", async (q, r) => {
    if (!guard(q, r, "simulation:invoke")) return;
    const result = await application.registry.invoke(
      "simulation.transaction",
      q.body ?? {},
      {
        capabilities: [TRADING_CAPABILITIES.ORDER_SIMULATE],
        invocationId: randomUUID(),
      },
    );
    return r
      .code(!result.ok && result.error.code === "UNAVAILABLE" ? 503 : 200)
      .send(result);
  });
  app.post("/v1/runs", async (q: any, r) => {
    if (!guard(q, r, "agent:write")) return;
    const b = q.body as { sessionId?: string; input?: string };
    if (!b?.sessionId || !b.input)
      return r.code(400).send({ error: { code: "VALIDATION_ERROR" } });
    const key = String(q.headers["idempotency-key"] ?? ""),
      old = key
        ? application.runs.idempotent(config.auth.tenantId, key)
        : undefined;
    if (old) return r.code(202).send(pub(old));
    const run = application.runs.create(
      {
        id: randomUUID(),
        tenantId: config.auth.tenantId,
        subject: "api",
        sessionId: b.sessionId,
        status: "running",
        createdAt: Date.now(),
        events: [],
      },
      key || undefined,
    );
    queueMicrotask(async () => {
      application.runs.emit(run.id, "run.started", {});
      for await (const e of application.runtime.run({
        messages: [{ role: "user", content: b.input! }],
      }))
        application.runs.emit(run.id, e.type, e);
      application.runs.setStatus(run.id, "failed");
    });
    return r.code(202).send(pub(run));
  });
  app.get("/v1/runs/:id", async (q: any, r) => {
    if (!guard(q, r, "agent:read")) return;
    const x = application.runs.get(q.params.id, config.auth.tenantId);
    return x ? pub(x) : r.code(404).send({ error: { code: "NOT_FOUND" } });
  });
  app.get("/v1/runs/:id/events", async (q: any, r) => {
    if (!guard(q, r, "agent:read")) return;
    const x = application.runs.get(q.params.id, config.auth.tenantId);
    if (!x) return r.code(404).send({ error: { code: "NOT_FOUND" } });
    const last = Number(q.headers["last-event-id"] ?? 0);
    return r
      .type("text/event-stream")
      .header("cache-control", "no-cache")
      .send(
        x.events
          .filter((e) => e.id > last)
          .map(
            (e) =>
              `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
          )
          .join(""),
      );
  });
  app.post("/v1/chat", async (q, r) =>
    guard(q, r, "agent:read")
      ? r.code(503).send({ error: { code: "MODEL_UNAVAILABLE" } })
      : undefined,
  );
  app.addHook("onClose", async () => application.stop());
  return app;
}
function pub(r: {
  id: string;
  sessionId: string;
  status: string;
  createdAt: number;
}) {
  return {
    id: r.id,
    sessionId: r.sessionId,
    status: r.status,
    createdAt: r.createdAt,
  };
}
export async function main() {
  const c = loadConfig(process.env),
    app = await createStandaloneServer(c);
  await app.listen({ host: c.host, port: c.port });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
