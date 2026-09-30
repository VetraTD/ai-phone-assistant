// lib/outbound/callbackRecognition.js
/**
 * S4-1 (spec §12.3): the ONE start-of-call helper the Live path
 * (lib/voice/live/index.js) and the cascade (lib/voice/session.js) share to
 * recognise a lead we called who is ringing back. INBOUND ONLY -- neither
 * caller invokes it on an outbound call.
 *
 * Runs inside the caller's tenant scope (withTenantSafe). Everything about it
 * fails toward "not recognised": a lookup that throws, a lookup that has not
 * answered within `timeoutMs` (it must never hold the greeting back), a
 * missing SUPPRESSION_HASH_KEY, a database object without the two functions.
 * "Not recognised" means the prompt and the declarations are exactly what they
 * were before this feature existed. The warn log carries the call SID and the
 * error message only -- never the phone number, never an answer.
 *
 * On a hit it closes the outreach `called_back` AT RECOGNITION (controller
 * ruling R1): a retry scheduled for +10 minutes must not dial the lead while
 * they are mid-callback. A close failure (the row changed under us) is logged
 * and the recognition still stands.
 *
 * Returns the `callbackOutreach` extras value, or null:
 *   { outreachId, campaignId, contactId, lastAttemptAt (ISO string), topic,
 *     remainingQuestions: [{key, ask, required}] }
 * `remainingQuestions` are the pinned questions with a usable key + ask whose
 * key is not yet in any call's answers for this outreach.
 */
import { log as defaultLog } from "../logger.js";
import { bumpCounter } from "../voice/metrics.js";

export const CALLBACK_LOOKUP_TIMEOUT_MS = 300;

/** Pinned questions still unanswered: askable (key + ask) and not in `answeredKeys`. */
export function remainingQuestionsOf(questions, answeredKeys) {
  const answered = new Set(Array.isArray(answeredKeys) ? answeredKeys : []);
  return (Array.isArray(questions) ? questions : [])
    .filter((q) => q && typeof q.key === "string" && q.key && typeof q.ask === "string" && q.ask.trim())
    .filter((q) => !answered.has(q.key))
    .map((q) => ({ key: q.key, ask: q.ask.trim(), required: Boolean(q.required) }));
}

/**
 * @param {object} args
 * @param {object} args.database - services/db.js (openOutreachForPhone, closeOutreachCalledBack)
 * @param {string} args.businessId
 * @param {string} args.callerPhone - E.164 as Twilio sent it; empty/withheld -> null
 * @param {string} [args.callSid]
 * @param {number} [args.timeoutMs]
 * @param {object} [args.log]
 * @returns {Promise<object|null>}
 */
export async function recognizeCallback({
  database,
  businessId,
  callerPhone,
  callSid = null,
  timeoutMs = CALLBACK_LOOKUP_TIMEOUT_MS,
  log = defaultLog,
}) {
  if (!callerPhone) return null;
  let timer;
  try {
    // A missing function is a missing wire: it throws here (TypeError) and
    // lands in the catch as "not recognised" with a warn log, never silently.
    const hit = await Promise.race([
      database.openOutreachForPhone(callerPhone),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
      }),
    ]);
    if (hit === "__timeout__") {
      bumpCounter("outbound_callback_lookup_failed");
      log.error("outbound_callback_lookup_failed", { callSid, businessId, reason: "timeout", severity: "warn" });
      return null;
    }
    if (!hit) return null;

    try {
      await database.closeOutreachCalledBack(hit.outreachId);
    } catch (err) {
      log.error("outbound_callback_close_failed", {
        callSid,
        outreachId: hit.outreachId,
        reason: err?.message,
        severity: "warn",
      });
    }

    const callbackOutreach = {
      outreachId: hit.outreachId,
      campaignId: hit.campaignId,
      contactId: hit.contactId,
      lastAttemptAt: new Date(hit.lastAttemptAt).toISOString(),
      topic: hit.topic || null,
      remainingQuestions: remainingQuestionsOf(hit.questions, hit.answeredKeys),
    };
    bumpCounter("outbound_callback_recognized");
    log.info("outbound_callback_recognized", {
      callSid,
      outreachId: callbackOutreach.outreachId,
      campaignId: callbackOutreach.campaignId,
    });
    return callbackOutreach;
  } catch (err) {
    bumpCounter("outbound_callback_lookup_failed");
    log.error("outbound_callback_lookup_failed", { callSid, businessId, reason: err?.message, severity: "warn" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
