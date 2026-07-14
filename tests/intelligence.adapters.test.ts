import { describe, expect, it, vi } from "vitest";
import {
  BlockscoutClient,
  DexScreenerClient,
  GeckoTerminalClient,
  IntelligenceError,
} from "../src/adapters/intelligence/index.js";

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("resilient intelligence clients", () => {
  it("retries retryable failures and normalizes rate limits", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "busy" }, 503))
      .mockResolvedValueOnce(json({ pairs: [] }));
    const client = new DexScreenerClient({
      fetch,
      retries: 1,
      retryDelayMs: 0,
    });
    await expect(client.search("eth")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const limited = new DexScreenerClient({
      fetch: vi.fn().mockResolvedValue(json({}, 429, { "retry-after": "2" })),
      retries: 0,
    });
    await expect(limited.search("eth")).rejects.toMatchObject({
      name: "IntelligenceError",
      source: "dexscreener",
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it("times out and rejects malformed provider data", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    await expect(
      new DexScreenerClient({
        fetch: hanging,
        timeoutMs: 5,
        retries: 0,
      }).search("x"),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(
      new DexScreenerClient({
        fetch: vi.fn().mockResolvedValue(json({ pairs: [{ bad: true }] })),
        retries: 0,
      }).search("x"),
    ).rejects.toBeInstanceOf(IntelligenceError);
  });

  it("supports DexScreener search, pair and token endpoints", async () => {
    const pair = {
      chainId: "ethereum",
      dexId: "uni",
      pairAddress: "0xpair",
      baseToken: { address: "0xbase", name: "Base", symbol: "BASE" },
      quoteToken: { address: "0xquote", name: "USD", symbol: "USD" },
      priceUsd: "1.2",
      liquidity: { usd: 1000 },
      volume: { h24: 50 },
      pairCreatedAt: 123,
    };
    const fetch = vi
      .fn()
      .mockImplementation((url) =>
        Promise.resolve(
          json(
            String(url).includes("token-pairs") ? [pair] : { pairs: [pair] },
          ),
        ),
      );
    const c = new DexScreenerClient({ fetch });
    expect((await c.search("base"))[0]?.priceUsd).toBe(1.2);
    await c.getPair("ethereum", "0xpair");
    await c.getTokenPairs("ethereum", "0xbase");
    expect(fetch.mock.calls.map((x) => String(x[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/latest/dex/search?q=base"),
        expect.stringContaining("/latest/dex/pairs/ethereum/0xpair"),
        expect.stringContaining("/token-pairs/v1/ethereum/0xbase"),
      ]),
    );
  });

  it("supports GeckoTerminal trending/new pools, pool detail, token metadata and OHLCV", async () => {
    const pool = {
      id: "eth_0xpool",
      type: "pool",
      attributes: {
        address: "0xpool",
        name: "BASE / USD",
        base_token_price_usd: "1.2",
        reserve_in_usd: "1000",
        volume_usd: { h24: "50" },
      },
      relationships: {
        base_token: { data: { id: "eth_0xbase", type: "token" } },
        quote_token: { data: { id: "eth_0xquote", type: "token" } },
        dex: { data: { id: "uni", type: "dex" } },
      },
    };
    const token = {
      id: "eth_0xbase",
      type: "token",
      attributes: {
        address: "0xbase",
        name: "Base",
        symbol: "BASE",
        decimals: 18,
        total_supply: "1000",
        price_usd: "1.2",
      },
    };
    const fetch = vi.fn().mockImplementation((u) =>
      String(u).includes("ohlcv")
        ? json({
            data: { attributes: { ohlcv_list: [[100, 1, 2, 0.5, 1.5, 10]] } },
          })
        : String(u).includes("tokens/0xbase")
          ? json({ data: token })
          : json({ data: [pool] }),
    );
    const c = new GeckoTerminalClient({ fetch });
    expect((await c.trendingPools("eth"))[0]?.address).toBe("0xpool");
    await c.newPools("eth");
    await c.getPool("eth", "0xpool");
    expect((await c.getToken("eth", "0xbase")).decimals).toBe(18);
    expect(await c.getOhlcv("eth", "0xpool", "hour")).toEqual([
      { timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
  });

  it("supports Blockscout token search/detail, holders and transfers", async () => {
    const token = {
      address: "0xbase",
      name: "Base",
      symbol: "BASE",
      decimals: "18",
      total_supply: "1000",
      exchange_rate: "1.2",
      holders_count: "7",
    };
    const fetch = vi.fn().mockImplementation((u) =>
      String(u).includes("holders")
        ? json({ items: [{ address: { hash: "0xholder" }, value: "10" }] })
        : String(u).includes("transfers")
          ? json({
              items: [
                {
                  from: { hash: "0xfrom" },
                  to: { hash: "0xto" },
                  total: { value: "2" },
                  timestamp: "2024-01-01T00:00:00Z",
                  transaction_hash: "0xtx",
                },
              ],
            })
          : String(u).includes("search")
            ? json({
                items: [
                  {
                    type: "token",
                    address: "0xbase",
                    name: "Base",
                    symbol: "BASE",
                  },
                ],
              })
            : json(token),
    );
    const c = new BlockscoutClient({
      baseUrl: "https://example/api/v2",
      fetch,
    });
    expect(await c.searchTokens("base")).toHaveLength(1);
    expect((await c.getToken("0xbase")).holdersCount).toBe(7);
    expect((await c.getTokenHolders("0xbase"))[0]?.address).toBe("0xholder");
    expect((await c.getTokenTransfers("0xbase"))[0]?.transactionHash).toBe(
      "0xtx",
    );
  });
});
