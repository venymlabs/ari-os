import { describe, expect, it } from "vitest";
import {
  assertSimulationSafe,
  buildSimulationRequest,
  createSimulationEvidence,
  NATIVE_ASSET,
  type SimulationResult,
} from "../src/execution/simulation.js";
import { ExecutionGateway } from "../src/execution/gateway.js";
import { decodeTransaction } from "../src/signer/transaction.js";
import {
  DESTINATION,
  evidenceFor,
  fullCapabilities,
  LAST_VALID_BLOCK_HEIGHT,
  MINT,
  okResult,
  POLICY_HASH,
  prepared,
  safety,
  simulationRequest,
  transferTransaction,
} from "./execution-fixtures.js";
import { blockhash, CLUSTER, pubkey } from "./signer-fixtures.js";

describe("exact transaction simulation", () => {
  it("binds the request to canonically decoded bytes and the policy hash", () => {
    const t = prepared(),
      r = buildSimulationRequest(t, POLICY_HASH),
      d = decodeTransaction(t.transaction);
    expect(r.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.policyHash).toBe(POLICY_HASH);
    expect(r.transaction).toBe(d.wireBase64);
    expect(r.message).toBe(d.messageBase64);
    expect(r.feePayer).toBe(d.feePayer);
    expect(r.recentBlockhash).toBe(d.recentBlockhash);
    expect(r.lastValidBlockHeight).toBe(LAST_VALID_BLOCK_HEIGHT);
    expect(r.programIds).toEqual(["11111111111111111111111111111111"]);
    expect(r.accountKeys).toContain(DESTINATION);
    expect(r.addressTableLookups).toEqual([]);
    expect(r.instructions[0]!.data).toMatch(/^02000000/);
  });
  it("refuses a prepared transaction with no cluster or an impossible expiry", () => {
    for (const bad of [
      { cluster: "" },
      { lastValidBlockHeight: -1 },
      { lastValidBlockHeight: 1.5 },
    ])
      expect(() => buildSimulationRequest(prepared(bad), POLICY_HASH)).toThrow(
        /prepared_/,
      );
  });
  it("rejects non-canonical wire bytes rather than simulating something else", () => {
    expect(() =>
      buildSimulationRequest(
        prepared({ transaction: `${transferTransaction()}\n` }),
        POLICY_HASH,
      ),
    ).toThrow("transaction_encoding_invalid");
  });
  it("hashes slot, blockhash, units, fee, logs, states, deltas and capabilities", () => {
    const r = simulationRequest(),
      base = evidenceFor(r);
    for (const change of [
      { slot: 101n },
      { unitsConsumed: 4_501n },
      { feeLamports: 5_001n },
      { logs: ["other"] },
      { assetDeltas: [] },
      { accountStates: [] },
      { capabilities: { ...fullCapabilities(), logs: false } },
    ] as Partial<SimulationResult>[])
      expect(evidenceFor(r, change).hash).not.toBe(base.hash);
    expect(base.messageHash).toBe(r.messageHash);
  });
  it("refuses to build evidence for a different transaction", () => {
    const r = simulationRequest();
    expect(() =>
      createSimulationEvidence(
        r,
        okResult(r, { messageHash: `0x${"11".repeat(32)}` }),
      ),
    ).toThrow("simulation_transaction_mismatch");
  });
});

describe("simulation safety", () => {
  it("fails closed on a failed simulation and surfaces the decoded error", () => {
    const r = simulationRequest();
    expect(() =>
      assertSimulationSafe(
        okResult(r, {
          success: false,
          err: "InstructionError(0,Custom(6001))",
        }),
        safety(r),
      ),
    ).toThrow("simulation_failed:InstructionError(0,Custom(6001))");
  });
  it("treats missing evidence as a refusal, never as a clean simulation", () => {
    const r = simulationRequest();
    // The bug this guards: a node that could not read accounts returns no
    // deltas, which is silence — not proof that nothing moved.
    expect(() =>
      assertSimulationSafe(
        okResult(r, {
          assetDeltas: [],
          capabilities: { ...fullCapabilities(), balances: false },
        }),
        safety(r),
      ),
    ).toThrow("simulation_balances_unavailable");
    for (const [key, error] of [
      ["fee", "simulation_fee_unavailable"],
      ["logs", "simulation_logs_unavailable"],
      ["addressTableLookups", "simulation_address_table_lookup_unresolved"],
    ] as const)
      expect(() =>
        assertSimulationSafe(
          okResult(r, {
            capabilities: { ...fullCapabilities(), [key]: false },
          }),
          safety(r),
        ),
      ).toThrow(error);
    expect(() =>
      assertSimulationSafe(
        okResult(r, { capabilities: undefined as never }),
        safety(r),
      ),
    ).toThrow("simulation_capabilities_absent");
  });
  it("requires a real blockhash, the expected message, and a current slot", () => {
    const r = simulationRequest();
    expect(() =>
      assertSimulationSafe(okResult(r, { blockhash: "" }), safety(r)),
    ).toThrow("simulation_blockhash_invalid");
    expect(() =>
      assertSimulationSafe(
        okResult(r),
        safety(r, { expectedMessageHash: `0x${"22".repeat(32)}` }),
      ),
    ).toThrow("simulation_transaction_mismatch");
    for (const context of [{ currentSlot: 99n }, { currentSlot: 200n }])
      expect(() =>
        assertSimulationSafe(okResult(r), safety(r, context)),
      ).toThrow("simulation_stale_slot");
  });
  it("refuses an expired blockhash before any authorization exists", () => {
    const r = simulationRequest();
    expect(() =>
      assertSimulationSafe(
        okResult(r),
        safety(r, {
          currentBlockHeight: LAST_VALID_BLOCK_HEIGHT + 1,
          lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
        }),
      ),
    ).toThrow("simulation_blockhash_expired");
    expect(() =>
      assertSimulationSafe(
        okResult(r),
        safety(r, {
          currentBlockHeight: LAST_VALID_BLOCK_HEIGHT,
          lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
        }),
      ),
    ).not.toThrow();
  });
  it("rejects duplicate and unexpected asset movement", () => {
    const r = simulationRequest(),
      delta = { asset: NATIVE_ASSET, owner: r.feePayer, amount: -1n };
    expect(() =>
      assertSimulationSafe(
        okResult(r, { assetDeltas: [delta, delta] }),
        safety(r),
      ),
    ).toThrow("simulation_duplicate_asset_delta");
    expect(() =>
      assertSimulationSafe(
        okResult(r, {
          assetDeltas: [{ asset: pubkey(7), owner: r.feePayer, amount: 5n }],
        }),
        safety(r),
      ),
    ).toThrow(/unexpected_asset_delta/);
    // Same asset, different owners is legitimate movement, not a duplicate.
    expect(() =>
      assertSimulationSafe(
        okResult(r, {
          assetDeltas: [
            { asset: MINT, owner: r.feePayer, amount: -5n },
            { asset: MINT, owner: DESTINATION, amount: 5n },
          ],
        }),
        safety(r),
      ),
    ).not.toThrow();
  });
});

describe("execution gateway", () => {
  it("simulates in prepare-only mode without any signer wired up", async () => {
    const gateway = new ExecutionGateway({
      simulate: async (request) => okResult(request),
    });
    const result = await gateway.prepare(prepared(), {
      policyHash: POLICY_HASH,
      currentSlot: 100n,
      maxSlotLag: 32n,
      allowedAssets: new Set([NATIVE_ASSET]),
    });
    expect(result.status).toBe("SIMULATED");
    expect(result.messageHash).toBe(result.request.messageHash);
    expect(result.simulation.capabilities.balances).toBe(true);
  });
  it("propagates the safety refusal instead of returning an unsafe preparation", async () => {
    const gateway = new ExecutionGateway({
      simulate: async (request) =>
        okResult(request, { success: false, err: "BlockhashNotFound" }),
    });
    await expect(
      gateway.prepare(prepared(), {
        policyHash: POLICY_HASH,
        currentSlot: 100n,
        maxSlotLag: 32n,
        allowedAssets: new Set([NATIVE_ASSET]),
      }),
    ).rejects.toThrow("simulation_failed:BlockhashNotFound");
  });
  it("fences the blockhash during prepare when the caller supplies a height", async () => {
    const gateway = new ExecutionGateway({
      simulate: async (request) => okResult(request),
    });
    await expect(
      gateway.prepare(prepared(), {
        policyHash: POLICY_HASH,
        currentSlot: 100n,
        maxSlotLag: 32n,
        allowedAssets: new Set([NATIVE_ASSET]),
        currentBlockHeight: LAST_VALID_BLOCK_HEIGHT + 1,
      }),
    ).rejects.toThrow("simulation_blockhash_expired");
  });
  it("never signs a raw prepared transaction even when simulation would pass", async () => {
    let signed = false;
    const gateway = new ExecutionGateway({
      simulate: async (request) => okResult(request),
      sign: async () => {
        signed = true;
        return { transaction: "", signature: "" };
      },
      broadcast: async () => "signature",
    });
    await expect(
      (gateway.execute as unknown as (x: unknown) => Promise<unknown>)(
        prepared(),
      ),
    ).rejects.toThrow("authorization_envelope_required");
    expect(signed).toBe(false);
  });
  it("refuses to execute at all when signing is not fully wired", async () => {
    const gateway = new ExecutionGateway({
      simulate: async (request) => okResult(request),
    });
    await expect(
      gateway.execute({
        transaction: transferTransaction(),
        envelope: {
          claims: { id: "auth-1" },
          signature: "sig",
        } as never,
      }),
    ).rejects.toThrow("signing_disabled");
  });
  it("keeps cluster and blockhash out of band: the request carries both", () => {
    const r = buildSimulationRequest(
      prepared({ transaction: transferTransaction(2n) }),
      POLICY_HASH,
    );
    expect(r.cluster).toBe(CLUSTER);
    expect(r.recentBlockhash).toBe(blockhash());
  });
});
