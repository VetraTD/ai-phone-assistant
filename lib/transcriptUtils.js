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
/**
 * Strip standalone filler words/phrases ("uh", "um", "mm-hmm", "you know")
 * from a transcript. Word-boundary anchors prevent stripping substrings from
 * real words (e.g., "umbrella" → "rella"). Shared by cleanTranscript below
 * and by the barge-in layer (lib/voice/turnManager.js), which uses an
 * empty-after-strip result to classify a final as pure filler noise.
 *
 * @param {string} text
 * @returns {string} Stripped text (may be empty)
 */
export function stripFillers(text) {
  if (!text || typeof text !== "string") return "";

  // "like" requires a following comma so the verb survives ("I'd like to
  // book" must NOT become "I'd to book"); the filler usage ("it's, like,
  // Tuesday") is transcribed with commas.
  let clean = text.replace(
    /\b(uh+|um+|hmm+|mm+|mhm|uh-huh|mm-hmm|er+|ah+|like,\s*|you\s+know,?\s*|i\s+mean,?\s*|so,?\s*|right,?\s*|okay,?\s*|ok,?\s*)\b/gi,
    " "
  );

  // Drop tokens left with no letters or digits — orphaned punctuation from
  // removed fillers (e.g. "mm-hmm" leaves a bare "-", "um," leaves a ",").
  clean = clean
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .join(" ");

  // Remove leading/trailing punctuation artifacts left after stripping
  clean = clean.replace(/^[,.\s]+|[,.\s]+$/g, "").trim();

  return clean;
}

export function cleanTranscript(text) {
  if (!text || typeof text !== "string") return null;

  const clean = stripFillers(text.trim());

  // Reject only when nothing survives the filler strip. Short real answers
  // ("no", "yes", "five", "Tuesday") are meaningful on a phone call — the AI
  // asks yes/no and single-slot questions constantly — so they must reach
  // the LLM rather than being discarded as mis-fires.
  if (!clean) return null;

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
// Shared by isIncomplete() and holdDurationFor() so the two can never drift
// out of sync about what "trailing conjunction" or "trailing lead-in" means.
const TRAILING_CONJUNCTION =
  /\b(and|but|so|because|or|if|then|with|for|to|at|on|in|by|y|e|o|u|pero|porque|si|con|para|por|de|en|a|que)\s*$/i;

const TRAILING_LEAD_IN =
  /\b(my name is|it's|i need|i want|i'd like|i'd like to|can i|do you|is there|the reason|it's about|we need|the number is|i'm calling about|let me|how about|mi nombre es|me llamo|necesito|quiero|quisiera|es para|llamo para)\s*$/i;

// A digit run of 1–6 trailing digits means the caller is still dictating a
// number (a complete US phone number is 10). Shared for the same reason.
const TRAILING_DIGITS = /\b(\d[\d\s\-]{0,12})$/;

/** @param {string} t trimmed text @returns {boolean} */
function hasPartialDigits(t) {
  const m = t.match(TRAILING_DIGITS);
  if (!m) return false;
  const digitCount = m[1].replace(/\D/g, "").length;
  return digitCount > 0 && digitCount < 7;
}

export function isIncomplete(text) {
  if (!text) return true;

  const t = text.trim();

  // Pattern 1 — trailing open-ended conjunction or preposition.
  // Spanish terms mirror the English set for parity with the pipeline's
  // Spanish support; "a"/"o"/"e"/"y"/"u" are single letters but the \b
  // anchors keep them from matching inside words.
  if (TRAILING_CONJUNCTION.test(t)) {
    return true;
  }

  // Pattern 1b — trailing lead-in phrase: the caller announced information
  // but the 300ms STT endpointing finalized before they delivered it
  // ("my name is...", "I'm calling about...", "how about...").
  if (TRAILING_LEAD_IN.test(t)) {
    return true;
  }

  // Pattern 1c — trailing comma: STT punctuated a mid-thought pause.
  if (/,\s*$/.test(t)) {
    return true;
  }

  // Pattern 2 — partial phone number (1–6 trailing digits means still dictating)
  if (hasPartialDigits(t)) return true;

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
 * How long to hold an incomplete-looking final, waiting for the caller to
 * finish, before forwarding it to the LLM anyway.
 *
 * A single flat timeout is the wrong shape: "I need to book an appointment
 * for" (the caller is visibly mid-thought) deserves noticeably more patience
 * than a final that merely lacks a full stop. The tiers below follow the
 * ratios published by production voice platforms — short on terminal
 * punctuation, ~1.5s with none, an in-between value while digits are being
 * dictated — with the trailing-conjunction case given the longest window
 * because it is the strongest textual evidence of an unfinished sentence.
 *
 * Callers are expected to bound the total across a chain of holds; this
 * function only prices one link. Returns 0 when the text looks finished, in
 * which case no hold should be started at all.
 *
 * @param {string} text - Cleaned transcript text
 * @returns {number} hold duration in ms (0 = don't hold)
 */
export function holdDurationFor(text) {
  return classifyHold(text).holdMs;
}

/**
 * Same decision as holdDurationFor, but also reports WHICH rule fired.
 *
 * Exists for diagnosis: every hold costs the caller real waiting time, so
 * when tuning you need to know whether a 2s hold came from a genuine
 * "...appointment for" or from a rule matching too eagerly. The duration
 * alone can't tell those apart.
 *
 * @param {string} text - Cleaned transcript text
 * @returns {{holdMs: number, rule: string}} rule is one of:
 *   "empty" | "trailing_conjunction" | "trailing_lead_in" | "partial_digits"
 *   | "terminal_punctuation" | "no_terminal_punctuation"
 */
/**
 * How long to wait on a final that carries no terminal punctuation. Tunable
 * because this is the one hold rule that fires on ordinary speech, so it is the
 * one worth moving from probe data. 0 disables it.
 */
// Read at call time, not module load, so it can be swept per-scenario by
// sim/cutoffSim.sim.js without reimporting the module — the same reason
// services/elevenlabs.js reads its kill-switch at call time.
function holdNoPunctMs() {
  const v = Number.parseInt(process.env.VOICE_HOLD_NO_PUNCT_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 3_000 ? v : 500;
}

export function classifyHold(text, rawText = text) {
  if (!text) return { holdMs: 0, rule: "empty" };
  const t = text.trim();
  if (!t) return { holdMs: 0, rule: "empty" };

  // Strongest signal of an unfinished sentence — the caller stopped on a
  // word that cannot end one.
  //
  // Deliberately NOT longer. This was briefly raised to 3s (with a 4.5s
  // chain ceiling) to try to cover measured pauses of 1.8s, 2.7s and 4.4s,
  // and it made things worse: the very next call had a ~6s gap, so the hold
  // ran its full 4.5s, flushed anyway, the continuation still arrived as a
  // separate turn, and the caller waited 6.7s voice-to-voice for the
  // privilege. A hold cannot out-wait an arbitrarily slow caller; past a
  // couple of seconds it only adds dead air to a turn that splits regardless.
  // Late continuations are handled by barge-in instead, which is fast and
  // (per live listening) sounds clean.
  if (TRAILING_CONJUNCTION.test(t)) return { holdMs: 2_000, rule: "trailing_conjunction" };
  if (TRAILING_LEAD_IN.test(t)) return { holdMs: 2_000, rule: "trailing_lead_in" };

  // Mid-dictation of a phone number or similar.
  if (hasPartialDigits(t)) return { holdMs: 1_500, rule: "partial_digits" };

  // Terminal punctuation and nothing above matched — STT believes the
  // sentence closed, so don't add latency to the common case.
  //
  // Tested against the RAW transcript, not the cleaned one. stripFillers ends
  // with `replace(/^[,.\s]+|[,.\s]+$/g, "")`, which removes the trailing full
  // stop — so a cleaned "I'd like to book an appointment." arrives here as
  // "...appointment" and reads as unfinished. That did not matter while
  // classifyHold sat behind an isIncomplete() gate, because this branch was
  // never reached for ordinary speech. Now that it is consulted for every
  // final, judging the stripped text would put a hold on EVERY declarative
  // sentence a caller speaks. ("?" and "!" survive stripFillers; "." does not,
  // which is why this was invisible until now.)
  const rawTrimmed = typeof rawText === "string" ? rawText.trim() : t;
  if (/[.!?]\s*$/.test(rawTrimmed)) return { holdMs: 0, rule: "terminal_punctuation" };

  // No terminal punctuation: STT finalized on a silence gap rather than a
  // sentence end. Worth a moment.
  //
  // 1500 -> HOLD_NO_PUNCT_MS (500). This branch was effectively dead while
  // classifyHold sat behind an isIncomplete() gate in lib/voice/session.js;
  // now that it is consulted for every final it fires far more often, and it
  // was sized for a 300ms Deepgram endpointing window rather than today's
  // 150ms. At 1500ms it would hand back more than the whole latency win the
  // endpointing change bought (-166ms p50). 500ms is enough to catch the
  // mid-sentence finals a 150ms window produces, and a hold that catches a
  // continuation costs nothing anyway — the continuation cancels it.
  return { holdMs: holdNoPunctMs(), rule: "no_terminal_punctuation" };
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
