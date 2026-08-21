import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Keypair,
  type Connection,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfRpcBroadcaster } from "../src/chains/solana/broadcaster.js";
import { JupiterClient } from "../src/chains/solana/jupiter.js";
import {
  generateWallet,
  LocalWallet,
  storeWallet,
} from "../src/chains/solana/local-wallet.js";
import { SolanaRpc } from "../src/chains/solana/rpc.js";
import { WSOL_MINT } from "../src/kernel/money.js";
import { Keystore } from "../src/vault/index.js";
import { removeDir } from "./helpers.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "solana-adapters-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  dirs.splice(0).forEach((d) => removeDir(d));
  vi.unstubAllGlobals();
});

const ZERO_BLOCKHASH = "11111111111111111111111111111111";

function unsignedTransfer(payer: Keypair): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: ZERO_BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString(
    "base64",
  );
}

const fakeConnection = (over: Partial<Connection>): Connection =>
  over as unknown as Connection;

describe("LocalWallet — keystore-backed WalletProvider", () => {
  it("signs a v0 transaction and returns the canonical wire + base58 signature", async () => {
    const ks = Keystore.init(join(temp(), "keystore.json"), "passphrase-1234");
    const generated = generateWallet();
    const payer = Keypair.fromSecretKey(Uint8Array.from(generated.secretKey));
    storeWallet(ks, generated.secretKey);

    const wallet = LocalWallet.fromKeystore(ks);
    expect(wallet.pubkey).toBe(generated.pubkey);

    const unsigned = unsignedTransfer(payer);
    const signed = await wallet.sign(unsigned);

    const decoded = VersionedTransaction.deserialize(
      Buffer.from(signed.wireBase64, "base64"),
    );
    const signature = decoded.signatures[0];
    expect(signature).toBeDefined();
    expect(bs58.encode(signature!)).toBe(signed.signature);
    expect(signature!.some((b) => b !== 0)).toBe(true);
  });

  it("never keeps key material on the provider after signing", async () => {
    const ks = Keystore.init(join(temp(), "keystore.json"), "passphrase-1234");
    const generated = generateWallet();
    storeWallet(ks, generated.secretKey);
    const wallet = LocalWallet.fromKeystore(ks);
    // storeWallet zeroes the source buffer it was handed a copy of.
    expect(JSON.stringify(wallet)).not.toContain("secretKey");
    expect(Object.keys(wallet)).toEqual(["pubkey"]);
    ks.lock();
    await expect(
      wallet.sign(unsignedTransfer(Keypair.generate())),
    ).rejects.toThrow(/locked/);
  });
});

describe("SelfRpcBroadcaster", () => {
  it("submits the raw wire with preflight skipped (the kernel already simulated)", async () => {
    const sendRawTransaction = vi.fn(async () => "sig-1");
    const broadcaster = new SelfRpcBroadcaster(
      fakeConnection({ sendRawTransaction } as unknown as Partial<Connection>),
    );
    const wireBase64 = Buffer.from("wire-bytes").toString("base64");
    expect(
      await broadcaster.broadcast({ wireBase64, signature: "s" }, undefined),
    ).toEqual({ signature: "sig-1" });
    const [raw, opts] = sendRawTransaction.mock.calls[0] as unknown as [
      Buffer,
      { skipPreflight: boolean },
    ];
    expect(raw.toString()).toBe("wire-bytes");
    expect(opts.skipPreflight).toBe(true);
  });
});

describe("SolanaRpc — read ports", () => {
  it("resolves the WSOL sentinel without an RPC round-trip", async () => {
    const rpc = new SolanaRpc(fakeConnection({}));
    expect(await rpc.getMintInfo(WSOL_MINT)).toMatchObject({
      decimals: 9,
      isToken2022: false,
    });
  });

  it("reads native SOL through the WSOL sentinel mint", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const rpc = new SolanaRpc(
      fakeConnection({ getBalance: vi.fn(async () => 1_234n as never) }),
    );
    expect(await rpc.readBalance(owner, WSOL_MINT)).toBe(1_234n);
  });

  it("reports a confirmed signature", async () => {
    const rpc = new SolanaRpc(
      fakeConnection({
        getSignatureStatuses: vi.fn(async () => ({
          value: [{ err: null, slot: 7, confirmationStatus: "confirmed" }],
        })) as never,
        getBlockHeight: vi.fn(async () => 1) as never,
      }),
    );
    expect(await rpc.confirm("sig", 100)).toMatchObject({
      status: "confirmed",
      slot: 7,
    });
  });

  it("reports a failed signature rather than retrying it", async () => {
    const rpc = new SolanaRpc(
      fakeConnection({
        getSignatureStatuses: vi.fn(async () => ({
          value: [{ err: { InstructionError: [0, "Custom"] }, slot: 9 }],
        })) as never,
        getBlockHeight: vi.fn(async () => 1) as never,
      }),
    );
    expect((await rpc.confirm("sig", 100)).status).toBe("failed");
  });

  it("declares expiry once the block height passes lastValidBlockHeight", async () => {
    const getSignatureStatuses = vi.fn(async () => ({ value: [null] }));
    const rpc = new SolanaRpc(
      fakeConnection({
        getSignatureStatuses: getSignatureStatuses as never,
        getBlockHeight: vi.fn(async () => 101) as never,
      }),
    );
    expect(await rpc.confirm("sig", 100)).toEqual({
      status: "expired",
      slot: undefined,
      err: undefined,
    });
    // Expiry is terminal: it resolves on the first poll, it does not keep retrying.
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("simulates without replacing the blockhash the transaction committed to", async () => {
    const simulateTransaction = vi.fn(async () => ({
      value: { err: null, logs: ["ok"], unitsConsumed: 42 },
    }));
    const rpc = new SolanaRpc(
      fakeConnection({ simulateTransaction: simulateTransaction as never }),
    );
    const outcome = await rpc.simulate(unsignedTransfer(Keypair.generate()));
    expect(outcome).toMatchObject({ ok: true, unitsConsumed: 42 });
    const opts = (
      simulateTransaction.mock.calls as unknown as unknown[][]
    )[0]?.[1] as {
      replaceRecentBlockhash: boolean;
      sigVerify: boolean;
    };
    expect(opts.replaceRecentBlockhash).toBe(false);
    expect(opts.sigVerify).toBe(false);
  });
});

describe("JupiterClient", () => {
  const quoteJson = {
    inAmount: "500000000",
    outAmount: "1000000",
    otherAmountThreshold: "995000",
    priceImpactPct: "0.12",
    slippageBps: 50,
    contextSlot: 321,
    routePlan: [
      { swapInfo: { label: "Raydium" } },
      { swapInfo: { label: "Orca" } },
    ],
  };

  it("normalizes a quote into bigint base units and a readable route label", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(quoteJson)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const quote = await new JupiterClient().quote({
      inputMint: WSOL_MINT,
      outputMint: "Bonk",
      amount: 500_000_000n,
      slippageBps: 50,
    });
    expect(quote).toMatchObject({
      inAmount: 500_000_000n,
      outAmount: 1_000_000n,
      otherAmountThreshold: 995_000n,
      routeLabel: "Raydium → Orca",
      contextSlot: 321,
    });
    const url = String(
      (fetchMock.mock.calls as unknown as unknown[][])[0]?.[0],
    );
    expect(url).toContain("lite-api.jup.ag/swap/v1/quote");
    expect(url).toContain("amount=500000000");
    expect(url).toContain("restrictIntermediateTokens=true");
  });

  it("uses the pro base and the api-key header when a key is configured", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(quoteJson)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new JupiterClient({ apiKey: "secret" }).quote({
      inputMint: WSOL_MINT,
      outputMint: "Bonk",
      amount: 1n,
      slippageBps: 50,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(String(url)).toContain("https://api.jup.ag/");
    expect(init.headers["x-api-key"]).toBe("secret");
  });

  it("surfaces the blockhash lifecycle the kernel will own", async () => {
    const swapTransaction = unsignedTransfer(Keypair.generate());
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              swapTransaction,
              lastValidBlockHeight: 4242,
              prioritizationFeeLamports: 90_000,
            }),
          ),
      ),
    );
    const build = await new JupiterClient().buildSwap({
      quote: { raw: quoteJson } as never,
      userPublicKey: Keypair.generate().publicKey.toBase58(),
      priorityFeeLamports: 100_000,
    });
    expect(build).toMatchObject({
      swapTransactionB64: swapTransaction,
      lastValidBlockHeight: 4242,
      prioritizationFeeLamports: 90_000,
      recentBlockhash: ZERO_BLOCKHASH,
    });
  });

  it("throws with the upstream status rather than returning a synthetic empty quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    await expect(
      new JupiterClient().quote({
        inputMint: WSOL_MINT,
        outputMint: "Bonk",
        amount: 1n,
        slippageBps: 50,
      }),
    ).rejects.toThrow(/429/);
  });
});
