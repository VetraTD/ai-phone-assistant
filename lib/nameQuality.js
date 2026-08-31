/**
 * How likely is it that we wrote this caller's name down wrong?
 *
 * From a live call: "Venkateshwaria Ayalavarapu" was stored as "Venkateshwaria
 * Ayalla Varpu". The surname came back as two mis-heard words, the assistant
 * never said it back, and never asked for a spelling — so nothing in the call
 * could have caught it. The business keeps that row.
 *
 * WHY NOT A LIST OF UNUSUAL NAMES
 *
 * Because we never see the name. We see what the recognizer returned. The
 * documented failure is "Nithin" coming back as "Nathan" — a very common name,
 * which any commonness check waves straight through, so the check agrees with
 * us only when the transcription was already right. It is blind precisely where
 * it is needed.
 *
 * It is also a fairness problem: a frequency list is a list of names common in
 * ONE language, so it would ask Akshar, Erling and Nithin to spell while never
 * asking Joe. For a receptionist sold in several markets that is a different
 * service depending on where your name is from.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Keys on transcription difficulty — properties of the string in front of us,
 * not of the name's origin. A long token is harder to hear correctly whether it
 * is Featherstonehaugh or Ayalavarapu, and a surname arriving as two tokens is
 * the recognizer telling us it was unsure.
 *
 * WHAT IT CANNOT DO
 *
 * Catch a confident mis-hearing of a SHORT name. "Nithin" to "Nathan" produces
 * a perfectly ordinary-looking string and this returns false for it. That case
 * is caught by reading the whole name back to the caller instead, which is the
 * layer that needs no threshold at all. This is the second line of defence, not
 * the first.
 */

/** Callers say "my name is X", not "X". Shared shape with lib/voice/fallbackFlow.js. */
const NAME_PREFIX_RE = /^\s*(my name is|this is|it's|i'm|i am|name's)\s+/i;

/** A token this long is hard to transcribe correctly, in any language. */
const LONG_TOKEN = 9;

/** Vowel groups approximate syllables well enough to rank difficulty. */
const MANY_SYLLABLES = 4;

/**
 * More pieces than a first and last name. The literal "Ayalla Varpu" signature:
 * one surname split into two words, which is evidence of uncertainty in itself.
 */
const MANY_TOKENS = 3;

/**
 * @param {*} raw - the name as the model captured it
 * @returns {boolean} true when it is worth confirming the spelling once
 */
export function looksHardToSpell(raw) {
  if (typeof raw !== "string") return false;
  const name = raw.replace(NAME_PREFIX_RE, "").trim();
  if (!name) return false;

  const tokens = name.split(/[\s-]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.length >= MANY_TOKENS) return true;

  for (const token of tokens) {
    const letters = token.replace(/[^\p{L}]/gu, "");
    if (letters.length >= LONG_TOKEN) return true;
    // Count vowel GROUPS, not vowels: "ea" in "Featherstone" is one nucleus.
    const vowelGroups = letters.match(/[aeiouy]+/gi);
    if (vowelGroups && vowelGroups.length >= MANY_SYLLABLES) return true;
  }

  return false;
}

/**
 * Normalize a name for comparison against one already on file: drop the
 * caller's spoken preamble, collapse whitespace, casefold. Deliberately loose —
 * this decides whether to ASK a question, and a false match costs one
 * un-asked question while a false miss costs the caller an interrogation.
 * @param {*} raw
 * @returns {string}
 */
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(NAME_PREFIX_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Should the receptionist ask this caller to spell their name, right now?
 *
 * The whole decision in one place, because it has three inputs and the old code
 * only consulted one of them (difficulty). A caller reported being asked for
 * their name and its spelling two or three separate times in a single call,
 * while OTHER callers still had their names stored wrong — a policy that is
 * simultaneously too eager and not eager enough is a policy split across too
 * many places.
 *
 * The rule, set by the owner on 2026-08-29: ask at most ONCE per call, only
 * when the name is not already on file, and only when something is about to be
 * written (the caller enforces that last part by only calling this on writes).
 *
 * @param {object} opts
 * @param {*} opts.name - the name as the model captured it
 * @param {object|null} [opts.callerContext] - the call-start caller snapshot
 * @param {boolean} [opts.spellingAlreadyAsked] - has this call spent its one ask
 * @param {"always"|"hard"|"off"} [opts.policy]
 * @returns {boolean}
 */
export function shouldConfirmSpelling({
  name,
  callerContext = null,
  spellingAlreadyAsked = false,
  policy = "always",
} = {}) {
  if (policy === "off") return false;
  if (spellingAlreadyAsked) return false;

  const normalized = normalizeName(name);
  if (!normalized) return false;

  // Already on file. The record IS the spelling — the business has had it
  // right since the last call, and asking again is the repetition callers
  // noticed. Nothing is read out to the caller here: a question is simply not
  // asked, so this does not touch the never-confirm-from-a-record rule.
  const onFile = (callerContext?.upcomingAppointments || [])
    .map((a) => normalizeName(a?.client_name))
    .filter(Boolean);
  if (onFile.includes(normalized)) return false;

  // "hard" is the pre-2026-08-29 behaviour, kept reachable by env so the extra
  // turn can be taken back out on real calls without a deploy.
  if (policy === "hard") return looksHardToSpell(name);
  return true;
}

/**
 * Which names get a spelling ask.
 *
 * "always" (default, set by the owner 2026-08-29): any name not already on the
 * caller's records, once per call, before it is written. "hard" is the
 * pre-2026-08-29 behaviour — only names looksHardToSpell flags. "off" disables
 * it entirely.
 *
 * Read at CALL time, not module load, so a Railway change takes effect on the
 * next call rather than the next deploy (the convention lib/transcriptUtils.js
 * documents for its own env reads).
 *
 * Lives here rather than in services/tools.js because two places need the same
 * answer: the gate that refuses a write, and the prompt block that tries to get
 * the question asked at a sensible moment so the gate never has to fire.
 *
 * @returns {"always"|"hard"|"off"}
 */
export function spellPolicy() {
  const v = (process.env.VOICE_SPELL_POLICY || "").trim().toLowerCase();
  return v === "hard" || v === "off" ? v : "always";
}

/**
 * Does the call-start caller snapshot already carry a name?
 *
 * Used to suppress the prompt's spelling nudge for a caller the business
 * already has on file. The code gate makes the same decision per-name, and
 * remains the guarantee — if this caller turns out to give a DIFFERENT name (a
 * shared handset), the gate still asks. This only stops the prompt from
 * volunteering a question the gate was never going to require.
 *
 * @param {object|null} callerContext
 * @returns {boolean}
 */
export function callerHasNameOnFile(callerContext) {
  return (callerContext?.upcomingAppointments || []).some(
    (a) => typeof a?.client_name === "string" && a.client_name.trim()
  );
}
