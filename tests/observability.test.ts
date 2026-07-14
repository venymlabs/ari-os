import { describe, it, expect } from "vitest";
import {
  SecureEventLogger,
  MetricRegistry,
  HealthRegistry,
  AuditRootBatcher,
  evaluateAlerts,
  type ImmutableAuditSink,
} from "../src/observability/index.js";

describe("secure observability", () => {
  it("emits correlated bounded events and recursively redacts secrets and signed transactions", () => {
    const out: any[] = [];
    const log = new SecureEventLogger((e) => out.push(e), {
      maxFields: 3,
      maxValueLength: 8,
    });
    log.emit(
      "execution",
      {
        runId: "r",
        sessionId: "s",
        toolId: "t",
        intentId: "i",
        policyId: "p",
        simulationId: "m",
        approvalId: "a",
        txId: "x",
      },
      {
        password: "secret",
        nested: { authorization: "Bearer abc", rawSignedTransaction: "0xdead" },
        long: "123456789",
        extra: 1,
      },
    );
    expect(out[0].correlation).toEqual({
      runId: "r",
      sessionId: "s",
      toolId: "t",
      intentId: "i",
      policyId: "p",
      simulationId: "m",
      approvalId: "a",
      txId: "x",
    });
    expect(JSON.stringify(out[0])).not.toContain("secret");
    expect(JSON.stringify(out[0])).not.toContain("0xdead");
    expect(out[0].attributes.long).toBe("12345678");
    expect(Object.keys(out[0].attributes)).toHaveLength(3);
  });
  it("provides dependency-light tracing", () => {
    const out: any[] = [];
    const log = new SecureEventLogger((e) => out.push(e));
    const span = log.startSpan("sign", { runId: "r" });
    span.setAttribute("apiKey", "bad");
    span.end();
    expect(out[0].name).toBe("span.sign");
    expect(out[0].attributes.apiKey).toBe("[REDACTED]");
  });
  it("bounds metric label cardinality and exposes Prometheus text", () => {
    const m = new MetricRegistry({ maxLabelValues: 2 });
    m.counter("policy_denials_total").add(2, { policy: "a" });
    m.counter("policy_denials_total").add(1, { policy: "b" });
    m.counter("policy_denials_total").add(9, { policy: "c" });
    expect(m.expose()).toContain('policy_denials_total{policy="a"} 2');
    expect(m.expose()).not.toContain('policy="c"');
  });
  it("separates liveness from dependency readiness", async () => {
    const h = new HealthRegistry();
    h.register("db", "readiness", async () => true);
    h.register("event", "readiness", async () => false);
    h.register("loop", "liveness", () => true);
    expect((await h.check("liveness")).ok).toBe(true);
    const ready = await h.check("readiness");
    expect(ready.ok).toBe(false);
    expect(ready.dependencies.event).toBe("unhealthy");
  });
  it("batches deterministic Merkle roots into immutable sink", async () => {
    const roots: any[] = [];
    const sink: ImmutableAuditSink = {
      append: async (root) => {
        roots.push(root);
      },
    };
    const b = new AuditRootBatcher(sink, 2);
    expect(await b.add({ b: 2, a: 1 })).toBeUndefined();
    const root = await b.add({ a: 2 });
    expect(root?.leafCount).toBe(2);
    expect(root?.root).toMatch(/^[a-f0-9]{64}$/);
    expect(roots).toEqual([root]);
    expect(Object.isFrozen(root)).toBe(true);
  });
  it("raises all critical operational alert classes", () => {
    const alerts = evaluateAlerts(
      {
        killSwitch: true,
        policyDenials: 11,
        nonceGap: 2,
        stuckTxSeconds: 301,
        rpcDisagreement: true,
        reorgDepth: 1,
        signerErrors: 1,
        simulationDivergence: true,
      },
      { policyDenialThreshold: 10, stuckTxSeconds: 300 },
    );
    expect(alerts.map((a) => a.code)).toEqual([
      "KILL_SWITCH",
      "POLICY_DENIAL_SPIKE",
      "NONCE_GAP",
      "STUCK_TX",
      "RPC_DISAGREEMENT",
      "REORG",
      "SIGNER_ERRORS",
      "SIMULATION_DIVERGENCE",
    ]);
  });
});
