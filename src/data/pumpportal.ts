/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS: the `ws` package
 * is replaced by Node's built-in global `WebSocket` (the WHATWG API, stable
 * since Node 22), so the keyless feed adds no production dependency and no
 * audit surface. That swap costs the `terminate()` / `removeAllListeners()`
 * calls the original relied on, so socket generations are tracked explicitly
 * instead — see `#connect`.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TapeTrade } from "./tape.js";

/**
 * Live feed off PumpPortal's KEYLESS public WebSocket — no API key, no credits,
 * no account. Subscribes to new-token launches on connect, lets callers stream
 * per-token trades, and maps each raw message into a clean {@link TapeTrade}.
 *
 * Resilient by design: exponential-backoff reconnect with jitter, a
 * stale-message watchdog, and a never-throw message handler (a bad frame is
 * swallowed, not propagated). Every active subscription is re-sent on each
 * (re)connect, so a drop is transparent to callers.
 *
 * Nothing here is a safety control. The feed going quiet does not loosen a
 * guard: an empty tape scores 60 on rug-heat, which the pools default rejects.
 * A dead feed therefore means no curve buys, not unchecked ones.
 */

export const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";
const MAX_BACKOFF_MS = 30_000;
const STALE_TIMEOUT_MS = 60_000;

/**
 * The slice of the WHATWG WebSocket this module uses.
 *
 * Declared structurally so tests can inject a fake socket without a network,
 * and so the module does not depend on `lib.dom` being in `types`.
 */
export interface FeedSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

/** How a socket gets created. Overridable so tests never open a real one. */
export type FeedSocketFactory = (url: string) => FeedSocket;

/** `WebSocket.OPEN`. Hard-coded because the constructor is resolved lazily. */
const OPEN = 1;

export interface PumpPortalOptions {
  readonly url?: string;
  readonly onTrade?: ((t: TapeTrade) => void) | undefined;
  readonly onNewToken?: ((mint: string, meta: unknown) => void) | undefined;
  /** Injected in tests; defaults to Node's global `WebSocket`. */
  readonly createSocket?: FeedSocketFactory | undefined;
}

/** Loose shape of an inbound frame — every field is optional/defensive. */
interface RawMessage {
  txType?: string;
  type?: string;
  mint?: string;
  solAmount?: number | string;
  sol_amount?: number | string;
  traderPublicKey?: string;
  trader?: string;
  price?: number | string;
  [k: string]: unknown;
}

function defaultSocketFactory(url: string): FeedSocket {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown })
    .WebSocket;
  if (!ctor) {
    throw new Error(
      "no global WebSocket: ARI OS requires Node >= 22, where the WHATWG " +
        "WebSocket is built in. The PumpPortal feed deliberately adds no " +
        "websocket dependency.",
    );
  }
  return new ctor(url) as FeedSocket;
}

export class PumpPortalWatcher {
  readonly #url: string;
  readonly #onTrade: ((t: TapeTrade) => void) | undefined;
  readonly #onNewToken: ((mint: string, meta: unknown) => void) | undefined;
  readonly #createSocket: FeedSocketFactory;

  #ws: FeedSocket | null = null;
  /**
   * Monotonic socket id. The WHATWG API has no `removeAllListeners()`, so a
   * closed socket's late events are ignored by comparing against this instead.
   */
  #generation = 0;
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #staleTimer: ReturnType<typeof setInterval> | null = null;
  #lastMessageAt = 0;
  #connected = false;

  /** Mints with an active per-token subscription (replayed on reconnect). */
  readonly #tokenSubs = new Set<string>();

  constructor(opts: PumpPortalOptions = {}) {
    this.#url = opts.url ?? PUMPPORTAL_URL;
    this.#onTrade = opts.onTrade;
    this.#onNewToken = opts.onNewToken;
    this.#createSocket = opts.createSocket ?? defaultSocketFactory;
  }

  /** True while a socket is open. The console reports this as feed liveness. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Epoch ms of the last frame received, or 0 if none ever arrived. */
  get lastMessageAt(): number {
    return this.#lastMessageAt;
  }

  /** Open the socket and begin streaming. Idempotent while already connected. */
  start(): void {
    this.#stopped = false;
    if (this.#ws) return;
    this.#connect();
  }

  /** Tear everything down: no more reconnects, watchdog cleared, socket closed. */
  stop(): void {
    this.#stopped = true;
    this.#clearReconnect();
    this.#clearWatchdog();
    this.#connected = false;
    const ws = this.#ws;
    this.#ws = null;
    // Bump the generation FIRST so any event still in flight is ignored.
    this.#generation += 1;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore — socket may already be closing.
      }
    }
  }

  /** Subscribe to live trades for a mint. Safe to call before the socket opens. */
  subscribeTokenTrade(mint: string): void {
    this.#tokenSubs.add(mint);
    this.#send({ method: "subscribeTokenTrade", keys: [mint] });
  }

  /** Stop receiving trades for a mint. */
  unsubscribeTokenTrade(mint: string): void {
    this.#tokenSubs.delete(mint);
    this.#send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }

  /** Mints this watcher is currently subscribed to. */
  subscriptions(): string[] {
    return [...this.#tokenSubs];
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#clearReconnect();

    const generation = ++this.#generation;
    const mine = () => generation === this.#generation && !this.#stopped;

    let ws: FeedSocket;
    try {
      ws = this.#createSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.addEventListener("open", () => {
      if (!mine()) return;
      this.#attempt = 0;
      this.#connected = true;
      this.#lastMessageAt = Date.now();
      this.#startWatchdog();
      // Always (re)subscribe to new launches, then replay any per-token subs.
      this.#send({ method: "subscribeNewToken" });
      for (const mint of this.#tokenSubs) {
        this.#send({ method: "subscribeTokenTrade", keys: [mint] });
      }
    });

    ws.addEventListener("message", (ev: { data: unknown }) => {
      if (!mine()) return;
      this.#lastMessageAt = Date.now();
      this.#handleMessage(ev.data);
    });

    ws.addEventListener("close", () => {
      if (!mine()) return;
      this.#connected = false;
      this.#clearWatchdog();
      if (this.#ws === ws) this.#ws = null;
      this.#scheduleReconnect();
    });

    // Swallow errors — a 'close' follows and drives the reconnect.
    ws.addEventListener("error", () => {});
  }

  /** Parse + route a frame. Never throws: any bad shape is ignored. */
  #handleMessage(data: unknown): void {
    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? new TextDecoder().decode(data)
            : String(data);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return;
      const d = parsed as RawMessage;

      const kind = d.txType ?? d.type;
      const mint = typeof d.mint === "string" ? d.mint : undefined;

      // Trade event: needs a buy/sell kind + a mint + a sol amount field.
      if (
        (kind === "buy" || kind === "sell") &&
        mint &&
        (d.solAmount !== undefined || d.sol_amount !== undefined)
      ) {
        const priceRaw = d.price;
        const solAmount = Number(d.solAmount ?? d.sol_amount ?? 0);
        // A non-finite size would poison every downstream average.
        if (!Number.isFinite(solAmount) || solAmount < 0) return;
        const priceSol =
          priceRaw !== undefined && priceRaw !== null
            ? Number(priceRaw)
            : undefined;
        const trade: TapeTrade = {
          mint,
          solAmount,
          isBuy: kind === "buy",
          trader: d.traderPublicKey ?? d.trader ?? "",
          ts: Date.now(),
          priceSol:
            priceSol !== undefined && Number.isFinite(priceSol)
              ? priceSol
              : undefined,
        };
        this.#onTrade?.(trade);
        return;
      }

      // New-token launch event: carries a mint but no trade kind.
      if (mint && kind !== "buy" && kind !== "sell") {
        this.#onNewToken?.(mint, d);
      }
    } catch {
      // Bad frame — ignore by design.
    }
  }

  /** Send a JSON command if the socket is open; silently no-op otherwise. */
  #send(payload: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore — a reconnect will replay subscriptions.
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    // Exponential backoff with jitter, capped at MAX_BACKOFF_MS.
    const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.#attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    // A market feed must never be the reason the process refuses to exit.
    this.#reconnectTimer.unref?.();
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /** Watchdog: if no frame arrives within STALE_TIMEOUT_MS, force a reconnect. */
  #startWatchdog(): void {
    this.#clearWatchdog();
    this.#staleTimer = setInterval(() => {
      if (this.#stopped) return;
      if (Date.now() - this.#lastMessageAt > STALE_TIMEOUT_MS) {
        const ws = this.#ws;
        this.#clearWatchdog();
        this.#connected = false;
        if (ws) {
          // WHATWG has no `terminate()`; closing is the strongest move
          // available. The generation bump makes the old socket's late frames
          // inert either way.
          this.#ws = null;
          this.#generation += 1;
          try {
            ws.close();
          } catch {
            // ignore — the reconnect below is what matters.
          }
        }
        this.#scheduleReconnect();
      }
    }, STALE_TIMEOUT_MS / 2);
    this.#staleTimer.unref?.();
  }

  #clearWatchdog(): void {
    if (this.#staleTimer) {
      clearInterval(this.#staleTimer);
      this.#staleTimer = null;
    }
  }
}
