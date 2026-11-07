// ---------------------------------------------------------------------------
// LVX187 -- does the English-only identity line ("This business operates in
// English ... Never apologise for the language") make gemini-3.8-live TALK ABOUT
// LANGUAGE when a caller's words arrive mangled into Spanish, and does the plain
// re-ask wording ("Sorry, I didn't catch that, could you say it again?") stop it?
//
// PAID. Opens real Live sessions against the Gemini API (AI Studio). Owner
// approved 2026-11-07: $0.50 hard cap across BOTH arms together
// (lib/spendLive.js, reserveLVX187). Do not run without that approval.
//
//   node scripts/probes/lvx187-language.mjs --estimate   NO network, no spend
//   node scripts/probes/lvx187-language.mjs --dry        same as --estimate
//   node scripts/probes/lvx187-language.mjs --arm old    10 sessions (run on the code BEFORE the fix)
//   node scripts/probes/lvx187-language.mjs --arm new    10 sessions (run on the code AFTER the fix)
//
// PRE-REGISTERED PASS RULE (fixed before any session ran):
//   A reply "mentions language" if its output transcription matches
//   /language|english|idioma|inglés/i.
//   PASS = the NEW arm mentions language in at most 1 of 10 AND in fewer
//   replies than the OLD arm. Anything else is a FAIL.
//
// STOP ON FAILURE, NO RERUN, NO REWORDING. If any session errors, times out or
// yields no transcription the run stops there (no retry), what was collected is
// written, and the process exits non-zero. A failing new arm is reported as it
// is; the wording is not tuned and tried again.
//
// ARM LABEL GUARD. Before any session opens, the real prompt is rendered and the
// run is refused unless it matches the label: `old` needs "operates in English"
// in the prompt; `new` needs the re-ask sentence and no "operates in English".
//
// SAME SETUP AS PRODUCTION (lib/voice/live/index.js ~8780, ~9118): session config
// = responseModalities [AUDIO], systemInstruction from the real
// buildSystemInstruction(STEPS.GREETING, null, config, extras) with
// greetingSpoken:false, outputAudioTranscription {}, tools from the real
// buildLiveTools() (default BLOCKING behaviour), speechConfig Kore + en-US.
// Model gemini-3.8-live on the AI Studio surface.
//
// DEVIATIONS from production, stated up front:
//   1. The caller turn is TEXT; production input is audio, so no ASR step and
//      no real mis-hearing: the mangled Spanish is handed over as the
//      transcription would have delivered it. History is seeded in ONE
//      sendClientContent call (the pattern scripts/probes/p6-onfile.mjs proved
//      on 3.8-live): user "Hello?", model GREETING, user CALLER_TEXT, with
//      turnComplete:true. The greeting is seeded text, not spoken audio.
//   2. One caller turn only. GREETING is the fixture business's own greeting
//      (config.greeting, "Thanks for calling Acme Dental."), the text
//      production speaks for a custom-greeting tenant. Only the reply to the
//      caller line is scored: the seeded greeting never enters the output
//      transcription.
//   3. Business config is the Acme Dental test fixture "appointments-db"
//      (languagesSpoken ["en"], so the English-only else-branch renders), not a
//      real tenant row.
//   4. Tool calls are answered by the probe's canned instant stub
//      (lib/tools.js), not the real tool runner.
//   5. Production model id comes from the LIVE_MODEL env on Cloud Run; this
//      probe pins gemini-3.8-live (override with LVX187_MODEL).
//   6. The caller text is invented and fixed; no real caller data is used or
//      stored. Replies are stored in results-lvx187.json.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openSession, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { resultFor } from "./lib/tools.js";
import {
  CAP_USD, BudgetExceeded, RATES, commit, priceTokens, reserveLVX187,
  lvx187Spent, LVX187_CAP_USD, LVX187_PREFIX, spent as ledgerSpent,
} from "./lib/spendLive.js";
import { FIXTURES } from "../../tests/fixtures/businessConfigs.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { buildLiveTools } from "../../lib/voice/live/tools.js";
import { STEPS } from "../../lib/callState.js";

// ----------------------------------------------------------------- settings
const MODEL = process.env.LVX187_MODEL || "gemini-3.8-live";
const SURFACE = "aistudio";
const VOICE = "Kore";
const LANGUAGE_CODE = "en-US";
const FIXTURE_NAME = "appointments-db"; // Acme Dental, America/Chicago, languagesSpoken ["en"]

const GREETING_FALLBACK = (name) => `Thanks for calling ${name}. How can I help you today?`;
const CALLER_TEXT = "¿Tienes que ayudarme a ponerlo a mí?";
const N_PER_ARM = 10;
const MENTIONS_LANGUAGE = /language|english|idioma|inglés/i;
const OLD_MARK = "operates in English";
const NEW_MARK = "Sorry, I didn't catch that, could you say it again?";

const TURN_WAIT_MS = 40_000;      // max wait for the reply's turnComplete
const SESSION_WATCHDOG_MS = 60_000;

// Worst-case cost assumptions (printed by --estimate).
const CHARS_PER_TOKEN = 4;        // chars/4 token estimate
const BILLED_TURNS = 3;           // tool turn + reply turn + one spare; each re-bills the full context
const OUT_AUDIO_S = 15;           // seconds of audio out allowed
const AUDIO_TOK_PER_S = 25;
const OUT_TEXT_TOK = 1500;        // thinking / text tokens at the text_out rate

const RESULTS_FILE = path.resolve("scripts/probes/results-lvx187.json");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ESTIMATE = flag("--estimate") || flag("--dry");
const ARM = argVal("--arm");

// ------------------------------------------------------- production setup
export function renderSession() {
  const fx = FIXTURES[FIXTURE_NAME];
  const extras = {
    integrations: [],
    knowledge: [],
    businessId: null,
    callerPhone: "+15555550123",
    callId: null,
    callerContext: null,
    transferAllowed: false,
    greetingSpoken: false,
    intentMarker: false,
  };
  const text = buildSystemInstruction(STEPS.GREETING, null, fx.config, extras);
  const greeting = fx.config.greeting || GREETING_FALLBACK(fx.config.businessName);
  const tools = buildLiveTools(fx.config, extras, {}); // env {} => production default BLOCKING
  return { text, tools, config: fx.config, greeting };
}

/** Throws if the rendered prompt does not match the arm label. */
export function checkArmLabel(arm, text) {
  if (arm === "old") {
    if (!text.includes(OLD_MARK)) throw new Error(`arm "old" needs the prompt to contain "${OLD_MARK}", but it does not: the code is not the old code`);
  } else if (arm === "new") {
    if (!text.includes(NEW_MARK)) throw new Error(`arm "new" needs the prompt to contain the re-ask sentence, but it does not`);
    if (text.includes(OLD_MARK)) throw new Error(`arm "new" needs the prompt to not contain "${OLD_MARK}", but it does`);
  } else {
    throw new Error(`--arm must be old or new, got ${JSON.stringify(arm)}`);
  }
}

// ------------------------------------------------------------ cost control
function promptTokens(r) {
  return Math.ceil((r.text.length + JSON.stringify(r.tools).length) / CHARS_PER_TOKEN);
}

function worstCaseUsd(promptTok) {
  const rt = RATES[MODEL] || RATES["gemini-3.8-live"];
  return (
    ((BILLED_TURNS * promptTok) / 1e6) * rt.text_in +
    ((OUT_AUDIO_S * AUDIO_TOK_PER_S) / 1e6) * rt.audio_out +
    (OUT_TEXT_TOK / 1e6) * rt.text_out
  );
}

// ----------------------------------------------------------------- session
async function runSession({ arm, n, r }) {
  const label = `${LVX187_PREFIX}-${arm}-${n}`;
  const promptTok = promptTokens(r);
  reserveLVX187(label, worstCaseUsd(promptTok));

  const row = { arm, n, at: new Date().toISOString(), reply: "", tool_calls: [], mentions_language: null };
  let ctx = null;
  let timer = null;
  let pump = null;
  let failure = null;
  try {
    ctx = await openSession({
      surface: SURFACE,
      model: MODEL,
      answerTools: false, // answered below by the pump, as p6-onfile.mjs does
      systemInstruction: r.text,
      tools: r.tools,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } }, languageCode: LANGUAGE_CODE },
    });
    timer = setTimeout(() => { try { ctx.session.close(); } catch {} }, SESSION_WATCHDOG_MS);
    const st = ctx.state;
    if (!(await setupOk(st))) throw new Error("no setupComplete");

    // Answer every tool call with the canned instant stub.
    let answered = 0;
    pump = setInterval(() => {
      const calls = st.turnToolCallObjects.slice(answered);
      if (!calls.length) return;
      answered += calls.length;
      try {
        ctx.session.sendToolResponse({
          functionResponses: calls.map((c) => ({ id: c.id, name: c.name, response: resultFor(c.name) })),
        });
      } catch {}
    }, 20);

    ctx.session.sendClientContent({
      turns: [
        { role: "user", parts: [{ text: "Hello?" }] },
        { role: "model", parts: [{ text: r.greeting }] },
        { role: "user", parts: [{ text: CALLER_TEXT }] },
      ],
      turnComplete: true,
    });

    // A turn that ends in a tool call is followed by another after the reply;
    // done = a turnComplete with spoken text, all tool calls answered, then quiet.
    const done = await waitFor(() => {
      if (st.error) return true;
      const allAnswered = answered === st.turnToolCallObjects.length;
      return Boolean(st.turnCompleteAt && st.outputTranscript.trim() && allAnswered && Date.now() - st.turnCompleteAt > 1500);
    }, TURN_WAIT_MS);
    if (st.error) throw new Error(`session error: ${String(st.error).slice(0, 120)}`);
    if (!done) throw new Error("timeout waiting for a spoken reply");

    row.reply = (st.outputTranscript || "").trim();
    row.tool_calls = [...st.turnToolCalls];
    if (!row.reply) throw new Error("no output transcription");
    row.mentions_language = MENTIONS_LANGUAGE.test(row.reply);
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err;
    failure = (err.message || String(err)).slice(0, 160);
    row.error = failure;
  } finally {
    clearTimeout(timer);
    clearInterval(pump);
    try { ctx?.session?.close?.(); } catch {}
    if (ctx) {
      await sleep(150);
      const u = ctx.state.usage;
      let usd = 0;
      let estimated = false;
      if (u && u.turns_billed > 0) usd = priceTokens(MODEL, u).usd;
      if (!(usd > 0)) { usd = worstCaseUsd(promptTok) / BILLED_TURNS; estimated = true; } // one full-context turn
      row.usd = Number(usd.toFixed(5));
      row.usd_estimated = estimated;
      commit({ probe: `${LVX187_PREFIX}-${arm}`, arm, label, model: MODEL, usd, estimated });
    }
  }
  if (failure) { const e = new Error(failure); e.row = row; throw e; }
  return row;
}

// ------------------------------------------------------------------- modes
function estimate() {
  const r = renderSession();
  const tok = promptTokens(r);
  const per = worstCaseUsd(tok);
  const rt = RATES[MODEL] || RATES["gemini-3.8-live"];
  const spent = lvx187Spent();
  const langLine = r.text.split("\n").find((l) => l.includes(OLD_MARK) || l.includes(NEW_MARK) || l.startsWith("You can speak") || l.startsWith("Speak ")) || "(none found)";
  console.log("LVX187 estimate -- NO network, NO spend\n");
  console.log(`rendered prompt: ${r.text.length} chars; tools JSON ${JSON.stringify(r.tools).length} chars`);
  console.log(`language line in the prompt: ${JSON.stringify(langLine)}`);
  console.log(`arm label check: old=${r.text.includes(OLD_MARK)} (code has "${OLD_MARK}"), new=${r.text.includes(NEW_MARK) && !r.text.includes(OLD_MARK)}`);
  console.log(`\nmodel ${MODEL}  surface ${SURFACE}  voice ${VOICE}  language ${LANGUAGE_CODE}  modality AUDIO + output transcription`);
  console.log(`fixture: ${FIXTURE_NAME} (languagesSpoken ${JSON.stringify(r.config.languagesSpoken)}), step ${STEPS.GREETING}, greetingSpoken:false`);
  console.log(`caller text (fixed, invented): ${JSON.stringify(CALLER_TEXT)}`);
  console.log("\nDEVIATIONS from production:");
  console.log("  1. caller turn is TEXT; production input is audio (no ASR, no real mis-hearing). History seeded in one sendClientContent call (p6-onfile.mjs pattern): user Hello?, model greeting, user caller text, turnComplete:true");
  console.log(`  2. greeting = the fixture's own config.greeting, seeded as text (not spoken): ${JSON.stringify(r.greeting)}; one caller turn; only the reply to the caller line is scored`);
  console.log("  3. Acme Dental test fixture, not a real tenant");
  console.log("  4. tool calls answered by the canned instant stub");
  console.log(`  5. model pinned to ${MODEL}, not read from the LIVE_MODEL env`);
  console.log(`\nplanned sessions: ${N_PER_ARM} per arm x 2 arms = ${2 * N_PER_ARM}, one at a time, stop on first failure, no retry`);
  console.log("\nWORST-CASE ASSUMPTIONS:");
  console.log(`  prompt tokens = (prompt chars + tools JSON chars) / ${CHARS_PER_TOKEN} = ${tok}`);
  console.log(`  history (greeting turns) adds ~${Math.ceil(JSON.stringify(r.greeting).length / CHARS_PER_TOKEN) + 20} tokens, negligible`);
  console.log(`  ${BILLED_TURNS} billed turns, each re-billing the full context, uncached, at text_in $${rt.text_in}/1M`);
  console.log(`  ${OUT_AUDIO_S} s of audio out x ${AUDIO_TOK_PER_S} tok/s at audio_out $${rt.audio_out}/1M`);
  console.log(`  ${OUT_TEXT_TOK} thinking/text tokens at text_out $${rt.text_out}/1M`);
  console.log(`\nworst case per session: $${per.toFixed(4)}`);
  console.log(`worst case for ${2 * N_PER_ARM} sessions: $${(per * 2 * N_PER_ARM).toFixed(3)}  (cap $${LVX187_CAP_USD.toFixed(2)} for both arms)`);
  console.log(`LVX187 spent so far: $${spent.toFixed(4)}; remaining under cap: $${(LVX187_CAP_USD - spent).toFixed(4)}`);
  console.log(`ledger: $${ledgerSpent().toFixed(4)} of $${CAP_USD}`);
  console.log(`reserve rule: before each session the worst case ($${per.toFixed(4)}) must fit under the cap given actual spend so far; actuals are priced from usageMetadata.`);
}

function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); } catch { return { arms: [] }; }
}
function saveArm(block) {
  const out = loadResults();
  if (!Array.isArray(out.arms)) out.arms = [];
  out.arms.push(block);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2) + "\n");
}

async function main() {
  if (ESTIMATE) { estimate(); return; }
  if (ARM !== "old" && ARM !== "new") { console.error("--arm old|new is required for a paid run (or use --estimate)"); process.exit(2); }
  const r = renderSession();
  try { checkArmLabel(ARM, r.text); } catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(2); }
  if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(2); }

  const rows = [];
  let stopped = null;
  for (let n = 1; n <= N_PER_ARM; n++) {
    try {
      const row = await runSession({ arm: ARM, n, r });
      rows.push(row);
      console.log(`  ${ARM} #${n}: ${row.mentions_language ? "MENTIONS LANGUAGE" : "no mention"}  $${row.usd}${row.usd_estimated ? "~" : ""}  ${JSON.stringify(row.reply)}`);
    } catch (e) {
      if (e.row) rows.push(e.row);
      stopped = `${ARM} #${n}: ${e.message}`;
      console.error(`\nSTOPPED (no retry): ${stopped}`);
      break;
    }
  }
  const valid = rows.filter((x) => !x.error);
  const mentions = valid.filter((x) => x.mentions_language).length;
  saveArm({
    arm: ARM, model: MODEL, surface: SURFACE, fixture: FIXTURE_NAME, caller_text: CALLER_TEXT,
    finished_at: new Date().toISOString(), complete: !stopped, stopped, n: valid.length, mentions, rows,
  });
  console.log(`\n=== LVX187 ${ARM} arm: n=${valid.length} mentions=${mentions} ===`);
  valid.forEach((x, i) => console.log(`  ${i + 1}. ${JSON.stringify(x.reply)}`));
  console.log(`LVX187 total $${lvx187Spent().toFixed(4)} of $${LVX187_CAP_USD.toFixed(2)}; ledger $${ledgerSpent().toFixed(4)} of $${CAP_USD}`);
  if (stopped) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
