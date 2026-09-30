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

// ---------------------------------------------------------------------------
// The demo scripts. A DIFFERENT job from the two above.
//
// The diagnostic and representative scripts exist to MEASURE -- they feed the
// latency probe, and their lines are chosen to hit classifyHold branches. These
// two exist to FALSIFY: each one drives the front-end down a path where a known
// defect either reappears in the counters or does not.
//
// They are read by scripts/live-call-harness.js, which cannot hear what the
// assistant says -- it receives audio, not text. So the assertion is never "it
// said the right thing"; it is a counter delta and a database row. That is a
// narrower claim and a much more reliable one.
//
// THE STANDING RISK WITH ANY SCRIPTED CALLER: it desyncs. A prompt change that
// reorders the questions leaves the caller answering the previous one, and the
// run still completes and still produces numbers. Two mitigations, and neither
// is complete: the lines below answer generically enough to survive a reordering
// ("Yes, that works" fits most questions), and the harness prints the assistant's
// audio timing per turn so a desync shows up as turns that do not line up. Read
// the deployment's live_debug_assistant_turn log before believing a green run.
// ---------------------------------------------------------------------------

/**
 * LVX40, LVX34 and LVX25, in one call.
 *
 * The caller DOES NOT VOLUNTEER A NAME. That is the whole point: LVX40 was a
 * booking written with client_name null because nothing ever asked, and the
 * owner had to ask whether it was confirmed before a name was collected at all.
 * If the assistant books before `demo_name`, the row will have no name and
 * `booking_refused_no_name` will read 0.
 *
 * The name is then given in speech only, which should trip the spelling gate --
 * and LVX34 is what the assistant does with that refusal. `spelling_gate_refusals`
 * should move; `live_deferral_after_refusal` should NOT.
 */
export const DEMO_BOOKING_LINES = [
  { label: "demo_open", text: "Hi, I'd like to book an appointment." },
  // The name goes SECOND because that is what gets asked second. The first
  // version of this script answered the name question with a symptom and never
  // recovered -- eight turns, no time ever agreed, no booking, and a run that
  // looked like a failed fix rather than a failed script.
  //
  // Two names, deliberately. "Fitzgerald" is what the caller SAYS; it is
  // ordinary enough that the STT gets it right, so the run tests the gate
  // rather than the transcriber. The first attempt used a name the STT turned
  // into "Nathan Daddario", which makes every downstream assertion about names
  // meaningless.
  { label: "demo_name", text: "It's Jane Fitzgerald, from Fitzgerald Design." },
  // RE-ALIGNED 2026-09-12 against the order the prompt actually asks in, which
  // is the maintenance the header warns this script needs after any prompt
  // change. Measured on a local run that same evening, question by question:
  //
  //   name -> number -> SPELL the name -> offer a time -> confirm
  //
  // The old order put `when` second and `spell` sixth, so every answer after
  // the name landed on the previous question: the number answered "spell your
  // name", and "Yes, that's right" answered "could you spell that". The caller's
  // affirmative therefore never followed a read-back, `lastAgreement` was never
  // written, consent_agreement_recorded stayed 0, and the recovery declined
  // `never_agreed` -- a run that looked like a failed feature and was a failed
  // script. Exactly the shape the comment above this one already describes.
  //
  // `when` now comes AFTER the spelling, because that is where the assistant
  // stops asking identity questions and starts talking about times.
  { label: "demo_number", text: "My number is four six nine, nine three three, eight eight nine zero." },
  { label: "demo_spell", text: "That's F, I, T, Z, G, E, R, A, L, D." },
  // THE MODEL ASKS THIS EVERY TIME AND THE SCRIPT HAD NO ANSWER FOR IT.
  // Three local calls, three phrasings: "what's your business, or what do you
  // sell?", "what's the industry or sector you work in?", "what's your company
  // name?" followed by "and what business are you in, Jane?". Every unanswered
  // question shifts the whole script by one turn, and on the third call that
  // pushed the caller's "Yes, that's right" onto a company question and left
  // the model's actual read-back -- "Shall I go ahead and book that?" -- being
  // answered by "No, that's everything".
  //
  // A caller line exists to absorb it. The company is already in demo_name, so
  // this is a repetition rather than new information, which is the safe kind of
  // filler: harmless if the question never comes.
  { label: "demo_company", text: "Fitzgerald Design. We do brand identity work." },
  { label: "demo_when", text: "Next Tuesday at ten in the morning, please." },
  // This one has to land on the READ-BACK, or none of the consent machinery
  // downstream of it ever engages.
  { label: "demo_accept", text: "Yes, that's right." },
  { label: "demo_anything", text: "No, that's everything." },
  { label: "demo_close", text: "Thanks, bye." },
];

/**
 * LVX33: several cancellations in one turn, then a booking.
 *
 * The second half is the assertion. Cancelling three appointments used to leave
 * two phantoms in the caller snapshot, and those tripped the
 * existing-appointment policy so the caller could not book AT ALL for the rest
 * of the call. So a run where the cancels succeed and the booking is then
 * refused is the bug still present, and it is visible in `live_tool_refusals`
 * without hearing a word.
 *
 * Needs appointments on the caller's number first, or it proves nothing.
 */
export const DEMO_CANCEL_LINES = [
  { label: "cx_open", text: "Hi, I need to cancel some appointments." },
  { label: "cx_name", text: "It's Jane Fitzgerald, from Fitzgerald Design." },
  { label: "cx_batch", text: "I have three booked and I need to cancel all of them, please." },
  { label: "cx_confirm", text: "Yes, cancel all three." },
  { label: "cx_rebook", text: "Now can I book a new one for next Tuesday at ten in the morning?" },
  // Added after the first run desynced here. The requested slot may well be
  // taken -- it was, on the rig where this was written -- and the assistant
  // then offers alternatives. Answering that with a phone number leaves the
  // rest of the script one question behind, which is how a run that had already
  // proved its point still ended without a booking.
  { label: "cx_slot", text: "The first one you offered is fine, thank you." },
  { label: "cx_number", text: "My number is four six nine, nine three three, eight eight nine one." },
  { label: "cx_accept", text: "Yes, that's right." },
  { label: "cx_done", text: "No, that's all. Thanks." },
];

/**
 * The person who picks up an OUTBOUND call (Task 15): one "Hello?", which
 * scripts/live-call-harness.js --outbound speaks at --hello-ms after the
 * simulated answer. People say it 1.87-2.2 s after answering (the owner's two
 * calls), which is what the listen-first first seconds are built around.
 */
export const OUTBOUND_HELLO_LINES = [{ label: "outbound_hello", text: "Hello?" }];

// ---------------------------------------------------------------------------
// S3-5: outbound SITUATION scripts -- multi-line, spoken against the real
// Live model by scripts/live-call-harness.js --outbound --script <name>.
//
// Each falsifies a specific §9.5/§9.6/§13 path (a gatekeeper, a wrong number,
// an opt-out, a "call me back" reschedule, a "are you a robot" challenge) the
// same way DEMO_BOOKING_LINES/DEMO_CANCEL_LINES falsify the inbound ones: the
// harness cannot hear, so every assertion is a counter, a log event or a
// database row (lib/probe/outboundHarness.js's situation criteria), never
// "it said the right thing".
//
// The contact's own first name is "Sam" (lib/probe/outboundSeed.js's
// HARNESS_FIRST_NAME) -- deliberately NOT the person these scripts were
// written for: Google TTS -> Live transcribes short, common first names far
// more reliably than uncommon ones (memory scripted-callers-desync), and
// every line below that speaks the contact's name uses this same one so the
// harness and the verdict agree on what "confirmed" sounds like.
//
// THE STANDING RISK: these desync exactly like the inbound demo scripts do.
// A caller line that no longer answers what Ava actually asked still sends
// and still produces a verdict -- read live_debug_assistant_turn before
// calling a FAIL a defect (memory scripted-callers-desync).
//
// TRIAGE ROUND 1 (real paid-run evidence, sims-report.md finding E /
// Surprising #1): every script used to open with its SUBSTANTIVE line. Real
// calls showed the caller's own opening words silently and completely
// dropped while the backstop clip plays (`lib/outbound/firstSeconds.js`'s
// local-barge gate treats a short utterance arriving as the clip starts as
// "not a barge," which also means it never reaches the model's ASR at all --
// `outbound_gatekeeper_later`-1/2 lost "He's out." entirely this way, and the
// model went on to (wrongly) treat the caller as an unconfirmed Sam). Fix:
// every script now opens with a SHORT, disposable greeting ("Hello?" or, for
// the two gatekeeper scripts, a short pickup phrase) -- if THAT line is lost
// or mistimed, nothing of substance is lost with it. The substantive line(s)
// move to position 2+, spoken only once Ava's own reply has gone quiet
// (ordinary turn-taking, scripts/live-call-harness.js's maybeSpeakNext), so
// they are never raced against the first-seconds backstop at all.
// ---------------------------------------------------------------------------

/** §13.3: an explicit opt-out, mid-call. Already opened with a short "Hello?" -- unchanged. */
export const OUTBOUND_STOP_LINES = [
  { label: "stop_hello", text: "Hello?" },
  { label: "stop_ask", text: "Please stop calling me." },
];

/**
 * §9.5: a gatekeeper who goes to fetch the actual contact. The pickup line
 * ITSELF is the gatekeeper's own greeting (there is no separate generic
 * "Hello?" to prepend -- "who's calling?" already IS the short opener), but
 * "Reception, who's calling?" measured 2.16 s of synthesized speech: onset
 * at --hello-ms plus that much speech risks running past `slowLiveMs`
 * (1,600 ms after onset) before the caller even finishes, which is exactly
 * the race this round is fixing. Shortened to "Reception?" per the triage
 * ruling (short enough to finish well inside that window); the two
 * substantive lines are unchanged and still play by ordinary turn-taking.
 */
export const OUTBOUND_GATEKEEPER_FETCH_LINES = [
  { label: "gk_fetch_reception", text: "Reception?" },
  { label: "gk_fetch_wait", text: "One moment." },
  { label: "gk_fetch_confirm", text: "Hi, this is Sam." },
];

/** §9.5: a gatekeeper who offers a callback time instead of fetching anyone. A short pickup phrase now opens it; the substantive line moved to position 2. */
export const OUTBOUND_GATEKEEPER_LATER_LINES = [
  { label: "gk_later_hello", text: "Hello, reception?" },
  { label: "gk_later_try", text: "He's out. Try tomorrow at ten." },
];

/**
 * 2026-09-30 (D-R2-1): the contact confirms who they are. The reply to the
 * confirmation must state why Ava is calling BEFORE the first question
 * (reason_before_first_question). "Hello?" first, so the stale-reply path
 * (D-R2-3) is exercised too, and identity must still be confirmed after it.
 */
export const OUTBOUND_REASON_FIRST_LINES = [
  { label: "rf_hello", text: "Hello?" },
  { label: "rf_confirm", text: "Yes, this is Sam." },
  { label: "rf_go_ahead", text: "Okay, sure." },
];

/** §9.5 "wrong person": a child answers and must not be treated as verified. A short "Hello?" now opens it; the substantive lines moved to positions 2-3. */
export const OUTBOUND_CHILD_LINES = [
  { label: "child_hello", text: "Hello?" },
  { label: "child_not_here", text: "He's not here, I'm his son." },
  { label: "child_what_about", text: "What's it about?" },
];

/** A bad time to talk, with a specific reschedule request. Already opened with a short "Hello?" -- unchanged. */
export const OUTBOUND_BAD_TIME_LINES = [
  { label: "bad_time_hello", text: "Hello?" },
  { label: "bad_time_driving", text: "I'm driving, call me tomorrow at three." },
];

/**
 * §9.5 "wrong person": the number reaches someone else entirely. A short
 * "Hello?" now opens it; the substantive line moved to position 2 and its
 * own wording was sharpened (lib/outbound/prompt.js triage round 1) to say
 * "wrong number" unambiguously, distinct from "{first_name} isn't here
 * right now" (the gatekeeper/household-member, RIGHT-number move).
 */
export const OUTBOUND_WRONG_NUMBER_LINES = [
  { label: "wrong_number_hello", text: "Hello?" },
  { label: "wrong_number_ask", text: "Wrong number. There's nobody called Sam at this number." },
];

/** §7 disclosure, challenged directly. Already opened with a short "Hello?" -- unchanged. */
export const OUTBOUND_ROBOT_LINES = [
  { label: "robot_hello", text: "Hello?" },
  { label: "robot_ask", text: "Are you a robot?" },
];

/** A channel preference that should close the call politely, outcome "other". Already opened with a short "Hello?" -- unchanged. */
export const OUTBOUND_EMAIL_LINES = [
  { label: "email_hello", text: "Hello?" },
  { label: "email_ask", text: "Just email me instead." },
];

// ---------------------------------------------------------------------------
// Final fix wave W1: three scripts for the next paid set (final-review.md's
// recommended sims), each aimed at one first-seconds fix. Two new line
// properties, read by scripts/live-call-harness.js's outbound runner:
//   - afterPreviousMs: send this line that long after the previous line's
//     audio ENDED, without waiting for Ava's reply (the caller talks over the
//     clip BY DESIGN) -- every other line still waits for Ava to go quiet;
//   - hangUpAfterMs: hang up that long after this line's audio ends.
// Lines reuse existing labels (so existing cached audio) wherever the words
// are the same; only `biz_greeting` is new and needs `--synth` once.
// ---------------------------------------------------------------------------

/**
 * A15: a SECOND short "Hello?" early in the clip (the caller did not hear
 * the opener start), then an ordinary answer once Ava speaks. The stale reply
 * to the FIRST hello must never play after the opener.
 */
export const OUTBOUND_DOUBLE_HELLO_LINES = [
  { label: "outbound_hello", text: "Hello?" },
  { label: "outbound_hello", text: "Hello?", afterPreviousMs: 700 },
  { label: "gk_fetch_confirm", text: "Hi, this is Sam." },
];

/**
 * I2: "Please stop calling me." said DURING the clip, then the caller hangs
 * up before the clip ends. The held words must still reach the transcript
 * and the opt-out must be recorded (a suppression row), with post-call run.
 */
export const OUTBOUND_STOP_MIDCLIP_HANGUP_LINES = [
  { label: "stop_hello", text: "Hello?" },
  { label: "stop_ask", text: "Please stop calling me.", afterPreviousMs: 300, hangUpAfterMs: 400 },
];

/**
 * A14: a long business-style greeting that is still going at onset +
 * slowLiveMs, so the clip fires mid-greeting (backstop_slow). The opener
 * must not be cut on its first frame.
 */
export const OUTBOUND_BUSINESS_GREETING_LINES = [
  { label: "biz_greeting", text: "Good morning, thank you for calling Riverside Dental, this is Sarah speaking, how can I help you today?" },
  { label: "gk_fetch_confirm", text: "Hi, this is Sam." },
];

const SCRIPTS = {
  diagnostic: SCRIPT_LINES,
  representative: REPRESENTATIVE_LINES,
  demo_booking: DEMO_BOOKING_LINES,
  demo_cancel: DEMO_CANCEL_LINES,
  outbound_hello: OUTBOUND_HELLO_LINES,
  outbound_stop: OUTBOUND_STOP_LINES,
  outbound_gatekeeper_fetch: OUTBOUND_GATEKEEPER_FETCH_LINES,
  outbound_gatekeeper_later: OUTBOUND_GATEKEEPER_LATER_LINES,
  outbound_child: OUTBOUND_CHILD_LINES,
  outbound_bad_time: OUTBOUND_BAD_TIME_LINES,
  outbound_wrong_number: OUTBOUND_WRONG_NUMBER_LINES,
  outbound_robot: OUTBOUND_ROBOT_LINES,
  outbound_email: OUTBOUND_EMAIL_LINES,
  outbound_double_hello: OUTBOUND_DOUBLE_HELLO_LINES,
  outbound_stop_midclip_hangup: OUTBOUND_STOP_MIDCLIP_HANGUP_LINES,
  outbound_business_greeting: OUTBOUND_BUSINESS_GREETING_LINES,
  outbound_reason_first: OUTBOUND_REASON_FIRST_LINES,
};

/**
 * The outbound situation scripts: the 8 of S3-5, in the order the report
 * lists them, then the 3 of the final fix wave (W1). `outbound_hello` is NOT
 * one of these: it is the pre-existing
 * single-line default `--outbound` (no `--script`) has always spoken, kept
 * that way so a run with no `--script` is byte-identical to before this task.
 */
export const OUTBOUND_SITUATION_SCRIPTS = Object.freeze([
  "outbound_stop",
  "outbound_gatekeeper_fetch",
  "outbound_gatekeeper_later",
  "outbound_child",
  "outbound_bad_time",
  "outbound_wrong_number",
  "outbound_robot",
  "outbound_email",
  // Final wave W1 (the next paid set).
  "outbound_double_hello",
  "outbound_stop_midclip_hangup",
  "outbound_business_greeting",
  // 2026-09-30 (D-R2-1).
  "outbound_reason_first",
]);

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
      // Final wave W1: the outbound runner's timed-line / hang-up properties.
      ...(typeof line.afterPreviousMs === "number" ? { afterPreviousMs: line.afterPreviousMs } : {}),
      ...(typeof line.hangUpAfterMs === "number" ? { hangUpAfterMs: line.hangUpAfterMs } : {}),
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
