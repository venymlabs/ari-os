import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserWorkflow } from "../src/cli/user-workflow.js";
import { posixPermissions } from "./helpers.js";
const dirs: string[] = [];
afterEach(() =>
  Promise.all(
    dirs.splice(0).map((x) => rm(x, { recursive: true, force: true })),
  ),
);
describe("clone-to-trade workflow", () => {
  it("initializes private config, policy, and socket token without returning the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raos-user-"));
    dirs.push(dir);
    const user = createUserWorkflow({ dataDir: dir });
    const out: any = await user({ group: "setup", action: "init", args: {} });
    expect(out.files).toEqual(
      expect.arrayContaining(["config.json", "policy.json", "signer.token"]),
    );
    expect(JSON.stringify(out)).not.toContain(
      await readFile(join(dir, "signer.token"), "utf8"),
    );
    if (posixPermissions)
      expect((await stat(join(dir, "signer.token"))).mode & 0o077).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, "config.json"), "utf8")).mode,
    ).toBe("local");
  });
  it("writes a default sign policy that can authorize allowance revokes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raos-user-"));
    dirs.push(dir);
    const user = createUserWorkflow({ dataDir: dir });
    await user({ group: "setup", action: "init", args: {} });
    const policy = JSON.parse(
      await readFile(join(dir, "sign-policy.json"), "utf8"),
    );
    expect(policy.dataPrefixes).toContain("0x095ea7b3");
  });
  it("routes trade revoke to the orchestrator with normalized token and dry-run default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raos-user-"));
    dirs.push(dir);
    const calls: unknown[] = [];
    const user = createUserWorkflow({
      dataDir: dir,
      trading: {
        revoke: (async (token: string, o: unknown) => {
          calls.push([token, o]);
          return { id: "x", state: "dry-run" };
        }) as any,
      } as any,
    });
    const out: any = await user({
      group: "trade",
      action: "revoke",
      args: {
        token: "0x00000000000000000000000000000000000000aa",
        idempotencyKey: "k1",
      },
    });
    expect(out.state).toBe("dry-run");
    expect(calls).toEqual([
      [
        "0x00000000000000000000000000000000000000AA",
        { idempotencyKey: "k1", actor: "cli", dryRun: true },
      ],
    ]);
    await expect(
      user({
        group: "trade",
        action: "revoke",
        args: { token: "nope", idempotencyKey: "k2" },
      }),
    ).rejects.toThrow();
  });
  it("uses RPC for portfolio but refuses disconnected fake trades", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raos-user-"));
    dirs.push(dir);
    let calls = 0;
    const user = createUserWorkflow({
      dataDir: dir,
      rpc: async (method) => {
        calls++;
        if (method === "eth_getBalance") return "0x10";
        throw Error("unexpected");
      },
    });
    await user({ group: "setup", action: "init", args: {} });
    const p: any = await user({
      group: "portfolio",
      action: "show",
      args: { address: "0x0000000000000000000000000000000000000001" },
    });
    expect(p.nativeBalance).toBe("16");
    await expect(
      user({
        group: "trade",
        action: "buy",
        args: { quoteId: "q", idempotencyKey: "same" },
      }),
    ).rejects.toThrow("trading service not configured");
    expect(calls).toBe(1);
    await expect(stat(join(dir, "trades.json"))).rejects.toThrow();
  });
});
