// What a phone network sends when the caller hid their number: words, or the
// keypad spellings Twilio uses for them (ANONYMOUS, RESTRICTED, BLOCKED,
// UNKNOWN, UNAVAILABLE; see lib/inboundGuards.js). They are not one caller, so
// nothing is ever looked up "from this number" for them. The frontend's
// calls/format.js keeps the same list for display.
const WITHHELD_WORDS = /^(anonymous|restricted|private|blocked|unknown|unavailable|withheld)$/i;
const WITHHELD_NUMBERS = new Set(["+266696687", "+7378742833", "+2562533", "+8656696", "+86282452253"]);

function isWithheld(number) {
  const v = typeof number === "string" ? number.trim() : "";
  return !v || WITHHELD_WORDS.test(v) || WITHHELD_NUMBERS.has(v);
}

module.exports = { isWithheld };
