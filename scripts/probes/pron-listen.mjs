// ---------------------------------------------------------------------------
// Pronunciation listening test (2026-10-20) -- go/no-go for the mid-call
// pronunciation box. Does gemini-3.8-live say the business name right, mid-call,
// when the prompt carries a SOUND-SPELLING instead of the written name?
//
// PAID. Opens real Live sessions against the Gemini API (AI Studio). Owner
// authorised a hard cap of $0.60 for this probe only (smoke included), 2026-10-20.
//
//   node scripts/probes/pron-listen.mjs --dry     NO network: arms, prompt size, leak check
//   node scripts/probes/pron-listen.mjs --smoke   1 session per arm (not judged)
//   node scripts/probes/pron-listen.mjs           full run; resumable (reads results.json)
//   node scripts/probes/pron-listen.mjs --order   (re)write the blind shuffled order only
//
// PRE-REGISTERED in .superpowers/sdd/2026-10-20-pronunciation/ledger.md (before
// any paid run). Short form: 4 arms (3 spellings + CONTROL "Digile"), 10 valid
// samples each (reply transcript contains "media"), at most 13 sessions per arm;
// owner judges blind on a phone; a spelling PASSES at >= 9/10 Right; CONTROL must
// fail or the result is INCONCLUSIVE.
//
// SAME AS PRODUCTION: real loadConfig + buildSystemInstruction(IDENTIFY_INTENT)
// + buildLiveTools, greetingSpoken false, intentMarker false, gemini-3.8-live,
// voice Kore, en-GB; the audio a caller would hear is rendered through
// production's own downsampler (24 kHz -> 8 kHz mu-law) and decoder.
// DEVIATIONS: the caller's words arrive as TEXT (sendClientContent); greeting
// seeded as a model text turn; canned tool replies; allowed_tasks + capability
// rows are defaults; config = the UK Digile tenant's prose fields as of 10-12.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomInt, randomBytes } from "node:crypto";
import { openSession, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { CAP_USD, BudgetExceeded, commit, priceTokens, load as loadLedger } from "./lib/spendLive.js";
import { loadConfig } from "../../services/db.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { buildLiveTools } from "../../lib/voice/live/tools.js";
import { STEPS } from "../../lib/callState.js";
import { createDownsampler, mulaw8kToPcm16k } from "../../lib/voice/resample.js";

const MODEL = "gemini-3.8-live";
const VOICE = "Kore";
const LANGUAGE = "en-GB";
const PREFIX = "PRONLISTEN";
const PROBE_CAP_USD = 0.6;
const WORST_SESSION_USD = 0.02;
const VALID_PER_ARM = 10;
const MAX_SESSIONS_PER_ARM = 13;
const TURN_TIMEOUT_MS = 30_000;
const UNREPORTED_SESSION_USD = 0.0102;

const ARMS = [
  { arm: "A", spelling: "Dij-aisle" },
  { arm: "B", spelling: "Didge-isle" },
  { arm: "C", spelling: "Dijile" },
  { arm: "CONTROL", spelling: "Digile" },
];
const QUESTIONS = [
  ...Array(4).fill("Sorry, what's the company called again?"),
  ...Array(3).fill("Who am I speaking to, sorry?"),
  ...Array(3).fill("What does your company actually do?"),
];

const BACKUP = path.resolve(".superpowers/backups/2026-10-12-s6-uk-show.txt");
const OUT = path.resolve(".superpowers/sdd/2026-10-20-pronunciation/listen");
const RESULTS_FILE = path.join(OUT, "results.json");
const SMOKE_FILE = path.join(OUT, "smoke.json");
const ORDER_FILE = path.join(OUT, "order.json");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const SMOKE = argv.includes("--smoke");
const ONE = argv.includes("--one"); // with --smoke: arm A only (meter check)
const ORDER_ONLY = argv.includes("--order");

// --- the tenant, from the set-business-config --show backup -----------------
function readBackup() {
  const fields = {};
  for (const line of fs.readFileSync(BACKUP, "utf8").split(/\r?\n/)) {
    const m = /^\[cfg\] BEFORE (\w+) b64 ?(.*)$/.exec(line);
    if (m) fields[m[1]] = Buffer.from(m[2].trim(), "base64").toString("utf8");
  }
  return fields;
}

const RAW = readBackup();
const BUSINESS_ID = "55c7c8c4-2c33-463c-875a-7f16d6bcc17e";

function rowFor(spelling) {
  const sub = (s) => (s ? s.replace(/Digile/g, spelling) : s);
  return {
    id: BUSINESS_ID,
    name: sub(RAW.name),
    greeting: sub(RAW.greeting),
    general_info: sub(RAW.general_info),
    custom_instructions: sub(RAW.custom_instructions),
    timezone: RAW.timezone,
    after_hours_policy: RAW.after_hours_policy,
    transfer_phone_number: RAW.transfer_phone_number || null,
    transfer_no_answer: RAW.transfer_no_answer,
    sms_followup_enabled: RAW.sms_followup_enabled === "true",
    allow_pricier_numbers: RAW.allow_pricier_numbers === "true",
    live_voice: null,
    locale: null,
  };
}

function buildArm(spelling) {
  const config = loadConfig(rowFor(spelling), []);
  const extras = {
    integrations: [],
    knowledge: [],
    businessId: BUSINESS_ID,
    callerPhone: "+447700900123",
    callId: null,
    callSid: PREFIX,
    callerContext: null,
    transferAllowed: false,
    greetingSpoken: false,
    intentMarker: false,
  };
  const instruction = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, extras);
  const tools = buildLiveTools(config, extras, {});
  return { config, extras, instruction, tools };
}

// --- audio -------------------------------------------------------------------
/** Same render as scripts/probes/voice-drift.mjs: production's downsampler, then its decoder. */
function toTelephoneBand(pcm24k) {
  const down = createDownsampler();
  return mulaw8kToPcm16k(down.process(pcm24k));
}

function wav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// --- budget --------------------------------------------------------------------
function probeSpent() {
  return loadLedger()
    .entries.filter((e) => typeof e.probe === "string" && e.probe.startsWith(PREFIX))
    .reduce((s, e) => s + (e.usd || 0), 0);
}

function reserve() {
  const spent = probeSpent();
  if (spent + WORST_SESSION_USD > PROBE_CAP_USD) {
    throw new BudgetExceeded(`BUDGET: ${PREFIX} at $${spent.toFixed(4)} + worst $${WORST_SESSION_USD} > cap $${PROBE_CAP_USD}`);
  }
  if (loadLedger().spent_usd + WORST_SESSION_USD > CAP_USD) throw new BudgetExceeded("overall ledger cap");
}

// --- one session ---------------------------------------------------------------
async function runOne(armDef, question, built, tag) {
  reserve();
  const { session, state } = await openSession({
    surface: "aistudio",
    model: MODEL,
    answerTools: false,
    capturePcm: true,
    systemInstruction: built.instruction,
    tools: built.tools,
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } }, languageCode: LANGUAGE },
  });
  const id = randomBytes(3).toString("hex");
  const out = { id, tag, arm: armDef.arm, spelling: armDef.spelling, question, transcript: "", tools: [], error: null, usd: 0 };
  try {
    if (!(await setupOk(state))) throw new Error("setup failed");
    let answered = 0;
    const pump = setInterval(() => {
      const calls = state.turnToolCallObjects.slice(answered);
      if (!calls.length) return;
      answered += calls.length;
      out.tools.push(...calls.map((c) => c.name));
      try {
        session.sendToolResponse({ functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response: { success: true } })) });
      } catch {}
    }, 20);
    session.sendClientContent({
      turns: [
        { role: "user", parts: [{ text: "Hello?" }] },
        { role: "model", parts: [{ text: built.config.greeting }] },
        { role: "user", parts: [{ text: question }] },
      ],
      turnComplete: true,
    });
    // Done = spoken text, every tool call answered, a turnComplete AFTER the last
    // audio, then 1.5 s quiet. The smoke closed on audio-quiet alone and every
    // session was metered at $0: usageMetadata rides on turnComplete, which had
    // not arrived yet.
    await waitFor(() => {
      if (state.error) return true;
      const allAnswered = answered === state.turnToolCallObjects.length;
      return Boolean(
        state.outputTranscript.trim() && allAnswered && state.lastAudioAt &&
        state.turnCompleteAt && state.turnCompleteAt >= state.lastAudioAt &&
        Date.now() - state.lastAudioAt > 1500
      );
    }, TURN_TIMEOUT_MS);
    // Then give the usage report a moment of its own before the socket goes.
    await waitFor(() => state.usage.turns_billed > 0, 3000);
    clearInterval(pump);
    out.transcript = state.outputTranscript.trim();
    out.error = state.error;
  } catch (e) {
    out.error = e?.message || String(e);
  } finally {
    try { session.close(); } catch {}
    await sleep(300);
    // The audio is what the money bought: on disk BEFORE the bookkeeping.
    const pcm = Buffer.concat(state.pcmChunks.map((c) => c.pcm));
    out.seconds = Number((pcm.length / 2 / 24_000).toFixed(1));
    if (pcm.length) {
      fs.mkdirSync(path.join(OUT, "wav"), { recursive: true });
      fs.mkdirSync(path.join(OUT, "studio"), { recursive: true });
      fs.writeFileSync(path.join(OUT, "wav", `${id}.wav`), wav(toTelephoneBand(pcm), 16_000));
      fs.writeFileSync(path.join(OUT, "studio", `${id}.wav`), wav(pcm, 24_000));
    }
    // A session that billed and reported nothing still cost money: fall back to
    // the measured per-session cost of this prompt builder (p6-onfile, max).
    const reported = state.usage.turns_billed > 0;
    out.usd = reported ? priceTokens(MODEL, state.usage).usd : UNREPORTED_SESSION_USD;
    out.usage = state.usage;
    out.usd_estimated = !reported;
    commit({ probe: `${PREFIX}-${armDef.arm}`, label: `${tag}-${id}`, model: MODEL, usd: out.usd, estimated: !reported });
  }
  out.valid = Boolean(!out.error && out.seconds > 0 && /media/i.test(out.transcript));
  return out;
}

// --- blind order ---------------------------------------------------------------
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function writeOrder(results) {
  const ids = shuffle(results.filter((r) => r.valid).map((r) => r.id));
  fs.writeFileSync(ORDER_FILE, JSON.stringify({ written_at: new Date().toISOString(), ids }, null, 2) + "\n");
  console.log(`order.json: ${ids.length} clips, shuffled (arm key only in results.json)`);
}

const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const BUILT = Object.fromEntries(ARMS.map((a) => [a.arm, buildArm(a.spelling)]));

// --- modes ---------------------------------------------------------------------
if (DRY) {
  for (const a of ARMS) {
    const b = BUILT[a.arm];
    // The email, website and Instagram handle keep the real letters on purpose:
    // the box maps the NAME, and a caller must be given the real address.
    const spokenOnly = (s) => s.replace(/\S*digile-media\.com\S*|@digilemedia/gi, "");
    const leak = /digile/i.test(spokenOnly(b.instruction)) || /digile/i.test(spokenOnly(JSON.stringify(b.tools)));
    const hits = b.instruction.split(a.spelling).length - 1;
    console.log(`${a.arm.padEnd(8)} ${a.spelling.padEnd(11)} prompt ${b.instruction.length} chars (~${Math.round(b.instruction.length / 4)} tok); spelling x${hits}; digile left: ${leak}`);
    if (a.arm !== "CONTROL" && leak) { console.error(`LEAK: arm ${a.arm} still carries "digile"`); process.exitCode = 1; }
  }
  console.log(`greeting (A): ${BUILT.A.config.greeting}`);
  console.log(`name (A): ${BUILT.A.config.businessName}; tz ${BUILT.A.config.timezone}`);
  console.log(`probe spent so far $${probeSpent().toFixed(4)} of $${PROBE_CAP_USD}; ledger $${loadLedger().spent_usd.toFixed(4)} of $${CAP_USD}`);
  process.exit();
}

if (ORDER_ONLY) {
  writeOrder(loadJson(RESULTS_FILE, { results: [] }).results);
  process.exit();
}

fs.mkdirSync(OUT, { recursive: true });

if (SMOKE) {
  const smoke = [];
  for (const a of ONE ? ARMS.slice(0, 1) : ARMS) {
    const r = await runOne(a, QUESTIONS[0], BUILT[a.arm], "smoke");
    smoke.push(r);
    console.log(`${a.arm.padEnd(8)} valid=${+r.valid} ${r.seconds}s $${r.usd.toFixed(4)}${r.usd_estimated ? " (EST)" : ""} ${JSON.stringify(r.usage)} ${r.error ? `ERR ${r.error} ` : ""}| ${r.transcript.slice(0, 140)}`);
  }
  fs.writeFileSync(SMOKE_FILE, JSON.stringify({ results: smoke }, null, 2) + "\n");
  console.log(`smoke $${smoke.reduce((s, r) => s + r.usd, 0).toFixed(4)}; probe total $${probeSpent().toFixed(4)}`);
  process.exit();
}

// Full run, resumable: per arm a queue of 10 question slots; an invalid reply
// re-queues its slot; an arm stops at 10 valid or 13 sessions. Round-robin.
const saved = loadJson(RESULTS_FILE, { results: [] });
const results = saved.results;
const save = () => fs.writeFileSync(RESULTS_FILE, JSON.stringify({ model: MODEL, voice: VOICE, language: LANGUAGE, results }, null, 2) + "\n");
// --topup (AMENDMENT 1, ledger): Q3 never says the name (0/24, "We are a UK
// digital marketing agency..."), so its 3 slots become Q1 x2 + Q2 x1, at most
// TOPUP_MAX_SESSIONS more sessions per arm. Recorded before any clip was judged.
const TOPUP = argv.includes("--topup");
const TOPUP_QUESTIONS = [QUESTIONS[0], QUESTIONS[0], QUESTIONS[4]];
const TOPUP_MAX_SESSIONS = 4;
const queues = Object.fromEntries(ARMS.map((a) => {
  const tag = TOPUP ? "topup" : "full";
  const done = results.filter((r) => r.arm === a.arm && r.valid && (r.tag || "full") === tag).map((r) => r.question);
  const q = [...(TOPUP ? TOPUP_QUESTIONS : QUESTIONS)];
  for (const d of done) q.splice(q.indexOf(d), 1);
  return [a.arm, q];
}));
const sessionsFor = TOPUP
  ? (arm) => MAX_SESSIONS_PER_ARM + results.filter((r) => r.arm === arm && r.tag === "topup").length - TOPUP_MAX_SESSIONS
  : (arm) => results.filter((r) => r.arm === arm).length;
const validFor = (arm) => results.filter((r) => r.arm === arm && r.valid).length;
let consecutiveErrors = 0;
// --max N: stop after N sessions this invocation (keeps a foreground run under
// the tool's 10-minute limit; a kill mid-session would bill without a commit).
const maxArg = argv.indexOf("--max");
const MAX_THIS_RUN = maxArg >= 0 ? Number(argv[maxArg + 1]) : Infinity;
let ranThisRun = 0;

outer: while (true) {
  let ran = false;
  for (const a of ARMS) {
    if (ranThisRun >= MAX_THIS_RUN) break outer;
    if (validFor(a.arm) >= VALID_PER_ARM || sessionsFor(a.arm) >= MAX_SESSIONS_PER_ARM || !queues[a.arm].length) continue;
    const question = queues[a.arm].shift();
    let r;
    try {
      r = await runOne(a, question, BUILT[a.arm], TOPUP ? "topup" : "full");
    } catch (e) {
      if (e instanceof BudgetExceeded) { console.log(e.message); break outer; }
      throw e;
    }
    ran = true;
    ranThisRun += 1;
    results.push(r);
    save();
    if (!r.valid) queues[a.arm].push(question);
    consecutiveErrors = r.error ? consecutiveErrors + 1 : 0;
    console.log(`${a.arm.padEnd(8)} #${sessionsFor(a.arm)} valid=${+r.valid} (${validFor(a.arm)}/10) ${r.seconds}s $${r.usd.toFixed(4)} ${r.error ? `ERR ${r.error} ` : ""}| ${r.transcript.slice(0, 120)}`);
    if (consecutiveErrors >= 3) { console.log("three consecutive errors -- aborting"); break outer; }
  }
  if (!ran) break;
}

const summary = Object.fromEntries(ARMS.map((a) => [a.arm, { spelling: a.spelling, valid: validFor(a.arm), sessions: sessionsFor(a.arm) }]));
console.log(JSON.stringify({ summary, usd_full: results.reduce((s, r) => s + r.usd, 0), probe_total: probeSpent() }, null, 2));
const complete = ARMS.every((a) => validFor(a.arm) >= VALID_PER_ARM || sessionsFor(a.arm) >= MAX_SESSIONS_PER_ARM);
if (complete) writeOrder(results);
else console.log("not complete -- re-run to continue (order.json not written)");
