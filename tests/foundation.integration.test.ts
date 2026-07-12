import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/index.js";
import { DurableRunStore } from "../src/storage/run-store.js";
import { checkDatabases } from "../src/storage/maintenance.js";
import { ToolRegistry } from "../src/agent/tools/registry.js";
import { RegistryDispatcher, ModelRouterProvider } from "../src/app/adapters.js";
import { registerBuiltInTools } from "../src/tools/index.js";
import { createApplication } from "../src/app/index.js";

const dirs:string[]=[];
const temp=()=>{const d=mkdtempSync(join(tmpdir(),"raos-"));dirs.push(d);return d};
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));

describe("validated executable foundation",()=>{
 it("creates an absolute private data layout and defaults to testnet read-only",()=>{const d=temp();const c=loadConfig({NODE_ENV:"test",DATA_DIR:d},d);expect(c.network).toBe("testnet");expect(c.execution).toBe("read-only");expect(c.paths.sessions).toBe(join(d,"sessions.sqlite"));expect(statSync(d).mode&0o777).toBe(0o700)});
 it("rejects relative data dirs and requires a mainnet double opt-in",()=>{expect(()=>loadConfig({NODE_ENV:"test",DATA_DIR:"relative"},temp())).toThrow(/absolute/);const d=temp();expect(()=>loadConfig({NODE_ENV:"test",DATA_DIR:d,NETWORK:"mainnet",MAINNET_ENABLED:"true"},d)).toThrow(/double opt-in/i);expect(loadConfig({NODE_ENV:"test",DATA_DIR:d,NETWORK:"mainnet",MAINNET_ENABLED:"true",MAINNET_ACKNOWLEDGE_RISK:"I_ACKNOWLEDGE_MAINNET_RISK"},d).network).toBe("mainnet")});
});

describe("durable wiring",()=>{
 it("retains tenant runs, idempotency and SSE sequence after restart",()=>{const p=join(temp(),"runs.sqlite");let s=new DurableRunStore(p,2);s.create({id:"r",tenantId:"t",sessionId:"s",status:"running",createdAt:1,events:[]},"key");s.emit("r","one",{});s.emit("r","two",{});s.close();s=new DurableRunStore(p,2);expect(s.idempotent("t","key")?.id).toBe("r");expect(s.get("r","t")?.events.map(e=>e.id)).toEqual([1,2]);expect(s.get("r","other")).toBeUndefined();s.close();expect(checkDatabases([p])[0]).toMatchObject({integrity:"ok"})});
 it("adapts registry capabilities and model schemas without casts",async()=>{const registry=new ToolRegistry();registerBuiltInTools(registry,{market:{networks:async()=>["testnet"]}});const dispatcher=new RegistryDispatcher(registry,["trading:market-data"]);expect(dispatcher.classify("market.networks").effect).toBe("read");expect((await dispatcher.dispatch({id:"1",name:"market.networks",arguments:{}},{signal:new AbortController().signal})).ok).toBe(true);const requests:any[]=[];const router={complete:async(r:any)=>(requests.push(r),{id:"x",provider:"p",model:"m",content:"ok",toolCalls:[],finishReason:"stop",usage:{inputTokens:1,outputTokens:1,totalTokens:2}})};const provider=new ModelRouterProvider(router as any,registry,{capabilities:["trading:market-data"]});expect((await provider.complete({messages:[{role:"user",content:"hi"}]},new AbortController().signal)).message.content).toBe("ok");expect(requests[0].tools.some((x:any)=>x.name==="market.networks")).toBe(true)});
 it("registers bounded read/proposal tools and never signing or broadcast",()=>{const r=new ToolRegistry();registerBuiltInTools(r,{market:{networks:async()=>[]},simulation:{simulate:async()=>({success:true,evidenceRef:"e"})}});const tools=r.listPrivileged();expect(tools.some(t=>t.name==="simulation.transaction"&&t.effect==="trade")).toBe(true);expect(tools.every(t=>!/sign|broadcast|private|wallet/i.test(t.name))).toBe(true)});
 it("owns lifecycle, recovery, readiness and idempotent stop",async()=>{const c=loadConfig({NODE_ENV:"test",DATA_DIR:temp()},process.cwd());const app=createApplication(c,{modelProvider:{id:"test",complete:async()=>({message:{role:"assistant",content:"READY"}})}});expect(app.ready()).toBe(false);await app.start();expect(app.ready()).toBe(true);await app.stop();await app.stop();expect(app.ready()).toBe(false)});
});
