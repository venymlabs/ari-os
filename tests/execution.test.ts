import { describe, expect, it } from "vitest";
import {
  buildSimulationRequest,
  assertSimulationSafe,
  type SimulationResult,
} from "../src/execution/simulation.js";
import { ExecutionGateway } from "../src/execution/gateway.js";

const tx = {
  chainId: 46630 as const,
  from: "0x0000000000000000000000000000000000000001" as const,
  to: "0x0000000000000000000000000000000000000002" as const,
  data: "0x12345678" as const,
  value: 0n,
  gas: 100000n,
  nonce: 1,
  type: "legacy" as const,
  gasPrice: 1n,
};

describe("exact transaction simulation", () => {
  it("binds simulation to canonical transaction bytes and policy hash", () => {
    const r = buildSimulationRequest(tx, "policy-v1");
    expect(r.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.policyHash).toBe("policy-v1");
  });
  it("fails closed on revert, unexpected asset delta, or stale block", () => {
    const bad: SimulationResult = {
      success: false,
      blockNumber: 10n,
      transactionHash: ("0x" + "0".repeat(64)) as `0x${string}`,
      gasUsed: 1n,
      assetDeltas: [],
      revertReason: "no",
    };
    expect(() =>
      assertSimulationSafe(bad, {
        expectedTransactionHash: bad.transactionHash,
        maxBlockLag: 2n,
        currentBlock: 11n,
        allowedAssets: new Set(),
      }),
    ).toThrow("simulation_reverted");
  });
});

describe("execution gateway", () => {
  it("never signs a raw prepared transaction even when simulation would pass", async () => {
    let signed = false;
    const gateway = new ExecutionGateway({
      simulate: async (req) => ({
        success: true,
        blockNumber: 100n,
        transactionHash: req.transactionHash,
        gasUsed: 1n,
        assetDeltas: [],
      }),
      signSerialized: async () => {
        signed = true;
        return "0xsigned";
      },
      broadcast: async () => "0xtx",
    });
    await expect(
      (gateway.execute as any)(tx, {
        policyHash: "p",
        currentBlock: 100n,
        maxBlockLag: 2n,
        allowedAssets: new Set(),
      }),
    ).rejects.toThrow("authorization_envelope_required");
    expect(signed).toBe(false);
  });
  it("supports prepare-only mode without a signer", async () => {
    const gateway = new ExecutionGateway({
      simulate: async (req) => ({
        success: true,
        blockNumber: 100n,
        blockHash: "0x" + "1".repeat(64),
        transactionHash: req.transactionHash,
        gasUsed: 1n,
        assetDeltas: [],
      }),
    });
    const result = await gateway.prepare(tx, {
      policyHash: "p",
      currentBlock: 100n,
      maxBlockLag: 2n,
      allowedAssets: new Set(),
    });
    expect(result.status).toBe("SIMULATED");
    expect(result.transactionHash).toMatch(/^0x/);
  });
  it("requires a canonical pinned block hash", () => {
    const request = buildSimulationRequest(tx, "p");
    expect(() =>
      assertSimulationSafe(
        {
          success: true,
          blockNumber: 10n,
          blockHash: "",
          transactionHash: request.transactionHash,
          gasUsed: 1n,
          assetDeltas: [],
        },
        {
          expectedTransactionHash: request.transactionHash,
          maxBlockLag: 2n,
          currentBlock: 10n,
          allowedAssets: new Set(),
        },
      ),
    ).toThrow("simulation_block_hash_invalid");
  });
});
