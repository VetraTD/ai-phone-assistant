/**
 * Input validation helpers for API routes.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{1,14}$/;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** UUID v4 format check. */
export function isValidUUID(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

/** E.164 phone number format check. */
export function isValidE164(s) {
  return typeof s === "string" && E164_RE.test(s);
}

/** 2-letter ISO country code check. */
export function isValidCountryCode(s) {
  return typeof s === "string" && COUNTRY_CODE_RE.test(s);
}

/** Basic email format check. */
export function isValidEmail(s) {
  return typeof s === "string" && EMAIL_RE.test(s);
}

/** Trim and cap string length. */
export function sanitizeString(s, maxLen = 1000) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxLen);
}
