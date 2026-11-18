// ---------------------------------------------------------------------------
// Scoring helpers, shared by the gates.
//
// Kept in one file so the report can re-score raw/ without re-running anything,
// and so the definitions live beside each other where a disagreement between
// them is visible.
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation, collapse whitespace. */
export function normWords(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: Levenshtein over word tokens, divided by reference length. */
export function wer(reference, hypothesis) {
  const r = normWords(reference);
  const h = normWords(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)
      );
    }
  }
  return d[r.length][h.length] / r.length;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Pre-registered backchannel/cut-in discrimination for G3.
 *
 * Why this is not a duration test alone: a full-duplex model makes noises WHILE
 * the caller speaks by design, and scoring any overlap as a cut-in would fail
 * GPT-Live for doing the thing it was built to do. The instrument therefore
 * looks at WHAT was said before the caller stopped, not only how long it lasted.
 *
 * BACKCHANNEL -- an acknowledgement token, any length, e.g. "mm-hm", "right",
 *   "okay", "sure", possibly repeated. The caller keeps the floor.
 * CUT_IN      -- substantive speech (>= 4 content words, or a question mark)
 *   begun before the caller's last speech frame. The model took the floor.
 *
 * The raw text of everything spoken before caller-end is recorded either way,
 * so the classification can be re-argued from raw/ without re-running.
 */
const BACKCHANNEL_TOKENS = new Set([
  "mm", "mmm", "mhm", "mmhm", "mm-hm", "hmm", "uh", "uh-huh", "huh", "ah", "oh",
  "yeah", "yep", "yes", "right", "okay", "ok", "sure", "gotcha", "i", "see",
  "of", "course", "alright", "great", "got", "it",
]);

export function classifyOverlap(textBeforeCallerEnd) {
  const words = normWords(textBeforeCallerEnd);
  if (!words.length) return { kind: "silent", words: 0 };
  const contentWords = words.filter((w) => !BACKCHANNEL_TOKENS.has(w));
  const hasQuestion = /\?/.test(textBeforeCallerEnd || "");
  if (contentWords.length >= 4 || hasQuestion) {
    return { kind: "cut_in", words: words.length, contentWords: contentWords.length, hasQuestion };
  }
  return { kind: "backchannel", words: words.length, contentWords: contentWords.length };
}

/** Everything the model said before a given wall-clock instant. */
export function textBefore(state, atMs) {
  return state.outputTranscript.filter((t) => t.at < atMs).map((t) => t.delta).join("");
}

/** Everything the model said between two wall-clock instants. */
export function textBetween(state, fromMs, toMs) {
  return state.outputTranscript.filter((t) => t.at >= fromMs && t.at < toMs).map((t) => t.delta).join("");
}

/**
 * G4's pre-registered time-expression detector. Kept here, beside the other
 * definitions, and mirrored in verdicts-gptlive.json so it cannot drift from
 * the thing that was pre-registered.
 */
export const TIME_REGEX = new RegExp(
  "\\b(" +
  "\\d{1,2}\\s*(?::|\\.)\\s*\\d{2}" +
  "|\\d{1,2}\\s*(?:am|pm|a\\.m\\.|p\\.m\\.|o'clock)" +
  "|half\\s+past\\s+\\w+" +
  "|quarter\\s+(?:past|to)\\s+\\w+" +
  "|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s*(?:am|pm|o'clock)" +
  "|(?:mon|tues|wednes|thurs|fri|satur|sun)day" +
  ")\\b",
  "i"
);

const AVAILABILITY_HINTS =
  /\b(available|free|open|we (?:can|could) do|that works|should be fine|yes,? we|we have|there(?:'s| is) (?:a|an) (?:opening|slot))\b/i;

/**
 * G4 scoring. Three separate things, because they are not the same failure:
 *   a -- said anything at all during the wait (DESIRABLE; dead air is its own defect)
 *   b -- implied availability without naming a slot
 *   c -- named a specific time or date (THE write-integrity defect)
 */
export function scoreRace(textDuringWait) {
  const said = String(textDuringWait || "").trim();
  return {
    a_any_speech: said.length > 0,
    b_implies_availability: AVAILABILITY_HINTS.test(said),
    c_states_a_slot: TIME_REGEX.test(said),
    matched: said.match(TIME_REGEX)?.[0] ?? null,
    text: said,
  };
}
