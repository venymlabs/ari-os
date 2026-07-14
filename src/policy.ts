import type { SwapIntent } from "./intent.js";

export interface Policy {
  now: number;
  maxAmountIn: bigint;
  maxSlippageBps: number;
  allowedTokens: ReadonlySet<string>;
}
export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
}

export function evaluatePolicy(
  intent: SwapIntent,
  policy: Policy,
): PolicyDecision {
  const reasons: string[] = [];
  if (intent.expiresAt <= policy.now) reasons.push("intent_expired");
  if (intent.amountIn > policy.maxAmountIn)
    reasons.push("spend_limit_exceeded");
  if (intent.maxSlippageBps > policy.maxSlippageBps)
    reasons.push("slippage_limit_exceeded");
  if (!policy.allowedTokens.has(intent.tokenIn))
    reasons.push("token_in_not_allowed");
  if (!policy.allowedTokens.has(intent.tokenOut))
    reasons.push("token_out_not_allowed");
  if (intent.tokenIn === intent.tokenOut) reasons.push("identical_assets");
  return { allowed: reasons.length === 0, reasons };
}
