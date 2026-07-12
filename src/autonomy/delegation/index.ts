export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CapabilityEffect = "read" | "write" | "execute" | "network";
export interface CapabilityGrant { name:string; effect:CapabilityEffect }
export interface CapabilityEnforcer { authorize(capability:string, metadata:{sessionId:string;parentSessionId:string}):boolean }
export interface ChildRuntimeInput { task:string;sessionId:string;context:unknown;model?:unknown;capabilities:readonly string[];maxIterations:number;deadline:number;signal:AbortSignal;metadata:{parentSessionId:string;depth:number} }
export interface ChildRuntimeResult { summary:string;iterations:number;costUsd:number;details?:unknown }
export interface ChildRuntime { run(input:ChildRuntimeInput):Promise<ChildRuntimeResult> }
export interface SpawnRequest { task:string;parentSessionId:string;parentCapabilities:readonly string[];requestedCapabilities:readonly string[];depth?:number;context?:unknown;model?:unknown }
export interface DelegationResult { sessionId:string;parentSessionId:string;status:Exclude<DelegationStatus,"queued"|"running">;summary?:string;details?:unknown;iterations?:number;costUsd?:number;error?:string;announced:boolean;archived:boolean }
export interface DelegationHandle { readonly sessionId:string;readonly status:DelegationStatus;readonly result:Promise<DelegationResult>;cancel(reason?:unknown):void }
export interface DelegationLimits { maxDepth:number;maxChildren:number;maxIterations:number;deadlineMs:number;maxCostUsd:number;concurrency:number }
export interface DelegationOptions {
 runtimeFactory:(metadata:{sessionId:string;parentSessionId:string;depth:number})=>ChildRuntime;limits?:Partial<DelegationLimits>;
 capabilities?:readonly CapabilityGrant[]; capabilityEnforcer?:CapabilityEnforcer;
 verifyResult?:(result:ChildRuntimeResult,metadata:{sessionId:string;parentSessionId:string})=>boolean|Promise<boolean>; verifierTimeoutMs?:number;
 announce?:(result:DelegationResult)=>void|Promise<void>;archive?:(result:DelegationResult)=>void|Promise<void>;
}
export class DelegationError extends Error { constructor(message:string){super(message);this.name="DelegationError"} }
const defaults:DelegationLimits={maxDepth:2,maxChildren:4,maxIterations:8,deadlineMs:30_000,maxCostUsd:1,concurrency:2};
const defaultCapabilities:CapabilityGrant[]=[{name:"market:read",effect:"read"}];
interface Entry { request:SpawnRequest;id:string;depth:number;status:DelegationStatus;controller:AbortController;resolve:(r:DelegationResult)=>void;settled:boolean;counted:boolean }
const terminal=(s:DelegationStatus)=>s==="completed"||s==="failed"||s==="cancelled";
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
function deepFreeze<T>(v:T,seen=new WeakSet<object>()):T { if(v&&typeof v==="object"&&!seen.has(v as object)){seen.add(v as object);for(const x of Object.values(v as object))deepFreeze(x,seen);Object.freeze(v)}return v }
function boundary<T>(v:T,label:string):T { if(v===undefined||v===null)return v;try{return deepFreeze(structuredClone(v))}catch{throw new DelegationError(`${label} must be cloneable`)} }
export class DelegationManager {
 readonly #options:DelegationOptions;readonly #limits:DelegationLimits;readonly #allowed:Set<string>;readonly #queue:Entry[]=[];readonly #entries=new Map<string,Entry>();readonly #counts=new Map<string,number>();#active=0;#sequence=0;
 constructor(options:DelegationOptions){this.#options=options;this.#limits={...defaults,...options.limits};for(const[k,v]of Object.entries(this.#limits))if(!Number.isFinite(v)||v<=0)throw new DelegationError(`${k} must be positive`);const grants=options.capabilities??defaultCapabilities;if(grants.some(g=>g.effect!=="read"))throw new DelegationError("delegated capabilities must be read-only");this.#allowed=new Set(grants.map(g=>g.name))}
 spawn(request:SpawnRequest):DelegationHandle {
  const depth=(request.depth??0)+1;if(depth>this.#limits.maxDepth)throw new DelegationError("maximum delegation depth exceeded");
  const count=this.#counts.get(request.parentSessionId)??0;if(count>=this.#limits.maxChildren)throw new DelegationError("maximum children exceeded");
  const capabilities=request.requestedCapabilities.filter(c=>request.parentCapabilities.includes(c)&&this.#allowed.has(c));if(!capabilities.length)throw new DelegationError("no permitted read-only capabilities");
  const safeRequest:SpawnRequest={...request,context:boundary(request.context,"context"),model:boundary(request.model,"model"),parentCapabilities:boundary([...request.parentCapabilities],"capabilities"),requestedCapabilities:boundary(capabilities,"capabilities")};
  const id=`${request.parentSessionId}:child:${++this.#sequence}`;let resolve!:(r:DelegationResult)=>void;const result=new Promise<DelegationResult>(r=>resolve=r);const entry:Entry={request:safeRequest,id,depth,status:"queued",controller:new AbortController(),resolve,settled:false,counted:true};
  this.#entries.set(id,entry);this.#counts.set(request.parentSessionId,count+1);this.#queue.push(entry);queueMicrotask(()=>this.#drain());return{sessionId:id,get status(){return entry.status},result,cancel:r=>this.#cancel(entry,r??"cancelled")};
 }
 cancelParent(parent:string,reason:unknown="parent cancelled"){const visit=(p:string)=>{for(const e of this.#entries.values())if(e.request.parentSessionId===p&&!terminal(e.status)){visit(e.id);this.#cancel(e,reason)}};visit(parent)}
 #cancel(e:Entry,reason:unknown){if(terminal(e.status))return;e.controller.abort(reason);if(e.status==="queued"){const i=this.#queue.indexOf(e);if(i>=0)this.#queue.splice(i,1);void this.#finish(e,{status:"cancelled",error:errorText(reason)})}}
 #drain(){while(this.#active<this.#limits.concurrency&&this.#queue.length){const e=this.#queue.shift()!;if(e.status==="queued")void this.#run(e)}}
 async #run(e:Entry){this.#active++;e.status="running";const deadline=Date.now()+this.#limits.deadlineMs;let timer!:ReturnType<typeof setTimeout>;
  try{const abort=new Promise<never>((_,reject)=>{const fail=()=>reject(e.controller.signal.reason??"cancelled");e.controller.signal.addEventListener("abort",fail,{once:true});timer=setTimeout(()=>e.controller.abort("deadline exceeded"),this.#limits.deadlineMs)});
   const runtime=this.#options.runtimeFactory({sessionId:e.id,parentSessionId:e.request.parentSessionId,depth:e.depth});
   const input=Object.freeze({task:e.request.task,sessionId:e.id,context:e.request.context,model:e.request.model,capabilities:e.request.requestedCapabilities,maxIterations:this.#limits.maxIterations,deadline,signal:e.controller.signal,metadata:deepFreeze({parentSessionId:e.request.parentSessionId,depth:e.depth})});
   const run=Promise.resolve().then(()=>runtime.run(input));run.catch(()=>{});
   const raw=await Promise.race([run,abort]);if(e.controller.signal.aborted)throw e.controller.signal.reason;
   if(!raw||typeof raw.summary!=="string"||!raw.summary.trim()||!Number.isInteger(raw.iterations)||raw.iterations<0||!Number.isFinite(raw.costUsd)||raw.costUsd<0)throw new DelegationError("invalid runtime result");
   if(raw.iterations>this.#limits.maxIterations||raw.costUsd>this.#limits.maxCostUsd)await this.#finish(e,{status:"failed",error:"budget exceeded"});
   else {const safe=boundary(raw,"runtime result");if(this.#options.verifyResult){try{const timeout=this.#options.verifierTimeoutMs??this.#limits.deadlineMs;const ok=await Promise.race([this.#options.verifyResult(safe,{sessionId:e.id,parentSessionId:e.request.parentSessionId}),new Promise<boolean>((_,r)=>setTimeout(()=>r(new Error("verifier timeout")),timeout))]);if(!ok){await this.#finish(e,{status:"failed",error:"result verification failed"});return}}catch(x){await this.#finish(e,{status:"failed",error:`verifier error: ${errorText(x)}`});return}}await this.#finish(e,{status:"completed",summary:safe.summary,details:safe.details,iterations:safe.iterations,costUsd:safe.costUsd},true)}
  }catch(x){await this.#finish(e,{status:e.controller.signal.aborted?"cancelled":"failed",error:e.controller.signal.aborted?errorText(e.controller.signal.reason):errorText(x)})}finally{clearTimeout(timer);this.#active--;this.#drain()}}
 async #finish(e:Entry,partial:Pick<DelegationResult,"status">&Partial<DelegationResult>,announce=false){if(e.settled)return;e.settled=true;e.status=partial.status;if(e.counted){e.counted=false;this.#counts.set(e.request.parentSessionId,Math.max(0,(this.#counts.get(e.request.parentSessionId)??1)-1))}
  let result:DelegationResult={sessionId:e.id,parentSessionId:e.request.parentSessionId,...partial,announced:false,archived:false};const errors:string[]=[];
  if(announce)try{await this.#options.announce?.(boundary(result,"announce result"));result.announced=true}catch(x){errors.push(errorText(x))}
  try{await this.#options.archive?.(boundary(result,"archive result"));result.archived=true}catch(x){errors.push(errorText(x))}
  if(errors.length)result.error=[partial.error,...errors].filter(Boolean).join("; ");e.resolve(boundary(result,"delegation result"));
 }
 authorizeDispatch(sessionId:string,capability:string):boolean {const e=this.#entries.get(sessionId);return !!e&&e.request.requestedCapabilities.includes(capability)&&this.#allowed.has(capability)&&(this.#options.capabilityEnforcer?.authorize(capability,{sessionId,parentSessionId:e.request.parentSessionId})??true)}
}
