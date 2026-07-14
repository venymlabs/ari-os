import { createHash } from "node:crypto";
export type Correlation = {
  runId?: string;
  sessionId?: string;
  toolId?: string;
  intentId?: string;
  policyId?: string;
  simulationId?: string;
  approvalId?: string;
  txId?: string;
};
export interface ObservabilityEvent {
  name: string;
  timestamp: number;
  correlation: Correlation;
  attributes: Record<string, unknown>;
}
const secret =
  /(secret|password|token|authorization|api.?key|private.?key|seed|mnemonic|signed.?transaction|raw.?tx)/i;
function clean(
  v: unknown,
  max: number,
  key = "",
  seen = new WeakSet<object>(),
): unknown {
  if (secret.test(key)) return "[REDACTED]";
  if (typeof v === "string") return v.slice(0, max);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v))
    return v.slice(0, 20).map((x) => clean(x, max, "", seen));
  if (v && typeof v === "object") {
    if (seen.has(v)) return "[CIRCULAR]";
    seen.add(v);
    return Object.fromEntries(
      Object.entries(v)
        .slice(0, 50)
        .map(([k, x]) => [k, clean(x, max, k, seen)]),
    );
  }
  return (typeof v === "number" && Number.isFinite(v)) ||
    typeof v === "boolean" ||
    v === null
    ? v
    : String(v);
}
export class SecureEventLogger {
  constructor(
    private sink: (e: ObservabilityEvent) => void,
    private options: {
      maxFields?: number;
      maxValueLength?: number;
      now?: () => number;
    } = {},
  ) {}
  emit(
    name: string,
    correlation: Correlation = {},
    attributes: Record<string, unknown> = {},
  ) {
    const entries = Object.entries(attributes).slice(
      0,
      this.options.maxFields ?? 32,
    );
    this.sink({
      name: name.slice(0, 128),
      timestamp: (this.options.now ?? Date.now)(),
      correlation: clean(correlation, 128) as Correlation,
      attributes: Object.fromEntries(
        entries.map(([k, v]) => [
          k,
          clean(v, this.options.maxValueLength ?? 1024, k),
        ]),
      ),
    });
  }
  startSpan(name: string, correlation: Correlation = {}) {
    const attributes: Record<string, unknown> = {};
    return {
      setAttribute: (k: string, v: unknown) => {
        attributes[k] = v;
      },
      end: () => this.emit(`span.${name}`, correlation, attributes),
    };
  }
}
class Counter {
  constructor(
    private r: MetricRegistry,
    private n: string,
  ) {}
  add(v = 1, l: Record<string, string> = {}) {
    this.r.add(this.n, v, l);
  }
}
export class MetricRegistry {
  private values = new Map<string, number>();
  private cardinality = new Map<string, Set<string>>();
  constructor(private options: { maxLabelValues?: number } = {}) {}
  counter(name: string) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name))
      throw Error("invalid metric name");
    return new Counter(this, name);
  }
  add(n: string, v: number, l: Record<string, string>) {
    const labels = Object.entries(l).sort();
    for (const [k, x] of labels) {
      const key = `${n}:${k}`,
        s = this.cardinality.get(key) ?? new Set<string>();
      if (!s.has(x) && s.size >= (this.options.maxLabelValues ?? 100)) return;
      s.add(x);
      this.cardinality.set(key, s);
    }
    const suffix = labels.length
      ? `{${labels.map(([k, x]) => `${k}=${JSON.stringify(x.slice(0, 128))}`).join(",")}}`
      : "";
    const key = n + suffix;
    this.values.set(key, (this.values.get(key) ?? 0) + v);
  }
  expose() {
    return (
      [...this.values]
        .sort()
        .map(([k, v]) => `${k} ${v}`)
        .join("\n") + "\n"
    );
  }
}
export type HealthKind = "liveness" | "readiness";
export class HealthRegistry {
  private checks = new Map<
    string,
    { kind: HealthKind; check: () => boolean | Promise<boolean> }
  >();
  register(
    name: string,
    kind: HealthKind,
    check: () => boolean | Promise<boolean>,
  ) {
    if (this.checks.has(name)) throw Error("duplicate health dependency");
    this.checks.set(name, { kind, check });
  }
  async check(kind: HealthKind) {
    const dependencies: Record<string, "healthy" | "unhealthy"> = {};
    for (const [n, c] of this.checks)
      if (c.kind === kind) {
        try {
          dependencies[n] = (await c.check()) ? "healthy" : "unhealthy";
        } catch {
          dependencies[n] = "unhealthy";
        }
      }
    return {
      ok: Object.values(dependencies).every((x) => x === "healthy"),
      kind,
      dependencies,
    };
  }
}
export interface AuditRoot {
  root: string;
  leafCount: number;
  createdAt: number;
}
export interface ImmutableAuditSink {
  append(root: Readonly<AuditRoot>): Promise<void>;
}
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "bigint"
      ? x.toString()
      : x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort())
        : x,
  );
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class AuditRootBatcher {
  private leaves: string[] = [];
  constructor(
    private sink: ImmutableAuditSink,
    private size = 100,
    private now = Date.now,
  ) {
    if (size < 1) throw Error("invalid batch size");
  }
  async add(event: unknown) {
    this.leaves.push(hash(canonical(clean(event, 4096))));
    if (this.leaves.length < this.size) return;
    return this.flush();
  }
  async flush() {
    if (!this.leaves.length) return;
    let level = this.leaves.splice(0);
    const count = level.length;
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2)
        next.push(hash(level[i]! + (level[i + 1] ?? level[i]!)));
      level = next;
    }
    const root = Object.freeze({
      root: level[0]!,
      leafCount: count,
      createdAt: this.now(),
    });
    await this.sink.append(root);
    return root;
  }
}
export interface AlertSnapshot {
  killSwitch?: boolean;
  policyDenials?: number;
  nonceGap?: number;
  stuckTxSeconds?: number;
  rpcDisagreement?: boolean;
  reorgDepth?: number;
  signerErrors?: number;
  simulationDivergence?: boolean;
}
export interface Alert {
  code: string;
  severity: "critical" | "warning";
}
export function evaluateAlerts(
  s: AlertSnapshot,
  t: { policyDenialThreshold?: number; stuckTxSeconds?: number } = {},
): Alert[] {
  const a: Alert[] = [];
  const add = (
    yes: boolean,
    code: string,
    severity: Alert["severity"] = "warning",
  ) => {
    if (yes) a.push({ code, severity });
  };
  add(!!s.killSwitch, "KILL_SWITCH", "critical");
  add(
    (s.policyDenials ?? 0) > (t.policyDenialThreshold ?? 10),
    "POLICY_DENIAL_SPIKE",
  );
  add((s.nonceGap ?? 0) > 0, "NONCE_GAP");
  add((s.stuckTxSeconds ?? 0) > (t.stuckTxSeconds ?? 300), "STUCK_TX");
  add(!!s.rpcDisagreement, "RPC_DISAGREEMENT", "critical");
  add((s.reorgDepth ?? 0) > 0, "REORG", "critical");
  add((s.signerErrors ?? 0) > 0, "SIGNER_ERRORS", "critical");
  add(!!s.simulationDivergence, "SIMULATION_DIVERGENCE", "critical");
  return a;
}
