/**
 * Did the caller actually spell their name — or actually refuse to?
 *
 * WHY THIS EXISTS
 *
 * The spelling gate in services/tools.js has always opened on the wrong
 * signal. Both of its stops measure what the ASSISTANT said: `spellAsks`
 * increments when the reply matches strings.js spellRequestRe, and
 * `spellingRefused` was set unconditionally the first time the gate fired. So
 * a caller who was asked to spell their name and simply carried on talking
 * about something else got their mis-heard name written to the database, and
 * the call never noticed. Asking is not the same as being answered, and only
 * the second one is worth blocking a write for.
 *
 * Nothing in this codebase has ever looked at the caller's side of that
 * exchange. lib/nameQuality.js says outright that it cannot catch a confident
 * mis-hearing of a short name ("Nithin" -> "Nathan"), because the string it is
 * handed looks perfectly ordinary. Letters are the only thing that can catch a
 * letter error. This module is what reads them.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not rebuild the name from the letters. That is the model's job, and
 * services/gemini.js states it as a rule ("THE LETTERS WIN"). This answers one
 * narrower question — has a spelling happened at all — because that is what a
 * gate needs and it is the part a prompt cannot be trusted to remember.
 *
 * TUNED FOR A MISS, NOT A FALSE POSITIVE
 *
 * A miss costs the caller one repeated question, bounded by the ask cap. A
 * false positive lets a wrong name through silently and the business keeps
 * that row — the exact failure this whole area exists to close. So every
 * threshold below is set where ordinary speech cannot reach it.
 */

/**
 * Split on the characters a spelled-out name arrives with. Deepgram returns
 * these several ways depending on how the caller paced it — "N I T H I N",
 * "N-I-T-H-I-N", "N. I. T. H. I. N." — and smart_format may punctuate any of
 * them. Apostrophes are deliberately NOT separators: splitting "I'm" would
 * manufacture a single-letter token out of an ordinary contraction.
 */
const SEPARATORS = /[\s,.;:\-–—/\|]+/;

/**
 * Single letters in a row. Three is enough: no ordinary English or Spanish
 * sentence puts three consecutive one-letter words together, and a caller
 * spelling anything at all produces at least this many.
 */
const MIN_LETTER_RUN = 3;

/**
 * Letters that are also words on their own ("a", "I", "o", "y"). A run made
 * ENTIRELY of these is not evidence of spelling, so at least one letter in the
 * run must be something else.
 */
const WORD_LETTERS = new Set(["a", "i", "o", "y"]);

/**
 * "B as in Boy", "N as in November". Two of these is a spelling; one alongside
 * a letter run is too (handled by the run rule independently).
 */
const AS_IN_EN = /\b([a-z])\s+(?:as|like)\s+in\b/gi;
const AS_IN_ES = /\b([a-z])\s+de\b/gi;
const MIN_AS_IN = 2;

/**
 * Spoken letter NAMES, for when the recognizer transcribes the sound rather
 * than the letter. The weakest of the three signals by a distance — most of
 * these are ordinary words ("see", "you", "oh", "why", "bee") — so it needs a
 * longer run than the others before it counts.
 */
const LETTER_WORDS_EN = new Set([
  "ay", "aye", "bee", "cee", "see", "dee", "ee", "ef", "eff", "gee", "aitch",
  "haitch", "eye", "jay", "kay", "el", "ell", "em", "en", "oh", "pee", "cue",
  "queue", "ar", "arr", "ess", "tee", "yu", "vee", "ex", "wye", "zed", "zee",
]);
const LETTER_WORDS_ES = new Set([
  "be", "ce", "che", "de", "efe", "ge", "hache", "jota", "ka", "ele", "elle",
  "eme", "ene", "eñe", "pe", "cu", "erre", "ere", "ese", "te", "uve", "equis",
  "ye", "zeta",
]);
const MIN_LETTER_WORD_RUN = 4;

/** Longest run of consecutive tokens satisfying `pred`. */
function longestRun(tokens, pred) {
  let best = 0;
  let run = 0;
  let bestHadSignal = false;
  let runHadSignal = false;
  for (const t of tokens) {
    const hit = pred(t);
    if (!hit) {
      run = 0;
      runHadSignal = false;
      continue;
    }
    run += 1;
    if (hit === "signal") runHadSignal = true;
    if (run > best) {
      best = run;
      bestHadSignal = runHadSignal;
    } else if (run === best && runHadSignal) {
      bestHadSignal = true;
    }
  }
  return { length: best, hadSignal: bestHadSignal };
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(SEPARATORS)
    .filter(Boolean);
}

function countMatches(text, re) {
  // Fresh lastIndex every call — these are module-level /g regexes.
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/**
 * Has the caller spelled something out in this turn?
 *
 * @param {*} text - the caller's transcript for one turn
 * @param {object} [strings] - the call's locale table (lib/voice/strings.js);
 *   only its `lang` is read, so passing nothing is safe and means English.
 * @returns {boolean}
 */
export function looksLikeSpelling(text, strings = null) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  const es = strings?.lang === "es";

  // 1. A run of single letters. The primary signal, and the one Deepgram
  //    produces for a caller who spells at any normal pace.
  const tokens = tokenize(raw);
  const letters = longestRun(tokens, (t) => {
    if (t.length !== 1) return false;
    if (!/\p{L}/u.test(t)) return false;
    return WORD_LETTERS.has(t) ? true : "signal";
  });
  if (letters.length >= MIN_LETTER_RUN && letters.hadSignal) return true;

  // 2. "B as in Boy". Two of them, because one can appear in ordinary speech
  //    ("a as in the letter grade").
  if (countMatches(raw, es ? AS_IN_ES : AS_IN_EN) >= MIN_AS_IN) return true;

  // 3. Spelled letter names. Longest threshold because most of these words
  //    mean something else.
  const lexicon = es ? LETTER_WORDS_ES : LETTER_WORDS_EN;
  const named = longestRun(tokens, (t) => (lexicon.has(t) ? "signal" : false));
  if (named.length >= MIN_LETTER_WORD_RUN) return true;

  return false;
}

/**
 * The caller declining to spell — including the soft, polite forms, because
 * "it's spelt how it sounds" is a refusal and pressing on after it is exactly
 * the nagging that got reported.
 *
 * Only ever consulted on the turn immediately after a spelling request (see
 * lib/voice/replyState.js). That context is what makes a bare "no" safe to
 * read as a refusal here when it would mean anything at all elsewhere.
 */
const REFUSAL_EN =
  /\b(no need|don'?t need|no thanks|no thank you|that'?s fine|it'?s fine|that'?s ok(ay)?|don'?t worry|no worries|(just )?(as|how|like) it sounds|spel+(t|ed) (like|how|as) it sounds|the (usual|normal|standard|obvious) (way|spelling)|standard spelling|rather not|skip (that|it)|don'?t bother|not necessary|nevermind|never mind)\b/i;
const REFUSAL_ES =
  /\b(no hace falta|no es necesario|está bien|esta bien|no importa|como suena|se escribe como suena|no, gracias|déjelo|dejelo|olvídelo|olvidelo)\b/i;

/** A whole-utterance "no", which only reads as a refusal in this position. */
const BARE_NO_EN = /^(no|nope|nah|no\.?)$/i;
const BARE_NO_ES = /^(no|no\.?)$/i;

/**
 * @param {*} text - the caller's transcript for one turn
 * @param {object} [strings] - the call's locale table; only `lang` is read
 * @returns {boolean}
 */
export function looksLikeSpellingRefusal(text, strings = null) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const es = strings?.lang === "es";
  if ((es ? BARE_NO_ES : BARE_NO_EN).test(raw)) return true;
  return (es ? REFUSAL_ES : REFUSAL_EN).test(raw);
}
