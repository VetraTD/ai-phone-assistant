/**
 * transcriptUtils.js — Pure transcript preprocessing utilities.
 *
 * These functions run on every STT result before it reaches the LLM pipeline.
 * Pipeline order:
 *   cleanTranscript() → isIncomplete() → extractFinalIntent()
 *
 * All functions are side-effect-free and independently testable.
 */

/**
 * Strip filler words and STT artifacts from a raw transcript before sending
 * to Gemini. Phone STT engines frequently emit isolated filler sounds ("uh",
 * "um", "mm-hmm") that carry no semantic content. Removing them prevents the
 * LLM from treating them as meaningful input or trying to interpret them.
 *
 * Returns null if the cleaned text is empty or under 2 words, indicating the
 * utterance carried no actionable content (e.g., a lone "um" or "okay").
 *
 * @param {string} text - Raw transcript from Deepgram or Twilio SpeechResult
 * @returns {string|null} Cleaned text, or null if nothing meaningful remains
 */
export function cleanTranscript(text) {
  if (!text || typeof text !== "string") return null;

  let clean = text.trim();

  // Remove standalone filler words/phrases. Word-boundary anchors prevent
  // stripping substrings from real words (e.g., "umbrella" → "rella").
  clean = clean.replace(
    /\b(uh+|um+|hmm+|mm+|mhm|uh-huh|mm-hmm|er+|ah+|like,?\s*|you\s+know,?\s*|i\s+mean,?\s*|so,?\s*|right,?\s*|okay,?\s*|ok,?\s*)\b/gi,
    " "
  );

  // Collapse multiple spaces introduced by the replacements above
  clean = clean.replace(/\s{2,}/g, " ").trim();

  // Remove leading/trailing punctuation artifacts left after stripping
  clean = clean.replace(/^[,.\s]+|[,.\s]+$/g, "").trim();

  // Reject single-word or empty results — almost certainly a STT mis-fire
  if (!clean || clean.split(/\s+/).length < 2) return null;

  return clean;
}

/**
 * Detect whether a transcript looks like an incomplete utterance that should
 * wait for more input rather than be forwarded to Gemini immediately.
 *
 * The existing terminal-punctuation check in mediaStream.js catches sentences
 * that close cleanly. This function catches three additional patterns:
 *
 *  1. Trailing conjunctions/prepositions — caller is mid-sentence:
 *     "I need to make an appointment and..." / "because my doctor..."
 *
 *  2. Partial phone number — digit sequences under 7 digits at end of text.
 *     The caller is still reading off digits (a complete US number is 10).
 *
 *  3. Partial date — bare month name or "weekday the" at end of text,
 *     meaning the caller hasn't given the day or year yet.
 *
 * Returns true when the utterance should NOT be forwarded to Gemini yet.
 *
 * @param {string} text - Cleaned transcript text
 * @returns {boolean}
 */
export function isIncomplete(text) {
  if (!text) return true;

  const t = text.trim();

  // Pattern 1 — trailing open-ended conjunction or preposition
  if (/\b(and|but|so|because|or|if|then|with|for|to|at|on|in|by)\s*$/i.test(t)) {
    return true;
  }

  // Pattern 2 — partial phone number (1–6 trailing digits means still dictating)
  const trailingDigits = t.match(/\b(\d[\d\s\-]{0,12})$/);
  if (trailingDigits) {
    const digitCount = trailingDigits[1].replace(/\D/g, "").length;
    if (digitCount > 0 && digitCount < 7) return true;
  }

  // Pattern 3 — partial date: month name at end with nothing following
  if (
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s*$/i.test(
      t
    )
  ) {
    return true;
  }
  // "Tuesday the" with no day number following
  if (
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+the\s*$/i.test(t)
  ) {
    return true;
  }

  return false;
}

/**
 * If the caller self-corrects mid-sentence ("actually", "wait", "no,",
 * "sorry,", "I mean", "scratch that"), discard everything before the
 * correction marker and return only the final intended content. This prevents
 * Gemini from seeing contradictory information and trying to reconcile both
 * halves (e.g., booking Tuesday AND Thursday because the caller said both).
 *
 * Returns the original text unchanged when no correction marker is detected.
 *
 * Examples:
 *   "I want Tuesday — actually, no, make it Thursday" → "make it Thursday"
 *   "My name is John, wait, sorry, it's James"        → "it's James"
 *   "Book at 10 AM, I mean 11 AM please"              → "11 AM please"
 *
 * @param {string} text - Cleaned transcript text
 * @returns {string} Text with pre-correction preamble removed, or original
 */
export function extractFinalIntent(text) {
  if (!text) return text;

  // Ordered most-specific to least-specific to avoid over-trimming.
  // Each pattern captures everything AFTER the correction marker.
  const CORRECTION_PATTERNS = [
    /\bactually[,\s]+(.+)$/i,
    /\bwait[,\s\-–]+(.+)$/i,
    /\bno[,\s\-–]+(.+)$/i,
    /\bsorry[,\s]+(.+)$/i,
    /\bi mean\s+(.+)$/i,
    /\blet me rephrase\b[^,]*[,\s]+(.+)$/i,
    /\bscratch that[,\s]+(.+)$/i,
  ];

  for (const pattern of CORRECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const corrected = match[1].trim();
      // Only accept correction if it contains at least 2 words — a single-word
      // result (e.g., "actually yes") is too ambiguous to use alone
      if (corrected.split(/\s+/).length >= 2) return corrected;
    }
  }

  return text;
}
