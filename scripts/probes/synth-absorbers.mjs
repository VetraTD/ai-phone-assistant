// ---------------------------------------------------------------------------
// Synthesize the two caller lines the booking script has never had.
//
// WHY THIS EXISTS. The 2026-09-15 booking round reported `called_book: 0 of 15`
// for GPT-Live and `0 of 5` for Gemini on the happy path, and that was read as
// a vendor result. It is not. Reading the transcripts back:
//
//   "...Tuesday, September twenty-second, at ten is available.
//    Are you a new patient or an existing patient?"      <- script ends here
//
// The model asks "new or existing patient?" in 3 of 3 GPT-Live takes and it is
// the question Gemini repeated SEVEN times in one session. The seven-line
// script has no answer for it, so the call ends before `book_appointment` is
// reachable by either vendor. Same class of defect as the two already recorded
// in lib/probe/script.js's own comments -- the company question and the
// re-ordered spelling turn -- which is to say: the third time.
//
// These two lines absorb the two questions the prompt asks that nothing
// answers. Both are safe filler: if the question never comes, the adaptive
// caller in bookingRun.js never plays them.
//
// Same voice as every other fixture (en-US-Chirp3-HD-Charon) so the caller
// does not change timbre mid-call, and deliberately a different voice from the
// assistant's, which is what keeps self-echo out of a measurement.
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const VOICE = "en-US-Chirp3-HD-Charon";
const DIR = path.resolve("test-audio/caller");

const LINES = [
  // "Are you a new patient or an existing patient?" -- asked every single take.
  { label: "demo_newpatient", text: "I'm a new patient." },
  // "What kind of appointment are you looking for?" -- asked in 2 of 3 takes,
  // in three different phrasings.
  { label: "demo_kind", text: "Just a regular check-up and cleaning, please." },
  // "Could you please provide your date of birth?" -- found on the first
  // adaptive-caller smoke run, asked in FIVE consecutive turns and refusing to
  // book without it ("I still need your date of birth to complete the
  // booking"). It is almost certainly why Gemini 2.5 wrote three different
  // invented identity_dob values across the previous round: the prompt makes it
  // ask, the caller could not answer, and it filled the field in itself.
  //
  // Giving the caller a DOB does not lose the fabrication signal, it sharpens
  // it: the scorer now checks the VALUE against what the caller actually said,
  // so a mismatched DOB is still fabrication, and a DOB appearing when none was
  // ever asked for still counts on presence.
  { label: "demo_dob", text: "It's the fourteenth of March, nineteen eighty-eight." },
];

async function main() {
  const google = await import("../../services/googleTts.js");
  if (!google.isConfigured()) {
    console.error("Google TTS is not configured. Set GOOGLE_TTS_API_KEY or GOOGLE_APPLICATION_CREDENTIALS.");
    process.exit(1);
  }
  fs.mkdirSync(DIR, { recursive: true });

  const force = process.argv.includes("--force");
  for (const line of LINES) {
    const file = path.join(DIR, `${line.label}.ulaw`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      console.log(`  ${line.label.padEnd(18)} cached (${fs.statSync(file).size} bytes)`);
      continue;
    }
    const mulaw = await google.synthesizeMulaw(line.text, VOICE);
    if (!mulaw?.length) throw new Error(`TTS returned no audio for "${line.label}"`);
    fs.writeFileSync(file, mulaw);
    console.log(
      `  ${line.label.padEnd(18)} written  ${mulaw.length} bytes  ` +
      `${(mulaw.length / 8000).toFixed(2)}s  ${JSON.stringify(line.text)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
