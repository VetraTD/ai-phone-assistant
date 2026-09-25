import { describe, it, expect } from "vitest";
import {
  CAP_USD,
  P1_CAP_USD,
  BudgetExceeded,
  p1Spent,
  reserveP1,
} from "../scripts/probes/lib/spendLive.js";

// Outbound Part 1's budget (spec D8): $10, inside the shared probe ledger. The
// ledger is passed in rather than read from disk, so these tests never touch
// scripts/probes/spend-gptlive.json.
//
// The production change that would turn these red: reserveP1 checking only one
// of the two caps, counting non-P1 entries as Part 1 spend, or accepting a
// label that is not P1- (whose spend would then never count against the $10).

const ledger = (entries) => ({
  spent_usd: entries.reduce((s, e) => s + e.usd, 0),
  entries,
});

describe("p1Spent", () => {
  it("counts only entries whose probe starts with P1-", () => {
    const s = ledger([
      { probe: "T4-38n10", usd: 2.0 },
      { probe: "P1-SPIKE-A", usd: 0.1 },
      { probe: "P1-SPIKE-B", usd: 0.25 },
      { probe: "VOICE38", usd: 0.01 },
    ]);
    expect(p1Spent(s)).toBeCloseTo(0.35, 10);
  });

  it("is zero on a ledger with no Part 1 entries", () => {
    expect(p1Spent(ledger([{ probe: "KNOBS", usd: 1 }]))).toBe(0);
  });
});

describe("reserveP1", () => {
  it("allows spend inside both caps and reports what is left", () => {
    const s = ledger([{ probe: "OLD", usd: 21.73 }, { probe: "P1-SPIKE-A", usd: 1 }]);
    const r = reserveP1("P1-SPIKE-B", 0.5, s);
    expect(r.p1Spent).toBeCloseTo(1, 10);
    expect(r.p1Remaining).toBeCloseTo(P1_CAP_USD - 1, 10);
  });

  it("refuses spend that would take Part 1 past its $10 even when the ledger has room", () => {
    const s = ledger([{ probe: "P1-LIVE-R1", usd: 9.9 }]);
    expect(() => reserveP1("P1-LIVE-R2", 0.2, s)).toThrow(BudgetExceeded);
    expect(() => reserveP1("P1-LIVE-R2", 0.2, s)).toThrow(/Part 1 cap/);
  });

  it("refuses spend that would take the whole ledger past CAP_USD even when Part 1 has room", () => {
    const s = ledger([{ probe: "OLD", usd: CAP_USD - 0.05 }]);
    expect(() => reserveP1("P1-SPIKE-A", 0.1, s)).toThrow(BudgetExceeded);
    expect(() => reserveP1("P1-SPIKE-A", 0.1, s)).toThrow(/cap/);
  });

  it("refuses a label that is not P1-, so Part 1 spend cannot escape the count", () => {
    // The message is asserted, not just the type: calling a function that does
    // not exist is ALSO a TypeError, and this test passed vacuously that way.
    expect(() => reserveP1("SPIKE-A", 0.01, ledger([]))).toThrow(/must start with "P1-"/);
  });

  it("refuses a worst case that is not a non-negative number", () => {
    expect(() => reserveP1("P1-SPIKE-A", -1, ledger([]))).toThrow(/non-negative number/);
    expect(() => reserveP1("P1-SPIKE-A", "0.1", ledger([]))).toThrow(/non-negative number/);
  });

  it("the overall cap was raised by exactly the $10 Part 1 budget over the $21.73 already spent", () => {
    expect(CAP_USD).toBeCloseTo(31.73, 10);
    expect(P1_CAP_USD).toBe(10);
  });
});
