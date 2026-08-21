/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { USDC_DECIMALS, USDC_MINT } from "../src/kernel/money.js";
import { isPerpGuardError, PerpsVenueError } from "../src/perps/errors.js";
import type { BlockhashSource, PerpAccountRef } from "../src/perps/venue.js";
import { DriftVenue, readOnlyWallet } from "../src/perps/drift/drift-venue.js";
import type {
  Bn,
  DriftClientLike,
  DriftPerpMarketAccount,
  DriftSdkModule,
  DriftUser,
} from "../src/perps/drift/sdk-types.js";

const ACCOUNT: PerpAccountRef = {
  owner: "OwnerPubkey1111111111111111111111111111111",
  subAccountId: 0,
};

const blockhash: BlockhashSource = {
  latestBlockhash: async () => ({
    blockhash: "FakeBlockhash1111111111111111111111111111111",
    lastValidBlockHeight: 250_000_000,
  }),
};

class FakeBN implements Bn {
  #v: string;
  constructor(value: string | number) {
    this.#v = String(value);
  }
  toString(): string {
    return this.#v;
  }
}

function nameBytes(s: string): number[] {
  const out = [...s].map((c) => c.charCodeAt(0));
  while (out.length < 32) out.push(32);
  return out;
}

function marketAccount(): DriftPerpMarketAccount {
  return {
    marketIndex: 0,
    name: nameBytes("SOL-PERP"),
    status: { active: {} },
    marginRatioInitial: 500,
    marginRatioMaintenance: 300,
    amm: {
      orderStepSize: new FakeBN("100000000"),
      minOrderSize: new FakeBN("100000000"),
      lastFundingRate: new FakeBN("1500000"),
      historicalOracleData: { lastOraclePriceTwap: new FakeBN("150000000") },
    },
  };
}

interface FakeSdkOptions {
  liquidationPrice?: string;
  userExists?: boolean;
}

/** A minimal stand-in for `@drift-labs/sdk`, so the adapter's own arithmetic is exercised without the real SDK. */
function fakeSdk(opts: FakeSdkOptions = {}): {
  sdk: DriftSdkModule;
  built: unknown[][];
} {
  const built: unknown[][] = [];
  const user: DriftUser = {
    getUserAccount: () => ({ subAccountId: 0, perpPositions: [] }),
    getPerpPosition: () => undefined,
    getFreeCollateral: () => new FakeBN("1000000000"),
    getTotalCollateral: () => new FakeBN("1000000000"),
    liquidationPrice: () => new FakeBN(opts.liquidationPrice ?? "105000000"),
  };

  const client: DriftClientLike = {
    subscribe: async () => true,
    unsubscribe: async () => undefined,
    getPerpMarketAccounts: () => [marketAccount()],
    getPerpMarketAccount: () => marketAccount(),
    getOracleDataForPerpMarket: () => ({
      price: new FakeBN("150000000"),
      slot: new FakeBN("999"),
    }),
    getUser: () => user,
    getUserAccount: () =>
      opts.userExists === false
        ? undefined
        : { subAccountId: 0, perpPositions: [] },
    getPlacePerpOrderIx: async () => ({ placePerpOrder: true }),
    getInitializeUserInstructions: async () => [
      { initUser: true },
      { initStats: true },
      { extra: true },
    ],
    buildTransaction: async (ixs) => {
      built.push(ixs);
      return {
        serialize: () => new Uint8Array([1, 2, 3, 4]),
        message: {
          recentBlockhash: "FakeBlockhash1111111111111111111111111111111",
        },
      };
    },
  };

  const sdk = {
    DriftClient: class {
      constructor(_config: Record<string, unknown>) {
        return client as unknown as InstanceType<typeof Object>;
      }
    } as unknown as DriftSdkModule["DriftClient"],
    PositionDirection: { LONG: "long", SHORT: "short" },
    MarketType: { PERP: "perp", SPOT: "spot" },
    BN: FakeBN as unknown as DriftSdkModule["BN"],
    getMarketOrderParams: (params: Record<string, unknown>) => params as never,
    getLimitOrderParams: (params: Record<string, unknown>) => params as never,
  } as DriftSdkModule;

  return { sdk, built };
}

function venue(
  opts: { allowAccountCreation?: boolean; sdk?: DriftSdkModule } = {},
): DriftVenue {
  const { sdk } = opts.sdk ? { sdk: opts.sdk } : fakeSdk();
  return new DriftVenue({
    connection: {},
    publicKey: {},
    owner: ACCOUNT.owner,
    blockhash,
    allowAccountCreation: opts.allowAccountCreation,
    sdkLoader: async () => sdk,
  });
}

// ── the no-signing guarantee ─────────────────────────────────────────────────

test("readOnlyWallet cannot sign — the adapter is signing-incapable by construction", () => {
  const w = readOnlyWallet({ toBase58: () => "pk" }) as Record<
    string,
    () => unknown
  >;
  assert.throws(() => w.signTransaction!(), /signing-incapable/);
  assert.throws(() => w.signAllTransactions!(), /signing-incapable/);
  assert.throws(() => w.signVersionedTransaction!(), /signing-incapable/);
});

// ── account creation is separately gated ─────────────────────────────────────

test("buildInitializeAccount refuses when account creation is not explicitly enabled", async () => {
  const v = venue({ allowAccountCreation: false });
  try {
    await v.buildInitializeAccount(ACCOUNT);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(isPerpGuardError(err));
    assert.equal(err.perpCode, "ACCOUNT_CREATION_DISABLED");
  }
});

test("the refusal happens BEFORE the SDK is even loaded — a trade can never create an account", async () => {
  const v = new DriftVenue({
    connection: {},
    publicKey: {},
    owner: ACCOUNT.owner,
    blockhash,
    sdkLoader: async () => {
      throw new Error("the SDK must not be loaded on the refused path");
    },
  });
  await assert.rejects(
    () => v.buildInitializeAccount(ACCOUNT),
    /ACCOUNT_CREATION_DISABLED|creation is disabled/,
  );
});

test("with creation enabled it builds an unsigned init transaction and warns about rent", async () => {
  const { sdk } = fakeSdk({ userExists: false });
  const v = new DriftVenue({
    connection: {},
    publicKey: {},
    owner: ACCOUNT.owner,
    blockhash,
    allowAccountCreation: true,
    sdkLoader: async () => sdk,
  });
  await v.connect();
  const build = await v.buildInitializeAccount(ACCOUNT);
  assert.equal(
    build.unsignedTxBase64,
    Buffer.from([1, 2, 3, 4]).toString("base64"),
  );
  assert.equal(build.lastValidBlockHeight, 250_000_000);
  assert.ok(build.venueWarnings.some((w) => w.includes("rent")));
});

test("creation is refused when the subaccount already exists", async () => {
  const v = venue({ allowAccountCreation: true });
  await v.connect();
  await assert.rejects(
    () => v.buildInitializeAccount(ACCOUNT),
    /already exists/,
  );
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test("every method refuses before connect() rather than half-working", async () => {
  const v = venue();
  await assert.rejects(() => v.listMarkets(), PerpsVenueError);
  await assert.rejects(() => v.getPositions(ACCOUNT), PerpsVenueError);
  await assert.rejects(() => v.getAccountStatus(ACCOUNT), PerpsVenueError);
});

test("a missing @drift-labs/sdk is a clear, actionable venue error", async () => {
  const v = new DriftVenue({
    connection: {},
    publicKey: {},
    owner: ACCOUNT.owner,
    blockhash,
  });
  await assert.rejects(
    () => v.connect(),
    (err: unknown) => {
      assert.ok(err instanceof PerpsVenueError);
      assert.match(err.message, /@drift-labs\/sdk is not installed/);
      return true;
    },
  );
});

// ── reads + builds against the fake SDK ──────────────────────────────────────

test("listMarkets converts Drift accounts into clean domain markets", async () => {
  const v = venue();
  await v.connect();
  const markets = await v.listMarkets();
  assert.equal(markets.length, 1);
  assert.equal(markets[0]!.symbol, "SOL-PERP");
  assert.equal(markets[0]!.venue, "drift");
  assert.equal(markets[0]!.maxLeverage, 20);
  assert.equal(markets[0]!.maintenanceMarginRatio, 0.03);
  await assert.rejects(
    () => v.getMarket("DOGE-PERP"),
    /unknown or unusable perp market/,
  );
});

test("getPrices and getFundingRate come back in domain units", async () => {
  const v = venue();
  await v.connect();
  const prices = await v.getPrices("SOL-PERP");
  assert.equal(prices.markPrice, 150);
  assert.equal(prices.oraclePrice, 150);

  const funding = await v.getFundingRate("SOL-PERP");
  assert.ok(Math.abs(funding.bpsPerHour - 0.1) < 1e-9);
});

test("buildOpen derives base size from the input leg: collateral × leverage ÷ price", async () => {
  const v = venue();
  await v.connect();
  const market = await v.getMarket("SOL-PERP");
  const build = await v.buildOpen({
    account: ACCOUNT,
    market,
    side: "long",
    collateral: {
      mint: USDC_MINT,
      amount: 50_000_000n,
      decimals: USDC_DECIMALS,
    },
    leverage: 3,
    orderType: "market",
    limitPrice: undefined,
    slippageBps: 50,
    priorityFeeLamports: 200_000,
  });

  // 50 USDC × 3 = 150 USDC notional; at $150 that is exactly 1 SOL.
  assert.equal(build.notional.amount, 150_000_000n);
  assert.equal(build.expectedBaseAmount, 1_000_000_000n);
  assert.equal(
    build.minBaseAmount,
    995_000_000n,
    "50bps of slippage means 0.5% less size in the worst case",
  );
  assert.equal(build.entryPrice, 150);
  assert.equal(build.estimatedLiquidationPrice, 105);
  assert.equal(build.priorityFeeLamports, 200_000);
  assert.ok(build.unsignedTxBase64.length > 0);
});

test("buildOpen refuses degenerate inputs", async () => {
  const v = venue();
  await v.connect();
  const market = await v.getMarket("SOL-PERP");
  const base = {
    account: ACCOUNT,
    market,
    side: "long" as const,
    orderType: "market" as const,
    limitPrice: undefined,
    slippageBps: 50,
    priorityFeeLamports: 200_000,
  };
  await assert.rejects(
    () =>
      v.buildOpen({
        ...base,
        collateral: { mint: USDC_MINT, amount: 0n, decimals: 6 },
        leverage: 3,
      }),
    /positive collateral/,
  );
  await assert.rejects(
    () =>
      v.buildOpen({
        ...base,
        collateral: { mint: USDC_MINT, amount: 50_000_000n, decimals: 6 },
        leverage: 0,
      }),
    /invalid leverage/,
  );
});

test("a limit order without a limit price is refused at the venue boundary", async () => {
  const v = venue();
  await v.connect();
  const market = await v.getMarket("SOL-PERP");
  await assert.rejects(
    () =>
      v.buildOpen({
        account: ACCOUNT,
        market,
        side: "long",
        collateral: {
          mint: USDC_MINT,
          amount: 50_000_000n,
          decimals: USDC_DECIMALS,
        },
        leverage: 3,
        orderType: "limit",
        limitPrice: undefined,
        slippageBps: 50,
        priorityFeeLamports: 200_000,
      }),
    /limit order needs a positive limit price/,
  );
});

test('a venue liquidation estimate of -1 ("none") surfaces as undefined, not as a price', async () => {
  const { sdk } = fakeSdk({ liquidationPrice: "-1" });
  const v = new DriftVenue({
    connection: {},
    publicKey: {},
    owner: ACCOUNT.owner,
    blockhash,
    sdkLoader: async () => sdk,
  });
  await v.connect();
  const market = await v.getMarket("SOL-PERP");
  const build = await v.buildOpen({
    account: ACCOUNT,
    market,
    side: "long",
    collateral: {
      mint: USDC_MINT,
      amount: 50_000_000n,
      decimals: USDC_DECIMALS,
    },
    leverage: 3,
    orderType: "market",
    limitPrice: undefined,
    slippageBps: 50,
    priorityFeeLamports: 200_000,
  });
  assert.equal(build.estimatedLiquidationPrice, undefined);
  assert.ok(build.venueWarnings.some((w) => w.includes("isolated model")));
});
