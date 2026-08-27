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
