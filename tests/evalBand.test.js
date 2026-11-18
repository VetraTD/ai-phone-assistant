import { describe, it, expect } from "vitest";

import { fisherOneSided, band, tally, scenarioNames } from "../scripts/eval-band.js";

/**
 * The statistics behind the eval noise band.
 *
 * These are pinned against HAND-COMPUTED hypergeometric values, not against
 * whatever the implementation happened to return when it was written. That
 * distinction is the whole point: a gate whose expected values were copied from
 * its own output cannot detect that it is wrong, and this file's job is to be
 * the thing that could.
 */
describe("fisherOneSided", () => {
  // C(5,0)*C(5,5) / C(10,5) = 1/252
  it("gives p=1/252 for a clean 5-0 split, the strongest signal n=5 can produce", () => {
    expect(fisherOneSided(0, 5, 5, 0)).toBeCloseTo(1 / 252, 10);
  });

  // The margins move with the table: here the TOTAL failure count is 4, not 5,
  // so the denominator is C(10,4) rather than C(10,5). Getting that wrong is
  // how this test was first written, and the implementation was right.
  //   C(5,0)*C(5,4) / C(10,4) = 5/210
  it("gives p=5/210 for a 4-1 split — still under 0.05, but only just", () => {
    const p = fisherOneSided(0, 5, 4, 1);
    expect(p).toBeCloseTo(5 / 210, 10);
    expect(p).toBeLessThan(0.05);
  });

  // C(5,0)*C(5,3) / C(10,3) = 10/120. Above 0.05: the documented limit.
  it("CANNOT call a 3-of-5 regression significant, and that limit is real", () => {
    const p = fisherOneSided(0, 5, 3, 2);
    expect(p).toBeCloseTo(10 / 120, 10);
    expect(p).toBeGreaterThan(0.05);
  });

  it("is ~1 when both arms fail identically — no signal in agreement", () => {
    expect(fisherOneSided(3, 2, 3, 2)).toBeGreaterThan(0.5);
  });

  it("is 1 when the candidate is BETTER, because it is one-sided by design", () => {
    expect(fisherOneSided(5, 0, 0, 5)).toBeCloseTo(1, 10);
  });

  it("never exceeds 1 for any small table — the summation cannot overshoot", () => {
    for (let bf = 0; bf <= 5; bf++) {
      for (let cf = 0; cf <= 5; cf++) {
        const p = fisherOneSided(bf, 5 - bf, cf, 5 - cf);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("band", () => {
  it("reports the observed range rather than a single number", () => {
    expect(band([37, 36, 35, 36, 36])).toEqual({ min: 35, max: 37, mean: 36, spread: 2 });
  });

  it("reports spread 0 when a suite really is deterministic", () => {
    expect(band([37, 37, 37]).spread).toBe(0);
  });
});

const run = (pairs) => ({
  byName: new Map(pairs.map(([name, hardPass, judgePass = true]) => [name, { name, hardPass, judgePass }])),
});

describe("tally", () => {
  it("counts failures per scenario across runs", () => {
    const runs = [run([["a", true]]), run([["a", false]]), run([["a", false]])];
    expect(tally(runs, ["a"]).get("a")).toMatchObject({ hardFail: 2, present: 3, missing: 0 });
  });

  it("does NOT count a missing scenario as a pass — it reports it as missing", () => {
    const runs = [run([["a", true]]), run([["b", true]])];
    const t = tally(runs, ["a", "b"]);
    // If absence were silently treated as a pass, `missing` would be 0 here and
    // a suite that lost a scenario would look like a suite that passed it.
    expect(t.get("a")).toMatchObject({ present: 1, missing: 1, hardFail: 0 });
    expect(t.get("b")).toMatchObject({ present: 1, missing: 1, hardFail: 0 });
  });
});

describe("scenarioNames", () => {
  it("unions across runs, so a gained or lost scenario is visible", () => {
    expect(scenarioNames([run([["b", true]]), run([["a", true]])])).toEqual(["a", "b"]);
  });
});
