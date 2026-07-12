import { describe, expect, it } from "vitest";
import { analyzeRisk } from "../src/risk/index.js";

describe("risk analytics", () => {
  it("scores multiple risk dimensions and communicates uncertainty", () => {
    const report = analyzeRisk({
      token: { address: "0xabc", verified: false, isProxy: true, name: "USDT Official ✅ http://x.bad" },
      holders: [{ address: "a", share: .55 }, { address: "b", share: .2 }],
      liquidityUsd: 4_000,
      pairCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
      restrictions: { sellRestricted: true, buyTaxPercent: 12, sellTaxPercent: 30 },
      sources: [{ source: "one", priceUsd: 1 }, { source: "two", priceUsd: 1.5 }],
    }, { now: Date.now() });
    expect(report.score).toBeGreaterThan(70);
    expect(report.level).toBe("critical");
    expect(report.factors.map(x => x.code)).toEqual(expect.arrayContaining(["HOLDER_CONCENTRATION", "LOW_LIQUIDITY", "NEW_PAIR", "PROXY", "UNVERIFIED", "SELL_RESTRICTION", "HIGH_TAX", "SUSPICIOUS_METADATA", "SOURCE_DISAGREEMENT"]));
    expect(report.confidence).toBeLessThan(1);
    expect(report.honeypot).toBe("unverified");
    expect(report.disclaimer).toMatch(/simulation/i);
  });

  it("returns bounded low risk and lower confidence when evidence is sparse", () => {
    const report = analyzeRisk({ token: { address: "0xabc", verified: true }, sources: [{ source: "one" }] });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.confidence).toBeLessThan(.5);
    expect(report.level).toBe("low");
  });
});
