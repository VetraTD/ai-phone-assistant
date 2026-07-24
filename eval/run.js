#!/usr/bin/env node
/**
 * Conversation eval runner.
 *
 *   npm run eval                         # all scenarios, default model
 *   npm run eval -- --filter availability
 *   npm run eval -- --tag memory --concurrency 3
 *   npm run eval -- --model gemini-2.5-pro --temperature 0
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
 */

import "dotenv/config";
import { readdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { createTextSession } from "../lib/harness/textSession.js";
import { makeFakeDeps, makeFakeEffectsDeps } from "../lib/harness/fakeDeps.js";
import { resolveGenerationConfig } from "../services/gemini.js";
import { STEPS } from "../lib/callState.js";
import { FIXTURES } from "../tests/fixtures/businessConfigs.js";
import { createSimCaller, isEndCall } from "./simCaller.js";
import { judgeConversation } from "./judge.js";

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
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    filter: null,
    tag: null,
    concurrency: 2,
    modelOverrides: {},
    json: null,
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
      turns.push({
        caller: callerText,
        reply: out.text,
        toolCalls: out.toolCalls,
        toolResults: out.toolResults,
        timings: out.timings,
        state: out.state,
        notes: out.notes,
      });
      allToolCalls.push(...out.toolCalls);
      allToolResults.push(...out.toolResults);
      if (out.timings?.firstEventMs != null) base.latency.firstEventMs.push(out.timings.firstEventMs);
      if (out.timings?.totalMs != null) base.latency.totalMs.push(out.timings.totalMs);
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

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function median(values) {
  return percentile(values, 50);
}

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
}

const fmtMs = (v) => (v == null ? "—" : `${v}ms`);

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
