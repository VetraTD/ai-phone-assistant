/**
 * Unit tests for the eval suite's matrix-mode aggregation helpers
 * (eval/matrixAggregate.js) — Task 6 / plan step 1.5.
 *
 * These are pure functions operating on synthetic `runScenario` results, no
 * network calls. The runner/probe that FEEDS these (eval/run.js's --matrix
 * flow) is API-bound and is exercised live, not here — see the task brief.
 */

import { describe, it, expect } from "vitest";
import {
  percentile,
  median,
  summarizeConfigResults,
  buildComparisonRows,
  formatComparisonTable,
} from "../eval/matrixAggregate.js";

// A minimal synthetic result shaped like runScenario()'s return value.
function makeResult({
  name = "scenario",
  hardPass = true,
  judgePass = true,
  turns = 2,
  firstEventMs = [],
  totalMs = [],
  error = undefined,
} = {}) {
  return {
    name,
    hardPass,
    judgePass,
    hardResults: [{ pass: hardPass, name: "x", detail: "" }],
    judgeResults: judgePass ? [] : [{ question: "q", verdict: "fail", reason: "r" }],
    turns: Array.from({ length: turns }, (_, i) => ({ caller: `t${i}` })),
    latency: { firstEventMs, totalMs },
    error,
  };
}

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("returns the single value for a one-element array at any percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("computes p50 on a sorted array via nearest-rank", () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(300);
  });

  it("computes p95 on a larger array", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    // nearest-rank: floor(0.95 * 20) = 19 -> sorted[19] is the 20th (last) value
    expect(percentile(values, 95)).toBe(20);
  });

  it("is insensitive to input order (sorts internally)", () => {
    expect(percentile([400, 100, 300, 200], 50)).toBe(300);
  });
});

describe("median", () => {
  it("delegates to percentile(values, 50)", () => {
    expect(median([10, 20, 30])).toBe(20);
  });

  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });
});

describe("summarizeConfigResults", () => {
  it("aggregates hard/judge pass counts, turns, and errors across scenarios", () => {
    const results = [
      makeResult({ name: "a", hardPass: true, judgePass: true, turns: 3, firstEventMs: [100], totalMs: [500] }),
      makeResult({ name: "b", hardPass: false, judgePass: true, turns: 2, firstEventMs: [200], totalMs: [800] }),
      makeResult({ name: "c", hardPass: true, judgePass: false, turns: 4, firstEventMs: [300], totalMs: [900] }),
    ];
    const summary = summarizeConfigResults(results);

    expect(summary.scenarioCount).toBe(3);
    expect(summary.hardPassCount).toBe(2);
    expect(summary.judgePassCount).toBe(2);
    expect(summary.totalTurns).toBe(9);
    expect(summary.errorCount).toBe(0);
    expect(summary.latency.firstEvent.p50).not.toBeNull();
    expect(summary.latency.total.p50).not.toBeNull();
  });

  it("counts scenario-level errors separately from hard-assertion failures", () => {
    const results = [
      makeResult({ name: "a", hardPass: false, error: "boom" }),
      makeResult({ name: "b", hardPass: true }),
    ];
    const summary = summarizeConfigResults(results);
    expect(summary.errorCount).toBe(1);
    expect(summary.hardPassCount).toBe(1);
  });

  it("handles an empty results array (e.g. a config skipped by the servability probe)", () => {
    const summary = summarizeConfigResults([]);
    expect(summary.scenarioCount).toBe(0);
    expect(summary.hardPassCount).toBe(0);
    expect(summary.judgePassCount).toBe(0);
    expect(summary.totalTurns).toBe(0);
    expect(summary.errorCount).toBe(0);
    expect(summary.latency.firstEvent.p50).toBeNull();
    expect(summary.latency.total.p95).toBeNull();
  });

  it("pools latency samples across all scenarios in the config, not per-scenario", () => {
    const results = [
      makeResult({ name: "a", firstEventMs: [100, 200], totalMs: [] }),
      makeResult({ name: "b", firstEventMs: [300], totalMs: [] }),
    ];
    const summary = summarizeConfigResults(results);
    // 3 pooled samples -> p50 should be the middle one (200)
    expect(summary.latency.firstEvent.p50).toBe(200);
  });
});

describe("buildComparisonRows", () => {
  it("shapes one row per config, marking unavailable configs distinctly", () => {
    const entries = [
      {
        label: "cfg-a",
        available: true,
        scenarioCount: 2,
        summary: summarizeConfigResults([
          makeResult({ hardPass: true, firstEventMs: [100], totalMs: [400] }),
          makeResult({ hardPass: true, firstEventMs: [150], totalMs: [450] }),
        ]),
      },
      {
        label: "cfg-b (dead model)",
        available: false,
        scenarioCount: 2,
        summary: summarizeConfigResults([]),
      },
    ];
    const rows = buildComparisonRows(entries);
    expect(rows).toHaveLength(2);

    expect(rows[0].label).toBe("cfg-a");
    expect(rows[0].available).toMatch(/yes/i);
    expect(rows[0].hard).toBe("2/2");

    expect(rows[1].label).toBe("cfg-b (dead model)");
    expect(rows[1].available).toMatch(/no/i);
    expect(rows[1].hard).toBe("0/2");
  });
});

describe("formatComparisonTable", () => {
  it("renders a header and one line per row, in order", () => {
    const rows = buildComparisonRows([
      { label: "cfg-a", available: true, scenarioCount: 1, summary: summarizeConfigResults([makeResult()]) },
      { label: "cfg-b", available: false, scenarioCount: 1, summary: summarizeConfigResults([]) },
    ]);
    const table = formatComparisonTable(rows);
    expect(typeof table).toBe("string");
    const lines = table.split("\n").filter(Boolean);
    // at least a header + separator + 2 data rows
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(table).toContain("cfg-a");
    expect(table).toContain("cfg-b");
  });

  it("returns a placeholder line for an empty row set rather than throwing", () => {
    expect(() => formatComparisonTable([])).not.toThrow();
    expect(formatComparisonTable([])).toEqual(expect.any(String));
  });

  it("clips a long --matrix-file label to the column width with an ellipsis, preserving alignment", () => {
    const longLabel = "this-is-a-very-long-custom-matrix-file-label-that-would-otherwise-blow-past-the-column";
    const rows = buildComparisonRows([
      { label: longLabel, available: true, scenarioCount: 1, summary: summarizeConfigResults([makeResult()]) },
      { label: "short", available: true, scenarioCount: 1, summary: summarizeConfigResults([makeResult()]) },
    ]);
    const table = formatComparisonTable(rows);
    const lines = table.split("\n");
    // header + separator + 2 rows, and every line has the same length (fixed columns => alignment preserved)
    expect(lines.length).toBe(4);
    const lineLengths = new Set(lines.map((l) => l.length));
    expect(lineLengths.size).toBe(1);

    expect(table).not.toContain(longLabel);
    const dataLine = lines[2];
    expect(dataLine).toContain("…");
    expect(dataLine.startsWith(longLabel.slice(0, 10))).toBe(true);
  });
});

describe("buildComparisonRows — crash vs hard-assertion-failure rendering", () => {
  it("marks a config with scenario-level errors distinctly from a plain hard-assertion failure", () => {
    const crashedEntry = {
      label: "crashed-config",
      available: true,
      scenarioCount: 1,
      summary: summarizeConfigResults([makeResult({ hardPass: false, error: "400 INVALID_ARGUMENT" })]),
    };
    const failedEntry = {
      label: "failed-config",
      available: true,
      scenarioCount: 1,
      summary: summarizeConfigResults([makeResult({ hardPass: false })]),
    };
    const rows = buildComparisonRows([crashedEntry, failedEntry]);

    // Both show 0/1, but the crashed config's hard cell must be visibly
    // distinguishable from the clean hard-assertion failure.
    expect(rows[0].hard).toContain("0/1");
    expect(rows[0].hard).toMatch(/ERR\(1\)/);
    expect(rows[1].hard).toBe("0/1");
    expect(rows[1].hard).not.toMatch(/ERR/);
    expect(rows[0].hard).not.toBe(rows[1].hard);
  });

  it("marks a partially-crashed config (some scenarios errored, others just failed) distinctly too", () => {
    const entry = {
      label: "mixed-config",
      available: true,
      scenarioCount: 3,
      summary: summarizeConfigResults([
        makeResult({ hardPass: false, error: "boom" }),
        makeResult({ hardPass: false }),
        makeResult({ hardPass: true }),
      ]),
    };
    const [row] = buildComparisonRows([entry]);
    expect(row.hard).toBe("1/3 ERR(1)");
  });
});
