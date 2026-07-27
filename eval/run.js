#!/usr/bin/env node
/**
 * Conversation eval runner.
 *
 *   npm run eval                         # all scenarios, default model
 *   npm run eval -- --filter availability
 *   npm run eval -- --tag memory --concurrency 3
 *   npm run eval -- --model gemini-2.5-pro --temperature 0
 *   npm run eval -- --matrix --filter availability-before-book
 *   npm run eval -- --matrix --matrix-file ./my-configs.json --tag booking
 *
 * Drives each scenario's simulated caller against the REAL receptionist brain
 * (via lib/harness/textSession.js — same prompt assembly, tool dispatch and
 * reply-state reducer a live call uses, minus audio and network), then grades
 * the result with hard assertions (deterministic, gate the exit code) and an
 * advisory LLM judge. Writes a full JSON report to eval/results/ and prints a
 * per-scenario table plus verbatim failure transcripts.
 *
 * Task 6 seam: `runScenario(scenario, { modelOverrides }) → result` is the
 * single unit of work and is importable, so a model-matrix benchmark can call
 * it across models without going through this CLI.
 *
 * --matrix runs the (filtered) suite once per candidate model config —
 * configs sequential, scenarios within a config at --concurrency — after a
 * one-call servability preflight per config (skips a dead/inaccessible model
 * instead of burning the suite on it). --matrix-file <path> overrides the
 * built-in default config list (DEFAULT_MATRIX below) with a JSON array of
 * `{label, model, temperature?, thinkingBudget?, maxOutputTokens?}` objects.
 * The judge always stays on its own pinned model (eval/judge.js) regardless
 * of the matrix — it scores, it isn't scored. Full per-config results land in
 * one `eval/results/matrix-<ts>.json`; a comparison table prints at the end.
 */

import "dotenv/config";
import { readdirSync } from "node:fs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { createTextSession } from "../lib/harness/textSession.js";
import { makeFakeDeps, makeFakeEffectsDeps } from "../lib/harness/fakeDeps.js";
import { resolveGenerationConfig, getClient } from "../services/gemini.js";
import { STEPS } from "../lib/callState.js";
import { FIXTURES } from "../tests/fixtures/businessConfigs.js";
import { createSimCaller, isEndCall } from "./simCaller.js";
import { judgeConversation } from "./judge.js";
import {
  percentile,
  median,
  summarizeConfigResults,
  buildComparisonRows,
  formatComparisonTable,
} from "./matrixAggregate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(HERE, "scenarios");
const RESULTS_DIR = path.join(HERE, "results");

// Every seeded appointment and every tool call in the harness is scoped to one
// synthetic business id. It MUST be non-null: the fake availability check short
// circuits to "0 overlapping" for a falsy businessId, so a null id would make a
// seeded-conflict scenario silently never conflict.
const EVAL_BUSINESS_ID = "eval-business";

// The @google/genai response.text getter warns "there are non-text parts …" on
// every tool-calling turn — expected noise (see scripts/chat.js). Suppress just
// that one message so the eval report stays readable.
const SDK_NONTEXT_WARNING = "there are non-text parts";
async function withSdkWarnFilter(fn) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === "string" && args[0].includes(SDK_NONTEXT_WARNING)) return;
    originalWarn.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// Truncation telemetry (Task 11 / plan 2.5)
//
// Two signals per turn:
//   - finishReason === "MAX_TOKENS": authoritative — the model hit the output
//     cap. Counted as `truncatedTurns`.
//   - suspectTruncation: a cheap ADVISORY regex — a non-empty reply that does
//     not end on sentence-final punctuation. Catches replies cut mid-thought
//     when finishReason is unavailable; never gates anything.
// ---------------------------------------------------------------------------

// Ends on . ! ? or … possibly followed by a closing quote/bracket.
const SENTENCE_FINAL = /[.!?…]["'”’)\]]*\s*$/;

function looksSuspectTruncated(text) {
  const t = (text || "").trim();
  if (!t) return false; // an empty reply is a different failure mode, not truncation
  return !SENTENCE_FINAL.test(t);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    filter: null,
    tag: null,
    concurrency: 2,
    modelOverrides: {},
    json: null,
    matrix: false,
    matrixFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--filter": opts.filter = next(); break;
      case "--tag": opts.tag = next(); break;
      case "--concurrency": opts.concurrency = Math.max(1, parseInt(next(), 10) || 1); break;
      case "--temperature": opts.modelOverrides.temperature = parseFloat(next()); break;
      case "--model": opts.modelOverrides.model = next(); break;
      case "--thinking-budget": opts.modelOverrides.thinkingBudget = parseInt(next(), 10); break;
      case "--json": opts.json = next(); break;
      case "--matrix": opts.matrix = true; break;
      case "--matrix-file": opts.matrixFile = next(); break;
      default:
        console.error(`Unknown flag: ${a}`);
        process.exitCode = 1;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

export async function loadScenarios() {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".js")).sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(SCENARIOS_DIR, f)).href);
    if (!mod.default) throw new Error(`scenario ${f} has no default export`);
    scenarios.push({ ...mod.default, _file: f });
  }
  return scenarios;
}

// ---------------------------------------------------------------------------
// Driving one conversation
// ---------------------------------------------------------------------------

function callerEndedByReceptionist(out) {
  return out?.state?.step === STEPS.ENDING || (out?.toolCalls || []).some((c) => c.name === "end_call");
}

/**
 * Run a single scenario end to end. Pure of any process/exit concern so Task 6
 * can call it directly across a model matrix.
 *
 * @param {object} scenario
 * @param {object} [opts]
 * @param {object} [opts.modelOverrides] - forwarded to the receptionist (not the judge)
 * @returns {Promise<object>} the per-scenario result
 */
export async function runScenario(scenario, { modelOverrides } = {}) {
  const base = {
    name: scenario.name,
    tags: scenario.tags || [],
    hardResults: [],
    judgeResults: [],
    hardPass: false,
    judgePass: false,
    turns: [],
    latency: { firstEventMs: [], totalMs: [] },
    // Truncation telemetry, accumulated across this scenario's turns.
    truncation: { truncatedTurns: 0, suspectTurns: 0, outputTokens: [] },
  };

  try {
    const fixture = FIXTURES[scenario.fixture];
    if (!fixture) throw new Error(`unknown fixture "${scenario.fixture}"`);

    const config = { ...fixture.config, ...(scenario.configPatch || {}) };
    const extras = { ...fixture.extras, ...(scenario.extrasPatch || {}), businessId: EVAL_BUSINESS_ID };
    const seedAppointments = (scenario.seedAppointments || []).map((s) => ({ business_id: EVAL_BUSINESS_ID, ...s }));

    const { deps, store } = makeFakeDeps({ seedAppointments });
    const effects = makeFakeEffectsDeps();
    const session = createTextSession({ config, extras, modelOverrides, fakes: { deps, store, effects } });

    const turns = [];
    const allToolCalls = [];
    const allToolResults = [];

    const record = (callerText, out) => {
      const finishReason = out.finishReason ?? null;
      const outputTokens = out.usage?.outputTokens ?? null;
      const truncated = finishReason === "MAX_TOKENS";
      const suspectTruncation = !truncated && looksSuspectTruncated(out.text);

      turns.push({
        caller: callerText,
        reply: out.text,
        toolCalls: out.toolCalls,
        toolResults: out.toolResults,
        timings: out.timings,
        state: out.state,
        notes: out.notes,
        usage: out.usage ?? null,
        finishReason,
        truncated,
        suspectTruncation,
      });
      allToolCalls.push(...out.toolCalls);
      allToolResults.push(...out.toolResults);
      if (out.timings?.firstEventMs != null) base.latency.firstEventMs.push(out.timings.firstEventMs);
      if (out.timings?.totalMs != null) base.latency.totalMs.push(out.timings.totalMs);
      if (truncated) base.truncation.truncatedTurns += 1;
      if (suspectTruncation) base.truncation.suspectTurns += 1;
      if (outputTokens != null) base.truncation.outputTokens.push(outputTokens);
    };

    if (scenario.caller.mode === "scripted") {
      for (const text of scenario.caller.turns) {
        const out = await withSdkWarnFilter(() => session.sendTurn(text));
        record(text, out);
        if (callerEndedByReceptionist(out)) break;
      }
    } else if (scenario.caller.mode === "persona") {
      const sim = createSimCaller({ persona: scenario.caller.persona, goal: scenario.caller.goal });
      const maxTurns = scenario.caller.maxTurns || 8;
      let lastReply = config.greeting || "";
      for (let i = 0; i < maxTurns; i++) {
        const utterance = await sim.next(lastReply);
        if (isEndCall(utterance) || !utterance) break;
        const out = await withSdkWarnFilter(() => session.sendTurn(utterance));
        record(utterance, out);
        lastReply = out.text;
        if (callerEndedByReceptionist(out)) break;
      }
    } else {
      throw new Error(`scenario "${scenario.name}" has unknown caller mode "${scenario.caller.mode}"`);
    }

    const ctx = {
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      turns,
      transcript: session.transcript,
      finalState: session.getState(),
      store,
    };

    base.turns = turns.map((t) => ({
      caller: t.caller,
      reply: t.reply,
      toolCalls: t.toolCalls,
      timings: t.timings,
      usage: t.usage,
      finishReason: t.finishReason,
      truncated: t.truncated,
      suspectTruncation: t.suspectTruncation,
    }));

    base.hardResults = (scenario.hard || []).map((fn) => {
      try {
        return fn(ctx);
      } catch (err) {
        return { pass: false, name: "assertion-threw", detail: err?.message ?? String(err) };
      }
    });
    base.hardPass = base.hardResults.every((r) => r.pass);

    base.judgeResults = await judgeConversation({ turns, questions: scenario.judge || [] });
    base.judgePass =
      base.judgeResults.length === 0 ? true : base.judgeResults.every((r) => r.verdict === "pass");

    return base;
  } catch (err) {
    base.error = err?.stack || err?.message || String(err);
    base.hardPass = false;
    return base;
  }
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

function printReport(results) {
  console.log("\n=== EVAL RESULTS ===\n");
  console.log(
    `${pad("scenario", 30)} ${pad("hard", 9)} ${pad("judge", 9)} ${pad("p50 turn", 9)}`
  );
  console.log("-".repeat(60));

  for (const r of results) {
    const hardOk = r.hardResults.filter((x) => x.pass).length;
    const hardTot = r.hardResults.length;
    const judgeOk = r.judgeResults.filter((x) => x.verdict === "pass").length;
    const judgeTot = r.judgeResults.length;
    const p50 = median(r.latency.totalMs);
    const hardCell = r.error ? "ERROR" : `${hardOk}/${hardTot} ${hardTot && hardOk === hardTot ? "✓" : "✗"}`;
    const judgeCell = judgeTot ? `${judgeOk}/${judgeTot}` : "—";
    console.log(
      `${pad(r.name, 30)} ${pad(hardCell, 9)} ${pad(judgeCell, 9)} ${pad(p50 == null ? "—" : `${p50}ms`, 9)}`
    );
  }

  // Failure detail — verbatim transcript + failed checks.
  const failures = results.filter((r) => !r.hardPass || r.error);
  if (failures.length) {
    console.log("\n=== FAILURES (transcript + failed checks) ===");
    for (const r of failures) {
      console.log(`\n──────── ${r.name} ────────`);
      if (r.error) console.log(`ERROR: ${r.error}`);
      for (const t of r.turns) {
        console.log(`CALLER: ${t.caller}`);
        for (const c of t.toolCalls || []) console.log(`  [tool] ${c.name}(${JSON.stringify(c.args || {})})`);
        console.log(`RECEPTIONIST: ${t.reply || "(no spoken reply)"}`);
      }
      for (const h of r.hardResults.filter((x) => !x.pass)) {
        console.log(`  ✗ HARD ${h.name} — ${h.detail}`);
      }
      for (const j of r.judgeResults.filter((x) => x.verdict !== "pass")) {
        console.log(`  ${j.verdict === "error" ? "!" : "·"} JUDGE [${j.verdict}] ${j.question} — ${j.reason}`);
      }
    }
  }

  // Summary + latency.
  const allFirst = results.flatMap((r) => r.latency.firstEventMs);
  const allTotal = results.flatMap((r) => r.latency.totalMs);
  const hardPassCount = results.filter((r) => r.hardPass).length;
  const judgePassCount = results.filter((r) => r.judgePass).length;

  console.log("\n=== SUMMARY ===");
  console.log(`scenarios:   ${results.length}`);
  console.log(`hard pass:   ${hardPassCount}/${results.length}`);
  console.log(`judge pass:  ${judgePassCount}/${results.length} (advisory)`);
  console.log(
    `first-event latency: p50 ${fmtMs(percentile(allFirst, 50))}  p95 ${fmtMs(percentile(allFirst, 95))}`
  );
  console.log(
    `total-turn latency:  p50 ${fmtMs(percentile(allTotal, 50))}  p95 ${fmtMs(percentile(allTotal, 95))}`
  );

  printTruncationReport(results);
}

/**
 * Truncation telemetry summary (Task 11 / plan 2.5). Prints the suite totals
 * the controller needs to decide the output cap — total turns, MAX_TOKENS
 * count, advisory suspect count, and outputTokens p50/p95 — plus a per-scenario
 * breakdown for the scenarios that showed any truncation.
 */
function printTruncationReport(results) {
  const summary = summarizeTruncation(results);

  console.log("\n=== TRUNCATION (output-cap telemetry) ===");
  console.log(`total turns:        ${summary.totalTurns}`);
  console.log(
    `MAX_TOKENS turns:   ${summary.truncatedTurns} (${pct(summary.truncatedTurns, summary.totalTurns)})`
  );
  console.log(
    `suspect (advisory): ${summary.suspectTurns} (${pct(summary.suspectTurns, summary.totalTurns)})`
  );
  console.log(
    `outputTokens:       p50 ${fmtTok(summary.outputTokensP50)}  p95 ${fmtTok(summary.outputTokensP95)}  ` +
      `(max ${fmtTok(summary.outputTokensMax)}, n=${summary.outputTokensCount})`
  );

  const perScenario = results
    .map((r) => ({
      name: r.name,
      truncated: r.truncation?.truncatedTurns || 0,
      suspect: r.truncation?.suspectTurns || 0,
      turns: r.turns?.length || 0,
    }))
    .filter((r) => r.truncated > 0 || r.suspect > 0);

  if (perScenario.length) {
    console.log("\nper-scenario (only scenarios with any truncation):");
    console.log(`${pad("scenario", 34)} ${pad("MAX_TOKENS", 12)} ${pad("suspect", 9)} ${pad("turns", 6)}`);
    console.log("-".repeat(63));
    for (const s of perScenario) {
      console.log(`${pad(s.name, 34)} ${pad(s.truncated, 12)} ${pad(s.suspect, 9)} ${pad(s.turns, 6)}`);
    }
  } else {
    console.log("\nper-scenario: no scenario produced a MAX_TOKENS or suspect turn.");
  }
}

/**
 * Pool the per-scenario truncation accumulators into the suite-level numbers.
 * Pure so it can feed both the printed report and the persisted JSON payload.
 *
 * @param {Array<object>} results - runScenario() return values
 */
function summarizeTruncation(results) {
  const list = results || [];
  const outputTokens = list.flatMap((r) => r.truncation?.outputTokens || []);
  return {
    totalTurns: list.reduce((sum, r) => sum + (r.turns?.length || 0), 0),
    truncatedTurns: list.reduce((sum, r) => sum + (r.truncation?.truncatedTurns || 0), 0),
    suspectTurns: list.reduce((sum, r) => sum + (r.truncation?.suspectTurns || 0), 0),
    outputTokensCount: outputTokens.length,
    outputTokensP50: percentile(outputTokens, 50),
    outputTokensP95: percentile(outputTokens, 95),
    outputTokensMax: outputTokens.length ? Math.max(...outputTokens) : null,
    perScenario: list.map((r) => ({
      name: r.name,
      turns: r.turns?.length || 0,
      truncatedTurns: r.truncation?.truncatedTurns || 0,
      suspectTurns: r.truncation?.suspectTurns || 0,
    })),
  };
}

const fmtTok = (v) => (v == null ? "—" : String(v));
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

const fmtMs = (v) => (v == null ? "—" : `${v}ms`);

// ---------------------------------------------------------------------------
// Matrix mode (Task 6 / plan step 1.5)
//
// Runs the (filtered) scenario suite once per candidate model config, model
// configs SEQUENTIALLY (so latency numbers reflect one config at a time, not
// contention across configs), scenarios within a config at the runner's usual
// --concurrency. Before spending the suite on a config, a one-call
// servability preflight ("Say OK") skips it cleanly if the model 404s/denies
// — this is what makes --matrix safe to point at a not-yet-GA model name.
// ---------------------------------------------------------------------------

const DEFAULT_MATRIX = [
  { label: "2.5-flash (baseline)", model: "gemini-2.5-flash" },
  { label: "2.5-flash +think128", model: "gemini-2.5-flash", thinkingBudget: 128 },
  { label: "2.5-flash +think512", model: "gemini-2.5-flash", thinkingBudget: 512 },
  { label: "3.6-flash", model: "gemini-3.6-flash" },
  { label: "3-flash-preview", model: "gemini-3-flash-preview" },
];

/**
 * Load the matrix config list: the built-in default, or a JSON array from
 * --matrix-file. Validation only (each entry needs a non-empty string
 * `label` AND a non-empty string `model` — a missing model would otherwise
 * reach `probeServability(undefined)` and fail with a confusing SDK error
 * far from the actual mistake) — the rest of the object is forwarded
 * verbatim as `modelOverrides`.
 *
 * @param {string|null} matrixFilePath
 * @returns {Promise<Array<{label: string, model: string, temperature?: number, thinkingBudget?: number, maxOutputTokens?: number}>>}
 */
export async function loadMatrixConfigs(matrixFilePath) {
  if (!matrixFilePath) return DEFAULT_MATRIX;
  const raw = await readFile(path.resolve(matrixFilePath), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--matrix-file ${matrixFilePath} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`--matrix-file ${matrixFilePath} must contain a non-empty JSON array of override objects`);
  }
  parsed.forEach((cfg, i) => {
    if (!cfg || typeof cfg.label !== "string" || !cfg.label) {
      throw new Error(`--matrix-file ${matrixFilePath}: entry ${i} needs a non-empty string "label"`);
    }
    if (typeof cfg.model !== "string" || !cfg.model) {
      throw new Error(`--matrix-file ${matrixFilePath}: entry ${i} missing model — needs a non-empty string "model"`);
    }
  });
  return parsed;
}

/**
 * Servability preflight: one minimal generateContent call. Cheap and
 * sufficient to distinguish "model doesn't exist / no access" (404,
 * permission-denied) from "model exists" — the two failure modes a candidate
 * model name (e.g. a preview alias) can hit before ever reaching the suite.
 *
 * @param {string} model
 * @returns {Promise<{available: boolean, error: string|null}>}
 */
export async function probeServability(model) {
  try {
    const client = getClient();
    await client.models.generateContent({
      model,
      contents: "Say OK",
      config: { temperature: 0, maxOutputTokens: 10 },
    });
    return { available: true, error: null };
  } catch (err) {
    return { available: false, error: err?.message || String(err) };
  }
}

/**
 * Decide the --matrix exit code from the per-config results. Pure/testable
 * on purpose — no fs, no process — so the decision can be unit tested without
 * driving the whole CLI.
 *
 * Exit-code contract (the ONLY two things that make this process exit
 * nonzero):
 *   1. Any hard-assertion failure in any servable (probe-available) config
 *      — i.e. some config actually ran a scenario and failed a deterministic
 *      check.
 *   2. Every config was unavailable (servability probe failed for all of
 *      them), so zero scenarios actually ran anywhere — without this guard,
 *      an all-unavailable matrix run would silently exit 0 ("success")
 *      despite having tested nothing (mirrors the non-matrix zero-scenario
 *      guard above, adapted to matrix mode's "probe skipped every config"
 *      failure shape).
 * Nothing else affects it — in particular the advisory judge
 * (judgePassCount) NEVER factors into the exit code, matrix or not.
 *
 * @param {Array<{results: Array<{hardPass: boolean}>}>} configEntries
 * @returns {{exitCode: number, message: string|null}}
 */
export function computeMatrixExitCode(configEntries) {
  const list = configEntries || [];
  const ranAnyScenario = list.some((c) => (c.results || []).length > 0);
  if (!ranAnyScenario) {
    return {
      exitCode: 1,
      message:
        "All matrix configs were unavailable (servability probe failed for every config) — " +
        "no scenario data was collected, nothing to compare.",
    };
  }
  const anyHardFail = list.some((c) => (c.results || []).some((r) => !r.hardPass));
  return { exitCode: anyHardFail ? 1 : 0, message: null };
}

/**
 * Run the full matrix: probe → (run suite | skip) → aggregate, per config,
 * sequentially. Prints the cross-config comparison table and returns the
 * full payload for persistence.
 *
 * @param {Array<object>} scenarios - already filtered by --filter/--tag
 * @param {object} opts - parsed CLI opts (concurrency, matrixFile)
 */
async function runMatrixMode(scenarios, opts) {
  const matrixConfigs = await loadMatrixConfigs(opts.matrixFile);
  console.log(
    `\nMatrix mode: ${matrixConfigs.length} config(s) × ${scenarios.length} scenario(s), ` +
      `configs run sequentially, concurrency ${opts.concurrency} within each.`
  );

  const configEntries = [];
  for (const cfg of matrixConfigs) {
    const { label, ...modelOverrides } = cfg;
    console.log(`\n--- ${label} (${JSON.stringify(modelOverrides)}) ---`);

    const probe = await probeServability(modelOverrides.model);
    if (!probe.available) {
      console.log(`  SKIPPED — servability probe failed: ${probe.error}`);
      configEntries.push({
        label,
        modelOverrides,
        probe,
        elapsedMs: 0,
        results: [],
        summary: summarizeConfigResults([]),
      });
      continue;
    }

    const startedAt = Date.now();
    const results = await runPool(scenarios, opts.concurrency, (scenario) =>
      runScenario(scenario, { modelOverrides })
    );
    const elapsedMs = Date.now() - startedAt;
    const summary = summarizeConfigResults(results);
    console.log(
      `  hard ${summary.hardPassCount}/${scenarios.length}  judge ${summary.judgePassCount}/${scenarios.length}  ` +
        `(${(elapsedMs / 1000).toFixed(1)}s)`
    );

    configEntries.push({ label, modelOverrides, probe, elapsedMs, results, summary });
  }

  const rows = buildComparisonRows(
    configEntries.map((c) => ({
      label: c.label,
      available: c.probe.available,
      scenarioCount: scenarios.length,
      summary: c.summary,
    }))
  );
  console.log("\n=== MATRIX COMPARISON ===\n");
  console.log(formatComparisonTable(rows));

  await mkdir(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    ranAt: new Date().toISOString(),
    scenarioCount: scenarios.length,
    scenarioNames: scenarios.map((s) => s.name),
    concurrency: opts.concurrency,
    configs: configEntries,
  };
  const defaultPath = path.join(RESULTS_DIR, `matrix-${ts}.json`);
  await writeFile(defaultPath, JSON.stringify(payload, null, 2));
  console.log(`\nFull matrix report: ${defaultPath}`);
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify(payload, null, 2));
    console.log(`Also written: ${opts.json}`);
  }

  // See computeMatrixExitCode's docstring for the exact exit-code contract.
  const { exitCode, message } = computeMatrixExitCode(configEntries);
  if (message) console.error(message);
  process.exitCode = exitCode;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set. Add it to your .env before running `npm run eval`.");
    process.exitCode = 1;
    return;
  }

  const opts = parseArgs(process.argv.slice(2));
  const modelOverrides = Object.keys(opts.modelOverrides).length ? opts.modelOverrides : undefined;

  let scenarios = await loadScenarios();
  if (opts.filter) scenarios = scenarios.filter((s) => s.name.includes(opts.filter));
  if (opts.tag) scenarios = scenarios.filter((s) => (s.tags || []).includes(opts.tag));

  if (!scenarios.length) {
    console.error("No scenarios matched the given --filter/--tag.");
    process.exitCode = 1;
    return;
  }

  if (opts.matrix) {
    if (modelOverrides) {
      console.log(
        "Note: --model/--temperature/--thinking-budget are ignored in --matrix mode " +
          "(each matrix config supplies its own)."
      );
    }
    await runMatrixMode(scenarios, opts);
    return;
  }

  const resolved = resolveGenerationConfig(modelOverrides);
  console.log(
    `Running ${scenarios.length} scenario(s) — receptionist model ${resolved.model} ` +
      `(temperature=${resolved.temperature}, thinkingBudget=${resolved.thinkingBudget}), concurrency ${opts.concurrency}`
  );
  console.log(scenarios.map((s) => `  • ${s.name} [${(s.tags || []).join(",")}]`).join("\n"));

  const startedAt = Date.now();
  const results = await runPool(scenarios, opts.concurrency, (scenario) =>
    runScenario(scenario, { modelOverrides })
  );
  const elapsedMs = Date.now() - startedAt;

  printReport(results);
  console.log(`\nElapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  // Persist full JSON.
  await mkdir(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    ranAt: new Date().toISOString(),
    model: resolved,
    concurrency: opts.concurrency,
    elapsedMs,
    truncation: summarizeTruncation(results),
    results,
  };
  const defaultPath = path.join(RESULTS_DIR, `${ts}.json`);
  await writeFile(defaultPath, JSON.stringify(payload, null, 2));
  console.log(`Full report: ${defaultPath}`);
  if (opts.json) {
    await writeFile(opts.json, JSON.stringify(payload, null, 2));
    console.log(`Also written: ${opts.json}`);
  }

  const anyHardFail = results.some((r) => !r.hardPass);
  process.exitCode = anyHardFail ? 1 : 0;
}

// Only run as a CLI; importing this module (Task 6) must not execute main().
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`Fatal: ${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  });
}
