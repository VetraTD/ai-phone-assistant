/**
 * Voice A/B listening-pack generator (Task 13).
 *
 * Synthesizes the SAME short multi-turn receptionist script through the REAL
 * per-turn ElevenLabs websocket path (services/elevenlabs.js createTtsConnection
 * — one socket per turn, exactly like a live call), with `previous_text` wired
 * from each turn into the next so prosody CONTINUITY is audible. It renders the
 * 4 combinations of:
 *     model      : eleven_flash_v2_5  vs  eleven_turbo_v2_5
 *     stability  : 0.5 (old default)  vs  0.65 (new default)
 * and writes one WAV per variant so you can listen and pick.
 *
 * The audio is the call's actual format (8kHz mu-law), wrapped in a WAV
 * container — it will sound exactly as thin as it does on the phone. That's on
 * purpose: judge it the way a caller hears it.
 *
 * Usage:
 *   node --env-file=.env scripts/voice-ab.js                 # first catalog voice
 *   node --env-file=.env scripts/voice-ab.js --voice sarah   # catalog id
 *   node --env-file=.env scripts/voice-ab.js --voice XrExE9yKIg1WjnnlVkGX  # raw EL id
 *   node --env-file=.env scripts/voice-ab.js --smoke        # 1 variant, 1 turn (proof it works)
 *
 * Cost: 4 variants x ~3 short sentences of ElevenLabs credits. Cheap, but real.
 * (--smoke is ~1 sentence, for verifying the pipeline without a full pack.)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createTtsConnection } from "../services/elevenlabs.js";
import { VOICE_CATALOG } from "../config/voices.js";

const OUT_DIR = path.resolve("voice-previews");

// A tiny multi-turn call: a greeting, then two caller-driven replies. Turn N's
// previous_text is the concatenation of everything spoken before it, so the
// model conditions each turn on the real prior audio's text.
const SCRIPT_TURNS = [
  "Thanks so much for calling Bright Smiles Dental! This is the front desk. How can I help you today?",
  "Of course, I'd be happy to book that cleaning for you. What day works best?",
  "Perfect, you're all set for Thursday at ten. Is there anything else I can help with?",
];

const MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5"];
const STABILITIES = [0.5, 0.65];

function parseVoiceArg() {
  const i = process.argv.indexOf("--voice");
  return i !== -1 ? process.argv[i + 1] : null;
}

/** Resolve --voice (catalog id OR raw EL id) to {elevenVoiceId, label, similarity_boost}. */
function resolveVoice(arg) {
  const first = VOICE_CATALOG[0];
  if (!arg) return { id: first.elevenVoiceId, label: first.label, similarity: first.voiceSettings.similarity_boost };
  const byId = VOICE_CATALOG.find((v) => v.id === arg);
  if (byId) return { id: byId.elevenVoiceId, label: byId.label, similarity: byId.voiceSettings.similarity_boost };
  const byElId = VOICE_CATALOG.find((v) => v.elevenVoiceId === arg);
  if (byElId) return { id: byElId.elevenVoiceId, label: byElId.label, similarity: byElId.voiceSettings.similarity_boost };
  // Unknown raw ID — use it directly with the default similarity_boost.
  return { id: arg, label: arg.slice(0, 8), similarity: 0.8 };
}

/** Synthesize ONE turn through the real per-turn websocket; resolves to its mu-law audio. */
function synthTurn({ voiceId, modelId, voiceSettings, previousText, text }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const conn = createTtsConnection({
      voiceId,
      modelId,
      voiceSettings,
      previousText,
      onAudio: (buf) => chunks.push(buf),
      onFinal: () => { conn.close(); done(resolve, Buffer.concat(chunks)); },
      onError: (err) => done(reject, err),
    });
    conn.sendText(text);
    conn.flush();
  });
}

/** Render the given turns for one {model, stability} variant → one mu-law Buffer. */
async function synthVariant({ voiceId, similarity, modelId, stability, turns }) {
  const voiceSettings = { stability, similarity_boost: similarity };
  const audio = [];
  let previousText = ""; // turn 1 has no prior audio
  for (const text of turns) {
    const buf = await synthTurn({ voiceId, modelId, voiceSettings, previousText, text });
    audio.push(buf);
    // REPLACE, don't accumulate. Production threads only the PREVIOUS turn's
    // spoken text (lib/voice/session.js sets lastSpokenText = spokenThisTurn,
    // an assignment), trimmed to the last 300 chars by trimPreviousText.
    // Accumulating the whole conversation here made this harness model a
    // pipeline that does not exist — which matters most for the thing it is now
    // used to judge: whether expression escalates across a long call.
    previousText = text;
  }
  return Buffer.concat(audio);
}

/** Wrap 8kHz mono mu-law PCM in a WAV container (format 7 = ITU G.711 mu-law). */
function mulawToWav(mulaw) {
  const sampleRate = 8000;
  const header = Buffer.alloc(58);
  let o = 0;
  header.write("RIFF", o); o += 4;
  header.writeUInt32LE(50 + mulaw.length, o); o += 4; // file size - 8
  header.write("WAVE", o); o += 4;
  header.write("fmt ", o); o += 4;
  header.writeUInt32LE(18, o); o += 4;            // fmt chunk size (18 for non-PCM)
  header.writeUInt16LE(7, o); o += 2;             // audioFormat 7 = mu-law
  header.writeUInt16LE(1, o); o += 2;             // channels
  header.writeUInt32LE(sampleRate, o); o += 4;    // sample rate
  header.writeUInt32LE(sampleRate, o); o += 4;    // byte rate (blockAlign * rate)
  header.writeUInt16LE(1, o); o += 2;             // block align
  header.writeUInt16LE(8, o); o += 2;             // bits per sample
  header.writeUInt16LE(0, o); o += 2;             // cbSize
  header.write("fact", o); o += 4;
  header.writeUInt32LE(4, o); o += 4;             // fact chunk size
  header.writeUInt32LE(mulaw.length, o); o += 4;  // samples
  header.write("data", o); o += 4;
  header.writeUInt32LE(mulaw.length, o); o += 4;
  return Buffer.concat([header, mulaw]);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("ELEVENLABS_API_KEY is not set. Run with: node --env-file=.env scripts/voice-ab.js");
    process.exit(1);
  }
  const voice = resolveVoice(parseVoiceArg());
  const smoke = process.argv.includes("--smoke");
  const models = smoke ? [MODELS[0]] : MODELS;
  const stabilities = smoke ? [STABILITIES[0]] : STABILITIES;
  const turns = smoke ? SCRIPT_TURNS.slice(0, 1) : SCRIPT_TURNS;
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`\nA/B pack for voice "${voice.label}" (${voice.id})${smoke ? " [SMOKE: 1 variant, 1 turn]" : ""}`);
  console.log(`Script: ${turns.length} sequential turn(s), previous_text wired between them.\n`);

  const written = [];
  for (const modelId of models) {
    for (const stability of stabilities) {
      const modelShort = modelId.replace("eleven_", "").replace("_v2_5", "");
      const stabTag = String(stability).replace("0.", "").padEnd(2, "0"); // 0.5->50, 0.65->65
      const file = path.join(OUT_DIR, `ab-${voice.label}-${modelShort}-stab${stabTag}.wav`);
      process.stdout.write(`  synth ${modelShort} @ stability ${stability} ... `);
      try {
        const mulaw = await synthVariant({ voiceId: voice.id, similarity: voice.similarity, modelId, stability, turns });
        await fs.writeFile(file, mulawToWav(mulaw));
        console.log(`ok -> ${path.relative(process.cwd(), file)} (${(mulaw.length / 8000).toFixed(1)}s)`);
        written.push(file);
      } catch (err) {
        console.log(`FAILED: ${err?.message}`);
      }
    }
  }

  console.log(`\nDone. ${written.length}/${MODELS.length * STABILITIES.length} variants written to ${path.relative(process.cwd(), OUT_DIR)}/\n`);
  console.log("How to listen and what to compare:");
  console.log("  1. Play the four files back to back for the SAME voice.");
  console.log("  2. stab50 vs stab65: does 0.65 sound steadier turn-to-turn, or flat/robotic?");
  console.log("     (0.65 is the new default — we raised it to stop expression swinging between turns.)");
  console.log("  3. flash vs turbo: same model family, slightly different prosody/latency character.");
  console.log("  4. Within each file, listen ACROSS the turn boundaries — with previous_text wired,");
  console.log("     energy/cadence should carry over instead of resetting at each new sentence.");
  console.log("  5. Pick a (model, stability) you like, then set ELEVENLABS_MODEL / config/voices.js stability.\n");
}

main().catch((err) => {
  console.error("voice-ab failed:", err?.message);
  process.exit(1);
});
