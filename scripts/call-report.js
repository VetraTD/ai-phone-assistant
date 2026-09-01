#!/usr/bin/env node
// ---------------------------------------------------------------------------
// call-report.js — what one call did, how it performed, and what it cost.
//
//   CLOUDSDK_CONFIG=~/.gcloud-vetra2 node scripts/call-report.js <callSid>
//   ... --project vetra-uk-edc8ca --hours 6 --json
//   ... --rates config/rates.json
//
// Read-only. Touches Cloud Logging and nothing else — no database, no Twilio,
// no vendor APIs, and never the running service.
//
// ---------------------------------------------------------------------------
// Why this reads logs rather than a billing export
// ---------------------------------------------------------------------------
//
// GCP billing cannot answer "what did that call cost". There is no BigQuery
// billing export configured, and console billing is service-level and lags
// about a day. Per-call cost has to come from the application's own telemetry,
// which is why the quantities below are counted at the point they are incurred:
// tokens from the model's own usageMetadata (what was BILLED, not what this
// process estimated), characters at the TTS send site, seconds from the call
// boundary events.
//
// ---------------------------------------------------------------------------
// TWO TOTALS, DELIBERATELY
// ---------------------------------------------------------------------------
//
// MARGINAL is what one more call costs: model, speech-to-text, text-to-speech,
// telephony. It is the number that decides whether a price per call works.
//
// FULLY LOADED adds the fixed estate — Cloud Run's always-on instance and Cloud
// SQL — divided by the calls actually taken this month. That division is
// ARITHMETIC, NOT MEASUREMENT: the estate costs the same at zero calls as at a
// thousand. At low volume it dominates and will tell you the product is
// hopeless; at scale it vanishes. Reporting either number alone is misleading
// in a different direction, so this prints both and labels which is which.
//
// ---------------------------------------------------------------------------
// RATES ARE NOT MEASUREMENTS
// ---------------------------------------------------------------------------
//
// Every quantity here is measured. Every PRICE is an assumption, and vendor
// pricing moves. The rate table is therefore printed with the output, carries a
// `verified` date, and the totals are marked approximate until someone sets it.
// A hardcoded price with no provenance is the shape of defect this codebase has
// already paid for once: a constant of assumption sitting on top of measured
// data, indistinguishable from a result.
//
// Correct them in a JSON file and pass --rates; nothing here needs editing.
// ---------------------------------------------------------------------------

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Rates. UNVERIFIED — set `verified` once you have checked each against the
// vendor's current pricing page, and the "approximate" markers disappear.
//
// Units are chosen to match how each vendor actually invoices, so that a wrong
// number here is wrong by a factor a human can spot rather than by a unit.
// ---------------------------------------------------------------------------
const DEFAULT_RATES = {
  verified: null,
  currency: "USD",
  notes: "Unverified defaults. Pass --rates <file> with your own figures.",
  vertex: {
    model: "gemini-3.6-flash",
    input_per_1m_tokens: null,
    cached_input_per_1m_tokens: null,
    output_per_1m_tokens: null,
    source: "https://cloud.google.com/vertex-ai/generative-ai/pricing",
  },
  deepgram: {
    per_minute: null,
    source: "https://deepgram.com/pricing",
  },
  elevenlabs: {
    per_1k_chars: null,
    source: "https://elevenlabs.io/pricing",
  },
  google_tts: {
    per_1m_chars: null,
    source: "https://cloud.google.com/text-to-speech/pricing",
  },
  twilio: {
    inbound_per_minute: null,
    media_stream_per_minute: null,
    billing_increment_seconds: 60,
    source: "https://www.twilio.com/en-us/voice/pricing",
  },
  fixed_monthly: {
    cloud_run_min_instance: null,
    cloud_sql: null,
    other: null,
  },
};

function parseArgs(argv) {
  const out = {
    callSid: null,
    project: "vetra-uk-edc8ca",
    hours: 24,
    json: false,
    rates: null,
    callsThisMonth: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" && argv[i + 1]) out.project = argv[++i];
    else if (a === "--hours" && argv[i + 1]) out.hours = Number(argv[++i]);
    else if (a === "--rates" && argv[i + 1]) out.rates = argv[++i];
    else if (a === "--calls-this-month" && argv[i + 1]) out.callsThisMonth = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else if (!out.callSid) out.callSid = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!out.callSid) throw new Error("Usage: call-report.js <callSid> [--project P] [--hours N] [--rates F] [--json]");
  return out;
}

// gcloud on Windows is a .cmd shim, and since Node 22 execFile refuses to
// launch .cmd/.bat without a shell. So this always goes through one — and a
// shell means the filter has to survive cmd.exe's quoting, which does not
// understand single quotes at all. The first version quoted the filter the
// POSIX way and cmd split it on the spaces, reporting
// `unrecognized arguments: AND` — which reads like a bad gcloud invocation
// rather than a quoting fault.
//
// Rather than escape a string containing double quotes through two different
// shells, the filter is built WITHOUT any inner quotes: Logging's filter syntax
// accepts bare tokens, and both values here are bare tokens. Only the outer
// double quotes remain, which cmd and sh agree on.
function gcloud(args) {
  return execFileSync("gcloud", args, {
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Every structured log entry for one call, oldest first. */
function fetchEntries({ callSid, project, hours }) {
  // Validated, not escaped. The value is interpolated into a shell command, and
  // an allow-list is the only version of this that stays safe when someone
  // later adds a second caller.
  if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) {
    throw new Error(`Not a Twilio call SID: ${callSid} (expected CA + 32 hex chars)`);
  }
  const filter = `resource.type=cloud_run_revision AND jsonPayload.callSid=${callSid}`;
  const raw = gcloud([
    "logging",
    "read",
    `"${filter}"`,
    "--project",
    project,
    "--limit",
    "1000",
    "--format",
    "json",
    "--freshness",
    `${hours}h`,
  ]);
  const rows = JSON.parse(raw).map((e) => e.jsonPayload || {});
  rows.reverse();
  return rows;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function percentile(values, p) {
  const s = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

function analyse(rows) {
  const turns = rows.filter((r) => r.event === "turn_latency");
  const chars = rows.filter((r) => r.event === "tts_turn_chars");
  const ended = rows.filter((r) => r.event === "call_ended");
  const tools = rows.filter((r) => r.event === "tool_duration");
  const barges = rows.filter((r) => r.event === "barge_in");
  const greeting = rows.find((r) => r.event === "greeting_audio_timing") || null;

  // Two call_ended events are normal — one per teardown path (media_stream_stop
  // and ws_close). Take the longest rather than the first, so a report is not
  // quietly short by whichever fired earliest.
  const durationMs = ended.length ? Math.max(...ended.map((e) => e.durationMs || 0)) : null;

  return {
    turns,
    durationMs,
    outcome: ended.find((e) => e.finalOutcome)?.finalOutcome ?? null,
    tools: tools.map((t) => ({ tool: t.tool, ms: t.ms, success: t.success })),
    bargeIns: barges.length,
    greeting,
    tokens: {
      // `prompt_tokens` already INCLUDES the cached portion, so the billable
      // uncached input is the difference. Adding them would double-count the
      // cache and overstate the bill on exactly the turns the cache helped.
      promptTotal: sum(turns.map((t) => t.prompt_tokens || 0)),
      cachedTotal: sum(turns.map((t) => t.cached_tokens || 0)),
      outputTotal: sum(turns.map((t) => t.output_tokens || 0)),
      thoughtsTotal: sum(turns.map((t) => t.thoughts_tokens || 0)),
      turnsMissingOutput: turns.filter((t) => t.output_tokens == null).length,
    },
    chars: {
      el: sum(chars.map((c) => c.el_chars || 0)),
      google: sum(chars.map((c) => c.google_chars || 0)),
      reports: chars.length,
    },
    latency: {
      trueV2vP50: percentile(turns.map((t) => t.true_v2v_ms), 50),
      v2vP50: percentile(turns.map((t) => t.voice_to_voice_ms), 50),
      llmTtfbP50: percentile(turns.map((t) => t.llm_ttfb_ms), 50),
      ttsTtfbP50: percentile(turns.map((t) => t.tts_ttfb_ms), 50),
    },
  };
}

/** null-propagating arithmetic: an unset rate yields an unknown cost, never 0. */
function mul(qty, rate, divisor = 1) {
  if (rate == null || qty == null) return null;
  return (qty * rate) / divisor;
}

function price(a, rates) {
  const minutesRaw = a.durationMs != null ? a.durationMs / 60000 : null;
  const inc = rates.twilio?.billing_increment_seconds || 60;
  // Telephony bills in whole increments and rounds UP. A 180.3-second call is
  // four minutes on the invoice, not three.
  const minutesBilled =
    a.durationMs != null ? Math.ceil(a.durationMs / 1000 / inc) * (inc / 60) : null;

  const uncachedInput = a.tokens.promptTotal - a.tokens.cachedTotal;

  const lines = [
    ["Vertex input (uncached)", `${uncachedInput.toLocaleString()} tok`,
      mul(uncachedInput, rates.vertex?.input_per_1m_tokens, 1e6)],
    ["Vertex input (cached)", `${a.tokens.cachedTotal.toLocaleString()} tok`,
      mul(a.tokens.cachedTotal, rates.vertex?.cached_input_per_1m_tokens, 1e6)],
    ["Vertex output", `${a.tokens.outputTotal.toLocaleString()} tok`,
      mul(a.tokens.outputTotal, rates.vertex?.output_per_1m_tokens, 1e6)],
    ["Deepgram STT", minutesRaw != null ? `${minutesRaw.toFixed(2)} min` : "?",
      mul(minutesRaw, rates.deepgram?.per_minute)],
    ["ElevenLabs TTS", `${a.chars.el.toLocaleString()} chars`,
      mul(a.chars.el, rates.elevenlabs?.per_1k_chars, 1000)],
    ["Google TTS (fallback)", `${a.chars.google.toLocaleString()} chars`,
      mul(a.chars.google, rates.google_tts?.per_1m_chars, 1e6)],
    ["Twilio inbound", minutesBilled != null ? `${minutesBilled} min billed` : "?",
      mul(minutesBilled, rates.twilio?.inbound_per_minute)],
    ["Twilio Media Streams", minutesBilled != null ? `${minutesBilled} min billed` : "?",
      mul(minutesBilled, rates.twilio?.media_stream_per_minute)],
  ];

  const known = lines.map(([, , c]) => c).filter((c) => c != null);
  const marginal = known.length ? sum(known) : null;
  const complete = lines.every(([, , c]) => c != null);

  const fixed = rates.fixed_monthly || {};
  const fixedMonthly = [fixed.cloud_run_min_instance, fixed.cloud_sql, fixed.other]
    .filter((v) => v != null);
  const fixedTotal = fixedMonthly.length ? sum(fixedMonthly) : null;

  return { lines, marginal, complete, minutesRaw, minutesBilled, fixedTotal };
}

function money(v, approx) {
  if (v == null) return "     —   ";
  return `${approx ? "~" : " "}$${v.toFixed(4)}`;
}

function render(a, p, rates, opts) {
  const approx = !rates.verified;
  const out = [];
  const L = (s = "") => out.push(s);

  L(`Call ${opts.callSid}`);
  L(
    `  duration ${a.durationMs != null ? (a.durationMs / 1000).toFixed(1) + "s" : "unknown"}` +
      `   turns ${a.turns.length}` +
      `   outcome ${a.outcome ?? "unknown"}` +
      `   barge-ins ${a.bargeIns}`
  );
  L();

  L("PERFORMANCE");
  L(`  ${"turn".padStart(4)} ${"v2v".padStart(7)} ${"true_v2v".padStart(9)} ${"llm_ttfb".padStart(9)} ${"tool".padStart(7)} ${"tts".padStart(6)}`);
  for (const t of a.turns) {
    L(
      `  ${String(t.turnIndex ?? "?").padStart(4)} ${String(t.voice_to_voice_ms ?? "—").padStart(7)}` +
        ` ${String(t.true_v2v_ms ?? "—").padStart(9)} ${String(t.llm_ttfb_ms ?? "—").padStart(9)}` +
        ` ${String(t.llm_tool_ms ?? "—").padStart(7)} ${String(t.tts_ttfb_ms ?? "—").padStart(6)}`
    );
  }
  L(
    `  p50   true_v2v ${a.latency.trueV2vP50 ?? "—"}ms   llm_ttfb ${a.latency.llmTtfbP50 ?? "—"}ms` +
      `   tts_ttfb ${a.latency.ttsTtfbP50 ?? "—"}ms`
  );
  if (a.greeting) L(`  greeting  first wire ${a.greeting.firstWireMs}ms, TTS first byte ${a.greeting.ttsFirstByteMs}ms, preroll ${a.greeting.prerollMs}ms`);
  if (a.tools.length) L(`  tools     ${a.tools.map((t) => `${t.tool} ${t.ms}ms${t.success === false ? " FAILED" : ""}`).join(", ")}`);
  L();

  L("COST — MARGINAL (what one more call costs)");
  for (const [label, qty, cost] of p.lines) {
    L(`  ${label.padEnd(24)} ${qty.padStart(20)}   ${money(cost, approx)}`);
  }
  L(`  ${"".padEnd(24)} ${"MARGINAL TOTAL".padStart(20)}   ${money(p.marginal, approx)}`);
  if (!p.complete) {
    const missing = p.lines.filter(([, , c]) => c == null).map(([l]) => l);
    L(`  ⚠ INCOMPLETE — no rate set for: ${missing.join(", ")}`);
    L(`    The total above is a FLOOR, not a cost. Set the missing rates.`);
  }
  L();

  if (p.fixedTotal != null && opts.callsThisMonth) {
    const perCall = p.fixedTotal / opts.callsThisMonth;
    L("COST — FULLY LOADED (arithmetic, not measurement)");
    L(`  fixed estate            ${("$" + p.fixedTotal.toFixed(2) + "/mo").padStart(20)}`);
    L(`  calls this month        ${String(opts.callsThisMonth).padStart(20)}`);
    L(`  fixed per call          ${("$" + perCall.toFixed(4)).padStart(20)}`);
    L(`  ${"".padEnd(24)}${"FULLY LOADED".padStart(21)}   ${money((p.marginal ?? 0) + perCall, approx)}`);
    L(`  The estate costs the same at zero calls. This division tells you what`);
    L(`  your P&L feels, NOT what a call costs. Price against MARGINAL.`);
  } else {
    L("COST — FULLY LOADED   (skipped: needs fixed_monthly rates and --calls-this-month)");
  }
  L();

  L("DATA QUALITY");
  if (a.tokens.turnsMissingOutput)
    L(`  ⚠ ${a.tokens.turnsMissingOutput}/${a.turns.length} turns report no output_tokens — pre-fix revision, LLM cost understated`);
  if (a.chars.reports === 0)
    L(`  ⚠ no tts_turn_chars events — pre-fix revision, TTS cost is $0 here and was not`);
  if (a.turns.some((t) => (t.true_v2v_ms ?? 0) < 0))
    L(`  ⚠ negative true_v2v on a turn — P24, greeting contamination, not a real measurement`);
  if (a.bargeIns) L(`  note: ${a.bargeIns} barge-in(s) — a barged turn's stt/latency figures are not clean`);
  L(`  quantities are measured; PRICES are assumptions`);
  L();

  L(`RATES  (${rates.verified ? `verified ${rates.verified}` : "UNVERIFIED — totals marked ~"})`);
  for (const [vendor, cfg] of Object.entries(rates)) {
    if (!cfg || typeof cfg !== "object") continue;
    const parts = Object.entries(cfg)
      .filter(([k, v]) => k !== "source" && k !== "model" && v != null)
      .map(([k, v]) => `${k}=${v}`);
    if (parts.length) L(`  ${vendor.padEnd(16)} ${parts.join("  ")}`);
  }
  if (!rates.verified) {
    L(`  ⚠ These are unverified defaults. Check each vendor's pricing page and`);
    L(`    pass --rates <file> with a "verified" date. Until then every dollar`);
    L(`    figure above is arithmetic on numbers nobody confirmed.`);
  }

  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rates = opts.rates
    ? { ...DEFAULT_RATES, ...JSON.parse(readFileSync(opts.rates, "utf8")) }
    : DEFAULT_RATES;

  const rows = fetchEntries(opts);
  if (rows.length === 0) {
    console.error(
      `No log entries for callSid ${opts.callSid} in the last ${opts.hours}h on ${opts.project}.\n` +
        `Widen with --hours, or check the project. Note that tool_duration events do not\n` +
        `carry callSid, so they will be absent from this report by design.`
    );
    process.exit(1);
  }

  const a = analyse(rows);
  const p = price(a, rates);

  if (opts.json) {
    console.log(JSON.stringify({ callSid: opts.callSid, analysis: a, pricing: p, rates }, null, 2));
    return;
  }
  console.log(render(a, p, rates, opts));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
