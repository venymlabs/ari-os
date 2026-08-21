/*
 * Portions of this file are derived from Aetheria (https://github.com/venymlabs/aetheria),
 * Copyright Venym Labs, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/APACHE-2.0.txt. Modified for ARI OS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Meteora's keyless public data API — pool discovery without an RPC bill.
 *
 * Base URL is `https://dlmm.datapi.meteora.ag` (the older `dlmm-api.meteora.ag`
 * host now 404s on every path). Two endpoints are used: `GET /pools` (paginated,
 * ~122k pools, sorted by TVL) and `GET /pools/{address}`.
 *
 * **Known limitation, stated rather than hidden:** the list endpoint accepts no
 * mint filter — every filter parameter that looks plausible (`search_term`,
 * `token_mints`, `include_token_mints`, `mint`, …) is silently ignored and the
 * unfiltered set comes back. So `listPools` fetches the deepest `maxPages` pages
 * and filters client-side, and reports how many pools it actually examined via
 * `scannedPools`. A pool for a small memecoin will fall outside that window; the
 * answer for those is `getPool(address)` with an address the caller already has,
 * which always works. Discovery by on-chain `getProgramAccounts` scan would be
 * exhaustive but needs a paid RPC, so it is deliberately not the default.
 */

const DEFAULT_BASE = "https://dlmm.datapi.meteora.ag";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;

export interface DataApiToken {
  readonly address: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly decimals: number;
  readonly is_verified?: boolean;
  readonly freeze_authority_disabled?: boolean;
  readonly price?: number;
}

export interface DataApiPool {
  readonly address: string;
  readonly name?: string;
  readonly token_x: DataApiToken;
  readonly token_y: DataApiToken;
  readonly token_x_amount?: number;
  readonly token_y_amount?: number;
  readonly created_at?: number;
  readonly pool_config?: {
    readonly bin_step: number;
    readonly base_fee_pct?: number;
    readonly max_fee_pct?: number;
    readonly protocol_fee_pct?: number;
  };
  readonly dynamic_fee_pct?: number;
  readonly tvl?: number;
  readonly current_price?: number;
  readonly apr?: number;
  readonly apy?: number;
  readonly volume?: Record<string, number>;
  readonly fees?: Record<string, number>;
  readonly is_blacklisted?: boolean;
  readonly launchpad?: string;
  readonly tags?: readonly string[];
}

interface PoolsPage {
  readonly total: number;
  readonly pages: number;
  readonly current_page: number;
  readonly page_size: number;
  readonly data: readonly DataApiPool[];
}

export interface ListResult {
  readonly pools: readonly DataApiPool[];
  /** How many pools were examined before filtering — the honest scope of the answer. */
  readonly scannedPools: number;
  /** True when the scan window was exhausted, i.e. the answer may be incomplete. */
  readonly truncated: boolean;
}

export interface MeteoraDataApiOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly timeoutMs?: number;
}

export class MeteoraDataApiError extends Error {}

export class MeteoraDataApi {
  #base: string;
  #fetch: typeof fetch;
  #maxPages: number;
  #pageSize: number;
  #timeoutMs: number;

  constructor(opts: MeteoraDataApiOptions = {}) {
    this.#base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
    this.#pageSize = Math.max(
      1,
      Math.min(200, opts.pageSize ?? DEFAULT_PAGE_SIZE),
    );
    this.#timeoutMs = opts.timeoutMs ?? 12_000;
  }

  async #json<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(`${this.#base}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new MeteoraDataApiError(
          `Meteora data API ${res.status} for ${path}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getPool(address: string): Promise<DataApiPool> {
    return this.#json<DataApiPool>(`/pools/${encodeURIComponent(address)}`);
  }

  /**
   * Deepest pools containing `mint` on either side. Scans at most
   * `maxPages × pageSize` pools ordered by TVL and filters locally — see the file
   * header for why. Blacklisted pools are dropped unconditionally.
   */
  async listPoolsForMint(mint: string, limit = 10): Promise<ListResult> {
    const matched: DataApiPool[] = [];
    let scanned = 0;
    let truncated = true;

    for (let page = 1; page <= this.#maxPages; page++) {
      const res = await this.#json<PoolsPage>(
        `/pools?page=${page}&page_size=${this.#pageSize}&sort_key=tvl&order_by=desc`,
      );
      const rows = res.data ?? [];
      scanned += rows.length;
      for (const p of rows) {
        if (p.is_blacklisted) continue;
        if (p.token_x?.address === mint || p.token_y?.address === mint)
          matched.push(p);
      }
      if (matched.length >= limit)
        return {
          pools: matched.slice(0, limit),
          scannedPools: scanned,
          truncated: true,
        };
      if (rows.length < this.#pageSize || page >= (res.pages ?? page)) {
        truncated = false;
        break;
      }
    }
    return { pools: matched.slice(0, limit), scannedPools: scanned, truncated };
  }
}
