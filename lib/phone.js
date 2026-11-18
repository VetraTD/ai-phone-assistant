/**
 * Phone-number normalization for the tenant-routing boundary.
 *
 * Why this exists: lookupBusinessByPhone matches the Twilio `To` value against
 * businesses.phone_number with string equality. Twilio always sends clean
 * E.164 ("+442079460958"), so any stored value that differs by a single
 * character is invisible to the lookup and the call silently falls through to
 * the "our office" default config.
 *
 * That is not hypothetical: every hand-entered business row was stored with a
 * LEADING NEWLINE ("\n+442079460958"), because Supabase's table editor renders
 * a text column as a multi-line textarea and saves a pasted newline verbatim.
 * The one business that worked was the one the app bought through the Twilio
 * API, whose value was never typed by a human.
 *
 * Deliberately does NOT guess a country code. A bare national number
 * ("020 7946 0958", "8176011171") is ambiguous, and guessing is how a UK
 * number silently becomes a US one. Ambiguous input returns null so it can be
 * rejected at the write boundary with a visible error.
 */

import { isValidE164 } from "./validate.js";

/**
 * Characters that carry no dialling information and are safe to drop:
 * ASCII whitespace, NBSP, the U+2000–U+200D range (en/em spaces, zero-width
 * space and friends), BOM, the punctuation humans format numbers with, and the
 * unicode dashes a word processor substitutes for a plain hyphen.
 */
const NON_DIALLING_CHARS =
  /[\s  -‍﻿()./‐-―−-]/g;

/**
 * Normalize a raw phone value to E.164, or null if it cannot be trusted.
 *
 * @param {unknown} raw - value as typed, pasted, or read from the database
 * @returns {string|null} E.164 ("+442079460958") or null when ambiguous/invalid
 */
export function normalizePhoneNumber(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.replace(NON_DIALLING_CHARS, "");
  if (!s) return null;

  // "00" is the international access prefix in most of the world; "+" is the
  // E.164 spelling of the same thing. No valid E.164 number starts with 0, so
  // this rewrite is unambiguous.
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  return isValidE164(s) ? s : null;
}

/**
 * True when a stored value would not survive an equality match against what
 * Twilio sends — i.e. it is damaged (whitespace, formatting) or unnormalizable.
 * Used by the migration and by write-path validation to report bad rows rather
 * than silently rewriting them.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function needsNormalization(raw) {
  if (raw === null || raw === undefined || raw === "") return false;
  return normalizePhoneNumber(raw) !== raw;
}

/**
 * Country of an E.164 number, for the two markets this product serves.
 *
 * READ-ONLY, and deliberately kept apart from normalizePhoneNumber. This module
 * refuses to GUESS a country code when writing, because that is how a UK number
 * silently becomes a US one. Reading a country back off a number that already
 * carries its prefix is the opposite operation: nothing is inferred and nothing
 * is stored. It exists so speech recognition can follow the caller's accent
 * rather than the business's chosen voice.
 *
 * Returns null for anything not clearly one of the two — including +1 numbers
 * in the wider North American plan, which share the prefix and are handled the
 * same way anyway.
 *
 * @param {string|null|undefined} e164
 * @returns {"US"|"GB"|null}
 */
export function countryFromE164(e164) {
  if (typeof e164 !== "string") return null;
  const trimmed = e164.trim();
  if (!trimmed.startsWith("+")) return null;
  if (/^\+44\d{7,}$/.test(trimmed)) return "GB";
  if (/^\+1\d{10}$/.test(trimmed)) return "US";
  return null;
}
