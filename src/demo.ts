import { createPublicClient, http } from "viem";
import { robinhoodTestnet } from "./chain.js";
import { normalizeIntent } from "./intent.js";
import { evaluatePolicy } from "./policy.js";
import { AuditJournal } from "./audit.js";

const client=createPublicClient({chain:robinhoodTestnet,transport:http()});
const chainId=await client.getChainId();
const block=await client.getBlockNumber();
const intent=normalizeIntent({kind:"swap",tokenIn:"0x0000000000000000000000000000000000000001",tokenOut:"0x0000000000000000000000000000000000000002",amountIn:"100",maxSlippageBps:100,expiresAt:Math.floor(Date.now()/1000)+300});
const decision=evaluatePolicy(intent,{now:Math.floor(Date.now()/1000),maxAmountIn:100n,maxSlippageBps:100,allowedTokens:new Set([intent.tokenIn,intent.tokenOut])});
const journal=new AuditJournal(); journal.append("intent",{...intent,amountIn:intent.amountIn.toString()}); journal.append("decision",decision);
console.log(JSON.stringify({network:robinhoodTestnet.name,chainId,latestBlock:block.toString(),mode:"READ_ONLY_DRY_RUN",decision,auditValid:journal.verify()},null,2));
