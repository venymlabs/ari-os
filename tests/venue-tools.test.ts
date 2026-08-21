import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { TRADING_CAPABILITIES } from "../src/agent/types.js";
import type { ToolContext } from "../src/kernel/contracts.js";
import { USDC_DECIMALS, USDC_MINT } from "../src/kernel/money.js";
import {
  FakePerpsVenue,
  fakePosition,
} from "../src/perps/testing/fake-venue.js";
import { testPolicy } from "../src/perps/testing/fixtures.js";
import type { PerpsToolDeps } from "../src/perps/tools/deps.js";
import { registerBuiltInTools } from "../src/tools/index.js";
import { perpsPositionReader, venueToolNames } from "../src/tools/venues.js";

const OWNER = "OwnerPubkey1111111111111111111111111111111";

const notImplemented = (what: string) => () => {
  throw new Error(`unexpected call to ${what}`);
};

/** A gateway that records every execute and refuses to move anything. */
function toolCtx(calls: { confirmedByUser: boolean[] }): ToolContext {
  return {
    ownerWallet: OWNER,
    rpcUrl: "http://localhost:8899",
    services: {
      solana: {
        getSolLamports: notImplemented("getSolLamports"),
        getTokenHoldings: notImplemented("getTokenHoldings"),
        getMintInfo: notImplemented("getMintInfo"),
      },
      jupiter: {
        quote: notImplemented("quote"),
        buildSwap: notImplemented("buildSwap"),
      },
    },
    gateway: {
      execute: async (_intent, opts) => {
        calls.confirmedByUser.push(opts.confirmedByUser === true);
        throw new Error("gateway refused (test)");
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    signal: undefined,
  };
}

function perpsDeps(venue: FakePerpsVenue): PerpsToolDeps {
  const policy = testPolicy();
  return {
    venue,
    policy: () => policy,
    killSwitch: () => false,
    executionEnabled: () => true,
    collateral: () => ({ mint: USDC_MINT, decimals: USDC_DECIMALS }),
  };
}

function mount(over: { perps?: boolean } = {}) {
  const calls = { confirmedByUser: [] as boolean[] };
  const venue = new FakePerpsVenue({ positions: [fakePosition()] });
  const registry = registerBuiltInTools(new ToolRegistry(), {
    venues: {
      runtime: { context: () => toolCtx(calls) },
      ...(over.perps === false ? {} : { perps: perpsDeps(venue) }),
    },
  });
  return { registry, venue, calls };
}

describe("venue tool registration", () => {
  it("registers reads once and value-moving tools as an execute/preview pair", () => {
    const { registry } = mount();
    const names = registry.listPrivileged().map((t) => t.name);

    expect(names).toContain("perps_markets");
    expect(names).not.toContain("perps_markets.preview");
    for (const spend of ["perps_open", "perps_close", "perps_adjust"]) {
      expect(names).toContain(spend);
      expect(names).toContain(`${spend}.preview`);
    }
  });

  it("gates spends behind a write capability and previews behind simulate", () => {
    const { registry } = mount();
    const capOf = (name: string) =>
      registry.listPrivileged().find((t) => t.name === name)?.capabilities;

    expect(capOf("perps_open")).toEqual([TRADING_CAPABILITIES.POSITION_WRITE]);
    expect(capOf("perps_open.preview")).toEqual([
      TRADING_CAPABILITIES.ORDER_SIMULATE,
    ]);
    expect(capOf("perps_positions")).toEqual([
      TRADING_CAPABILITIES.PORTFOLIO_READ,
    ]);
  });

  it("classifies spends as trade-effect and never parallel-safe", () => {
    const { registry } = mount();
    expect(registry.classify("perps_open")).toEqual({
      effect: "trade",
      parallelSafe: false,
    });
    expect(registry.classify("perps_markets")).toEqual({
      effect: "read",
      parallelSafe: true,
    });
  });

  it("never lets tool input set confirmedByUser", async () => {
    const { registry, calls } = mount();
    // A model that could smuggle this flag through would clear the
    // untrusted-mint gate by asking for it.
    await registry.invoke(
      "perps_close",
      { market: "SOL-PERP", confirmedByUser: true },
      { capabilities: [TRADING_CAPABILITIES.POSITION_WRITE] },
    );
    expect(calls.confirmedByUser.every((c) => c === false)).toBe(true);
  });

  it("registers nothing when a venue is not mounted", () => {
    const { registry } = mount({ perps: false });
    const names = registry.listPrivileged().map((t) => t.name);
    expect(names.some((n) => n.startsWith("perps_"))).toBe(false);
    expect(venueToolNames({})).toEqual([]);
  });
});

describe("perps position reader", () => {
  it("signs the venue position by side so the gateway can diff it", async () => {
    const venue = new FakePerpsVenue({ positions: [fakePosition()] });
    const reader = perpsPositionReader({ perps: perpsDeps(venue) })!;
    const ref = {
      venue: "fake",
      market: "SOL-PERP",
      owner: OWNER,
      subAccountId: 0,
    };

    expect(await reader.readPosition(ref)).toBe(1_000_000_000n);

    const short = new FakePerpsVenue({
      positions: [fakePosition({ side: "short" })],
    });
    expect(
      await perpsPositionReader({ perps: perpsDeps(short) })!.readPosition(ref),
    ).toBe(-1_000_000_000n);
  });

  it("reads a missing position as flat and an unknown venue as an error", async () => {
    const venue = new FakePerpsVenue({ positions: [fakePosition()] });
    const reader = perpsPositionReader({ perps: perpsDeps(venue) })!;

    expect(
      await reader.readPosition({
        venue: "fake",
        market: "BTC-PERP",
        owner: OWNER,
        subAccountId: 0,
      }),
    ).toBe(0n);

    await expect(
      reader.readPosition({
        venue: "drift",
        market: "SOL-PERP",
        owner: OWNER,
        subAccountId: 0,
      }),
    ).rejects.toThrow(/no perps venue named 'drift' is mounted/);
  });

  it("is undefined when perps are not mounted, so the gateway refuses perp intents", () => {
    expect(perpsPositionReader({})).toBeUndefined();
  });
});
