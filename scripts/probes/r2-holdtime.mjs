// ---------------------------------------------------------------------------
// R2 diagnostic — how long does each vendor ACTUALLY hold an open turn?
//
//   node scripts/probes/r2-holdtime.mjs
//
// Fixes a real flaw in how both the round-1 V4 arm and the round-2 Gemini
// endpointing arm were scored. Both recorded a binary: did the vendor respond
// inside classifyHold's window? A "no" was scored as "correctly waited".
//
// But "no" has two completely different causes:
//   (a) the vendor held the turn open, heard the caller, and was still waiting
//       for them to continue  -- which is the behaviour we want, or
//   (b) the vendor never registered speech at all and the session was inert
//       -- which is a broken configuration scored as a virtue.
//
// A receptionist that never answers is not patient. Telling these apart needs
// only one thing the earlier arms did not do: keep sending silence well past
// the window and record WHEN the vendor eventually commits. A hold that
// resolves at 2.5 s is patience. A hold that never resolves is a dead session.
//
// Deliberately small: the ambiguous cells only, 3 trials each.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { openSession as geminiSession, sendAudio, armTurn, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { openSession as openaiSession, appendAudio, billableUsage } from "./lib/openai.js";
import { geminiFrames, openaiFrames, paceFrames, silenceFrames } from "./lib/audio.js";
import { SYSTEM_PROMPT, OPENAI_TOOLS } from "./lib/prompt.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { p50, writeRaw } from "./lib/stats.js";
import { VERTEX_MODEL, VERTEX_LOCATION } from "./lib/geminiSession.js";

const N = 3;
/** Round 3 re-runs this for the two finalists rather than 2.5 and the mini. */
const G_SURFACE = process.env.PROBE_G_SURFACE || "vertex";
const G_MODEL = process.env.PROBE_G_MODEL || VERTEX_MODEL;
const O_MODEL = process.env.PROBE_O_MODEL || "gpt-realtime-2.1-mini";
const TAG = process.env.PROBE_TAG || "r2-holdtime";
/** Far past any classifyHold window, so a real hold has room to resolve. */
const MAX_HOLD_MS = 12000;
const EST = 0.05;

const GEMINI_ARMS = {
  patient: { endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 1200 },
  default: null,
};
const OPENAI_ARMS = {
  "semantic:low": { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
  "server:500": { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
};

const FIXTURES = ["no_terminal_punct", "trailing_lead_in", "partial_digits"];

async function geminiHold(armName, label, idx) {
  reserve(`hold gemini ${armName}/${label}`, EST);
  const { session, state } = await geminiSession({
    surface: G_SURFACE, model: G_MODEL,
    automaticActivityDetection: GEMINI_ARMS[armName] || undefined,
  });
  let row = { vendor: "gemini", arm: armName, label, trial: idx + 1 };
  try {
    await setupOk(state);
    armTurn(state);
    await paceFrames(geminiFrames(label).frames, (f) => sendAudio(session, f));
    const tEnd = Date.now();
    // Keep the line alive the whole time, exactly as Twilio would.
    await paceFrames(silenceFrames("pcm16k", MAX_HOLD_MS), (f) => sendAudio(session, f), {
      stop: () => state.firstAudioAt !== null,
    });
    row = {
      ...row,
      responded: state.firstAudioAt !== null,
      hold_ms: state.firstAudioAt ? state.firstAudioAt - tEnd : null,
      heard: state.inputTranscript.trim(),
      said: state.outputTranscript.trim().slice(0, 120),
    };
  } finally { try { session.close(); } catch {} await sleep(250); }
  const c = price(G_MODEL, state.usage);
  commit({ probe: "R2", arm: `hold:gemini:${armName}:${label}`, run: idx + 1, model: G_MODEL, location: G_SURFACE, usage: state.usage, usd: c.usd });
  row.usd = c.usd;
  return row;
}

async function openaiHold(armName, label, idx) {
  reserve(`hold openai ${armName}/${label}`, EST);
  const model = O_MODEL;
  const s = await openaiSession({
    model, instructions: SYSTEM_PROMPT, tools: OPENAI_TOOLS, turnDetection: OPENAI_ARMS[armName],
  });
  let row = { vendor: "openai", arm: armName, label, trial: idx + 1 };
  try {
    await waitFor(() => s.state.sessionUpdated, 10000);
    await paceFrames(openaiFrames(label).frames, (f) => appendAudio(s.send, f));
    const tEnd = Date.now();
    await paceFrames(silenceFrames("ulaw8k", MAX_HOLD_MS), (f) => appendAudio(s.send, f), {
      stop: () => s.state.firstAudioAt !== null,
    });
    row = {
      ...row,
      responded: s.state.firstAudioAt !== null,
      hold_ms: s.state.firstAudioAt ? s.state.firstAudioAt - tEnd : null,
      commit_ms: s.state.responseCreatedAt ? s.state.responseCreatedAt - tEnd : null,
      heard: s.state.inputTranscript.trim(),
      said: s.state.outputTranscript.trim().slice(0, 120),
    };
  } finally { s.close(); await sleep(250); }
  const usage = billableUsage(s.state.usage);
  const c = price(model, usage);
  commit({ probe: "R2", arm: `hold:openai:${armName}:${label}`, run: idx + 1, model, usage, usd: c.usd });
  row.usd = c.usd;
  return row;
}

async function main() {
  console.log(`R2 hold-time diagnostic — does "waited" mean held, or inert?`);
  console.log(`max hold ${MAX_HOLD_MS} ms, N=${N}   spent $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);
  const rows = [];

  for (const [vendor, arms, fn] of [
    ["gemini", Object.keys(GEMINI_ARMS), geminiHold],
    ["openai", Object.keys(OPENAI_ARMS), openaiHold],
  ]) {
    for (const arm of arms) {
      for (const label of FIXTURES) {
        const cell = [];
        for (let i = 0; i < N; i++) {
          try { cell.push(await fn(arm, label, i)); }
          catch (e) {
            if (e.name === "BudgetExceeded") throw e;
            cell.push({ vendor, arm, label, trial: i + 1, error: e.message?.slice(0, 120) });
          }
        }
        rows.push(...cell);
        const ok = cell.filter((r) => r.responded);
        const holds = ok.map((r) => r.hold_ms);
        const heard = cell.filter((r) => (r.heard || "").trim()).length;
        console.log(
          `  ${vendor.padEnd(7)} ${arm.padEnd(13)} ${label.padEnd(18)} ` +
          `responded ${ok.length}/${cell.length}  hold p50 ${holds.length ? p50(holds) + "ms" : "NEVER"}  transcript ${heard}/${cell.length}`
        );
      }
    }
    console.log("");
  }

  writeRaw(TAG, { max_hold_ms: MAX_HOLD_MS, n: N, rows, at: new Date().toISOString() });
  console.log(`  running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`R2 holdtime ABORTED: ${e.message}`); process.exit(1); });
