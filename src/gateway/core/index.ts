import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const identifier=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const version=z.string().regex(/^\d+\.\d+$/);
const base={version,id:identifier};
export const requestFrameSchema=z.object({...base,kind:z.literal("request"),method:identifier,idempotencyKey:identifier,sessionId:z.string().optional(),runId:z.string().optional(),params:z.unknown()}).strict();
export const responseFrameSchema=z.object({...base,kind:z.literal("response"),ok:z.boolean(),result:z.unknown().optional(),error:z.object({code:identifier,message:z.string(),details:z.unknown().optional()}).strict().optional()}).strict().superRefine((x,c)=>{if(x.ok&&x.error)c.addIssue({code:"custom",message:"successful response cannot contain error"});if(!x.ok&&!x.error)c.addIssue({code:"custom",message:"failed response requires error"})});
export const eventFrameSchema=z.object({...base,kind:z.literal("event"),event:identifier,sequence:z.number().int().nonnegative(),sessionId:z.string().optional(),runId:z.string().optional(),payload:z.unknown()}).strict();
export type RequestFrame=z.infer<typeof requestFrameSchema>;
export type ResponseFrame=z.infer<typeof responseFrameSchema>;
export type EventFrame=z.infer<typeof eventFrameSchema>;
export const gatewayFrameJsonSchemas={request:zodToJsonSchema(requestFrameSchema),response:zodToJsonSchema(responseFrameSchema),event:zodToJsonSchema(eventFrameSchema)};

export interface Principal {readonly id:string;readonly roles:readonly string[];readonly scopes:readonly string[];readonly capabilities:readonly string[]}
export interface AuthVerifier {verify(credential:string):Promise<Principal|null>}
export interface PairingRecord {deviceId:string;principalId:string;state:"pending"|"paired"|"revoked"}
export interface PairingStore {get(deviceId:string):Promise<PairingRecord|null>}
export interface AuthInput {credential:string;deviceId?:string}
export interface GatewayContext {principal:Principal;device?:PairingRecord}
export interface AuthorizationRequirement {roles?:readonly string[];scopes?:readonly string[];capabilities?:readonly string[]}
export class GatewayError extends Error {constructor(readonly code:string,message:string,readonly details?:unknown){super(message);this.name="GatewayError"}}

const canonical=(prefix:"run"|"ses",value:string)=>{const raw=value.toUpperCase().replace(new RegExp(`^${prefix.toUpperCase()}_`),"");if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw))throw new GatewayError("INVALID_ID",`invalid canonical ${prefix} id`);return `${prefix}_${raw}`};
export const canonicalRunId=(value?:string)=>canonical("run",value??randomBytes(16).toString("hex").slice(0,26));
export const canonicalSessionId=(value?:string)=>canonical("ses",value??randomBytes(16).toString("hex").slice(0,26));
export interface ChannelRoute {agentId?:string;accountId?:string;peerId?:string;threadId?:string}
export function routingKey(route:ChannelRoute){for(const [kind,value] of [["thread",route.threadId],["peer",route.peerId],["account",route.accountId],["agent",route.agentId]] as const)if(value){const clean=identifier.parse(value);return `${kind}:${clean}`}throw new GatewayError("INVALID_ROUTE","route requires agent, account, peer, or thread")}

type Handler=(request:RequestFrame,context:GatewayContext)=>unknown|Promise<unknown>;
export interface GatewayConfig {verifier:AuthVerifier;pairingStore:PairingStore;supportedVersions:readonly string[];maxRequestBytes:number;now?:()=>Date}
export class GatewayCore {
 private handlers=new Map<string,Handler>(); private idempotency=new Map<string,{hash:string,response:ResponseFrame}>(); private sessions=new Map<string,{principalId:string;accountId:string}>(); private started:number;
 constructor(private config:GatewayConfig){if(!config.supportedVersions.length||config.maxRequestBytes<1)throw new Error("invalid gateway configuration");this.started=Date.now()}
 negotiate(offered:readonly string[]){const match=this.config.supportedVersions.find(v=>offered.includes(v));if(!match)throw new GatewayError("VERSION_NOT_SUPPORTED","no mutually supported gateway protocol version",{supported:this.config.supportedVersions});return match}
 async authenticate(input:AuthInput):Promise<GatewayContext>{const principal=await this.config.verifier.verify(input.credential);if(!principal)throw new GatewayError("UNAUTHENTICATED","invalid authentication credential");if(!input.deviceId)return{principal};const device=await this.config.pairingStore.get(input.deviceId);if(!device||device.state!=="paired"||device.principalId!==principal.id)throw new GatewayError("DEVICE_NOT_PAIRED","device is not paired to this principal");return{principal,device}}
 authorize(context:GatewayContext,requirements:AuthorizationRequirement){for(const [field,actual] of [[requirements.roles,context.principal.roles],[requirements.scopes,context.principal.scopes],[requirements.capabilities,context.principal.capabilities]] as const)if(field?.some(x=>!actual.includes(x)))throw new GatewayError("FORBIDDEN","forbidden: insufficient authority")}
 claimSession(context:GatewayContext,sessionId:string,accountId:string){const id=canonicalSessionId(sessionId),existing=this.sessions.get(id);if(existing&&(existing.principalId!==context.principal.id||existing.accountId!==accountId))throw new GatewayError("SESSION_ISOLATED","session isolated from principal/account");this.sessions.set(id,{principalId:context.principal.id,accountId})}
 assertSessionAccess(context:GatewayContext,sessionId:string,accountId:string){const owner=this.sessions.get(canonicalSessionId(sessionId));if(!owner||owner.principalId!==context.principal.id||owner.accountId!==accountId)throw new GatewayError("SESSION_ISOLATED","session isolated from principal/account")}
 register(method:string,handler:Handler){if(this.handlers.has(method))throw new Error(`duplicate gateway method ${method}`);this.handlers.set(identifier.parse(method),handler)}
 async handle(raw:unknown,auth:AuthInput):Promise<ResponseFrame>{let value:unknown=raw;if(typeof raw==="string"){if(Buffer.byteLength(raw)>this.config.maxRequestBytes)throw new GatewayError("REQUEST_TOO_LARGE","request exceeds size limit");try{value=JSON.parse(raw)}catch{throw new GatewayError("INVALID_FRAME","request is not valid JSON")}}else{let encoded:string;try{encoded=JSON.stringify(raw)}catch{throw new GatewayError("INVALID_FRAME","request is not serializable")};if(Buffer.byteLength(encoded)>this.config.maxRequestBytes)throw new GatewayError("REQUEST_TOO_LARGE","request exceeds size limit")}
  const parsed=requestFrameSchema.safeParse(value);if(!parsed.success)throw new GatewayError("INVALID_FRAME","invalid request frame",parsed.error.flatten());const request=parsed.data;if(!this.config.supportedVersions.includes(request.version))throw new GatewayError("VERSION_NOT_SUPPORTED","unsupported request version");const context=await this.authenticate(auth);const handler=this.handlers.get(request.method);if(!handler)throw new GatewayError("METHOD_NOT_FOUND","gateway method not found");const hash=createHash("sha256").update(JSON.stringify({method:request.method,params:request.params,sessionId:request.sessionId,runId:request.runId})).digest("hex");const key=`${context.principal.id}:${request.sessionId??"-"}:${request.idempotencyKey}`,prior=this.idempotency.get(key);if(prior){if(prior.hash!==hash)throw new GatewayError("IDEMPOTENCY_CONFLICT","idempotency key reused with different request");return prior.response}const result=await handler(request,context);const response=responseFrameSchema.parse({kind:"response",version:request.version,id:request.id,ok:true,result});this.idempotency.set(key,{hash,response});return response}
 health(){return{status:"ok" as const,transport:"in-process" as const,supportedVersions:[...this.config.supportedVersions],maxRequestBytes:this.config.maxRequestBytes,uptimeMs:Math.max(0,Date.now()-this.started),registeredMethods:this.handlers.size}}
}
