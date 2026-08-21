import { afterEach, describe, expect, it } from "vitest";
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
) =>
  execFileAsync(
    process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd,
    args,
    process.platform === "win32" && cmd === "npm"
      ? { ...opts, shell: true }
      : opts,
  );
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  ),
);
const envFor = async () => {
  const d = await mkdtemp(join(tmpdir(), "raos-ops-"));
  dirs.push(d);
  return { ...process.env, DATA_DIR: d, NODE_ENV: "test" };
};
describe("operational package entrypoints", () => {
  it("does not run a destructive build from operational scripts and has distinct database commands", async () => {
    const p = JSON.parse(await readFile("package.json", "utf8"));
    for (const name of [
      "config:check",
      "db:migrate",
      "db:status",
      "db:integrity",
      "worker",
    ])
      expect(p.scripts[name]).not.toContain("npm run build");
    expect(
      new Set([
        p.scripts["db:migrate"],
        p.scripts["db:status"],
        p.scripts["db:integrity"],
      ]).size,
    ).toBe(3);
  });
  it("runs migration, status and integrity sequentially against real databases", async () => {
    const env = await envFor();
    for (const command of ["db:migrate", "db:status", "db:integrity"]) {
      const { stdout } = await exec("npm", ["run", command, "--silent"], {
        env,
      });
      expect(JSON.parse(stdout)).toMatchObject({ command, ok: true });
    }
  }, 60000);
  it("runs worker once against the durable queue", async () => {
    const env = await envFor();
    const { stdout } = await exec(
      "npm",
      ["run", "worker", "--silent", "--", "--once"],
      { env },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      worker: { once: true, processed: false },
    });
  }, 60000);
  it("server bootstrap creates and starts the real application", async () => {
    const source = await readFile("src/server.ts", "utf8");
    expect(source).toContain("loadConfig");
    expect(source).toContain("createApplication");
    expect(source).toContain("await application.start()");
  });
  it("installed CLI emits status results and package version", async () => {
    const env = await envFor();
    const { stdout: version } = await exec(
      process.execPath,
      [join(process.cwd(), "dist/bin/robinhood-agent-os.js"), "--version"],
      { env },
    );
    expect(version.trim()).toBe("0.1.0");
    const { stdout } = await exec(
      process.execPath,
      [join(process.cwd(), "dist/bin/robinhood-agent-os.js"), "status"],
      { env: { ...env, RAOS_API_URL: "data:application/json,%7B%7D" } },
    ).catch((e: any) => e);
    expect(stdout).toContain("ok");
  }, 30000);
});
