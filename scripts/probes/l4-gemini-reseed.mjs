// ---------------------------------------------------------------------------
// L4 — does Gemini's text-reseed cost fix preserve a hard-to-spell name? V6.
//
//   node scripts/probes/l4-gemini-reseed.mjs
//
// LV2 (the text reseed) is the entire economic case for Gemini Live: Live
// re-bills the whole context every turn, so the only way the numbers work is to
// drop the accumulated AUDIO history and reseed the session from a TEXT
// transcript. That is a lossy conversion by construction — audio in, text out,
// audio again — and the one thing a receptionist cannot get wrong is the
// caller's name.
//
// "Nithin" is not an arbitrary choice. It is the name that broke the cascade on
// a real handset: Google STT returned niton / nithan / Nathan and never once the
// correct spelling (gcp-migration-ledger.md:804). Deepgram got it right. If the
// reseed loses it too, LV2 costs us the exact defect the migration was supposed
// to be neutral on.
//
// ASSERTION IS EXACT STRING EQUALITY. PLAN.md: "Read-back by ear cannot catch a
// spelling error." A human listening to synthesized speech hears "Nithin" and
// "Nithan" as the same word.
//
// Two deviations from PLAN.md, both recorded rather than quietly taken:
//
//  1. There is no caller fixture that asks for a spelling read-back, so turn 6
//     is injected as TEXT via sendClientContent instead of as audio. What is
//     under test is whether the reseed carried the name across, not how the
//     question was asked.
//  2. What we can actually read is Gemini's own output transcription of its
//     speech. So this measures whether the model still KNOWS the spelling, not
//     whether its text-to-speech pronounces it. That is the right target: a
//     name the model has lost cannot be pronounced correctly by anyone.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiFrames, paceFrames, silenceFrames, sleep, GROUND_TRUTH } from "./lib/audio.js";
import { SYSTEM_PROMPT, GEMINI_TOOLS } from "./lib/prompt.js";
import { geminiToolResponses } from "./lib/tools.js";
import { emptyUsage, addUsage } from "./lib/geminiUsage.js";
import { reserve, commit, price, spent, CAP_USD } from "./lib/spend.js";
import { errorGuard, writeRaw } from "./lib/stats.js";

const MODEL = "gemini-3.1-flash-live-preview";
const N = 5;
const TURN_TIMEOUT_MS = 20000;
const EST_PER_SESSION = 0.06;

/** The name the caller actually said, from lib/probe/script.js. */
const GROUND_TRUTH_NAME = "Nithin";
const GROUND_TRUTH_LETTERS = "NITHIN";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const LIVE_CONFIG = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  tools: [GEMINI_TOOLS],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

async function openSession() {
  const state = {
    firstAudioAt: null, turnCompleteAt: null,
    inputTranscript: "", outputTranscript: "",
    turnToolCalls: [], usage: emptyUsage(), session: null, error: null, events: [],
  };
  const session = await ai.live.connect({
    model: MODEL,
    config: LIVE_CONFIG,
    callbacks: {
      onmessage: (msg) => {
        const at = Date.now();
        if (msg.setupComplete) state.events.push({ at, t: "setupComplete" });
        if (msg.usageMetadata) addUsage(state.usage, msg.usageMetadata);
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          state.turnToolCalls.push(...calls.map((c) => c.name));
          try { state.session?.sendToolResponse({ functionResponses: geminiToolResponses(calls) }); } catch {}
        }
        const sc = msg.serverContent;
        if (!sc) return;
        if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data) && state.firstAudioAt === null) {
          state.firstAudioAt = at;
        }
        if (sc.inputTranscription?.text) state.inputTranscript += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) state.outputTranscript += sc.outputTranscription.text;
        if (sc.turnComplete) state.turnCompleteAt = at;
      },
      onerror: (e) => { state.error = e?.message || String(e); },
      onclose: () => {},
    },
  });
  state.session = session;
  return { session, state };
}

function sendAudio(session, frame) {
  session.sendRealtimeInput({ audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
}

function armTurn(state) {
  state.firstAudioAt = null; state.turnCompleteAt = null;
  state.outputTranscript = ""; state.turnToolCalls = [];
}

async function waitFor(pred, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return false;
}

/** One audio caller turn, with the trailing silence the vendor VAD needs. */
async function audioTurn(session, state, label) {
  armTurn(state);
  const before = state.inputTranscript;
  await paceFrames(geminiFrames(label).frames, (f) => sendAudio(session, f));
  await paceFrames(silenceFrames("pcm16k", 4000), (f) => sendAudio(session, f), {
    stop: () => state.firstAudioAt !== null,
  });
  await waitFor(() => state.firstAudioAt !== null, TURN_TIMEOUT_MS);
  await waitFor(() => state.turnCompleteAt !== null, TURN_TIMEOUT_MS);
  const heard = state.inputTranscript.slice(before.length).trim();
  return { label, heard, said: state.outputTranscript.trim(), tools: [...state.turnToolCalls] };
}

/** One text caller turn — used only for the read-back request. */
async function textTurn(session, state, text) {
  armTurn(state);
  session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
  await waitFor(() => state.firstAudioAt !== null, TURN_TIMEOUT_MS);
  await waitFor(() => state.turnCompleteAt !== null, TURN_TIMEOUT_MS);
  return { label: "text:readback", heard: text, said: state.outputTranscript.trim() };
}

/**
 * Letters as the model actually spelled them. "N, I, T, H, I, N." and
 * "N-I-T-H-I-N" and "N I T H I N" all normalize to NITHIN.
 *
 * Takes the LONGEST CONTIGUOUS run of single-letter tokens, not every
 * single-letter token in the sentence. The first version of this function did
 * the latter and scored a correct spelling as NITHINI, because "Is there
 * anything else I can help you with" contributes a stray "I" and "should we"
 * a stray "S". That made all 5 trials read as failures when the model had in
 * fact spelled the name correctly every time — the instrument was wrong, not
 * the vendor. Exactly the class of error PLAN.md's cross-check rule exists for.
 */
function spelledLetters(text) {
  const words = String(text).toUpperCase().match(/[A-Z]+/g) || [];
  let best = "", run = "";
  for (const w of words) {
    if (w.length === 1) { run += w; if (run.length > best.length) best = run; }
    else run = "";
  }
  return best;
}

/**
 * One trial: 2 audio turns, a reseed that throws away the audio session, then
 * 3 more turns on the fresh session and the read-back.
 */
async function trial(idx) {
  reserve(`L4 trial ${idx + 1} (pre-reseed)`, EST_PER_SESSION);
  const turnsBefore = [];
  const { session: s1, state: st1 } = await openSession();
  let heardName = "";
  let usage1 = null;
  try {
    await waitFor(() => st1.events.some((e) => e.t === "setupComplete"), 10000);
    turnsBefore.push(await audioTurn(s1, st1, "name_spelling"));
    heardName = turnsBefore[0].heard;
    turnsBefore.push(await audioTurn(s1, st1, "rep_time_q"));
    usage1 = st1.usage;
  } finally {
    try { s1.close(); } catch {}
    await sleep(300);
  }

  // --- THE RESEED (LV2) ---------------------------------------------------
  // The audio session is gone. Everything the new session knows about the
  // caller now travels as text, which is the whole point of the cost fix and
  // the whole risk to the spelling.
  const history = turnsBefore.flatMap((t) => [
    { role: "user", parts: [{ text: t.heard }] },
    { role: "model", parts: [{ text: t.said }] },
  ]);

  reserve(`L4 trial ${idx + 1} (post-reseed)`, EST_PER_SESSION);
  const { session: s2, state: st2 } = await openSession();
  const turnsAfter = [];
  let readback = null;
  let usage2 = null;
  try {
    await waitFor(() => st2.events.some((e) => e.t === "setupComplete"), 10000);
    st2.session.sendClientContent({ turns: history, turnComplete: false });
    await sleep(400);
    turnsAfter.push(await audioTurn(s2, st2, "rep_confirm"));
    turnsAfter.push(await audioTurn(s2, st2, "rep_digits"));
    readback = await textTurn(
      s2, st2,
      "Before we finish, can you read my first name back to me and spell it out letter by letter?"
    );
    usage2 = st2.usage;
  } finally {
    try { s2.close(); } catch {}
    await sleep(300);
  }

  const said = readback?.said || "";
  const letters = spelledLetters(said);
  const row = {
    trial: idx + 1,
    heard_name_pre_reseed: heardName,
    stt_captured_name: heardName.includes(GROUND_TRUTH_NAME),
    reseed_history_chars: JSON.stringify(history).length,
    readback_said: said,
    readback_letters: letters,
    name_exact: said.includes(GROUND_TRUTH_NAME),
    spelling_exact: letters === GROUND_TRUTH_LETTERS,
    pass: said.includes(GROUND_TRUTH_NAME) && letters === GROUND_TRUTH_LETTERS,
    turns_before: turnsBefore,
    turns_after: turnsAfter,
  };

  const u1 = usage1 || emptyUsage(), u2 = usage2 || emptyUsage();
  const c1 = price(MODEL, u1), c2 = price(MODEL, u2);
  commit({ probe: "L4", arm: "pre-reseed", run: idx + 1, model: MODEL, usage: u1, usd: c1.usd });
  commit({ probe: "L4", arm: "post-reseed", run: idx + 1, model: MODEL, usage: u2, usd: c2.usd });
  return { ...row, usage_pre: u1, usage_post: u2, usd: c1.usd + c2.usd };
}


async function main() {
  console.log(`L4 — Gemini text-reseed name fidelity  ${MODEL}`);
  console.log(`ground truth "${GROUND_TRUTH_NAME}" — fixture: ${GROUND_TRUTH.name_spelling}`);
  console.log(`spent so far $${spent().toFixed(4)} / $${CAP_USD.toFixed(2)}\n`);

  const guard = errorGuard(3);
  const trials = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await trial(i);
      guard.ok();
      trials.push(r);
      console.log(
        `  trial ${i + 1}: stt_heard="${r.heard_name_pre_reseed.slice(0, 46)}" ` +
        `readback_letters=${r.readback_letters || "-"} name_exact=${r.name_exact} ` +
        `spelling_exact=${r.spelling_exact} -> ${r.pass ? "PASS" : "FAIL"}  $${r.usd.toFixed(4)}`
      );
    } catch (err) {
      if (err.name === "BudgetExceeded" || err.name === "SocketErrorStreak") throw err;
      console.log(`  trial ${i + 1}: FAILED — ${err.message?.slice(0, 140)}`);
      trials.push({ trial: i + 1, error: err.message, pass: false });
      guard.fail(err);
    }
  }

  const passes = trials.filter((t) => t.pass).length;
  const sttCaptured = trials.filter((t) => t.stt_captured_name).length;
  const summary = {
    probe: "L4", model: MODEL, n: N,
    ground_truth: GROUND_TRUTH_NAME,
    exact_match_count: passes,
    name_exact_count: trials.filter((t) => t.name_exact).length,
    spelling_exact_count: trials.filter((t) => t.spelling_exact).length,
    stt_captured_name_count: sttCaptured,
    usd: trials.reduce((s, t) => s + (t.usd || 0), 0),
  };
  writeRaw("l4-gemini-reseed", { summary, trials });
  console.log(`\n  exact match ${passes}/${N}   (vendor STT captured the name pre-reseed in ${sttCaptured}/${N})`);
  console.log(`  L4 cost $${summary.usd.toFixed(4)} — running total $${spent().toFixed(4)}`);
}

main().catch((e) => { console.error(`L4 ABORTED: ${e.message}`); process.exit(1); });
