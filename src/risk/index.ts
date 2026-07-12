export interface RiskInput {
  token: { address: string; verified?: boolean; isProxy?: boolean; name?: string; symbol?: string };
  holders?: Array<{ address: string; share: number }>;
  liquidityUsd?: number;
  pairCreatedAt?: number;
  restrictions?: { buyRestricted?: boolean; sellRestricted?: boolean; buyTaxPercent?: number; sellTaxPercent?: number };
  sources?: Array<{ source: string; priceUsd?: number }>;
}
export interface RiskFactor { code: string; severity: "low"|"medium"|"high"|"critical"; points: number; evidence: string }
export interface RiskReport { score:number; level:"low"|"medium"|"high"|"critical"; confidence:number; honeypot:"unverified"; factors:RiskFactor[]; provenance:Array<{source:string;priceUsd?:number}>; disclaimer:string }
export function analyzeRisk(i:RiskInput, options:{now?:number}={}):RiskReport {
  const factors:RiskFactor[]=[]; const add=(code:string,points:number,evidence:string,severity:RiskFactor["severity"]="high")=>factors.push({code,points,evidence,severity});
  const top=i.holders?.[0]?.share??0, top10=(i.holders??[]).slice(0,10).reduce((n,h)=>n+h.share,0);
  if(top>=.25||top10>=.6)add("HOLDER_CONCENTRATION",20,`Largest holder ${(top*100).toFixed(1)}%; observed top holders ${(top10*100).toFixed(1)}%`);
  if(i.liquidityUsd!=null&&i.liquidityUsd<10_000)add("LOW_LIQUIDITY",15,`Liquidity $${i.liquidityUsd}`);
  if(i.pairCreatedAt!=null&&(options.now??Date.now())-i.pairCreatedAt<24*3600e3)add("NEW_PAIR",10,"Pair is less than 24 hours old","medium");
  if(i.token.isProxy)add("PROXY",8,"Contract is reported as a proxy","medium");
  if(i.token.verified===false)add("UNVERIFIED",8,"Source code is not verified","medium");
  if(i.restrictions?.sellRestricted||i.restrictions?.buyRestricted)add(i.restrictions.sellRestricted?"SELL_RESTRICTION":"BUY_RESTRICTION",25,"Reported transfer/trading restriction","critical");
  if(Math.max(i.restrictions?.buyTaxPercent??0,i.restrictions?.sellTaxPercent??0)>=10)add("HIGH_TAX",15,`Reported buy/sell tax ${i.restrictions?.buyTaxPercent??0}%/${i.restrictions?.sellTaxPercent??0}%`);
  if(/[✅]|https?:\/\/|official/i.test(`${i.token.name??""} ${i.token.symbol??""}`))add("SUSPICIOUS_METADATA",8,"Promotional or URL-like token metadata","medium");
  const prices=(i.sources??[]).flatMap(s=>s.priceUsd==null?[]:[s.priceUsd]); if(prices.length>1){const mean=prices.reduce((a,b)=>a+b,0)/prices.length;const spread=(Math.max(...prices)-Math.min(...prices))/mean;if(spread>.1)add("SOURCE_DISAGREEMENT",12,`Price spread ${(spread*100).toFixed(1)}% across sources`);}
  const score=Math.min(100,factors.reduce((n,f)=>n+f.points,0)); const dimensions=[i.holders,i.liquidityUsd,i.pairCreatedAt,i.restrictions,i.sources?.length&&i.sources.length>1].filter(Boolean).length;
  return {score,level:score>=70?"critical":score>=45?"high":score>=20?"medium":"low",confidence:Math.min(.95,.15+dimensions*.16),honeypot:"unverified",factors,provenance:(i.sources??[]).map(s=>({...s})),disclaimer:"This is heuristic risk screening, not a honeypot determination. Confirm tradeability with transaction simulation and independent review."};
}
