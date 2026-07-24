/**
 * Pure aggregation + table-shaping helpers for `eval/run.js --matrix`
 * (Task 6 / plan step 1.5 — benchmark matrix mode).
 *
 * Everything here operates on already-collected `runScenario()` results (see
 * eval/run.js) or on the per-config summaries derived from them. No network
 * calls, no fs, no process — that's what makes this the unit-testable slice
 * of the matrix feature; the runner and the servability probe are API-bound
 * and are exercised live instead (see the Task 6 brief).
 */

/**
 * Nearest-rank percentile, matching the semantics `eval/run.js`'s single-run
 * report has always used (sort ascending, floor(p/100 * n), clamp to the
 * last index).
 *
 * @param {number[]} values
 * @param {number} p - 0..100
 * @returns {number|null} null for an empty input
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** @param {number[]} values */
export function median(values) {
  return percentile(values, 50);
}

/**
 * Aggregate one config's full set of per-scenario `runScenario()` results
 * into the summary Task 6 requires: scenarios passed (hard), judge pass
 * rate, pooled p50/p95 latency (first-event and total-turn), total turns
 * across all scenarios, and scenario-level error count.
 *
 * Latency samples are POOLED across every scenario run under this config
 * (not averaged per-scenario first) — a config's p95 should reflect its
 * worst turns across the whole suite, not the p95-of-p50s.
 *
 * @param {Array<object>} results - `runScenario()` return values
 */
export function summarizeConfigResults(results) {
  const list = results || [];

  const firstEventSamples = list.flatMap((r) => r.latency?.firstEventMs || []);
  const totalSamples = list.flatMap((r) => r.latency?.totalMs || []);

  return {
    scenarioCount: list.length,
    hardPassCount: list.filter((r) => r.hardPass).length,
    judgePassCount: list.filter((r) => r.judgePass).length,
    totalTurns: list.reduce((sum, r) => sum + (r.turns?.length || 0), 0),
    errorCount: list.filter((r) => r.error).length,
    latency: {
      firstEvent: { p50: percentile(firstEventSamples, 50), p95: percentile(firstEventSamples, 95) },
      total: { p50: percentile(totalSamples, 50), p95: percentile(totalSamples, 95) },
    },
  };
}

const fmtMs = (v) => (v == null ? "—" : `${v}ms`);

/**
 * Shape one comparison-table row per config entry.
 *
 * @param {Array<{label: string, available: boolean, scenarioCount: number, summary: object}>} entries
 * @returns {Array<object>} formatted row objects, one per entry, same order
 */
export function buildComparisonRows(entries) {
  return (entries || []).map(({ label, available, scenarioCount, summary }) => ({
    label,
    available: available ? "yes" : "no (skipped)",
    hard: `${summary.hardPassCount}/${scenarioCount}`,
    judge: `${summary.judgePassCount}/${scenarioCount}`,
    firstP50: fmtMs(summary.latency.firstEvent.p50),
    firstP95: fmtMs(summary.latency.firstEvent.p95),
    totalP50: fmtMs(summary.latency.total.p50),
    totalP95: fmtMs(summary.latency.total.p95),
    turns: summary.totalTurns,
    errors: summary.errorCount,
  }));
}

const pad = (s, n) => String(s).padEnd(n);

const COLUMNS = [
  { key: "label", header: "config", width: 26 },
  { key: "available", header: "servable", width: 12 },
  { key: "hard", header: "hard", width: 8 },
  { key: "judge", header: "judge", width: 8 },
  { key: "firstP50", header: "first p50", width: 10 },
  { key: "firstP95", header: "first p95", width: 10 },
  { key: "totalP50", header: "total p50", width: 10 },
  { key: "totalP95", header: "total p95", width: 10 },
  { key: "turns", header: "turns", width: 7 },
  { key: "errors", header: "errors", width: 7 },
];

/**
 * Render the cross-config comparison table as plain text (one row per
 * config, in the order given). Pure string shaping — printing it is the
 * caller's job.
 *
 * @param {Array<object>} rows - from buildComparisonRows
 * @returns {string}
 */
export function formatComparisonTable(rows) {
  const header = COLUMNS.map((c) => pad(c.header, c.width)).join(" ");
  const separator = "-".repeat(header.length);
  if (!rows || !rows.length) {
    return [header, separator, "(no configs)"].join("\n");
  }
  const lines = rows.map((r) => COLUMNS.map((c) => pad(r[c.key], c.width)).join(" "));
  return [header, separator, ...lines].join("\n");
}
