/**
 * The control plane: the daemon serves its own operator console.
 *
 * One process. `node dist/server.js` and the operator has the dashboard at `/`
 * and its API at `/api` on the same origin — no second deployment, no CORS, no
 * separate static host that can drift out of step with the kernel it controls.
 *
 * ─── the six routes ─────────────────────────────────────────────────────────
 *
 * The contract is documented at the top of `web/src/data/http-source.ts` and
 * this module implements exactly it:
 *
 *   GET  /api/snapshot                 → DashboardSnapshot
 *   GET  /api/stream                   → text/event-stream of DashboardSnapshot
 *   POST /api/approvals/:id/decide     { decision: 'approve' | 'reject' }
 *   POST /api/policy/kill-switch       { engaged: boolean }
 *   POST /api/policy/execution         { enabled: boolean }
 *   POST /api/strategies/:id/status    { status: StrategyStatus }
 *
 * Plus `POST|DELETE|GET /api/session`, which is how a browser that cannot set
 * an `Authorization` header gets authenticated at all — see `./auth.ts`.
 *
 * ─── what is real ───────────────────────────────────────────────────────────
 *
 * `./snapshot.ts` documents, field by field, which panels are read from the
 * kernel and which report an explicit unavailable state because no source for
 * them exists in this repo yet. `GET /api/sources` returns that same map on the
 * wire so an operator never has to guess whether a zero is a measurement.
 *
 * The approvals route is mounted, authenticated and scope-checked, and then
 * refuses with `APPROVALS_UNAVAILABLE` — the kernel has no pending-approval
 * queue to decide against. It is NOT an open endpoint waiting for a queue.
 */

import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  ControlAuth,
  readCookie,
  isSameOrigin,
  SESSION_COOKIE,
} from "./auth.js";
import type { ControlAuthOptions } from "./auth.js";
import { isPolicyControlError } from "./policy.js";
import { buildSnapshot, snapshotSources } from "./snapshot.js";
import type { ControlRuntime } from "./snapshot.js";
import { LOGIN_CSS, LOGIN_HTML, LOGIN_JS } from "./login.js";
import { STRATEGY_STATUSES } from "./view.js";
import type { StrategyStatus } from "./view.js";
import { strategyView } from "../strategy/index.js";

export { ControlAuth, SESSION_COOKIE } from "./auth.js";
export type { ControlAuthOptions } from "./auth.js";
export { PolicyController, isPolicyControlError } from "./policy.js";
export { buildSnapshot, snapshotSources } from "./snapshot.js";
export type { ControlRuntime, SnapshotSources } from "./snapshot.js";
export * from "./view.js";

/** Scopes the console needs. Read is separate from anything that moves value. */
export const CONTROL_SCOPES = {
  read: "agent:read",
  policy: "trading:execute",
  approve: "trading:approve",
} as const;

/**
 * The Content-Security-Policy the console is served under.
 *
 * `default-src 'self'` with no external host anywhere: the dashboard, its
 * fonts, its API and its event stream are all this origin. Two deliberate
 * relaxations, neither of which admits a third party:
 *
 *  · `img-src 'self' data:` — `web/src/styles/base.css` embeds its film-grain
 *    as an inline `data:image/svg+xml` URI, and CSS `url(data:)` in a
 *    `background-image` is governed by `img-src`.
 *  · `style-src 'self' 'unsafe-inline'` — the React views set computed geometry
 *    through `style={{ width: … }}` props (cap meters, liquidation bars,
 *    countdown fills) in ~40 places, and CSP treats a `style` ATTRIBUTE as
 *    inline style. Removing this means removing those props from `web/src`,
 *    which is a UI change, not a server one. **`script-src` gets no such
 *    exception** — the executable surface stays `'self'` only, which is the
 *    half that matters for XSS.
 *
 * `font-src 'self' data:` is redundant against `default-src` today; it is
 * stated so that self-hosted fonts — including base64 `data:` faces inlined by
 * the bundler — keep working without anyone reaching for a CDN exception.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};

/** Paths that must answer JSON, never the SPA shell, when they do not exist. */
const DEFAULT_RESERVED = [
  "/api",
  "/v1",
  "/livez",
  "/readyz",
  "/metrics",
  "/version",
  "/openapi.json",
] as const;

/**
 * A Vite content hash: `name-[hash:8].ext`, EXACTLY eight characters.
 *
 * The width matters. A loose `{8,}` also matches hand-named files that merely
 * contain a long hyphenated tail — `instrument-serif-400-italic.woff2` is the
 * one in this very bundle — and marking a mutable filename `immutable` for a
 * year is a cache poisoning you cannot take back. Anything this does not
 * recognise falls to the short-lived rule, which is the safe direction.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const MAX_STREAMS = 8;
const SESSION_ATTEMPT_WINDOW_MS = 60_000;
const SESSION_ATTEMPT_MAX = 10;

export interface ControlPlaneOptions {
  readonly runtime: ControlRuntime;
  readonly auth: ControlAuth | ControlAuthOptions;
  /** Directory holding the built dashboard. Defaults to `<package>/web/dist`. */
  readonly webRoot?: string;
  readonly apiPrefix?: string;
  readonly streamIntervalMs?: number;
}

export function defaultWebRoot(): string {
  const configured = process.env.ARI_DASHBOARD_DIR;
  if (configured) return resolve(configured);
  // src/control/index.ts and dist/control/index.js are both two levels deep,
  // so one expression resolves the package root from either.
  return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

type Json = Record<string, unknown>;

const fail = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) => reply.code(status).send({ error: { code, message } });

/**
 * Mount the console and its API on an existing Fastify instance.
 *
 * Registration order does not matter to find-my-way — an exact route always
 * beats the static plugin's wildcard — but the SPA fallback is deliberately a
 * not-found handler rather than a `GET /*` route, so it can only ever run once
 * every real route has declined.
 */
export function registerControlPlane(
  app: FastifyInstance,
  options: ControlPlaneOptions,
): FastifyInstance {
  const auth =
    options.auth instanceof ControlAuth
      ? options.auth
      : new ControlAuth(options.auth);
  const prefix = options.apiPrefix ?? "/api";
  const webRoot = options.webRoot ?? defaultWebRoot();
  const indexPath = join(webRoot, "index.html");
  const hasDashboard = existsSync(indexPath);
  const streamInterval = options.streamIntervalMs ?? 2_000;
  const runtime = options.runtime;
  const streams = new Set<() => void>();
  const attempts = new Map<string, { n: number; start: number }>();

  if (!auth.configured) {
    // "Refuse by default and say so loudly." Every control-plane route answers
    // 401 until a credential exists; this is the only place it can be said out
    // loud to whoever started the process.
    console.warn(
      "[ari-os] control plane mounted WITHOUT a credential: set API_BEARER_TOKEN or API_BEARER_TOKEN_SHA256. Every /api route — including approvals — will refuse with 401 AUTH_NOT_CONFIGURED.",
    );
  }

  // ── security headers on every response this daemon emits ──────────────────
  app.addHook("onRequest", async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      reply.header(name, value);
    if (req.protocol === "https")
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
  });

  app.addHook("onClose", async () => {
    for (const close of [...streams]) close();
    streams.clear();
  });

  // ── identity ──────────────────────────────────────────────────────────────
  const secure = (req: FastifyRequest) => req.protocol === "https";

  const authenticated = (req: FastifyRequest): boolean => {
    if (!auth.configured) return false;
    if (auth.verifyAuthorizationHeader(req.headers.authorization)) return true;
    return auth.verifySession(readCookie(req.headers.cookie, SESSION_COOKIE));
  };

  const guard = (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
  ): boolean => {
    if (!auth.configured) {
      void fail(
        reply,
        401,
        "AUTH_NOT_CONFIGURED",
        "this daemon has no API credential configured, so the console cannot be authenticated; set API_BEARER_TOKEN or API_BEARER_TOKEN_SHA256 and restart",
      );
      return false;
    }
    if (!authenticated(req)) {
      void fail(reply, 401, "UNAUTHORIZED", "Authentication required");
      return false;
    }
    if (!auth.hasScope(scope)) {
      void fail(reply, 403, "FORBIDDEN", `Missing ${scope}`);
      return false;
    }
    return true;
  };

  /** Mutating requests must be JSON and must not be cross-site. */
  const writable = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const type = String(req.headers["content-type"] ?? "");
    if (!type.toLowerCase().startsWith("application/json")) {
      void fail(
        reply,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "requests that change state must be application/json",
      );
      return false;
    }
    if (
      !isSameOrigin({
        origin: req.headers.origin,
        host: req.headers.host,
        secFetchSite: req.headers["sec-fetch-site"] as string | undefined,
      })
    ) {
      void fail(reply, 403, "CROSS_ORIGIN", "cross-origin request refused");
      return false;
    }
    return true;
  };

  const body = (req: FastifyRequest): Json => (req.body ?? {}) as Json;

  // ── session ───────────────────────────────────────────────────────────────
  app.post(`${prefix}/session`, async (req, reply) => {
    if (!writable(req, reply)) return;
    if (!auth.configured)
      return fail(
        reply,
        401,
        "AUTH_NOT_CONFIGURED",
        "this daemon has no API credential configured; set API_BEARER_TOKEN or API_BEARER_TOKEN_SHA256 and restart",
      );
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const seen = attempts.get(ip);
    const window =
      !seen || now - seen.start >= SESSION_ATTEMPT_WINDOW_MS
        ? { n: 1, start: now }
        : { n: seen.n + 1, start: seen.start };
    attempts.set(ip, window);
    if (window.n > SESSION_ATTEMPT_MAX)
      return fail(reply, 429, "RATE_LIMITED", "too many sign-in attempts");
    const token = body(req).token;
    if (typeof token !== "string" || !auth.verifyToken(token))
      return fail(reply, 401, "UNAUTHORIZED", "token rejected");
    attempts.delete(ip);
    const session = auth.createSession();
    return reply
      .header("set-cookie", auth.cookie(session.id, secure(req)))
      .send({ ok: true, expiresAt: session.expiresAt, scopes: auth.scopes });
  });

  app.delete(`${prefix}/session`, async (req, reply) => {
    auth.revokeSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    return reply
      .header("set-cookie", auth.clearedCookie(secure(req)))
      .send({ ok: true });
  });

  app.get(`${prefix}/session`, async (req, reply) =>
    reply.send({
      configured: auth.configured,
      authenticated: authenticated(req),
      scopes: authenticated(req) ? auth.scopes : [],
    }),
  );

  // ── reads ─────────────────────────────────────────────────────────────────
  app.get(`${prefix}/snapshot`, async (req, reply) => {
    if (!guard(req, reply, CONTROL_SCOPES.read)) return;
    return reply
      .header("cache-control", "no-store")
      .send(await buildSnapshot(runtime));
  });

  app.get(`${prefix}/sources`, async (req, reply) => {
    if (!guard(req, reply, CONTROL_SCOPES.read)) return;
    return reply.send(snapshotSources(runtime));
  });

  app.get(`${prefix}/stream`, async (req, reply) => {
    if (!guard(req, reply, CONTROL_SCOPES.read)) return;
    if (streams.size >= MAX_STREAMS)
      return fail(reply, 503, "TOO_MANY_STREAMS", "stream capacity reached");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // nginx buffers text/event-stream by default and would swallow every
      // frame until the connection closed.
      "x-accel-buffering": "no",
    });
    raw.write(`retry: ${streamInterval}\n\n`);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      streams.delete(stop);
      raw.end();
    };
    const push = async () => {
      if (stopped) return;
      try {
        const snapshot = await buildSnapshot(runtime);
        if (!stopped) raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        // A snapshot that cannot be built must not kill the stream; the client
        // keeps the connection and the next tick may succeed.
        if (!stopped) raw.write(": snapshot unavailable\n\n");
      }
    };
    const timer = setInterval(() => void push(), streamInterval);
    // Never hold the process open for a browser tab.
    timer.unref?.();
    streams.add(stop);
    req.raw.on("close", stop);
    req.raw.on("error", stop);
    await push();
    return reply;
  });

  // ── writes ────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    `${prefix}/approvals/:id/decide`,
    async (req, reply) => {
      // Authentication FIRST: this route is the one that would bind a human to
      // an exact transaction, so it must refuse anonymously even while the
      // queue behind it does not exist.
      if (!guard(req, reply, CONTROL_SCOPES.approve)) return;
      if (!writable(req, reply)) return;
      const decision = body(req).decision;
      if (decision !== "approve" && decision !== "reject")
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "decision must be 'approve' or 'reject'",
        );
      return fail(
        reply,
        503,
        "APPROVALS_UNAVAILABLE",
        "this build has no pending-approval queue: the kernel takes `confirmedByUser` per execute call and the composition leaves it unwired, so there is no intent to bind a decision to",
      );
    },
  );

  const policyRoute = (
    path: string,
    field: "engaged" | "enabled",
    apply: (value: boolean) => void,
  ) =>
    app.post(`${prefix}${path}`, async (req, reply) => {
      if (!guard(req, reply, CONTROL_SCOPES.policy)) return;
      if (!writable(req, reply)) return;
      const value = body(req)[field];
      if (typeof value !== "boolean")
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          `${field} must be a boolean`,
        );
      try {
        apply(value);
      } catch (e) {
        if (isPolicyControlError(e)) return fail(reply, 409, e.code, e.message);
        throw e;
      }
      const policy = runtime.policy.get();
      return reply.send({
        ok: true,
        executionEnabled: policy.executionEnabled,
        killSwitch: policy.killSwitch,
        enforced: runtime.policy.enforced,
      });
    });

  policyRoute("/policy/kill-switch", "engaged", (v) =>
    runtime.policy.setKillSwitch(v),
  );
  policyRoute("/policy/execution", "enabled", (v) =>
    runtime.policy.setExecutionEnabled(v),
  );

  app.post<{ Params: { id: string } }>(
    `${prefix}/strategies/:id/status`,
    async (req, reply) => {
      if (!guard(req, reply, CONTROL_SCOPES.policy)) return;
      if (!writable(req, reply)) return;
      const status = body(req).status;
      if (
        typeof status !== "string" ||
        !(STRATEGY_STATUSES as readonly string[]).includes(status)
      )
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          `status must be one of ${STRATEGY_STATUSES.join(", ")}`,
        );
      const store = runtime.strategies;
      // A runner is only mounted when custody is: with no wallet there is no
      // gateway for a strategy to execute through, so there is nothing to
      // pause. 503 says "not in this deployment", not "your request was wrong".
      if (!store)
        return fail(
          reply,
          503,
          "STRATEGIES_UNAVAILABLE",
          "no strategy runner is mounted in this process: strategies are composed alongside custody, and this daemon was started without a wallet",
        );
      // Unknown id is a 404, never a silent success — an operator pressing
      // "pause" has to be able to tell a no-op from a stale row.
      if (!store.setStatus(req.params.id, status as StrategyStatus))
        return fail(reply, 404, "NOT_FOUND", `no strategy ${req.params.id}`);
      const row = store.get(req.params.id);
      return reply.send({
        ok: true,
        id: req.params.id,
        status,
        ...(row ? { strategy: strategyView(row) } : {}),
      });
    },
  );

  // ── sign-in page ──────────────────────────────────────────────────────────
  const page = (reply: FastifyReply, type: string, payload: string) =>
    reply.type(type).header("cache-control", "no-store").send(payload);

  app.get("/login", async (_req, reply) =>
    page(reply, "text/html; charset=utf-8", LOGIN_HTML),
  );
  app.get("/login.css", async (_req, reply) =>
    page(reply, "text/css; charset=utf-8", LOGIN_CSS),
  );
  app.get("/login.js", async (_req, reply) =>
    page(reply, "text/javascript; charset=utf-8", LOGIN_JS),
  );

  // ── the dashboard itself ──────────────────────────────────────────────────
  if (hasDashboard) {
    void app.register(fastifyStatic, {
      root: webRoot,
      // `/` and every deep link go through the not-found handler instead, so
      // the shell is served from exactly one place with exactly one policy.
      index: false,
      cacheControl: false,
      dotfiles: "deny",
      setHeaders(reply, filePath) {
        const name = basename(filePath);
        reply.header(
          "cache-control",
          name === "index.html"
            ? "no-store"
            : HASHED_ASSET.test(name)
              ? // The filename carries the content hash, so the bytes behind
                // it can never change: a rebuilt bundle is a new filename.
                "public, max-age=31536000, immutable"
              : "public, max-age=3600",
        );
      },
    });
  }

  /**
   * The SPA shell, served from exactly one place.
   *
   * `no-store` because it is the only unhashed document in the bundle: cache it
   * and a rebuilt dashboard keeps pointing at asset hashes that no longer
   * exist. It is read from disk per request rather than at boot for the same
   * reason — rebuilding the console must not require restarting the daemon.
   */
  const sendShell = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hasDashboard)
      return reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .send(
          "ARI OS control dashboard is not built.\n\nRun `npm run dashboard:build` (or set ARI_DASHBOARD_DIR) and restart.\nThe API at /api is unaffected.\n",
        );
    // The bundle has no sign-in screen and cannot grow one from here, so an
    // unauthenticated navigation is sent to the one that exists rather than to
    // a console that would render empty panels and 401s with no way out. No
    // `?next=` is carried: a redirect target taken from the URL is an open
    // redirect waiting to happen, and landing on `/` costs one click.
    if (!authenticated(req))
      return reply.header("cache-control", "no-store").redirect("/login", 302);
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(await readFile(indexPath, "utf8"));
  };

  // `@fastify/static` answers a bare directory with 403 when `index` is off, so
  // the root is routed explicitly rather than left to the plugin's wildcard.
  app.get("/", async (req, reply) => sendShell(req, reply));

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    const reserved = DEFAULT_RESERVED.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
    const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
    const navigational = req.method === "GET" || req.method === "HEAD";

    if (reserved || !navigational || !wantsHtml)
      return fail(
        reply,
        404,
        "NOT_FOUND",
        `no route for ${req.method} ${path}`,
      );
    return sendShell(req, reply);
  });

  return app;
}

/** Exposed for tests and tooling that want the shell without a running app. */
export function readDashboardShell(webRoot = defaultWebRoot()) {
  const indexPath = join(webRoot, "index.html");
  return existsSync(indexPath) ? createReadStream(indexPath) : undefined;
}
