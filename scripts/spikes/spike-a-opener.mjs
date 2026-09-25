#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SPIKE A -- outbound Part 1, spec section 9.3 and decision D6. THROWAWAY.
//
// Two questions, both of which can change the spec before anything is built:
//
//   1. VOICE. The opener is pre-rendered by services/googleTts.js while the
//      phone rings, in the Chirp 3 HD voice that matches the tenant's Live
//      voice. Which British voice? The owner picks by ear from WAVs this writes.
//
//   2. SEEDING. Can the pre-rendered opener be handed to Gemini Live as the
//      model's OWN first turn, so Live does not speak again and carries on
//      naturally from the caller's reply? Or must Live speak the opener itself
//      (the fallback, which makes G2's 2-second rule monitored, not guaranteed)?
//
// The seeding arms (N per arm, default 3):
//   S1  one role:"model" turn holding the opener, turnComplete:false
//   S2  a role:"user" "(call connected)" turn, then the model turn, turnComplete:false
//   F   the inbound mechanism: opener as the system prompt's first words + a
//       user kick turn (lib/voice/live/index.js ~5534) -- the fallback
//
// PRE-REGISTERED RULE (written before any run): the seeded path is GO if one
// seeding shape shows, across its N runs, 0 spontaneous speech before the
// caller speaks, 0 re-introductions, N/N coherent continuations and no API
// error. Otherwise the fallback. The VOICE match is judged by the owner, never
// by this script.
//
// Spend: every paid call reserves against the Part 1 cap first
// (scripts/probes/lib/spendLive.js reserveP1, label P1-SPIKE-A) and commits
// after, including failed sessions.
//
// Usage (run from the repo root, Norton needs the CA bundle):
//   NODE_EXTRA_CA_CERTS=... node scripts/spikes/spike-a-opener.mjs --phase voices --out <dir>
//   NODE_EXTRA_CA_CERTS=... node scripts/spikes/spike-a-opener.mjs --phase seed --out <dir> [--n 3]
// Needs GOOGLE_TTS_API_KEY and GEMINI_API_KEY in .env (LIVE_SURFACE=aistudio,
// the same surface production uses).
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { synthesizeMulaw } from "../../services/googleTts.js";
import { decodeMulaw } from "../../lib/voice/mulaw.js";
import { ulawToPcm16k, frames, FRAME_BYTES, paceFrames, silenceFrames } from "../probes/lib/audio.js";
import { emptyUsage, addUsage } from "../probes/lib/geminiUsage.js";
import { commit, priceTokens, priceGeminiByMinutes, reserveP1, p1Spent } from "../probes/lib/spendLive.js";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PHASE = arg("phase", "");
const OUT = arg("out", "");
const N = Math.max(1, Math.min(5, parseInt(arg("n", "3"), 10) || 3));
const MODEL = process.env.LIVE_MODEL || "gemini-3.8-live";
const LIVE_VOICE = arg("live-voice", "Kore");
const PROBE = "P1-SPIKE-A";

if (!["voices", "seed"].includes(PHASE) || !OUT) {
  console.error("usage: --phase voices|seed --out <dir> [--n 3] [--live-voice Kore]");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// The spec's demo opener (section 7 template, Digile demo persona D6).
const OPENER =
  "Hi, is that Sam? It's Ava, an AI assistant calling from Digile Media. " +
  "You just asked about our clinic systems. Have you got two minutes?";
const CALLER_REPLY = "Yes, speaking. Yeah, go on then.";
const VOICES = ["Kore", "Aoede", "Leda"];
const CALLER_VOICE = "en-GB-Chirp3-HD-Charon";
// Chirp 3 HD list price per character. Priced conservatively (no free tier
// assumed) and marked estimated.
const TTS_USD_PER_CHAR = 30 / 1e6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// WAV helpers. PCM16 mono, so any player opens it.
// ---------------------------------------------------------------------------
function wavPcm16(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const ulawToPcm8k = (ulaw) => Int16Array.from(decodeMulaw(ulaw));
function pcm24kTo8k(buf) {
  const src = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const out = new Int16Array(Math.floor(src.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = Math.round((src[i * 3] + src[i * 3 + 1] + src[i * 3 + 2]) / 3);
  return out;
}
const silence8k = (ms) => new Int16Array(Math.round((ms / 1000) * 8000));
function concat16(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// PHASE voices: three opener samples + the scripted caller's reply.
// ---------------------------------------------------------------------------
async function phaseVoices() {
  const tts = new TextToSpeechClient({ apiKey: process.env.GOOGLE_TTS_API_KEY });
  const [list] = await tts.listVoices({ languageCode: "en-GB" });
  const chirp = (list.voices || []).map((v) => v.name).filter((n) => /Chirp3-HD/.test(n)).sort();
  const wanted = [...VOICES.map((v) => `en-GB-Chirp3-HD-${v}`), CALLER_VOICE];
  const missing = wanted.filter((w) => !chirp.includes(w));
  console.log(`en-GB Chirp3-HD voices available: ${chirp.length}`);
  if (missing.length) {
    console.error(`MISSING voices: ${missing.join(", ")} -- stopping before any spend.`);
    process.exit(2);
  }

  const chars = OPENER.length * VOICES.length + CALLER_REPLY.length;
  const worst = chars * TTS_USD_PER_CHAR;
  const budget = reserveP1(PROBE, worst);
  console.log(`reserve ok: worst case $${worst.toFixed(4)} (${chars} chars); Part 1 remaining $${budget.p1Remaining.toFixed(4)}`);

  const rows = [];
  let billedChars = 0;
  try {
    for (const v of VOICES) {
      const name = `en-GB-Chirp3-HD-${v}`;
      const t0 = Date.now();
      const ulaw = await synthesizeMulaw(OPENER, name, null, { bypassCache: true });
      billedChars += OPENER.length;
      const ms = Date.now() - t0;
      fs.writeFileSync(path.join(OUT, `opener-${v}.ulaw`), ulaw);
      fs.writeFileSync(path.join(OUT, `opener-${v}.wav`), wavPcm16(ulawToPcm8k(ulaw), 8000));
      rows.push({ voice: name, synth_ms: ms, audio_s: Number((ulaw.length / 8000).toFixed(2)) });
      console.log(`  ${name}: ${ms} ms to synthesise, ${(ulaw.length / 8000).toFixed(2)} s of audio`);
    }
    const callerUlaw = await synthesizeMulaw(CALLER_REPLY, CALLER_VOICE, null, { bypassCache: true });
    billedChars += CALLER_REPLY.length;
    fs.writeFileSync(path.join(OUT, "caller-reply.ulaw"), callerUlaw);
    fs.writeFileSync(path.join(OUT, "caller-reply.wav"), wavPcm16(ulawToPcm8k(callerUlaw), 8000));
  } finally {
    const usd = billedChars * TTS_USD_PER_CHAR;
    commit({ probe: PROBE, arm: "tts", label: "voices", model: "chirp3-hd", chars: billedChars, usd, estimated: true });
    console.log(`committed $${usd.toFixed(5)} (${billedChars} chars). Part 1 spent: $${p1Spent().toFixed(4)}`);
  }
  fs.writeFileSync(path.join(OUT, "voices.json"), JSON.stringify({ at: new Date().toISOString(), opener: OPENER, rows }, null, 2));
}

// ---------------------------------------------------------------------------
// PHASE seed: the Live arms.
// ---------------------------------------------------------------------------
function systemPrompt(arm) {
  const common =
    "You are Ava, an AI assistant calling on behalf of Digile Media, a marketing agency for private clinics.\n" +
    "=== OUTBOUND CALL ===\n" +
    "You are calling Sam, who just filled in a form asking about our clinic systems.\n" +
    "Objective: qualify the clinic and book a 30-minute discovery call.\n" +
    "The person's identity is not yet confirmed; hearing them confirm their name is enough.\n" +
    "If someone other than Sam answers, say who you are calling for, offer to call back, and share nothing else.\n" +
    "Never claim to be human. If asked, confirm you are an AI.\n" +
    "Questions to ask, one at a time: What's the clinic called? What's your role there?\n" +
    "Keep every reply short and natural, in British English.\n";
  if (arm === "F") {
    return common +
      `Your FIRST words on this call, before anything else, must be this opening, word for word: "${OPENER}"\n` +
      "After that, never say that opening line again.";
  }
  return common +
    `You have ALREADY said this, word for word, at the start of the call: "${OPENER}"\n` +
    "Do not repeat it and do not introduce yourself again. Wait for their reply, then continue.";
}

const REINTRO_RE = /\b(it'?s ava|this is ava|i'?m ava|an ai assistant|calling from digile)\b/i;

async function runArm(arm, i, callerUlaw) {
  reserveP1(PROBE, 0.03);
  const st = {
    setup: false, err: null, closeReason: null, usage: emptyUsage(),
    out: [], outText: "", inText: "", firstAudioAt: null, totalOutBytes: 0,
  };
  let session = null;
  const t0 = Date.now();
  let sentAudioMs = 0;
  const res = { arm, run: i, model: MODEL, voice: LIVE_VOICE };
  try {
    session = await new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: systemPrompt(arm) }] },
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } }, languageCode: "en-GB" },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (m) => {
          const at = Date.now();
          if (m.setupComplete) st.setup = true;
          if (m.usageMetadata) addUsage(st.usage, m.usageMetadata);
          const sc = m.serverContent;
          if (!sc) return;
          const p = sc.modelTurn?.parts?.find((x) => x.inlineData?.data);
          if (p) {
            const pcm = Buffer.from(p.inlineData.data, "base64");
            st.out.push({ at, pcm });
            st.totalOutBytes += pcm.length;
            if (st.firstAudioAt === null) st.firstAudioAt = at;
          }
          if (sc.outputTranscription?.text) st.outText += sc.outputTranscription.text;
          if (sc.inputTranscription?.text) st.inText += sc.inputTranscription.text;
        },
        onerror: (e) => { st.err = (e?.message || String(e)).slice(0, 200); },
        onclose: (e) => { st.closeReason = e?.reason ? String(e.reason).slice(0, 200) : null; },
      },
    });
    for (let k = 0; k < 100 && !st.setup && !st.err; k++) await sleep(100);
    if (!st.setup) throw new Error(`no setupComplete (${st.err || st.closeReason || "timeout"})`);
    const setupAt = Date.now();

    const sil = (ms) => silenceFrames("pcm16k", ms);
    const send = (f) => { session.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }); sentAudioMs += 20; };

    let kickAt = null;
    if (arm === "S1") {
      session.sendClientContent({ turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false });
    } else if (arm === "S2") {
      session.sendClientContent({
        turns: [
          { role: "user", parts: [{ text: "(The call has connected.)" }] },
          { role: "model", parts: [{ text: OPENER }] },
        ],
        turnComplete: false,
      });
    } else {
      kickAt = Date.now();
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: "(The caller has just connected. Open the call now.)" }] }],
        turnComplete: true,
      });
    }

    // Before the caller speaks: continuous silence, as Twilio sends it. For S
    // arms any model audio here is SPONTANEOUS SPEECH (a fail). For F it is
    // the opener being spoken, and we wait for it to finish.
    const preMs = arm === "F" ? 9000 : 2500;
    await paceFrames(sil(preMs), send, {
      stop: () => arm === "F" && st.firstAudioAt && Date.now() - st.out[st.out.length - 1].at > 700,
    });
    const preOut = st.out.slice();
    const preText = st.outText;
    res.pre_caller_audio_s = Number((preOut.reduce((s, o) => s + o.pcm.length, 0) / 48000).toFixed(2));
    res.pre_caller_text = preText.trim();
    if (arm === "F") {
      res.opener_first_audio_ms = st.firstAudioAt && kickAt ? st.firstAudioAt - kickAt : null;
      res.opener_verbatim_ratio = verbatimRatio(preText, OPENER);
    }

    // The caller replies, then real-time silence until the model answers.
    st.out = []; st.outText = ""; st.firstAudioAt = null;
    const callerFrames = frames(ulawToPcm16k(callerUlaw), FRAME_BYTES.pcm16k);
    await paceFrames(callerFrames, send);
    const callerEndAt = Date.now();
    await paceFrames(sil(8000), send, {
      stop: () => st.firstAudioAt && Date.now() - st.out[st.out.length - 1].at > 900,
    });
    res.reply_latency_ms = st.firstAudioAt ? st.firstAudioAt - callerEndAt : null;
    res.reply_text = st.outText.trim();
    res.reintroduced = REINTRO_RE.test(st.outText);
    res.asked_question = /\?/.test(st.outText) || /\b(what|which|who|how|could you|can you)\b/i.test(st.outText);
    res.setup_ms = setupAt - t0;

    // Stitched handoff sample: what a caller would hear.
    const openerPart = arm === "F"
      ? pcm24kTo8k(Buffer.concat(preOut.map((o) => o.pcm)))
      : ulawToPcm8k(fs.readFileSync(path.join(OUT, `opener-${LIVE_VOICE}.ulaw`)));
    const gap = Math.min(res.reply_latency_ms ?? 1000, 4000);
    const stitched = concat16([
      openerPart, silence8k(400), ulawToPcm8k(callerUlaw), silence8k(gap),
      pcm24kTo8k(Buffer.concat(st.out.map((o) => o.pcm))),
    ]);
    fs.writeFileSync(path.join(OUT, `handoff-${arm}-${i}.wav`), wavPcm16(stitched, 8000));
  } catch (e) {
    res.error = e.message.slice(0, 200);
  } finally {
    try { session?.close?.(); } catch {}
    res.api_error = st.err;
    res.close_reason = st.closeReason;
    let priced = priceTokens(MODEL, st.usage);
    let estimated = false;
    if (!priced.usd) {
      priced = priceGeminiByMinutes({ inSeconds: sentAudioMs / 1000, outSeconds: st.totalOutBytes / 48000 });
      estimated = true;
    }
    res.usd = Number(priced.usd.toFixed(5));
    res.usd_estimated = estimated;
    res.wall_s = Number(((Date.now() - t0) / 1000).toFixed(1));
    commit({ probe: PROBE, arm, label: `seed-${arm}-${i}`, model: MODEL, usd: priced.usd, estimated });
  }
  return res;
}

function verbatimRatio(spoken, target) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const a = norm(spoken), b = norm(target);
  if (!b.length) return null;
  let hit = 0;
  const pool = new Map();
  for (const w of a) pool.set(w, (pool.get(w) || 0) + 1);
  for (const w of b) if (pool.get(w)) { hit++; pool.set(w, pool.get(w) - 1); }
  return Number((hit / b.length).toFixed(2));
}

async function phaseSeed() {
  const callerPath = path.join(OUT, "caller-reply.ulaw");
  const openerPath = path.join(OUT, `opener-${LIVE_VOICE}.ulaw`);
  if (!fs.existsSync(callerPath) || !fs.existsSync(openerPath)) {
    console.error("run --phase voices first (needs caller-reply.ulaw and the opener in the Live voice)");
    process.exit(1);
  }
  const callerUlaw = fs.readFileSync(callerPath);
  const results = [];
  for (const arm of ["S1", "S2", "F"]) {
    for (let i = 1; i <= N; i++) {
      const r = await runArm(arm, i, callerUlaw);
      results.push(r);
      console.log(
        `${arm}#${i}  pre-caller audio ${r.pre_caller_audio_s ?? "-"}s  reply ${r.reply_latency_ms ?? "-"}ms  ` +
        `reintro=${r.reintroduced}  q=${r.asked_question}  err=${r.error || r.api_error || "-"}  $${r.usd}`
      );
      console.log(`      reply: ${JSON.stringify((r.reply_text || "").slice(0, 160))}`);
      if (r.pre_caller_text) console.log(`      pre-caller: ${JSON.stringify(r.pre_caller_text.slice(0, 160))}`);
    }
  }

  const verdict = {};
  for (const arm of ["S1", "S2"]) {
    const rs = results.filter((r) => r.arm === arm);
    verdict[arm] = {
      runs: rs.length,
      spontaneous: rs.filter((r) => (r.pre_caller_audio_s || 0) > 0).length,
      reintroduced: rs.filter((r) => r.reintroduced).length,
      continued: rs.filter((r) => r.reply_text && !r.error && !r.api_error).length,
      errors: rs.filter((r) => r.error || r.api_error).length,
    };
    const v = verdict[arm];
    v.go = v.spontaneous === 0 && v.reintroduced === 0 && v.continued === v.runs && v.errors === 0;
  }
  const f = results.filter((r) => r.arm === "F");
  verdict.F = {
    runs: f.length,
    opener_first_audio_ms: f.map((r) => r.opener_first_audio_ms),
    opener_verbatim_ratio: f.map((r) => r.opener_verbatim_ratio),
  };
  verdict.seeded_go = verdict.S1.go || verdict.S2.go;
  fs.writeFileSync(path.join(OUT, "seed-results.json"), JSON.stringify({ at: new Date().toISOString(), model: MODEL, voice: LIVE_VOICE, n: N, verdict, results }, null, 2));
  console.log("\nVERDICT " + JSON.stringify(verdict, null, 2));
  console.log(`Part 1 spent: $${p1Spent().toFixed(4)}`);
}

if (PHASE === "voices") await phaseVoices();
else await phaseSeed();
