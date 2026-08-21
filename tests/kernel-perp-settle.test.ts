/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. New in ARI OS: covers the
 * venue-position settle branch the Aetheria perps package could only document.
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../src/kernel/clock.js";
import type {
  PerpSettleLeg,
  PolicyConfig,
  TradeIntent,
} from "../src/kernel/contracts.js";
import { defaultPolicy } from "../src/kernel/defaults.js";
import { newIdempotencyKey } from "../src/kernel/ids.js";
import { USDC_MINT } from "../src/kernel/money.js";
import {
  MockBalances,
  MockBroadcaster,
  MockChain,
  MockConfirmer,
  MockMints,
  MockPositions,
  MockSimulator,
  MockWallet,
  positionKey,
} from "../src/kernel/selfcheck/mocks.js";
import { KernelStore } from "../src/kernel/store.js";
import { TradeGatewayImpl } from "../src/kernel/trade-gateway.js";
import { removeDir } from "./helpers.js";

const MARKET = "SOL-PERP";
const VENUE = "drift";
const KEY = positionKey({
  venue: VENUE,
  market: MARKET,
  owner: "irrelevant",
  subAccountId: 0,
});

/** 100 USDC of margin, 1 SOL of base size. */
const COLLATERAL = 100_000_000n;
const BASE = 1_000_000_000n;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function perpLeg(over: Partial<PerpSettleLeg> = {}): PerpSettleLeg {
  return {
    venue: VENUE,
    market: MARKET,
    accountSubId: 0,
    side: "long",
    baseDecimals: 9,
    expectedBaseAmount: BASE,
    minBaseAmount: (BASE * 99n) / 100n,
    ...over,
  };
}

function perpIntent(
  kind: TradeIntent["kind"],
  collateral: bigint,
  perp: PerpSettleLeg,
): TradeIntent {
  return {
    kind,
    source: "perps_open",
    input: { mint: USDC_MINT, amount: collateral, decimals: 6 },
    output: { mint: USDC_MINT, decimals: 6 },
    inputProvenance: "user",
    outputProvenance: "user",
    unsignedTxBase64: "AAAA",
    recentBlockhash: "hash",
    lastValidBlockHeight: 1_000,
    landMode: "self-rpc",
    landHandle: undefined,
    priorityFeeLamports: 10_000,
    // A perp has no token output leg; the fill bounds live on `perp`.
    quote: {
      inAmount: collateral,
      outAmount: 0n,
      minOutAmount: 0n,
      priceImpactPct: 0,
      routeLabel: `${VENUE}:${MARKET}`,
      slippageBps: 50,
      contextSlot: undefined,
    },
    perp,
    summary: `${kind} ${MARKET}`,
  };
}

function harness(opts: { positions?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ari-perp-settle-"));
  dirs.push(dir);
  const chain = new MockChain();
  const store = new KernelStore(join(dir, "kernel.db"));
  const policy: PolicyConfig = { ...defaultPolicy(), executionEnabled: true };
  const broadcaster = new MockBroadcaster(chain);
  const gateway = new TradeGatewayImpl({
    store,
    wallet: new MockWallet(),
    policy: () => policy,
    mints: new MockMints(),
    balances: new MockBalances(chain),
    simulator: new MockSimulator(chain),
    broadcasters: { "self-rpc": broadcaster, "jupiter-ultra": broadcaster },
    confirmer: new MockConfirmer(chain),
    clock: systemClock,
    ...(opts.positions === false
      ? {}
      : { positions: new MockPositions(chain) }),
  });
  // Plenty of collateral in the wallet.
  chain.balances.set(USDC_MINT, 10_000_000_000n);
  return { chain, store, gateway };
}

const run = (gateway: TradeGatewayImpl, intent: TradeIntent) =>
  gateway.execute(intent, { idempotencyKey: newIdempotencyKey() });

describe("perp settle by venue position delta", () => {
  it("verifies an open against the position, not the collateral balance", async () => {
    const { chain, gateway } = harness();
    // The collateral mint is BOTH legs of a perp intent, so the balance delta
    // is negative on a successful open. Under the swap-shaped settle that alone
    // would have tripped a shortfall; the position delta is what really filled.
    chain.fill = {
      inMint: USDC_MINT,
      inAmt: COLLATERAL,
      outMint: USDC_MINT,
      outAmt: 0n,
    };
    chain.positionFill = { key: KEY, delta: BASE };

    const r = await run(
      gateway,
      perpIntent("perp_open", COLLATERAL, perpLeg()),
    );

    expect(r.state).toBe("confirmed");
    expect(r.error).toBeUndefined();
    expect(r.fill?.positionDelta).toBe(BASE);
    expect(r.fill?.outputDelta).toBeLessThan(0n); // would have been a false shortfall
    expect(r.fill?.effectiveSlippageBps).toBe(0);
  });

  it("reports a shortfall when the position moved less than the committed minimum", async () => {
    const { chain, gateway } = harness();
    chain.positionFill = { key: KEY, delta: BASE / 2n };

    const r = await run(
      gateway,
      perpIntent("perp_open", COLLATERAL, perpLeg()),
    );

    expect(r.state).toBe("confirmed");
    expect(r.error?.code).toBe("SETTLE_SHORTFALL");
    expect(r.fill?.positionDelta).toBe(BASE / 2n);
    expect(r.fill?.effectiveSlippageBps).toBe(5_000);
  });

  it("reports a shortfall when the position did not move at all", async () => {
    const { gateway } = harness();
    const r = await run(
      gateway,
      perpIntent("perp_open", COLLATERAL, perpLeg()),
    );
    expect(r.error?.code).toBe("SETTLE_SHORTFALL");
    expect(r.fill?.positionDelta).toBe(0n);
  });

  it("measures a close in the ORDER's direction, so shrinking a long verifies", async () => {
    const { chain, gateway } = harness();
    chain.positions.set(KEY, BASE); // an open long
    chain.positionFill = { key: KEY, delta: -BASE }; // the close sells it
    const leg = perpLeg({ side: "short", minBaseAmount: BASE });

    const r = await run(gateway, perpIntent("perp_close", 0n, leg));

    expect(r.state).toBe("confirmed");
    expect(r.error).toBeUndefined();
    expect(r.fill?.positionDelta).toBe(-BASE);
    expect(chain.positions.get(KEY)).toBe(0n);
  });

  it("refuses a close whose position moved the WRONG way", async () => {
    const { chain, gateway } = harness();
    chain.positions.set(KEY, BASE);
    chain.positionFill = { key: KEY, delta: BASE }; // grew instead of shrinking

    const r = await run(
      gateway,
      perpIntent(
        "perp_close",
        0n,
        perpLeg({ side: "short", minBaseAmount: BASE }),
      ),
    );

    expect(r.error?.code).toBe("SETTLE_SHORTFALL");
  });

  it("refuses before broadcast when no position reader is mounted", async () => {
    const { chain, gateway } = harness({ positions: false });
    chain.positionFill = { key: KEY, delta: BASE };

    const r = await run(
      gateway,
      perpIntent("perp_open", COLLATERAL, perpLeg()),
    );

    expect(r.state).toBe("rejected");
    expect(r.error?.code).toBe("SETTLE_UNVERIFIABLE");
    expect(r.signature).toBeUndefined();
    // Nothing was signed or broadcast: the position book is untouched.
    expect(chain.positions.size).toBe(0);
  });

  it("reports SETTLE_UNVERIFIED rather than unwinding a confirmed trade", async () => {
    const { chain, store, gateway } = harness();
    chain.positionFill = { key: KEY, delta: BASE };
    const intent = perpIntent("perp_open", COLLATERAL, perpLeg());

    // The pre-read succeeds; the venue goes dark before the post-read.
    const original = MockPositions.prototype.readPosition;
    let reads = 0;
    MockPositions.prototype.readPosition = async function (ref) {
      if (++reads > 1) throw new Error("venue RPC unavailable");
      return original.call(this, ref);
    };
    let r;
    try {
      r = await run(gateway, intent);
    } finally {
      MockPositions.prototype.readPosition = original;
    }

    expect(r.state).toBe("confirmed");
    expect(r.error?.code).toBe("SETTLE_UNVERIFIED");
    expect(r.fill?.positionDelta).toBeUndefined();
    expect(store.getTrade(r.tradeId)?.state).toBe("confirmed");
  });

  it("still reserves the collateral against the input-leg cap", async () => {
    const { chain, store, gateway } = harness();
    chain.positionFill = { key: KEY, delta: BASE };

    await run(gateway, perpIntent("perp_open", COLLATERAL, perpLeg()));
    expect(store.usage("usdc", Date.now()).day).toBe(COLLATERAL);

    // A close posts nothing, so it consumes no cap — the agent can always exit.
    chain.positions.set(KEY, BASE);
    chain.positionFill = { key: KEY, delta: -BASE };
    await run(
      gateway,
      perpIntent(
        "perp_close",
        0n,
        perpLeg({ side: "short", minBaseAmount: BASE }),
      ),
    );
    expect(store.usage("usdc", Date.now()).day).toBe(COLLATERAL);
  });

  it("leaves the swap path settling on the token balance", async () => {
    const { chain, gateway } = harness();
    const bonk = "BonkMint11111111111111111111111111111111111";
    chain.fill = {
      inMint: USDC_MINT,
      inAmt: COLLATERAL,
      outMint: bonk,
      outAmt: 400n,
    };
    const swap: TradeIntent = {
      ...perpIntent("perp_open", COLLATERAL, perpLeg()),
      kind: "swap",
      source: "swap_jupiter",
      output: { mint: bonk, decimals: 6 },
      outputProvenance: "user",
      quote: {
        inAmount: COLLATERAL,
        outAmount: 1_000n,
        minOutAmount: 995n,
        priceImpactPct: 0,
        routeLabel: "orca",
        slippageBps: 50,
        contextSlot: undefined,
      },
    };
    delete (swap as { perp?: unknown }).perp;

    const r = await run(gateway, swap);

    expect(r.state).toBe("confirmed");
    expect(r.error?.code).toBe("SETTLE_SHORTFALL");
    expect(r.fill?.outputDelta).toBe(400n);
    expect(r.fill?.positionDelta).toBeUndefined();
  });
});
