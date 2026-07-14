import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config/index.js";
import { createStandaloneServer } from "../src/server.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "raos-api-"));
  dirs.push(d);
  return d;
};
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
const bearer = (token = "secret") => ({ authorization: `Bearer ${token}` });

describe("standalone authenticated composition", () => {
  it("keeps operations public and fails protected routes closed when auth is absent", async () => {
    const server = await createStandaloneServer(
      loadConfig({ NODE_ENV: "test", DATA_DIR: temp() }),
    );
    expect((await server.inject("/livez")).statusCode).toBe(200);
    expect((await server.inject("/readyz")).statusCode).toBe(200);
    expect((await server.inject("/v1/tools")).statusCode).toBe(401);
    await server.close();
  });
  it("accepts configured bearer hash and enforces read scope and tenant isolation", async () => {
    const hash = createHash("sha256").update("secret").digest("hex");
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: temp(),
      API_BEARER_TOKEN_SHA256: hash,
      API_TENANT_ID: "tenant-a",
      API_SCOPES: "agent:read,tool:read,tool:invoke,agent:write",
    });
    const server = await createStandaloneServer(config);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/tools",
          headers: bearer("bad"),
        })
      ).statusCode,
    ).toBe(401);
    const tools = await server.inject({
      method: "GET",
      url: "/v1/tools",
      headers: bearer(),
    });
    expect(tools.statusCode).toBe(200);
    expect(
      tools
        .json()
        .items.some((x: { name: string }) => x.name === "market.networks"),
    ).toBe(true);
    const invoked = await server.inject({
      method: "POST",
      url: "/v1/tools/market.networks/invoke",
      headers: bearer(),
      payload: {},
    });
    expect(invoked.statusCode).toBe(503);
    expect(invoked.json()).toMatchObject({
      ok: false,
      tool: "market.networks",
      error: { code: "UNAVAILABLE" },
    });
    for (const path of ["sessions", "skills", "markets", "jobs"]) {
      const response = await server.inject({
        method: "GET",
        url: `/v1/${path}`,
        headers: bearer(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty("items");
    }
    const simulated = await server.inject({
      method: "POST",
      url: "/v1/simulate",
      headers: bearer(),
      payload: { transaction: {} },
    });
    expect(simulated.statusCode).toBe(403);
    const made = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...bearer(), "idempotency-key": "one" },
      payload: { sessionId: "s1", input: "hello" },
    });
    expect(made.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/v1/runs/${made.json().id}`,
          headers: bearer(),
        })
      ).statusCode,
    ).toBe(200);
    await server.close();
  });
  it("enforces endpoint scopes and returns unavailable for absent simulation composition", async () => {
    const server = await createStandaloneServer(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: temp(),
        API_BEARER_TOKEN: "secret",
        API_TENANT_ID: "t",
        API_SCOPES: "agent:read,simulation:invoke",
      }),
    );
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/v1/jobs",
          headers: bearer(),
        })
      ).statusCode,
    ).toBe(403);
    const response = await server.inject({
      method: "POST",
      url: "/v1/simulate",
      headers: bearer(),
      payload: { transaction: {} },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    await server.close();
  });
  it("survives restart with durable run status and resumable SSE; model absence is optional", async () => {
    const dir = temp(),
      env = {
        NODE_ENV: "test",
        DATA_DIR: dir,
        API_BEARER_TOKEN: "secret",
        API_TENANT_ID: "t",
        API_SCOPES: "agent:read,agent:write",
      };
    let server = await createStandaloneServer(loadConfig(env));
    const made = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: bearer(),
      payload: { sessionId: "s", input: "hi" },
    });
    await new Promise((r) => setTimeout(r, 0));
    const id = made.json().id;
    await server.close();
    server = await createStandaloneServer(loadConfig(env));
    const got = await server.inject({
      method: "GET",
      url: `/v1/runs/${id}`,
      headers: bearer(),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe("failed");
    const events = await server.inject({
      method: "GET",
      url: `/v1/runs/${id}/events`,
      headers: { ...bearer(), "last-event-id": "1" },
    });
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).not.toContain("id: 1\n");
    expect((await server.inject("/readyz")).statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/v1/chat",
          headers: bearer(),
          payload: { sessionId: "s", input: "hi" },
        })
      ).statusCode,
    ).toBe(503);
    await server.close();
  });
});
