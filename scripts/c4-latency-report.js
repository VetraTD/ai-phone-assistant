#!/usr/bin/env node
/**
 * C4 — latency on the DEPLOYED stack against the A0 baseline.
 *
 *   node scripts/c4-latency-report.js --since 2026-08-25T14:00:00Z
 *   node scripts/c4-latency-report.js --since ... --until ...   # bound both ends
 *   node scripts/c4-latency-report.js --from-file entries.json  # an export you already have
 *   node scripts/c4-latency-report.js --print-query --since ... # just the gcloud command
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * C4 is "latency vs the A0 baseline", and until now there was no path from the
 * deployed stack to that comparison. `scripts/latency-probe.js --report-only`
 * re-renders a LOCAL probe run out of `latency-runs/`; it cannot see Cloud Run.
 * The A0 numbers lived only as a markdown table in the ledger. So C4 after a
 * live-call session meant somebody hand-writing a log query, extracting
 * payloads, computing percentiles per stage and comparing against a table by
 * eye — which is the kind of step that either does not happen or happens wrong.
 *
 * The data is already there and is durable: `lib/voice/metrics.js` emits one
 * structured `turn_latency` line PER TURN through `lib/logger.js`, and the
 * org-node sinks export it. That matters more than it sounds — the in-process
 * ring buffer behind `getCallStats()` is NOT a reliable source, because the
 * Twilio status callback that reads it is a separate HTTP request that can land
 * on a different Cloud Run instance, whose buffer is empty. The DB's
 * `calls.latency_*` columns can therefore be silently absent while the logs are
 * complete. C4 reads the logs.
 *
 * ---------------------------------------------------------------------------
 * AN EMPTY RESULT IS A FAILURE, NOT A CLEAN BILL OF HEALTH
 * ---------------------------------------------------------------------------
 *
 * The failure this file is most likely to produce is a query that matches
 * nothing and a report that says "no regression detected". Zero entries and
 * zero regressions look identical in a summary and are opposite facts. So a run
 * that finds no turns exits non-zero and says so in those words.
 *
 * The same reasoning applies one level down, per stage: a stage present in the
 * baseline and absent from the sample is reported as MISSING rather than
 * quietly skipped, because a stage that stopped being emitted is a finding.
 *
 * With one exception, which is marked in the baseline rather than guessed at.
 * `llm_tool_ms` and `llm_reply_after_tool_ms` are null on turns with no tool
 * call — metrics.js says so in its own comment — so their absence means the
 * calls did not exercise a tool, not that anything broke. Counting those would
 * fail every clean run, and a gate that cries wolf is one nobody reads. They
 * are reported as "not exercised" and do not affect the exit code.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT COMPARABLE
 * ---------------------------------------------------------------------------
 *
 * A0 ran on Railway, reached through carrier hops from a handset. This runs on
 * Cloud Run. End-to-end numbers are not strictly comparable and are printed
 * with that said out loud. The per-STAGE numbers are measured inside one
 * process and are comparable — which is the distinction that let the TTS
 * finding stand up, `tts_ttfb_ms` 92 -> 1,408 ms being a server-side stage
 * rather than a carrier artefact.
 *
 * The report also prints the covered-lane reference from 2026-08-22, because
 * "has the deployed stack moved" is usually the more useful question than "how
 * far is it from Railway".
 *
 * ---------------------------------------------------------------------------
 * THE TIMESTAMP FILTER IS EXPLICIT ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * `gcloud logging read --freshness` did not filter reliably here — a standing
 * fact in the ledger, found the expensive way. Every query this builds uses an
 * explicit `timestamp >= "..."` and, when given, `timestamp <= "..."`.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const BASELINE = JSON.parse(
  readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "eval", "a0-baseline.json"), "utf8")
);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const SERVICE = arg("--service", "voice-us-staging");
const PROJECT = arg("--project", "vetra-us-staging-c3a3bd");
const SINCE = arg("--since");
const UNTIL = arg("--until");
const FROM_FILE = arg("--from-file");

/** Explicit timestamps, never --freshness. See the header. */
function buildFilter() {
  const parts = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${SERVICE}"`,
    `jsonPayload.event="turn_latency"`,
  ];
  if (SINCE) parts.push(`timestamp>="${SINCE}"`);
  if (UNTIL) parts.push(`timestamp<="${UNTIL}"`);
  return parts.join(" AND ");
}

function gcloudCommand() {
  return [
    "gcloud logging read",
    `'${buildFilter()}'`,
    `--project=${PROJECT}`,
    "--format=json",
    "--limit=5000",
  ].join(" ");
}

/** p-th percentile of an ascending array. Same definition as lib/voice/metrics.js. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(values) {
  const s = values.filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
}

/** Cloud Logging wraps our line in jsonPayload; a raw stdout export does not. */
function payloadsFrom(entries) {
  return entries
    .map((e) => e.jsonPayload || e.json_payload || e)
    .filter((p) => p && p.event === "turn_latency");
}

function fmtDelta(now, base) {
  if (now == null || base == null) return "     —";
  const d = now - base;
  const pct = base === 0 ? "" : ` (${d >= 0 ? "+" : ""}${Math.round((d / base) * 100)}%)`;
  return `${d >= 0 ? "+" : ""}${d}${pct}`;
}

function row(label, now, base) {
  const n = now == null ? "—" : String(now);
  const b = base == null ? "—" : String(base);
  return `  ${label.padEnd(26)} ${b.padStart(8)} ${n.padStart(9)}   ${fmtDelta(now, base)}`;
}

async function main() {
  if (has("--print-query")) {
    console.log(gcloudCommand());
    return;
  }

  let entries;
  if (FROM_FILE) {
    entries = JSON.parse(readFileSync(FROM_FILE, "utf8"));
  } else {
    if (!SINCE) {
      console.error(
        "Give --since (an explicit RFC3339 timestamp), or --from-file with a\n" +
          "`gcloud logging read --format=json` export. --freshness is deliberately\n" +
          "not used: it did not filter reliably here.\n\n" +
          "To see the query without running it:  --print-query --since <ts>"
      );
      process.exitCode = 1;
      return;
    }
    console.log(`querying: ${gcloudCommand()}\n`);
    const out = execFileSync("gcloud", [
      "logging", "read", buildFilter(),
      `--project=${PROJECT}`, "--format=json", "--limit=5000",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    entries = JSON.parse(out);
  }

  const turns = payloadsFrom(Array.isArray(entries) ? entries : [entries]);

  // The guard that matters. Zero turns and zero regressions are opposite facts
  // that produce identical-looking summaries.
  if (turns.length === 0) {
    console.error(
      "NO `turn_latency` ENTRIES MATCHED.\n\n" +
        "This is a FAILED measurement, not a clean result — a report saying " +
        "'no regression' off zero\nsamples would be worse than no report. Check, in this order:\n" +
        "  - did a call actually happen inside the window?\n" +
        `  - is the service name right? (--service, currently "${SERVICE}")\n` +
        `  - is the project right? (--project, currently "${PROJECT}")\n` +
        "  - is the log sink's severity filter still DEBUG? INFO lines vanish below it.\n" +
        "  - are the timestamps RFC3339 and UTC?"
    );
    process.exitCode = 1;
    return;
  }

  const calls = new Set(turns.map((t) => t.callSid).filter(Boolean));
  console.log(`${turns.length} turns across ${calls.size} call(s)`);
  console.log(`baseline: A0 ${BASELINE.capturedAt} (${BASELINE.serverTurns} turns, ${BASELINE.calls} calls, Railway)\n`);

  let regressions = 0;
  let missing = 0;

  console.log("END TO END — not strictly comparable, A0 was Railway through carrier hops");
  console.log(`  ${"metric".padEnd(26)} ${"A0".padStart(8)} ${"now".padStart(9)}   delta`);
  for (const [name, base] of Object.entries(BASELINE.endToEnd)) {
    if (name.startsWith("_")) continue;
    const s = summarise(turns.map((t) => t[name]));
    if (!s) {
      console.log(row(`${name} p50`, null, base.p50) + "   MISSING");
      missing++;
      continue;
    }
    console.log(row(`${name} p50`, s.p50, base.p50));
    console.log(row(`${name} p95`, s.p95, base.p95));
  }

  console.log("\nPER STAGE — server-side, one process, genuinely comparable");
  console.log(`  ${"stage".padEnd(26)} ${"A0".padStart(8)} ${"now".padStart(9)}   delta`);
  for (const [name, base] of Object.entries(BASELINE.stages)) {
    if (name.startsWith("_")) continue;
    const s = summarise(turns.map((t) => t[name]));
    if (!s) {
      // `llm_tool_ms` and `llm_reply_after_tool_ms` are null on turns with no
      // tool call — metrics.js says so in its own comment — so their absence
      // means the calls did not exercise a tool, not that a stage broke.
      // Counting those as findings would fail every clean run, which is a gate
      // that cries wolf until nobody reads it.
      if (base.conditional) {
        console.log(row(`${name} p50`, null, base.p50) + "   not exercised — no tool call in this sample");
      } else {
        console.log(row(`${name} p50`, null, base.p50) + "   MISSING — stage not emitted at all");
        missing++;
      }
      continue;
    }
    console.log(row(`${name} p50`, s.p50, base.p50) + `   n=${s.n}`);
    if (base.p50 != null && s.p50 > base.p50) regressions++;
  }

  const ref = BASELINE._covered_lane_reference;
  console.log(`\nAGAINST THE COVERED LANE (${ref.capturedAt}) — usually the more useful question`);
  console.log(`  ${"metric".padEnd(26)} ${"then".padStart(8)} ${"now".padStart(9)}   delta`);
  const v2v = summarise(turns.map((t) => t.voice_to_voice_ms));
  console.log(row("voice_to_voice_ms p50", v2v?.p50 ?? null, ref.voice_to_voice_ms.p50));
  for (const [name, base] of Object.entries(ref.stages)) {
    const s = summarise(turns.map((t) => t[name]));
    console.log(row(`${name} p50`, s?.p50 ?? null, base.p50));
  }

  // A0's own worst finding, and the ledger's note that the migration does not
  // fix it. Counted here so it cannot be quietly forgotten at C4.
  const noReply = turns.filter((t) => t.voice_to_voice_ms == null).length;
  const pct = ((noReply / turns.length) * 100).toFixed(1);
  const basePct = BASELINE.quality.turnsTimedOutNoReply.pct;
  console.log(
    `\nTURNS WITH NO REPLY: ${noReply}/${turns.length} (${pct}%) · A0 was ` +
      `${BASELINE.quality.turnsTimedOutNoReply.count}/${BASELINE.quality.turnsTimedOutNoReply.of} (${basePct}%)`
  );
  console.log("  Predates the migration and is not fixed by it — recorded so it cannot be misattributed.");

  console.log(
    `\nEVIDENCE LINE: C4 — ${turns.length} turns / ${calls.size} calls, ` +
      `voice_to_voice_ms p50 ${v2v?.p50 ?? "—"} (A0 ${BASELINE.endToEnd.voice_to_voice_ms.p50}, ` +
      `covered lane ${ref.voice_to_voice_ms.p50}), ${regressions} stage(s) above A0, ${missing} missing.`
  );

  if (missing) process.exitCode = 1;
}

// Guarded so the module tree can be imported without running a query — the same
// shape as the other job entrypoints, and what lets a build step prove it loads.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
