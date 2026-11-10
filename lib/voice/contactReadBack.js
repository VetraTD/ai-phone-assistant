// ---------------------------------------------------------------------------
// Did the assistant read a CALLER'S contact details back? (Ilija inbound Task N,
// fix round 4.)
//
// The post-call message net used to wait for a declared message intent. A tenant
// with no allowed tasks is offered set_call_intent with the single value
// general_question, so on that tenant the intent can never be a message one --
// and that is the tenant the lost-lead call came from. What the net can see
// without an intent is the assistant saying a number or an email address back.
//
// But a business says its OWN numbers and addresses all the time ("you can reach
// the office on ..."), so those are excluded, and a spelled-out name is not
// counted at all: businesses spell their own names. Pure; the session compiles
// the business's contacts once per call (collectBusinessContacts) and tests each
// assistant turn against them (readsCallerContactBack).
// ---------------------------------------------------------------------------
import { digitRunValues } from "./askLedger.js";

// A number is compared by its LAST SEVEN digits, so "01372 656055",
// "+44 1372 656055" and "oh one three seven two six five six oh five five" are
// one number whatever prefix was said.
const TAIL = 7;

// local@domain.tld. Spoken forms are normalised first (" at " -> "@",
// " dot " -> "."), and a match needs the "@" AND a top-level domain, so ordinary
// prose ("open at 9 tomorrow") can never form one.
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/giu;

function normaliseSpoken(text) {
  return String(text || "")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s+dot\s+/gi, ".");
}

/** Every email address in `text`, lower-cased. */
export function emailsIn(text) {
  return (normaliseSpoken(text).match(EMAIL_RE) || []).map((e) => e.toLowerCase());
}

/** The last seven digits of one explicit phone field, or null if it has fewer. */
function tailOf(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= TAIL ? digits.slice(-TAIL) : null;
}

/** Every string in a config subtree (capability notes and the like), depth-bounded. */
function stringsIn(value, depth = 0, out = []) {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, depth + 1, out);
  else if (typeof value === "object") for (const v of Object.values(value)) stringsIn(v, depth + 1, out);
  return out;
}

/**
 * The business's own phone numbers and email addresses.
 *
 * @param {object} p
 * @param {object} [p.business] - the business row (snake_case columns)
 * @param {object} [p.config] - the normalised config (camelCase)
 * @param {string[]} [p.numbers] - any other number known to be the business's (the line this call came in on)
 * @returns {{ numbers: Set<string>, emails: Set<string> }} numbers as last-seven-digit strings
 */
export function collectBusinessContacts({ business, config, numbers = [] } = {}) {
  const nums = new Set();
  const emails = new Set();
  const addNumber = (v) => {
    const t = tailOf(v);
    if (t) nums.add(t);
  };
  const addProse = (text) => {
    if (typeof text !== "string") return;
    for (const run of digitRunValues(text)) nums.add(run.slice(-TAIL));
    for (const e of emailsIn(text)) emails.add(e);
  };

  for (const v of [
    business?.phone_number,
    business?.main_phone,
    business?.transfer_phone_number,
    business?.notification_phone,
    config?.businessPhone,
    config?.mainPhone,
    config?.transferPhoneNumber,
    ...numbers,
  ]) {
    addNumber(v);
  }
  if (typeof business?.notification_email === "string" && business.notification_email.trim()) {
    emails.add(business.notification_email.trim().toLowerCase());
  }
  for (const text of [
    business?.general_info,
    business?.custom_instructions,
    config?.generalInfo,
    config?.customInstructions,
    ...stringsIn(config?.capabilities),
  ]) {
    addProse(text);
  }
  return { numbers: nums, emails };
}

/**
 * Whether one assistant turn reads back a number or an email address that is
 * NOT one of the business's own. A spelled-out name alone never counts.
 *
 * @param {string} text - one assistant turn
 * @param {{ numbers: Set<string>, emails: Set<string> }} [contacts]
 * @returns {boolean}
 */
export function readsCallerContactBack(text, contacts) {
  const own = contacts || { numbers: new Set(), emails: new Set() };
  for (const run of digitRunValues(text)) {
    if (!own.numbers.has(run.slice(-TAIL))) return true;
  }
  for (const email of emailsIn(text)) {
    if (!own.emails.has(email)) return true;
  }
  return false;
}
