import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializable,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  SignerWireVerifier,
  type AuthorizationEnvelope,
  type EnvelopeVerifier,
  type ExecutionState,
  type ReplayStore,
} from "../execution/authorization/index.js";
import { isWindows, permissionsAreUnsafe } from "../platform.js";

const KDF = { N: 16384, r: 8, p: 1, dkLen: 32 } as const;
type KdfParams = { N: number; r: number; p: number; dkLen: number };
function validKdf(x: unknown): x is KdfParams {
  if (!x || typeof x !== "object") return false;
  const k = x as any;
  return (
    Number.isSafeInteger(k.N) &&
    k.N >= 16384 &&
    k.N <= 262144 &&
    (k.N & (k.N - 1)) === 0 &&
    Number.isSafeInteger(k.r) &&
    k.r >= 1 &&
    k.r <= 16 &&
    Number.isSafeInteger(k.p) &&
    k.p >= 1 &&
    k.p <= 4 &&
    k.dkLen === 32 &&
    128 * k.N * k.r <= 512 * 1024 * 1024
  );
}
const scrypt = (password: string, salt: Buffer, k: KdfParams = KDF) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      k.dkLen,
      { N: k.N, r: k.r, p: k.p, maxmem: 512 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
type Keystore = {
  version: 1;
  address: Address;
  crypto: {
    cipher: "aes-256-gcm";
    kdf: "scrypt";
    kdfparams: KdfParams;
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
};
export async function assertPrivatePath(
  path: string,
  label: string,
  exists: boolean,
) {
  const absolute = resolve(path),
    root = parse(absolute).root,
    immediate = dirname(absolute);
  const samePath = (a: string, b: string) =>
    isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  let current = immediate;
  while (current !== root) {
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw Error(`${label}_parent_symlink_forbidden`);
    if (!st.isDirectory()) throw Error(`${label}_parent_invalid`);
    const resolved = await realpath(current);
    if (!samePath(resolved, current))
      throw Error(`${label}_parent_symlink_forbidden`);
    if (current === immediate && permissionsAreUnsafe(st))
      throw Error(`${label}_parent_permissions_unsafe`);
    current = dirname(current);
  }
  if (exists) {
    const st = await lstat(absolute);
    if (st.isSymbolicLink()) throw Error(`${label}_symlink_forbidden`);
    if (!st.isFile()) throw Error(`${label}_format_invalid`);
    if (permissionsAreUnsafe(st)) throw Error(`${label}_permissions_unsafe`);
  }
}
export async function createEncryptedKeystore(
  path: string,
  privateKey: Hex,
  password: string,
): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
    throw Error("private_key_invalid");
  if (!password) throw Error("password_required");
  await assertPrivatePath(path, "keystore", false);
  const salt = randomBytes(32),
    iv = randomBytes(12),
    key = await scrypt(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv),
      plain = Buffer.from(privateKey.slice(2), "hex");
    try {
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]),
        account = privateKeyToAccount(privateKey),
        body: Keystore = {
          version: 1,
          address: account.address,
          crypto: {
            cipher: "aes-256-gcm",
            kdf: "scrypt",
            kdfparams: { ...KDF },
            salt: salt.toString("hex"),
            iv: iv.toString("hex"),
            tag: cipher.getAuthTag().toString("hex"),
            ciphertext: ciphertext.toString("hex"),
          },
        },
        file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(body));
        await file.sync();
      } finally {
        await file.close();
      }
      return account.address;
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
}
export async function unlockKeystore(
  path: string,
  password: string,
): Promise<PrivateKeyAccount> {
  let key: Buffer | undefined, plain: Buffer | undefined;
  try {
    await assertPrivatePath(path, "keystore", true);
    const body = JSON.parse(await readFile(path, "utf8")) as Keystore;
    if (
      body.version !== 1 ||
      body.crypto.cipher !== "aes-256-gcm" ||
      body.crypto.kdf !== "scrypt"
    )
      throw Error("keystore_format_invalid");
    if (!validKdf(body.crypto.kdfparams)) throw Error("keystore_kdf_invalid");
    if (
      !/^[0-9a-f]{64}$/i.test(body.crypto.salt) ||
      !/^[0-9a-f]{24}$/i.test(body.crypto.iv) ||
      !/^[0-9a-f]{32}$/i.test(body.crypto.tag) ||
      !/^[0-9a-f]{64}$/i.test(body.crypto.ciphertext)
    )
      throw Error("keystore_format_invalid");
    key = await scrypt(
      password,
      Buffer.from(body.crypto.salt, "hex"),
      body.crypto.kdfparams,
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(body.crypto.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(body.crypto.tag, "hex"));
    plain = Buffer.concat([
      decipher.update(Buffer.from(body.crypto.ciphertext, "hex")),
      decipher.final(),
    ]);
    const account = privateKeyToAccount(`0x${plain.toString("hex")}`);
    if (
      !timingSafeEqual(
        Buffer.from(account.address.toLowerCase()),
        Buffer.from(body.address.toLowerCase()),
      )
    )
      throw Error("address mismatch");
    return account;
  } catch (error) {
    if (
      error instanceof Error &&
      /permissions|format|symlink|kdf/.test(error.message)
    )
      throw error;
    // Deliberately opaque: decryption failures must not leak which stage
    // failed (wrong password, tampered ciphertext, corrupt file).
    // eslint-disable-next-line preserve-caught-error
    throw Error("keystore_decryption_failed");
  } finally {
    key?.fill(0);
    plain?.fill(0);
  }
}

export class SqliteReplayStore implements ReplayStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS signer_replay(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,data TEXT,updated_at INTEGER NOT NULL,recovered INTEGER NOT NULL DEFAULT 0)`,
    );
    const columns = this.db
      .prepare("PRAGMA table_info(signer_replay)")
      .all() as any[];
    if (!columns.some((x) => x.name === "recovered"))
      this.db.exec(
        "ALTER TABLE signer_replay ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0",
      );
  }
  async consume(id: string, expiresAt: number) {
    if (!id || !Number.isSafeInteger(expiresAt)) return false;
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO signer_replay(id,expires_at,state,updated_at) VALUES(?,?,'claimed',?)",
        )
        .run(id, expiresAt, Date.now()).changes === 1
    );
  }
  async transition(
    id: string,
    from: ExecutionState,
    to: ExecutionState,
    data?: string,
  ) {
    return (
      this.db
        .prepare(
          "UPDATE signer_replay SET state=?,data=?,version=version+1,updated_at=? WHERE id=? AND state=?",
        )
        .run(to, data ?? null, Date.now(), id, from).changes === 1
    );
  }
  get(id: string) {
    return this.db
      .prepare(
        "SELECT id,expires_at expiresAt,state,version,data,updated_at updatedAt,recovered FROM signer_replay WHERE id=?",
      )
      .get(id) as any;
  }
  recoverSigned(id: string) {
    return this.db
      .prepare(
        "UPDATE signer_replay SET recovered=1,version=version+1,updated_at=? WHERE id=? AND state='signed' AND recovered=0 RETURNING data",
      )
      .get(Date.now(), id) as { data: string } | undefined;
  }
  list(states: ExecutionState[]) {
    const q = states.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT id,expires_at expiresAt,state,version,data,updated_at updatedAt FROM signer_replay WHERE state IN (${q})`,
      )
      .all(...states) as any[];
  }
  close() {
    this.db.close();
  }
}

export interface SignPolicy {
  chainIds: readonly number[];
  accounts: readonly Address[];
  to: readonly Address[];
  maxValue: bigint;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  dataPrefixes: readonly Hex[];
}
export interface LoadedSignPolicy extends SignPolicy {
  version: number;
  hash: Hex;
}
export async function loadSignPolicy(path: string): Promise<LoadedSignPolicy> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw Error("policy_symlink_forbidden");
  if (!st.isFile()) throw Error("policy_format_invalid");
  if (permissionsAreUnsafe(st)) throw Error("policy_permissions_unsafe");
  const raw = await readFile(path, "utf8"),
    x = JSON.parse(raw);
  if (
    x.version !== 1 ||
    !Array.isArray(x.chainIds) ||
    !Array.isArray(x.accounts) ||
    !Array.isArray(x.to) ||
    !Array.isArray(x.dataPrefixes)
  )
    throw Error("policy_format_invalid");
  return {
    ...x,
    maxValue: BigInt(x.maxValue),
    maxGas: BigInt(x.maxGas),
    maxFeePerGas: BigInt(x.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(x.maxPriorityFeePerGas),
    hash: `0x${createHash("sha256").update(raw).digest("hex")}`,
  };
}

export class SignerService {
  constructor(
    private account: PrivateKeyAccount,
    private replay: ReplayStore,
    private policy: SignPolicy,
    private wire?: {
      verifier: EnvelopeVerifier;
      audience: string;
      signerKeyId?: string;
      policyHash?: string;
      policyVersion?: number;
      now?: () => number;
      nonce?: (chainId: number, account: string) => Promise<number>;
    },
  ) {}
  private check(tx: TransactionSerializable, claimed: Address) {
    if (
      !Number.isSafeInteger(tx.chainId) ||
      !this.policy.chainIds.includes(tx.chainId!)
    )
      throw Error("policy_chain");
    if (
      getAddress(claimed) !== getAddress(this.account.address) ||
      !this.policy.accounts.some((x) => getAddress(x) === getAddress(claimed))
    )
      throw Error("policy_account");
    if (
      !tx.to ||
      !this.policy.to.some((x) => getAddress(x) === getAddress(tx.to!))
    )
      throw Error("policy_to");
    if (!Number.isSafeInteger(tx.nonce) || tx.nonce! < 0)
      throw Error("policy_nonce");
    if ((tx.value ?? 0n) > this.policy.maxValue) throw Error("policy_value");
    if ((tx.gas ?? 0n) > this.policy.maxGas) throw Error("policy_gas");
    if (
      (tx.maxFeePerGas ?? 0n) > this.policy.maxFeePerGas ||
      (tx.maxPriorityFeePerGas ?? 0n) > this.policy.maxPriorityFeePerGas
    )
      throw Error("policy_fees");
    if (
      !this.policy.dataPrefixes.some((x) =>
        (tx.data ?? "0x").toLowerCase().startsWith(x.toLowerCase()),
      )
    )
      throw Error("policy_data");
  }
  private stored(id: string, requestHash: Hex) {
    const row = (this.replay as any).get?.(id);
    if (!row) return;
    let data: any;
    try {
      data = JSON.parse(row.data);
    } catch {
      return;
    }
    if (data.requestHash?.toLowerCase() !== requestHash.toLowerCase())
      throw Error("authorization_request_mismatch");
    if (row.state !== "signed" || !data.raw)
      throw Error("authorization_in_progress");
    return data as {
      requestHash: Hex;
      raw: Hex;
      hash: Hex;
      recovered?: boolean;
    };
  }
  async sign(
    authorizationId: string,
    tx: TransactionSerializable,
    claimedAccount: Address,
  ) {
    this.check(tx, claimedAccount);
    const requestHash = keccak256(
      await import("viem").then((v) => v.serializeTransaction(tx)),
    );
    const prior = this.stored(authorizationId, requestHash);
    if (prior) return prior.raw;
    if (!(await this.replay.consume(authorizationId, Date.now() + 60_000)))
      throw Error("envelope_replayed");
    return this.signClaimed(authorizationId, tx, requestHash);
  }
  private async signClaimed(
    id: string,
    tx: TransactionSerializable,
    requestHash: Hex,
  ) {
    try {
      const raw = await this.account.signTransaction(tx),
        data = JSON.stringify({ requestHash, raw, hash: keccak256(raw) });
      if (
        this.replay.transition &&
        !(await this.replay.transition(id, "claimed", "signed", data))
      )
        throw Error("replay_fencing_lost");
      return raw;
    } catch (e) {
      await this.replay.transition?.(id, "claimed", "failed");
      throw e;
    }
  }
  result(id: string, requestHash: Hex, recoverRaw = false) {
    const data = this.stored(id, requestHash);
    if (!data) return { state: "not_found" as const };
    const result: any = { state: "signed", hash: data.hash };
    if (recoverRaw) {
      const claimed = (this.replay as any).recoverSigned?.(id);
      if (claimed) {
        let recovered: any;
        try {
          recovered = JSON.parse(claimed.data);
        } catch {
          throw Error("signed_result_invalid");
        }
        result.raw = recovered.raw;
      }
    }
    return result;
  }
  async signEnvelope(serialized: Hex, envelope: AuthorizationEnvelope) {
    if (!this.wire) throw Error("wire_verifier_required");
    const requestHash = keccak256(serialized),
      prior = this.stored(envelope.claims.id, requestHash);
    const replayStore: ReplayStore = prior
      ? { consume: async () => true }
      : this.replay;
    const verified = await new SignerWireVerifier({
      ...this.wire,
      replayStore,
    }).verify(serialized, envelope);
    this.check(verified.decoded, envelope.claims.account);
    return (
      prior?.raw ??
      this.signClaimed(envelope.claims.id, verified.decoded, requestHash)
    );
  }
}

export class JsonFrameDecoder {
  private pending = Buffer.alloc(0);
  constructor(private max = 1024 * 1024) {}
  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > this.max && !this.pending.includes(10))
      throw Error("frame_too_large");
    const out: unknown[] = [];
    for (;;) {
      const i = this.pending.indexOf(10);
      if (i < 0) break;
      if (i > this.max) throw Error("frame_too_large");
      const line = this.pending.subarray(0, i);
      this.pending = this.pending.subarray(i + 1);
      if (!line.length) continue;
      try {
        out.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw Error("frame_json_invalid");
      }
    }
    return out;
  }
}
export type RpcCall = (method: string, params: unknown[]) => Promise<any>;
export async function broadcastSigned(
  store: SqliteReplayStore,
  id: string,
  raw: Hex,
  rpc: RpcCall,
) {
  const expected = keccak256(raw),
    hash = await rpc("eth_sendRawTransaction", [raw]);
  if (
    typeof hash !== "string" ||
    hash.toLowerCase() !== expected.toLowerCase()
  ) {
    await store.transition(
      id,
      "signed",
      "reconciliation",
      JSON.stringify({ expected, returned: hash }),
    );
    throw Error("broadcast_hash_mismatch");
  }
  if (
    !(await store.transition(
      id,
      "signed",
      "broadcast",
      JSON.stringify({ hash, raw }),
    ))
  )
    throw Error("broadcast_state_invalid");
  return hash as Hex;
}
export async function reconcileTransactions(
  store: SqliteReplayStore,
  rpc: RpcCall,
) {
  for (const row of store.list(["broadcast", "reconciliation"])) {
    let data: any;
    try {
      data = JSON.parse(row.data ?? "{}");
    } catch {
      continue;
    }
    const hash = data.hash ?? data.expected;
    if (!hash) continue;
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      await store.transition(
        row.id,
        row.state,
        receipt.status === "0x1" ? "confirmed" : "reverted",
        JSON.stringify({ hash, receipt }),
      );
      continue;
    }
    const tx = await rpc("eth_getTransactionByHash", [hash]);
    if (tx && row.state === "reconciliation")
      await store.transition(
        row.id,
        "reconciliation",
        "broadcast",
        JSON.stringify({ hash, raw: data.raw }),
      );
  }
}
