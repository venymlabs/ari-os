import { describe, expect, it, vi } from "vitest";
import {
  GatewayCore, GatewayError, requestFrameSchema, responseFrameSchema, eventFrameSchema,
  gatewayFrameJsonSchemas, canonicalRunId, canonicalSessionId, routingKey,
  type AuthVerifier, type PairingStore
} from "../src/gateway/core/index.js";

const principal={id:"user-1",roles:["operator"],scopes:["sessions:write"],capabilities:["chat"]};
const verifier:AuthVerifier={verify:vi.fn(async credential=>credential==="valid"?principal:null)};
const pairing:PairingStore={get:vi.fn(async (id:string)=>id==="paired"?{deviceId:id,principalId:"user-1",state:"paired" as const}:null)};
const core=(overrides={})=>new GatewayCore({verifier,pairingStore:pairing,supportedVersions:["1.1","1.0"],maxRequestBytes:1024,...overrides});
const request=(overrides={})=>({kind:"request" as const,version:"1.1",id:"req-1",method:"session.send",idempotencyKey:"idem-1",sessionId:"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",params:{message:"hi"},...overrides});

describe("gateway wire protocol",()=>{
 it("validates strict typed request, response, and event frames and exports JSON schemas",()=>{
  expect(requestFrameSchema.parse(request())).toMatchObject({kind:"request",id:"req-1"});
  expect(responseFrameSchema.parse({kind:"response",version:"1.1",id:"req-1",ok:true,result:{accepted:true}}).ok).toBe(true);
  expect(eventFrameSchema.parse({kind:"event",version:"1.1",id:"evt-1",event:"session.message",sequence:1,sessionId:"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",payload:{}}).kind).toBe("event");
  expect(()=>requestFrameSchema.parse({...request(),extra:true})).toThrow();
  expect(gatewayFrameJsonSchemas.request).toMatchObject({type:"object"});
 });
 it("negotiates the highest mutually supported version and rejects no overlap",()=>{
  expect(core().negotiate(["1.0","1.1","2.0"])).toBe("1.1");
  expect(()=>core().negotiate(["2.0"])).toThrowError(GatewayError);
 });
});

describe("identity, authorization, and isolation",()=>{
 it("authenticates using the injected verifier and binds paired devices",async()=>{
  const context=await core().authenticate({credential:"valid",deviceId:"paired"});
  expect(context.principal).toEqual(principal); expect(context.device?.state).toBe("paired");
  await expect(core().authenticate({credential:"bad"})).rejects.toMatchObject({code:"UNAUTHENTICATED"});
  await expect(core().authenticate({credential:"valid",deviceId:"unknown"})).rejects.toMatchObject({code:"DEVICE_NOT_PAIRED"});
 });
 it("enforces roles, scopes, and capabilities without exposing signing authority",async()=>{
  const gateway=core(); const context=await gateway.authenticate({credential:"valid"});
  expect(()=>gateway.authorize(context,{roles:["operator"],scopes:["sessions:write"],capabilities:["chat"]})).not.toThrow();
  expect(()=>gateway.authorize(context,{scopes:["wallet:sign"]})).toThrowError(/forbidden/i);
  expect(context.principal).not.toHaveProperty("signing");
 });
 it("isolates sessions by principal and account",async()=>{
  const gateway=core(); const context=await gateway.authenticate({credential:"valid"});
  gateway.claimSession(context,"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV","acct-a");
  expect(()=>gateway.assertSessionAccess(context,"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV","acct-a")).not.toThrow();
  expect(()=>gateway.assertSessionAccess({...context,principal:{...principal,id:"other"}},"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV","acct-a")).toThrowError(/isolated/i);
  expect(()=>gateway.assertSessionAccess(context,"ses_01ARZ3NDEKTSV4RRFFQ69G5FAV","acct-b")).toThrowError(/isolated/i);
 });
});

describe("canonical identifiers and routing",()=>{
 it("creates canonical sortable run and session IDs",()=>{
  expect(canonicalRunId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("run_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(canonicalSessionId("ses_01arz3ndektsv4rrffq69g5fav")).toBe("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(()=>canonicalRunId("../bad")).toThrow();
 });
 it("routes deterministically with thread > peer > account > agent precedence",()=>{
  expect(routingKey({agentId:"a",accountId:"z",peerId:"p",threadId:"t"})).toBe("thread:t");
  expect(routingKey({agentId:"a",accountId:"z",peerId:"p"})).toBe("peer:p");
  expect(routingKey({agentId:"a",accountId:"z"})).toBe("account:z");
  expect(routingKey({agentId:"a"})).toBe("agent:a");
  expect(()=>routingKey({})).toThrow();
 });
});

describe("transport-neutral request handling",()=>{
 it("rejects oversized requests before authentication",async()=>{
  const isolatedVerifier:AuthVerifier={verify:vi.fn(async()=>principal)};
  const tiny=core({maxRequestBytes:20,verifier:isolatedVerifier});
  await expect(tiny.handle(JSON.stringify(request()),{credential:"valid"})).rejects.toMatchObject({code:"REQUEST_TOO_LARGE"});
  expect(isolatedVerifier.verify).not.toHaveBeenCalled();
 });
 it("deduplicates idempotent requests within a principal and session",async()=>{
  const gateway=core(); let calls=0; gateway.register("session.send",async()=>({calls:++calls}));
  const a=await gateway.handle(request(),{credential:"valid"}); const b=await gateway.handle(request(),{credential:"valid"});
  expect(a).toEqual(b); expect(calls).toBe(1);
  await expect(gateway.handle({...request(),params:{message:"different"}},{credential:"valid"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
 });
 it("reports a safe health snapshot",()=>{
  expect(core().health()).toMatchObject({status:"ok",transport:"in-process",supportedVersions:["1.1","1.0"],maxRequestBytes:1024});
  expect(core().health()).not.toHaveProperty("verifier");
 });
});
