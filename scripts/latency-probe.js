#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import twilio from "twilio";
import { buildDialPlan, MAX_CALLS } from "../lib/probe/dialPlan.js";
import { buildReport } from "../lib/probe/report.js";
import { synthesizeCallerAudio, buildProbeScript, resolveScriptLines } from "../lib/probe/script.js";

// ---------------------------------------------------------------------------
// Test 1 — measure the voice path.
//
// Places N identical Twilio->Twilio calls against the deployed assistant and
// collects two clocks: the server's own per-turn stages, and the probe's
// voice-to-voice measured on the originating leg past both carrier hops. The
// difference between them is the part of the caller's wait that happens
// outside this codebase.
//
// Usage:
//   node scripts/latency-probe.js --synth            # cache the caller audio once
//   node scripts/latency-probe.js                    # dry run: prints the plan + cost
//   node scripts/latency-probe.js --confirm          # place the calls
//   node scripts/latency-probe.js --calls 4 --confirm
//   node scripts/latency-probe.js --report-only      # re-render from a finished run
//
// Requires on the SERVER under test: DEBUG_ENDPOINTS=true and DEBUG_TOKEN set.
// Turn both off when the run is finished.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

// Which caller script to run. "diagnostic" (default) hand-picks utterances to
// exercise each classifyHold branch; "representative" is shaped like real
// caller speech and is the one to use when sizing what those branches cost.
const SCRIPT_NAME = opt("--script", "diagnostic");

const BASE_URL = (process.env.PROBE_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";
const ASSISTANT_NUMBER = process.env.ASSISTANT_NUMBER || "";
const PROBE_NUMBER = process.env.PROBE_NUMBER || "";
const CALLS = Number.parseInt(opt("--calls", "12"), 10);
const SMOKE = has("--smoke");

const RUNS_DIR = path.resolve("latency-runs");

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/** Authenticated GET against the token-gated debug API. */
async function debugGet(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-debug-token": DEBUG_TOKEN },
  });
  if (res.status === 404) {
    die(
      `${pathname} returned 404. On the server under test set DEBUG_ENDPOINTS=true and a ` +
        `DEBUG_TOKEN matching this one, then redeploy.`
    );
  }
  if (!res.ok) die(`${pathname} returned ${res.status}`);
  return res.json();
}

async function debugPost(pathname, body) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      "x-debug-token": DEBUG_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) die(`${pathname} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- --synth: cache the caller audio, once -------------------------------
if (has("--synth")) {
  const lines = resolveScriptLines(SCRIPT_NAME);
  // Either engine works; both are a DIFFERENT voice from the assistant's, which
  // is what keeps self-echo out of a measurement. Google emits 8kHz mu-law
  // natively; the ElevenLabs path exists because Google credentials are not
  // always present, and it uses a deliberately different catalog voice
  // (daniel) from the assistant default (bella).
  let synthesizeMulaw;
  let voiceName;
  if (opt("--tts", "google") === "elevenlabs") {
    const { synthesizeMulawOnce } = await import("../services/elevenlabs.js");
    if (!process.env.ELEVENLABS_API_KEY) die("ELEVENLABS_API_KEY is not set.");
    voiceName = opt("--caller-voice", "onwK4e9ZLuTAKqWW03F9");
    synthesizeMulaw = (text, voiceId) => synthesizeMulawOnce({ voiceId, text });
  } else {
    const google = await import("../services/googleTts.js");
    if (!google.isConfigured()) {
      die(
        "Google TTS is not configured. Set GOOGLE_APPLICATION_CREDENTIALS or " +
          "GOOGLE_TTS_API_KEY, or pass --tts elevenlabs."
      );
    }
    synthesizeMulaw = google.synthesizeMulaw;
    voiceName = opt("--caller-voice", "en-US-Chirp3-HD-Charon");
  }

  const { written, skipped } = await synthesizeCallerAudio({
    synthesizeMulaw,
    voiceName,
    force: has("--force"),
    lines,
  });
  console.log(`\n  Caller audio: ${written.length} written, ${skipped.length} already cached.`);
  console.log(`  ${lines.length} lines (${SCRIPT_NAME}) in test-audio/caller/\n`);
  process.exit(0);
}

// --- Assemble and render a report from whatever the server has -----------
async function renderReport(runId, callCount) {
  const [serverStats, probe] = await Promise.all([
    debugGet("/api/debug/latency"),
    debugGet("/api/debug/probe-results"),
  ]);

  const probeTurns = probe.runs.flatMap((r) => r.turns ?? []);
  const md = buildReport({ runId, callCount, probeTurns, serverStats });

  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify(serverStats, null, 2));
  fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(probe, null, 2));
  fs.writeFileSync(path.join(dir, "report.md"), md);

  console.log(md);
  console.log(`\n  Written to ${path.join(dir, "report.md")}\n`);
}

if (has("--report-only")) {
  const runId = opt("--run-id", `run-${process.pid}`);
  await renderReport(runId, Number.parseInt(opt("--calls", "0"), 10));
  process.exit(0);
}

// --- Validate the run before anything dials ------------------------------
const plan = buildDialPlan({
  to: ASSISTANT_NUMBER,
  from: PROBE_NUMBER,
  assistantNumber: ASSISTANT_NUMBER,
  baseUrl: BASE_URL,
  debugToken: DEBUG_TOKEN,
  calls: SMOKE ? 1 : CALLS,
  confirm: has("--confirm"),
});

console.log(`\n  ${plan.summary}`);
console.log(`  Server under test: ${BASE_URL}`);
console.log(`  Hard cap: ${MAX_CALLS} calls per run.\n`);

if (!plan.ok) {
  console.log(`  Not dialling: ${plan.reason}\n`);
  process.exit(plan.dryRun ? 0 : 1);
}

// Fail before spending money if the audio isn't cached.
let localScript;
try {
  localScript = buildProbeScript(resolveScriptLines(SCRIPT_NAME));
} catch (err) {
  die(err.message);
}

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!accountSid || !authToken) die("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");
const client = twilio(accountSid, authToken);

const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

// A run starts from an empty buffer, or it pools with the previous one and
// blurs any before/after comparison.
await debugPost("/api/debug/latency/reset");

// The probe leg runs on the server, so the audio has to get there. Uploading
// the exact bytes synthesized here means both ends are provably playing the
// same script — no dependency on TTS being configured on the deployed box, and
// no chance two runs differ because the audio did.
const installed = await debugPost("/api/debug/probe-script", {
  lines: localScript.map((l) => ({
    label: l.label,
    audioBase64: l.mulaw.toString("base64"),
    ...(l.bargeInAfterMs ? { bargeInAfterMs: l.bargeInAfterMs } : {}),
  })),
});
console.log(
  `  Server stats reset. Caller script uploaded (${installed.lines} lines, ${installed.seconds}s). Starting calls...\n`
);

const twiml =
  `<Response><Connect><Stream url="${plan.streamUrl}"/></Connect></Response>`;

let completed = 0;
for (let i = 1; i <= plan.calls; i++) {
  process.stdout.write(`  Call ${i}/${plan.calls}... `);
  try {
    const call = await client.calls.create({ to: plan.to, from: plan.from, twiml });
    // Sequential on purpose: concurrent calls would contend for the same
    // process and inflate the very latencies being measured.
    let status = "queued";
    const startedAt = Date.now();
    while (!["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() - startedAt > 240_000) break;
      status = (await client.calls(call.sid).fetch()).status;
    }
    completed += status === "completed" ? 1 : 0;
    console.log(status);
  } catch (err) {
    console.log(`error: ${err.message}`);
  }
}

console.log(`\n  ${completed}/${plan.calls} calls completed.\n`);
await renderReport(runId, completed);
console.log("  Remember to unset DEBUG_ENDPOINTS and DEBUG_TOKEN on the server.\n");
