import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';
import {
  ERC20_ABI, UNISWAP_V3_ROUTER_ABI, allowanceIntent, approvalIntent, buildApprovalTransaction,
  buildSwapTransaction, discoverBestRoute, portfolio, quoteExactInput, quoteExactInputSingle,
  simulateUnsignedTransaction, swapIntent,
} from '../src/trading/index.js';

const A=getAddress('0x0000000000000000000000000000000000000001');
const B=getAddress('0x0000000000000000000000000000000000000002');
const C=getAddress('0x0000000000000000000000000000000000000003');
const OWNER=getAddress('0x0000000000000000000000000000000000000004');
const ROUTER=getAddress('0x0000000000000000000000000000000000000005');
const QUOTER=getAddress('0x0000000000000000000000000000000000000006');

const reader={readContract:async (x:any)=>x.functionName==='balanceOf'?11n:x.functionName==='allowance'?7n:x.functionName==='decimals'?18:x.functionName==='symbol'?'TOK':'Token'};

describe('deterministic trading toolkit',()=>{
 it('reads bigint balances, metadata and exact allowance into a portfolio',async()=>{
   const p=await portfolio(reader as any,{owner:OWNER,tokens:[A,B],spenders:[ROUTER],nativeBalance:9n});
   expect(p.nativeBalance).toBe(9n); expect(p.tokens[0]).toMatchObject({balance:11n,decimals:18,symbol:'TOK'}); expect(p.tokens[0]!.allowances[0]!.amount).toBe(7n);
 });
 it('constructs bounded approve and revoke calldata only',()=>{
   const approve=buildApprovalTransaction(approvalIntent({chainId:46630,owner:OWNER,token:A,spender:ROUTER,amount:123n}),{nonce:2,gas:50_000n,maxFeePerGas:3n,maxPriorityFeePerGas:1n});
   expect(decodeFunctionData({abi:ERC20_ABI,data:approve.transaction.data})).toMatchObject({functionName:'approve',args:[ROUTER,123n]});
   expect(approve.serialized).toMatch(/^0x/); expect(()=>approvalIntent({chainId:46630,owner:OWNER,token:A,spender:ROUTER,amount:(1n<<256n)})).toThrow();
   expect(allowanceIntent({chainId:46630,owner:OWNER,token:A,spender:ROUTER,amount:0n}).kind).toBe('revoke');
 });
 it('quotes exactInputSingle and exactInput using injected verified quoter',async()=>{
   const calls:any[]=[]; const q={readContract:async(x:any)=>{calls.push(x);return x.functionName==='quoteExactInputSingle'?[100n,2n,3,40_000n]:[90n,[2n],3n,50_000n]}};
   expect((await quoteExactInputSingle(q as any,{quoter:QUOTER,tokenIn:A,tokenOut:B,fee:3000,amountIn:101n})).amountOut).toBe(100n);
   expect((await quoteExactInput(q as any,{quoter:QUOTER,path:{tokens:[A,C,B],fees:[500,3000]},amountIn:101n})).amountOut).toBe(90n);
   expect(calls).toHaveLength(2);
 });
 it('discovers highest-output route deterministically and rejects malformed paths',async()=>{
   const best=await discoverBestRoute([{tokens:[A,B],fees:[3000]},{tokens:[A,C,B],fees:[500,3000]}],async p=>p.tokens.length===2?10n:20n);
   expect(best.amountOut).toBe(20n); await expect(quoteExactInput({} as any,{quoter:QUOTER,path:{tokens:[A,B],fees:[]},amountIn:1n})).rejects.toThrow();
 });
 it('preserves slippage bounds for adversarial bigint amounts',()=>{
   let seed=17n;
   for(let n=0;n<250;n++){seed=(seed*1103515245n+12345n)&((1n<<64n)-1n);const quoted=seed+1n,bps=Number(seed%10001n);const i=swapIntent({chainId:46630,owner:OWNER,router:ROUTER,recipient:OWNER,tokenIn:A,tokenOut:B,fee:3000,amountIn:1n,quotedAmountOut:quoted,slippageBps:bps,deadline:2n,now:1n});expect(i.amountOutMinimum).toBeLessThanOrEqual(quoted);expect(i.amountOutMinimum).toBe(quoted*BigInt(10000-bps)/10000n);}
 });
 it('enforces recipient, deadline and integer slippage then constructs router calldata',()=>{
   const intent=swapIntent({chainId:46630,owner:OWNER,router:ROUTER,recipient:OWNER,tokenIn:A,tokenOut:B,fee:3000,amountIn:1000n,quotedAmountOut:999n,slippageBps:100,deadline:2000n,now:1000n});
   expect(intent.amountOutMinimum).toBe(989n);
   const tx=buildSwapTransaction(intent,{nonce:1,gas:150_000n,maxFeePerGas:4n,maxPriorityFeePerGas:2n});
   const decoded=decodeFunctionData({abi:UNISWAP_V3_ROUTER_ABI,data:tx.transaction.data}); expect(decoded.functionName).toBe('exactInputSingle');
   expect(()=>swapIntent({...intent,recipient:B} as any)).toThrow(/recipient/);
   expect(()=>swapIntent({...intent,deadline:999n,now:1000n} as any)).toThrow(/deadline/);
   expect(()=>swapIntent({...intent,slippageBps:10_001} as any)).toThrow(/slippage/);
 });
 it('estimates fees and simulates the exact constructed unsigned transaction',async()=>{
   const intent=swapIntent({chainId:46630,owner:OWNER,router:ROUTER,recipient:OWNER,tokenIn:A,tokenOut:B,fee:3000,amountIn:1000n,quotedAmountOut:999n,slippageBps:0,deadline:2000n,now:1000n});
   const client={estimateGas:async()=>123n,estimateFeesPerGas:async()=>({maxFeePerGas:5n,maxPriorityFeePerGas:2n}),call:async()=>({data:'0x' as const})};
   const r=await simulateUnsignedTransaction(client as any,intent,{nonce:0}); expect(r.gas).toBe(123n); expect(r.maxCost).toBe(615n); expect(r.success).toBe(true);
 });
 it('requires independent NOXA verification before constructing a NOXA swap',async()=>{
   const base={chainId:46630,owner:OWNER,router:ROUTER,recipient:OWNER,tokenIn:A,tokenOut:B,fee:3000,amountIn:1n,quotedAmountOut:1n,slippageBps:0,deadline:2n,now:1n,noxaToken:B};
   await expect(swapIntent(base as any,{verifyNoxaToken:async()=>false})).rejects.toThrow(/NOXA/);
 });
});
