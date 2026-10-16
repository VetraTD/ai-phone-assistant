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
// therefore costs a refusal the caller clears by saying yes again, never a row
// at a time nobody agreed to.
//
// Measured 2026-09-13 against the real read-back from CAf1d6447d34
// ("...Wednesday, September 16th at 4 30 PM Central time...") and the test
// fixture, plus the variants below: 11/11.
//
// ---------------------------------------------------------------------------
// 2026-09-17: IT COULD NOT READ A SINGLE ONE OF gemini-3.8-live's OWN
// READ-BACKS, and that is why bookings were being lost.
//
// Every form this file generated was a DIGIT form -- "3:30 pm", "3 30 pm",
// "330pm". 3.8 speaks the clock in words. Census of the ten read-backs in
// call-corpus/ (seven real calls, 2026-09-16/17):
//
//     1  digit   "at 1 PM on Friday, September 18th"           <- the 3.1 call
//     6  word    "at three thirty PM"  "at three o'clock"  "at four-thirty PM"
//     3  neither (a spelling confirmation, naming no time)
//
// So `readBackMentionsSlot` returned false on EVERY 3.8 read-back, the consent
// latch could never hold, and `agreementSuperseded` refused the write instead --
// six times on CA03558d, which wrote zero rows and then told the caller "Yes, I
// have confirmed that your appointment is booked."
//
// The reverted fix 5232277 was built on this function and its tests passed only
// because they rewrote the live sentence -- "at ten o'clock" became "at 10 00
// AM" -- before asserting on it. A matcher tested against text the model does
// not produce is not a matcher.
//
// Word forms, scored on the real table: 20/20, against 10/20 for digits alone.
//
// NEVER A BARE HOUR WORD. "four" occurs in "the last four digits of the phone
// number" and "one" in "one second, let me look that up" -- both verbatim from
// the corpus. Every word form pairs the hour with a minute, a meridiem, or
// o'clock, so an hour word on its own can never match.
// ---------------------------------------------------------------------------

/** `2026-09-16T16:30` and friends. Seconds optional; anything else is unusable. */
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** Indexed by `hour12 % 12`, so 12 o'clock sits at 0. */
const HOUR_WORD = [
  "twelve",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
];

/**
 * Multiples of five only. A model that says "three seventeen" is not a shape
 * this corpus has ever contained, and inventing forms for it would widen the
 * surface without covering anything real -- those times keep the digit forms,
 * which is what they are spoken as anyway.
 */
const MINUTE_WORD = {
  5: "five",
  10: "ten",
  15: "fifteen",
  20: "twenty",
  25: "twenty five",
  30: "thirty",
  35: "thirty five",
  40: "forty",
  45: "forty five",
  50: "fifty",
  55: "fifty five",
};

const WEEKDAY = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

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

  // ---- the half 3.8 actually speaks ---------------------------------------
  // `normalize` turns "-" into a space, so "four-thirty PM" arrives here as
  // "four thirty pm" and the hyphen needs no form of its own.
  const hourWord = HOUR_WORD[hour12 % 12];
  const minuteWord = MINUTE_WORD[minute];
  for (const suffix of [meridiem, meridiem.replace("m", ".m.")]) {
    if (minute === 0) {
      forms.add(`${hourWord} o'clock`);
      forms.add(`${hourWord} ${suffix}`);
    } else if (minuteWord) {
      forms.add(`${hourWord} ${minuteWord}`);
      forms.add(`${hourWord} ${minuteWord} ${suffix}`);
    }
  }
  // The two phrasings the old header listed as known misses, plus the quarters.
  if (minute === 30) forms.add(`half past ${hourWord}`);
  if (minute === 15) forms.add(`quarter past ${hourWord}`);
  if (minute === 45) forms.add(`quarter to ${HOUR_WORD[(hour12 + 1) % 12]}`);
  if (hour24 === 12 && minute === 0) forms.add("noon");
  if (hour24 === 0 && minute === 0) forms.add("midnight");

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
 * Whether the read-back names a weekday, and every weekday it names is the
 * wrong one.
 *
 * A clock time alone cannot tell Friday at three from Thursday at three, and
 * the latch it feeds is what authorises the write. Absence of a weekday proves
 * nothing and is not held against the read-back -- "I have you down for three
 * thirty PM" is a perfectly good confirmation. But a read-back that names ONLY
 * other days is discussing another appointment, whatever the clock says.
 *
 * @param {string} haystack - already normalized
 * @param {string} naive
 * @returns {boolean}
 */
function weekdayContradicts(haystack, naive) {
  const m = NAIVE_DATETIME.exec(String(naive || ""));
  if (!m) return false;
  const want = WEEKDAY[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  const named = WEEKDAY.filter((day) => haystack.includes(day));
  return named.length > 0 && !named.includes(want);
}

/**
 * Whether `readBack` names the time in `naive`.
 *
 * @param {string} readBack - what the caller heard
 * @param {string} naive - the time about to be written
 * @param {{open?: boolean}} [opts] - `open`: the text may still be arriving
 *   (the read-back wait reads it chunk by chunk), so a bare hour that is the
 *   LAST word proves nothing yet -- "at ten" may go on " thirty".
 * @returns {boolean} false when unknown, deliberately -- see the header
 */
export function readBackMentionsSlot(readBack, naive, { open = false } = {}) {
  const forms = spokenTimeForms(naive);
  if (!forms) return false;
  const haystack = normalize(readBack);
  if (!haystack) return false;
  if (weekdayContradicts(haystack, naive)) return false;
  // Whole words (round A1 part 4, M): by substring "1 pm" sat inside "11 pm",
  // so a read-back of 11 p.m. vouched for a 1 p.m. write. normalize leaves
  // single spaces and no edge space, so padding both sides is a word bound;
  // a colon or quote at a word's EDGE ("3 pm:", "'3 pm'") is dropped first,
  // inside one ("2:00", "o'clock") it stays (review M8).
  const padded = ` ${haystack.replace(/(^| )[':]+/g, "$1").replace(/[':]+(?= |$)/g, "")} `;
  // A full stop or comma after the last word closes it, even mid-stream --
  // but not a full stop right after a digit: "at 10." may be "at 10.30"
  // (re-review M4).
  const openEnd = open && !/(?:[,!?;:]|(?<![0-9])\.)["')\]]*$/.test(String(readBack).trimEnd());
  return (
    forms.some((form) => padded.includes(` ${normalize(form)} `)) || weekdayBareHour(haystack, naive, openEnd)
  );
}

// Between a weekday and a bare hour only a date may sit ("Wednesday, October
// 21 at 10"), never a part of the day ("Wednesday evening at 10").
const MONTH =
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

/**
 * Round A1 part 4, F-C (CAdefce6ab). "Wednesday at 10 for Priya Raman,
 * booking that now" -- the shape our own flow steps taught -- matched no form
 * above, so the gate never saw the model's read-back and handed it a second.
 *
 * A bare hour is read ONLY: right after the slot's own weekday (only a date may
 * sit between: "Wednesday, October 21 at 10"), on the hour, for a slot whose
 * hour has ONE reading in 08:00-18:59 (8-11 a.m., noon, 1-6 p.m.; owner,
 * 2026-10-16: 7 is out, its a.m. and p.m. were both in the old 07:00-19:59),
 * word-bounded ("at 1" never matches "at 10"), and with no minute, meridiem,
 * o'clock or part of the day after it ("at 10 in the evening") -- the forms
 * above were checked and disagreed. Never a bare hour on its own (the
 * header's "last four digits").
 *
 * @param {string} haystack - already normalized
 * @param {string} naive
 * @param {boolean} [openEnd] - the hour may not be the last word (text still arriving)
 * @returns {boolean}
 */
function weekdayBareHour(haystack, naive, openEnd = false) {
  const m = NAIVE_DATETIME.exec(String(naive || ""));
  if (!m) return false;
  const hour24 = Number(m[4]);
  if (Number(m[5]) !== 0 || hour24 < 8 || hour24 > 18) return false;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const day = WEEKDAY[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  const minuteWords = Object.values(MINUTE_WORD).join("|");
  // Open text (re-review M2): the hour needs a WHOLE next word (a space after
  // it) that cannot begin a minute, meridiem or part of the day still being
  // spoken ("at 10 in", "at 10 p", "at 10 thir") -- the checks below then see
  // the finished phrase. Only a delay: the wait's turn end, timeout and close
  // judge the whole text strictly.
  const end = openEnd ? "(?= (?!(?:in|at|this|a|p|o|the) )\\S+ )" : "(?= |$)";
  const re = new RegExp(
    `(?:^| )${day}(?: (?:${MONTH}))?(?: the)?(?: \\d{1,2}(?:st|nd|rd|th)?)? at (?:${hour12}|${HOUR_WORD[hour12 % 12]})` +
      end +
      `(?! (?:a m|p m|am|pm|o'clock|oclock|\\d+|${minuteWords})(?: |$))` +
      `(?! (?:in the (?:morning|afternoon|evening)|at night|tonight|this (?:morning|afternoon|evening))(?: |$))`
  );
  return re.test(haystack);
}
