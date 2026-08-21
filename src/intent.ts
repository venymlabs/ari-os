import { z } from "zod";
import { isPublicKey } from "./signer/transaction.js";

/**
 * A base58 SPL mint.
 *
 * Deliberately not normalized: base58 is case-sensitive, so two strings
 * differing only in case are two different mints, and lowercasing one would
 * silently retarget the trade. The value either decodes to a 32-byte key on the
 * Ed25519 curve or it is refused.
 */
const mint = z.string().refine(isPublicKey, "must be a base58 Solana address");
const swapIntentSchema = z
  .object({
    kind: z.literal("swap"),
    tokenIn: mint,
    tokenOut: mint,
    amountIn: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(BigInt),
    maxSlippageBps: z.number().int().min(0).max(10_000),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type SwapIntent = z.infer<typeof swapIntentSchema>;
/**
 * The typed boundary an untrusted planner has to come through.
 *
 * `.strict()` is the whole point: an intent carries a mint pair, an amount, a
 * slippage bound and an expiry, and nothing else. A model cannot append raw
 * instruction data, an extra account, or a program id, because an unknown field
 * is a parse failure rather than a passthrough.
 */
export function normalizeIntent(input: unknown): SwapIntent {
  return swapIntentSchema.parse(input);
}
