// lib/outbound/detectors.js
/**
 * Post-call compliance detectors (spec §13.2-13.4, Task 20). Pure: no I/O, no
 * clock, no database -- lib/outbound/postCall.js runs these over the stored
 * transcript and the attempt's own measured timings and decides what to do
 * with the answer.
 */

// ---------------------------------------------------------------------------
// §13.3 opt-out, belt and braces
// ---------------------------------------------------------------------------

/**
 * The assistant's OWN confirmation that it processed an opt-out (§13.3 step
 * 2's first list, exactly). This is what the `opt_out` tool says once it
 * exists (stage 3); scanned here as the belt to that tool's brace, because a
 * detector must not depend on a pack that has not shipped yet.
 */
const ASSISTANT_OPT_OUT_PATTERNS = [/won'?t call you again/i, /remove you from our list/i, /take you off our list/i];

/** What a caller says to ask to be taken off the list (§13.3 step 2's second list, exactly). */
const CALLER_OPT_OUT_PATTERNS = [/stop calling/i, /don'?t call me/i, /take me off/i, /remove me/i];

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
  const caller = String(callerText || "");
  const assistant = String(assistantText || "");
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
  const text = String(assistantText || "");
  const re = /\b(I'?m|I am) (a )?(real|human|person)\b/gi;
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
