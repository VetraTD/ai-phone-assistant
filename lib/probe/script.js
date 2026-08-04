import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// The fixed caller script.
//
// Identical audio on every call, in every run. That is what makes this a
// measurement rather than an anecdote: two runs differ only because the system
// under test differed, never because the caller phrased something differently
// or paused for longer.
//
// The utterances are not arbitrary. Each one targets a specific branch of
// classifyHold (lib/transcriptUtils.js), so a run returns per-rule cost rather
// than a single averaged number that can't be acted on. The branch a line is
// expected to hit is named below; if the observed attribution disagrees, that
// mismatch is itself a finding about isIncomplete/classifyHold.
//
// The audio is synthetic and contains no real caller data — deliberately, so
// no recording of a real call is ever needed for latency work.
// ---------------------------------------------------------------------------

/** Where pre-synthesized caller audio is cached (gitignored). */
export const CALLER_AUDIO_DIR = path.resolve("test-audio/caller");

/**
 * The script. `expectRule` documents intent only — nothing enforces it, since
 * the run's job is to report what actually fired.
 */
export const SCRIPT_LINES = [
  {
    label: "clean_open",
    text: "Hi, I'd like to book an appointment.",
    expectRule: "complete",
  },
  {
    label: "trailing_lead_in",
    text: "It's for, uh",
    expectRule: "trailing_lead_in", // classifyHold charges 2000ms
  },
  {
    label: "name_spelling",
    text: "My name is Nithin. That's N, I, T, H, I, N.",
    expectRule: "complete",
  },
  {
    label: "partial_digits",
    text: "My number is five five five, two",
    expectRule: "partial_digits", // 1500ms
  },
  {
    label: "digits_continuation",
    text: "three four five six",
    expectRule: "no_terminal_punctuation",
  },
  {
    label: "no_terminal_punct",
    text: "Next Tuesday afternoon works",
    expectRule: "no_terminal_punctuation", // the common-case 1500ms tax
  },
  {
    // Interrupts the reply 400ms in. Measures the barge path and the
    // post-barge settle window, which no clean turn exercises.
    label: "barge_in",
    text: "Actually, could we make it Wednesday instead?",
    bargeInAfterMs: 400,
    expectRule: "post_barge_settle",
  },
  {
    label: "clean_close",
    text: "That's all, thanks.",
    expectRule: "complete",
  },
];

/**
 * A caller script shaped like real speech rather than like the branch table.
 *
 * SCRIPT_LINES above is diagnostic: half its lines are chosen to trigger a
 * specific classifyHold rule, and each says so in `expectRule`. That is the
 * right tool for exercising the branches and the wrong one for sizing what
 * they cost — it is why the runbook recorded classifyHold as firing on "~1 in
 * 3 turns", a number that describes the script, not the product.
 *
 * These lines are shaped from 1,000 real caller utterances in call_transcripts.
 * Only aggregate statistics were taken — no transcript text was copied, which
 * also keeps PHI out of a file that gets synthesized to disk and played down a
 * phone line. The measured shape:
 *
 *   median 6 words · p25 4 · p90 14 · ~25% are 1-3 words
 *   · ~34% questions · ~10% contain digits
 *
 * Deliberately NO `expectRule` anywhere. Deepgram decides where finals land, so
 * the rule mix is an OUTCOME of the run. Predicting it here would rig it again.
 */
export const REPRESENTATIVE_LINES = [
  { label: "rep_open", text: "Hi, I'd like to book an appointment." },
  {
    label: "rep_reason",
    text: "I've been having some tooth pain on the left side for about a week.",
  },
  { label: "rep_avail_q", text: "Do you have anything this week?" },
  { label: "rep_time_q", text: "Do you have anything Tuesday morning?" },
  { label: "rep_confirm", text: "Tuesday at ten works for me." },
  { label: "rep_digits", text: "It's five five five, one two three four." },
  { label: "rep_repeat_q", text: "Sorry, could you repeat that?" },
  {
    // Keeps the barge path and the post-barge settle window covered — no clean
    // turn exercises them, and real callers interrupt.
    label: "rep_barge",
    text: "Actually, can we make it Wednesday instead?",
    bargeInAfterMs: 400,
  },
  { label: "rep_done", text: "No, that's everything." },
  { label: "rep_close", text: "Thanks, bye." },
];

const SCRIPTS = {
  diagnostic: SCRIPT_LINES,
  representative: REPRESENTATIVE_LINES,
};

/**
 * Pick a script by name. Defaults to the diagnostic one so every existing
 * caller and cached run keeps its current behaviour.
 *
 * Throws on an unknown name rather than falling back: a run that silently used
 * a different script than the operator asked for would still produce a
 * plausible report, which is the same failure mode buildProbeScript guards.
 *
 * @param {string} [name="diagnostic"]
 */
export function resolveScriptLines(name = "diagnostic") {
  const lines = SCRIPTS[name];
  if (!lines) {
    throw new Error(`Unknown probe script "${name}". Expected one of: ${Object.keys(SCRIPTS).join(", ")}`);
  }
  return lines;
}

/** Path a line's cached mu-law audio lives at. */
export function audioPathFor(label) {
  return path.join(CALLER_AUDIO_DIR, `${label}.ulaw`);
}

/**
 * Load the script with its pre-synthesized audio attached.
 *
 * Throws rather than silently skipping a missing line: a run that quietly
 * dropped an utterance would still produce a plausible-looking report built on
 * a different script than the one it claims.
 *
 * @returns {Array<{label: string, mulaw: Buffer, bargeInAfterMs?: number}>}
 */
export function buildProbeScript(lines = SCRIPT_LINES) {
  return lines.map((line) => {
    const file = audioPathFor(line.label);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Missing caller audio for "${line.label}" (${file}). ` +
          `Run: node scripts/latency-probe.js --synth`
      );
    }
    const mulaw = fs.readFileSync(file);
    if (!mulaw.length) throw new Error(`Caller audio for "${line.label}" is empty: ${file}`);
    return {
      label: line.label,
      mulaw,
      ...(line.bargeInAfterMs ? { bargeInAfterMs: line.bargeInAfterMs } : {}),
    };
  });
}

/**
 * Synthesize and cache the caller audio, once.
 *
 * Uses Google TTS because it already emits 8kHz mu-law natively (no resampling
 * on the input side) and because it is a DIFFERENT voice from the assistant's
 * ElevenLabs one — the echo guard compares content, but keeping the two voices
 * distinct removes any doubt about self-echo contaminating a measurement.
 *
 * @param {object} deps
 * @param {function(string, string=): Promise<Buffer>} deps.synthesizeMulaw
 * @param {string} [deps.voiceName]
 * @param {boolean} [deps.force] - re-synthesize even if cached
 * @returns {Promise<{written: string[], skipped: string[]}>}
 */
export async function synthesizeCallerAudio({
  synthesizeMulaw,
  voiceName = "en-US-Chirp3-HD-Charon",
  force = false,
  lines = SCRIPT_LINES,
} = {}) {
  fs.mkdirSync(CALLER_AUDIO_DIR, { recursive: true });
  const written = [];
  const skipped = [];

  for (const line of lines) {
    const file = audioPathFor(line.label);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      skipped.push(line.label);
      continue;
    }
    const mulaw = await synthesizeMulaw(line.text, voiceName);
    if (!mulaw?.length) throw new Error(`TTS returned no audio for "${line.label}"`);
    fs.writeFileSync(file, mulaw);
    written.push(line.label);
    log.info("probe_caller_audio_written", {
      label: line.label,
      bytes: mulaw.length,
      seconds: Number((mulaw.length / 8000).toFixed(2)),
    });
  }

  return { written, skipped };
}
