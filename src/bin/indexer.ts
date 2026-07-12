#!/usr/bin/env node
import {createPublicClient,http} from "viem";
import {loadConfig} from "../config/index.js";
import {robinhoodMainnet,robinhoodTestnet} from "../chain.js";
import {createNoxaTokenRegistry} from "../noxa.js";
import {NoxaIndexer} from "../indexers/noxa.js";
import {NoxaIndexStore} from "../storage/noxa-index.js";
export async function main(argv=process.argv.slice(2)){
 if(!argv.includes("--once"))throw new Error("indexer currently requires --once");const c=loadConfig(process.env,process.cwd(),{requireRpc:true}),chain=c.network==="mainnet"?robinhoodMainnet:robinhoodTestnet,client=createPublicClient({chain,transport:http(c.rpc!.url)}),registry=createNoxaTokenRegistry(client as any),store=new NoxaIndexStore(c.paths.indexer);
 try{const indexed=await new NoxaIndexer({...client,verifyToken:registry.verifyToken,getLogs:async(args:any)=>registry.discover({fromBlock:args.fromBlock,toBlock:args.toBlock})},store,{startBlock:BigInt(process.env.INDEXER_START_BLOCK??0),confirmations:BigInt(process.env.INDEXER_CONFIRMATIONS??0)}).runOnce();console.log(JSON.stringify({indexer:{once:true,indexed}}))}finally{store.close()}
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1});
