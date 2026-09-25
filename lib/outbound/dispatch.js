// lib/outbound/dispatch.js
/**
 * Dispatch one outreach (spec §10.1). Two properties make a retried or
 * duplicated task safe, and G6 tests both against real Postgres:
 *   1. SELECT ... FOR UPDATE SKIP LOCKED -- a concurrent dispatcher skips.
 *   2. UNIQUE (outreach_id, attempt_no) -- if two ever pass 1, the insert loses.
 * Twilio is called AFTER the tenant transaction commits, so a slow Twilio never
 * holds a row lock, and a crash between commit and create leaves an attempt
 * with no CallSid that post-call's sweep closes (Task 20).
 *
 * CAPACITY is serialised: every dispatch transaction first takes one global
 * advisory lock, so two concurrent dispatches for DIFFERENT outreach cannot
 * both read "1 line free" and both dial (Cloud Tasks runs up to 5 at once).
 * The lock is held only for the short transaction, not for the Twilio call.
 * callerIdValid() is inside the transaction but cached for an hour per number,
 * so at most one Twilio REST read per number per hour runs under the lock.
 */
import { evaluateGate } from "./gate.js";
import { computeAttemptAt, applyWindow, contactTimezone } from "./schedule.js";
import { zonedComponentsToUtcMs } from "../capabilities/datetime.js";
import { bumpCounter } from "../voice/metrics.js";

export function createDispatcher({ db, twilio, enqueue, env, now = () => new Date(), rand = Math.random, callerIdValid, renderAudio, log }) {
  return async function dispatch({ businessId, outreachId }) {
    const phase = await db.withTenant(businessId, async () => {
      await db.lockCapacity(); // SELECT pg_advisory_xact_lock(hashtext('outbound_capacity'))
      const r = await db.claimOutreachForDispatch(outreachId);
      if (!r || r.state !== "waiting") return { status: "skipped" };
      const t = now();
      const tz = contactTimezone({ timezone: r.contact_timezone, phone_e164: r.phone_e164 }, r.business_timezone);
      const [suppressed, consents, hasRelationship, dialsToday, active, idOk] = await Promise.all([
        db.isSuppressed(r.phone_e164),
        db.listConsents(r.contact_id),
        r.compliance_class === "service" ? db.hasServiceRelationship(r.phone_e164) : Promise.resolve(false),
        db.countDialsSince(r.phone_e164, startOfLocalDay(t, tz)),
        db.activeDialCounts(businessId),
        callerIdValid(r.config.caller_id),
      ]);
      const verdict = evaluateGate({
        now: t, env,
        business: { outbound_enabled: r.outbound_enabled, outbound_max_concurrent: r.outbound_max_concurrent },
        campaign: { status: r.campaign_status, compliance_class: r.compliance_class, template_key: r.template_key, config: r.config },
        contact: { phone_e164: r.phone_e164, timezone: tz },
        outreach: { attempts_made: r.attempts_made, created_at: r.created_at, hold_until: r.hold_until },
        suppressed, consents, hasRelationship, dialsToday, active, callerIdValid: idOk,
      }, { rand });

      if (verdict.verdict === "never") {
        await db.closeOutreach(outreachId, verdict.reason);
        return { status: "closed", reason: verdict.reason };
      }
      if (verdict.verdict === "later") {
        // at === null (a paused campaign) PARKS the outreach: next_attempt_at
        // NULL is excluded by app_outbound_due, so the sweep stops re-queuing
        // it every 5 minutes. Resuming the campaign sets next_attempt_at=now().
        await db.rescheduleOutreach(outreachId, verdict.at ?? null);
        return { status: "later", reason: verdict.reason, at: verdict.at };
      }
      const ins = await db.insertCallAttempt({ outreachId, attemptNo: r.attempts_made + 1, fromNumber: r.config.caller_id, toNumber: r.phone_e164 });
      if (ins.conflict) return { status: "conflict" };
      await db.markOutreachDialing(outreachId);
      return { status: "dial", attemptId: ins.id, row: r, tz };
    }, { actor: { type: "system", id: "outbound-dispatch" } });

    if (phase.status === "later") {
      if (phase.at) await enqueue({ businessId, outreachId, at: phase.at, source: "reschedule" });
      bumpCounter("outbound_gate_later");
      log.info("outbound_gate_refused", { reason: phase.reason, verdict: "later" });
      return phase;
    }
    if (phase.status === "closed") { bumpCounter("outbound_gate_refused"); log.info("outbound_gate_refused", { reason: phase.reason, verdict: "never" }); return phase; }
    if (phase.status !== "dial") return phase;

    const { row: r, attemptId, tz } = phase;
    const attemptNo = r.attempts_made + 1;
    const base = env.baseUrl;
    let call;
    try {
      call = await twilio.calls.create({
        to: r.phone_e164, from: r.config.caller_id,
        url: `${base}/twilio/outbound-answer`, method: "POST",
        statusCallback: `${base}/twilio/outbound-status`, statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd", asyncAmd: "true",
        asyncAmdStatusCallback: `${base}/twilio/outbound-amd`, asyncAmdStatusCallbackMethod: "POST",
        // Spec §9.4 (revised after spike B): a US carrier's voicemail answered
        // after 26.6 s, so 25 s never reaches it. 40 s where a message is due.
        timeout: (r.config.retries.voicemail_on || []).includes(attemptNo) ? 40 : 25,
      });
    } catch (err) {
      const t = now();
      const capacity = err?.status === 429;
      const next = capacity
        ? new Date(t.getTime() + 30_000)
        : nextScheduled(r, attemptNo, t, tz, rand);
      await db.withTenant(businessId, async () => {
        // C16: Twilio's concurrency refusal must not use up an attempt or count
        // toward the daily cap -- no call was placed. Any other failure is a
        // real (failed) attempt: result='failed' + ended_at releases capacity.
        if (capacity) await db.undoAttempt(attemptId, outreachId);
        else await db.failAttempt(attemptId);
        if (next) await db.rescheduleOutreach(outreachId, next);
        else await db.closeOutreach(outreachId, "attempts_exhausted");
      }, { actor: { type: "system", id: "outbound-dispatch" } });
      if (next) await enqueue({ businessId, outreachId, at: next, source: "reschedule" });
      bumpCounter("outbound_dial_failed");
      log.error("outbound_dial_failed", { attemptId, status: err?.status ?? null, capacity });
      return { status: "dial_failed", attemptId };
    }

    await db.withTenant(businessId, () => db.setAttemptCallSid(attemptId, call.sid), { actor: { type: "system", id: "outbound-dispatch" } });
    bumpCounter("outbound_dial");
    log.info("outbound_dial", { attemptId, callSid: call.sid, attemptNo });

    // §9.3 step 1: render the backstop line (and the voicemail when due) WHILE
    // it rings, in the tenant's Gemini Live voice (Task 14's liveRender.js;
    // in 2a renderAudio is a no-op).
    try {
      const audio = await renderAudio({ row: r, attemptNo });
      if (audio) await db.withTenant(businessId, () => db.storeAttemptAudio(attemptId, audio), { actor: { type: "system", id: "outbound-dispatch" } });
    } catch (err) {
      log.error("outbound_backstop_render_failed", { attemptId, error: err?.message }); // session logs outbound_backstop_missing (§9.3)
    }
    return { status: "dialed", callSid: call.sid, attemptId };
  };
}

/**
 * The schedule entry after attempt `attemptNoJustMade` (1-based), windowed;
 * null when exhausted. The attempt number is EXPLICIT because dispatch holds
 * the pre-increment row (attempts_made = N-1) while post-call (Task 20) reads
 * the incremented one (attempts_made = N) -- deriving it from the row made
 * post-call skip an entry and never place the last attempt.
 */
export function nextScheduled(r, attemptNoJustMade, t, tz, rand) {
  const entries = r.config.retries.schedule;
  const idx = attemptNoJustMade; // entries[0] was attempt 1, so the next is entries[attemptNoJustMade]
  if (idx >= entries.length) return null;
  const at = computeAttemptAt({ entry: entries[idx], now: t, lastEndedAt: t, createdAt: new Date(r.created_at), timezone: tz });
  return applyWindow(at, r.config.calling_window, tz, rand);
}

/** Local midnight of `t`'s day in `tz`, as an instant. DST-safe via datetime.js. */
export function startOfLocalDay(t, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [year, month, day] = fmt.format(t).split("-").map(Number);
  return new Date(zonedComponentsToUtcMs({ year, month, day, hour: 0, minute: 0, second: 0 }, tz));
}
