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
import { renderCampaignLine, CAMPAIGN_LIMITS } from "./campaignSchema.js";
import { voicemailPermitted } from "./amd.js";

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

/**
 * D10 (spec §19, S3-D2): how long the dial waits for the opener clip to
 * render and store before going ahead without it (`outbound_render_late`,
 * WARN). The prompt path (§9.3 step 1's own fallback, `outbound_backstop_
 * missing`) is what a session takes when the render loses this race, so
 * going ahead late is never a silent first-turn -- Live is just asked to say
 * the line directly at the deadline instead of playing a clip.
 *
 * Also the reason the stale-`dialing` thresholds in
 * lib/outbound/internalRoutes.js (`OUTBOUND_STALE_SIDLESS_MINUTES` etc.) must
 * exceed this plus the longest ring timeout (40 s, voicemail_on): a real
 * dial that is merely running slightly late must never be mistaken by the
 * sweep for one that never happened at all. tests/outboundDispatch.test.js
 * asserts the inequality directly.
 */
export const RENDER_BEFORE_DIAL_MAX_MS = 8_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves `true` if `ms` elapsed before `promise` did, `false` otherwise --
 * always clearing its own timer either way (M5, fix round 1: a race whose
 * timeout branch never fires still leaves a live `setTimeout` dangling for
 * the rest of `ms` unless something clears it).
 */
function withDeadline(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  return Promise.race([promise.then(() => false), timedOut]).finally(() => clearTimeout(timer));
}

/** Due on the dispatcher's clock? NULL (parked), missing or unparseable is NOT due: fail closed. */
function isDue(nextAttemptAt, t) {
  if (nextAttemptAt === null || nextAttemptAt === undefined) return false;
  const ms = new Date(nextAttemptAt).getTime();
  return Number.isFinite(ms) && ms <= t.getTime() + DUE_SLACK_MS;
}

export function createDispatcher({ db, twilio, twilioClientFor, enqueue, env, now = () => new Date(), rand = Math.random, callerIdValid, renderAudio, log, sleep = defaultSleep }) {
  // O-26/C17: `twilioClientFor(callerId)` is the account-aware resolver
  // (lib/outbound/twilioAccounts.js in production); `twilio` is the OLDER,
  // single already-resolved client shape every existing caller of this
  // function (and every test that predates C17) still passes. Both are
  // accepted -- `twilioClientFor` wins when given, `twilio` is the fallback
  // -- so a caller that has not been taught about accounts keeps dialling
  // from exactly the client it always has, with no signature break.
  const resolveClient = (callerId) => (twilioClientFor ? twilioClientFor(callerId) : twilio);
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
      // O-26/C17: the SAME account that placed the call (r.config.caller_id)
      // -- Twilio's Calls resource is account-scoped, so hanging up with the
      // wrong account's client just 404s.
      const client = await resolveClient(r.config.caller_id);
      try {
        const res = await client.calls(sid).update({ status: "canceled" });
        if (res?.status === "canceled" || res?.status === "completed") return res.status;
      } catch {
        // refused (already answered, or gone): try `completed`
      }
      try {
        await client.calls(sid).update({ status: "completed" });
        return "completed";
      } catch (err) {
        log.error("outbound_unroutable_call_hangup_failed", { attemptId, callSid: sid, error: err?.message });
        return null;
      }
    }

    // D10 (spec §19, S3-D2, live round 1): the opener now renders and is
    // STORED BEFORE calls.create, not after -- a fast answer used to find no
    // clip at all because the render only started once the phone was already
    // ringing. §9.3 step 1: render the TEXT of the backstop line (and the
    // voicemail when due) from the row's CURRENT values -- Task 13, O-4. A
    // business renamed after the campaign was saved can push a rendered line
    // over its save-time-validated budget (that check ran against a
    // worst-case NAME LENGTH, not this business's actual, possibly-since-
    // changed name), so each field is checked again here and OMITTED, never
    // truncated, when it is over budget -- the same outcome as a failed
    // render (amended spec §9.3 step 1). `lines` only ever holds fields that
    // are actually safe to speak; Task 14's session takes the prompt path for
    // whichever key is missing.
    //
    // Rendered by renderCampaignLine, the SAME function the Live session uses
    // for the seed (Task 14 fix round 2, O-9): with no first name, the
    // sentences that need one are dropped, and a remainder without the
    // business name and the AI disclosure is no line at all ("unusable_line")
    // -- never the literal "null".
    const renderLine = (tpl) => renderCampaignLine(tpl, { firstName: r.first_name, businessName: r.business_name, config: r.config });
    const lines = {};

    const renderedOpener = renderLine(r.config.opener);
    if (renderedOpener === null) {
      log.error("outbound_backstop_render_refused", { attemptId, reason: "unusable_line" });
    } else if (renderedOpener.length > CAMPAIGN_LIMITS.rendered_opener) {
      log.error("outbound_backstop_render_refused", { attemptId, chars: renderedOpener.length });
    } else {
      lines.opener = renderedOpener;
    }

    const voicemailDue = (r.config.retries.voicemail_on || []).includes(attemptNo) && voicemailPermitted(r.compliance_class);
    if (voicemailDue) {
      const renderedVoicemail = renderLine(r.config.voicemail);
      if (renderedVoicemail === null) {
        log.error("outbound_voicemail_render_refused", { attemptId, reason: "unusable_line" });
      } else if (renderedVoicemail.length > CAMPAIGN_LIMITS.rendered_voicemail) {
        log.error("outbound_voicemail_render_refused", { attemptId, chars: renderedVoicemail.length });
      } else {
        lines.voicemail = renderedVoicemail;
      }
    }

    // §9.3 step 1: render the CLIPS (Task 14's liveRender.js) -- but only when
    // there is at least one line safe to speak.
    //
    // EACH CLIP IS STORED THE MOMENT IT IS READY (Task 14 fix round 1, I4).
    // storeAttemptAudio writes only the column it is given, so the second
    // write never nulls the first. `onClip` is the renderer's hook; anything a
    // renderer returns without having handed it over is stored after.
    const storedClips = new Set();
    const storeClip = async (kind, buf) => {
      if (!Buffer.isBuffer(buf) || buf.length === 0 || storedClips.has(kind)) {
        if (kind === "opener") settleOpener(); // nothing more is coming for the opener
        return;
      }
      storedClips.add(kind);
      try {
        await db.withTenant(businessId, () => db.storeAttemptAudio(attemptId, { [kind]: buf }), ACTOR);
      } catch (err) {
        // Most often post-call already started (a quick no-answer) and cleared
        // the clips: storeAttemptAudio refuses to write them back.
        log.error("outbound_backstop_store_refused", { attemptId, kind, error: err?.message });
      } finally {
        if (kind === "opener") settleOpener();
      }
    };

    // D10: the dial waits for the OPENER specifically (never the voicemail),
    // bounded by RENDER_BEFORE_DIAL_MAX_MS. `settleOpener` is idempotent --
    // whichever of "stored", "refused/empty" or "the render itself failed"
    // happens first is the one that counts, and only once.
    let openerSettled = false;
    let resolveOpenerWait;
    const openerWait = new Promise((resolve) => { resolveOpenerWait = resolve; });
    const settleOpener = () => {
      if (openerSettled) return;
      openerSettled = true;
      resolveOpenerWait();
    };

    // The render keeps running (and storing whatever it produces) past the
    // opener race below -- a hung or slow render must never hang the DIAL,
    // which is all that race protects. `renderTask` is awaited again, capped,
    // once the dial itself has succeeded (I2, fix round 1, below). Never
    // rejects: a render failure is caught and logged here, same as before
    // D10 moved the dial around it.
    let renderTask = null;
    if (Object.keys(lines).length > 0) {
      renderTask = (async () => {
        let audio = null;
        try {
          audio = await renderAudio({ row: r, attemptNo, lines, onClip: storeClip });
        } catch (err) {
          log.error("outbound_backstop_render_failed", { attemptId, error: err?.message }); // session logs outbound_backstop_missing (§9.3)
          settleOpener();
          return;
        }
        if (audio) {
          for (const kind of ["opener", "voicemail"]) await storeClip(kind, audio[kind]);
        }
        settleOpener(); // covers a renderer that never called onClip("opener", ...) at all
      })();
    }
    if (!lines.opener) settleOpener(); // no opener line was ever going to render

    // M5 (fix round 1): clears its own timer either way, so a dispatch whose
    // opener wins the race does not leave an 8 s timer dangling.
    const renderTimedOut = await withDeadline(openerWait, RENDER_BEFORE_DIAL_MAX_MS);
    if (renderTimedOut) {
      bumpCounter("outbound_render_late");
      log.error("outbound_render_late", { attemptId, waited_ms: RENDER_BEFORE_DIAL_MAX_MS, severity: "warn" });
    }

    let call;
    try {
      // O-26/C17: the client for the campaign's OWN caller_id -- account A
      // (`resolveClient`'s fallback) when no `twilioClientFor` was given,
      // exactly the pre-C17 behaviour.
      const dialClient = await resolveClient(r.config.caller_id);
      call = await dialClient.calls.create({
        to: r.phone_e164, from: r.config.caller_id,
        url: `${base}/twilio/outbound-answer`, method: "POST",
        statusCallback: `${base}/twilio/outbound-status`, statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd", asyncAmd: "true",
        asyncAmdStatusCallback: `${base}/twilio/outbound-amd`, asyncAmdStatusCallbackMethod: "POST",
        // Spec §9.4 (revised after spike B): a US carrier's voicemail answered
        // after 26.6 s, so 25 s never reaches it. 40 s where a message is due.
        timeout: (r.config.retries.voicemail_on || []).includes(attemptNo) ? 40 : 25,
        // M1 (fix wave, checkpoint 2b): campaignSchema.js validates
        // max_call_minutes at save (CAMPAIGN_LIMITS) but nothing enforced it
        // -- a tenant's own cap did nothing. Twilio's `timeLimit` is seconds;
        // omitted entirely (never 0) when the config carries no value, so a
        // template or a row saved before this field existed dials exactly as
        // it always has.
        ...(r.config.max_call_minutes ? { timeLimit: r.config.max_call_minutes * 60 } : {}),
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

    // I2 (fix round 1, reverting ruling 4). `voice-uk-prod` runs with
    // `cpu-throttling: true` -- Cloud Run allocates CPU only while a request
    // is in flight, and the media-stream WebSocket that would otherwise keep
    // this instance busy only opens on answer, commonly seconds to tens of
    // seconds away (and possibly on a DIFFERENT instance). A render detached
    // from THIS request after it returns can stall for the whole gap, and
    // `voicemail_audio` (or a late opener the 8 s race above missed) would
    // then not be stored by the time it is needed. Await it here instead,
    // bounded by the SAME ring timeout Twilio itself is using -- `renderLines`
    // is already capped per line (liveRender.js RENDER_TIMEOUT_MS, 20 s, run
    // in parallel), so this cap rarely has to be the one that fires; it exists
    // for the business-load and dynamic-import time around it, which is not
    // otherwise bounded. Never reached on the dial-failed paths above, which
    // already returned.
    if (renderTask) {
      const ringCapMs = voicemailDue ? 40_000 : 25_000;
      const renderIncomplete = await withDeadline(renderTask, ringCapMs);
      if (renderIncomplete) {
        bumpCounter("outbound_render_incomplete");
        log.error("outbound_render_incomplete", { attemptId, waited_ms: ringCapMs, severity: "warn" });
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

/**
 * Fail an attempt that never became a routable call, and apply the retry
 * schedule to its outreach: `lockOutreachState` -> `failAttempt` ->
 * `rescheduleOutreach`/`closeOutreach("attempts_exhausted")` -> `enqueue`.
 * The SAME sequence `createDispatcher`'s own `failAndReschedule` runs for a
 * non-capacity failure (§10.1 step 5), extracted so the sweep's `sidless`
 * backstop (spec §6.3, migration 045, Task 20) can reuse it rather than
 * duplicating it -- additive only; `createDispatcher`'s own closure is
 * untouched, so this carries zero risk to the dial path's existing tests.
 *
 * `attemptNo` is the FAILED attempt's own `attempt_no`, never the outreach's
 * `attempts_made` (the rule `nextScheduled`'s own doc carries).
 *
 * @param {{db: object, enqueue: Function, businessId: string, outreachId: string, attemptId: string, r: object, attemptNo: number, tz: string, now: () => Date, rand?: () => number}} o
 * @returns {Promise<{outreachClosed: boolean, next: Date|null}>}
 */
export async function failStaleAttempt({ db, enqueue, businessId, outreachId, attemptId, r, attemptNo, tz, now, rand = Math.random }) {
  const t = now();
  const next = nextScheduled(r, attemptNo, t, tz, rand);
  let rescheduled = false;
  const outreachClosed = await db.withTenant(
    businessId,
    async () => {
      const state = await db.lockOutreachState(outreachId);
      await db.failAttempt(attemptId);
      // b32 (fix wave, checkpoint 2b): only apply the schedule while the
      // outreach is still 'dialing' -- matching applyOutreachResult's own
      // guard (`state IN ('dialing','in_call')`, services/db.js). Any OTHER
      // state means a normal post-call run (or an earlier stale-attempt
      // pass on this same row) already applied the schedule for this
      // attempt; doing it again here would be a SECOND reschedule/close,
      // possibly with a different `next` time than the one already
      // committed. `failAttempt` above still runs regardless -- the attempt
      // itself is stale either way, whatever state the outreach is in.
      if (state !== "dialing") return state === "closed";
      if (next) {
        await db.rescheduleOutreach(outreachId, next);
        rescheduled = true;
      } else {
        await db.closeOutreach(outreachId, "attempts_exhausted");
      }
      return false;
    },
    ACTOR
  );
  if (next && !outreachClosed && rescheduled) await enqueue({ businessId, outreachId, at: next, source: "reschedule" });
  return { outreachClosed, next };
}
