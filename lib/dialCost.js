// Number block: nobody can make us dial or text an expensive number.
//
// Every number is checked against a committed snapshot of Twilio's price list
// (lib/dialCostTable.json, refreshed by scripts/refresh-dial-costs.mjs).
// Money guards fail CLOSED: a missing or malformed table makes this module
// throw at import, so the process refuses to boot rather than allow-all.
//
// This file is vendored byte-for-byte into the dashboard as
// AI-phone-dashboard/backend/src/dialCost.mjs (loaded with await import()).
// It may therefore import ONLY node:fs and node:url.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const AUTO_MAX_PER_MIN = 0.10;
export const HARD_MAX_PER_MIN = 0.60;
export const TEXT_MAX_EACH = 0.25;

export const REFUSAL_MESSAGES = {
  invalid:
    "That doesn't look like a full international number. Use the + format with the country code, for example +442079460958.",
  unknown:
    "We can't find a price for this number, so we can't call or text it. Please use a different number, or contact VetraTD support.",
  never:
    "This is a premium-rate, personal or special-rate number, which we never call or text. Please use a regular landline or mobile number.",
  over_ceiling: "Calls or texts to this number cost more than we allow. Please use a different number.",
  needs_switch_on:
    "Calls to this number cost more than our standard rate. VetraTD support can switch on pricier numbers for your account, or please use a different number.",
};

const E164 = /^\+[1-9]\d{6,14}$/;
// Twilio prices US 900/976 etc. under plain +1 at about 1.4 cents, so this list is the only guard.
const NANP_NEVER = /^\+1(?:900|976|500|52[1-9]|533|544|566|577|588|700)/;
const NEVER_CATEGORIES = new Set(["premium", "personal", "satellite", "pager", "shared"]);
const CATEGORIES = new Set([...NEVER_CATEGORIES, "special", "mobile", "fixed"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function parseTable(text) {
  let t;
  try {
    t = JSON.parse(text);
  } catch {
    throw new Error("dialCost table: not valid JSON");
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("dialCost table: not an object");
  if (typeof t.fetched !== "string" || Number.isNaN(new Date(t.fetched).getTime())) {
    throw new Error("dialCost table: bad fetched date");
  }
  const { voice, sms } = t;
  if (!voice || typeof voice !== "object" || Array.isArray(voice) || Object.keys(voice).length === 0) {
    throw new Error("dialCost table: voice missing or empty");
  }
  for (const [prefix, v] of Object.entries(voice)) {
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !isNum(v[0]) ||
      typeof v[1] !== "string" ||
      !/^[A-Z]{2}$/.test(v[1]) ||
      !CATEGORIES.has(v[2]) ||
      !/^\d+$/.test(prefix)
    ) {
      throw new Error(`dialCost table: bad voice entry for prefix ${prefix}`);
    }
  }
  if (!sms || typeof sms !== "object" || Array.isArray(sms) || Object.keys(sms).length === 0) {
    throw new Error("dialCost table: sms missing or empty");
  }
  for (const [iso, v] of Object.entries(sms)) {
    if (!isNum(v)) throw new Error(`dialCost table: bad sms price for ${iso}`);
  }
  return t;
}

export function makeChecker(table) {
  const voice = table.voice;
  const sms = table.sms;
  let maxLen = 0;
  for (const k of Object.keys(voice)) if (k.length > maxLen) maxLen = k.length;

  function callCostOf(e164) {
    if (typeof e164 !== "string" || !E164.test(e164)) return null;
    const digits = e164.slice(1);
    for (let n = Math.min(maxLen, digits.length); n >= 1; n--) {
      const hit = voice[digits.slice(0, n)];
      if (hit) return { perMin: hit[0], iso: hit[1], category: hit[2] };
    }
    return null;
  }

  // Shared first half of both checks. Returns a refusal, or { cost } to continue.
  function screen(e164) {
    if (typeof e164 !== "string" || !E164.test(e164)) return { refuse: { ok: false, reason: "invalid" } };
    if (NANP_NEVER.test(e164)) return { refuse: { ok: false, reason: "never" } };
    const cost = callCostOf(e164);
    if (!cost) return { refuse: { ok: false, reason: "unknown" } };
    const { perMin, iso, category } = cost;
    if (NEVER_CATEGORIES.has(category)) return { refuse: { ok: false, reason: "never", perMin, iso } };
    if (category === "special" && perMin > AUTO_MAX_PER_MIN) {
      return { refuse: { ok: false, reason: "never", perMin, iso } };
    }
    return { cost };
  }

  function checkDial(e164, { allowPricier = false } = {}) {
    const s = screen(e164);
    if (s.refuse) return s.refuse;
    const { perMin, iso } = s.cost;
    if (perMin > HARD_MAX_PER_MIN) return { ok: false, reason: "over_ceiling", perMin, iso };
    if (perMin > AUTO_MAX_PER_MIN && allowPricier !== true) {
      return { ok: false, reason: "needs_switch_on", perMin, iso };
    }
    return { ok: true, perMin, iso };
  }

  function checkText(e164) {
    const s = screen(e164);
    if (s.refuse) return s.refuse;
    const { iso } = s.cost;
    const price = sms[iso];
    if (price === undefined) return { ok: false, reason: "unknown", iso };
    if (price > TEXT_MAX_EACH) return { ok: false, reason: "over_ceiling", price, iso };
    return { ok: true, price, iso };
  }

  return { callCostOf, checkDial, checkText };
}

// Read at import. Any failure here throws and takes the process down on purpose.
const TABLE = parseTable(readFileSync(fileURLToPath(new URL("./dialCostTable.json", import.meta.url)), "utf8"));
const DEFAULT = makeChecker(TABLE);

export const callCostOf = DEFAULT.callCostOf;
export const checkDial = DEFAULT.checkDial;
export const checkText = DEFAULT.checkText;

export function tableAgeDays(now = new Date()) {
  return Math.floor((now.getTime() - new Date(TABLE.fetched).getTime()) / 86400000);
}
