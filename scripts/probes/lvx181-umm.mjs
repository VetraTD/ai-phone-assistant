// ---------------------------------------------------------------------------
// LVX181 -- does gemini-3.8-live start talking when the caller says "ummm"
// right after the receptionist asked a question, and does a VAD patience
// setting or a prompt line stop that without slowing normal replies?
//
// PAID. Opens real Live sessions against the Gemini API (AI Studio). Owner
// authorised $0.80 hard cap for LVX181 only, 2026-10-16 (lib/spendLive.js,
// reserveLVX181). Do not run without that authorisation.
//
//   node scripts/probes/lvx181-umm.mjs --dry     NO network, no spend: prints
//                                                fixtures, arms, worst-case $,
//                                                the rendered prompt tail, config
//   node scripts/probes/lvx181-umm.mjs --smoke   1 umm + 1 complete, default arm
//   node scripts/probes/lvx181-umm.mjs           full run (60 sessions)
//   ... --arms default,sil1200                   restrict arms
//
// ---------------------------------------------------------------------------
// WEAKER INSTRUMENT, stated up front: the "ummm" is SYNTHETIC (Windows SAPI,
// Microsoft David, rate -10, see lvx181-make-fixtures.mjs), not a person
// hesitating. It is voiced and about 1.3 s long but has no breath, no creak
// and no falling-pitch hesitation contour. If the model ignores it, that does
// NOT prove it would ignore a real one. A model that answers it is a finding.
// ---------------------------------------------------------------------------
//
// SAME SETUP AS PRODUCTION (lib/voice/live/index.js ~9010-9050):
//   - session config = responseModalities [AUDIO], systemInstruction from the
//     real buildSystemInstruction(IDENTIFY_INTENT, ...), inputAudioTranscription
//     {}, outputAudioTranscription {}, tools from the real buildLiveTools()
//     (BLOCKING behaviour, as production defaults), speechConfig Kore + en-US,
//     plus createVendorAd({silenceDurationMs}).connectConfig() for the VAD arms.
//   - model gemini-3.8-live on the AI Studio surface (see DEVIATIONS).
//
// DEVIATIONS from production that could not be avoided -- also printed by --dry:
//   1. Business config is the Acme Dental test fixture (US, America/Chicago,
//      book_appointment + cancel_reschedule), not a real tenant row.
//   2. History is seeded with sendClientContent text turns (greeting, request,
//      the Tuesday question). Production's history is spoken audio.
//   3. The prompt is built with greetingSpoken:false as production does at
//      open, yet the seeded history contains a greeting.
//   4. Tool calls are answered by the probe's canned instant stub
//      (lib/tools.js), not the real tool runner.
//   5. Production model id comes from the LIVE_MODEL env on Cloud Run
//      (code default is gemini-3.1-flash-live-preview). This probe pins
//      gemini-3.8-live as instructed; override with LVX181_MODEL.
//   6. The caller audio is 16 kHz PCM16 into the API, as production sends
//      after its own mulaw->PCM16 conversion; the fixtures are 8 kHz mulaw
//      upsampled by lib/audio.js (linear), the same path every other probe uses.
//
// MEASUREMENTS (all audio-energy based; the output transcript lags audio by
// 2.6-3.0 s and is only logged):
//   REPLY = model output SPEECH: a run of >= 300 ms above an RMS floor in the
//   24 kHz output PCM, timed against a playout clock (chunks can arrive faster
//   than real time, so a chunk's samples are placed after the previous chunk's
//   playout end, never before their own arrival).
//   umm take: reply counts if it starts between umm start and umm end + 4000 ms.
//   complete take: DELAY = first speech start - the fixture's energy-based
//   speech end (negative = talked over the caller).
//   INVALID: the model made any audio before the caller audio started, the
//   session failed to set up, or errored.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Modality } from "@google/genai";
import { openSession, sendAudio, waitForQuiet, setupOk, waitFor, sleep } from "./lib/geminiSession.js";
import { loadUlaw, ulawToPcm16k, frames, FRAME_BYTES, paceFrames, silenceFrames } from "./lib/audio.js";
import {
  CAP_USD, BudgetExceeded, RATES, commit, priceTokens, priceGeminiByMinutes, reserveLVX181,
  lvx181Spent, LVX181_CAP_USD, LVX181_PREFIX, spent as ledgerSpent,
} from "./lib/spendLive.js";
import { decodeMulaw } from "../../lib/voice/mulaw.js";
import { FIXTURES } from "../../tests/fixtures/businessConfigs.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { buildLiveTools } from "../../lib/voice/live/tools.js";
import { createVendorAd } from "../../lib/voice/live/turnEnd/vendorAd.js";
import { STEPS } from "../../lib/callState.js";

// ----------------------------------------------------------------- settings
const MODEL = process.env.LVX181_MODEL || "gemini-3.8-live";
const SURFACE = "aistudio";
const VOICE = "Kore";                 // production default (VOICE_BY_LANGUAGE en-US)
const LANGUAGE_CODE = "en-US";
const FIXTURE_NAME = "appointments-db"; // Acme Dental, America/Chicago

const N_UMM = 10;
const N_COMPLETE = 5;
const SETTLE_MS = 1500;               // quiet window after seeding, before the caller speaks
const UMM_TAIL_MS = 4000;             // silence after the umm; also the reply window beyond umm end
const COMPLETE_TAIL_MS = 6000;
const TRANSCRIPT_WAIT_MS = 2500;      // complete takes: keep the line open after speech starts, for the log
const MIN_RUN_MS = 300;
const RMS_FLOOR = 500;                // int16 scale, 20 ms frames, same order as gptlive.js outputSpeechRuns
const HANGOVER_MS = 240;
const TAKE_WATCHDOG_MS = 45_000;

const PROMPT_LINE = "After you ask a question, a lone um or uh is the caller thinking -- say nothing and wait.";
const ARMS = {
  default: { silenceDurationMs: undefined, promptLine: false },
  sil1000: { silenceDurationMs: 1000, promptLine: false },
  sil1200: { silenceDurationMs: 1200, promptLine: false },
  prompt: { silenceDurationMs: undefined, promptLine: true },
};

const UMM_FIXTURE = "lvx181_umm";
const COMPLETE_FIXTURE = "lvx181_ten_works";

const HISTORY = [
  { role: "user", parts: [{ text: "Hello?" }] },
  { role: "model", parts: [{ text: "Thanks for calling Acme Dental. How can I help you today?" }] },
  { role: "user", parts: [{ text: "Hi, I'd like to book an appointment on Tuesday." }] },
  { role: "model", parts: [{ text: "I have 9 a.m., 1 p.m., or 4:30 p.m. on Tuesday. Which works best?" }] },
];

const RESULTS_FILE = path.resolve("scripts/probes/results-lvx181.json");
const SMOKE_FILE = path.resolve("scripts/probes/results-lvx181-smoke.json");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DRY = flag("--dry");
const SMOKE = flag("--smoke");
const ARM_NAMES = (argVal("--arms") ? argVal("--arms").split(",").map((s) => s.trim()) : Object.keys(ARMS));
for (const a of ARM_NAMES) if (!ARMS[a]) { console.error(`unknown arm ${a}; have ${Object.keys(ARMS)}`); process.exit(2); }

// ------------------------------------------------------- production setup
/** Render the real production system instruction (+ optional extra static rule). */
export function renderInstruction({ promptLine }) {
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
  let text = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, fx.config, extras);
  if (promptLine) {
    // Where production's static rules sit: the end of the NON-NEGOTIABLE RULES
    // block, as the next numbered rule.
    const head = text.indexOf("=== NON-NEGOTIABLE RULES ===");
    if (head < 0) throw new Error("NON-NEGOTIABLE RULES section not found; cannot place the prompt line");
    const next = text.indexOf("\n\n===", head + 10);
    const block = text.slice(head, next < 0 ? text.length : next);
    const nums = [...block.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    text = text.slice(0, head) + block + `\n${n}. ${PROMPT_LINE}` + (next < 0 ? "" : text.slice(next));
  }
  return { text, config: fx.config, extras };
}

function sessionOptions(armName) {
  const arm = ARMS[armName];
  const { text, config, extras } = renderInstruction({ promptLine: arm.promptLine });
  const vad = createVendorAd({ silenceDurationMs: arm.silenceDurationMs }).connectConfig();
  return {
    surface: SURFACE,
    model: MODEL,
    answerTools: true,
    capturePcm: true,
    systemInstruction: text,
    tools: buildLiveTools(config, extras, {}), // env {} => production default BLOCKING
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } }, languageCode: LANGUAGE_CODE },
    extraConfig: vad,
    _vad: vad,
    _text: text,
  };
}

// ------------------------------------------------------------- fixtures
function pcmFramesOf(label) {
  const fx = loadUlaw(label);
  const pcm = ulawToPcm16k(fx.ulaw);
  const fr = frames(pcm, FRAME_BYTES.pcm16k).map((f) => (f.length === FRAME_BYTES.pcm16k ? f : Buffer.concat([f, Buffer.alloc(FRAME_BYTES.pcm16k - f.length)])));
  return { ...fx, frames: fr };
}

/** Energy-based voiced extent of a mulaw fixture, in ms from its start. */
function voicedExtent(ulaw) {
  const pcm = decodeMulaw(ulaw);
  const rms = [];
  for (let i = 0; i + 160 <= pcm.length; i += 160) {
    let s = 0;
    for (let j = 0; j < 160; j++) s += pcm[i + j] ** 2;
    rms.push(Math.sqrt(s / 160));
  }
  const peak = Math.max(...rms);
  const thr = Math.max(300, peak * 0.1);
  const first = rms.findIndex((r) => r > thr);
  const last = rms.length - 1 - [...rms].reverse().findIndex((r) => r > thr);
  return { startMs: first * 20, endMs: (last + 1) * 20, voicedMs: (last + 1 - first) * 20, fileMs: (pcm.length / 8) | 0 };
}

// ----------------------------------------------- output speech detection
/**
 * Streaming speech-run detector over the model's 24 kHz PCM16 output, on a
 * playout clock. Offsets are returned in absolute wall-clock ms.
 */
function createSpeechDetector() {
  let queueEndMs = 0;      // when already-received audio finishes playing
  let carry = new Int16Array(0);
  let carryStartMs = 0;
  let cur = null;          // {startMs, lastLoudMs}
  let quiet = 0;
  const runs = [];
  const FR = 480;          // 20 ms @ 24 kHz
  let processed = 0;

  function frame(samples, tMs) {
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] ** 2;
    const rms = Math.sqrt(s / samples.length);
    if (rms > RMS_FLOOR) {
      if (!cur) cur = { startMs: tMs, lastLoudMs: tMs };
      cur.lastLoudMs = tMs;
      quiet = 0;
    } else if (cur) {
      quiet += 20;
      if (quiet >= HANGOVER_MS) { runs.push({ ...cur, ms: cur.lastLoudMs - cur.startMs + 20 }); cur = null; quiet = 0; }
    }
  }

  function feed(at, pcmBuf) {
    const n = pcmBuf.length >> 1;
    const samples = new Int16Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + n * 2));
    let startMs;
    if (carry.length && at <= queueEndMs) {
      startMs = carryStartMs; // contiguous with queued audio
    } else {
      carry = new Int16Array(0);
      startMs = Math.max(at, queueEndMs);
      carryStartMs = startMs;
    }
    queueEndMs = startMs + (carry.length + n) / 24;
    const all = new Int16Array(carry.length + n);
    all.set(carry); all.set(samples, carry.length);
    let off = 0;
    while (off + FR <= all.length) { frame(all.subarray(off, off + FR), startMs + off / 24); off += FR; }
    carry = all.slice(off);
    carryStartMs = startMs + off / 24;
  }

  return {
    poll(state) {
      const chunks = state.pcmChunks;
      for (; processed < chunks.length; processed++) feed(chunks[processed].at, chunks[processed].pcm);
    },
    /** Earliest qualifying run (>= MIN_RUN_MS), counting an open run once long enough. */
    first() {
      const all = cur ? [...runs, { ...cur, ms: cur.lastLoudMs - cur.startMs + 20 }] : runs;
      return all.find((r) => r.ms >= MIN_RUN_MS) || null;
    },
  };
}

// ------------------------------------------------------------ cost control
let PROMPT_TOK_EST = null; // set in main from the rendered prompt + tools
const estTok = (chars) => Math.ceil(chars / 3.2); // deliberately high

function promptTokensFor(opts) {
  return estTok(opts._text.length + JSON.stringify(opts.tools).length + JSON.stringify(HISTORY).length);
}

/** Priced on the RATES card, uncached, 2 billed turns of full context + audio. */
function worstCaseUsd(promptTok, kind) {
  const r = RATES[MODEL] || RATES["gemini-3.8-live"];
  const inSec = kind === "umm" ? 1.5 + UMM_TAIL_MS / 1000 + SETTLE_MS / 1000 : 0.6 + COMPLETE_TAIL_MS / 1000 + SETTLE_MS / 1000;
  const outSec = kind === "umm" ? 12 : 15;   // we close early; allow a long burst anyway
  const AUDIO_TOK_PER_S = 25;
  return (
    (2 * promptTok / 1e6) * r.text_in +
    (inSec * AUDIO_TOK_PER_S / 1e6) * r.audio_in +
    (outSec * AUDIO_TOK_PER_S / 1e6) * r.audio_out +
    (300 / 1e6) * r.text_out
  );
}

function priceSession(ctx, promptTok, inSec) {
  const u = ctx?.state?.usage;
  const outSec = (ctx?.state?.audioBytes || 0) / (24000 * 2);
  if (u && u.turns_billed > 0) {
    const p = priceTokens(MODEL, u);
    if (p.usd > 0) return { usd: p.usd, estimated: false, usage: u };
  }
  // No usageMetadata (we close before the turn completes, or there was no
  // generation). Charge ONE full-context turn as a conservative estimate --
  // recording zero would understate the bill.
  const r = RATES[MODEL];
  const usd = (promptTok / 1e6) * r.text_in + ((inSec * 25) / 1e6) * r.audio_in + ((outSec * 25) / 1e6) * r.audio_out;
  return { usd, estimated: true, usage: u || null };
}

// ----------------------------------------------------------------- takes
async function runTake({ arm, kind, take, fixtures, resultsRow }) {
  const label = `${LVX181_PREFIX}-${arm}-${kind}-${take}`;
  const opts = sessionOptions(arm);
  const promptTok = promptTokensFor(opts);
  reserveLVX181(label, worstCaseUsd(promptTok, kind));

  const row = { key: `${arm}|${kind}|${take}`, arm, kind, take, at: new Date().toISOString(), valid: true };
  const fx = kind === "umm" ? fixtures.umm : fixtures.complete;
  const tailMs = kind === "umm" ? UMM_TAIL_MS : COMPLETE_TAIL_MS;
  let ctx = null;
  const tOpen = Date.now();
  let callerAudioSec = 0;
  const watchdog = { timer: null };

  try {
    ctx = await openSession(opts);
    watchdog.timer = setTimeout(() => { try { ctx.session.close(); } catch {} }, TAKE_WATCHDOG_MS);
    const st = ctx.state;
    if (!(await setupOk(st))) { row.valid = false; row.invalid_reason = "no setupComplete"; return row; }

    // Seed history; turnComplete:false so the model does not speak first.
    ctx.session.sendClientContent({ turns: HISTORY, turnComplete: false });

    // Settle with a live line (silence frames), as a phone does.
    await paceFrames(silenceFrames("pcm16k", SETTLE_MS), (f) => sendAudio(ctx.session, f));
    if (st.audioChunks > 0) {
      await waitForQuiet(st, { quietMs: 800, maxMs: 15000 });
      row.valid = false;
      row.invalid_reason = "model spoke before caller audio";
      row.pre_speech_chunks = st.audioChunks;
      return row;
    }

    const det = createSpeechDetector();
    const t0 = Date.now();
    row.speech_end_ms = fx.extent.endMs;
    let found = null;
    let foundAt = 0;
    const poll = () => {
      det.poll(st);
      if (!found) { const r = det.first(); if (r) { found = r; foundAt = Date.now(); } }
    };

    // Caller speaks the fixture, then the line keeps streaming silence.
    const send = (f) => sendAudio(ctx.session, f);
    const speech = await paceFrames(fx.frames, send, { onFrame: poll });
    const silenceMs = tailMs;
    const tail = silenceFrames("pcm16k", silenceMs);
    await paceFrames(tail, send, {
      onFrame: poll,
      stop: () => {
        if (!found) return false;
        if (kind === "umm") return true;                       // reply seen; nothing more to learn
        return Date.now() - foundAt >= TRANSCRIPT_WAIT_MS;     // keep the line open for the log
      },
    });
    poll();
    callerAudioSec = (Date.now() - t0) / 1000;
    row.caller_audio_sent_ms = Date.now() - t0;
    row.fixture_pace_ms = speech.elapsedMs;

    if (found) {
      row.reply_start_ms = Math.round(found.startMs - t0);
      row.reply_run_ms = found.ms;
    }
    row.output_transcript = (st.outputTranscript || "").trim().slice(0, 300);
    row.input_transcript = (st.inputTranscript || "").trim().slice(0, 200);
    row.tool_calls = [...st.turnToolCalls];

    if (kind === "umm") {
      const windowEnd = fx.extent.fileMs + UMM_TAIL_MS;
      if (found && found.startMs - t0 < 0) { row.valid = false; row.invalid_reason = "speech before caller audio"; }
      row.replied = Boolean(found) && row.reply_start_ms >= 0 && row.reply_start_ms <= windowEnd;
      row.replied_during_umm = row.replied && row.reply_start_ms <= fx.extent.endMs;
    } else {
      row.replied = Boolean(found);
      row.delay_ms = found ? row.reply_start_ms - fx.extent.endMs : null;
    }
    return row;
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err;
    row.valid = false;
    row.invalid_reason = `error: ${(err.message || String(err)).slice(0, 160)}`;
    return row;
  } finally {
    clearTimeout(watchdog.timer);
    try { ctx?.session?.close?.(); } catch {}
    if (ctx) {
      await sleep(150);
      const wall = (Date.now() - tOpen) / 1000;
      const priced = priceSession(ctx, promptTok, callerAudioSec || SETTLE_MS / 1000);
      row.usd = Number(priced.usd.toFixed(5));
      row.usd_estimated = priced.estimated;
      row.wall_s = Number(wall.toFixed(1));
      commit({ probe: `${LVX181_PREFIX}-${arm}`, arm, label, model: MODEL, usd: priced.usd, estimated: priced.estimated });
    }
  }
}

// ---------------------------------------------------------------- report
const median = (v) => {
  const s = v.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const RULE =
  "Instrument check: default must reply to the umm in >= 3/10, else the probe is BLIND and nothing changes. " +
  "An arm qualifies only if it cuts umm-replies by >= 3 (of 10) vs default AND its complete-answer median delay is <= default median + 150 ms. " +
  "Among qualifying arms, fewest umm-replies wins; tie -> lower median delay. No qualifying arm -> change nothing.";

function report(rows, armNames) {
  const per = {};
  for (const a of armNames) {
    const mine = rows.filter((r) => r.arm === a);
    const umm = mine.filter((r) => r.kind === "umm");
    const com = mine.filter((r) => r.kind === "complete");
    const ummValid = umm.filter((r) => r.valid);
    const comValid = com.filter((r) => r.valid);
    per[a] = {
      umm_valid: ummValid.length,
      umm_replies: ummValid.filter((r) => r.replied).length,
      umm_replies_during_umm: ummValid.filter((r) => r.replied_during_umm).length,
      complete_delays: comValid.map((r) => r.delay_ms),
      complete_no_reply: comValid.filter((r) => !r.replied).length,
      complete_median: median(comValid.map((r) => r.delay_ms)),
      invalid: mine.filter((r) => !r.valid).map((r) => `${r.kind}#${r.take}: ${r.invalid_reason}`),
      usd: Number(mine.reduce((s, r) => s + (r.usd || 0), 0).toFixed(4)),
    };
  }
  console.log("\n=== LVX181 results ===");
  for (const a of armNames) {
    const p = per[a];
    console.log(
      `${a.padEnd(8)} umm replies ${p.umm_replies}/${p.umm_valid} valid (${p.umm_replies_during_umm} began during the umm)  ` +
      `complete median ${p.complete_median ?? "n/a"} ms  delays [${p.complete_delays.map((d) => d ?? "none").join(", ")}]  ` +
      `no-reply ${p.complete_no_reply}  invalid ${p.invalid.length}  $${p.usd.toFixed(4)}`
    );
    for (const i of p.invalid) console.log(`           INVALID ${i}`);
  }
  console.log(`LVX181 total $${lvx181Spent().toFixed(4)} of $${LVX181_CAP_USD.toFixed(2)}; ledger $${ledgerSpent().toFixed(4)} of $${CAP_USD}`);
  console.log(`\nPRE-REGISTERED RULE:\n${RULE}\n`);

  const d = per.default;
  if (!d) { console.log("VERDICT: default arm not run; the rule cannot be applied."); return; }
  if (d.umm_valid < N_UMM) console.log(`NOTE: default has only ${d.umm_valid}/${N_UMM} valid umm takes; the rule's thresholds are absolute counts and are applied to the raw count.`);
  if (d.umm_replies < 3) {
    console.log(`VERDICT: BLIND. default replied to the umm ${d.umm_replies} time(s) (< 3). Nothing changes.`);
    return;
  }
  const qual = [];
  for (const a of armNames) {
    if (a === "default") continue;
    const p = per[a];
    const cut = d.umm_replies - p.umm_replies;
    const delayOk = p.complete_median != null && d.complete_median != null && p.complete_median <= d.complete_median + 150;
    console.log(`  ${a}: cut ${cut} (need >= 3), median ${p.complete_median} vs default ${d.complete_median} + 150 -> ${cut >= 3 && delayOk ? "QUALIFIES" : "does not qualify"}${p.complete_median == null || d.complete_median == null ? " (median missing)" : ""}`);
    if (cut >= 3 && delayOk) qual.push(a);
  }
  if (!qual.length) { console.log("VERDICT: no qualifying arm. Change nothing."); return; }
  qual.sort((x, y) => per[x].umm_replies - per[y].umm_replies || per[x].complete_median - per[y].complete_median);
  console.log(`VERDICT: the rule picks "${qual[0]}" (qualifying: ${qual.join(", ")}).`);
}

// ------------------------------------------------------------------ main
function loadFixtures() {
  const u = pcmFramesOf(UMM_FIXTURE);
  const c = pcmFramesOf(COMPLETE_FIXTURE);
  return { umm: { ...u, extent: voicedExtent(u.ulaw) }, complete: { ...c, extent: voicedExtent(c.ulaw) } };
}

function dry(fixtures) {
  console.log("LVX181 dry run -- NO network, NO spend\n");
  for (const [k, f] of Object.entries(fixtures)) {
    console.log(`fixture ${k}: ${f.label}.ulaw  file ${f.extent.fileMs} ms  voiced ${f.extent.startMs}..${f.extent.endMs} ms (${f.extent.voicedMs} ms voiced)  frames ${f.frames.length} x 20 ms`);
  }
  console.log(`\nmodel ${MODEL}  surface ${SURFACE}  voice ${VOICE}  language ${LANGUAGE_CODE}  modality AUDIO  business fixture ${FIXTURE_NAME}`);
  console.log(`seeded history (sendClientContent, turnComplete:false): ${HISTORY.length} turns, last = ${JSON.stringify(HISTORY.at(-1).parts[0].text)}`);
  console.log(`takes: ${N_UMM} umm + ${N_COMPLETE} complete per arm; arms: ${ARM_NAMES.join(", ")}`);
  console.log(`umm take: ${fixtures.umm.extent.fileMs} ms audio + ${UMM_TAIL_MS} ms silence; reply window 0..${fixtures.umm.extent.fileMs + UMM_TAIL_MS} ms`);
  console.log(`complete take: ${fixtures.complete.extent.fileMs} ms audio + up to ${COMPLETE_TAIL_MS} ms silence; delay vs speech end ${fixtures.complete.extent.endMs} ms\n`);

  let total = 0;
  for (const a of ARM_NAMES) {
    const o = sessionOptions(a);
    const tok = promptTokensFor(o);
    const wu = worstCaseUsd(tok, "umm"), wc = worstCaseUsd(tok, "complete");
    const armTotal = wu * N_UMM + wc * N_COMPLETE;
    total += armTotal;
    const lines = o._text.split("\n");
    console.log(`--- arm ${a}: vad config ${JSON.stringify(o._vad)}  prompt line ${ARMS[a].promptLine ? "YES" : "no"}`);
    console.log(`    system instruction ${o._text.length} chars (~${tok} tokens incl. tools+history est), ${lines.length} lines; tools ${o.tools[0].functionDeclarations.length} declarations, behavior ${o.tools[0].functionDeclarations[0]?.behavior ?? "none"}`);
    console.log(`    worst case/session: umm $${wu.toFixed(4)}, complete $${wc.toFixed(4)}; arm worst case $${armTotal.toFixed(3)}`);
    if (a === ARM_NAMES[0] || ARMS[a].promptLine) {
      console.log("    last 5 lines of the instruction:");
      for (const l of lines.slice(-5)) console.log(`      | ${l.slice(0, 160)}${l.length > 160 ? "..." : ""}`);
    }
    if (ARMS[a].promptLine) {
      const i = o._text.indexOf(PROMPT_LINE);
      console.log(`    prompt line placed at char ${i}: ...${JSON.stringify(o._text.slice(Math.max(0, i - 60), i + PROMPT_LINE.length))}`);
    }
  }
  console.log(`\nWORST-CASE TOTAL (all arms, uncached, 2 billed turns/session): $${total.toFixed(3)}  vs LVX181 cap $${LVX181_CAP_USD.toFixed(2)}  (per-session reserve is checked live against the cap)`);
  const oneTurn = (promptTokensFor(sessionOptions("default")) / 1e6) * RATES[MODEL].text_in;
  console.log(`expected (1 uncached turn/session): ~$${(oneTurn * 60).toFixed(2)} for 60 sessions`);
  console.log(`ledger now $${ledgerSpent().toFixed(4)} of $${CAP_USD}; LVX181 spent so far $${lvx181Spent().toFixed(4)}`);
  console.log("\nSession config keys that would be sent:", Object.keys({ responseModalities: 1, systemInstruction: 1, tools: 1, inputAudioTranscription: 1, outputAudioTranscription: 1, speechConfig: 1, ...sessionOptions("sil1200").extraConfig }).join(", "));
  console.log("sil1200 extra config:", JSON.stringify(sessionOptions("sil1200").extraConfig));
}

async function main() {
  const fixtures = loadFixtures();
  if (DRY) { dry(fixtures); return; }
  if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(2); }

  const file = SMOKE ? SMOKE_FILE : RESULTS_FILE;
  let out = { meta: {}, rows: [] };
  try { out = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  out.meta = { model: MODEL, surface: SURFACE, voice: VOICE, language: LANGUAGE_CODE, started_at: out.meta?.started_at || new Date().toISOString(), rule: RULE, smoke: SMOKE };
  const done = new Set(out.rows.map((r) => r.key));
  const save = () => fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  // Round-robin: round i runs every arm's umm take i (and complete take i while i <= N_COMPLETE).
  const nU = SMOKE ? 1 : N_UMM, nC = SMOKE ? 1 : N_COMPLETE;
  const arms = SMOKE ? ["default"] : ARM_NAMES;
  const plan = [];
  for (let i = 1; i <= nU; i++) {
    for (const arm of arms) {
      plan.push({ arm, kind: "umm", take: i });
      if (i <= nC) plan.push({ arm, kind: "complete", take: i });
    }
  }

  console.log(`LVX181 ${SMOKE ? "SMOKE" : "full"} run, ${plan.length} sessions planned, ${plan.filter((p) => done.has(`${p.arm}|${p.kind}|${p.take}`)).length} already recorded`);
  let stopped = null;
  for (const p of plan) {
    const key = `${p.arm}|${p.kind}|${p.take}`;
    if (done.has(key)) continue;
    try {
      const row = await runTake({ ...p, fixtures });
      out.rows.push(row);
      save();
      const desc = row.valid
        ? (p.kind === "umm" ? (row.replied ? `REPLIED at ${row.reply_start_ms} ms` : "silent") : (row.replied ? `delay ${row.delay_ms} ms` : "no reply"))
        : `INVALID (${row.invalid_reason})`;
      console.log(`  ${key.padEnd(22)} ${desc}  $${row.usd}${row.usd_estimated ? "~" : ""}${row.output_transcript ? `  said: ${JSON.stringify(row.output_transcript.slice(0, 70))}` : ""}`);
    } catch (e) {
      if (e instanceof BudgetExceeded) { stopped = e.message; console.error(`\n${e.message}`); break; }
      throw e;
    }
  }
  report(out.rows, SMOKE ? ["default"] : ARM_NAMES);
  if (stopped) console.log(`\nSTOPPED EARLY: ${stopped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
