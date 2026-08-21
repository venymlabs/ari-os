/*
 * SPDX-License-Identifier: MIT
 * NEW in ARI OS — not derived from Aetheria. Aetheria's signals engine and its
 * pools guards never met: the `RugHeatSource` port is an ARI OS extraction, and
 * these are the cases that prove the port is actually satisfied end to end.
 */

import { describe, expect, it } from "vitest";
import { SignalsEngine, SignalsFeed, TradeTape } from "../src/data/index.js";
import { defaultPoolGuardConfig, guardRugHeat } from "../src/pools/guards.js";
import { readRugHeat, resolveDeps } from "../src/pools/tools/deps.js";
import type { PoolsDepsInput, RugHeatSource } from "../src/pools/tools/deps.js";
import type { RugHeat } from "../src/pools/signals.js";

const MINT = "BonkMint11111111111111111111111111111111111";

/** Enough of `PoolsDeps` to exercise `readRugHeat`; no venue is touched. */
const depsWith = (signals?: RugHeatSource) =>
  resolveDeps({
    venue: null as never,
    curve: null as never,
    chain: null as never,
    ...(signals ? { signals } : {}),
  } as PoolsDepsInput);

/** Healthy two-sided flow: many distinct traders, real size, balanced. */
function healthyTape(mint = MINT): TradeTape {
  const tape = new TradeTape();
  const now = Date.now();
  for (let i = 0; i < 10; i++)
    tape.addTrade({
      mint,
      solAmount: 3 + i * 0.05,
      isBuy: true,
      trader: `buyer${i}`,
      ts: now,
    });
  for (let i = 0; i < 9; i++)
    tape.addTrade({
      mint,
      solAmount: 3 + i * 0.05,
      isBuy: false,
      trader: `seller${i}`,
      ts: now,
    });
  return tape;
}

describe("rug-heat source mounting", () => {
  it("a SignalsEngine satisfies RugHeatSource without adaptation", () => {
    // Structural, not nominal: the engine IS the port. If this stops compiling
    // the composition root stops compiling too, which is the point.
    const source: RugHeatSource = new SignalsEngine(healthyTape());
    const heat: RugHeat = source.rugHeatScore(MINT);
    expect(typeof heat.score).toBe("number");
    expect(heat.reasons.length).toBeGreaterThan(0);
  });

  it("UNMOUNTED: no reading, and guardRugHeat refuses", () => {
    const deps = depsWith(undefined);
    const heat = readRugHeat(deps, MINT);
    expect(heat).toBeNull();

    const refusal = guardRugHeat(defaultPoolGuardConfig(), heat);
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("POOL_RUG_HEAT");
    expect(refusal?.message).toMatch(/no rug-heat reading available/i);
  });

  it("MOUNTED over observed trades: a real reading, and the guard passes", () => {
    const deps = depsWith(new SignalsEngine(healthyTape()));
    const heat = readRugHeat(deps, MINT);
    expect(heat).not.toBeNull();
    expect(heat?.score).toBeLessThan(defaultPoolGuardConfig().maxRugHeat);
    expect(guardRugHeat(defaultPoolGuardConfig(), heat)).toBeNull();
  });

  it("MOUNTED over an EMPTY tape still refuses — mounting is not a relaxation", () => {
    // The failure mode that matters: wiring an engine must not turn a
    // never-seen mint into a pass. An empty tape scores 60, which is AT the
    // default rejection threshold.
    const deps = depsWith(new SignalsEngine(new TradeTape()));
    const heat = readRugHeat(deps, MINT);
    expect(heat?.score).toBe(60);
    const refusal = guardRugHeat(defaultPoolGuardConfig(), heat);
    expect(refusal?.code).toBe("POOL_RUG_HEAT");
    expect(refusal?.message).toMatch(/at or above the 60 rejection threshold/i);
  });

  it("a throwing source degrades to a refusal, never to a pass", () => {
    const hostile: RugHeatSource = {
      rugHeatScore() {
        throw new Error("feed exploded");
      },
    };
    const heat = readRugHeat(depsWith(hostile), MINT);
    expect(heat).toBeNull();
    expect(guardRugHeat(defaultPoolGuardConfig(), heat)).not.toBeNull();
  });
});

describe("SignalsFeed", () => {
  it("exposes an engine before any socket is opened", () => {
    const feed = new SignalsFeed({ watcher: { createSocket: neverConnect } });
    expect(feed.started).toBe(false);
    expect(feed.connected).toBe(false);
    // The reading exists immediately — it is simply uninformed, and therefore
    // refusing.
    expect(feed.engine.rugHeatScore(MINT).score).toBe(60);
  });

  it("pins an explicitly watched mint against auto-follow eviction", () => {
    const feed = new SignalsFeed({
      watcher: { createSocket: neverConnect },
      maxAutoFollow: 1,
    });
    feed.watch(MINT);
    expect(feed.watching()).toContain(MINT);
  });

  it("start/stop are idempotent and never open a socket twice", () => {
    let created = 0;
    const feed = new SignalsFeed({
      watcher: {
        createSocket: (url) => {
          created += 1;
          return neverConnect(url);
        },
      },
    });
    feed.start();
    feed.start();
    expect(created).toBe(1);
    expect(feed.started).toBe(true);
    feed.stop();
    feed.stop();
    expect(feed.started).toBe(false);
  });
});

describe("composition root", () => {
  /**
   * The last link in the chain, asserted at the source.
   *
   * Everything above proves the engine SATISFIES the port. This proves the
   * composition root actually HANDS it over — which cannot be exercised
   * directly without a funded wallet and a live RPC, neither of which exists
   * here. If the mount is ever dropped, `guardRugHeat` silently goes back to
   * refusing every pump.fun buy, and nothing else in the suite would notice.
   */
  it("mounts the engine on the pools deps and starts the feed in start()", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(process.cwd(), "src", "app", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/new SignalsFeed\(/);
    // The pools mount hands over the engine and the tape-warming hook.
    expect(src).toMatch(/signals:\s*signals\.engine/);
    expect(src).toMatch(
      /watch:\s*\(mint: string\)\s*=>\s*signals\.watch\(mint\)/,
    );
    // The socket opens on the application lifecycle, not at construction.
    expect(src).toMatch(/venues\.signals\.start\(\)/);
    expect(src).toMatch(/venues\?\.signals\.stop\(\)/);
  });
});

/** A socket that is constructed but never opens. Nothing touches a network. */
function neverConnect(_url: string) {
  return {
    readyState: 0,
    send() {},
    close() {},
    addEventListener() {},
  } as never;
}
