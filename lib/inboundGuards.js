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

const E164 = /^\+[1-9]\d{6,14}$/;

/** What Twilio sends as From when the caller withholds their number. */
const WITHHELD_PLACEHOLDERS = new Set(["+266696687", "+7378742833", "+86282452253", "+2562533"]);

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
    facts = await database.inboundGuardFacts({ businessId, from, countCalls: countable });
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
