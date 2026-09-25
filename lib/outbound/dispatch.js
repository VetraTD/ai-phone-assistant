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

const ACTOR = { actor: { type: "system", id: "outbound-dispatch" } };

/**
 * How early a task may arrive and still count as due (fix C). Cloud Tasks
 * fires at or after scheduleTime, but its clock and ours are not the same
 * clock. A task more than this early is a duplicate or a retry of one whose
 * outreach was since rescheduled, and its real-time task is already queued.
 */
export const DUE_SLACK_MS = 5_000;

/**
 * Pauses between SID writes (fix A): three writes in all. The call is already
 * ringing, so this is short on purpose -- the alternative to succeeding is
 * hanging the call up.
 */
export const SID_WRITE_BACKOFF_MS = Object.freeze([100, 300]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Due on the dispatcher's clock? NULL (parked), missing or unparseable is NOT due: fail closed. */
function isDue(nextAttemptAt, t) {
  if (nextAttemptAt === null || nextAttemptAt === undefined) return false;
  const ms = new Date(nextAttemptAt).getTime();
  return Number.isFinite(ms) && ms <= t.getTime() + DUE_SLACK_MS;
}

export function createDispatcher({ db, twilio, enqueue, env, now = () => new Date(), rand = Math.random, callerIdValid, renderAudio, log, sleep = defaultSleep }) {
  return async function dispatch({ businessId, outreachId }) {
    const phase = await db.withTenant(businessId, async () => {
      await db.lockCapacity(); // SELECT pg_advisory_xact_lock(hashtext('outbound_capacity'))
      const r = await db.claimOutreachForDispatch(outreachId);
      if (!r || r.state !== "waiting") return { status: "skipped" };
      const t = now();
      // Fix C: a duplicate or retried task that arrives after its outreach was
      // rescheduled would otherwise dial attempt N+1 at once, skipping the
      // schedule (and a 429's 30 s back-off). Checked before the gate.
      if (!isDue(r.next_attempt_at, t)) return { status: "skipped", reason: "not_due" };
      const tz = contactTimezone({ timezone: r.contact_timezone, phone_e164: r.phone_e164 }, r.business_timezone);
      const [suppressed, consents, hasRelationship, dialsToday, active, idOk] = await Promise.all([
        db.isSuppressed(r.phone_e164),
        db.listConsents(r.contact_id),
        r.compliance_class === "service" ? db.hasServiceRelationship(r.phone_e164) : Promise.resolve(false),
        db.countDialsSince(r.phone_e164, startOfLocalDay(t, tz)),
        // Fix D: the CLAIMED row's business_id, as Postgres spells it. The
        // payload's string can differ (an upper-case UUID still scopes RLS)
        // and would then match no directory row: zero live calls.
        db.activeDialCounts(r.business_id),
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
      if (ins.conflict) return { status: "conflict", attemptNo: r.attempts_made + 1 };
      await db.markOutreachDialing(outreachId);
      return { status: "dial", attemptId: ins.id, row: r, tz };
    }, ACTOR);

    if (phase.status === "conflict") {
      // Fix E: with the row lock and the capacity lock both in place a lost
      // insert race should never happen, so one that does is worth seeing.
      bumpCounter("outbound_dispatch_conflict");
      log.error("outbound_dispatch_conflict", { outreachId, attemptNo: phase.attemptNo });
      return { status: "conflict" };
    }
    if (phase.status === "later") {
      if (phase.at) await enqueue({ businessId, outreachId, at: phase.at, source: "reschedule" });
      bumpCounter("outbound_gate_later");
      log.info("outbound_gate_refused", { reason: phase.reason, verdict: "later", outreachId });
      return phase;
    }
    if (phase.status === "closed") { bumpCounter("outbound_gate_refused"); log.info("outbound_gate_refused", { reason: phase.reason, verdict: "never", outreachId }); return phase; }
    if (phase.status !== "dial") return phase;

    const { row: r, attemptId, tz } = phase;
    const attemptNo = r.attempts_made + 1;
    const base = env.baseUrl;

    /**
     * The attempt did not become a routable call: record that, and put the
     * outreach back on its schedule. One unit of work, with the outreach row
     * LOCKED and read first (fix B): if something closed it while Twilio was
     * being asked (an opt-out, the dashboard), the attempt write still commits
     * -- a rolled-back failAttempt would leave it open, holding capacity, for
     * good -- and the closed outreach is left closed rather than rescheduled.
     */
    async function failAndReschedule({ capacity }) {
      const t = now();
      const next = capacity
        ? new Date(t.getTime() + 30_000)
        : nextScheduled(r, attemptNo, t, tz, rand);
      const outreachClosed = await db.withTenant(businessId, async () => {
        const state = await db.lockOutreachState(outreachId); // SELECT state ... FOR UPDATE
        // C16: Twilio's concurrency refusal must not use up an attempt or count
        // toward the daily cap -- no call was placed. Any other failure is a
        // real (failed) attempt: result='failed' + ended_at releases capacity.
        if (capacity) await db.undoAttempt(attemptId, outreachId);
        else await db.failAttempt(attemptId);
        if (state === "closed") return true;
        if (next) await db.rescheduleOutreach(outreachId, next);
        else await db.closeOutreach(outreachId, "attempts_exhausted");
        return false;
      }, ACTOR);
      if (next && !outreachClosed) await enqueue({ businessId, outreachId, at: next, source: "reschedule" });
      return { outreachClosed };
    }

    /** Fix A: three writes, idempotent SQL, short pauses. Returns the last error, or null. */
    async function writeCallSid(sid) {
      let lastErr = null;
      for (let i = 0; i <= SID_WRITE_BACKOFF_MS.length; i++) {
        try {
          await db.withTenant(businessId, () => db.setAttemptCallSid(attemptId, sid), ACTOR);
          return null;
        } catch (err) {
          lastErr = err;
          if (i < SID_WRITE_BACKOFF_MS.length) await sleep(SID_WRITE_BACKOFF_MS[i]);
        }
      }
      return lastErr;
    }

    /**
     * Hang up a call no callback can route. `canceled` ends a queued or ringing
     * call. On an answered (in-progress) call Twilio accepts `canceled` as a
     * SUCCESSFUL no-op -- 200, call still up (Checkpoint 2a, M3) -- so the
     * returned status is read, and anything but canceled/completed falls
     * through to `completed`, which is what ends an answered call. A refused
     * `canceled` falls through the same way. Best effort: a failure here is
     * logged, never thrown.
     */
    async function hangUp(sid) {
      try {
        const res = await twilio.calls(sid).update({ status: "canceled" });
        if (res?.status === "canceled" || res?.status === "completed") return res.status;
      } catch {
        // refused (already answered, or gone): try `completed`
      }
      try {
        await twilio.calls(sid).update({ status: "completed" });
        return "completed";
      } catch (err) {
        log.error("outbound_unroutable_call_hangup_failed", { attemptId, callSid: sid, error: err?.message });
        return null;
      }
    }

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
      const capacity = err?.status === 429;
      const { outreachClosed } = await failAndReschedule({ capacity });
      bumpCounter("outbound_dial_failed");
      log.error("outbound_dial_failed", { attemptId, status: err?.status ?? null, capacity, outreachClosed });
      return { status: "dial_failed", attemptId };
    }

    // Fix A: the phone is ringing now. Without its SID on the attempt no
    // callback can route it, and the answer door hangs up on an unknown SID --
    // a silent answered call. So retry the write, and if it never lands, hang
    // the call up and treat the attempt as failed.
    const sidErr = await writeCallSid(call.sid);
    if (sidErr) {
      const hungUp = await hangUp(call.sid);
      // Logged and counted BEFORE the reschedule (Checkpoint 2a, M2): the
      // usual cause of a failed SID write is the database being down, and
      // then failAndReschedule throws too -- this line must not depend on it.
      bumpCounter("outbound_dial_failed");
      log.error("outbound_dial_failed", { attemptId, reason: "sid_write_failed", error: sidErr?.message, hungUp });
      await failAndReschedule({ capacity: false });
      return { status: "dial_failed", attemptId };
    }
    bumpCounter("outbound_dial");
    log.info("outbound_dial", { attemptId, callSid: call.sid, attemptNo });

    // §9.3 step 1: render the backstop line (and the voicemail when due) WHILE
    // it rings, in the tenant's Gemini Live voice (Task 14's liveRender.js;
    // in 2a renderAudio is a no-op).
    let audio = null;
    try {
      audio = await renderAudio({ row: r, attemptNo });
    } catch (err) {
      log.error("outbound_backstop_render_failed", { attemptId, error: err?.message }); // session logs outbound_backstop_missing (§9.3)
    }
    if (audio) {
      try {
        await db.withTenant(businessId, () => db.storeAttemptAudio(attemptId, audio), ACTOR);
      } catch (err) {
        // Most often post-call already started (a quick no-answer) and cleared
        // the clips: storeAttemptAudio refuses to write them back.
        log.error("outbound_backstop_store_refused", { attemptId, error: err?.message });
      }
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
