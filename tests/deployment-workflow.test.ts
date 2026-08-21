import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execFileAsync = promisify(execFile);
const exec = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown> = {},
) => {
  const windows = process.platform === "win32";
  const target = windows && cmd === "npm" ? "npm.cmd" : cmd;
  const needsShell = windows && (target.endsWith(".cmd") || cmd === "npm");
  return execFileAsync(
    target,
    args,
    needsShell ? { ...opts, shell: true } : opts,
  );
};
const dockerComposeAvailable = await exec("docker", ["compose", "version"])
  .then(() => true)
  .catch(() => false);
describe("clone-to-trade deployment", () => {
  it("documents only real commands, secure key input, and complete operator recovery", async () => {
    const readme = await readFile("README.md", "utf8"),
      trading = await readFile("docs/TRADING.md", "utf8");
    for (const command of [
      "npm run setup:trading",
      "npm run signer -- create",
      "npm run signer -- serve",
      "npm run cli -- trade quote",
      "npm run cli -- trade buy",
      "npm run cli -- trade reconcile --id",
    ])
      expect(`${readme}\n${trading}`).toContain(command);
    for (const topic of [
      "Fund it",
      "Emergency pause",
      "revoke",
      "reconcile",
      "Backup and restore",
    ])
      expect(trading).toContain(topic);
    expect(trading).toContain("--password-fd");
    expect(trading).toContain("--key-fd");
    expect(trading).not.toMatch(/--private-key|--password\s+\S+/);
    expect(trading).toContain("npm run cli -- trade revoke --token");
    // The signer policy prerequisite for a live revoke. Was the ERC-20
    // approve selector `0x095ea7b3`; on Solana the analogue is the SPL Token
    // program plus the `Revoke` instruction discriminator.
    expect(trading).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(readme).not.toContain("read-only and cannot move funds");
  });
  it("describes the production package honestly and ships every deployment asset", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.description).toMatch(/isolated signer/i);
    expect(pkg.files).toEqual(
      expect.arrayContaining(["compose.yaml", "deploy", "docs", "templates"]),
    );
  });
  it.skipIf(!dockerComposeAvailable)(
    "renders compose with explicit RPC and complete API trading configuration",
    async () => {
      await expect(
        exec("docker", ["compose", "config"], {
          cwd: process.cwd(),
          env: { ...process.env, RPC_URL: "" },
        }),
      ).rejects.toThrow();
      const { stdout } = await exec("docker", ["compose", "config"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RPC_URL: "https://rpc.example",
          TRADING_ACCOUNT: "0x0000000000000000000000000000000000000001",
          TRADING_MAX_AMOUNT_IN: "1",
          API_BEARER_TOKEN_SHA256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
      for (const value of [
        "RPC_URL",
        "EXECUTION_MODE",
        "TRADING_ACCOUNT",
        "SIGNER_SOCKET_PATH",
        "SIGNER_TOKEN_PATH",
        "SIGNER_POLICY_PATH",
        "healthcheck",
        "condition: service_healthy",
      ])
        expect(stdout).toContain(value);
      expect(stdout).not.toContain("host.docker.internal");
    },
  );
  it("ships setup and reconcile operator scripts plus ordered hardened systemd units", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.scripts["setup:trading"]).toBe(
      "node dist/bin/robinhood-agent-os.js setup",
    );
    expect(pkg.scripts["trading:reconcile"]).toContain("reconcile");
    const api = await readFile("deploy/systemd/raos-api.service", "utf8");
    const signer = await readFile("deploy/systemd/raos-signer.service", "utf8");
    expect(api).toContain("Requires=raos-migrate.service raos-signer.service");
    expect(api).toContain(
      "After=network-online.target raos-migrate.service raos-signer.service",
    );
    expect(signer).toContain("/opt/robinhood-agent-os/dist/bin/signer.js");
    expect(signer).toContain("StateDirectory=raos-signer");
  });
  it("keeps API and signer environment files separate while readiness binds their identities", async () => {
    const compose = await readFile("compose.yaml", "utf8"),
      api = await readFile("deploy/systemd/raos-api.service", "utf8"),
      signer = await readFile("deploy/systemd/raos-signer.service", "utf8");
    expect(api).toContain("EnvironmentFile=/etc/raos/raos.env");
    expect(signer).toContain(
      "EnvironmentFile=/etc/raos-signer/raos-signer.env",
    );
    expect(
      compose.match(/AUTHORIZATION_KEY_ID/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(compose).toContain('"request","--method","status"');
  });
  it("npm pack installs executable raos and raos-signer wallet/trade commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "raos-pack-"));
    try {
      const packed = JSON.parse(
        (await exec("npm", ["pack", "--json"], { cwd: process.cwd() })).stdout,
      )[0].filename;
      await exec("npm", ["init", "-y"], { cwd: root });
      await exec("npm", ["install", join(process.cwd(), packed)], {
        cwd: root,
      });
      const shim = (name: string) =>
        join(
          root,
          "node_modules/.bin",
          process.platform === "win32" ? `${name}.cmd` : name,
        );
      const raos = shim("raos"),
        signer = shim("raos-signer");
      expect((await exec(raos, ["--help"], { cwd: root })).stdout).toContain(
        "wallet",
      );
      await expect(
        exec(signer, ["status", "--keystore", join(root, "missing.json")], {
          cwd: root,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/ENOENT|no such file/i),
      });
      await rm(join(process.cwd(), packed), { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 240000);
});
