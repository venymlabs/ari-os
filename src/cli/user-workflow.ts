import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {getAddress,type Address} from 'viem';
import type {UserRequest} from './index.js';
import type {DecisionInput} from '../execution/approvals/index.js';
import type {TradeSide,TradingOrchestrator} from '../live-trading/index.js';

type Rpc=(method:string,params:unknown[])=>Promise<any>;
type Trading=Pick<TradingOrchestrator,'quote'|'execute'|'approve'|'deny'|'submit'|'status'|'reconcile'> & {portfolio?:()=>Promise<unknown>};
type Proof={operator:string}&Omit<DecisionInput,'operatorId'>;
type C={dataDir:string;rpc?:Rpc;trading?:Trading;operatorProof?:(id:string,decision:'approve'|'deny',reason?:string)=>Promise<Proof>;spawnSigner?:(action:string,args:Record<string,string|boolean>)=>Promise<unknown>};
const ROUTER='0xcaf681a66d020601342297493863e78c959e5cb2';
const json=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2);
async function exists(p:string){try{await stat(p);return true}catch{return false}}
async function privateWrite(p:string,x:string,force=false){if(!force&&await exists(p))throw Error(`already_exists: ${p}`);await writeFile(p,x,{mode:0o600});await chmod(p,0o600)}
const required=(a:Record<string,string|boolean>,key:string)=>{const v=a[key];if(typeof v!=='string'||!v)throw Error(`${key} required`);return v};
const integer=(a:Record<string,string|boolean>,key:string)=>{const v=required(a,key);if(!/^\d+$/.test(v))throw Error(`${key} must be a non-negative integer`);return BigInt(v)};
export async function createOperatorDecisionProof(path:string,input:{requestId:string;operator:string;decision:'approve'|'deny';challenge:string;expectedRevision:number;reason?:string}){const key=(await readFile(path)).toString('utf8').trim();if(!key)throw Error('operator key is empty');const timestamp=Date.now(),nonce=randomUUID(),body={...input,nonce,timestamp};return{operator:input.operator,decision:input.decision,challenge:input.challenge,nonce,expectedRevision:input.expectedRevision,timestamp,proof:createHmac('sha256',key).update(JSON.stringify(body)).digest('hex'),...(input.reason?{reason:input.reason}:{})};}
export function createUserWorkflow(c:C){
 const proof=c.operatorProof??(async(id,decision,reason)=>{const x:any=c.trading?.status(id);const status=await x;if(!status?.challenge||!Number.isInteger(status.approvalRevision))throw Error('approval challenge unavailable');return createOperatorDecisionProof(join(c.dataDir,'operator.key'),{requestId:id,operator:'operator',decision,challenge:status.challenge,expectedRevision:status.approvalRevision,...(reason?{reason}:{})})});
 return async(req:UserRequest):Promise<unknown>=>{
  await mkdir(c.dataDir,{recursive:true,mode:0o700});
  if(req.group==='setup'){
   const force=req.args.force===true,account=getAddress(String(req.args.account??'0x0000000000000000000000000000000000000000')),socket=join(c.dataDir,'signer.sock');
   const files:{name:string;value:string}[]=[
    {name:'config.json',value:json({version:1,mode:req.args.remote?'remote':'local',remote:req.args.remote??null,rpcUrl:req.args.rpc??null,socket,account})},
    {name:'policy.json',value:json({version:1,maxAmountIn:'1000000000000000000',maxSlippageBps:100,approvalRequired:true,finalityBlocks:12,allowedTokens:[]})},
    {name:'sign-policy.json',value:json({version:1,chainIds:[4663],accounts:[account],to:[ROUTER],maxValue:'0',maxGas:'500000',maxFeePerGas:'100000000000',maxPriorityFeePerGas:'5000000000',dataPrefixes:['0x04e45aaf','0xb858183f']})},
    ...['signer.token','api.token','authorization.key','operator.key'].map(name=>({name,value:randomBytes(32).toString('hex')}))
   ];
   for(const f of files)await privateWrite(join(c.dataDir,f.name),f.value,force);
   return{initialized:true,dataDir:c.dataDir,files:files.map(f=>f.name),next:[`raos wallet create --keystore ${join(c.dataDir,'wallet.json')} --password-fd 0`,'raos signer start','raos portfolio']};
  }
  if(req.group==='wallet'||req.group==='signer'){if(req.group==='signer'&&req.action==='status')return{running:await exists(join(c.dataDir,'signer.sock')),socket:join(c.dataDir,'signer.sock'),guidance:'Start with: raos signer start'};if(!c.spawnSigner)throw Error(`${req.group} ${req.action} requires isolated raos-signer`);return c.spawnSigner(req.action,req.args)}
  if(req.group==='portfolio'){if(c.trading?.portfolio)return c.trading.portfolio();if(!c.rpc)throw Error('trading service or RPC not configured');const address=getAddress(required(req.args,'address'));return{address,nativeBalance:BigInt(await c.rpc('eth_getBalance',[address,'latest'])).toString()}}
  if(!c.trading)throw Error('trading service not configured');const a=req.args;
  if(req.action==='quote')return c.trading.quote({side:String(a.side??'buy') as TradeSide,tokenIn:getAddress(required(a,'tokenIn')),tokenOut:getAddress(required(a,'tokenOut')),amountIn:integer(a,'amountIn'),slippageBps:Number(required(a,'slippage'))});
  if(req.action==='buy'||req.action==='sell')return c.trading.execute(required(a,'quoteId'),{idempotencyKey:required(a,'idempotencyKey'),actor:String(a.actor??'cli'),dryRun:a.live!==true});
  if(req.action==='approve'||req.action==='deny'){const id=required(a,'id'),decision=req.action;const p=await proof(id,decision,typeof a.reason==='string'?a.reason:undefined);const {operator,...input}=p;return decision==='approve'?c.trading.approve(id,operator,input):c.trading.deny(id,operator,input)}
  if(req.action==='submit')return c.trading.submit(required(a,'id'));
  if(req.action==='status')return c.trading.status(required(a,'id'));
  if(req.action==='reconcile')return c.trading.reconcile(required(a,'id'));
  throw Error(`Unknown trade action: ${req.action}`);
 };
}
export async function httpRpc(url:string,method:string,params:unknown[]){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const x:any=await r.json();if(x.error)throw Error(`rpc error ${x.error.code}`);return x.result}
