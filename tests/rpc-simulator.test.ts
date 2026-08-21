import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  CLUSTER_GENESIS_HASHES,
  decodeSimulationError,
  RpcSimulationError,
  RpcSimulator,
} from "../src/execution/rpc-simulator.js";
import { NATIVE_ASSET } from "../src/execution/simulation.js";
import {
  DESTINATION,
  FEE_PAYER,
  MINT,
  POLICY_HASH,
  simulationRequest,
  tokenAccountData,
} from "./execution-fixtures.js";
import {
  buildTransaction,
  CLUSTER,
  lookupTable,
  pubkey,
  systemTransfer,
  transferChecked,
} from "./signer-fixtures.js";

const GENESIS = CLUSTER_GENESIS_HASHES[CLUSTER]!;
const SYSTEM = "11111111111111111111111111111111";

type Handler = (method: string, params: unknown[]) => unknown;

function rpcFetch(handler: Handler, calls: [string, unknown[]][] = []) {
  return (async (_u: URL | RequestInfo, i?: RequestInit) => {
    const b = JSON.parse(String(i?.body));
    calls.push([b.method, b.params]);
    const result = handler(b.method, b.params);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: b.id,
        ...(result instanceof Error
          ? { error: { code: -32000, message: result.message } }
          : { result }),
      }),
    );
  }) as typeof fetch;
}

const account = (lamports: number, owner = SYSTEM, data = "") => ({
  lamports,
  owner,
  data: [data, "base64"],
  executable: false,
  rentEpoch: 0,
});

/** A minimal but real address-lookup-table account body. */
function lookupTableData(authority: string, addresses: string[]) {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(2n ** 64n - 1n, 4);
  meta.writeBigUInt64LE(0n, 12);
  meta.writeUInt8(0, 20);
  meta.writeUInt8(1, 21);
  Buffer.from(bs58.decode(authority)).copy(meta, 22);
  return Buffer.concat([
    meta,
    ...addresses.map((a) => Buffer.from(bs58.decode(a))),
  ]).toString("base64");
}

/** The happy path: a system transfer whose fee payer and payee both move. */
function transferRpc(overrides: Partial<Record<string, unknown>> = {}) {
  const pre = [account(10_000), account(0)],
    post = [account(4_000), account(1_000)];
  return (method: string): unknown => {
    if (method === "getGenesisHash") return GENESIS;
    if (method === "getMultipleAccounts")
      return { context: { slot: 100 }, value: pre };
    if (method === "simulateTransaction")
      return {
        context: { slot: 100 },
        value: {
          err: null,
          logs: [`Program ${SYSTEM} success`],
          accounts: post,
          unitsConsumed: 450,
          ...overrides,
        },
      };
    if (method === "getFeeForMessage")
      return { context: { slot: 100 }, value: 5_000 };
    throw Error(`unexpected ${method}`);
  };
}

const simulator = (
  handler: Handler,
  options: Record<string, unknown> = {},
  calls: [string, unknown[]][] = [],
) =>
  new RpcSimulator({
    url: "https://user:secret@rpc.test/path?key=abc",
    cluster: CLUSTER,
    fetch: rpcFetch(handler, calls),
    ...options,
  });

describe("Solana RPC simulator", () => {
  it("pins the cluster, reads pre-state, and never lets the node swap the blockhash", async () => {
    const calls: [string, unknown[]][] = [];
    const r = await simulator(transferRpc(), {}, calls).simulate(
      simulationRequest(),
    );
    expect(r).toMatchObject({
      success: true,
      slot: 100n,
      unitsConsumed: 450n,
      feeLamports: 5_000n,
    });
    expect(r.capabilities).toEqual({
      balances: true,
      logs: true,
      fee: true,
      addressTableLookups: true,
    });
    const sim = calls.find((c) => c[0] === "simulateTransaction")![1] as [
      string,
      Record<string, unknown>,
    ];
    expect(sim[1]).toMatchObject({
      encoding: "base64",
      replaceRecentBlockhash: false,
      // The transaction is unsigned before authorization, so there is nothing
      // to verify and asking would fail for the wrong reason.
      sigVerify: false,
      minContextSlot: 100,
    });
    expect(sim[1].accounts).toMatchObject({
      addresses: [FEE_PAYER, DESTINATION],
    });
    expect(calls.map((c) => c[0])).toEqual([
      "getGenesisHash",
      "getMultipleAccounts",
      "simulateTransaction",
      "getFeeForMessage",
    ]);
  });
  it("handles legacy messages, which have no lookup tables at all", async () => {
    const request = simulationRequest({
      transaction: buildTransaction({
        payer: FEE_PAYER,
        instructions: [systemTransfer(FEE_PAYER, DESTINATION, 1_000n)],
        legacy: true,
      }),
    });
    const r = await simulator(transferRpc()).simulate(request);
    expect(r.success).toBe(true);
    expect(r.provenance.observedAccounts).toEqual([FEE_PAYER, DESTINATION]);
    expect(r.capabilities.addressTableLookups).toBe(true);
  });
  it("derives native asset deltas from pre/post account state", async () => {
    const r = await simulator(transferRpc()).simulate(simulationRequest());
    expect(r.assetDeltas).toEqual([
      { asset: NATIVE_ASSET, owner: FEE_PAYER, amount: -6_000n },
      { asset: NATIVE_ASSET, owner: DESTINATION, amount: 1_000n },
    ]);
    expect(r.accountStates.map((s) => s.address)).toEqual([
      FEE_PAYER,
      DESTINATION,
    ]);
  });
  it("derives SPL token deltas from the token account amount field", async () => {
    const source = pubkey(4),
      destination = pubkey(5),
      receiver = pubkey(6),
      token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const request = simulationRequest({
      transaction: buildTransaction({
        payer: FEE_PAYER,
        instructions: [
          transferChecked({
            source,
            mint: MINT,
            destination,
            owner: FEE_PAYER,
            amount: 600n,
          }),
        ],
      }),
    });
    const pre = [
        account(10_000),
        account(2_000, token, tokenAccountData(MINT, FEE_PAYER, 1_000n)),
        account(2_000, token, tokenAccountData(MINT, receiver, 0n)),
      ],
      post = [
        account(10_000),
        account(2_000, token, tokenAccountData(MINT, FEE_PAYER, 400n)),
        account(2_000, token, tokenAccountData(MINT, receiver, 600n)),
      ];
    const r = await simulator((method) => {
      if (method === "getGenesisHash") return GENESIS;
      if (method === "getMultipleAccounts")
        return { context: { slot: 100 }, value: pre };
      if (method === "simulateTransaction")
        return {
          context: { slot: 100 },
          value: { err: null, logs: [], accounts: post, unitsConsumed: 900 },
        };
      return { context: { slot: 100 }, value: 5_000 };
    }).simulate(request);
    expect(r.assetDeltas).toEqual([
      { asset: MINT, owner: FEE_PAYER, amount: -600n },
      { asset: MINT, owner: receiver, amount: 600n },
    ]);
  });
  it("refuses a token account whose mint or owner changed under the simulation", async () => {
    const source = pubkey(4),
      token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const request = simulationRequest({
      transaction: buildTransaction({
        payer: FEE_PAYER,
        instructions: [
          transferChecked({
            source,
            mint: MINT,
            destination: pubkey(5),
            owner: FEE_PAYER,
            amount: 1n,
          }),
        ],
      }),
    });
    const body = (mint: string) =>
      account(2_000, token, tokenAccountData(mint, FEE_PAYER, 1n));
    await expect(
      simulator((method) => {
        if (method === "getGenesisHash") return GENESIS;
        if (method === "getMultipleAccounts")
          return {
            context: { slot: 100 },
            value: [account(10_000), body(MINT), body(MINT)],
          };
        if (method === "simulateTransaction")
          return {
            context: { slot: 100 },
            value: {
              err: null,
              logs: [],
              accounts: [account(10_000), body(pubkey(8)), body(MINT)],
              unitsConsumed: 1,
            },
          };
        return { context: { slot: 100 }, value: 1 };
      }).simulate(request),
    ).rejects.toMatchObject({ code: "token_account_identity_changed" });
  });
  it("returns a decoded failure rather than fabricating clean evidence", async () => {
    const r = await simulator((method) => {
      if (method === "getGenesisHash") return GENESIS;
      if (method === "getMultipleAccounts")
        return { context: { slot: 100 }, value: [account(1), account(0)] };
      return {
        context: { slot: 100 },
        value: {
          err: { InstructionError: [0, { Custom: 6001 }] },
          logs: ["Program log: slippage"],
          accounts: null,
          unitsConsumed: 12,
        },
      };
    }).simulate(simulationRequest());
    expect(r.success).toBe(false);
    expect(r.err).toBe("InstructionError(0,Custom(6001))");
    expect(r.assetDeltas).toEqual([]);
    // The empty deltas above are explicitly *not* evidence of safety.
    expect(r.capabilities.balances).toBe(false);
    expect(r.capabilities.fee).toBe(false);
  });
  it.each([
    ["accounts", null, "account_states_unavailable"],
    ["accounts", [], "account_states_incomplete"],
    ["logs", null, "logs_unavailable"],
  ])(
    "raises a capability error when a successful simulation omits %s",
    async (field, value, code) => {
      await expect(
        simulator(transferRpc({ [field]: value })).simulate(
          simulationRequest(),
        ),
      ).rejects.toMatchObject({ code });
    },
  );
  it("refuses when the cluster no longer knows the blockhash to price it", async () => {
    await expect(
      simulator((method) =>
        method === "getFeeForMessage"
          ? { context: { slot: 100 }, value: null }
          : transferRpc()(method),
      ).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "fee_unavailable" });
  });
  it("rejects a cluster it cannot identify or that answers with another genesis", async () => {
    await expect(
      new RpcSimulator({
        url: "http://rpc",
        cluster: "localnet",
        fetch: rpcFetch(transferRpc()),
      }).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "cluster_unknown" });
    await expect(
      simulator((m) =>
        m === "getGenesisHash" ? pubkey(2) : transferRpc()(m),
      ).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "cluster_mismatch" });
    await expect(
      simulator(transferRpc()).simulate({
        ...simulationRequest(),
        cluster: "devnet",
      }),
    ).rejects.toMatchObject({ code: "cluster_mismatch" });
  });
  it("rejects a request whose message hash does not match its bytes", async () => {
    await expect(
      simulator(transferRpc()).simulate({
        ...simulationRequest(),
        messageHash: `0x${"99".repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: "transaction_mismatch" });
  });
  it("bounds slot drift instead of pretending the state was pinned", async () => {
    const drifting = (slot: number) => (method: string) =>
      method === "simulateTransaction"
        ? {
            context: { slot },
            value: {
              err: null,
              logs: [],
              accounts: [account(4_000), account(1_000)],
              unitsConsumed: 1,
            },
          }
        : transferRpc()(method);
    await expect(
      simulator(drifting(99)).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "slot_regressed" });
    await expect(
      simulator(drifting(1_000), { maxSlotDrift: 10 }).simulate(
        simulationRequest(),
      ),
    ).rejects.toMatchObject({ code: "slot_drift_exceeded" });
    const ok = await simulator(drifting(105)).simulate(simulationRequest());
    expect(ok.provenance).toMatchObject({
      pinned: false,
      preSlot: 100,
      slot: 105,
    });
  });
  it("refuses to observe more writable accounts than it will report on", async () => {
    await expect(
      simulator(transferRpc(), { maxObservedAccounts: 1 }).simulate(
        simulationRequest(),
      ),
    ).rejects.toMatchObject({ code: "observed_accounts_exceeded" });
  });
  it("strips credentials and query strings from the recorded endpoint", async () => {
    const r = await simulator(transferRpc()).simulate(simulationRequest());
    expect(r.provenance.url).toBe("https://rpc.test/path");
    expect(r.provenance).toMatchObject({
      provider: "solana-json-rpc",
      cluster: CLUSTER,
      genesisHash: GENESIS,
      commitment: "confirmed",
      replaceRecentBlockhash: false,
      lookupTablesResolvedByRpc: [],
    });
  });
  it("surfaces oversized responses, RPC errors and timeouts as coded failures", async () => {
    await expect(
      simulator((m) => (m === "getGenesisHash" ? GENESIS : "x".repeat(5_000)), {
        maxResponseBytes: 100,
      }).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await expect(
      simulator((m) =>
        m === "getMultipleAccounts" ? Error("node behind") : GENESIS,
      ).simulate(simulationRequest()),
    ).rejects.toBeInstanceOf(RpcSimulationError);
    await expect(
      new RpcSimulator({
        url: "http://rpc",
        cluster: CLUSTER,
        timeoutMs: 1,
        fetch: (async (_u: unknown, i?: RequestInit) =>
          new Promise((_r, reject) =>
            i?.signal?.addEventListener("abort", () =>
              reject(Object.assign(Error("aborted"), { name: "AbortError" })),
            ),
          )) as typeof fetch,
      }).simulate(simulationRequest()),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("address lookup tables", () => {
  const table = pubkey(20);
  const withLookup = () => {
    const transaction = buildTransaction({
      payer: FEE_PAYER,
      instructions: [systemTransfer(FEE_PAYER, DESTINATION, 1_000n)],
      lookupTables: [lookupTable(table, [DESTINATION])],
    });
    return simulationRequest({ transaction }, POLICY_HASH);
  };
  it("compiles the fixture through a lookup table at all", () => {
    expect(withLookup().addressTableLookups).toEqual([table]);
  });
  it("refuses a table the operator has not pinned rather than trusting an RPC", async () => {
    await expect(
      simulator(transferRpc()).simulate(withLookup()),
    ).rejects.toMatchObject({ code: "address_table_lookup_unpinned" });
  });
  it("resolves a pinned table and records that an RPC supplied the addresses", async () => {
    const calls: [string, unknown[]][] = [];
    let firstMultiple = true;
    const r = await simulator(
      (method) => {
        if (method === "getGenesisHash") return GENESIS;
        if (method === "getMultipleAccounts") {
          if (firstMultiple) {
            firstMultiple = false;
            return {
              context: { slot: 100 },
              value: [
                account(
                  1,
                  "AddressLookupTab1e1111111111111111111111111",
                  lookupTableData(FEE_PAYER, [DESTINATION]),
                ),
              ],
            };
          }
          return {
            context: { slot: 100 },
            value: [account(10_000), account(0)],
          };
        }
        if (method === "simulateTransaction")
          return {
            context: { slot: 100 },
            value: {
              err: null,
              logs: [],
              accounts: [account(4_000), account(1_000)],
              unitsConsumed: 1,
            },
          };
        return { context: { slot: 100 }, value: 5_000 };
      },
      { addressLookupTables: [table] },
      calls,
    ).simulate(withLookup());
    expect(r.provenance.lookupTablesResolvedByRpc).toEqual([table]);
    expect(r.provenance.observedAccounts).toEqual([FEE_PAYER, DESTINATION]);
    expect(r.capabilities.addressTableLookups).toBe(true);
  });
  it("refuses a pinned table that is missing or undecodable", async () => {
    for (const [value, code] of [
      [null, "address_table_lookup_missing"],
      [account(1, SYSTEM, "AAAA"), "address_table_lookup_invalid"],
    ] as const)
      await expect(
        simulator(
          (method) =>
            method === "getGenesisHash"
              ? GENESIS
              : { context: { slot: 100 }, value: [value] },
          { addressLookupTables: [table] },
        ).simulate(withLookup()),
      ).rejects.toMatchObject({ code });
  });
});

describe("simulation error decoding", () => {
  it.each([
    [
      { InstructionError: [1, { Custom: 6001 }] },
      "InstructionError(1,Custom(6001))",
    ],
    [
      { InstructionError: [0, "InvalidAccountData"] },
      "InstructionError(0,InvalidAccountData)",
    ],
    ["BlockhashNotFound", "BlockhashNotFound"],
    [{ InsufficientFundsForRent: { account_index: 0 } }, undefined],
    [null, "failed"],
    [{}, "failed"],
  ])("renders %j as a stable string", (err, expected) => {
    const decoded = decodeSimulationError(err);
    expect(typeof decoded).toBe("string");
    if (expected) expect(decoded).toBe(expected);
    else expect(decoded).toContain("InsufficientFundsForRent");
  });
});
