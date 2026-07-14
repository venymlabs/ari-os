import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalManifest,
  parsePluginManifest,
  PluginInstaller,
  PluginHost,
  type PluginWorker,
} from "../src/plugins/index.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "plugin-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => removeDir(d)));
const base = {
  schemaVersion: 1,
  id: "com.acme.prices",
  version: "1.2.3",
  package: {
    sha256: "a".repeat(64),
    provenance: "https://registry.example/acme/prices",
  },
  compatibility: { agent: ">=1.0.0 <2.0.0", node: ">=22" },
  tools: [{ name: "quote", effect: "read", capabilities: ["market.read"] }],
  permissions: {
    filesystem: { read: ["data/public"], write: ["data/cache"] },
    network: [{ hostname: "api.example.com", port: 443, tls: true }],
    env: ["API_REGION"],
  },
  resources: { cpuMs: 1000, memoryMb: 64, timeoutMs: 5000 },
};

describe("signed plugin manifests", () => {
  it("parses a strict versioned manifest and returns immutable declarations", () => {
    const m = parsePluginManifest(base);
    expect(m.id).toBe("com.acme.prices");
    expect(Object.isFrozen(m.permissions.network)).toBe(true);
    expect(() => m.permissions.env.push("SECRET")).toThrow();
  });
  it.each([
    "signing",
    "wallet",
    "broadcast",
    "raw_transaction",
    "policy.mutate",
    "approval",
    "memory",
    "skills",
    "jobs",
  ])("rejects forbidden %s capability", (cap) =>
    expect(() =>
      parsePluginManifest({
        ...base,
        tools: [{ name: "x", effect: "read", capabilities: [cap] }],
      }),
    ).toThrow(/forbidden/i),
  );
  it("rejects unknown fields, env values, unsafe paths and insecure egress", () => {
    expect(() => parsePluginManifest({ ...base, evil: true })).toThrow(
      /unknown/i,
    );
    expect(() =>
      parsePluginManifest({
        ...base,
        permissions: { ...base.permissions, env: ["TOKEN=value"] },
      }),
    ).toThrow(/env/i);
    expect(() =>
      parsePluginManifest({
        ...base,
        permissions: {
          ...base.permissions,
          filesystem: { read: ["../secret"], write: [] },
        },
      }),
    ).toThrow(/path/i);
    expect(() =>
      parsePluginManifest({
        ...base,
        permissions: {
          ...base.permissions,
          network: [{ hostname: "*", port: 80, tls: false }],
        },
      }),
    ).toThrow(/network|hostname|tls/i);
  });
});

describe("secure installer", () => {
  it("verifies injected signature and package digest before atomically installing", async () => {
    const keys = generateKeyPairSync("ed25519");
    const bytes = Buffer.from("safe package");
    const manifest = {
      ...base,
      package: {
        ...base.package,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const signature = sign(
      null,
      Buffer.from(canonicalManifest(manifest)),
      keys.privateKey,
    );
    const root = temp();
    const installer = new PluginInstaller({
      root,
      verifySignature: (payload, sig) => {
        expect(payload.toString()).toBe(canonicalManifest(manifest));
        return verify(null, payload, keys.publicKey, sig);
      },
    });
    const result = await installer.install({
      manifest,
      signature,
      packageBytes: bytes,
      entries: [{ path: "index.js", data: Buffer.from("export default 1") }],
    });
    expect(result.id).toBe(base.id);
    expect(
      readFileSync(join(root, base.id, base.version, "index.js"), "utf8"),
    ).toContain("export");
  });
  it("rejects bad signatures, digest mismatch, traversal, symlinks and archive bombs", async () => {
    const root = temp();
    const installer = new PluginInstaller({
      root,
      verifySignature: () => false,
      limits: { maxFiles: 2, maxUnpackedBytes: 10 },
    });
    await expect(
      installer.install({
        manifest: base,
        signature: Buffer.alloc(1),
        packageBytes: Buffer.from("x"),
        entries: [],
      }),
    ).rejects.toThrow(/signature/i);
    const ok = new PluginInstaller({
      root,
      verifySignature: () => true,
      limits: { maxFiles: 2, maxUnpackedBytes: 10 },
    });
    await expect(
      ok.install({
        manifest: base,
        signature: Buffer.alloc(1),
        packageBytes: Buffer.from("x"),
        entries: [],
      }),
    ).rejects.toThrow(/digest/i);
    const digest = (await import("node:crypto"))
      .createHash("sha256")
      .update("x")
      .digest("hex");
    const m = { ...base, package: { ...base.package, sha256: digest } };
    for (const entries of [
      [{ path: "../x", data: Buffer.from("x") }],
      [{ path: "link", data: Buffer.alloc(0), type: "symlink" as const }],
      [{ path: "x", data: Buffer.alloc(11) }],
    ])
      await expect(
        ok.install({
          manifest: m,
          signature: Buffer.alloc(1),
          packageBytes: Buffer.from("x"),
          entries,
        }),
      ).rejects.toThrow(/path|symlink|limit/i);
  });
});

describe("capability sandbox host", () => {
  it("starts injected workers with sanitized env/temp cwd and mediates RPC default-deny", async () => {
    let options: any;
    const worker: PluginWorker = {
      invoke: vi.fn(async () => ({ ok: true })),
      terminate: vi.fn(async () => {}),
    };
    const host = new PluginHost({
      spawn: async (o) => ((options = o), worker),
      env: { API_REGION: "us", SIGNER_PRIVATE_KEY: "never", PATH: "/bin" },
      mediate: async (req) =>
        req.capability === "market.read"
          ? "allowed"
          : Promise.reject(new Error("denied")),
    });
    const session = await host.start(parsePluginManifest(base));
    expect(options.env).toEqual({ API_REGION: "us" });
    expect(options.cwd).toMatch(/plugin-/);
    expect(options.resources.memoryMb).toBe(64);
    await expect(
      session.request({
        capability: "market.read",
        operation: "quote",
        input: {},
      }),
    ).resolves.toBe("allowed");
    await expect(
      session.request({ capability: "wallet", operation: "sign", input: {} }),
    ).rejects.toThrow(/denied|capability/i);
    await session.close();
    expect(worker.terminate).toHaveBeenCalled();
  });
  it("times out, cancels, and quarantines crashing plugins", async () => {
    const worker: PluginWorker = {
      invoke: () => Promise.reject(new Error("crash")),
      terminate: vi.fn(async () => {}),
    };
    const host = new PluginHost({
      spawn: async () => worker,
      mediate: async () => new Promise(() => {}),
      quarantineThreshold: 1,
    });
    const session = await host.start(
      parsePluginManifest({
        ...base,
        resources: { ...base.resources, timeoutMs: 10 },
      }),
    );
    await expect(session.invoke("quote", {})).rejects.toThrow(/crash/i);
    expect(host.isQuarantined(base.id)).toBe(true);
    await expect(host.start(parsePluginManifest(base))).rejects.toThrow(
      /quarantin/i,
    );
  });
});
