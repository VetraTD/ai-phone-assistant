/**
 * CommonJS mirror of the engine's lib/phone.js.
 *
 * The dashboard backend is a separate CommonJS package and cannot import the
 * engine's ESM module, so this is a deliberate second copy. A third copy exists
 * as normalize_phone_value() in database/024_normalize_phone_numbers.sql.
 *
 * All three MUST stay in step. tests/phone.test.js (engine) and
 * src/__tests__/phone.test.js (here) run the same table against both JS copies;
 * the SQL one is exercised by running the migration.
 *
 * Why this exists at all: businesses.phone_number is matched against Twilio's
 * `To` value with string equality. Every hand-entered row was stored with a
 * leading newline by the Supabase table editor, so the row was invisible to the
 * lookup and those businesses answered with the generic default config.
 */

const E164_RE = /^\+[1-9]\d{1,14}$/;

/**
 * Characters that carry no dialling information: ASCII whitespace, NBSP, the
 * U+2000–U+200D range, BOM, formatting punctuation, and unicode dashes.
 */
const NON_DIALLING_CHARS =
  /[\s  -‍﻿()./‐-―−-]/g;

/**
 * Normalize a raw phone value to E.164, or null if it cannot be trusted.
 * Deliberately does not guess a country code — an ambiguous national number
 * returns null so it is rejected with a visible error rather than silently
 * mapped to the wrong country.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizePhoneNumber(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.replace(NON_DIALLING_CHARS, "");
  if (!s) return null;

  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  return E164_RE.test(s) ? s : null;
}

/**
 * Strip formatting/whitespace without demanding a country code. For values that
 * are spoken to a caller rather than dialled by Twilio.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function stripPhoneFormatting(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.replace(NON_DIALLING_CHARS, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return s;
}

module.exports = { normalizePhoneNumber, stripPhoneFormatting };
