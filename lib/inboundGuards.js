/**
 * Inbound call guards (batch-3 S4), shared by /twilio/live-voice and
 * /twilio/voice so both front-ends behave identically.
 *
 * Two kinds of refusal, in this order:
 *   1. the block list: the one guard allowed to turn a caller away, and only
 *      on a MATCH;
 *   2. the loop guard: a call arriving from a number we just dialled (a
 *      forward-all bounce) is refused, because answering it would ring the
 *      business's own phone into a loop.
 * Then a count: one caller ringing more than 30 times a day is an alert, never
 * a refusal.
 *
 * FAILS OPEN. A guard that could stop a real caller reaching the business must
 * not do so because its lookup broke: any throw answers the call.
 */

import { log } from "./logger.js";
import { normalizePhoneNumber, last4 } from "./phone.js";

/** Prior calls today at which the NEXT call raises the repeat-caller alert. */
export const REPEAT_CALLS_ALERT_AT = 30;

/**
 * AI seconds one caller may use at one business in a UTC day before the
 * repeat_caller_minutes alert fires (30 minutes). An alert, never a refusal.
 */
export const AI_MINUTES_ALERT_SEC = 1800;

/**
 * Longest the inbound guard lookup may take before the call is answered
 * anyway. Twilio gives a webhook 15 s; the pool alone can spend ~11 s (5 s
 * connect + 6 s statement), so an unbounded guard could turn a slow database
 * into "application error". The business lookup before the guard can itself
 * take ~11 s, so lookup + guard must stay under Twilio's 15 s: hence 2 s.
 * A timeout is treated exactly like a DB error.
 */
export const INBOUND_GUARD_TIMEOUT_MS = 2000;

/**
 * Longest the awaited pending-dial write may take on a transfer before the
 * call is handed over anyway (otherwise up to ~11 s of dead air after "let me
 * put you through"). 2 s for the same reason as above: the business lookup
 * (~11 s: 5 s pool connect + 6 s statement) plus this must stay under
 * Twilio's 15 s webhook limit. A timeout is treated exactly like a write error.
 */
export const PENDING_DIAL_WRITE_TIMEOUT_MS = 2000;

/**
 * Race `promise` against a timer. Rejects with Error("timeout") if the timer
 * wins; the timer is always cleared when the promise settles first, and a
 * late settlement of the losing promise is swallowed (no unhandled rejection).
 */
export function withTimeout(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(new Error("timeout")), ms);
  });
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  return Promise.race([guarded, timeout]).finally(() => clearTimer(timer));
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** What Twilio sends as From when the caller withholds their number. */
const WITHHELD_PLACEHOLDERS = new Set(["+266696687", "+7378742833", "+86282452253", "+2562533"]);

/**
 * True when `from` is one of Twilio's withheld-number placeholders, in any
 * stored format. For checks that keep their own looser shape test (the
 * prompt's caller-number block) but must still never treat a withheld caller
 * as having a number. LVX189 review fix round 1.
 */
export function isWithheldCallerNumber(from) {
  if (typeof from !== "string" || !from.trim()) return false;
  return WITHHELD_PLACEHOLDERS.has(normalizePhoneNumber(from) ?? from.trim());
}

/** True for a real, countable caller number (not withheld, not malformed). */
export function isRealCallerNumber(from) {
  return typeof from === "string" && E164.test(from) && !WITHHELD_PLACEHOLDERS.has(from);
}

/** True when `from` is one of the business's own numbers (any stored format). */
export function isOwnNumber(business, from) {
  const caller = normalizePhoneNumber(from);
  if (!caller || !business) return false;
  return [business.phone_number, business.main_phone, business.transfer_phone_number, business.notification_phone].some(
    (own) => normalizePhoneNumber(own) === caller
  );
}

/**
 * The number a call is recorded and answered under. The business's own number
 * (a call forwarded from it, or placed from one of its phones) is not a
 * customer, and neither is a From that merely repeats the forwarding number.
 * Empty means no caller number: no number read-back, no history, no callback
 * fallback. Only the TwiML stream parameter uses this; guards keep the raw From.
 */
export function callerIdentityNumber(business, from, forwardedFrom) {
  if (isOwnNumber(business, from)) return "";
  const fwd = normalizePhoneNumber(forwardedFrom);
  if (fwd && normalizePhoneNumber(from) === fwd) return "";
  return from;
}

/**
 * @returns {Promise<string|null>} TwiML to refuse the call, or null to answer it.
 * Never throws.
 */
export async function inboundGuardTwiml({ database, business, from, callSid, route }) {
  if (!business || !business.id) return null;
  const businessId = business.id;
  const own = isOwnNumber(business, from);
  const countable = isRealCallerNumber(from) && !own;

  let facts;
  try {
    facts = await withTimeout(
      database.inboundGuardFacts({ businessId, from, countCalls: countable }),
      INBOUND_GUARD_TIMEOUT_MS
    );
  } catch (err) {
    log.error("inbound_guard_failed", { callSid, businessId, route, message: err?.message, severity: "warn" });
    return null;
  }
  if (!facts) return null;

  if (facts.blocked) {
    log.info("inbound_caller_blocked", { callSid, businessId, route, callerLast4: last4(from) });
    return '<Response><Reject reason="rejected"/></Response>';
  }
  if (facts.bounced) {
    log.error("transfer_loop_refused", { callSid, businessId, route, severity: "warn" });
    return '<Response><Reject reason="busy"/></Response>';
  }
  if (countable && facts.callsToday === REPEAT_CALLS_ALERT_AT) {
    log.error("repeat_caller_calls", {
      callSid,
      businessId,
      callerLast4: last4(from),
      count: facts.callsToday + 1,
      severity: "warn",
    });
  }
  return null;
}
