import { afterEach, describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import {
  ApprovalEngine,
  canonicalHash,
  type ApprovalRequestInput,
} from "../src/execution/approvals/index.js";
import { tmpdir } from "node:os";

const engines: ApprovalEngine[] = [];
const base = (
  over: Partial<ApprovalRequestInput> = {},
): ApprovalRequestInput => ({
  id: "r1",
  type: "broadcast",
  proposerId: "alice",
  chain: "eip155:1",
  serializedTransaction: {
    to: "0xrouter",
    value: "10",
    data: "0x1234",
    nonce: "7",
  },
  intentHash: "intent",
  policyHash: "policy",
  policyVersion: "3",
  simulationHash: "sim",
  simulationBlock: "100",
  simulationState: "state",
  account: "0xalice",
  nonce: "7",
  value: "10",
  calldata: "0x1234",
  router: "0xrouter",
  expiresAt: 2000,
  displayImpact: "Swap 10 units",
  ...over,
});
const make = (path = ":memory:", now = { v: 1000 }) => {
  const e = new ApprovalEngine(path, {
    clock: () => now.v,
    operators: [
      { id: "alice", roles: ["proposer"], scopes: ["*"] },
      { id: "bob", roles: ["approver"], scopes: ["broadcast", "sign"] },
      { id: "carol", roles: ["approver"], scopes: ["*"] },
    ],
    operatorConfigVersion: "v1",
    verifyDecisionProof: (p) =>
      p.proof ===
      `proof:${p.operatorId}:${p.requestId}:${p.decision}:${p.challenge}:${p.nonce}:${p.revision}:${p.timestamp}`,
  });
  engines.push(e);
  return { e, now };
};
const proof = (
  r: any,
  operatorId: string,
  decision: "approve" | "deny",
  nonce: string,
  revision: number,
  timestamp = 1000,
) => ({
  operatorId,
  decision,
  challenge: r.challenge,
  nonce,
  expectedRevision: revision,
  timestamp,
  proof: `proof:${operatorId}:${r.id}:${decision}:${r.challenge}:${nonce}:${revision}:${timestamp}`,
});
afterEach(() => {
  while (engines.length) engines.pop()!.close();
});

describe("durable exact-transaction approvals", () => {
  it("binds every security field and treats decoded impact as display-only", () => {
    const { e } = make();
    const r = e.request(base(), { quorum: 2 });
    expect(r).toMatchObject({
      status: "pending",
      revision: 0,
      transactionHash: canonicalHash(base().serializedTransaction),
      displayImpact: "Swap 10 units",
    });
    e.decide(r.id, proof(r, "bob", "approve", "n1", 0));
    const approved = e.decide(r.id, proof(r, "carol", "approve", "n2", 1));
    expect(approved.status).toBe("approved");
    expect(
      e.consume(r.id, {
        serializedTransaction: {
          nonce: "7",
          data: "0x1234",
          value: "10",
          to: "0xrouter",
        },
        chain: "eip155:1",
        intentHash: "intent",
        policyHash: "policy",
        policyVersion: "3",
        simulationHash: "sim",
        simulationBlock: "100",
        simulationState: "state",
        account: "0xalice",
        nonce: "7",
        value: "10",
        calldata: "0x1234",
        router: "0xrouter",
      }).status,
    ).toBe("consumed");
  });

  it.each([
    "sign",
    "broadcast",
    "allowance",
    "bridge",
    "withdraw",
    "policy-change",
  ] as const)("supports %s requests", (type) => {
    const { e } = make();
    expect(e.request(base({ id: `r-${type}`, type }), { quorum: 1 }).type).toBe(
      type,
    );
  });

  it("enforces distinct scoped approvers, no self approval, challenge and nonce anti-replay", () => {
    const { e } = make();
    const r = e.request(base(), { quorum: 2 });
    expect(() => e.decide(r.id, proof(r, "alice", "approve", "x", 0))).toThrow(
      /self/i,
    );
    expect(() =>
      e.decide(r.id, {
        ...proof(r, "bob", "approve", "x", 0),
        challenge: "wrong",
      }),
    ).toThrow(/challenge/i);
    e.decide(r.id, proof(r, "bob", "approve", "x", 0));
    expect(() => e.decide(r.id, proof(r, "bob", "approve", "y", 1))).toThrow(
      /distinct/i,
    );
    expect(() => e.decide(r.id, proof(r, "carol", "approve", "x", 1))).toThrow(
      /nonce/i,
    );
  });

  it("uses optimistic revisions across connections and keeps decisions append-only", () => {
    const path = `${tmpdir()}/approvals-${process.pid}-${Date.now()}.db`,
      now = { v: 1000 };
    const a = make(path, now).e,
      b = make(path, now).e;
    const r = a.request(base(), { quorum: 2 });
    a.decide(r.id, proof(r, "bob", "approve", "1", 0));
    expect(() => b.decide(r.id, proof(r, "carol", "approve", "2", 0))).toThrow(
      /revision/i,
    );
    b.decide(r.id, proof(r, "carol", "approve", "2", 1));
    expect(a.decisions(r.id)).toHaveLength(2);
    a.close();
    b.close();
    try {
      unlinkSync(path);
    } catch {}
  });

  it("fails closed for exact-field mutation, expiry, revocation, denial and one-time consume", () => {
    const { e, now } = make();
    const approve = (id: string) => {
      const r = e.request(base({ id }), { quorum: 1 });
      e.decide(id, proof(r, "bob", "approve", id, 0));
      return r;
    };
    const r = approve("mut");
    expect(() =>
      e.consume(r.id, {
        ...base(),
        serializedTransaction: {
          ...(base().serializedTransaction as Record<string, unknown>),
          value: "11",
        },
      }),
    ).toThrow(/exact|mismatch/i);
    const one = approve("one");
    const exact = { ...base(), id: "ignored" };
    e.consume(one.id, exact);
    expect(() => e.consume(one.id, exact)).toThrow(/consumed/i);
    const revoked = approve("rev");
    e.revoke(revoked.id, {
      operatorId: "carol",
      reason: "risk",
      expectedRevision: 1,
    });
    expect(() => e.consume(revoked.id, base())).toThrow(/revoked/i);
    const expired = approve("exp");
    now.v = 2001;
    expect(() => e.consume(expired.id, base())).toThrow(/expired/i);
    expect(e.get(expired.id)?.status).toBe("expired");
    now.v = 1000;
    const denied = e.request(base({ id: "deny" }), { quorum: 2 });
    e.decide(denied.id, proof(denied, "bob", "deny", "dn", 0));
    expect(e.get(denied.id)?.status).toBe("denied");
  });
});

describe("security hardening", () => {
  it("generates challenges and requires a proof bound to the complete decision", () => {
    const { e } = make();
    const r = e.request(base(), { quorum: 1 });
    expect(r.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      e.decide(r.id, {
        ...proof(r, "bob", "approve", "n-1234567890123456", 0),
        proof: "forged",
      }),
    ).toThrow(/proof/i);
    expect(
      e.decide(r.id, proof(r, "bob", "approve", "n-1234567890123456", 0))
        .status,
    ).toBe("approved");
  });
  it("rejects caller-controlled challenges and always requires injected proof", () => {
    const { e } = make();
    expect(() =>
      e.request(base(), { quorum: 1, challenge: "attacker-known" } as any),
    ).toThrow(/challenge/i);
    const r = e.request(base(), { quorum: 1 });
    expect(() =>
      e.decide(r.id, {
        operatorId: "bob",
        decision: "approve",
        challenge: r.challenge,
        nonce: "n",
        expectedRevision: 0,
      }),
    ).toThrow(/proof/i);
  });
  it("rejects duplicate operator config and impossible quorum", () => {
    expect(
      () =>
        new ApprovalEngine(":memory:", {
          operators: [
            { id: "bob", roles: ["approver"], scopes: ["*"] },
            { id: "bob", roles: ["approver"], scopes: ["*"] },
          ],
          operatorConfigVersion: "v1",
          verifyDecisionProof: () => true,
        }),
    ).toThrow(/duplicate/i);
    const { e } = make();
    expect(() => e.request(base(), { quorum: 3 })).toThrow(/quorum/i);
  });
  it("validates inputs and canonical transaction bytes", () => {
    const { e } = make();
    expect(() => e.request(base({ id: "" }), { quorum: 1 })).toThrow(/id/i);
    expect(() =>
      e.request(base({ serializedTransaction: { arbitrary: true } }), {
        quorum: 1,
      }),
    ).toThrow(/transaction/i);
    expect(() => e.request(base({ intentHash: "" }), { quorum: 1 })).toThrow(
      /hash/i,
    );
  });
  it("records immutable lifecycle audit with attribution", () => {
    const { e } = make();
    const r = e.request(base(), { quorum: 1 });
    e.decide(r.id, proof(r, "bob", "approve", "n-1234567890123456", 0));
    e.revoke(r.id, {
      operatorId: "carol",
      reason: "risk",
      expectedRevision: 1,
    });
    expect(e.audit(r.id).map((x) => x.event)).toEqual([
      "created",
      "approved",
      "revoked",
    ]);
    expect(e.audit(r.id)[2]).toMatchObject({
      operatorId: "carol",
      reason: "risk",
      bindingHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(() =>
      e.unsafeDatabaseForTests().exec("DELETE FROM approval_events"),
    ).toThrow(/append-only/i);
  });
  it("commits expiration before throwing from consume", () => {
    const { e, now } = make();
    const r = e.request(base(), { quorum: 1 });
    e.decide(r.id, proof(r, "bob", "approve", "n-1234567890123456", 0));
    now.v = 2001;
    expect(() => e.consume(r.id, base())).toThrow(/expired/i);
    expect(e.audit(r.id).at(-1)?.event).toBe("expired");
  });
});
