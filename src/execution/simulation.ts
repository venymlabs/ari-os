import { keccak256, serializeTransaction, stringToHex, type AccessList } from "viem";

export interface PreparedTransaction { chainId:number; from:`0x${string}`; to:`0x${string}`; data:`0x${string}`; value:bigint; gas:bigint; nonce:number; type?:"legacy"|"eip2930"|"eip1559"; gasPrice?:bigint; maxFeePerGas?:bigint; maxPriorityFeePerGas?:bigint; accessList?:AccessList }
export interface AssetDelta { asset:`0x${string}`; amount:bigint }
export interface StateDiff {address:`0x${string}`;key:string;before:string;after:string}
export interface SimulationEvent {address:`0x${string}`;topics:string[];data:string}
export interface SimulationRequest { transaction:PreparedTransaction; serialized:`0x${string}`; transactionHash:`0x${string}`; policyHash:string }
export interface SimulationResult { success:boolean; blockNumber:bigint; blockHash?:string; transactionHash:`0x${string}`; gasUsed:bigint; stateDiffs?:StateDiff[]; events?:SimulationEvent[]; assetDeltas:AssetDelta[]; revertReason?:string }
export interface SimulationEvidence {hash:`0x${string}`;transactionHash:`0x${string}`;blockNumber:bigint;blockHash:string;gasUsed:bigint;stateDiffs:StateDiff[];events:SimulationEvent[];assetDeltas:AssetDelta[]}
export interface SafetyContext { expectedTransactionHash:`0x${string}`; maxBlockLag:bigint; currentBlock:bigint; allowedAssets:ReadonlySet<string> }

export function buildSimulationRequest(t:PreparedTransaction,policyHash:string):SimulationRequest {
 const type=t.type??"legacy";
 const common={chainId:t.chainId,to:t.to,data:t.data,value:t.value,gas:t.gas,nonce:t.nonce};
 const transaction=type==="eip1559"?{...common,type,maxFeePerGas:t.maxFeePerGas??0n,maxPriorityFeePerGas:t.maxPriorityFeePerGas??0n,accessList:t.accessList??[]}:type==="eip2930"?{...common,type,gasPrice:t.gasPrice??0n,accessList:t.accessList??[]}:{...common,type:"legacy" as const,gasPrice:t.gasPrice??0n};
 const serialized=serializeTransaction(transaction),transactionHash=keccak256(serialized); return {transaction:t,serialized,transactionHash,policyHash};
}
const canonical=(value:unknown):unknown=>typeof value==="bigint"?value.toString():Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const evidenceBody=(request:SimulationRequest,result:SimulationResult)=>({domain:"robinhood-simulation-evidence/v1",transactionHash:request.transactionHash,blockNumber:result.blockNumber,blockHash:result.blockHash??"",gasUsed:result.gasUsed,stateDiffs:result.stateDiffs??[],events:result.events??[],assetDeltas:result.assetDeltas});
export function createSimulationEvidence(request:SimulationRequest,result:SimulationResult):SimulationEvidence {const body=evidenceBody(request,result);return {...body,hash:keccak256(stringToHex(JSON.stringify(canonical(body))))} as SimulationEvidence}
export function simulationEvidenceHash(e:Omit<SimulationEvidence,"hash">):`0x${string}` {return keccak256(stringToHex(JSON.stringify(canonical({domain:"robinhood-simulation-evidence/v1",...e}))))}
export function assertSimulationSafe(result:SimulationResult,context:SafetyContext):void {
 if(!result.success)throw Error(`simulation_reverted${result.revertReason?`:${result.revertReason}`:""}`);
 if(!/^0x[0-9a-fA-F]{64}$/.test(result.blockHash??""))throw Error("simulation_block_hash_invalid");
 if(result.transactionHash.toLowerCase()!==context.expectedTransactionHash.toLowerCase())throw Error("simulation_transaction_mismatch");
 if(result.blockNumber>context.currentBlock||context.currentBlock-result.blockNumber>context.maxBlockLag)throw Error("simulation_stale_block");
 const seen=new Set<string>(); for(const d of result.assetDeltas){const k=d.asset.toLowerCase();if(seen.has(k))throw Error("simulation_duplicate_asset_delta");seen.add(k);if(!context.allowedAssets.has(k))throw Error(`unexpected_asset_delta:${d.asset}`)}
}
