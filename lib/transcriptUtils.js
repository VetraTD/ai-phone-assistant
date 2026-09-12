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

// A hesitation, and nothing wider. Deliberately NOT stripFillers.
//
// stripFillers cleans a transcript, and its list is wider than "hesitation" on
// purpose: it eats discourse markers too. Measured on real phrasings, it
// reduces "Okay", "OK", "Right", "So" and "Mm-hmm" to the empty string, so a
// consent gate built on it refuses a booking when the caller says "Okay." --
// the commonest way anyone agrees to anything on a phone call. It also lets
// "uh-huh" through as "-huh", because `uh+` precedes `uh-huh` in its
// alternation, so two words meaning the same thing get opposite verdicts.
//
// Internal punctuation is preserved when matching, which is what keeps the
// affirmative grunts out: "mm-hmm" and "uh-huh" mean yes and must never be
// read as hesitation. Only leading/trailing punctuation is trimmed, so "Ah!"
// still matches.
const HESITATION_TOKEN_RE = /^(?:u+h+|u+m+|h+m+|m+|e+r+m?|a+h+|e+h)$/i;
const TRIM_OUTER_PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * True when the caller's turn is ENTIRELY hesitation — "umm", "Ah!", "uh...".
 *
 * On the cascade this question never arose: Deepgram's text goes through
 * cleanTranscript, so a hesitation arrives as an empty turn and never reaches
 * the model as an answer. On the Live front-end the MODEL is the ASR and there
 * is no text stage, so "Ah!" arrives verbatim -- and on 2026-09-03 it was read
 * as agreement, and a reschedule and a name change were executed off it. See
 * LVX45 (the hang-up) and LVX56 (every other write).
 *
 * False for an empty turn on purpose: silence means the caller said nothing at
 * all, which the silence ladder owns, and treating it here would block a
 * legitimate close after a goodbye.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isHesitationOnly(text) {
  if (!text || typeof text !== "string") return false;
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(TRIM_OUTER_PUNCT_RE, ""))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => HESITATION_TOKEN_RE.test(t));
}

// ---------------------------------------------------------------------------
// DID THE CALLER SAY YES? LVX95.
//
// Nothing in this repository answered that question before. There were two
// predicates and both are NEGATIVE: isHesitationOnly says "this was not an
// answer", stripFillers says "this was not content". Neither can tell agreement
// from a change of subject, and "not a hesitation" is a very long way from
// "yes" -- "no, cancel the other one" clears every existing check.
//
// That gap is why confirmBeforeWrite could never be certified. Enforcement was
// a tool ARGUMENT the model set about itself (lib/capabilities/requirements.js
// :402), and on 2026-09-09 a call cancelled three appointments FOURTEEN SECONDS
// before asking the caller whether it should. The confirmation the caller heard
// was the model's own invention: unenforced, unmeasured, and indistinguishable
// from a real one.
//
// ---------------------------------------------------------------------------
// "Okay" IS a yes here, and that is the opposite of the hang-up gate's rule
// ---------------------------------------------------------------------------
//
// services/tools.js:219-226 already records why the two gates need different
// predicates. The hang-up gate follows "is there anything else?", where an
// affirmative grunt means there IS something else and a vague "okay" is not a
// no -- so it uses stripFillers, whose list swallows "Okay" deliberately. A
// WRITE gate follows "shall I book that?", where "okay" is the commonest way
// anyone agrees to anything on a phone call, and refusing on it would be its
// own defect.
//
// ---------------------------------------------------------------------------
// A negation anywhere in the turn beats an affirmative anywhere in it
// ---------------------------------------------------------------------------
//
// "Yes, but can we make it Thursday instead?" opens with a yes and is not
// consent to what was read back. "No, that's wrong" contains no affirmative at
// all and needs no special handling; the sentence that needs it is the one that
// starts agreeing and then changes something. Fail closed: when both appear,
// this returns false and the caller is asked once more.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// BILINGUAL, because a guard that only recognises English protects only English
// callers -- the reason promiseRe and deferralRe are localized, arriving here
// through the write gate instead of the claim guard.
//
// A gate that refuses is the sharp end of that principle. If this were
// English-only, every Spanish write would fail both halves and be refused until
// the per-call ceiling released it: strictly worse for those callers than not
// having the gate at all.
//
// `si` WITHOUT ITS ACCENT IS DELIBERATELY ABSENT. Unaccented, it is the
// conditional "if", and "si puede, cámbielo al jueves" ("if you can, change it
// to Thursday") is a request to change something, not consent to what was read
// back. Reading it as agreement would be the exact failure this gate exists to
// prevent, so it is left out; a transcript that drops the accent costs one
// extra turn, which the ceiling bounds.
// ---------------------------------------------------------------------------
const AFFIRMATIVE_RE =
  /\b(?:yes|yeah|yep|yup|yah|sure|correct|right|okay|ok|absolutely|definitely|exactly|perfect|great|please\s+do|go\s+ahead|sounds?\s+good|that'?s\s+(?:right|correct|it|fine)|do\s+it|book\s+it|confirm(?:ed)?|mm-hmm|uh-huh|s[í]|claro|vale|correcto|perfecto|adelante|de\s+acuerdo|por\s+supuesto|est[aá]\s+bien|me\s+parece\s+bien|h[aá]galo|res[eé]rvelo)\b/i;

// Words that withdraw or amend whatever was just read back. `instead`,
// `actually` and `change` are here because they are how a caller corrects a
// read-back WITHOUT ever saying no, which is the case a bare yes/no test misses.
//
// Spanish `cambie`/`mejor`/`en realidad` are the same shape: "sí, pero mejor el
// jueves" opens with agreement and is not consent to what was read back.
const NEGATION_RE =
  /\b(?:no|nope|nah|not|don'?t|do\s+not|wait|hold\s+on|hang\s+on|actually|instead|change|different|wrong|cancel\s+that|never\s*mind|sorry|nunca|espere|un\s+momento|en\s+realidad|mejor|cambie|cambiar|diferente|equivocad[oa])\b/i;

/**
 * True when the caller's last turn reads as agreement and nothing takes it back.
 *
 * Engine-observed and unfakeable by the model, which is the entire point: it is
 * built from the caller's own transcribed words, not from an argument the model
 * chose to set on a tool call.
 *
 * Empty or non-string is FALSE, not true. Silence is not consent, and a turn
 * that failed to transcribe is not one we know anything about.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isAffirmative(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NEGATION_RE.test(trimmed)) return false;
  return AFFIRMATIVE_RE.test(trimmed);
}

// Below this share of readable letters, the turn is not English (or Spanish)
// that went slightly wrong -- it is a different script, which on an English
// call means the transcriber failed rather than the caller switched.
const MIN_LATIN_LETTER_SHARE = 0.5;

/**
 * True when the transcript of a caller turn is not usable as speech at all.
 *
 * A caller's English turn came back as the Korean characters "에레는" and the
 * assistant answered "Great, 8 AM on Tuesday, September 8th, is available" --
 * then the call booked from it. The Live path has no notion of an unusable
 * transcript: the vendor exposes no confidence, stability or language field on
 * inputTranscription (checked -- the only fields read anywhere are
 * usageMetadata, toolCall, and serverContent's transcriptions plus
 * generationComplete/turnComplete/interrupted), and stripFillers only catches
 * recognised filler words, not garbage. A script-range check on the text is the
 * one signal available. See LVX50.
 *
 * Latin covers English AND Spanish, both supported locales, so an accented
 * Spanish turn is correctly not flagged. What this CANNOT detect is a
 * transcript that is fluent Latin nonsense; that limit is real and is the
 * reason this gates a write rather than silencing a reply.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isUnusableTranscript(text) {
  if (!text || typeof text !== "string") return false;
  const letters = text.match(/\p{L}/gu);
  // No letters at all is not the same as letters we cannot read. There is
  // nothing to judge here, so nothing is judged.
  if (!letters || letters.length === 0) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < MIN_LATIN_LETTER_SHARE;
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
 * The terminal-punctuation check in the voice session catches sentences
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

// SPLIT 2026-09-01, for the same reason the verb list below was split: several
// of these phrases END sentences as readily as they open them, and the ones
// that do are how a caller says goodbye.
//
//   "No, that's all I need."      ends on i need
//   "That's what I want."         ends on i want
//   "That's exactly what I'd like." ends on i'd like
//   "That's the reason."          ends on the reason
//
// Every one of those took the full 2000ms hold — twice what the verb list
// charges, landing immediately before the goodbye, and independent of every
// flag, so it has been live on production the whole time. On a phone call two
// seconds of silence reads as the line having dropped, and it is the last
// thing the caller experiences.
//
// Found while writing a test for the verb-list fix, which tripped over it.
//
// These lead unconditionally — nothing follows "my name is" but a name.
const TRAILING_LEAD_IN_STRUCTURAL =
  /\b(my name is|it's|i'd like to|can i|do you|is there|it's about|the number is|i'm calling about|how about|mi nombre es|me llamo|es para|llamo para)\s*$/i;

// ...and these are ambiguous: an opening ("I need an appointment") or a
// sign-off ("that's all I need"), told apart only by what precedes them.
const TRAILING_LEAD_IN_AMBIGUOUS =
  /\b(i need|i want|i'd like|we need|the reason|let me|necesito|quiero|quisiera)\s*$/i;

/**
 * The words that turn one of the above from an announcement into a closure.
 * "all I need", "what I want", "that's the reason", "todo lo que necesito" —
 * the caller is summing up, not about to continue.
 */
const CLOSING_BEFORE_LEAD_IN =
  /\b(all|what|everything|that's|thats|it's|its|todo|lo que)\s+(\S+\s+)?(i need|i want|i'd like|we need|the reason|let me|necesito|quiero|quisiera)\s*$/i;

/** @param {string} t trimmed, cleaned text @returns {boolean} */
function endsOnLeadIn(t) {
  if (TRAILING_LEAD_IN_STRUCTURAL.test(t)) return true;
  if (!TRAILING_LEAD_IN_AMBIGUOUS.test(t)) return false;
  return !CLOSING_BEFORE_LEAD_IN.test(t);
}

// The caller stopped on a word that needs an object.
//
// The third list, and the one that covers what the other two structurally
// cannot: they match trailing FUNCTION words, while sim/cutoffSim.sim.js shows
// the real cutoffs are fragments ending on transitive verbs and determiners —
// "I'd like to book", "Can I get", "I've been having". Deepgram's smart_format
// punctuates those mid-thought, so without this they reach the terminal-
// punctuation branch and get a zero hold.
//
// SPLIT IN TWO on 2026-08-31, when the default moved from 0 to 800.
//
// This was one list, under a comment claiming "every word here is one that
// CANNOT end a caller's sentence". That was simply false for the verbs:
//
//   "No, that's all I need."      ends on need
//   "Yes, cancel."                ends on cancel   (answering "book or cancel?")
//   "Just a booking."             ends on booking
//   "That's what I want."         ends on want
//
// Every one of those is a complete turn, and several are how a call ENDS — so
// at 800ms the fix would have put dead air in front of the goodbye. It was
// invisible while the default was 0, and the matched-pair evidence could not
// see it either: the simulator's fluent control is a fixed script that happens
// not to end on any of these words, so "the fluent control does not move" was
// a property of the script, not of the rule. Utterances ending on these verbs
// are now IN that control, precisely so it can fail.
//
// The determiners below are genuinely unconditional — nothing follows "the"
// but a noun. The verbs are not, so they need a cue: an infinitive marker or
// an auxiliary within a couple of words, which is what separates "I'd like TO
// BOOK" from "all I NEED".
//
// The exclusions are still load-bearing, for both groups:
//   know  — "I don't know."
//   have  — "Yes I have."
//   is/are/was — "Yes it is."
//   can/could/will/would — "Yes I can."
//   that/some/any — "I'd like that."
//   see   — "I see." is a backchannel, and holding on it is pure dead air.
// There is deliberately no /\w+ing$/ catch-all either: "Tuesday morning." and
// "just a cleaning." are complete answers.
//
// Keep both lists TIGHT. Every false positive is dead air on a finished turn,
// and onHoldExpired can extend it further. Check
// holdRules.trailing_incomplete in /api/debug/latency before adding to them.
const TRAILING_INCOMPLETE_STRUCTURAL =
  /\b(a|an|the|my|your|our|their|its|this|these|those|be|been|being|un|una|el|la|los|las|mi|su)\s*$/i;

/**
 * A transitive verb at the end, WITH an infinitive marker or auxiliary within
 * two words of it.
 *
 * Two words is what admits "Can I get" while still rejecting "all I need": the
 * cue has to be close enough to be governing the verb, rather than merely
 * present somewhere earlier in the sentence. Written as one literal rather
 * than composed from strings because a regex assembled with new RegExp needs
 * every backslash doubled, and getting that wrong produces a regex that
 * matches nothing while still compiling.
 */
const TRAILING_INCOMPLETE_VERB =
  /\b(to|can|could|would|should|will|shall|may|might|be|been|am|is|are|was|were|para|puedo|quiero|quisiera|voy)\b(\s+\S+){0,2}\s+(book|booking|schedule|scheduling|reschedule|rescheduling|cancel|canceling|cancelling|get|getting|make|making|take|taking|need|needing|want|wanting|having|bring|bringing|reservar|hacer|cancelar|cambiar)\s*$/i;

/** @param {string} t trimmed, cleaned text @returns {boolean} */
function endsMidThought(t) {
  return TRAILING_INCOMPLETE_STRUCTURAL.test(t) || TRAILING_INCOMPLETE_VERB.test(t);
}

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
  if (endsOnLeadIn(t)) {
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

/**
 * How long to hold a fragment that ended on a word needing an object.
 *
 * Read at call time for the same reason as holdNoPunctMs: sim/cutoffSim.sim.js
 * mocks this module, and a mock factory's importActual() result survives
 * vi.resetModules() — a module-level read would freeze at the env of first
 * import and every per-scenario sweep would silently measure nothing.
 *
 * 0 disables. Capped at the 3s chain ceiling (lib/voice/session.js
 * MAX_TOTAL_HOLD_MS) so a misconfigured value cannot out-wait the pipeline.
 *
 * Default 0 -> 800 on 2026-08-31.
 *
 * CORRECTED, same day: this was first written as "the branch stayed dead in
 * production". That is wrong, and the way it was wrong is worth keeping. The
 * CODE default was 0, but staging had already set VOICE_HOLD_TRAILING_MS=800
 * in its environment — so the rule had been live on real calls for some time,
 * and what was actually inert was every environment that did NOT set it: local
 * dev, the test suite, and the simulator's own unpinned arms.
 *
 * Which means the simulator was modelling an environment that did not exist.
 * Its "punctuated finals @150ms / 50% cutoffs" baseline was never staging's
 * behaviour; staging was already sitting on the 12.5% row. Reading a sim row
 * as "what production does" requires knowing that the flags match, and nobody
 * had checked — which is exactly what backlog P0-1 exists for.
 *
 * The change is still right: it makes the code agree with the environment
 * instead of relying on it, and it fixes the false positives below, which
 * WERE live on staging the whole time. The matched pair the recommendation was
 * waiting for, same script, same pauses, same endpointing, flag the only
 * difference:
 *
 *   punctuated finals @150ms    8 turns  4 cutoffs  50.0%  reply 1260ms
 *   punctuated + trailing 800   8 turns  1 cutoff   12.5%  reply 1260ms
 *   fluent (control)            5 turns  0 cutoffs   0.0%  reply 1260ms
 *   fluent + trailing 800       5 turns  0 cutoffs   0.0%  reply 1260ms
 *
 * The fluent control does not move at all — not its cutoffs and not its reply
 * latency — which is the point. This rule sits ABOVE the punctuation branch
 * and only matches fragments ending on a word that needs an object, so a
 * caller who speaks in whole sentences never reaches it and pays nothing. That
 * is what separates it from raising a blanket hold, which buys the same
 * accuracy by charging every caller for it.
 *
 * NOT 2000: the comment on TRAILING_CONJUNCTION records a live call where a
 * longer hold bought nothing and cost 6.7s voice-to-voice.
 */
function holdTrailingMs() {
  const v = Number.parseInt(process.env.VOICE_HOLD_TRAILING_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 3_000 ? v : 800;
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
  if (endsOnLeadIn(t)) return { holdMs: 2_000, rule: "trailing_lead_in" };

  // Stopped on a word that needs an object. Sits HERE, above the punctuation
  // branch, which is the whole point: smart_format punctuates these fragments
  // mid-thought, so judged after punctuation they would all read as finished.
  // Placed here it costs nothing on complete turns, because it never matches
  // them.
  const trailingMs = holdTrailingMs();
  if (trailingMs > 0 && endsMidThought(t)) {
    return { holdMs: trailingMs, rule: "trailing_incomplete" };
  }

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

/**
 * The longest run of identical words shared by two assistant turns. LVX78.
 *
 * Exists because a caller reported hearing "something repeated in an unnatural
 * way" and could not say what, and nothing in this system could answer the
 * question. Reading four calls back by hand found three instances, none of
 * which any counter had seen.
 *
 * WHY A WORD RUN AND NOT A PHRASING LIST. It is exact, it is free, and it needs
 * no vocabulary — the same three properties that made counting "?" the right
 * shape for stacked questions. It is also immune to LVX73: a spurious vendor
 * transcription fragment cannot manufacture a sixteen-word match with the
 * previous turn, where a phrase list could be tripped by one.
 *
 * Deliberately NOT a similarity ratio. Two turns that say the same thing in
 * different words are a different defect from one that reads a booking back
 * verbatim, and a ratio would blur them.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} words in the longest identical run, 0 if either is empty
 */
export function longestSharedRun(a, b) {
  const words = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return 0;

  // Classic DP for longest common substring, on words. Turns are a couple of
  // dozen words, so the quadratic cost is irrelevant and the clarity is worth
  // more than a rolling hash.
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * How long a shared run has to be before it reads as a REPEAT rather than as
 * two sentences that happen to share a phrase.
 *
 * MEASURED, not chosen. Across 26 consecutive turn-pairs from three real calls
 * on 2026-09-05, 24 pairs shared 4 words or fewer. The only two above that were
 * both genuine defects: 6 words (a greeting delivered twice) and 16 words (an
 * entire booking — day, date, time and the caller's phone number — read back in
 * two consecutive turns). Nothing landed in between, so the threshold sits in a
 * real gap rather than on a guess.
 *
 * The expected false positive, stated rather than discovered: offering a time
 * and then confirming the same time can legitimately share six or seven words.
 * That is acceptable because NOTHING ACTS ON THIS — it is a count, so a false
 * hit costs a number that reads louder and never reaches a caller.
 */
export const REPEAT_RUN_WORDS = 6;

/**
 * Does one assistant turn ask for more than one thing? LVX25.
 *
 * The counter used to be "more than one question mark", which is exact and free
 * and MISSED THE TURN THAT MATTERED. On 2026-09-05 the model said:
 *
 *   "May I get your full name, and what is the best number to reach you on?"
 *
 * One question mark, two questions -- and it caused three consecutive repeats,
 * because the caller answered the first half and the model re-asked the second
 * half verbatim, three times. The counter read 2 for that whole call while the
 * defect drove six repeats.
 *
 * So the question-mark rule stays as the exact half, and this adds the shapes
 * actually observed:
 *
 *   two question STARTERS in one sentence -- "May I get X, and what is Y?"
 *   ", and" or "also" inside a question   -- "..., and what industry? Also, ..."
 *   a starter plus a joining "and"        -- "Can I get X and Y, please?"
 *
 * THE FALSE POSITIVE, stated rather than discovered: "What day and time works
 * for you?" trips the third rule and most callers hear that as one question.
 * Acceptable because NOTHING ACTS ON THIS -- it is a count, so a false hit costs
 * a number that reads louder and never reaches a caller. The moment anything
 * refuses on it, this rule needs revisiting.
 */
// NARROWED 2026-09-05, hours after it was first written, because the first
// version was WORSE than what it replaced.
//
// It counted question STARTERS and called two of them a stacked question. On the
// next real call that flagged four single questions out of seven turns: "How can
// I help you today?" has two starters ("how", "can i") and is one question, and
// so do "what industry are you in" and "could you spell that... first and last".
// A counter that fires on most turns is not a signal.
//
// The rule that survives contact with the data is narrower and structural: TWO
// CLAUSES, EACH WITH ITS OWN QUESTION STARTER, JOINED BY ", and". That is the
// shape of the turn that actually caused three consecutive repeats —
//
//   "May I get your full name, and what is the best number to reach you on?"
//
// — and it does not match "Okay, and what is your main marketing challenge?",
// where what precedes the comma is a discourse marker rather than a clause.
//
// Measured over 15 real turns from the 2026-09-05 calls: 15/15.
//
// What it still misses, deliberately: "Can I get your full name and the best
// number, please?" — one starter, no comma. Widening to catch a bare "and"
// brought back the false positives, and a counter that over-fires is worse than
// one that under-fires, because a low number reads as "not a problem" while a
// high one reads as "the detector is broken".
const QUESTION_STARTER = "what|when|where|which|who|how|why|can i|may i|could you|can you|would you|do you|are you|is there";
const TWO_CLAUSES = new RegExp(
  `\\b(?:${QUESTION_STARTER})\\b[^?]*,\\s*and\\s+(?:${QUESTION_STARTER})\\b`,
  "i"
);
/** "…? Also, …" — a second ask bolted on after the first was already asked. */
const ALSO_THEN_ASK = /\balso\b[^?]*\?/i;

/**
 * Every ", and <starter>" join inside one sentence, so a THIRD clause counts.
 * Global on purpose -- TWO_CLAUSES answers "is this stacked", this answers
 * "how many times".
 */
const JOINED_STARTER = new RegExp(`,\\s*and\\s+(?:${QUESTION_STARTER})\\b`, "gi");

/**
 * How many things one assistant turn asks for. LVX82.
 *
 * A LOWER BOUND, not a count, and the difference is the whole design. It sums
 * only signals that are already exact -- a "?"-terminated sentence, and each
 * ", and <starter>" clause joined inside one -- and it deliberately cannot see
 * a bare noun phrase in a list. The turn from the 2026-09-07 calls
 *
 *   "Can I take your name, date of birth, and what it is for?"
 *
 * scores 2, not 3: "date of birth" carries no question starter. Widening to
 * catch it means counting comma-separated noun phrases, which is the phrasing
 * treadmill the docblock above was narrowed to escape, and it would score
 * "What day and time works for you?" as two.
 *
 * WHY A LOWER BOUND IS ENOUGH. The counter exists to show that a behaviour fix
 * worked. That needs the number to be MONOTONE and comparable across runs, not
 * exact: a turn that stops stacking scores lower whether the floor was tight or
 * loose. It is not quotable as "the caller heard N questions", and the field is
 * named `asks` rather than `questions` for that reason.
 *
 * The boolean it replaces read the same for a turn asking two things and a turn
 * asking five. `live_stacked_questions` fired five times on 2026-09-07 and could
 * not distinguish either case from the other.
 *
 * @param {string} text
 * @returns {number} a floor on the things asked, 0 when nothing was asked
 */
export function countAsks(text) {
  const whole = String(text || "");
  let asks = 0;

  for (const sentence of whole.split(/(?<=[.!?])\s+/)) {
    if (!sentence.includes("?")) continue;
    asks += 1;
    // The joins only count when the sentence is stacked in the structural
    // sense TWO_CLAUSES defines -- a starter clause BEFORE the join as well as
    // after. Without that, "I'll send that over, and what time suits?" reads as
    // two asks when it is one.
    if (TWO_CLAUSES.test(sentence)) {
      asks += (sentence.match(JOINED_STARTER) || []).length;
    }
  }

  // "…? Also, …" bolts a second ask onto a turn whose sentences may already
  // have been counted. Floor it at two rather than adding, so the two rules
  // cannot double-count the same pair.
  if (asks < 2 && ALSO_THEN_ASK.test(whole)) asks = 2;

  return asks;
}

/**
 * Does one assistant turn ask for more than one thing? LVX25.
 *
 * Kept as its own export because the shape of the question is a boolean at most
 * call sites. It is now the threshold on countAsks rather than a second
 * implementation of the same rules -- two copies drifting apart is how the
 * `marks:` field came to disagree with the counter beside it.
 */
export function asksMoreThanOneThing(text) {
  return countAsks(text) > 1;
}

/**
 * A stable, cheap identity for a piece of text. djb2.
 *
 * MOVED HERE FROM services/tools.js so there is exactly one of it. The
 * write-order gate fingerprints the read-back it refused against, and the
 * engine's agreement ledger fingerprints the read-back the caller answered; the
 * two are compared, so two copies of this function would make that comparison
 * meaningless in a way nothing would report. A shared definition is the only
 * thing that makes the comparison mean anything at all.
 *
 * Not a hash for security and not stable across runtimes by contract -- it is
 * used only to ask "is this the same sentence as that one", within one process.
 *
 * @param {string} text
 * @returns {string}
 */
export function textFingerprint(text) {
  let h = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `k${h}`;
}

// ---------------------------------------------------------------------------
// A CALLER TURN THAT READS AS THE WRONG LANGUAGE. COUNT ONLY. NEVER GATES.
//
// isUnusableTranscript above is a script-range check, and its own comment names
// the limit this fills: "What this CANNOT detect is a transcript that is fluent
// Latin nonsense; that limit is real." On 2026-09-12 that limit cost two calls.
// An English caller asking to book a strategy call arrived as
// "Je pense que c'est une stratégie pas" -- fluent French, full Latin script,
// so the script check passed it -- and the assistant answered a different call
// than the one being made.
//
// THERE IS NO FIX AT THE SOURCE, which is why this only counts. The Live API
// exposes no way to constrain or even read the language of caller transcription:
// AudioTranscriptionConfig is an EMPTY interface in the SDK, RealtimeInputConfig
// carries only activity-detection fields, and the single languageCode on the
// session lives in speechConfig -- which governs the voice the model SPEAKS.
// Checked in the SDK types, and the read side was already recorded above.
//
// So the question this answers is "how often", not "what do we do about it".
// Four calls is an anecdote; a rate tells us whether this is a curiosity or the
// main thing wrong with the product. A miscount costs nothing because nothing
// acts on it -- which is also why it may use a word list without being the
// phrasing treadmill this codebase warns about. That warning is about GATING on
// an unbounded list of phrasings; counting is bounded and free.
//
// DELIBERATELY CONSERVATIVE, requiring positive evidence of another language
// rather than mere absence of English. "Best Electrical Dallas Texas Plumbing"
// is five words with no function words and is not foreign; without the marker
// requirement every list of proper nouns would be flagged.
// ---------------------------------------------------------------------------

/** Words an English sentence of any length is overwhelmingly likely to contain. */
const EN_FUNCTION_WORDS = new Set([
  "the", "a", "an", "i", "you", "to", "and", "is", "it", "of", "for", "in", "my", "me",
  "that", "do", "can", "have", "want", "was", "we", "on", "at", "be", "with", "this",
  "yes", "no", "please", "would", "like", "need", "what", "when", "book", "call", "im",
  "are", "there", "about", "just", "so", "but", "get", "was", "how", "all", "okay",
]);

/**
 * Function words that are common in other Latin-script languages and rare or
 * absent in English. Spanish is a SUPPORTED locale, so its markers are excluded
 * here and this check only ever runs against an English session.
 */
const NON_EN_MARKERS = new Set([
  // French
  "je", "que", "une", "pas", "pour", "avec", "est", "du", "au", "oui", "les", "des",
  "dans", "sur", "mais", "vous", "nous", "ce", "cette", "très", "bien", "merci",
  // German
  "der", "die", "das", "und", "ich", "nicht", "ein", "eine", "zu", "mit", "ist",
  "für", "auf", "sie", "haben", "sehr",
  // Portuguese / Italian. DELIBERATELY SHORT, and every omission is a Spanish
  // word. Spanish is a supported locale with real callers, so "para", "com" and
  // "una" are excluded even though they are also Portuguese: including them made
  // this flag "Sí, quiero una cita para el martes", which is a legitimate
  // caller rather than a transcription fault. Caught before shipping by the
  // existing Spanish fixture in tests/liveUnusableTranscript.test.js.
  //
  // The consequence is accepted: a Portuguese turn built only from words Spanish
  // shares will not be counted. Undercounting a rate is recoverable; a counter
  // inflated by ordinary traffic is worse than no counter, because it would read
  // as evidence of a fault that is not there.
  "você", "não", "che", "della", "sono", "molto", "anche", "perché",
]);

/** Smallest turn this will judge. Short real answers carry no function words. */
const MIN_WORDS_FOR_LANGUAGE_CHECK = 5;

/**
 * Does this caller turn look like a language other than English?
 *
 * COUNT ONLY. No caller is refused and no write is gated on this.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksNonEnglish(text) {
  if (!text || typeof text !== "string") return false;
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < MIN_WORDS_FOR_LANGUAGE_CHECK) return false;
  // Absence of English is not evidence of another language, only of proper nouns.
  if (words.some((w) => EN_FUNCTION_WORDS.has(w))) return false;
  return words.some((w) => NON_EN_MARKERS.has(w));
}
