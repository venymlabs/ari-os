/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: `node:test` +
 * `node:assert/strict` replaced with vitest, and the PumpPortal cases are new
 * (Aetheria had none — its watcher was only exercised against the live socket).
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  PumpPortalWatcher,
  SignalsEngine,
  TradeTape,
  type FeedSocket,
  type TapeTrade,
} from "../src/data/index.js";

const now = Date.now();

function trade(
  p: Partial<TapeTrade> & { solAmount: number; isBuy: boolean },
): TapeTrade {
  return {
    mint: "M",
    trader: `t${Math.round(p.solAmount * 1000)}-${p.isBuy}`,
    ts: now,
    ...p,
  };
}

describe("trade tape signals", () => {
  it("diverges volume-weighted pressure from count pressure under dust spam", () => {
    const tape = new TradeTape();
    // 5 tiny buys, 1 large sell.
    for (let i = 0; i < 5; i++)
      tape.addTrade(trade({ solAmount: 0.01, isBuy: true, trader: `b${i}` }));
    tape.addTrade(trade({ solAmount: 5, isBuy: false, trader: "s0" }));

    const s = tape.signals("M");
    expect(s.trades).toBe(6);
    expect(s.buyPressurePct).toBeGreaterThan(80); // 5/6 by count
    expect(s.volumeWeightedBuyPressurePct).toBeLessThan(5); // 0.05/5.05 by size
    expect(s.largestTradeSol).toBe(5);
  });

  it("computes the window price change from the first→last priced trade", () => {
    const tape = new TradeTape();
    tape.addTrade(
      trade({ solAmount: 1, isBuy: true, ts: now - 2000, priceSol: 0.001 }),
    );
    tape.addTrade(
      trade({ solAmount: 1, isBuy: true, ts: now - 1000, priceSol: 0.0012 }),
    );
    const s = tape.signals("M");
    expect(s.priceChangePct).toBeDefined();
    expect(s.priceChangePct ?? 0).toBeCloseTo(20, 9); // +20%
    expect(s.lastPriceSol).toBe(0.0012);
  });

  it("ignores trades older than the window", () => {
    const tape = new TradeTape();
    tape.addTrade(trade({ solAmount: 3, isBuy: true, ts: now - 600_000 }));
    tape.addTrade(trade({ solAmount: 1, isBuy: true, ts: now }));
    expect(tape.signals("M", 300_000).trades).toBe(1);
    expect(tape.signals("M", 900_000).trades).toBe(2);
  });

  it("evicts the oldest print once a mint's buffer is over cap", () => {
    const tape = new TradeTape(3);
    for (let i = 0; i < 5; i++)
      tape.addTrade(trade({ solAmount: i + 1, isBuy: true }));
    const kept = tape.trades("M").map((t) => t.solAmount);
    expect(kept).toEqual([3, 4, 5]);
    expect(tape.size()).toBe(3);
  });
});

describe("rug heat", () => {
  it("flags the count/size divergence (distribution tell)", () => {
    const tape = new TradeTape();
    for (let i = 0; i < 5; i++)
      tape.addTrade(trade({ solAmount: 0.02, isBuy: true, trader: `b${i}` }));
    tape.addTrade(trade({ solAmount: 6, isBuy: false, trader: "s0" }));

    const heat = new SignalsEngine(tape).rugHeatScore("M");
    expect(heat.score).toBeGreaterThanOrEqual(40);
    expect(heat.reasons.some((r) => /sell SIZE dominates/i.test(r))).toBe(true);
  });

  it("scores an empty / unseen mint at the illiquidity default", () => {
    const heat = new SignalsEngine(new TradeTape()).rugHeatScore("UNSEEN");
    expect(heat.score).toBe(60);
    expect(heat.reasons[0]).toMatch(/no trades in window/i);
  });

  it("scores balanced healthy flow low", () => {
    const tape = new TradeTape();
    for (let i = 0; i < 8; i++)
      tape.addTrade(
        trade({ solAmount: 2 + i * 0.1, isBuy: true, trader: `b${i}` }),
      );
    for (let i = 0; i < 7; i++)
      tape.addTrade(
        trade({ solAmount: 2 + i * 0.1, isBuy: false, trader: `s${i}` }),
      );
    const heat = new SignalsEngine(tape).rugHeatScore("M");
    expect(heat.score).toBeLessThan(40);
  });

  it("renders a one-line summary carrying the verdict", () => {
    const tape = new TradeTape();
    tape.addTrade(trade({ solAmount: 2, isBuy: true, priceSol: 0.001 }));
    const line = new SignalsEngine(tape).summary("M");
    expect(line).toMatch(/rug-heat \d+\/100 \[(LOW|WATCH|ELEVATED|HIGH)\]/);
  });
});

/** A scriptable stand-in for the WHATWG WebSocket. No network anywhere. */
class FakeSocket implements FeedSocket {
  readyState = 1; // OPEN
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, ((arg: never) => void)[]>();
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }
  addEventListener(type: string, listener: (arg: never) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }
  emit(type: string, arg?: unknown): void {
    for (const l of this.#listeners.get(type) ?? [])
      (l as (a: unknown) => void)(arg);
  }
  commands(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

describe("PumpPortal watcher", () => {
  const start = () => {
    let socket!: FakeSocket;
    const trades: TapeTrade[] = [];
    const launches: string[] = [];
    const watcher = new PumpPortalWatcher({
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
      onTrade: (t) => trades.push(t),
      onNewToken: (mint) => launches.push(mint),
    });
    watcher.start();
    socket.emit("open");
    return { watcher, socket, trades, launches };
  };

  it("subscribes to new launches on connect and replays token subs", () => {
    const { watcher, socket } = start();
    expect(socket.commands()).toContainEqual({ method: "subscribeNewToken" });
    watcher.subscribeTokenTrade("MintA");
    expect(socket.commands()).toContainEqual({
      method: "subscribeTokenTrade",
      keys: ["MintA"],
    });
    expect(watcher.subscriptions()).toEqual(["MintA"]);
    watcher.stop();
    expect(socket.closed).toBe(true);
  });

  it("normalises both field spellings and skips bad sizes", () => {
    const { watcher, socket, trades } = start();
    socket.emit("message", {
      data: JSON.stringify({
        txType: "buy",
        mint: "MintA",
        solAmount: 1.5,
        traderPublicKey: "T1",
        price: 0.002,
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "sell",
        mint: "MintA",
        sol_amount: "0.25",
        trader: "T2",
      }),
    });
    // Non-numeric size: dropped rather than poisoning every average downstream.
    socket.emit("message", {
      data: JSON.stringify({ txType: "buy", mint: "MintA", solAmount: "abc" }),
    });
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      mint: "MintA",
      solAmount: 1.5,
      isBuy: true,
      trader: "T1",
      priceSol: 0.002,
    });
    expect(trades[1]).toMatchObject({
      solAmount: 0.25,
      isBuy: false,
      trader: "T2",
    });
    expect(trades[1]?.priceSol).toBeUndefined();
    watcher.stop();
  });

  it("routes a non-trade frame carrying a mint to onNewToken", () => {
    const { watcher, socket, launches, trades } = start();
    socket.emit("message", {
      data: JSON.stringify({ txType: "create", mint: "FreshMint" }),
    });
    expect(launches).toEqual(["FreshMint"]);
    expect(trades).toHaveLength(0);
    watcher.stop();
  });

  it("swallows malformed frames instead of throwing", () => {
    const { watcher, socket, trades, launches } = start();
    expect(() => {
      socket.emit("message", { data: "not json" });
      socket.emit("message", { data: "null" });
      socket.emit("message", { data: JSON.stringify([1, 2, 3]) });
    }).not.toThrow();
    expect(trades).toHaveLength(0);
    expect(launches).toHaveLength(0);
    watcher.stop();
  });

  it("ignores frames from a socket that has already been superseded", () => {
    const { watcher, socket, trades } = start();
    watcher.stop();
    socket.emit("message", {
      data: JSON.stringify({ txType: "buy", mint: "MintA", solAmount: 1 }),
    });
    expect(trades).toHaveLength(0);
    expect(watcher.connected).toBe(false);
  });
});
