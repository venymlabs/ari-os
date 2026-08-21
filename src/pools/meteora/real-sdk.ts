/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Connection,
  PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { PoolGuardError } from "../errors.js";
import type { LiquidityShape } from "../types.js";
import {
  type AddLiquidityArgs,
  DLMM_PACKAGE,
  type DlmmPoolHandle,
  type DlmmSdk,
  loadDlmmModule,
  type RemoveLiquidityArgs,
  type SdkPoolState,
  type SdkPosition,
  type SdkTxParts,
  STRATEGY_NAME,
} from "./sdk-port.js";

/**
 * `DlmmSdk` implemented over the real `@meteora-ag/dlmm` package.
 *
 * ⚠ **Unverified against a live pool.** This workspace has no funded wallet and no
 * paid RPC, and the SDK is not in the lockfile, so this adapter has been written
 * from the published API surface and reviewed — not executed. Everything above it
 * (bin maths, guards, the rebalance decision, intent assembly, the pump.fun path)
 * is exercised by tests against the port, so a mismatch here is contained to this
 * one file. Treat the first live run as a smoke test, on devnet, with dust.
 *
 * Defensive by construction: every value pulled out of the SDK is narrowed and
 * range-checked before it becomes a domain object, because a silently-`undefined`
 * `activeId` would otherwise turn into a position centred on bin 0.
 */

type Bnish = { toString(): string };

function bnToBigInt(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string") {
    const cleaned = v.includes(".") ? (v.split(".")[0] as string) : v;
    if (/^-?\d+$/.test(cleaned)) return BigInt(cleaned);
  }
  if (v && typeof (v as Bnish).toString === "function") {
    const s = (v as Bnish).toString();
    const cleaned = s.includes(".") ? (s.split(".")[0] as string) : s;
    if (/^-?\d+$/.test(cleaned)) return BigInt(cleaned);
  }
  throw new PoolGuardError(
    "POOL_VENUE_ERROR",
    `DLMM SDK returned an unreadable ${field}: ${String(v)}`,
  );
}

function num(v: unknown, field: string): number {
  const n =
    typeof v === "number"
      ? v
      : Number((v as Bnish | undefined)?.toString?.() ?? NaN);
  if (!Number.isFinite(n))
    throw new PoolGuardError(
      "POOL_VENUE_ERROR",
      `DLMM SDK returned an unreadable ${field}`,
    );
  return n;
}

function str(v: unknown, field: string): string {
  if (typeof v === "string") return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (v && typeof (v as Bnish).toString === "function")
    return (v as Bnish).toString();
  throw new PoolGuardError(
    "POOL_VENUE_ERROR",
    `DLMM SDK returned an unreadable ${field}`,
  );
}

/** The SDK returns a legacy `Transaction`, or an array of them when it must split. */
function instructionsOf(
  tx: unknown,
  what: string,
): readonly TransactionInstruction[] {
  if (Array.isArray(tx)) {
    if (tx.length !== 1) {
      throw new PoolGuardError(
        "POOL_MULTI_TX",
        `${what} needs ${tx.length} transactions; an intent is exactly one transaction. ` +
          "Narrow the bin range or remove liquidity in smaller slices.",
        { count: tx.length },
      );
    }
    return instructionsOf(tx[0], what);
  }
  const ixs = (tx as Transaction | undefined)?.instructions;
  if (!Array.isArray(ixs) || ixs.length === 0) {
    throw new PoolGuardError(
      "POOL_VENUE_ERROR",
      `${what} produced no instructions`,
    );
  }
  return ixs;
}

interface DlmmModule {
  default?: unknown;
  DLMM?: unknown;
  StrategyType?: Record<string, unknown>;
  BN?: new (v: string | number) => unknown;
}

async function loadBnCtor(
  mod: DlmmModule,
): Promise<new (v: string | number) => unknown> {
  if (typeof mod.BN === "function") return mod.BN;
  const specifier = "@coral-xyz/anchor";
  try {
    const anchor = (await import(specifier)) as {
      BN?: new (v: string | number) => unknown;
    };
    if (typeof anchor.BN === "function") return anchor.BN;
  } catch {
    // fall through to the explicit error below
  }
  throw new PoolGuardError(
    "POOL_SDK_MISSING",
    `could not load a BN constructor; install @coral-xyz/anchor alongside ${DLMM_PACKAGE}`,
  );
}

class RealDlmmPool implements DlmmPoolHandle {
  #pool: Record<string, unknown>;
  #strategyType: Record<string, unknown>;
  #BN: new (v: string | number) => unknown;
  #state: SdkPoolState;

  constructor(
    pool: Record<string, unknown>,
    strategyType: Record<string, unknown>,
    BN: new (v: string | number) => unknown,
  ) {
    this.#pool = pool;
    this.#strategyType = strategyType;
    this.#BN = BN;
    this.#state = this.#readState();
  }

  get state(): SdkPoolState {
    return this.#state;
  }

  #readState(): SdkPoolState {
    const p = this.#pool;
    const lbPair = p.lbPair as Record<string, unknown> | undefined;
    if (!lbPair)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM instance has no lbPair state",
      );
    const tokenX = p.tokenX as Record<string, unknown> | undefined;
    const tokenY = p.tokenY as Record<string, unknown> | undefined;
    if (!tokenX || !tokenY)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM instance has no token metadata",
      );

    const decimalsOf = (t: Record<string, unknown>): number =>
      num(
        (t.mint as { decimals?: unknown } | undefined)?.decimals ??
          t.decimal ??
          t.decimals,
        "token decimals",
      );

    // baseFactor × binStep × 10 is the base fee in 1e9 units → bps = /1e5.
    const params = lbPair.parameters as Record<string, unknown> | undefined;
    const binStep = num(lbPair.binStep, "binStep");
    const baseFactor = params ? num(params.baseFactor, "baseFactor") : 0;
    const baseFeeBps = baseFactor > 0 ? (baseFactor * binStep) / 100 : 0;

    return {
      address: str(p.pubkey, "pool pubkey"),
      binStep,
      activeBinId: num(lbPair.activeId, "activeId"),
      tokenXMint: str(tokenX.publicKey, "tokenX mint"),
      tokenXDecimals: decimalsOf(tokenX),
      tokenXProgramId: str(
        tokenX.owner ?? tokenX.programId ?? "",
        "tokenX program",
      ),
      tokenYMint: str(tokenY.publicKey, "tokenY mint"),
      tokenYDecimals: decimalsOf(tokenY),
      tokenYProgramId: str(
        tokenY.owner ?? tokenY.programId ?? "",
        "tokenY program",
      ),
      baseFeeBps,
      reserveX: bnToBigInt((tokenX.amount as unknown) ?? 0, "reserveX"),
      reserveY: bnToBigInt((tokenY.amount as unknown) ?? 0, "reserveY"),
    };
  }

  async refresh(): Promise<SdkPoolState> {
    const refetch = this.#pool.refetchStates;
    if (typeof refetch === "function")
      await (refetch as () => Promise<void>).call(this.#pool);
    this.#state = this.#readState();
    return this.#state;
  }

  async positionsOf(owner: string): Promise<readonly SdkPosition[]> {
    const fn = this.#pool.getPositionsByUserAndLbPair;
    if (typeof fn !== "function")
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM SDK lacks getPositionsByUserAndLbPair",
      );
    const res = (await (fn as (o: PublicKey) => Promise<unknown>).call(
      this.#pool,
      new PublicKey(owner),
    )) as {
      userPositions?: readonly unknown[];
    };
    return (res.userPositions ?? []).map((p) => toSdkPosition(p, owner));
  }

  #strategy(shape: LiquidityShape): unknown {
    const name = STRATEGY_NAME[shape];
    const v = this.#strategyType[name];
    if (v === undefined)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        `DLMM StrategyType has no '${name}' member`,
      );
    return v;
  }

  async buildAddLiquidity(args: AddLiquidityArgs): Promise<SdkTxParts> {
    const strategy = {
      minBinId: args.lowerBinId,
      maxBinId: args.upperBinId,
      strategyType: this.#strategy(args.shape),
    };
    const common = {
      user: new PublicKey(args.owner),
      totalXAmount: new this.#BN(args.totalXAmount.toString()),
      totalYAmount: new this.#BN(args.totalYAmount.toString()),
      strategy,
    };

    if (args.positionAddress) {
      const fn = this.#pool.addLiquidityByStrategy;
      if (typeof fn !== "function")
        throw new PoolGuardError(
          "POOL_VENUE_ERROR",
          "DLMM SDK lacks addLiquidityByStrategy",
        );
      const tx = await (fn as (a: unknown) => Promise<unknown>).call(
        this.#pool,
        {
          ...common,
          positionPubKey: new PublicKey(args.positionAddress),
        },
      );
      return {
        instructions: instructionsOf(tx, "addLiquidityByStrategy"),
        extraSigners: [],
        description: `add liquidity to ${args.positionAddress} over bins ${args.lowerBinId}..${args.upperBinId} (${args.shape})`,
      };
    }

    // A brand-new position needs its own account, and `initialize_position` takes
    // that account as a SIGNER. The kernel's wallet signs exactly one key, so we
    // surface the requirement instead of conjuring a keypair inside a tool — see
    // `assertWalletSignableAlone` for what happens next.
    const fn = this.#pool.initializePositionAndAddLiquidityByStrategy;
    if (typeof fn !== "function") {
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM SDK lacks initializePositionAndAddLiquidityByStrategy",
      );
    }
    const placeholder = PublicKey.unique();
    const tx = await (fn as (a: unknown) => Promise<unknown>).call(this.#pool, {
      ...common,
      positionPubKey: placeholder,
    });
    return {
      instructions: instructionsOf(
        tx,
        "initializePositionAndAddLiquidityByStrategy",
      ),
      extraSigners: [placeholder.toBase58()],
      description: `open a new position over bins ${args.lowerBinId}..${args.upperBinId} (${args.shape})`,
    };
  }

  async buildRemoveLiquidity(args: RemoveLiquidityArgs): Promise<SdkTxParts> {
    const fn = this.#pool.removeLiquidity;
    if (typeof fn !== "function")
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM SDK lacks removeLiquidity",
      );
    const binCount = args.toBinId - args.fromBinId + 1;
    if (binCount <= 0)
      throw new PoolGuardError("POOL_RANGE_INVALID", "removal range is empty");
    const tx = await (fn as (a: unknown) => Promise<unknown>).call(this.#pool, {
      position: new PublicKey(args.positionAddress),
      user: new PublicKey(args.owner),
      fromBinId: args.fromBinId,
      toBinId: args.toBinId,
      liquiditiesBpsToRemove: Array.from(
        { length: binCount },
        () => new this.#BN(String(args.bpsToRemove)),
      ),
      shouldClaimAndClose: args.claimAndClose,
    });
    return {
      instructions: instructionsOf(tx, "removeLiquidity"),
      extraSigners: [],
      description:
        `remove ${(args.bpsToRemove / 100).toFixed(2)}% from ${args.positionAddress} bins ${args.fromBinId}..${args.toBinId}` +
        (args.claimAndClose ? " and close it" : ""),
    };
  }

  async buildClaimFees(args: {
    readonly owner: string;
    readonly positionAddress: string;
  }): Promise<SdkTxParts> {
    const positions = await this.positionsOf(args.owner);
    const target = positions.find((p) => p.publicKey === args.positionAddress);
    if (!target)
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        `position ${args.positionAddress} not found for ${args.owner}`,
      );
    const fn = this.#pool.claimSwapFee;
    if (typeof fn !== "function")
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM SDK lacks claimSwapFee",
      );
    const tx = await (fn as (a: unknown) => Promise<unknown>).call(this.#pool, {
      owner: new PublicKey(args.owner),
      position: new PublicKey(args.positionAddress),
    });
    return {
      instructions: instructionsOf(tx, "claimSwapFee"),
      extraSigners: [],
      description: `claim accrued fees on ${args.positionAddress}`,
    };
  }
}

function toSdkPosition(raw: unknown, owner: string): SdkPosition {
  const p = raw as Record<string, unknown>;
  const data = (p.positionData ?? p) as Record<string, unknown>;
  const lastUpdated = data.lastUpdatedAt;
  return {
    publicKey: str(p.publicKey ?? p.address, "position pubkey"),
    owner:
      typeof data.owner === "string"
        ? data.owner
        : data.owner instanceof PublicKey
          ? data.owner.toBase58()
          : owner,
    lowerBinId: num(data.lowerBinId, "lowerBinId"),
    upperBinId: num(data.upperBinId, "upperBinId"),
    totalXAmount: bnToBigInt(data.totalXAmount ?? 0, "totalXAmount"),
    totalYAmount: bnToBigInt(data.totalYAmount ?? 0, "totalYAmount"),
    feeX: bnToBigInt(data.feeX ?? 0, "feeX"),
    feeY: bnToBigInt(data.feeY ?? 0, "feeY"),
    lastUpdatedAt:
      lastUpdated === undefined
        ? undefined
        : Number(bnToBigInt(lastUpdated, "lastUpdatedAt")) * 1000,
  };
}

export class RealDlmmSdk implements DlmmSdk {
  #connection: Connection;
  #module: DlmmModule | null = null;

  constructor(connectionOrUrl: Connection | string) {
    this.#connection =
      typeof connectionOrUrl === "string"
        ? new Connection(connectionOrUrl, "confirmed")
        : connectionOrUrl;
  }

  async #mod(): Promise<DlmmModule> {
    if (!this.#module) this.#module = (await loadDlmmModule()) as DlmmModule;
    return this.#module;
  }

  #dlmmClass(mod: DlmmModule): {
    create: (c: Connection, k: PublicKey) => Promise<Record<string, unknown>>;
    getAllLbPairPositionsByUser?: unknown;
  } {
    const cls = (mod.default ?? mod.DLMM) as { create?: unknown } | undefined;
    if (!cls || typeof cls.create !== "function") {
      throw new PoolGuardError(
        "POOL_SDK_MISSING",
        `${DLMM_PACKAGE} did not export a DLMM class with a static create()`,
      );
    }
    return cls as {
      create: (c: Connection, k: PublicKey) => Promise<Record<string, unknown>>;
      getAllLbPairPositionsByUser?: unknown;
    };
  }

  async openPool(poolAddress: string): Promise<DlmmPoolHandle> {
    const mod = await this.#mod();
    const DLMM = this.#dlmmClass(mod);
    const strategyType = mod.StrategyType;
    if (!strategyType)
      throw new PoolGuardError(
        "POOL_SDK_MISSING",
        `${DLMM_PACKAGE} did not export StrategyType`,
      );
    const BN = await loadBnCtor(mod);
    const pool = await DLMM.create(
      this.#connection,
      new PublicKey(poolAddress),
    );
    return new RealDlmmPool(pool, strategyType, BN);
  }

  async positionsOfUser(
    owner: string,
  ): Promise<readonly { pool: string; position: SdkPosition }[]> {
    const mod = await this.#mod();
    const DLMM = this.#dlmmClass(mod);
    const fn = DLMM.getAllLbPairPositionsByUser;
    if (typeof fn !== "function")
      throw new PoolGuardError(
        "POOL_VENUE_ERROR",
        "DLMM SDK lacks getAllLbPairPositionsByUser",
      );
    const map = (await (
      fn as (c: Connection, o: PublicKey) => Promise<unknown>
    ).call(DLMM, this.#connection, new PublicKey(owner))) as
      Map<string, { lbPairPositionsData?: readonly unknown[] }> | undefined;
    if (!map || typeof map.forEach !== "function") return [];
    const out: { pool: string; position: SdkPosition }[] = [];
    map.forEach((info, poolAddress) => {
      for (const p of info.lbPairPositionsData ?? [])
        out.push({ pool: poolAddress, position: toSdkPosition(p, owner) });
    });
    return out;
  }
}
