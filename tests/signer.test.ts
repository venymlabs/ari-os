import { afterEach, describe, it, expect } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import {
  createEncryptedKeystore,
  decodeTransaction,
  generateSecretKey,
  loadSignPolicy,
  parseSecretKey,
  SignerService,
  SqliteReplayStore,
  unlockKeystore,
} from "../src/signer/index.js";
import { posixPermissions } from "./helpers.js";
import {
  buildTransaction,
  cleanupTempDirs,
  COMPUTE_BUDGET_PROGRAM,
  createTestWallet,
  envelopeVerifier,
  lookupTable,
  pubkey,
  setComputeUnitLimit,
  setComputeUnitPrice,
  SYSTEM_PROGRAM,
  systemTransfer,
  tempDir,
  TOKEN_PROGRAM,
  transferChecked,
  writePolicy,
} from "./signer-fixtures.js";

afterEach(cleanupTempDirs);

const DESTINATION = pubkey(9);
const MINT = pubkey(5);

/** Verify an Ed25519 signature against the message the signer committed to. */
function signatureIsValid(signedWire: string, publicKey: string) {
  const decoded = decodeTransaction(signedWire),
    signature = decoded.signatures[0];
  if (!signature) return false;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(bs58.decode(publicKey)),
  ]);
  return ed25519Verify(
    null,
    Buffer.from(decoded.messageBytes),
    createPublicKey({ key: spki, format: "der", type: "spki" }),
    Buffer.from(bs58.decode(signature)),
  );
}

async function service(
  dir: string,
  overrides: Parameters<typeof writePolicy>[2] = {},
  wire = false,
) {
  const wallet = await createTestWallet(dir),
    account = await unlockKeystore(wallet.keystore, wallet.password),
    policy = await loadSignPolicy(
      await writePolicy(dir, wallet.publicKey, overrides),
    ),
    store = new SqliteReplayStore(join(dir, "replay.sqlite"));
  return {
    wallet,
    account,
    policy,
    store,
    service: new SignerService(
      account,
      store,
      policy,
      wire
        ? {
            verifier: envelopeVerifier,
            audience: "daemon",
            cluster: policy.cluster,
            blockHeight: async () => 10_000,
          }
        : undefined,
    ),
  };
}

describe("isolated signer keystore", () => {
  it("writes an envelope-encrypted mode-0600 keystore and rejects wrong passwords or tampering", async () => {
    const dir = tempDir("signer-"),
      path = join(dir, "wallet.json"),
      secret = generateSecretKey(),
      seed = Buffer.from(secret.subarray(0, 32)).toString("hex");
    const publicKey = await createEncryptedKeystore(
      path,
      secret,
      "correct horse",
    );
    expect(new PublicKey(publicKey).toBase58()).toBe(publicKey);
    if (posixPermissions) expect((await stat(path)).mode & 0o777).toBe(0o600);

    // The secret must not be recoverable from the file in any encoding.
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(seed);
    expect(text).not.toContain(bs58.encode(secret));
    const body = JSON.parse(text);
    expect(body).toMatchObject({ version: 2, curve: "ed25519", publicKey });
    expect(body.crypto.kdfparams).toEqual({ N: 32768, r: 8, p: 1, dkLen: 32 });

    const account = await unlockKeystore(path, "correct horse");
    expect(account.publicKey).toBe(publicKey);
    await expect(unlockKeystore(path, "wrong")).rejects.toThrow(
      "keystore_decryption_failed",
    );
    for (const field of ["wrappedDek", "secretKey"] as const) {
      const tampered = JSON.parse(text);
      const c = tampered.crypto[field].ciphertext;
      tampered.crypto[field].ciphertext = c.replace(
        /.$/,
        c.endsWith("0") ? "1" : "0",
      );
      await writeFile(path, JSON.stringify(tampered), { mode: 0o600 });
      await expect(unlockKeystore(path, "correct horse")).rejects.toThrow(
        "keystore_decryption_failed",
      );
    }
    secret.fill(0);
  });

  it("locks on demand and refuses to sign afterwards", async () => {
    const dir = tempDir("lock-"),
      wallet = await createTestWallet(dir),
      account = await unlockKeystore(wallet.keystore, wallet.password);
    expect(account.locked).toBe(false);
    expect(account.signMessage(Buffer.from("hello")).length).toBe(64);
    account.lock();
    expect(account.locked).toBe(true);
    expect(() => account.signMessage(Buffer.from("hello"))).toThrow(
      "keystore_locked",
    );
  });

  it("accepts only the real Solana secret-key encodings", async () => {
    const secret = generateSecretKey();
    expect(parseSecretKey(bs58.encode(secret))).toEqual(secret);
    expect(parseSecretKey(JSON.stringify([...secret]))).toEqual(secret);
    expect(parseSecretKey(bs58.encode(secret.subarray(0, 32)))).toEqual(secret);
    const forged = Uint8Array.from(secret);
    forged[63] = forged[63]! ^ 1;
    for (const bad of [
      "",
      "not base58 !!",
      "[1,2,3]",
      "[300]",
      bs58.encode(Buffer.alloc(48, 1)),
      bs58.encode(forged),
    ])
      expect(() => parseSecretKey(bad)).toThrow("secret_key_invalid");
  });
});

describe("isolated signer replay fence", () => {
  it("durably consumes once and fences state transitions across reopen", async () => {
    const path = join(tempDir("replay-"), "replay.sqlite");
    let a = new SqliteReplayStore(path);
    expect(await a.consume("id", 9999)).toBe(true);
    expect(await a.transition("id", "claimed", "signed", "data")).toBe(true);
    a.close();
    a = new SqliteReplayStore(path);
    expect(await a.consume("id", 9999)).toBe(false);
    expect(await a.transition("id", "claimed", "failed")).toBe(false);
    expect(await a.transition("id", "signed", "broadcast", "sent")).toBe(true);
    expect(a.get("id")?.state).toBe("broadcast");
    a.close();
  });

  it("makes claimed -> expired and claimed -> signed mutually exclusive", async () => {
    const store = new SqliteReplayStore(join(tempDir("fence-"), "r.sqlite"));
    await store.consume("id", 9999);
    expect(await store.transition("id", "claimed", "expired", "{}")).toBe(true);
    expect(await store.transition("id", "claimed", "signed", "{}")).toBe(false);
    expect(store.get("id")?.state).toBe("expired");
    store.close();
  });
});

describe("isolated signer service", () => {
  it("signs only exact authorized bytes and returns the durable result idempotently", async () => {
    const dir = tempDir("service-"),
      { wallet, service: svc, store, policy } = await service(dir);
    const tx = buildTransaction({
      payer: wallet.publicKey,
      instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1_000n)],
    });
    const signed = await svc.sign("auth-1", tx, wallet.publicKey);
    expect(signatureIsValid(signed.transaction, wallet.publicKey)).toBe(true);
    expect(signed.signature).toBe(
      decodeTransaction(signed.transaction).signatures[0],
    );
    store.close();

    // A restart must not produce a second signature for the same authorization.
    const reopened = new SqliteReplayStore(join(dir, "replay.sqlite")),
      account = await unlockKeystore(wallet.keystore, wallet.password),
      again = new SignerService(account, reopened, policy);
    expect(await again.sign("auth-1", tx, wallet.publicKey)).toEqual(signed);

    // Same authorization id, different bytes: refused, never re-signed.
    const other = buildTransaction({
      payer: wallet.publicKey,
      instructions: [systemTransfer(wallet.publicKey, DESTINATION, 2_000n)],
    });
    await expect(again.sign("auth-1", other, wallet.publicKey)).rejects.toThrow(
      "authorization_request_mismatch",
    );
    reopened.close();
  });

  it("rejects a fee payer that is not the signer's own account", async () => {
    const dir = tempDir("payer-"),
      { wallet, service: svc, store } = await service(dir);
    const foreign = pubkey(3),
      tx = buildTransaction({
        payer: foreign,
        instructions: [systemTransfer(foreign, DESTINATION, 1n)],
      });
    await expect(svc.sign("a", tx, foreign)).rejects.toThrow(
      "policy_fee_payer",
    );
    // Claiming the right fee payer over the wrong bytes fails too.
    await expect(svc.sign("b", tx, wallet.publicKey)).rejects.toThrow(
      "policy_fee_payer",
    );
    store.close();
  });

  it("rejects disallowed programs, unclassified instructions and over-cap spends", async () => {
    const dir = tempDir("policy-"),
      { wallet, service: svc, store } = await service(dir);
    const p = wallet.publicKey;
    const cases: [string, string][] = [
      [
        "policy_program",
        buildTransaction({
          payer: p,
          instructions: [
            transferChecked({
              source: pubkey(11),
              mint: MINT,
              destination: pubkey(12),
              owner: p,
              amount: 1n,
            }),
          ],
        }),
      ],
      [
        "policy_spend_cap",
        buildTransaction({
          payer: p,
          instructions: [systemTransfer(p, DESTINATION, 1_000_001n)],
        }),
      ],
      [
        // Two legs, each under the cap, together above it.
        "policy_spend_cap",
        buildTransaction({
          payer: p,
          instructions: [
            systemTransfer(p, DESTINATION, 600_000n),
            systemTransfer(p, pubkey(13), 600_000n),
          ],
        }),
      ],
      [
        "policy_compute_unit_price",
        buildTransaction({
          payer: p,
          instructions: [
            setComputeUnitPrice(500_000n),
            systemTransfer(p, DESTINATION, 1n),
          ],
        }),
      ],
      [
        "policy_compute_units",
        buildTransaction({
          payer: p,
          instructions: [
            setComputeUnitLimit(900_000),
            systemTransfer(p, DESTINATION, 1n),
          ],
        }),
      ],
      [
        "policy_priority_fee",
        buildTransaction({
          payer: p,
          instructions: [
            setComputeUnitLimit(400_000),
            setComputeUnitPrice(50_000n),
            systemTransfer(p, DESTINATION, 1n),
          ],
        }),
      ],
      [
        // A second compute-budget instruction must not be quietly ignored.
        "policy_compute_units",
        buildTransaction({
          payer: p,
          instructions: [
            setComputeUnitLimit(1_000),
            setComputeUnitLimit(400_000),
            systemTransfer(p, DESTINATION, 1n),
          ],
        }),
      ],
      [
        "policy_compute_unit_price",
        buildTransaction({
          payer: p,
          instructions: [
            setComputeUnitPrice(1n),
            setComputeUnitPrice(1n),
            systemTransfer(p, DESTINATION, 1n),
          ],
        }),
      ],
      [
        // Data too short to hold the amount the spend rule points at.
        "policy_spend_unreadable",
        buildTransaction({
          payer: p,
          instructions: [
            {
              ...systemTransfer(p, DESTINATION, 1n),
              data: Buffer.from("02000000", "hex"),
            } as never,
          ],
        }),
      ],
    ];
    for (const [error, tx] of cases)
      await expect(
        svc.sign(crypto.randomUUID(), tx, wallet.publicKey),
      ).rejects.toThrow(error);
    store.close();
  });

  it("refuses an allowed program invoked with an unlisted discriminator", async () => {
    const dir = tempDir("disc-"),
      { wallet, service: svc, store } = await service(dir);
    // System `allocate` (tag 8) — the program is allowed, this instruction is not.
    const data = Buffer.alloc(12);
    data.writeUInt32LE(8, 0);
    const tx = buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        {
          ...systemTransfer(wallet.publicKey, DESTINATION, 1n),
          data,
        } as never,
      ],
    });
    await expect(svc.sign("a", tx, wallet.publicKey)).rejects.toThrow(
      "policy_instruction",
    );
    store.close();
  });

  it("verifies the mint an instruction actually names before applying its cap", async () => {
    const dir = tempDir("mint-"),
      overrides = {
        programs: [
          {
            programId: TOKEN_PROGRAM,
            discriminator: "0c",
            effect: "spend",
            spend: {
              asset: MINT,
              amountOffset: 1,
              amountEncoding: "u64le",
              mintAccountIndex: 1,
            },
          },
        ],
        caps: { [MINT]: "100" },
      },
      { wallet, service: svc, store } = await service(dir, overrides);
    const ok = buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        transferChecked({
          source: pubkey(11),
          mint: MINT,
          destination: pubkey(12),
          owner: wallet.publicKey,
          amount: 100n,
        }),
      ],
    });
    expect(
      signatureIsValid(
        (await svc.sign("ok", ok, wallet.publicKey)).transaction,
        wallet.publicKey,
      ),
    ).toBe(true);
    const wrongMint = buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        transferChecked({
          source: pubkey(11),
          mint: pubkey(6),
          destination: pubkey(12),
          owner: wallet.publicKey,
          amount: 1n,
        }),
      ],
    });
    await expect(svc.sign("bad", wrongMint, wallet.publicKey)).rejects.toThrow(
      "policy_spend_mint_mismatch",
    );
    store.close();
  });

  it("refuses address lookup tables it cannot independently resolve", async () => {
    const dir = tempDir("alt-"),
      { wallet, service: svc, store } = await service(dir);
    const table = pubkey(20),
      tx = buildTransaction({
        payer: wallet.publicKey,
        instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1n)],
        lookupTables: [lookupTable(table, [DESTINATION])],
      });
    expect(decodeTransaction(tx).addressTableLookups).toHaveLength(1);
    await expect(svc.sign("a", tx, wallet.publicKey)).rejects.toThrow(
      "policy_address_table_lookup",
    );
    store.close();
  });

  it("caps a looked-up asset only when the mint is actually verifiable", async () => {
    const dir = tempDir("alt-mint-"),
      table = pubkey(21),
      overrides = {
        programs: [
          {
            programId: TOKEN_PROGRAM,
            discriminator: "0c",
            effect: "spend",
            spend: {
              asset: MINT,
              amountOffset: 1,
              amountEncoding: "u64le",
              mintAccountIndex: 1,
            },
          },
        ],
        caps: { [MINT]: "100" },
        addressLookupTables: [table],
      },
      { wallet, service: svc, store } = await service(dir, overrides);
    const tx = buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        transferChecked({
          source: pubkey(11),
          mint: MINT,
          destination: pubkey(12),
          owner: wallet.publicKey,
          amount: 1n,
        }),
      ],
      lookupTables: [lookupTable(table, [MINT, pubkey(11), pubkey(12)])],
    });
    // The mint now resolves through the table, so the signer cannot confirm it.
    expect(decodeTransaction(tx).instructions[0]!.accounts.includes(null)).toBe(
      true,
    );
    await expect(svc.sign("a", tx, wallet.publicKey)).rejects.toThrow(
      "policy_spend_mint_mismatch",
    );
    store.close();
  });

  it("rejects malformed, non-canonical and multi-signer transactions", async () => {
    const dir = tempDir("malformed-"),
      { wallet, service: svc, store } = await service(dir);
    const good = buildTransaction({
      payer: wallet.publicKey,
      instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1n)],
    });
    for (const [error, tx] of [
      ["transaction_invalid", ""],
      ["transaction_invalid", Buffer.from("nonsense").toString("base64")],
      ["transaction_encoding_invalid", `${good}  `],
      ["transaction_invalid", good.slice(0, good.length - 8)],
    ] as [string, string][])
      await expect(
        svc.sign(crypto.randomUUID(), tx, wallet.publicKey),
      ).rejects.toThrow(error);

    // Trailing bytes after a valid transaction must not decode as that transaction.
    const padded = Buffer.concat([
      Buffer.from(good, "base64"),
      Buffer.from([0]),
    ]).toString("base64");
    await expect(
      svc.sign(crypto.randomUUID(), padded, wallet.publicKey),
    ).rejects.toThrow(/transaction_/);

    // A second required signer exceeds maxRequiredSignatures = 1.
    const cosigned = buildTransaction({
      payer: wallet.publicKey,
      instructions: [
        {
          ...systemTransfer(wallet.publicKey, DESTINATION, 1n),
          keys: [
            {
              pubkey: new PublicKey(wallet.publicKey),
              isSigner: true,
              isWritable: true,
            },
            {
              pubkey: new PublicKey(pubkey(4)),
              isSigner: true,
              isWritable: true,
            },
          ],
        } as never,
      ],
    });
    expect(decodeTransaction(cosigned).numRequiredSignatures).toBe(2);
    await expect(svc.sign("co", cosigned, wallet.publicKey)).rejects.toThrow(
      "policy_signers",
    );
    store.close();
  });

  it("refuses an instruction whose program id hides behind a lookup table", async () => {
    // Hand-assemble a v0 message whose only instruction points its program id
    // at a looked-up address. The signer must refuse rather than assume.
    const dir = tempDir("hidden-"),
      { wallet, service: svc, store } = await service(dir),
      payer = Buffer.from(bs58.decode(wallet.publicKey)),
      table = Buffer.from(bs58.decode(pubkey(20))),
      bytes = Buffer.concat([
        Buffer.from([0]), // signature count (unsigned)
        Buffer.from([0x80]), // v0 prefix
        Buffer.from([1, 0, 0]), // header
        Buffer.from([1]),
        payer, // one static key
        Buffer.alloc(32, 7), // recent blockhash
        Buffer.from([1]), // one instruction
        Buffer.from([1]), // programIdIndex = 1 -> looked-up address
        Buffer.from([0]), // no accounts
        Buffer.from([0]), // no data
        Buffer.from([1]), // one address table lookup
        table,
        Buffer.from([0]), // no writable indexes
        Buffer.from([1, 0]), // one readonly index
      ]).toString("base64");
    await expect(svc.sign("a", bytes, wallet.publicKey)).rejects.toThrow(
      /transaction_program_unresolvable|transaction_/,
    );
    store.close();
  });

  it("never consumes the authorization when policy validation fails", async () => {
    const dir = tempDir("atomic-"),
      { wallet, service: svc, store } = await service(dir);
    const over = buildTransaction({
        payer: wallet.publicKey,
        instructions: [
          systemTransfer(wallet.publicKey, DESTINATION, 2_000_000n),
        ],
      }),
      ok = buildTransaction({
        payer: wallet.publicKey,
        instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1n)],
      });
    await expect(svc.sign("same", over, wallet.publicKey)).rejects.toThrow(
      "policy_spend_cap",
    );
    expect(store.get("same")).toBeUndefined();
    expect(
      signatureIsValid(
        (await svc.sign("same", ok, wallet.publicKey)).transaction,
        wallet.publicKey,
      ),
    ).toBe(true);
    store.close();
  });

  it("treats blockhash expiry as terminal and never re-signs", async () => {
    const dir = tempDir("expiry-"),
      { wallet, service: svc, store } = await service(dir, {}, true);
    const tx = buildTransaction({
      payer: wallet.publicKey,
      instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1n)],
    });
    // blockHeight() reports 10_000; the blockhash died at 9_000.
    await expect(svc.sign("dead", tx, wallet.publicKey, 9_000)).rejects.toThrow(
      "blockhash_expired",
    );
    expect(store.get("dead")?.state).toBe("expired");
    // Terminal: neither a retry of the same bytes nor a claim that the
    // blockhash is still alive can revive it.
    await expect(svc.sign("dead", tx, wallet.publicKey, 9_000)).rejects.toThrow(
      "authorization_expired",
    );
    await expect(
      svc.sign("dead", tx, wallet.publicKey, 99_000),
    ).rejects.toThrow("authorization_expired");
    expect(svc.result("dead", decodeTransaction(tx).messageHash)).toEqual({
      state: "expired",
    });
    // A live blockhash under a fresh authorization still signs.
    const fresh = await svc.sign("alive", tx, wallet.publicKey, 99_000);
    expect(signatureIsValid(fresh.transaction, wallet.publicKey)).toBe(true);
    store.close();
  });

  it("preserves an existing co-signer signature and only fills its own slot", async () => {
    const dir = tempDir("cosign-"),
      {
        wallet,
        service: svc,
        store,
      } = await service(dir, {
        maxRequiredSignatures: 2,
      });
    const cosigner = pubkey(4),
      tx = buildTransaction({
        payer: wallet.publicKey,
        instructions: [
          {
            ...systemTransfer(wallet.publicKey, DESTINATION, 1n),
            keys: [
              {
                pubkey: new PublicKey(wallet.publicKey),
                isSigner: true,
                isWritable: true,
              },
              {
                pubkey: new PublicKey(cosigner),
                isSigner: true,
                isWritable: true,
              },
            ],
          } as never,
        ],
      });
    const partial = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(tx, "base64")),
    );
    partial.signatures[1] = Uint8Array.from(Buffer.alloc(64, 3));
    const withCosigner = Buffer.from(partial.serialize()).toString("base64");
    const signed = await svc.sign("a", withCosigner, wallet.publicKey);
    const out = decodeTransaction(signed.transaction);
    expect(out.signatures[1]).toBe(bs58.encode(Buffer.alloc(64, 3)));
    expect(signatureIsValid(signed.transaction, wallet.publicKey)).toBe(true);
    store.close();
  });
});

describe("signer policy file", () => {
  it("rejects a policy whose instructions are not classified", async () => {
    const dir = tempDir("unclassified-"),
      wallet = await createTestWallet(dir);
    for (const programs of [
      [{ programId: SYSTEM_PROGRAM, discriminator: "02000000" }],
      [
        {
          programId: SYSTEM_PROGRAM,
          discriminator: "02000000",
          effect: "spend",
        },
      ],
      [{ programId: SYSTEM_PROGRAM, discriminator: "02", effect: "fee" }],
      [
        {
          programId: COMPUTE_BUDGET_PROGRAM,
          discriminator: "07",
          effect: "fee",
        },
      ],
      [{ programId: "not-a-key", discriminator: "02", effect: "none" }],
      [{ programId: SYSTEM_PROGRAM, discriminator: "zz", effect: "none" }],
    ]) {
      const path = await writePolicy(
        dir,
        wallet.publicKey,
        { programs },
        `p-${Math.random()}.json`,
      );
      await expect(loadSignPolicy(path)).rejects.toThrow(/policy_/);
    }
  });

  it("rejects duplicate program rules and unknown cap assets", async () => {
    const dir = tempDir("dupe-"),
      wallet = await createTestWallet(dir);
    const dupe = await writePolicy(
      dir,
      wallet.publicKey,
      {
        programs: [
          { programId: SYSTEM_PROGRAM, discriminator: "02", effect: "none" },
          { programId: SYSTEM_PROGRAM, discriminator: "02", effect: "none" },
        ],
      },
      "dupe.json",
    );
    await expect(loadSignPolicy(dupe)).rejects.toThrow(
      "policy_program_duplicate",
    );
    const badCap = await writePolicy(
      dir,
      wallet.publicKey,
      { caps: { "not-a-mint": "1" } },
      "cap.json",
    );
    await expect(loadSignPolicy(badCap)).rejects.toThrow("policy_cap_invalid");
  });

  it("refuses to cap an asset it was never given a limit for", async () => {
    const dir = tempDir("nocap-"),
      { wallet, service: svc, store } = await service(dir, { caps: {} });
    const tx = buildTransaction({
      payer: wallet.publicKey,
      instructions: [systemTransfer(wallet.publicKey, DESTINATION, 1n)],
    });
    await expect(svc.sign("a", tx, wallet.publicKey)).rejects.toThrow(
      "policy_cap_missing",
    );
    store.close();
  });
});
