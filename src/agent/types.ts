import type { z } from "zod";

export const TRADING_CAPABILITIES = {
  MARKET_DATA: "trading:market-data",
  PORTFOLIO_READ: "trading:portfolio-read",
  RISK_ANALYSIS: "trading:risk-analysis",
  ORDER_SIMULATE: "trading:order-simulate",
  ORDER_WRITE: "trading:order-write",
  POSITION_WRITE: "trading:position-write",
} as const;

export type TradingCapability =
  (typeof TRADING_CAPABILITIES)[keyof typeof TRADING_CAPABILITIES];
export type Capability = TradingCapability | (string & {});
export type ToolEffect = "read" | "write" | "trade" | "admin";
export interface Availability {
  available: boolean;
  reason?: string;
}
export interface ToolExecutionContext {
  signal: AbortSignal;
  invocationId: string;
  capabilities: ReadonlySet<Capability>;
}
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  capabilities: readonly Capability[];
  effect: ToolEffect;
  parallelSafe: boolean;
  timeoutMs?: number;
  availability?: () => Availability | Promise<Availability>;
  execute(input: I, context: ToolExecutionContext): O | Promise<O>;
}
export interface InvocationContext {
  capabilities: readonly Capability[];
  invocationId?: string;
  signal?: AbortSignal;
}
export interface ToolError {
  code:
    | "UNKNOWN_TOOL"
    | "CAPABILITY_DENIED"
    | "UNAVAILABLE"
    | "INVALID_INPUT"
    | "INVALID_OUTPUT"
    | "TIMEOUT"
    | "CANCELLED"
    | "EXECUTION_ERROR";
  message: string;
  details?: unknown;
}
export type ToolResult<T = unknown> =
  | { ok: true; invocationId: string; tool: string; data: T }
  | { ok: false; invocationId: string; tool: string; error: ToolError };
export interface ToolAuditEvent {
  phase: "start" | "finish";
  invocationId: string;
  tool: string;
  effect: ToolEffect;
  parallelSafe: boolean;
  ok?: boolean;
  errorCode?: ToolError["code"];
}
