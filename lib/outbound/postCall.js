// lib/outbound/postCall.js
/**
 * Post-call (spec §11, Task 20): runs EXACTLY ONCE per attempt, however many
 * terminal callbacks or session-finish races arrive, and whichever of the
 * two inputs -- the status door's terminal stamp, or the Live session's
 * `finish()` -- lands second claims the run with `services/db.js`'s
 * `claimPostCall` (the plan's single atomic UPDATE). The sweep's
 * `postcall_pending` backstop (migration 045) claims a session that died
 * without finishing, through the same function.
 *
 * `runPostCall` runs the seven steps; `createPostCall` wraps it with the
 * claim and is what doorRoutes.js, the Live session and the sweep all call.
 *
 * FIX ROUND 1 (controller review, 0 Critical / 8 Important, all addressed):
 *   1. Owner O-15: a throw after the claim commits no longer strands the
 *      attempt -- `tryClaimByAttempt` releases the claim on failure
 *      (services/db.js's `releasePostCallClaim`), which the migration 045
 *      trigger re-lists in `postcall_pending` for the next retry.
 *   2. Every DB write below is its OWN short `db.withTenant` call --
 *      `summarize()` (the Gemini call) never runs inside an open
 *      transaction, and is itself bounded (`SUMMARY_TIMEOUT_MS`).
 *   3. (silent-call session-end fallback) lives in lib/voice/live/index.js's
 *      `finish()` and detectors.js's `sessionEndSilent` -- nothing to redo
 *      here, `resolveSilentVerdict` already only reads the persisted verdict.
 *   4. A machine/fax answer skips tiers 3-4 outright (never LLM-scored,
 *      never terminal) and never defaults `result` to 'connected'.
 *   5. (transcriptSettled ordering) lives in live/index.js's `finish()`.
 *   6. (curly apostrophes) lives in detectors.js.
 *   7. A non-terminal reschedule enqueues the next attempt after the write
 *      commits (`deps.enqueue`), instead of waiting for the sweep.
 *   8. (real-DB test coverage) lives in tests/db/outboundPostCallWrites.test.js.
 *
 * POST-2c (O-23, b29): the no-session path (a crashed/never-finished session)
 * used to resolve its outcome from the summary ONLY -- spec §11 said so in so
 * many words. That let a contact who booked (or opted out) moments before the
 * crash get redialled, because tiers 1-3 (the door/tool-set outcome_code, and
 * the booking/opt-out effects) were gated on `hasSession`. They no longer are:
 * every answered, non-machine attempt now resolves tool/door outcome_code,
 * then effects, then the summary, in that order, whether or not a session
 * ever finished. Only the `outbound_postcall_without_session` counter/log and
 * the silent-verdict read (a DIFFERENT ruling, unrelated to outcome
 * resolution) still branch on `hasSession`.
 */
import { randomUUID } from "node:crypto";
import { nextScheduled } from "./dispatch.js";
import { contactTimezone } from "./schedule.js";
import { detectOptOut, detectClaimedHuman, resolveSilentVerdict, isMachineOrFaxAnswer, hadRealExchange } from "./detectors.js";
import { generateSummaryAndSentiment, OUTBOUND_OUTCOME_ENUM } from "../../services/gemini.js";
import { RESULTS_EVENTS, outboxIdempotencyKey, buildResultsPayload } from "../connections/outbox.js";
import { bumpCounter } from "../voice/metrics.js";
import { log as defaultLog } from "../logger.js";
import * as realDb from "../../services/db.js";

const ACTOR = { actor: { type: "system", id: "outbound-postcall" } };

/**
 * Terminal outcomes close the outreach (spec §8, §12.2). "transferred"
 * (S3-4, D6) joins this set the same way "booked"/"opted_out" already did:
 * a deterministic, door-set outcome_code (ctx.outcomeCode, tier 1/2 above),
 * never guessed at from the transcript -- a completed transfer needs no
 * further contact from this outreach.
 */
const TERMINAL_OUTCOMES = new Set(["booked", "not_interested", "not_a_fit", "opted_out", "wrong_person", "transferred"]);

/** 72 hours, in ms (spec §13.4's silent-call hold). */
const SILENT_HOLD_MS = 72 * 60 * 60 * 1000;

/**
 * Ruling (fix round 1, item 2): the reviewer's probe measured ~3.2s real for
 * `generateSummaryAndSentiment`. Bounded so a slow model call can never hold
 * up the reschedule/enqueue below; on timeout the outcome falls to
 * `'unknown'`, the SAME fallback the function returns for an empty
 * transcript or no API key. This is a race against a promise that keeps
 * running in the background -- its eventual settlement (if any) is ignored,
 * not cancelled; nothing here depends on it finishing.
 */
const SUMMARY_TIMEOUT_MS = 5000;
const SUMMARY_FALLBACK = Object.freeze({ summary: null, sentiment: null, outcome: "unknown" });

/** Race `promise` against a timer; on timeout, resolve to `fallback` rather than reject. */
async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fix round 1, item 4: the `result` a machine/fax answer falls back to when
 * AMD's own write has not landed for some reason -- NEVER 'connected'. Fax
 * is `decideAmd`'s own "failed" outcome (lib/outbound/amd.js); every
 * machine_* value defaults to the safe assumption that no message was
 * confirmed left.
 * @param {string|null} answeredBy
 */
function fallbackMachineResult(answeredBy) {
  return answeredBy === "fax" ? "failed" : "voicemail_skipped";
}

/**
 * Owner 2026-10-01 (the Hello call's +10 min redial): was this a real
 * conversation with THE PERSON, so the retry schedule stops? All of:
 *   - the person was confirmed (calls.answers._identity_confirmed, written by
 *     the engine on confirm_identity(true)) -- a gatekeeper-only talk never
 *     closes the lead;
 *   - a real exchange: the session's audio marker (calls.answers._exchanged,
 *     lib/outbound/liveFirstLine.js onExchange) or, failing that, the
 *     transcript (detectors.js hadRealExchange: the AI's reply heard AND
 *     answered) -- the transcript can lose the caller's text to lag;
 *   - no callback was asked for or BOOKED (callback_requested, or a stored
 *     _callback_requested_at: set_call_outcome overwrites outcome_code, so a
 *     booked callback can sit under another outcome -- final review #3);
 *   - not a hold timeout (we never reached the person after the hold).
 * Known residual: the hold-timeout note is a fire-and-forget write; if it
 * lands after this read, a confirmed-then-held call closes instead of retrying.
 */
function realConversation(ctx, transcriptRows, outcome) {
  if (outcome === "callback_requested" || ctx.answers?._callback_requested_at) return false;
  if (ctx.answers?._outcome_note === "hold timeout") return false;
  if (ctx.answers?._identity_confirmed !== true) return false;
  return ctx.answers?._exchanged === true || hadRealExchange(transcriptRows);
}

/** Step 6 (spec §11, §12.4). No-op until Task 27 ships text-after-missed-call. */
async function maybeTextAfterMissedCall(_ctx, _deps) {}

/**
 * Step 7 (spec §11, §12.5, amended §19 S3-D3, S3-8): the shared results
 * channel. One outbox row per (fired event x active, subscribed endpoint):
 * `call.completed` always fires; `outreach.closed` fires only when THIS
 * attempt's own write is what actually closed the outreach (`terminal &&
 * applied` -- W3, final review D1: `terminal` alone is true for a losing
 * side of the `applyOutreachResult` WHERE-clause race too, see the caller's
 * own doc). Each row's `id` is generated here (not left to the column
 * default) because it is ALSO the payload's own `delivery_id` and the
 * `X-Vetra-Delivery` header value -- fixed before it is known whether the
 * insert will land or be swallowed by the idempotency conflict.
 *
 * Wrapped in its own try/catch, the same posture as `maybeTextAfterMissedCall`
 * above and the reschedule-enqueue block below: a webhook/endpoint problem
 * is a best-effort notification to a third party, never a reason to strand
 * the exactly-once post-call claim over what is, by this point, an already
 * durable state-machine write. A missing `deps.db` outbox function (an
 * older test double that predates this task) is exactly this kind of
 * problem, not a bug in the caller -- it degrades to a log line, same as a
 * missing `deps.enqueue`.
 *
 * @param {ReturnType<typeof outboundPostCallContext>} ctx
 * @param {object} deps
 * @param {{businessId: string, attemptId: string, outcome: string|null, terminal: boolean,
 *   applied: boolean, closeReason: string|null, nextAttemptAt: Date|null, endedAt: Date|string|null,
 *   finalResult: string|null, summaryText: string|null}} resultCtx
 */
async function writeOutboxRows(ctx, deps, resultCtx) {
  const { db, log = defaultLog, now = () => new Date(), enqueueOutbox = null } = deps;
  const { businessId, attemptId, outcome, terminal, applied, closeReason, nextAttemptAt, endedAt, finalResult, summaryText } = resultCtx;
  // W3 (final review D1): the ONE flag every event/state field below reads --
  // never bare `terminal`, which is also true for the attempt that LOST the
  // applyOutreachResult race (its own write never landed; some other
  // attempt's did). `applied` defaults to `true` when the caller does not
  // pass it at all (every test double that predates this fix, and any
  // non-terminal call where "did this attempt's write land" is moot because
  // there was no close to race over).
  const outreachActuallyClosed = terminal && applied !== false;
  try {
    if (typeof db.listActiveWebhookEndpoints !== "function" || typeof db.insertOutboxRow !== "function") return;

    const events = outreachActuallyClosed ? RESULTS_EVENTS : ["call.completed"];

    let labels = { campaignName: null, contactFirstName: null, contactExternalIds: {} };
    if (typeof db.outboundResultsLabels === "function") {
      labels = await db.withTenant(
        businessId,
        () => db.outboundResultsLabels({ campaignId: ctx.campaignId, contactId: ctx.contactId }),
        ACTOR
      );
    }
    let booking = null;
    if (outcome === "booked" && typeof db.outboundBookingInfo === "function") {
      const b = await db.withTenant(businessId, () => db.outboundBookingInfo(ctx.callId), ACTOR);
      if (b) booking = { start: b.scheduled_at, length_min: null, appointment_id: b.id };
    }
    // W3 (final review D2): `endedAt` is the caller's post-step-1 value
    // (finalizeAttemptResult's own RETURNING, falling back to ctx.endedAt),
    // never ctx.endedAt alone -- that pre-read is null exactly when step 1's
    // COALESCE is what first sets ended_at, which used to make every such
    // call's duration_seconds silently null in the webhook payload.
    const durationSeconds =
      ctx.answeredAt && endedAt ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(ctx.answeredAt).getTime()) / 1000)) : null;

    for (const eventType of events) {
      const subjectId = eventType === "outreach.closed" ? ctx.outreachId : attemptId;
      const endpoints = await db.withTenant(businessId, () => db.listActiveWebhookEndpoints(eventType), ACTOR);
      if (!endpoints || endpoints.length === 0) continue;

      for (const ep of endpoints) {
        const deliveryId = randomUUID();
        const idempotencyKey = outboxIdempotencyKey({ endpointId: ep.id, eventType, subjectId });
        // I2 (fix round 1): ONE `now()` for this row, reused for BOTH the
        // insert's `next_attempt_at` and the enqueue's `at`. Three separate
        // `now()` calls (this task's original shape) can each return a
        // different millisecond in production -- and
        // createWebhookDeliveryEnqueuer names the Cloud Task
        // `w-<id>-<ceil(at)>`, so a mismatch between the row's own due time
        // and the enqueued task's `at` breaks Cloud Tasks' dedupe, letting
        // a retried insert or a duplicated task create a genuinely second
        // task instead of colliding with the first.
        const insertedAt = now();
        const payload = buildResultsPayload({
          event: eventType,
          deliveryId,
          occurredAt: insertedAt.toISOString(),
          campaign: { id: ctx.campaignId, name: labels.campaignName, version: ctx.campaignVersion },
          outreach: {
            id: ctx.outreachId,
            attempt: ctx.attemptNo,
            state: outreachActuallyClosed ? "closed" : "waiting",
            close_reason: outreachActuallyClosed ? closeReason : null,
          },
          call: { result: finalResult, answered_by: ctx.answeredBy, duration_seconds: durationSeconds },
          outcome,
          contact: { id: ctx.contactId, phone: ctx.phoneE164, first_name: labels.contactFirstName, external_ids: labels.contactExternalIds },
          answers: ctx.answers ?? {},
          booking,
          summary: summaryText,
          nextAttemptAt: terminal ? null : nextAttemptAt ? nextAttemptAt.toISOString() : null,
        });

        const { inserted } = await db.withTenant(
          businessId,
          () =>
            db.insertOutboxRow({
              id: deliveryId,
              kind: "webhook",
              targetId: ep.id,
              eventType,
              payload,
              idempotencyKey,
              nextAttemptAt: insertedAt,
            }),
          ACTOR
        );
        if (!inserted) continue; // idempotent no-op: this (endpoint, event, subject) row already exists

        bumpCounter("outbound_webhook_enqueued");
        if (enqueueOutbox) {
          try {
            await enqueueOutbox({ businessId, outboxId: deliveryId, at: insertedAt });
          } catch (err) {
            // I3(b) (fix round 1, controller ruling): counted, not only
            // logged -- a row can insert successfully and then never get a
            // Cloud Task at all (an instance dying right here, or a Cloud
            // Tasks blip), and until this round nothing distinguished that
            // from a healthy call. Stays non-fatal (this whole step is
            // wrapped in its own try/catch, by design -- a webhook
            // notification must never strand the exactly-once post-call
            // claim); the sweep's per-tenant backstop is the rescue path,
            // Parked for its own gap (I3, this report's Fix round 1).
            bumpCounter("outbound_webhook_enqueue_failed");
            log.error("outbound_webhook_enqueue_failed", { attemptId, outboxId: deliveryId, message: err?.message, severity: "warn" });
          }
        } else {
          log.info("outbound_webhook_enqueue_unavailable", { attemptId, outboxId: deliveryId });
        }
      }
    }
  } catch (err) {
    bumpCounter("outbound_webhook_writeoutbox_failed");
    log.error("outbound_webhook_writeoutbox_failed", { attemptId, message: err?.message, severity: "warn" });
  }
}

/** One side's transcript as a single blob, for the detectors (they scan free text, not turns). */
function sideText(rows, speaker) {
  return (rows || [])
    .filter((r) => r.speaker === speaker)
    .map((r) => r.message || "")
    .join(" ");
}

/**
 * Run the seven steps of spec §11 for one already-CLAIMED attempt. Every
 * database write is its OWN short `db.withTenant` call (fix round 1, item
 * 2) -- none of them wraps `summarize()`, and none holds a row lock for
 * longer than its own single statement.
 *
 * @param {{attemptId: string, businessId: string}} o
 * @param {{
 *   db: typeof import("../../services/db.js"),
 *   log?: typeof defaultLog,
 *   now?: () => Date,
 *   rand?: () => number,
 *   summarize?: typeof generateSummaryAndSentiment,
 *   enqueue?: ((args: {businessId: string, outreachId: string, at: Date, source: string}) => Promise<unknown>) | null,
 * }} deps
 */
export async function runPostCall({ attemptId, businessId, hints = {} }, deps) {
  const {
    db,
    log = defaultLog,
    now = () => new Date(),
    rand = Math.random,
    summarize = generateSummaryAndSentiment,
    enqueue = null,
  } = deps;

  // TXN 1 (short, read-only): the attempt's context AND its transcript, in
  // one round trip -- so `summarize()` below never runs inside an open
  // transaction (fix round 1, item 2). The transcript is fetched here only
  // when it will actually be used (an answered, non-machine attempt): a
  // machine/fax answer skips tiers 3-4 entirely (fix round 1, item 4) and
  // has no use for it.
  const { ctx, transcriptRows } = await db.withTenant(
    businessId,
    async () => {
      const c = await db.outboundPostCallContext(attemptId);
      if (!c) return { ctx: null, transcriptRows: [] };
      // I6 (fix wave, checkpoint 2b, = b37): a `calls` row (`callId`) only
      // ever exists because Task 14's onStart created it on an ANSWERED
      // call -- so its presence is answered evidence in its own right, not
      // only `answered_at`. This is the backstop for the stamp itself being
      // lost or not yet landed (see `stampAttemptAnswered`'s own doc): a
      // talked-to person must never fall through to the unanswered branch
      // below, which skips the transcript read and both detectors.
      const answeredForRead = c.answeredAt != null || c.callId != null;
      const wantsTranscript = answeredForRead && !isMachineOrFaxAnswer(c.answeredBy) && c.callId;
      const rows = wantsTranscript ? await db.fetchCallTranscript(c.callId) : [];
      return { ctx: c, transcriptRows: rows };
    },
    ACTOR
  );

  if (!ctx) {
    log.error("outbound_postcall_attempt_missing", { attemptId, severity: "warn" });
    return;
  }

  // I6: the SAME fallback as the transcript read above, applied to every
  // other "was this attempt answered" decision in this function (the result
  // fallback, tiers 2-4, the detectors' transcriptRows.length gate, and the
  // silent-verdict step).
  const answered = ctx.answeredAt != null || ctx.callId != null;
  const hasSession = ctx.sessionFinishedAt != null;
  const isMachine = isMachineOrFaxAnswer(ctx.answeredBy);

  if (answered && !hasSession) {
    bumpCounter("outbound_postcall_without_session");
    log.info("outbound_postcall_without_session", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId });
  }

  // Step 1 (its own short txn): result + ended_at (COALESCE -- never
  // clobbers a door/AMD verdict already in place, including one that lands
  // concurrently), and clear the two audio columns. Fix round 1, item 4: a
  // machine/fax answer's fallback is NEVER 'connected'.
  //
  // W3 (final review D2): finalizeAttemptResult's own RETURNING gives back
  // the `ended_at` THIS COALESCE actually committed -- `ctx.endedAt` (TXN 1,
  // read before this statement ever ran) is null exactly when this write is
  // what first sets it, and step 7's duration_seconds must use the real
  // value, never that stale pre-read.
  const resultIfUnset = !answered ? null : isMachine ? fallbackMachineResult(ctx.answeredBy) : "connected";
  const finalizedEndedAt = await db.withTenant(businessId, () => db.finalizeAttemptResult(attemptId, resultIfUnset), ACTOR);

  let outcome = null;
  let silentFinal = false;
  // Step 7's own summary field (spec §12.5's `summary`) -- set only when
  // tier 4 actually ran (an unanswered/machine attempt, or one tiers 1-3
  // already resolved, never calls the summarizer at all, and the results
  // payload's `summary` is null for exactly the same reason the spec's own
  // example shows it populated only on a scored call).
  let summaryText = null;

  // Fix round 1, item 4: a machine/fax answer skips tiers 3-4 outright --
  // an answering machine's greeting is never scored by the LLM, and (via
  // step 5 below, since `outcome` stays null) never closes the outreach.
  // Spec §9.4: a decline diverted to voicemail is never "not interested".
  if (answered && !isMachine) {
    // Step 2, tiers 1+2 (no DB call -- both already in `ctx`). See the
    // Ruling in the module doc: they collapse onto the same column, because
    // the `outcome` tool (capabilities/outcome.js, S3-3) writes
    // `calls.outcome_code` through the SAME setCallOutcomeCode a door route
    // uses -- ctx.outcomeCode reads whichever landed, tool or door, with no
    // way (or need) to tell them apart here. O-23 (post-2c, b29): NEITHER
    // this nor tier 3 below is gated on `hasSession` any more
    // -- a door-set outcome_code (e.g. the transfer door's callback_requested)
    // or a booking/opt-out effect is real regardless of whether the Live
    // session itself ever called finish(), and skipping them here is exactly
    // what let a contact who booked before a crash get redialled. Only the
    // `outbound_postcall_without_session` LOG above (and the silent-verdict
    // read below, unrelated to this ruling) still reads `hasSession`.
    if (ctx.outcomeCode) outcome = ctx.outcomeCode;

    // Tier 3: effects (its own short read txn). A booking or a
    // tool-inserted opt-out beats the summary guess -- with or without a
    // live session (O-23): `outboundCallEffects` is a cheap, callId-scoped
    // read (services/db.js's own doc) that returns {false, false} on a null
    // callId, so this is safe to run unconditionally once `answered` is true.
    if (!outcome) {
      const effects = await db.withTenant(businessId, () => db.outboundCallEffects(ctx.callId), ACTOR);
      if (effects.booked) outcome = "booked";
      else if (effects.optedOut) outcome = "opted_out";
    }

    // D9 (spec §13.3, this task): the opt-out detector is consulted BEFORE
    // the outcome is decided, not merely logged afterward. The bug this
    // fixes: a caller who says "please stop calling me" with no tool ever
    // called used to fall straight to tier 4's LLM guess, which can (and on
    // a real call did) read that sentence as `not_interested` -- a plausible
    // paraphrase, and the wrong outcome. The suppression write itself was
    // never the problem (insertDetectorSuppression already ran, and the
    // do-not-call list was correct); only the CALL's own recorded outcome
    // was wrong. Moved ahead of tier 4 rather than left where it was: when
    // tiers 1-3 set nothing and the detector hits, `outcome` is decided here
    // and the summary call is skipped entirely -- cheaper, and it removes
    // the LLM guess from the one path that most needs to be exact.
    //
    // "when tiers 1-3 set nothing" is `!outcome` at the point this runs: a
    // hit never overwrites a door/tool outcome_code or a booking/opt-out
    // effect already resolved above.
    let assistantText = "";
    let optOutHit = null;
    if (transcriptRows.length > 0) {
      assistantText = sideText(transcriptRows, "ai");
      const callerText = sideText(transcriptRows, "caller");

      optOutHit = detectOptOut({ assistantText, callerText });
      if (optOutHit.hit) {
        // Idempotent by construction on a retry (fix round 1, item 1):
        // isSuppressed + insertDetectorSuppression's own ON CONFLICT DO
        // NOTHING mean re-running this after a released claim never
        // double-inserts and never throws.
        const inserted = await db.withTenant(
          businessId,
          async () => {
            const already = await db.isSuppressed(ctx.phoneE164);
            if (already) return false;
            return db.insertDetectorSuppression({ phone: ctx.phoneE164, sourceCallId: ctx.callId });
          },
          ACTOR
        );
        if (inserted) {
          bumpCounter("outbound_optout_detector_fired");
          log.info("outbound_optout_detector_fired", { attemptId, callSid: ctx.callSid, side: optOutHit.side });
        }
        if (!outcome) {
          outcome = "opted_out";
          bumpCounter("outbound_optout_outcome_from_detector");
        }
      }
    }

    // STAGE 4, S4-2 (owner rule 2026-09-29). The Live session marked this
    // attempt `_optout_unverified`: the caller spoke during the opener clip and
    // hung up, and NEITHER Gemini nor Deepgram gave us their words -- they may
    // have said "stop calling me". Precedence, explicit: opted_out (any tier,
    // incl. the detector on Deepgram's text above) > held_for_review > every
    // other outcome. So an opt-out that WAS verified still suppresses; anything
    // else is held: outcome held_for_review, the outreach is CLOSED below
    // (close_reason held_for_review, no next_attempt_at), and the summarizer is
    // never asked -- its guess must not decide whether to phone them again.
    // Strict `=== true`: a missing or malformed marker is not a hold.
    // Two channels (S4-2 fix round 1, I2): the durable calls.answers marker,
    // and `hints.optoutUnverified` from the same process that ran the drain
    // (createPostCall.tryClaimByAttempt), which survives a lost marker write.
    const markerSet = ctx.answers?._optout_unverified === true;
    const optOutUnverified = markerSet || hints?.optoutUnverified === true;
    if (optOutUnverified && outcome !== "opted_out") {
      outcome = "held_for_review";
      if (!markerSet && ctx.callSid) {
        // Re-write the lost marker so a released-claim retry (no hint) still holds.
        try {
          await db.withTenant(businessId, () => db.mergeCallAnswers(ctx.callSid, { _optout_unverified: true }), ACTOR);
        } catch (err) {
          log.error("outbound_optout_unverified_marker_failed", { attemptId, callSid: ctx.callSid, via: "postcall", message: err?.message, severity: "warn" });
        }
      }
    }

    // Tier 4: the summary, extended with the outbound enum -- OUTSIDE any
    // transaction, and bounded (fix round 1, item 2). Tier 5 ('unknown') is
    // either generateSummaryAndSentiment's own fallback or the timeout's.
    let summaryResult = null;
    if (!outcome) {
      summaryResult = await withTimeout(summarize(transcriptRows, OUTBOUND_OUTCOME_ENUM), SUMMARY_TIMEOUT_MS, SUMMARY_FALLBACK);
      outcome = summaryResult.outcome;
      summaryText = summaryResult.summary;
    }

    // Write the outcome (its own short txn). This is `calls.outcome_code`/
    // `calls.summary`/`calls.sentiment` -- different columns from `result`,
    // which step 1 above already protected with its own COALESCE.
    if (ctx.callSid) {
      await db.withTenant(
        businessId,
        async () => {
          await db.setCallOutcomeCode(ctx.callSid, outcome);
          if (summaryResult) await db.updateCallSummary(ctx.callSid, summaryResult.summary, summaryResult.sentiment, null);
        },
        ACTOR
      );
    }

    // Step 3 + §13.2's OTHER detector: claimed-human, unrelated to outcome
    // resolution, so it stays a plain log/counter over the same transcript.
    if (transcriptRows.length > 0 && detectClaimedHuman(assistantText)) {
      bumpCounter("outbound_claimed_human");
      log.info("outbound_claimed_human", { attemptId, callSid: ctx.callSid });
    }
  }

  // §13.4: the final silent verdict (its own short txn(s)), for EVERY
  // answered attempt -- INCLUDING a machine/fax one. This runs OUTSIDE the
  // `!isMachine` gate above on purpose: `resolveSilentVerdict`'s own
  // machine/fax exclusion is exactly what corrects a session that flagged
  // `silent=true` before the AMD verdict was known (the verdict can land
  // after the session finishes) -- skipping this for a machine answer would
  // leave that stale `true` uncorrected in the database. Idempotent on a
  // retry: both writes set an absolute value derived from persisted state,
  // never an increment.
  if (answered) {
    const sessionSilent = hasSession ? Boolean(ctx.silent) : false;
    silentFinal = resolveSilentVerdict({ hasSession, sessionSilent, answeredBy: ctx.answeredBy });
    await db.withTenant(businessId, () => db.setAttemptSilent(attemptId, silentFinal), ACTOR);
    if (silentFinal) {
      bumpCounter("outbound_silent_call");
      await db.withTenant(
        businessId,
        () => db.setOutreachHold(ctx.outreachId, new Date(new Date(ctx.answeredAt).getTime() + SILENT_HOLD_MS)),
        ACTOR
      );
      log.info("outbound_silent_call", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId });
    }
  }

  // Step 5: the state machine (spec §8), and the no-double-reschedule guard
  // in one atomic UPDATE (applyOutreachResult, its own short txn). `busy`/
  // `no-answer` never reach `outcome` at all (answered is false), and a
  // machine/fax answer never reaches it either (isMachine, above) -- so a
  // decline (carrier or answering machine) can never be scored
  // `not_interested`: structural, not a check.
  let terminal = false;
  let closeReason = null;
  let nextAttemptAt = null;
  if (answered && !isMachine && outcome === "held_for_review") {
    // S4-2: closed for a human to look at; the operator re-adds the lead by
    // hand. Deliberately NOT in TERMINAL_OUTCOMES: its close_reason differs.
    terminal = true;
    closeReason = "held_for_review";
  } else if (answered && !isMachine && TERMINAL_OUTCOMES.has(outcome)) {
    terminal = true;
    closeReason = "terminal_outcome";
  } else if (answered && !isMachine && realConversation(ctx, transcriptRows, outcome)) {
    // Hello call 2026-10-01 (outreach 6df56867): qualified_no_booking is not
    // in TERMINAL_OUTCOMES, so a person who had just talked to us was
    // rescheduled +10 min. Owner 2026-10-01: no auto-redial after a real
    // conversation unless they asked for a callback. Same close reason as the
    // terminal outcomes (an existing CHECK value; no migration).
    terminal = true;
    closeReason = "terminal_outcome";
  } else {
    // `callback_requested` schedules at the REQUESTED time when one exists
    // (`schedule_callback`, stage 3, would write calls.answers.callback_
    // requested_at). With no requested time -- today's only real case, the
    // transfer-unanswered door path (Task 19) never sets one -- it takes
    // the next schedule entry, exactly like everything else (mechanical
    // ruling, spec §11/§12.2). Passes the ATTEMPT's own attempt_no, never
    // outreach.attempts_made (dispatch.js's rule, carried here).
    let next = null;
    // Final review #3 (hold fixes): a callback BOOKED with schedule_callback is
    // honoured whatever outcome_code was recorded after it (set_call_outcome
    // overwrites the column) -- it is what the person was promised.
    if (outcome === "callback_requested" || ctx.answers?._callback_requested_at) {
      // Minor (review, capabilities/callback.js): renamed to
      // `_callback_requested_at` -- the plain key could collide with a
      // campaign question of the same name (QUESTION_KEY_RE allows it).
      const requested = ctx.answers?._callback_requested_at ? new Date(ctx.answers._callback_requested_at) : null;
      // I4 (review, controller ruling): a requested time that is not
      // strictly in the future is never honoured -- capabilities/callback.js
      // already refuses a past/too-soon request at booking time, but this is
      // the defense-in-depth backstop for a stale row written before that
      // fix, or any other path that could write this key without going
      // through the tool's own validation. Falls through to the ordinary
      // retry schedule below, exactly as if no callback had been requested,
      // rather than re-dialling within minutes of a call that just ended.
      if (requested && !Number.isNaN(requested.getTime()) && requested.getTime() > now().getTime()) {
        next = requested;
      }
    }
    if (!next) {
      const tz = contactTimezone({ timezone: ctx.contactTimezone, phone_e164: ctx.phoneE164 }, ctx.businessTimezone);
      const scheduleRow = { config: ctx.config, created_at: ctx.outreachCreatedAt };
      next = nextScheduled(scheduleRow, ctx.attemptNo, now(), tz, rand);
    }
    if (next) nextAttemptAt = next;
    else {
      terminal = true;
      closeReason = "attempts_exhausted";
    }
  }

  const applied = await db.withTenant(
    businessId,
    () =>
      db.applyOutreachResult(ctx.outreachId, ctx.attemptNo, {
        terminal,
        closeReason,
        outcome: terminal ? outcome : null,
        nextAttemptAt: terminal ? null : nextAttemptAt,
      }),
    ACTOR
  );

  if (closeReason === "held_for_review") {
    if (applied) {
      // The alertable event (jsonPayload.event, ERROR), once per lead: only
      // when THIS run actually closed the outreach. A released-claim retry
      // finds it already closed (applied false) and stays at INFO. Ids and a
      // reason only -- no transcript, no audio, no phone number.
      bumpCounter("outbound_optout_unverified_hold");
      log.error("outbound_optout_unverified_hold", {
        outreachId: ctx.outreachId,
        attemptId,
        callSid: ctx.callSid,
        reason: "optout_unverified",
      });
    } else {
      log.info("outbound_optout_unverified_hold_already_applied", { outreachId: ctx.outreachId, attemptId, callSid: ctx.callSid });
    }
  }

  if (terminal && applied) {
    log.info("outbound_outreach_closed", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId, reason: closeReason });
  } else if (!applied) {
    // dispatch's own failAndReschedule (or an earlier post-call run) has
    // already applied the schedule for a LATER attempt on this outreach --
    // guarded by applyOutreachResult's WHERE clause, not a race.
    bumpCounter("outbound_postcall_reschedule_skipped");
    log.info("outbound_postcall_reschedule_skipped", {
      attemptId,
      callSid: ctx.callSid,
      outreachId: ctx.outreachId,
      attemptNo: ctx.attemptNo,
      outreachState: ctx.outreachState,
      attemptsMade: ctx.attemptsMade,
    });
  }

  // Fix round 1, item 7: enqueue AFTER the commit above, when the outreach
  // was actually rescheduled -- spec §11 says "compute and enqueue", and
  // without this every reschedule waited 2-7 minutes for the sweep. Same
  // shape dispatch.js's own enqueue calls use. `enqueue` is only ever unset
  // when the Cloud Tasks queue/service-account env is not configured
  // (buildOutboundDeps returned null, e.g. local dev) -- logged, and the
  // sweep is the backstop either way.
  if (!terminal && applied && nextAttemptAt) {
    if (enqueue) {
      try {
        await enqueue({ businessId, outreachId: ctx.outreachId, at: nextAttemptAt, source: "reschedule" });
      } catch (err) {
        log.error("outbound_postcall_enqueue_failed", {
          attemptId,
          outreachId: ctx.outreachId,
          message: err?.message,
          severity: "warn",
        });
      }
    } else {
      log.info("outbound_postcall_enqueue_unavailable", { attemptId, outreachId: ctx.outreachId });
    }
  }

  // Step 6: a seam only (Task 27, text after a missed call).
  await maybeTextAfterMissedCall(ctx, deps);
  // Step 7 (S3-8): the shared results channel. `finalResult` mirrors what
  // step 1's COALESCE actually committed (ctx.result -- the door/AMD verdict
  // that was already there -- wins; resultIfUnset only fills a null).
  //
  // W3 (final review D1): `applied` -- not merely `terminal` -- decides
  // whether THIS attempt's own state-machine write is what actually closed
  // the outreach. `applyOutreachResult`'s own WHERE clause guard (above)
  // means a later attempt on this outreach can already have applied ITS OWN
  // schedule/close by the time this one's write runs (a race, not a bug);
  // `terminal` alone stayed true for the attempt that lost that race, so the
  // old code fired a false `outreach.closed` webhook event for a close that
  // never actually happened on the attempt reporting it.
  await writeOutboxRows(ctx, deps, {
    businessId,
    attemptId,
    outcome,
    terminal,
    applied,
    closeReason,
    nextAttemptAt,
    endedAt: finalizedEndedAt ?? ctx.endedAt,
    finalResult: ctx.result ?? resultIfUnset,
    summaryText,
  });

  log.info("outbound_attempt_result", {
    attemptId,
    callSid: ctx.callSid,
    outreachId: ctx.outreachId,
    answered,
    outcome,
    silent: silentFinal,
    terminal,
    rescheduled: !terminal && applied,
  });
}

/**
 * Wrap `runPostCall` with the exactly-once claim (spec §11). `tryClaim`
 * (the shape doorRoutes.js and the Live session already call) resolves a
 * Twilio CallSid to its attempt first; `tryClaimByAttempt` is for callers
 * that already have both ids (the Live session's own `finish()`, and the
 * sweep's `postcall_pending`/`lost_callback` branches).
 *
 * @param {{
 *   db?: typeof import("../../services/db.js"),
 *   log?: typeof defaultLog,
 *   now?: () => Date,
 *   rand?: () => number,
 *   summarize?: typeof generateSummaryAndSentiment,
 *   enqueue?: ((args: object) => Promise<unknown>) | null,
 *   enqueueOutbox?: ((args: object) => Promise<unknown>) | null,
 * }} [deps]
 */
export function createPostCall(deps = {}) {
  const { db = realDb, log = defaultLog, now, rand, summarize } = deps;
  // Fix round 1, item 7: mutable, not frozen at construction -- the real
  // singleton (`postCall`, below) is created at MODULE LOAD, before
  // server.js has resolved `buildOutboundDeps` (which is what builds the
  // real, Cloud-Tasks-backed enqueue function). `setEnqueue` lets server.js
  // wire it in once it exists, without needing a second shared instance.
  // `setEnqueueOutbox` (S3-8) is the SAME idea for step 7's delivery-task
  // enqueue.
  let enqueueFn = deps.enqueue ?? null;
  let enqueueOutboxFn = deps.enqueueOutbox ?? null;
  const buildRunDeps = () => ({
    db,
    log,
    ...(now ? { now } : {}),
    ...(rand ? { rand } : {}),
    ...(summarize ? { summarize } : {}),
    enqueue: enqueueFn,
    enqueueOutbox: enqueueOutboxFn,
  });

  /** @returns {Promise<boolean>} true iff THIS call claimed the run */
  async function tryClaimByAttempt(attemptId, businessId, hints = {}) {
    if (!attemptId || !businessId) return false;
    let claimedAt = null;
    try {
      claimedAt = await db.withTenant(businessId, () => db.claimPostCall(attemptId), ACTOR);
    } catch (err) {
      log.error("outbound_postcall_claim_failed", { attemptId, businessId, message: err?.message, severity: "warn" });
      return false;
    }
    if (!claimedAt) return false;
    try {
      await runPostCall({ attemptId, businessId, hints }, buildRunDeps());
    } catch (err) {
      // Fix round 1, item 1 (Owner O-15): a failure after the claim must
      // not strand the attempt forever. `releasePostCallClaim` is safe by
      // construction (see its own doc: only WE could have set this column
      // non-null, so nothing else needs protecting against) -- the 045
      // trigger re-lists the row in `postcall_pending` the instant this
      // commits, and the next sweep tick (or a retried caller) tries again.
      bumpCounter("outbound_postcall_run_failed");
      log.error("outbound_postcall_run_failed", { attemptId, businessId, message: err?.message, severity: "warn" });
      try {
        await db.withTenant(businessId, () => db.releasePostCallClaim(attemptId), ACTOR);
      } catch (releaseErr) {
        log.error("outbound_postcall_release_failed", {
          attemptId,
          businessId,
          message: releaseErr?.message,
          severity: "warn",
        });
      }
    }
    return true;
  }

  /** @returns {Promise<boolean>} true iff THIS call claimed the run */
  async function tryClaim(callSid) {
    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_postcall_lookup_failed", { callSid, message: err?.message, severity: "warn" });
      return false;
    }
    if (!attempt) return false;
    return tryClaimByAttempt(attempt.attemptId, attempt.businessId);
  }

  return {
    tryClaim,
    tryClaimByAttempt,
    /** Fix round 1, item 7: server.js calls this once buildOutboundDeps resolves. `null` disables enqueueing (the sweep remains the backstop). */
    setEnqueue(fn) {
      enqueueFn = fn ?? null;
    },
    /** S3-8: the same idea, for step 7's webhook-delivery task enqueue. `null` disables it (a row still lands in outbox; the sweep's per-tenant backstop is what rescues it). */
    setEnqueueOutbox(fn) {
      enqueueOutboxFn = fn ?? null;
    },
  };
}

/** The real, wired-up instance: server.js and the Live session share this ONE. */
export const postCall = createPostCall({ db: realDb });
