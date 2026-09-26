// lib/outbound/detectors.js
/**
 * Post-call compliance detectors (spec §13.2-13.4, Task 20). Pure: no I/O, no
 * clock, no database -- lib/outbound/postCall.js runs these over the stored
 * transcript and the attempt's own measured timings and decides what to do
 * with the answer.
 */

/**
 * Fold curly apostrophes/quotes (’ U+2019, ‘ U+2018) to the straight ASCII
 * one (fix round 1, item 6): a transcript written by a model or a
 * transcription service routinely uses the curly form ("Yes, I’m a real
 * person"), and every pattern below writes `'?` expecting the straight one
 * -- so a curly apostrophe silently missed both detectors. The patterns
 * themselves are unchanged; only the input is normalised before matching.
 * @param {string} s
 * @returns {string}
 */
function foldCurlyQuotes(s) {
  return String(s || "").replace(/[‘’]/g, "'");
}

// ---------------------------------------------------------------------------
// §13.3 opt-out, belt and braces
// ---------------------------------------------------------------------------

/**
 * The assistant's OWN confirmation that it processed an opt-out (§13.3 step
 * 2's first list, exactly). This is what the `opt_out` tool says once it
 * exists (stage 3); scanned here as the belt to that tool's brace, because a
 * detector must not depend on a pack that has not shipped yet.
 *
 * EXPORTED (checkpoint 2b review, I3) so lib/outbound/prompt.js's own test
 * can assert the exact confirmation it tells Ava to SAY matches this list --
 * the prompt and the detector cannot drift apart again if one test binds to
 * both.
 */
export const ASSISTANT_OPT_OUT_PATTERNS = [
  /won'?t call you again/i,
  /remove you from our list/i,
  /take you off our list/i,
];

/**
 * What a caller says to ask to be taken off the list (§13.3 step 2's second
 * list). `remove me` carries a trailing `\b` (checkpoint 2b review, b40):
 * without it, the bare substring "remove me" is the first nine characters of
 * "remove medication", and a false opt-out here loses a real lead, not just
 * a false alarm -- `insertDetectorSuppression` (services/db.js) is the only
 * automated writer, and it fires from this list alone.
 */
const CALLER_OPT_OUT_PATTERNS = [/stop calling/i, /don'?t call me/i, /take me off/i, /remove me\b/i];

/**
 * Scan one turn's transcript text from each side for an opt-out (spec
 * §13.3). The caller side is checked first: a caller's own request is the
 * stronger, more direct signal, and the two lists are not mutually exclusive
 * on a single call.
 *
 * @param {{assistantText?: string, callerText?: string}} o
 * @returns {{hit: boolean, side: "assistant"|"caller"|null}}
 */
export function detectOptOut({ assistantText = "", callerText = "" } = {}) {
  const caller = foldCurlyQuotes(callerText);
  const assistant = foldCurlyQuotes(assistantText);
  if (CALLER_OPT_OUT_PATTERNS.some((re) => re.test(caller))) return { hit: true, side: "caller" };
  if (ASSISTANT_OPT_OUT_PATTERNS.some((re) => re.test(assistant))) return { hit: true, side: "assistant" };
  return { hit: false, side: null };
}

// ---------------------------------------------------------------------------
// §13.2 disclosure: claiming to be human
// ---------------------------------------------------------------------------

/**
 * `/\b(I'?m|I am) (a )?(real|human|person)\b/i`, exactly as the brief's
 * interface names it. A match immediately followed by a negation ("not",
 * "n't" -- allowing one comma in between, e.g. "I'm human, not a robot" is
 * still a genuine claim, but "I'm human, not really" retracts it) does not
 * count: the claim was walked back in the same breath.
 *
 * "I'm not a real person, I'm an AI" is not even a REGEX match (the "not"
 * breaks the required adjacency between "I'm" and "a real person", and
 * "I'm an AI" matches none of real/human/person), so it reads as false
 * without needing the negation check at all. "Yes, I'm a real person" is a
 * match with no following negation: true.
 *
 * Global, so a turn with multiple candidate phrases is not short-circuited
 * by the first one if THAT one happens to be immediately retracted.
 *
 * @param {string} assistantText
 * @returns {boolean}
 */
export function detectClaimedHuman(assistantText) {
  const text = foldCurlyQuotes(assistantText);
  // Checkpoint 2b review, b40. The trailing `\b` alone is satisfied by a
  // hyphen -- a hyphen is a non-word character, so "human-like" already has
  // a word boundary right after "human" and the old regex read that compound
  // word as a claim. `(?!-)` additionally refuses a following hyphen without
  // narrowing the genuine claims: a claim followed by a space, comma, period
  // or end of string is untouched.
  const re = /\b(I'?m|I am) (a )?(real|human|person)\b(?!-)/gi;
  const FOLLOWING_NEGATION = /^\s*(,\s*)?(not\b|n't\b)/i;
  let m;
  while ((m = re.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (!FOLLOWING_NEGATION.test(after)) return true;
    // A retracted match cannot loop forever: exec() already advanced past it.
  }
  return false;
}

// ---------------------------------------------------------------------------
// §13.4 silent calls
// ---------------------------------------------------------------------------

/**
 * The two-limb rule, evaluated from the session's OWN measured timings
 * (lib/outbound/firstSeconds.js's `firstAudio()` shape) -- no machine
 * exclusion and no "no stream" case here: those need `answered_by` and
 * whether a session ever existed, neither of which the Live controller can
 * know for certain at the moment it tears down (the AMD verdict can land
 * after the session finishes). This is what `finishAttemptSession` persists;
 * `resolveSilentVerdict` below applies the rest, in post-call, once.
 *
 * Fix round 1, item 3: this is only accurate when `firstAudio.measured ===
 * "playout"` -- a real, confirmed play. When it is `"enqueue"` or `firstAudio`
 * is `null`, the caller (`lib/voice/live/index.js`'s `finish()`) uses
 * `sessionEndSilent` below instead.
 *
 * @param {{from_speech_ms?: number|null, from_answer_ms?: number|null}|null} firstAudio
 * @returns {boolean}
 */
export function isSessionSilent(firstAudio) {
  const fromSpeechMs = firstAudio?.from_speech_ms;
  const fromAnswerMs = firstAudio?.from_answer_ms;
  if (typeof fromSpeechMs === "number") return fromSpeechMs > 2000;
  if (typeof fromAnswerMs === "number") return fromAnswerMs > 2000;
  return false;
}

/**
 * The session-end-bounded fallback (fix round 1, item 3, spec §13.4): when
 * `firstAudio()` could not confirm a real PLAYOUT -- either nothing was ever
 * queued at all (no clip, and Live never produced audio either), or a clip
 * WAS queued but its mark never echoed -- `isSessionSilent` above would read
 * `null`/an understated enqueue time as "not silent", which is wrong: the
 * person may have heard nothing for the whole call.
 *
 * By the time `finish()` runs, a LATE echo is definitionally impossible (the
 * session is ending, and nothing more will ever be delivered to Twilio for
 * it), so bound the silence by the session's own end instant instead of
 * trusting a queue-time value that necessarily understates how long the
 * person actually waited.
 *
 * @param {{onsetAt: number|null, streamStartAtMs: number, answerToStreamMs: number, atMs: number}} o
 *   `onsetAt`/`streamStartAtMs`/`answerToStreamMs` are firstSeconds.js's own
 *   raw state (`rawState()`); `atMs` is the session clock at finish().
 * @returns {boolean}
 */
export function sessionEndSilent({ onsetAt, streamStartAtMs, answerToStreamMs, atMs }) {
  if (onsetAt !== null && onsetAt !== undefined) return atMs - onsetAt > 2000;
  return atMs - streamStartAtMs + answerToStreamMs > 2000;
}

/** Twilio `AnsweredBy` values the silent rule NEVER applies to (spec §13.4). */
const MACHINE_OR_FAX = new Set(["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax"]);

/** @param {string|null|undefined} answeredBy @returns {boolean} */
export function isMachineOrFaxAnswer(answeredBy) {
  return MACHINE_OR_FAX.has(answeredBy);
}

/**
 * The FINAL silent verdict (spec §13.4), applied once by post-call:
 *   - a machine or a fax answer -> never silent, even if the session flagged
 *     it (the verdict can land after the session finished, so the exclusion is
 *     applied here, at the end, not by the controller);
 *   - no session ever finished for an answered attempt -> silent (the
 *     stream never connected);
 *   - otherwise, the session's own verdict stands.
 *
 * @param {{hasSession: boolean, sessionSilent: boolean, answeredBy: string|null}} o
 * @returns {boolean}
 */
export function resolveSilentVerdict({ hasSession, sessionSilent, answeredBy }) {
  if (isMachineOrFaxAnswer(answeredBy)) return false;
  if (!hasSession) return true;
  return Boolean(sessionSilent);
}
