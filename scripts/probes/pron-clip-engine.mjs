// ---------------------------------------------------------------------------
// Pronunciation build, Step 0 (2026-10-20): which engine makes the recorded
// greeting and the fixed lines? Owner picks by ear, blind.
//
// PAID (cents). Owner approved ~$0.05; this probe's hard cap is $0.10.
//
//   node scripts/probes/pron-clip-engine.mjs --dry   NO network: texts, plan
//   node scripts/probes/pron-clip-engine.mjs         render everything once
//
// Greeting (Digile UK, real greeting text, spoken form "Dij-aisle"):
//   TTS-SPELL  Google TTS en-GB-Chirp3-HD-Kore from "Dij-aisle Media" via
//              services/googleTts.js synthesizeMulaw (the production path)
//   TTS-IPA    same voice, SSML <phoneme alphabet="ipa" ph="ˈdɪdʒaɪl">Digile</phoneme>
//   LIVE-1..5  gemini-3.8-live, voice Kore, en-GB, lib/outbound/liveRender.js
//              renderLines (production render path, transcript-verified)
// Fixed line (CALL_LINES.technical): TTS-SPELL path and one LIVE take.
// Output: 8 kHz mu-law -> production decoder -> 16-bit WAV, shuffled labels.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { synthesizeMulaw } from "../../services/googleTts.js";
import { renderLines } from "../../lib/outbound/liveRender.js";
import { loadConfig } from "../../services/db.js";
import { greetingTextFor } from "../../lib/voice/greeting.js";
import { CALL_LINES } from "../../lib/twiml.js";
import { mulaw8kToPcm16k } from "../../lib/voice/resample.js";
import { CAP_USD, BudgetExceeded, commit, priceTokens, load as loadLedger } from "./lib/spendLive.js";

const MODEL = "gemini-3.8-live";
const VOICE = "Kore";
const LANGUAGE = "en-GB";
const TTS_VOICE = `${LANGUAGE}-Chirp3-HD-${VOICE}`;
const PREFIX = "PRONCLIP";
const PROBE_CAP_USD = 0.1;
const WORST_LIVE_USD = 0.01;
const TTS_USD_PER_CHAR = 30 / 1e6; // Chirp 3 HD list price
const LIVE_TAKES = 5;
const IPA = "ˈdɪdʒaɪl";

const BACKUP = path.resolve(".superpowers/backups/2026-10-12-s6-uk-show.txt");
const OUT = path.resolve(".superpowers/sdd/2026-10-20-pronunciation/engine");
const DRY = process.argv.includes("--dry");

function readBackup() {
  const f = {};
  for (const line of fs.readFileSync(BACKUP, "utf8").split(/\r?\n/)) {
    const m = /^\[cfg\] BEFORE (\w+) b64 ?(.*)$/.exec(line);
    if (m) f[m[1]] = Buffer.from(m[2].trim(), "base64").toString("utf8");
  }
  return f;
}
const RAW = readBackup();
const config = loadConfig({ id: "55c7c8c4-2c33-463c-875a-7f16d6bcc17e", name: RAW.name, greeting: RAW.greeting, timezone: RAW.timezone }, []);
const WRITTEN = greetingTextFor(config);
const SPOKEN = WRITTEN.replace(/\bDigile\b/g, "Dij-aisle");
const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const IPA_SSML = `<speak>${escapeXml(WRITTEN).replace(/\bDigile\b/g, `<phoneme alphabet="ipa" ph="${IPA}">Digile</phoneme>`)}</speak>`;
const FIXED = CALL_LINES.technical;

function probeSpent() {
  return loadLedger().entries.filter((e) => e.probe?.startsWith(PREFIX)).reduce((s, e) => s + (e.usd || 0), 0);
}
function reserve(worst) {
  if (probeSpent() + worst > PROBE_CAP_USD) throw new BudgetExceeded(`BUDGET: ${PREFIX} $${probeSpent().toFixed(4)} + $${worst} > $${PROBE_CAP_USD}`);
  if (loadLedger().spent_usd + worst > CAP_USD) throw new BudgetExceeded("overall ledger cap");
}

function wav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const toWav = (mulaw) => wav(mulaw8kToPcm16k(mulaw), 16_000);

function stripWavHeader(buf) {
  const i = buf.indexOf("data");
  return i >= 0 ? buf.subarray(i + 8) : buf;
}

async function tts(text, label) {
  reserve(text.length * TTS_USD_PER_CHAR);
  const audio = await synthesizeMulaw(text, TTS_VOICE, null, { bypassCache: true });
  commit({ probe: `${PREFIX}-TTS`, label, usd: text.length * TTS_USD_PER_CHAR, estimated: true });
  return audio;
}

async function ttsIpa(ssml, label) {
  const chars = ssml.length;
  reserve(chars * TTS_USD_PER_CHAR);
  const client = process.env.GOOGLE_TTS_API_KEY ? new TextToSpeechClient({ apiKey: process.env.GOOGLE_TTS_API_KEY }) : new TextToSpeechClient();
  const [res] = await client.synthesizeSpeech({
    input: { ssml },
    voice: { languageCode: LANGUAGE, name: TTS_VOICE },
    audioConfig: { audioEncoding: "MULAW", sampleRateHertz: 8000 },
  });
  commit({ probe: `${PREFIX}-TTS`, label, usd: chars * TTS_USD_PER_CHAR, estimated: true });
  return stripWavHeader(Buffer.from(res.audioContent, "binary"));
}

async function live(text, label) {
  reserve(WORST_LIVE_USD);
  const usages = [];
  const refusals = [];
  const log = {
    info: (ev, f) => { if (ev === "outbound_render_usage") usages.push(f); },
    error: (ev, f) => refusals.push({ ev, ...f }),
    warn: () => {}, debug: () => {},
  };
  const out = await renderLines({ lines: { opener: text }, voiceName: VOICE, languageCode: LANGUAGE, model: MODEL, log });
  const u = usages[0] || {};
  const usage = { text_in: u.text_in || 0, audio_in: u.audio_in || 0, text_out: u.text_out || 0, audio_out: u.audio_out || 0, cached_in: u.cached_in || 0 };
  const reported = (u.turns_billed || 0) > 0;
  const usd = reported ? priceTokens(MODEL, usage).usd : WORST_LIVE_USD;
  commit({ probe: `${PREFIX}-LIVE`, label, model: MODEL, usd, estimated: !reported });
  return { audio: out.opener || null, refusal: refusals[0] || null, usd, outcome: u.outcome };
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = randomInt(i + 1); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

console.log(`written : ${WRITTEN}`);
console.log(`spoken  : ${SPOKEN}`);
console.log(`ipa ssml: ${IPA_SSML}`);
console.log(`fixed   : ${FIXED}`);
console.log(`plan: 2 TTS greetings + ${LIVE_TAKES} Live greetings + 1 TTS + 1 Live fixed line; cap $${PROBE_CAP_USD}; spent $${probeSpent().toFixed(4)}`);
if (DRY) process.exit();

fs.mkdirSync(path.join(OUT, "clips"), { recursive: true });
const made = [];
const keep = (kind, engine, audio, extra = {}) => { if (audio?.length) made.push({ kind, engine, audio, ...extra }); };

try {
  keep("greeting", "TTS-SPELL", await tts(SPOKEN, "greeting-spell"));
  try { keep("greeting", "TTS-IPA", await ttsIpa(IPA_SSML, "greeting-ipa")); }
  catch (e) { console.log(`TTS-IPA failed: ${e.message}`); }
  for (let i = 1; i <= LIVE_TAKES; i++) {
    const r = await live(SPOKEN, `greeting-live-${i}`);
    console.log(`LIVE-${i}: ${r.audio ? `${(r.audio.length / 8000).toFixed(1)}s` : "REFUSED"} $${r.usd.toFixed(4)} ${r.refusal ? JSON.stringify(r.refusal) : ""}`);
    keep("greeting", `LIVE-${i}`, r.audio);
  }
  keep("fixed", "TTS-SPELL", await tts(FIXED, "fixed-technical"));
  const f = await live(FIXED, "fixed-live");
  console.log(`fixed LIVE: ${f.audio ? "ok" : "REFUSED"} $${f.usd.toFixed(4)}`);
  keep("fixed", "LIVE-1", f.audio);
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  console.log(e.message);
}

const key = [];
for (const kind of ["greeting", "fixed"]) {
  shuffle(made.filter((m) => m.kind === kind)).forEach((m, i) => {
    const label = `${kind === "greeting" ? "g" : "f"}${i + 1}`;
    fs.writeFileSync(path.join(OUT, "clips", `${label}.wav`), toWav(m.audio));
    key.push({ label, kind, engine: m.engine, seconds: Number((m.audio.length / 8000).toFixed(1)) });
  });
}
fs.writeFileSync(path.join(OUT, "key.json"), JSON.stringify({ written: WRITTEN, spoken: SPOKEN, key }, null, 2) + "\n");
console.log(`clips: ${key.map((k) => k.label).join(", ")}; probe total $${probeSpent().toFixed(4)}`);
