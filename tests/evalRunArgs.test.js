/**
 * The eval runner's flag surface.
 *
 * Cheap on purpose: everything else in eval/ costs real Gemini tokens to
 * exercise, so the argument parsing — which is pure, and which silently
 * changes what a whole run does — is worth covering here for free.
 */
import { describe, it, expect, vi } from "vitest";
import { parseArgs, summarizeCost, printCostReport } from "../eval/run.js";

describe("parseArgs", () => {
  it("defaults to NOT running the judge", () => {
    // Changed 2026-08-30. The advisory judge re-sends the entire transcript
    // once per question per scenario and has never set the exit code — the
    // 37-scenario hard gate is the only thing that does. It was the largest
    // line in the $10 -> $85 August Gemini bill, and that bill was development
    // evals, not production traffic. Iterating should be cheap by default; the
    // run that decides a merge opts in.
    expect(parseArgs([]).noJudge).toBe(true);
  });

  it("--judge opts back in", () => {
    expect(parseArgs(["--judge"]).noJudge).toBe(false);
  });

  it("--no-judge still parses, so existing scripts and docs do not die", () => {
    expect(parseArgs(["--no-judge"]).noJudge).toBe(true);
  });

  it("composes with the flags people actually pair it with", () => {
    const o = parseArgs(["--filter", "date-without-time", "--no-judge", "--json", "out.json"]);
    expect(o.filter).toBe("date-without-time");
    expect(o.noJudge).toBe(true);
    expect(o.json).toBe("out.json");
  });

  it("keeps the other defaults intact", () => {
    const o = parseArgs([]);
    expect(o.concurrency).toBe(2);
    expect(o.matrix).toBe(false);
    expect(o.filter).toBeNull();
  });

  it("still rejects an unknown flag rather than ignoring it", () => {
    const prev = process.exitCode;
    try {
      parseArgs(["--no-judgee"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// The run cost report.
//
// Pure, so it is free to test — and worth testing, because the one arithmetic
// mistake available here (treating cachedTokens as an ADDITION to promptTokens
// rather than a subset of it) would overstate every bill and understate every
// saving, in a number people are meant to make spending decisions from.
// ---------------------------------------------------------------------------
describe("summarizeCost", () => {
  const run = (turns) => [{ turns }];

  it("treats cached tokens as a subset of prompt tokens, not an addition", () => {
    const c = summarizeCost(run([{ usage: { promptTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 } }]));
    expect(c.promptTokens).toBe(1_000_000);
    expect(c.cachedTokens).toBe(1_000_000);
    // Fully cached: 1M at the cached rate, nothing at the fresh rate.
    expect(c.estimatedUsd).toBeCloseTo(0.075, 6);
    // ...against $0.75 uncached.
    expect(c.savedUsd).toBeCloseTo(0.675, 6);
  });

  it("prices a fully uncached run at the fresh input rate and reports no saving", () => {
    const c = summarizeCost(run([{ usage: { promptTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000 } }]));
    expect(c.estimatedUsd).toBeCloseTo(0.75 + 3.75, 6);
    expect(c.savedUsd).toBeCloseTo(0, 6);
  });

  it("ignores turns the SDK reported no usage for, rather than counting them as free", () => {
    const c = summarizeCost(run([{ usage: null }, { usage: { promptTokens: 100, outputTokens: 10 } }]));
    expect(c.turnsWithUsage).toBe(1);
  });

  it("survives an empty run without dividing by anything", () => {
    const c = summarizeCost([]);
    expect(c.turnsWithUsage).toBe(0);
    expect(c.estimatedUsd).toBe(0);
  });
});

// The printer is exported and smoke-tested because the alternative place to
// discover a typo in it is at the end of an $8 five-run band.
describe("printCostReport", () => {
  it("prints the dollar figure and the cached share", () => {
    const lines = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    printCostReport([{ turns: [{ usage: { promptTokens: 1_000_000, cachedTokens: 900_000, outputTokens: 1000 } }] }]);
    spy.mockRestore();
    const out = lines.join("\n");
    expect(out).toMatch(/estimated cost:\s+\$/);
    expect(out).toMatch(/cache saved:\s+\$/);
    expect(out).toMatch(/90/); // 900k of 1M cached
  });

  it("says so plainly when no turn carried usage, instead of printing $0.000", () => {
    const lines = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    printCostReport([{ turns: [{ usage: null }] }]);
    spy.mockRestore();
    expect(lines.join("\n")).toMatch(/nothing to price/);
  });
});
