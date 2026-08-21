import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { KernelStore } from "../src/kernel/store.js";
import { defaultPolicy } from "../src/kernel/defaults.js";
import { PolicyController } from "../src/control/policy.js";
import {
  CONTENT_SECURITY_POLICY,
  registerControlPlane,
} from "../src/control/index.js";
import type { ControlRuntime } from "../src/control/index.js";
import { StrategyStore } from "../src/strategy/index.js";
import { SignalsFeed } from "../src/data/index.js";
import { loadConfig } from "../src/config/index.js";
import { createStandaloneServer } from "../src/server.js";
import { removeDir } from "./helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realDashboard = join(repoRoot, "web", "dist");
const dashboardBuilt = existsSync(join(realDashboard, "index.html"));

const dirs: string[] = [];
const stores: KernelStore[] = [];
const servers: FastifyInstance[] = [];
const temp = (prefix = "raos-control-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => removeDir(d));
});

const TOKEN = "operator-token";
const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const json = { "content-type": "application/json" };

/** A believable built dashboard: hashed asset + unhashed shell. */
function fakeDashboard(): string {
  const root = temp("raos-web-");
  mkdirSync(join(root, "assets"));
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><html><head><title>ARI OS Control</title>" +
      '<script type="module" crossorigin src="/assets/index-CNfO7aI6.js"></script>' +
      '</head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(root, "assets", "index-CNfO7aI6.js"), "export default 1;");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  // A self-hosted font whose name merely LOOKS hashed. It is not, and marking
  // it immutable for a year would be unrecoverable.
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "fonts", "instrument-serif-400-italic.woff2"), "x");
  return root;
}

function mount(
  options: {
    scopes?: string[];
    token?: string | undefined;
    webRoot?: string;
    canArm?: boolean;
    /** Mount a real strategy store, as a composition with custody would. */
    strategies?: StrategyStore;
    signals?: SignalsFeed;
  } = {},
): { app: FastifyInstance; store: KernelStore; policy: PolicyController } {
  const store = new KernelStore(":memory:");
  stores.push(store);
  const policy = new PolicyController(defaultPolicy(), {
    canArm: options.canArm ?? false,
  });
  const runtime: ControlRuntime = {
    network: "mainnet",
    rpcLabel: "rpc.example",
    modelLabel: "unconfigured",
    bootedAt: 1,
    walletAddress: null,
    policy,
    kernel: () => store,
    ...(options.strategies ? { strategies: options.strategies } : {}),
    ...(options.signals ? { signals: options.signals } : {}),
  };
  const app = Fastify({ logger: false });
  servers.push(app);
  registerControlPlane(app, {
    runtime,
    auth: {
      ...("token" in options ? { bearerToken: options.token } : {}),
      ...(!("token" in options) ? { bearerToken: TOKEN } : {}),
      scopes: options.scopes ?? [
        "agent:read",
        "trading:execute",
        "trading:approve",
      ],
    },
    webRoot: options.webRoot ?? fakeDashboard(),
    streamIntervalMs: 25,
  });
  return { app, store, policy };
}

describe("control plane — serving the dashboard", () => {
  it("serves the shell at / and on deep links, and never caches it", async () => {
    const { app } = mount();
    for (const url of ["/", "/approvals", "/positions/deep/link"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html", ...bearer() },
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('<div id="root">');
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("sends an unauthenticated navigation to the sign-in page, not an empty console", async () => {
    const { app } = mount();
    for (const url of ["/", "/approvals"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
      });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe("/login");
    }
    // …and the sign-in page itself must never redirect to itself.
    expect((await app.inject("/login")).statusCode).toBe(200);
  });

  it("serves hashed assets as immutable and unhashed ones as short-lived", async () => {
    const { app } = mount();
    const asset = await app.inject("/assets/index-CNfO7aI6.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    for (const url of [
      "/favicon.svg",
      "/fonts/instrument-serif-400-italic.woff2",
    ]) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["cache-control"], url).toBe("public, max-age=3600");
    }
  });

  it("answers a mistyped API path with JSON 404, never the HTML shell", async () => {
    const { app } = mount();
    for (const url of ["/api/snapshotz", "/api", "/v1/nope"]) {
      const res = await app.inject({
        method: "GET",
        url,
        // A browser navigation Accept header — the shell must still not win.
        headers: { ...bearer(), accept: "text/html,*/*" },
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toContain("application/json");
      expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    const posted = await app.inject({
      method: "POST",
      url: "/definitely-not-a-route",
      headers: { ...bearer(), ...json },
      payload: {},
    });
    expect(posted.statusCode).toBe(404);
    expect(posted.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("reports the dashboard as unbuilt instead of pretending to serve it", async () => {
    const { app } = mount({ webRoot: join(temp(), "never-built") });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("npm run dashboard:build");
  });

  it("sets a strict same-origin CSP and the usual hardening headers", async () => {
    const { app } = mount();
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    // No external host may appear anywhere in the policy.
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves a sign-in page with no inline script or style", async () => {
    const { app } = mount();
    const page = await app.inject("/login");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<script src="/login.js">');
    expect(page.body).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(page.body).not.toMatch(/<style|style="/);
    expect((await app.inject("/login.js")).statusCode).toBe(200);
    expect((await app.inject("/login.css")).statusCode).toBe(200);
  });
});

describe("control plane — authentication", () => {
  it("refuses every route when no credential is configured", async () => {
    const { app } = mount({ token: undefined });
    for (const url of ["/api/snapshot", "/api/sources", "/api/stream"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer() });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "AUTH_NOT_CONFIGURED" },
      });
    }
    const decided = await app.inject({
      method: "POST",
      url: "/api/approvals/a1/decide",
      headers: { ...bearer(), ...json },
      payload: { decision: "approve" },
    });
    expect(decided.statusCode).toBe(401);
    expect(decided.json()).toMatchObject({
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
    const minted = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: json,
      payload: { token: TOKEN },
    });
    expect(minted.statusCode).toBe(401);
  });

  it("never lets the approvals endpoint be reached unauthenticated", async () => {
    const { app } = mount();
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/approvals/a1/decide",
      headers: json,
      payload: { decision: "approve" },
    });
    expect(anonymous.statusCode).toBe(401);
    const wrongToken = await app.inject({
      method: "POST",
      url: "/api/approvals/a1/decide",
      headers: { ...bearer("nope"), ...json },
      payload: { decision: "approve" },
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it("enforces scopes independently for reads, policy and approvals", async () => {
    const { app } = mount({ scopes: ["agent:read"] });
    expect(
      (await app.inject({ url: "/api/snapshot", headers: bearer() }))
        .statusCode,
    ).toBe(200);
    for (const url of [
      "/api/policy/kill-switch",
      "/api/approvals/a1/decide",
      "/api/strategies/s1/status",
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...bearer(), ...json },
        payload: { engaged: true, decision: "approve", status: "paused" },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("exchanges the bearer token for a same-origin session cookie", async () => {
    const { app } = mount();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: json,
      payload: { token: "wrong" },
    });
    expect(rejected.statusCode).toBe(401);

    const minted = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: json,
      payload: { token: TOKEN },
    });
    expect(minted.statusCode).toBe(200);
    const cookie = String(minted.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toMatch(/^ari_session=[A-Za-z0-9_-]{20,}/);

    const jar = cookie.split(";")[0]!;
    const read = await app.inject({
      url: "/api/snapshot",
      headers: { cookie: jar },
    });
    expect(read.statusCode).toBe(200);

    await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie: jar },
    });
    expect(
      (await app.inject({ url: "/api/snapshot", headers: { cookie: jar } }))
        .statusCode,
    ).toBe(401);
  });

  it("refuses cross-origin and non-JSON writes", async () => {
    const { app } = mount();
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/policy/kill-switch",
      headers: { ...bearer(), ...json, origin: "https://evil.example" },
      payload: { engaged: true },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({
      error: { code: "CROSS_ORIGIN" },
    });
    const formEncoded = await app.inject({
      method: "POST",
      url: "/api/policy/kill-switch",
      headers: {
        ...bearer(),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "engaged=true",
    });
    expect(formEncoded.statusCode).toBe(415);
  });
});

describe("control plane — the six routes", () => {
  it("projects real kernel state into the snapshot", async () => {
    const { app, store } = mount();
    const now = Date.now();
    store.reserve({
      bucket: "sol",
      amount: 250_000_000n,
      caps: defaultPolicy().capsSol,
      tradeId: "t1",
      now,
    });
    store.insertTrade(
      {
        id: "t1",
        idempotencyKey: "k1",
        intentJson: JSON.stringify({ summary: "buy 0.25 SOL of BONK" }),
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        inputAmount: 250_000_000n,
        lastValidBlockHeight: 400,
        now,
      },
      null,
    );
    store.appendJournal({
      type: "intent.received",
      tradeId: "t1",
      at: now,
      idempotencyKey: "k1",
      source: "swap_jupiter",
      summary: "buy 0.25 SOL of BONK",
    });
    store.appendJournal({
      type: "guard.rejected",
      tradeId: "t1",
      at: now + 1,
      code: "CAP_EXCEEDED",
      message: "per-hour cap would be exceeded",
    });

    const res = await app.inject({ url: "/api/snapshot", headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const snap = res.json();

    // Real: the journal, the inflight queue and the cap ledger.
    expect(snap.activity.map((a: { kind: string }) => a.kind)).toEqual([
      "guard.rejected",
      "intent.received",
    ]);
    expect(snap.activity[0]).toMatchObject({ level: "fail", tradeId: "t1" });
    expect(snap.inflight).toHaveLength(1);
    expect(snap.inflight[0]).toMatchObject({
      id: "t1",
      state: "reserved",
      summary: "buy 0.25 SOL of BONK",
    });
    expect(snap.system.reconciler.pending).toBe(1);
    const sol = snap.caps.find((c: { bucket: string }) => c.bucket === "sol");
    expect(
      sol.meters.find((m: { window: string }) => m.window === "perHour").used,
    ).toBe("250000000");
    // bigints must arrive as decimal strings, per the wire contract.
    expect(typeof snap.system.priorityFeeMaxLamports).toBe("string");

    // Explicitly unavailable rather than invented.
    expect(snap.approvals).toEqual([]);
    expect(snap.strategies).toEqual([]);
    expect(snap.signals).toMatchObject({ connected: false, tape: [] });
    expect(snap.positions).toMatchObject({ perps: [], dlmm: [] });

    const sources = await app.inject({
      url: "/api/sources",
      headers: bearer(),
    });
    expect(sources.json()).toMatchObject({
      kernel: true,
      approvals: false,
      strategies: false,
      signals: false,
      valuation: false,
    });
  });

  it("refuses approvals and strategies with an explicit unavailable code", async () => {
    const { app } = mount();
    const decided = await app.inject({
      method: "POST",
      url: "/api/approvals/a1/decide",
      headers: { ...bearer(), ...json },
      payload: { decision: "approve" },
    });
    expect(decided.statusCode).toBe(503);
    expect(decided.json()).toMatchObject({
      error: { code: "APPROVALS_UNAVAILABLE" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/approvals/a1/decide",
      headers: { ...bearer(), ...json },
      payload: { decision: "maybe" },
    });
    expect(invalid.statusCode).toBe(400);
    const strategy = await app.inject({
      method: "POST",
      url: "/api/strategies/s1/status",
      headers: { ...bearer(), ...json },
      payload: { status: "paused" },
    });
    expect(strategy.statusCode).toBe(503);
    expect(strategy.json()).toMatchObject({
      error: { code: "STRATEGIES_UNAVAILABLE" },
    });
  });

  it("backs the strategies route once a runner is mounted", async () => {
    const strategies = new StrategyStore(":memory:");
    const signals = new SignalsFeed({
      // Constructed but never connected: nothing here touches a network.
      watcher: {
        createSocket: () =>
          ({
            readyState: 0,
            send() {},
            close() {},
            addEventListener() {},
          }) as never,
      },
    });
    const row = strategies.create(
      1,
      "dca",
      {
        token: "BonkMint11111111111111111111111111111111111",
        amountUiPerStep: 0.1,
      },
      Date.now(),
    );
    const { app } = mount({ strategies, signals });

    // The panel now reports a measurement instead of an absence.
    const sources = await app.inject({
      url: "/api/sources",
      headers: bearer(),
    });
    expect(sources.json()).toMatchObject({ strategies: true, signals: true });

    const snap = (
      await app.inject({ url: "/api/snapshot", headers: bearer() })
    ).json();
    expect(snap.strategies).toHaveLength(1);
    expect(snap.strategies[0]).toMatchObject({ id: row.id, kind: "dca" });
    // An unstarted feed is DISCONNECTED, not a quiet market.
    expect(snap.signals).toMatchObject({
      feedLabel: "PUMPPORTAL",
      connected: false,
    });

    const paused = await app.inject({
      method: "POST",
      url: `/api/strategies/${row.id}/status`,
      headers: { ...bearer(), ...json },
      payload: { status: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ ok: true, status: "paused" });
    expect(strategies.get(row.id)?.status).toBe("paused");

    // An unknown id is a 404 — an operator must be able to tell a no-op from a
    // stale row.
    const missing = await app.inject({
      method: "POST",
      url: "/api/strategies/no-such-id/status",
      headers: { ...bearer(), ...json },
      payload: { status: "paused" },
    });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: "POST",
      url: `/api/strategies/${row.id}/status`,
      headers: { ...bearer(), ...json },
      payload: { status: "definitely-not-a-status" },
    });
    expect(bad.statusCode).toBe(400);
    strategies.close();
  });

  it("moves the real policy the money path reads, and cannot raise authority", async () => {
    const { app, policy } = mount();
    // Nothing is enforcing this policy yet: refuse rather than give false
    // assurance that a kill switch is doing something.
    const premature = await app.inject({
      method: "POST",
      url: "/api/policy/execution",
      headers: { ...bearer(), ...json },
      payload: { enabled: true },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toMatchObject({
      error: { code: "POLICY_NOT_ENFORCED" },
    });

    policy.markEnforced();
    const engaged = await app.inject({
      method: "POST",
      url: "/api/policy/kill-switch",
      headers: { ...bearer(), ...json },
      payload: { engaged: true },
    });
    expect(engaged.statusCode).toBe(200);
    expect(policy.get().killSwitch).toBe(true);
    expect(
      (await app.inject({ url: "/api/snapshot", headers: bearer() })).json()
        .system,
    ).toMatchObject({ killSwitch: true, agentPhase: "halted" });

    // The boot-time opt-in is the ceiling: a browser cannot arm a process that
    // was not started live.
    const armed = await app.inject({
      method: "POST",
      url: "/api/policy/execution",
      headers: { ...bearer(), ...json },
      payload: { enabled: true },
    });
    expect(armed.statusCode).toBe(409);
    expect(armed.json()).toMatchObject({
      error: { code: "EXECUTION_NOT_PERMITTED" },
    });
    expect(policy.get().executionEnabled).toBe(false);

    const badBody = await app.inject({
      method: "POST",
      url: "/api/policy/kill-switch",
      headers: { ...bearer(), ...json },
      payload: { engaged: "yes" },
    });
    expect(badBody.statusCode).toBe(400);
  });
});

describe("control plane — the daemon actually serves it", () => {
  it("boots, serves the console, streams snapshots and 404s API typos as JSON", async () => {
    const server = await createStandaloneServer(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: temp(),
        API_BEARER_TOKEN: TOKEN,
        API_SCOPES: "agent:read,trading:execute,trading:approve",
      }),
    );
    servers.push(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${
      (server.server.address() as { port: number }).port
    }`;

    // An anonymous visitor is pointed at the one sign-in screen that exists.
    const anonymousShell = await fetch(`${base}/`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(anonymousShell.status).toBe(302);
    expect(anonymousShell.headers.get("location")).toBe("/login");

    const shell = await fetch(`${base}/`, {
      headers: { accept: "text/html", authorization: `Bearer ${TOKEN}` },
    });
    const csp = shell.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(shell.headers.get("cache-control")).toBe("no-store");

    if (dashboardBuilt) {
      expect(shell.status).toBe(200);
      const html = await shell.text();
      expect(html).toContain('<div id="root">');
      // Everything the shell references must be served by this same daemon.
      const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        const res = await fetch(`${base}${asset}`);
        expect(res.status, asset).toBe(200);
        if (asset.startsWith("/assets/"))
          expect(res.headers.get("cache-control"), asset).toContain(
            "immutable",
          );
      }
      // The built shell and the served shell are the same bytes.
      expect(html).toBe(
        await readFile(join(realDashboard, "index.html"), "utf8"),
      );
    } else {
      expect(shell.status).toBe(503);
    }

    const typo = await fetch(`${base}/api/snapsho`, {
      headers: { accept: "text/html,*/*", authorization: `Bearer ${TOKEN}` },
    });
    expect(typo.status).toBe(404);
    expect(typo.headers.get("content-type")).toContain("application/json");
    expect(await typo.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const anonymous = await fetch(`${base}/api/snapshot`);
    expect(anonymous.status).toBe(401);

    const snapshot = await fetch(`${base}/api/snapshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).system.network).toBe("testnet");

    // SSE: one real frame off the wire, then hang up.
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let frame: string | undefined;
    while (!frame) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const line = buffered
        .split("\n\n")
        .find((chunk) => chunk.startsWith("data: "));
      if (line) frame = line.slice("data: ".length);
    }
    abort.abort();
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!)).toMatchObject({
      system: { network: "testnet" },
      approvals: [],
    });
  }, 30000);
});
