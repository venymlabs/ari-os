import bs58 from "bs58";
import {
  buildSimulationRequest,
  createSimulationEvidence,
  NATIVE_ASSET,
  type PreparedTransaction,
  type SimulationCapabilities,
  type SimulationEvidence,
  type SimulationRequest,
  type SimulationResult,
} from "../src/execution/simulation.js";
import {
  blockhash,
  buildTransaction,
  CLUSTER,
  pubkey,
  systemTransfer,
} from "./signer-fixtures.js";

/** Shared Solana execution fixtures: one exact transfer, simulated. */

export const FEE_PAYER = pubkey(1);
export const DESTINATION = pubkey(9);
export const MINT = pubkey(3);
export const LAST_VALID_BLOCK_HEIGHT = 1_000;
export const POLICY_HASH = `0x${"ab".repeat(32)}`;

export function transferTransaction(lamports = 1_000n, payer = FEE_PAYER) {
  return buildTransaction({
    payer,
    instructions: [systemTransfer(payer, DESTINATION, lamports)],
  });
}

export function prepared(
  overrides: Partial<PreparedTransaction> = {},
): PreparedTransaction {
  return {
    cluster: CLUSTER,
    transaction: transferTransaction(),
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    ...overrides,
  };
}

export function simulationRequest(
  overrides: Partial<PreparedTransaction> = {},
  policyHash = POLICY_HASH,
): SimulationRequest {
  return buildSimulationRequest(prepared(overrides), policyHash);
}

export const fullCapabilities = (): SimulationCapabilities => ({
  balances: true,
  logs: true,
  fee: true,
  addressTableLookups: true,
});

export function okResult(
  request: SimulationRequest,
  overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    success: true,
    slot: 100n,
    blockhash: request.recentBlockhash,
    messageHash: request.messageHash,
    unitsConsumed: 4_500n,
    feeLamports: 5_000n,
    logs: ["Program 11111111111111111111111111111111 success"],
    accountStates: [
      {
        address: request.feePayer,
        lamports: 9_000n,
        owner: "11111111111111111111111111111111",
        data: null,
      },
    ],
    assetDeltas: [
      { asset: NATIVE_ASSET, owner: request.feePayer, amount: -1_000n },
    ],
    capabilities: fullCapabilities(),
    ...overrides,
  };
}

export function evidenceFor(
  request: SimulationRequest,
  overrides: Partial<SimulationResult> = {},
): SimulationEvidence {
  return createSimulationEvidence(request, okResult(request, overrides));
}

export const safety = (
  request: SimulationRequest,
  overrides: Record<string, unknown> = {},
) => ({
  expectedMessageHash: request.messageHash,
  currentSlot: 100n,
  maxSlotLag: 32n,
  allowedAssets: new Set([NATIVE_ASSET, MINT]),
  ...overrides,
});

/** A base64 SPL token account with the given mint, owner and amount. */
export function tokenAccountData(
  mint: string,
  owner: string,
  amount: bigint,
): string {
  const data = Buffer.alloc(165);
  bs58.decode(mint).forEach((b, i) => (data[i] = b));
  bs58.decode(owner).forEach((b, i) => (data[32 + i] = b));
  data.writeBigUInt64LE(amount, 64);
  return data.toString("base64");
}

export { blockhash, CLUSTER, pubkey };
