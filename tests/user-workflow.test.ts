import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserWorkflow } from "../src/cli/user-workflow.js";
import { posixPermissions } from "./helpers.js";
import { pubkey, TOKEN_PROGRAM } from "./signer-fixtures.js";
const TOKEN_ACCOUNT = pubkey(10);
const WALLET = pubkey(11);
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
  it("writes a default sign policy that can authorize delegate revokes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raos-user-"));
    dirs.push(dir);
    const user = createUserWorkflow({ dataDir: dir });
    await user({ group: "setup", action: "init", args: {} });
    const policy = JSON.parse(
      await readFile(join(dir, "sign-policy.json"), "utf8"),
    );
    // SPL Token `Revoke`, classified `none` because it cannot move value: it
    // only ever reduces what a delegate may move.
    expect(policy.programs).toContainEqual({
      programId: TOKEN_PROGRAM,
      discriminator: "05",
      effect: "none",
    });
  });
  it("routes trade revoke to the orchestrator with a checked token account and dry-run default", async () => {
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
      args: { token: TOKEN_ACCOUNT, idempotencyKey: "k1" },
    });
    expect(out.state).toBe("dry-run");
    expect(calls).toEqual([
      [TOKEN_ACCOUNT, { idempotencyKey: "k1", actor: "cli", dryRun: true }],
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
        // Lamports, in the RPC context envelope Solana wraps balances in.
        if (method === "getBalance") return { context: { slot: 1 }, value: 16 };
        throw Error("unexpected");
      },
    });
    await user({ group: "setup", action: "init", args: {} });
    const p: any = await user({
      group: "portfolio",
      action: "show",
      args: { address: WALLET },
    });
    expect(p.nativeBalance).toBe("16");
    // An EVM address is not a wallet any more, and never reaches the RPC.
    await expect(
      user({
        group: "portfolio",
        action: "show",
        args: { address: "0x0000000000000000000000000000000000000001" },
      }),
    ).rejects.toThrow(/address/);
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
