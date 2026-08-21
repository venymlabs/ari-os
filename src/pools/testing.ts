/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "../chains/solana/spl.js";
import type {
  ExecuteResult,
  MintInfo,
  ToolContext,
  TradeGateway,
  TradeIntent,
} from "../kernel/contracts.js";
import type { AccountSnapshot, Blockhash, ChainReader } from "./chain.js";
import {
  BONDING_CURVE_DISCRIMINATOR,
  GLOBAL_DISCRIMINATOR,
  PUMP_TOTAL_SUPPLY,
} from "./pumpfun/constants.js";
import type {
  AddLiquidityArgs,
  DlmmPoolHandle,
  DlmmSdk,
  RemoveLiquidityArgs,
  SdkPoolState,
  SdkPosition,
  SdkTxParts,
} from "./meteora/sdk-port.js";

/**
 * Test doubles.
 *
 * Shipped as part of the package rather than hidden in a `__tests__` folder so the
 * engine's own selfcheck can drive this package end-to-end with **zero network and
 * zero keys** — the same property the kernel selfcheck has. Nothing here is used
 * by production code paths.
 */

export const TEST_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

// ── account fixtures ─────────────────────────────────────────────────────────

export interface CurveAccountFields {
  virtualTokenReserves?: bigint;
  virtualSolReserves?: bigint;
  realTokenReserves?: bigint;
  realSolReserves?: bigint;
  tokenTotalSupply?: bigint;
  complete?: boolean;
  creator?: string;
  isMayhemMode?: boolean;
  isCashbackCoin?: boolean;
  quoteMint?: string;
  /** 49 (legacy), 81 (creator added), or 115 (current). */
  length?: number;
}

/** A synthetic `BondingCurve` account at any of its three historical lengths. */
export function curveAccountBuffer(f: CurveAccountFields = {}): Uint8Array {
  const len = f.length ?? 115;
  const buf = Buffer.alloc(len);
  Buffer.from(BONDING_CURVE_DISCRIMINATOR).copy(buf, 0);
  buf.writeBigUInt64LE(f.virtualTokenReserves ?? 536_500_000_000_000n, 8);
  buf.writeBigUInt64LE(f.virtualSolReserves ?? 60_000_000_000n, 16);
  buf.writeBigUInt64LE(f.realTokenReserves ?? 256_600_000_000_000n, 24);
  buf.writeBigUInt64LE(f.realSolReserves ?? 30_000_000_000n, 32);
  buf.writeBigUInt64LE(f.tokenTotalSupply ?? PUMP_TOTAL_SUPPLY, 40);
  buf.writeUInt8(f.complete ? 1 : 0, 48);
  if (len >= 81)
    new PublicKey(f.creator ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
      .toBuffer()
      .copy(buf, 49);
  if (len >= 82) buf.writeUInt8(f.isMayhemMode ? 1 : 0, 81);
  if (len >= 83) buf.writeUInt8(f.isCashbackCoin ? 1 : 0, 82);
  if (len >= 115)
    new PublicKey(f.quoteMint ?? PublicKey.default.toBase58())
      .toBuffer()
      .copy(buf, 83);
  return Uint8Array.from(buf);
}

export interface GlobalAccountFields {
  authority?: string;
  feeRecipient?: string;
  feeBasisPoints?: bigint;
  creatorFeeBasisPoints?: bigint;
  initialRealTokenReserves?: bigint;
  feeRecipients?: readonly string[];
}

export function globalAccountBuffer(f: GlobalAccountFields = {}): Uint8Array {
  const buf = Buffer.alloc(386);
  Buffer.from(GLOBAL_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt8(1, 8);
  new PublicKey(f.authority ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
    .toBuffer()
    .copy(buf, 9);
  const primary =
    f.feeRecipient ?? "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";
  new PublicKey(primary).toBuffer().copy(buf, 41);
  buf.writeBigUInt64LE(1_073_000_000_000_000n, 73);
  buf.writeBigUInt64LE(30_000_000_000n, 81);
  buf.writeBigUInt64LE(f.initialRealTokenReserves ?? 793_100_000_000_000n, 89);
  buf.writeBigUInt64LE(PUMP_TOTAL_SUPPLY, 97);
  buf.writeBigUInt64LE(f.feeBasisPoints ?? 95n, 105);
  buf.writeBigUInt64LE(f.creatorFeeBasisPoints ?? 5n, 154);
  (f.feeRecipients ?? [primary]).forEach((r, i) => {
    if (162 + i * 32 + 32 <= buf.length)
      new PublicKey(r).toBuffer().copy(buf, 162 + i * 32);
  });
  return Uint8Array.from(buf);
}

/** An SPL mint account: `decimals` is the single byte at offset 44. */
export function mintAccountBuffer(decimals = 6): Uint8Array {
  const buf = Buffer.alloc(82);
  buf.writeUInt8(decimals, 44);
  return Uint8Array.from(buf);
}

// ── ChainReader ──────────────────────────────────────────────────────────────

export class FakeChainReader implements ChainReader {
  accounts = new Map<string, AccountSnapshot>();
  balances = new Map<string, bigint>();
  blockhash: Blockhash = {
    blockhash: TEST_BLOCKHASH,
    lastValidBlockHeight: 1_000,
  };
  calls: string[] = [];

  set(
    address: string,
    data: Uint8Array,
    owner = TOKEN_PROGRAM_ID.toBase58(),
    lamports = 1_000_000n,
  ): this {
    this.accounts.set(address, { address, owner, data, lamports });
    return this;
  }

  setBalance(owner: string, mint: string, amount: bigint): this {
    this.balances.set(`${owner}:${mint}`, amount);
    return this;
  }

  async getAccount(address: string): Promise<AccountSnapshot | null> {
    this.calls.push(`getAccount:${address}`);
    return this.accounts.get(address) ?? null;
  }

  async getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (AccountSnapshot | null)[]> {
    this.calls.push(`getMultipleAccounts:${addresses.length}`);
    return addresses.map((a) => this.accounts.get(a) ?? null);
  }

  async getLatestBlockhash(): Promise<Blockhash> {
    return this.blockhash;
  }

  async getTokenBalance(owner: string, mint: string): Promise<bigint> {
    return this.balances.get(`${owner}:${mint}`) ?? 0n;
  }
}

// ── DLMM SDK ─────────────────────────────────────────────────────────────────

export interface FakePoolOptions {
  readonly state: SdkPoolState;
  readonly positions?: readonly SdkPosition[];
  /** Force `buildAddLiquidity` to demand a co-signer, as `initialize_position` does. */
  readonly requireExtraSignerOnNewPosition?: boolean | undefined;
}

/** One `TransactionInstruction`-shaped memo, enough for `compileToV0Message`. */
function memoIx(payer: string) {
  return {
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [{ pubkey: new PublicKey(payer), isSigner: true, isWritable: true }],
    data: Buffer.from("fake"),
  } as unknown as import("@solana/web3.js").TransactionInstruction;
}

export class FakeDlmmPool implements DlmmPoolHandle {
  #opts: FakePoolOptions;
  calls: string[] = [];

  constructor(opts: FakePoolOptions) {
    this.#opts = opts;
  }

  get state(): SdkPoolState {
    return this.#opts.state;
  }

  async refresh(): Promise<SdkPoolState> {
    return this.#opts.state;
  }

  async positionsOf(owner: string): Promise<readonly SdkPosition[]> {
    this.calls.push(`positionsOf:${owner}`);
    return (this.#opts.positions ?? []).filter((p) => p.owner === owner);
  }

  async buildAddLiquidity(args: AddLiquidityArgs): Promise<SdkTxParts> {
    this.calls.push(`add:${args.lowerBinId}..${args.upperBinId}:${args.shape}`);
    const isNew = args.positionAddress === undefined;
    return {
      instructions: [memoIx(args.owner)],
      extraSigners:
        isNew && this.#opts.requireExtraSignerOnNewPosition !== false
          ? [PublicKey.unique().toBase58()]
          : [],
      description: isNew
        ? "open new position"
        : `add to ${args.positionAddress}`,
    };
  }

  async buildRemoveLiquidity(args: RemoveLiquidityArgs): Promise<SdkTxParts> {
    this.calls.push(`remove:${args.bpsToRemove}:${args.claimAndClose}`);
    return {
      instructions: [memoIx(args.owner)],
      extraSigners: [],
      description: `remove ${args.bpsToRemove}bps`,
    };
  }

  async buildClaimFees(args: {
    readonly owner: string;
    readonly positionAddress: string;
  }): Promise<SdkTxParts> {
    this.calls.push(`claim:${args.positionAddress}`);
    return {
      instructions: [memoIx(args.owner)],
      extraSigners: [],
      description: "claim fees",
    };
  }
}

export class FakeDlmmSdk implements DlmmSdk {
  #pools = new Map<string, FakeDlmmPool>();

  addPool(opts: FakePoolOptions): FakeDlmmPool {
    const pool = new FakeDlmmPool(opts);
    this.#pools.set(opts.state.address, pool);
    return pool;
  }

  async openPool(poolAddress: string): Promise<DlmmPoolHandle> {
    const pool = this.#pools.get(poolAddress);
    if (!pool) throw new Error(`fake sdk has no pool ${poolAddress}`);
    return pool;
  }

  async positionsOfUser(
    owner: string,
  ): Promise<readonly { pool: string; position: SdkPosition }[]> {
    const out: { pool: string; position: SdkPosition }[] = [];
    for (const [address, pool] of this.#pools) {
      for (const p of await pool.positionsOf(owner))
        out.push({ pool: address, position: p });
    }
    return out;
  }
}

// ── ToolContext ──────────────────────────────────────────────────────────────

export interface RecordedExecution {
  readonly intent: TradeIntent;
  readonly idempotencyKey: string;
  readonly confirmedByUser: boolean;
}

/** A gateway that records intents and confirms them. It never signs anything. */
export class RecordingGateway implements TradeGateway {
  executions: RecordedExecution[] = [];
  result: Partial<ExecuteResult> = {};

  async execute(
    intent: TradeIntent,
    opts: { idempotencyKey: string; confirmedByUser?: boolean },
  ): Promise<ExecuteResult> {
    this.executions.push({
      intent,
      idempotencyKey: opts.idempotencyKey,
      confirmedByUser: opts.confirmedByUser ?? false,
    });
    return {
      tradeId: "trd_fake",
      state: "confirmed",
      signature: "sig_fake",
      simulated: false,
      summary: intent.summary,
      fill: undefined,
      error: undefined,
      ...this.result,
    };
  }
}

export interface FakeToolContextOptions {
  readonly ownerWallet?: string;
  readonly mints?: Readonly<Record<string, MintInfo>>;
  readonly gateway?: TradeGateway;
}

const notImplemented = (what: string) => (): never => {
  throw new Error(`fake ToolContext: ${what} is not wired for this test`);
};

export function cleanMintInfo(mint: string, decimals = 6): MintInfo {
  return {
    mint,
    decimals,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    isToken2022: false,
    freezeAuthority: null,
    mintAuthority: null,
  };
}

/** A `ToolContext` with only the seams the pools tools actually touch. */
export function fakeToolContext(
  opts: FakeToolContextOptions = {},
): ToolContext & { gateway: RecordingGateway } {
  const gateway = (opts.gateway as RecordingGateway) ?? new RecordingGateway();
  const mints = opts.mints ?? {};
  return {
    ownerWallet:
      opts.ownerWallet ?? "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    rpcUrl: "http://fake",
    services: {
      solana: {
        getSolLamports: notImplemented("getSolLamports"),
        getTokenHoldings: notImplemented("getTokenHoldings"),
        getMintInfo: async (mint: string) => {
          const info = mints[mint];
          if (!info)
            throw new Error(`fake ToolContext: no mint record for ${mint}`);
          return info;
        },
      },
      jupiter: {
        quote: notImplemented("jupiter.quote"),
        buildSwap: notImplemented("jupiter.buildSwap"),
      },
    },
    gateway,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    signal: undefined,
  };
}
