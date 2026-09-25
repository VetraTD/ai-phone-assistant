/**
 * What this system may tell a caller about how their call is kept.
 *
 * NO CALL IS RECORDED. The Live path hands the call off with
 * <Connect><Stream> and never issues a TwiML Record verb; the only one in the
 * codebase is the degraded-mode voicemail (tests/recordingPathLint.test.js,
 * which fails on the literal tag -- so this comment names the verb in words).
 * What IS kept is the transcript (LVX83). Until 2026-09-24 every Digile call
 * opened with "calls are recorded for quality" and the code default promised
 * the same, which was untrue (LVX88). Spec decision D4 replaced it with the
 * sentence below, which is true.
 *
 * One module, so the sentence the greeting speaks, the lint that keeps a
 * recording claim out of the source, and the production audit of tenant
 * free text all agree on what a claim is.
 */

/** The default disclosure. D4, word for word. */
export const TRANSCRIPTION_DISCLOSURE = "This call may be transcribed to help us assist you.";

/**
 * Sentences that tell a caller their call is recorded.
 *
 * Settled against a table of real strings before it was written here (the
 * cases live in tests/voiceDisclosure.test.js). The word "recorded" on its own
 * is NOT a claim: lib/voice/strings.js treats "I have your message recorded"
 * as a write confirmation, and this codebase's comments say "recorded" in the
 * sense of "written down" hundreds of times. A claim needs a CALL (or a
 * conversation, or a line) as the thing being recorded, or one of the formulas
 * that only ever describe call recording.
 *
 * Widened after review: the first version missed the standard UK phrasings
 * ("Calls to this number may be recorded", "Call recording is in operation"),
 * and the production audit closes LVX88 on reading clean, so a missed phrasing
 * is a tenant wrongly cleared. Negations ("calls are not recorded") are the
 * truth here and must never match.
 *
 * KNOWN FALSE POSITIVES, accepted on purpose: "the call is recorded as
 * completed", "each call is recorded in your log". Both are rare in caller-
 * or operator-facing text, and narrowing the pattern to exclude them would
 * reopen the misses above. Do not "fix" them by narrowing.
 */
export const RECORDING_CLAIM_PATTERNS = [
  // "calls are recorded", "Calls to this number may be recorded", "your call
  // may also be recorded", "this conversation may be recorded", "calls may be
  // monitored, recorded and transcribed". Up to three words may sit between the
  // noun and the verb, and up to two after it -- but never "not" or "never".
  /\b(?:calls?|conversations?|line)\b(?:\s+\w+){0,3}?\s+(?:is|are|may|might|will|can|could|would|shall)\s+(?:(?!not\b|never\b)\w+\s+){0,2}?(?:(?:monitored|transcribed)\s*(?:,|and|or|and\/or|&)\s*)*recorded\b/i,
  // "recorded for quality", "recorded for training / monitoring purposes"
  /\brecorded\s+for\s+(?:quality|training|monitoring|security|compliance)\b/i,
  // "Call recording is in operation", "call recording may be used"
  /\bcall\s+recording\s+(?:is|may|will|in)\b/i,
  // "we record all calls", "we may record calls", "we monitor and record
  // calls", "we're recording this call"
  /\bwe(?:'re|\s+are)?\s+(?:may\s+)?(?:also\s+)?(?:monitor\s+and\s+)?record(?:ing)?\s+(?:(?:this|all|our|your|every|phone)\s+)?calls?\b/i,
];

/**
 * @param {string|null|undefined} text
 * @returns {boolean} true when the text tells a caller the call is recorded
 */
export function claimsRecording(text) {
  if (!text) return false;
  return RECORDING_CLAIM_PATTERNS.some((re) => re.test(text));
}
