import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalPolicy, policyHash, TradingControl, ReservationLedger, type PolicyDocument, type TradeRequest } from "../src/execution/control/index.js";

const policy = (): PolicyDocument => ({
  version: "1", effectiveAt: 0n, expiresAt: 10_000n,
  allow: { chains:[1n], accounts:["acct"], tokens:["A","B"], routers:["R"], targets:["T"], selectors:["0x12345678"], recipients:["acct"] },
  limits: { perTrade:100n, assetHourly:150n, assetDaily:300n, strategyHourly:180n, strategyDaily:400n, totalExposure:500n, assetExposure:250n, concentrationBps:6000n, drawdown:100n, totalLoss:80n },
  market: { maxQuoteAge:10n, maxSlippageBps:100n, maxImpactBps:150n, maxGas:20n, maxFees:10n, minLiquidity:1000n, maxTaxBps:200n, allowProxy:false, maxOracleAge:10n, requireSequencerUp:true },
  approvalClass:"exact", deadManAfter:100n, globalKill:false, strategyKills:[]
});
const trade = (over: Partial<TradeRequest> = {}): TradeRequest => ({ id:"x", now:100n, chain:1n, account:"acct", tokenIn:"A", tokenOut:"B", router:"R", target:"T", selector:"0x12345678", recipient:"acct", strategy:"s", amount:50n, approvalAmount:50n, quoteAt:95n, slippageBps:50n, impactBps:50n, gas:10n, fees:5n, liquidity:2000n, taxBps:0n, isProxy:false, oracleAt:95n, sequencerUp:true, portfolioExposure:100n, assetExposure:50n, portfolioValue:500n, peakValue:500n, realizedLoss:0n, unrealizedLoss:0n, lastHeartbeat:50n, ...over });

describe("deterministic trading control", () => {
  it("canonicalizes and hashes independent of key order", () => {
    const p=policy(); const reordered={...p, version:p.version} as PolicyDocument;
    expect(canonicalPolicy(p)).toBe(canonicalPolicy(reordered));
    expect(policyHash(p)).toMatch(/^[a-f0-9]{64}$/);
    expect(policyHash(p)).toBe(policyHash(reordered));
  });
  it("requires the injected verifier to accept the exact policy reference", () => {
    const c=new TradingControl(policy(), { policyHash:policyHash(policy()), signature:"sig" }, ()=>false);
    expect(c.reserve(trade()).reasons).toContain("policy_signature_invalid");
  });
  it("rejects every allowlist mismatch and exact approval mismatch deterministically", () => {
    const cases: [Partial<TradeRequest>,string][]=[[{chain:2n},"chain_not_allowed"],[{account:"z"},"account_not_allowed"],[{tokenOut:"Z"},"token_not_allowed"],[{router:"Z"},"router_not_allowed"],[{target:"Z"},"target_not_allowed"],[{selector:"0x0"},"selector_not_allowed"],[{recipient:"z"},"recipient_not_allowed"],[{approvalAmount:51n},"approval_not_exact"]];
    for(const [change, reason] of cases) expect(control().reserve(trade(change)).reasons).toContain(reason);
  });
  it("enforces market, portfolio, loss and liveness boundaries", () => {
    const cases: [Partial<TradeRequest>,string][]=[[{quoteAt:89n},"quote_stale"],[{slippageBps:101n},"slippage_exceeded"],[{impactBps:151n},"impact_exceeded"],[{gas:21n},"gas_exceeded"],[{fees:11n},"fees_exceeded"],[{liquidity:999n},"liquidity_too_low"],[{taxBps:201n},"tax_exceeded"],[{isProxy:true},"proxy_forbidden"],[{oracleAt:89n},"oracle_stale"],[{sequencerUp:false},"sequencer_down"],[{portfolioExposure:451n},"total_exposure_exceeded"],[{assetExposure:201n},"asset_exposure_exceeded"],[{assetExposure:251n},"concentration_exceeded"],[{peakValue:601n},"drawdown_exceeded"],[{realizedLoss:50n,unrealizedLoss:31n},"loss_exceeded"],[{lastHeartbeat:-1n},"dead_man_switch"]];
    for(const [change, reason] of cases) expect(control().reserve(trade(change)).reasons).toContain(reason);
  });
  it("supports global and strategy kill switches",()=>{
    const p=policy(); p.globalKill=true; expect(control(p).reserve(trade()).reasons).toContain("global_kill_switch");
    const q=policy(); q.strategyKills=["s"]; expect(control(q).reserve(trade()).reasons).toContain("strategy_kill_switch");
  });
});

describe("reservation ledger",()=>{
  it("atomically prevents concurrent oversubscription and supports release",()=>{
    const c=control(); expect(c.reserve(trade({id:"a",amount:100n,approvalAmount:100n})).allowed).toBe(true);
    expect(c.reserve(trade({id:"b",amount:60n,approvalAmount:60n})).reasons).toContain("asset_hourly_limit_exceeded");
    c.release("a"); expect(c.reserve(trade({id:"b",amount:60n,approvalAmount:60n})).allowed).toBe(true);
  });
  it("commit is idempotent, rolling windows expire, and reconciliation replaces state",()=>{
    const c=control(); c.reserve(trade({id:"a",amount:100n,approvalAmount:100n})); c.commit("a",100n); c.commit("a",100n);
    expect(c.reserve(trade({id:"b",now:3701n,quoteAt:3701n,oracleAt:3701n,lastHeartbeat:3701n,amount:100n,approvalAmount:100n})).allowed).toBe(true);
    c.reconcile([{id:"old",at:99n,asset:"B",strategy:"s",amount:150n}]);
    expect(c.reserve(trade({id:"z",amount:1n,approvalAmount:1n})).reasons).toContain("asset_hourly_limit_exceeded");
  });
  it("rejects duplicate ids and non-positive integer amounts",()=>{
    const c=control(); expect(c.reserve(trade({amount:0n,approvalAmount:0n})).reasons).toContain("invalid_amount");
    expect(c.reserve(trade()).allowed).toBe(true); expect(c.reserve(trade()).reasons).toContain("duplicate_trade_id");
  });
});

describe("hardened durable control",()=>{
  it("fails closed and rejects malformed policies",()=>{ const p=policy(); p.allow.tokens.push("B"); expect(()=>policyHash(p)).toThrow(); const q=policy(); expect(new TradingControl(q,{policyHash:policyHash(q),signature:"s"},()=>{throw Error()}).reserve(trade()).reasons).toContain("policy_signature_invalid"); });
  it("rejects negatives and future observations",()=>{ for(const x of [{gas:-1n},{portfolioExposure:-1n},{quoteAt:101n},{oracleAt:101n},{lastHeartbeat:101n}]) expect(control().reserve(trade(x)).allowed).toBe(false); });
  it("counts reservations toward exposure",()=>{ const c=control(); expect(c.reserve(trade({id:"a",amount:100n,approvalAmount:100n})).allowed).toBe(true); expect(c.reserve(trade({id:"b",amount:100n,approvalAmount:100n,portfolioExposure:350n})).reasons).toContain("total_exposure_exceeded"); });
  it("coordinates sqlite connections and survives restart",()=>{ const d=mkdtempSync(join(tmpdir(),"ctl-")),db=join(d,"x.db"); try { const a=control(policy(),new ReservationLedger(db)),b=control(policy(),new ReservationLedger(db)); expect(a.reserve(trade({id:"a",amount:100n,approvalAmount:100n})).allowed).toBe(true); expect(b.reserve(trade({id:"b",amount:60n,approvalAmount:60n})).reasons).toContain("asset_hourly_limit_exceeded"); expect(new ReservationLedger(db).has("a")).toBe(true); } finally { rmSync(d,{recursive:true,force:true}); } });
  it("uses trusted commit time and records reconciliation discrepancy",()=>{ const l=new ReservationLedger(":memory:",{now:()=>200n,reservationTtl:50n}); expect(l.reserve({id:"a",at:100n,asset:"B",strategy:"s",amount:10n})).toBe(true); expect(l.commit("a",999n)).toBe(true); expect(l.usage(200n,1n,()=>true)).toBe(10n); expect(l.reconcile([{id:"other",at:200n,asset:"B",strategy:"s",amount:1n}],200n)).toBe("discrepancy"); expect(l.status()).toBe("discrepancy"); });
});
function control(p=policy(),ledger=new ReservationLedger()){ return new TradingControl(p,{policyHash:policyHash(p),signature:"sig"},(ref,hash)=>ref.policyHash===hash && ref.signature==="sig",ledger); }
