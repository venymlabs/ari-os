import { describe, expect, it } from "vitest";
import { runSelfcheck } from "../src/kernel/selfcheck/run.js";

/**
 * The kernel selfcheck drives TradeGateway over synthetic ports and asserts the
 * safety invariants end to end. It is also runnable as a script
 * (`node dist/kernel/selfcheck/run.js`); this suite is the CI gate for it.
 */
describe("kernel selfcheck invariants", () => {
  it("holds every invariant when the chokepoint is driven over synthetic state", async () => {
    const report = await runSelfcheck();
    const failed = report.checks.filter((c) => !c.ok);
    expect(
      failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`),
    ).toEqual([]);
    expect(report.failures).toBe(0);
    expect(report.total).toBeGreaterThanOrEqual(30);
  }, 30000);

  it("covers the invariants that actually protect capital", async () => {
    const names = new Set((await runSelfcheck()).checks.map((c) => c.name));
    for (const required of [
      "per-trade cap rejects",
      "duplicate does not double-spend the cap",
      "slippage over the clamp is refused",
      "token-2022 mint is refused",
      "untrusted mint without confirmation is refused",
      "disarmed engine refuses to execute",
      "expired trade is terminal and never re-signed",
      "concurrent race: cap counted once (no double-spend)",
      "signed wire is persisted before broadcast is attempted",
      "priority fee over the bps-of-notional cap is refused",
      "reconciler releases the cap for an expired trade",
    ])
      expect(names).toContain(required);
  }, 30000);
});
