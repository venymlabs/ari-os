import { describe, expect, it } from "vitest";
import { MarketAggregator, type MarketPair } from "../src/adapters/intelligence/index.js";

const pair=(source:"dexscreener"|"geckoterminal",priceUsd:number,liquidityUsd:number):MarketPair=>({source,chainId:"eth",address:"0xpair",baseToken:{address:"0xbase"},quoteToken:{address:"0xquote"},priceUsd,liquidityUsd,volume24hUsd:100,raw:{}});

describe("cross-source market aggregation",()=>{
  it("merges matching markets with provenance and confidence",async()=>{
    const aggregator=new MarketAggregator({dexscreener:{search:async()=>[pair("dexscreener",1,1000)]},geckoterminal:{searchPools:async()=>[pair("geckoterminal",1.02,900)]}});
    const [market]=await aggregator.search("base",{network:"eth"});
    expect(market?.sources).toEqual(["dexscreener","geckoterminal"]);
    expect(market?.priceUsd).toBeCloseTo(1.01);
    expect(market?.confidence).toBeGreaterThan(.7);
    expect(market?.provenance).toHaveLength(2);
  });
  it("returns partial results and records failed sources",async()=>{
    const aggregator=new MarketAggregator({dexscreener:{search:async()=>[pair("dexscreener",1,1000)]},geckoterminal:{searchPools:async()=>{throw new Error("down")}}});
    const [market]=await aggregator.search("base",{network:"eth"});
    expect(market?.confidence).toBeLessThan(.7);
    expect(market?.errors[0]?.source).toBe("geckoterminal");
  });
});
