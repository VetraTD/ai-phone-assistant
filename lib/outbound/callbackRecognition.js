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
 * ORDER, and why. It runs AFTER the plain 4-argument createCall and the other
 * context fetches have settled (the caller calls it last inside the same
 * withTenantSafe), so a no-outreach call does exactly the work it always did.
 * Each database step here runs in its own SAVEPOINT (services/db.js
 * withSavepoint): a SQL error rolls back to it and the shared transaction
 * stays usable for everything else.
 *   1. look the caller up (bounded);
 *   2. LINK the already-written calls row to the outreach -- if that fails the
 *      call is NOT recognised (no "you called us" prompt over an unlinked row);
 *   3. close the outreach `called_back` (controller ruling R1) so a +10 minute
 *      retry cannot dial the lead mid-callback. Guarded to state 'waiting' in
 *      SQL: if the dispatcher moved it on meanwhile it is left alone (warn
 *      log), and recognition still stands -- the caller is on the line.
 * `callId` is required: no call row means nothing to link, so no recognition.
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
 * The callback as THIS call should see it: no leftover questions when the
 * caller already has an upcoming appointment.
 *
 * CAffb5c7, 2026-10-02: the caller had booked a discovery call (on another
 * campaign) and rang to cancel it; their number also matched a still-waiting
 * outreach, and the assistant asked that outreach's "what is the name of your
 * clinic?" before doing what they rang for. Someone with a booking on the
 * calendar is past qualification and is almost always ringing about that
 * booking, so the questions are dropped -- which removes both the "Questions
 * still unanswered" sentence and the record_answer declaration (both read
 * remainingQuestions). Recognition itself is unchanged: the call is still
 * linked and the outreach still closed called_back.
 *
 * "Upcoming" is the same test services/gemini.js buildCallerContextSection
 * applies: a scheduled_at in the future. Shared by the Live path and the
 * cascade so the two cannot drift.
 *
 * @param {object|null|undefined} callbackOutreach - recognizeCallback's result
 * @param {object|null|undefined} callerContext - the call-start caller snapshot
 * @returns {object|null} the same object when nothing changes
 */
export function callbackOutreachForCall(callbackOutreach, callerContext) {
  if (!callbackOutreach) return null;
  if (!(callbackOutreach.remainingQuestions || []).length) return callbackOutreach;
  const nowMs = Date.now();
  const hasUpcoming = (callerContext?.upcomingAppointments || []).some((a) => {
    const t = Date.parse(a?.scheduled_at);
    return Number.isFinite(t) && t > nowMs;
  });
  if (!hasUpcoming) return callbackOutreach;
  bumpCounter("outbound_callback_questions_suppressed");
  return { ...callbackOutreach, remainingQuestions: [] };
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
  callId = null,
  timeoutMs = CALLBACK_LOOKUP_TIMEOUT_MS,
  log = defaultLog,
}) {
  if (!callerPhone) return null;
  // No calls row (createCall failed) -> nothing to link -> never recognise.
  if (!callId) return null;
  let timer;
  let cancelled = false;
  try {
    // A missing function is a missing wire: it throws here (TypeError) and
    // lands in the catch as "not recognised" with a warn log, never silently.
    const lookup = Promise.resolve(database.openOutreachForPhone(callerPhone, { isCancelled: () => cancelled }));
    const hit = await Promise.race([
      lookup,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
      }),
    ]);
    if (hit === "__timeout__") {
      cancelled = true; // the lookup issues no further statement once it notices
      // The timeout decides only whether the RESULT is used. The lookup's
      // in-flight statement still has to settle -- success, or its ROLLBACK TO
      // SAVEPOINT after an error -- BEFORE this returns and the caller's scope
      // goes on to flush the audit and COMMIT. Otherwise a statement that
      // errors after the race (statement_timeout) aborts the shared
      // transaction ahead of its own rollback and takes createCall and the
      // other context fetches with it, and its late savepoint statements
      // could run on a released client. Postgres bounds the wait
      // (statement_timeout is pool-wide).
      await lookup.catch(() => {});
      bumpCounter("outbound_callback_lookup_failed");
      log.error("outbound_callback_lookup_failed", { callSid, businessId, reason: "timeout", severity: "warn" });
      return null;
    }
    if (!hit) return null;

    // A link that fails means NOT recognised: the prompt would say "you called
    // us" over a calls row that carries no outreach_id.
    await database.linkCallToOutreach(callSid, hit.outreachId, hit.contactId);

    try {
      const closed = await database.closeOutreachCalledBack(hit.outreachId);
      if (!closed) {
        log.error("outbound_callback_close_skipped", {
          callSid,
          outreachId: hit.outreachId,
          reason: "no longer waiting",
          severity: "warn",
        });
      }
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
