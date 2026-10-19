// ---------------------------------------------------------------------------
// Round A1 Part 6, Fix 2 -- does the on-file note in set_call_intent's reply
// stop gemini-3.8-live asking an on-file caller to spell their name?
//
// PAID. Opens real Live sessions against the Gemini API (AI Studio). Owner
// authorised ~$0.40, hard cap $0.50 for this probe only, 2026-10-19.
//
//   node scripts/probes/p6-onfile.mjs --dry     NO network: arms, worst case $, note text
//   node scripts/probes/p6-onfile.mjs --smoke   1 session per arm
//   node scripts/probes/p6-onfile.mjs           full run: 10 per arm (5 per caller line)
//
// PRE-REGISTERED (before any run):
//   PRIMARY  SPELL = the model's reply to the caller's first turn asks for a
//            spelling (/\bspell/i). The note ships only if
//            note.SPELL <= plain.SPELL - 3 (of 10). If plain.SPELL < 3 the
//            instrument did not reproduce the defect: INCONCLUSIVE, owner decides.
//   SECONDARY NAME = asks for the name in any form ("your name", "the name");
//            "Is that under <name>?" is a yes/no, not a name ask.
//            MOVE = a question about moving / rescheduling / an extra one.
//
// SAME AS PRODUCTION: real buildSystemInstruction (IDENTIFY_INTENT) with a
// caller snapshot shaped like the Test Line's on 10-19 (several names on one
// number), real buildLiveTools (BLOCKING), voice Kore en-US, gemini-3.8-live.
// The note is the real onFileNameNote().
// DEVIATIONS: Acme Dental fixture config, not the Test Line row; the caller's
// words arrive as TEXT (sendClientContent), not audio; tools are answered by
// this script's canned replies (set_call_intent per arm; availability
// "available"); greeting seeded as a text turn.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openSession, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { CAP_USD, BudgetExceeded, commit, priceTokens, load as loadLedger } from "./lib/spendLive.js";
import { FIXTURES } from "../../tests/fixtures/businessConfigs.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { buildLiveTools } from "../../lib/voice/live/tools.js";
import { onFileNameNote } from "../../capabilities/appointments.js";
import { STEPS } from "../../lib/callState.js";

const MODEL = process.env.P6_MODEL || "gemini-3.8-live";
const PREFIX = "P6ONFILE";
const PROBE_CAP_USD = 0.5;
const WORST_SESSION_USD = 0.04;
const N_PER_LINE = 5;
const LINES = [
  "Hi, I'd like to book another appointment for myself.",
  "Hi, I'd like to book another appointment for myself, Tuesday the 27th at 9 a.m.",
];
const TURN_TIMEOUT_MS = 30_000;
const RESULTS_FILE = path.resolve("scripts/probes/results-p6-onfile.json");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const SMOKE = argv.includes("--smoke");
// --note-only (after the opus review changed the note: listed names only, the
// in_addition flag): re-run the note arm alone against the first run's plain
// arm (5/10). PRE-REGISTERED: it passes if note SPELL <= 2/10.
const NOTE_ONLY = argv.includes("--note-only");
const BASELINE_PLAIN_SPELL = 5;

// The Test Line's snapshot shape on 2026-10-19 (pseudonyms kept as on the line).
const at = (d, h) => new Date(`2026-10-${d}T${String(h).padStart(2, "0")}:00:00-05:00`).toISOString();
const R = (id, client_name, d, h) => ({ id, client_name, scheduled_at: at(d, h) });
const CALLER_CONTEXT = {
  callCount: 6,
  lastCallSummary: null,
  upcomingAppointments: [
    R("a1", "Nithin Dodla", 20, 11),
    R("a2", "Nithin Dodla", 20, 14),
    R("a3", "Priya Raman", 21, 10),
    R("a4", "Leila Hartmann", 21, 11),
    R("a5", "Nithin Dodla", 22, 14),
  ],
  upcomingOverflow: 4,
  upcomingBeyond: [R("b1", "Nithin Dodla", 23, 14), R("b2", "Maja Okafor", 28, 9), R("b3", "Maja Okafor", 28, 10), R("b4", "Nithin Dodla", 29, 14)],
};

const fx = FIXTURES["appointments-db"];
const config = fx.config;
const extras = {
  integrations: [],
  knowledge: [],
  businessId: null,
  callerPhone: "+15555550123",
  callId: null,
  callerContext: CALLER_CONTEXT,
  transferAllowed: false,
  greetingSpoken: false,
  intentMarker: false,
};
const NOTE = onFileNameNote({ callerSaidThisCall: "", callerContext: CALLER_CONTEXT, config }, "book_appointment");
const ARMS = {
  plain: { success: true },
  note: { success: true, message: NOTE },
};
const GREETING = `Thanks for calling ${config.businessName}. How can I help you today?`;

const SPELL_RE = /\bspell/i;
const NAME_RE = /\b(?:your|the)\s+(?:full\s+|first\s+and\s+last\s+|first\s+|last\s+)?name\b/i;
const MOVE_RE = /\b(?:reschedul\w*|move|moving|additional|in\s+addition|existing\s+(?:one|appointment)|an?\s+extra)\b/i;

function score(reply) {
  const questions = reply.split(/(?<=[?])/).filter((q) => q.includes("?"));
  return {
    spell: SPELL_RE.test(reply),
    name: NAME_RE.test(reply),
    move: questions.some((q) => MOVE_RE.test(q)),
  };
}

function ledgerSpent() {
  return loadLedger()
    .entries.filter((e) => typeof e.probe === "string" && e.probe.startsWith(PREFIX))
    .reduce((s, e) => s + (e.usd || 0), 0);
}

function reserve() {
  const spent = ledgerSpent();
  if (spent + WORST_SESSION_USD > PROBE_CAP_USD) {
    throw new BudgetExceeded(`BUDGET: ${PREFIX} at $${spent.toFixed(4)} + worst $${WORST_SESSION_USD} > cap $${PROBE_CAP_USD}`);
  }
  if (loadLedger().spent_usd + WORST_SESSION_USD > CAP_USD) throw new BudgetExceeded("overall ledger cap");
}

function toolReply(call, arm) {
  if (call.name === "set_call_intent") return ARMS[arm];
  if (call.name === "check_appointment_availability") {
    return { success: true, available: true, message: "That time is available." };
  }
  return { success: true };
}

async function runOne(arm, line, idx) {
  reserve();
  const instruction = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, extras);
  const { session, state } = await openSession({
    surface: "aistudio",
    model: MODEL,
    answerTools: false,
    systemInstruction: instruction,
    tools: buildLiveTools(config, extras, {}),
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, languageCode: "en-US" },
  });
  const out = { arm, line, idx, reply: "", tools: [], error: null, usd: 0 };
  try {
    if (!(await setupOk(state))) throw new Error("setup failed");
    let answered = 0;
    const pump = setInterval(() => {
      const calls = state.turnToolCallObjects.slice(answered);
      if (!calls.length) return;
      answered += calls.length;
      out.tools.push(...calls.map((c) => c.name));
      try {
        session.sendToolResponse({
          functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response: toolReply(c, arm) })),
        });
      } catch {}
    }, 20);
    session.sendClientContent({
      turns: [
        { role: "user", parts: [{ text: "Hello?" }] },
        { role: "model", parts: [{ text: GREETING }] },
        { role: "user", parts: [{ text: line }] },
      ],
      turnComplete: true,
    });
    // A turn that ends in a tool call is followed by another after the reply;
    // done = a turnComplete with spoken text, all tool calls answered, then quiet.
    const t0 = Date.now();
    let lastTc = null;
    await waitFor(() => {
      if (state.error) return true;
      if (state.turnCompleteAt && state.turnCompleteAt !== lastTc) lastTc = state.turnCompleteAt;
      const allAnswered = answered === state.turnToolCallObjects.length;
      return Boolean(lastTc && state.outputTranscript.trim() && allAnswered && Date.now() - lastTc > 1500);
    }, TURN_TIMEOUT_MS);
    clearInterval(pump);
    out.ms = Date.now() - t0;
    out.reply = state.outputTranscript.trim();
    out.error = state.error;
  } catch (e) {
    out.error = e?.message || String(e);
  } finally {
    try { session.close(); } catch {}
    await sleep(300);
    const p = priceTokens(MODEL, state.usage);
    out.usd = p.usd;
    out.usage = state.usage;
    commit({ probe: `${PREFIX}-${arm}`, arm, label: `${arm}-${idx}`, model: MODEL, usd: p.usd, estimated: false });
  }
  Object.assign(out, score(out.reply));
  return out;
}

if (DRY) {
  const instruction = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, extras);
  console.log(`model ${MODEL}; prompt ${instruction.length} chars (~${Math.round(instruction.length / 4)} tokens)`);
  console.log(`sessions: ${SMOKE ? 2 : 2 * LINES.length * N_PER_LINE}; worst $${WORST_SESSION_USD}/session; cap $${PROBE_CAP_USD}; spent so far $${ledgerSpent().toFixed(4)}`);
  console.log(`note arm reply.message:\n  ${NOTE}`);
  console.log(`CALLER CONTEXT block present: ${/Upcoming appointments:/.test(instruction)}`);
  process.exit(0);
}

const plan = [];
if (SMOKE) {
  plan.push(["plain", LINES[0], 0], ["note", LINES[0], 0]);
} else {
  // Interleaved so drift over the run hits both arms alike.
  for (let i = 0; i < N_PER_LINE; i++) for (const line of LINES) for (const arm of NOTE_ONLY ? ["note"] : ["plain", "note"]) plan.push([arm, line, i]);
}
const results = [];
for (const [arm, line, i] of plan) {
  try {
    const r = await runOne(arm, line, i);
    results.push(r);
    console.log(`${arm.padEnd(5)} L${LINES.indexOf(line)} #${i} spell=${+r.spell} name=${+r.name} move=${+r.move} $${r.usd.toFixed(4)} ${r.error ? `ERR ${r.error}` : ""}| ${r.reply.slice(0, 160)}`);
  } catch (e) {
    if (e instanceof BudgetExceeded) { console.log(e.message); break; }
    throw e;
  }
}
const valid = results.filter((r) => !r.error && r.reply);
const tally = (arm, k) => valid.filter((r) => r.arm === arm && r[k]).length;
const n = (arm) => valid.filter((r) => r.arm === arm).length;
const summary = {
  model: MODEL,
  n: { plain: n("plain"), note: n("note") },
  spell: { plain: tally("plain", "spell"), note: tally("note", "spell") },
  name: { plain: tally("plain", "name"), note: tally("note", "name") },
  move: { plain: tally("plain", "move"), note: tally("note", "move") },
  invalid: results.length - valid.length,
  usd: results.reduce((s, r) => s + r.usd, 0),
};
summary.verdict = NOTE_ONLY
  ? (summary.spell.note <= BASELINE_PLAIN_SPELL - 3 ? "NOTE HOLDS" : "NOTE REGRESSED")
  : summary.spell.plain < 3 ? "INCONCLUSIVE (plain arm did not reproduce)" :
  summary.spell.note <= summary.spell.plain - 3 ? "NOTE WINS" : "NO WIN";
console.log(JSON.stringify(summary, null, 2));
if (!SMOKE) fs.writeFileSync(NOTE_ONLY ? RESULTS_FILE.replace(".json", "-v2.json") : RESULTS_FILE, JSON.stringify({ summary, note: NOTE, results }, null, 2));
