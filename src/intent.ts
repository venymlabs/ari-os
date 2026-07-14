import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
const swapIntentSchema = z
  .object({
    kind: z.literal("swap"),
    tokenIn: address,
    tokenOut: address,
    amountIn: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(BigInt),
    maxSlippageBps: z.number().int().min(0).max(10_000),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type SwapIntent = z.infer<typeof swapIntentSchema>;
export function normalizeIntent(input: unknown): SwapIntent {
  return swapIntentSchema.parse(input);
}
