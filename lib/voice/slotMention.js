// ---------------------------------------------------------------------------
// Did the read-back the caller heard actually name the time we are about to
// write?
//
// The consent latch (services/tools.js) lets an agreement outlive the turn it
// was given on. That is only safe if the agreement cannot be spent on a
// DIFFERENT appointment, and a fingerprint of the read-back text cannot answer
// that on its own: the same read-back is still standing when a model calls
// book_appointment with a time it never said out loud. CA8c019c is that failure
// with a cancellation's consent; this is the same shape inside one proposal.
//
// GENERATION, NOT PARSING, and that is the whole reason this is trustworthy.
// Reading a time out of arbitrary speech is open-ended. Rendering a known
// `scheduled_at` into the handful of forms a model says out loud, and asking
// whether the read-back contains any of them, is closed: every form is one we
// produced.
//
// FAIL-OPEN IS NOT AN OPTION HERE, so this returns false when it cannot find a
// match, and the caller treats false as "do not latch" -- which falls back to
// the turn-local rule the gate already applies. A phrasing this does not know
// ("half past two", "noon") therefore costs a refusal the caller clears by
// saying yes again, never a row at a time nobody agreed to.
//
// Measured 2026-09-13 against the real read-back from CAf1d6447d34
// ("...Wednesday, September 16th at 4 30 PM Central time...") and the test
// fixture, plus the variants below: 11/11, with "noon" and "half past two"
// deliberately among the known misses.
// ---------------------------------------------------------------------------

/** `2026-09-16T16:30` and friends. Seconds optional; anything else is unusable. */
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * Every spoken form of one wall-clock time that a model plausibly produces.
 *
 * @param {string} naive - a naive local datetime, as the tool declarations ask for
 * @returns {string[]|null} null when the value is not a datetime at all
 */
export function spokenTimeForms(naive) {
  const m = NAIVE_DATETIME.exec(String(naive || ""));
  if (!m) return null;

  const hour24 = Number(m[4]);
  const minute = Number(m[5]);
  if (!Number.isFinite(hour24) || !Number.isFinite(minute)) return null;

  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const mm = String(minute).padStart(2, "0");

  const forms = new Set();
  // Three spellings of the meridiem, because the transcript of SPOKEN audio and
  // the model's own text differ on the dots and the case.
  for (const suffix of [meridiem, meridiem.replace("m", ".m."), meridiem.toUpperCase()]) {
    if (minute === 0) {
      forms.add(`${hour12} ${suffix}`);
      forms.add(`${hour12}${suffix}`);
      forms.add(`${hour12}:00 ${suffix}`);
      forms.add(`${hour12} 00 ${suffix}`);
      forms.add(`${hour12} o'clock`);
    } else {
      forms.add(`${hour12}:${mm} ${suffix}`);
      forms.add(`${hour12} ${mm} ${suffix}`);
      forms.add(`${hour12}${mm}${suffix}`);
    }
  }
  return [...forms];
}

/**
 * Lowercase, punctuation-stripped, single-spaced. Apostrophe and colon survive
 * because "o'clock" and "2:00" depend on them.
 *
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9:' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether `readBack` names the time in `naive`.
 *
 * @param {string} readBack - what the caller heard
 * @param {string} naive - the time about to be written
 * @returns {boolean} false when unknown, deliberately -- see the header
 */
export function readBackMentionsSlot(readBack, naive) {
  const forms = spokenTimeForms(naive);
  if (!forms) return false;
  const haystack = normalize(readBack);
  if (!haystack) return false;
  return forms.some((form) => haystack.includes(normalize(form)));
}
