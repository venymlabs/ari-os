#!/usr/bin/env node
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import {
  isWindows,
  permissionsAreUnsafe,
  readFd,
  toIpcPath,
} from "../platform.js";
import {
  createEncryptedKeystore,
  generateSecretKey,
  JsonFrameDecoder,
  loadSignPolicy,
  parseSecretKey,
  reconcileTransactions,
  SignerService,
  SqliteReplayStore,
  broadcastSigned,
  unlockKeystore,
  type RpcCall,
} from "../signer/index.js";

export const VERSION = "0.1.0";
const HELP = `raos-signer ${VERSION}

Usage: raos-signer <create|import|status|serve|request|reconcile> [options]

Options:
  --rpc <url>                 Solana JSON-RPC endpoint
  --key-id <id>               authorization key identifier
  --policy <path>             signer policy JSON file
  --keystore <path>           encrypted wallet file
  --help                      show help
  --version                   show version`;

type Args = Record<string, string | boolean>;
function args(xs: string[]) {
  const out: Args = {};
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x.startsWith("--")) {
      const k = x.slice(2);
      out[k] = xs[i + 1] && !xs[i + 1]!.startsWith("--") ? xs[++i]! : true;
    } else if (!out._) out._ = x;
  }
  return out;
}
async function secret(fd: number, label: string) {
  if (process.stdin.isTTY) process.stderr.write(`${label}: `);
  const b = await readFd(fd),
    s = b.toString("utf8").trim();
  b.fill(0);
  if (!s) throw Error(`${label.toLowerCase()}_required`);
  return s;
}
async function safeSecretFile(path: string) {
  const st = await lstat(path);
  if (st.isSymbolicLink() || !st.isFile() || permissionsAreUnsafe(st))
    throw Error("secret_file_unsafe");
  return (await readFile(path, "utf8")).trim();
}
async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const x: any = await r.json();
  if (x.error) throw Error(`rpc_${x.error.code}`);
  return x.result;
}
function send(socket: string, request: unknown) {
  return new Promise<any>((resolve, reject) => {
    const c = createConnection(toIpcPath(socket)),
      d = new JsonFrameDecoder();
    c.on("connect", () => c.write(`${JSON.stringify(request)}\n`));
    c.on("data", (b) => {
      try {
        const [x] = d.push(b);
        if (x) {
          c.end();
          if ((x as any).ok) resolve((x as any).result);
          else reject(Error((x as any).error));
        }
      } catch (e) {
        reject(e);
      }
    });
    c.on("error", reject);
  });
}

export function createSignerWireConfig(
  authKey: string,
  audience: string,
  keyId: string | undefined,
  policy: { hash: string; version: number; cluster: string },
) {
  return {
    audience,
    cluster: policy.cluster,
    verifier: {
      verify: async (d: string, s: string, claimedKeyId?: string) => {
        if (keyId && claimedKeyId !== keyId) return false;
        const expected = createHmac("sha256", authKey).update(d).digest();
        let got: Buffer;
        try {
          got = Buffer.from(s, "hex");
        } catch {
          return false;
        }
        return got.length === expected.length && timingSafeEqual(got, expected);
      },
    },
    ...(keyId ? { signerKeyId: keyId, authorizationKeyIds: [keyId] } : {}),
    policyHash: policy.hash,
    policyVersion: policy.version,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  if (a.help) {
    console.log(HELP);
    return;
  }
  if (a.version) {
    console.log(VERSION);
    return;
  }
  const cmd = String(a._ ?? "");
  const keystore = String(a.keystore ?? "wallet.json");
  if (cmd === "create" || cmd === "import") {
    const password = await secret(Number(a["password-fd"] ?? 0), "Password");
    // `import` accepts what real Solana tooling emits: solana-keygen's JSON
    // byte array, or a base58 secret key. Never an argv value.
    let key =
      cmd === "create"
        ? generateSecretKey()
        : parseSecretKey(await secret(Number(a["key-fd"] ?? 0), "Secret key"));
    try {
      console.log(
        JSON.stringify({
          address: await createEncryptedKeystore(keystore, key, password),
        }),
      );
    } finally {
      key.fill(0);
      // Best-effort: drop the local reference to the key material.
      // eslint-disable-next-line no-useless-assignment
      key = new Uint8Array(0);
    }
    return;
  }
  if (cmd === "status") {
    const st = await lstat(keystore),
      body = JSON.parse(await readFile(keystore, "utf8"));
    console.log(
      JSON.stringify({
        locked: true,
        address: body.publicKey,
        permissions: (st.mode & 0o777).toString(8),
      }),
    );
    return;
  }
  const socket = String(a.socket ?? "signer.sock"),
    tokenFile = String(a.token ?? "signer.token");
  if (cmd === "request") {
    const token = await safeSecretFile(tokenFile),
      payload = a.method
        ? { method: String(a.method) }
        : JSON.parse(await readFile(String(a.file ?? "/dev/stdin"), "utf8"));
    console.log(JSON.stringify(await send(socket, { token, ...payload })));
    return;
  }
  if (cmd !== "serve" && cmd !== "reconcile")
    throw Error("usage: signer <create|import|status|serve|request|reconcile>");
  const password = await secret(Number(a["password-fd"] ?? 0), "Password"),
    account = await unlockKeystore(keystore, password),
    policy = await loadSignPolicy(String(a.policy)),
    store = new SqliteReplayStore(String(a.db ?? "signer.sqlite")),
    rpcUrl = String(a.rpc ?? "");
  const call: RpcCall = (m, p) => rpc(rpcUrl, m, p);
  if (cmd === "reconcile") {
    try {
      await reconcileTransactions(store, call);
    } finally {
      account.lock();
      store.close();
    }
    return;
  }
  const authKey = await safeSecretFile(String(a["authorization-key"])),
    token = await safeSecretFile(tokenFile),
    wire = {
      ...createSignerWireConfig(
        authKey,
        String(a.audience ?? "signer"),
        a["key-id"] ? String(a["key-id"]) : undefined,
        policy,
      ),
      // Solana has no account nonce; the recent blockhash is the fence, and
      // crossing its last valid height is terminal.
      ...(rpcUrl
        ? {
            blockHeight: async () =>
              Number(
                await call("getBlockHeight", [{ commitment: "confirmed" }]),
              ),
          }
        : {}),
    },
    service = new SignerService(account, store, policy, wire);
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  await rm(socket, { force: true });
  const server = createServer((c) => {
    const decoder = new JsonFrameDecoder();
    c.on("data", async (b) => {
      try {
        for (const value of decoder.push(b)) {
          const q: any = value;
          if (
            typeof q.token !== "string" ||
            !timingSafeEqual(Buffer.from(q.token), Buffer.from(token))
          )
            throw Error("socket_unauthorized");
          if (q.method === "status") {
            c.write(
              JSON.stringify({
                ok: true,
                result: {
                  account: account.publicKey,
                  cluster: policy.cluster,
                  policyHash: policy.hash,
                  policyVersion: policy.version,
                  authorizationKeyId: String(a["key-id"] ?? ""),
                  serviceVersion: VERSION,
                },
              }) + "\n",
            );
            continue;
          }
          if (q.method === "result") {
            c.write(
              JSON.stringify({
                ok: true,
                result: service.result(
                  q.authorizationId,
                  q.messageHash,
                  q.recoverRaw === true,
                ),
              }) + "\n",
            );
            continue;
          }
          if (q.method !== "sign") throw Error("method_invalid");
          const signed = await service.signEnvelope(q.transaction, q.envelope);
          const broadcast = q.broadcast
            ? await broadcastSigned(
                store,
                q.envelope.claims.id,
                signed.transaction,
                call,
              )
            : undefined;
          c.write(
            JSON.stringify({ ok: true, result: { ...signed, broadcast } }) +
              "\n",
          );
        }
      } catch (e) {
        c.write(
          JSON.stringify({
            ok: false,
            error: e instanceof Error ? e.message : "request_failed",
          }) + "\n",
        );
        c.destroy();
      }
    });
  });
  server.on("close", () => {
    clearInterval(reconcileTimer);
    account.lock();
    store.close();
  });
  const reconcileInterval = Math.max(
    1000,
    Number(a["reconcile-interval-ms"] ?? 15000),
  );
  let reconciling = false;
  await reconcileTransactions(store, call);
  const reconcileTimer = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await reconcileTransactions(store, call);
    } catch (e) {
      console.error(e instanceof Error ? e.message : "reconcile_failed");
    } finally {
      reconciling = false;
    }
  }, reconcileInterval);
  reconcileTimer.unref();
  server.listen(toIpcPath(socket), async () => {
    // Named pipes are not filesystem inodes; chmod applies to Unix
    // domain sockets only.
    if (!isWindows) await chmod(socket, 0o600);
    if (process.send) process.send("ready");
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, () => server.close());
}
if (process.argv[1]) {
  let invoked: string | undefined;
  try {
    invoked = realpathSync(process.argv[1]);
  } catch {}
  if (invoked === fileURLToPath(import.meta.url))
    main().catch((e) => {
      console.error(e instanceof Error ? e.message : "signer_failed");
      process.exitCode = 1;
    });
}
