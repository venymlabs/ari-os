import { describe, expect, it, vi } from "vitest";
import { createUtilityApi, type UtilityDataSource } from "../src/api/index.js";

const source:UtilityDataSource={
 networks:async()=>[{id:"eth",name:"Ethereum"}], search:async()=>[{address:"0xt"}], trending:async()=>[{address:"0xt",volume24hUsd:100,liquidityUsd:50,priceChange24hPercent:10}], newPairs:async()=>[], token:async()=>({address:"0xt",verified:true}), pair:async()=>({address:"0xp"}), ohlcv:async()=>[], trades:async()=>[], holders:async()=>[], riskInput:async()=>({token:{address:"0xt",verified:true}})
};
describe("read-only utility API",()=>{
 it("exposes all discovery and analytics endpoints with envelopes",async()=>{const api=createUtilityApi({source});
  for(const url of ["/health","/networks","/search?q=eth&network=eth","/trending?network=eth","/pairs/new?network=eth","/tokens/0xt?network=eth","/pairs/0xp?network=eth","/pairs/0xp/ohlcv?network=eth&period=hour","/pairs/0xp/trades?network=eth","/tokens/0xt/holders?network=eth","/tokens/0xt/risk?network=eth"]){const r=await api.inject({method:"GET",url});expect(r.statusCode,url).toBe(200);expect(r.json()).toHaveProperty("data");}
  expect((await api.inject({method:"GET",url:"/trending?network=eth"})).json().data[0].trendingScore).toBeGreaterThan(0);
 });
 it("provides schemas, CORS, validation, error envelope, timeout, and rate limiting",async()=>{const slow={...source,search:vi.fn(()=>new Promise<unknown[]>(()=>{}))};const api=createUtilityApi({source:slow,corsOrigin:"https://app.test",timeoutMs:5,rateLimit:{max:1,windowMs:10000}});
  expect(api.openapi.paths["/tokens/{address}/risk"]?.get).toBeTruthy();
  const invalid=await api.inject({method:"GET",url:"/search"});expect(invalid.statusCode).toBe(400);expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
  const timed=createUtilityApi({source:slow,timeoutMs:5});expect((await timed.inject({method:"GET",url:"/search?q=x"})).statusCode).toBe(504);
  const ok=await api.inject({method:"GET",url:"/health",headers:{origin:"https://app.test"}});expect(ok.headers["access-control-allow-origin"]).toBe("https://app.test");
  expect((await api.inject({method:"GET",url:"/health"})).statusCode).toBe(429);
 });
 it("rejects non-read methods",async()=>{expect((await createUtilityApi({source}).inject({method:"POST",url:"/search?q=x"})).statusCode).toBe(405)});
});
