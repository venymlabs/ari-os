import { assertSimulationSafe, buildSimulationRequest, type PreparedTransaction, type SimulationRequest, type SimulationResult } from "./simulation.js";
import { keccak256 } from "viem";
import type { AuthorizationEnvelope, SignerWireVerifier } from "./authorization/index.js";

interface Dependencies {simulate:(request:SimulationRequest)=>Promise<SimulationResult>;wireVerifier?:SignerWireVerifier;signSerialized?:(serialized:`0x${string}`)=>Promise<`0x${string}`>;broadcast?:(signed:`0x${string}`)=>Promise<`0x${string}`>}
interface ExecutionContext {policyHash:string;currentBlock:bigint;maxBlockLag:bigint;allowedAssets:ReadonlySet<string>}
export interface AuthorizedExecution {serialized:`0x${string}`;envelope:AuthorizationEnvelope}
export class ExecutionGateway {
 constructor(private readonly dependencies:Dependencies) {}
 async prepare(transaction:PreparedTransaction,context:ExecutionContext){const request=buildSimulationRequest(transaction,context.policyHash),simulation=await this.dependencies.simulate(request);assertSimulationSafe(simulation,{expectedTransactionHash:request.transactionHash,currentBlock:context.currentBlock,maxBlockLag:context.maxBlockLag,allowedAssets:context.allowedAssets});return {status:"SIMULATED" as const,transactionHash:request.transactionHash,request,simulation}}
 async execute(input:AuthorizedExecution){
  if(!input?.envelope||!input.serialized)throw Error("authorization_envelope_required");
  if(!this.dependencies.wireVerifier||!this.dependencies.signSerialized||!this.dependencies.broadcast)throw Error("signing_disabled");
  const verified=await this.dependencies.wireVerifier.verify(input.serialized,input.envelope);
  let signed:`0x${string}`;try{signed=await this.dependencies.signSerialized(verified.serialized)}catch(error){await verified.replayStore.transition?.(input.envelope.claims.id,"claimed","failed",String(error));throw error}
  const signedHash=keccak256(signed);await verified.replayStore.transition?.(input.envelope.claims.id,"claimed","signed",signedHash);
  let hash:`0x${string}`;try{hash=await this.dependencies.broadcast(signed)}catch(error){await verified.replayStore.transition?.(input.envelope.claims.id,"signed","reconciliation",String(error));throw error}
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash)||hash.toLowerCase()!==signedHash.toLowerCase()){await verified.replayStore.transition?.(input.envelope.claims.id,"signed","reconciliation",hash);throw Error("broadcast_hash_mismatch")}
  await verified.replayStore.transition?.(input.envelope.claims.id,"signed","broadcast",hash);return {status:"BROADCAST" as const,transactionHash:signedHash,hash};
 }
}
