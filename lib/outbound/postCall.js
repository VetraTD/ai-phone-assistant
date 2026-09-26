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
 */
import { nextScheduled } from "./dispatch.js";
import { contactTimezone } from "./schedule.js";
import { detectOptOut, detectClaimedHuman, resolveSilentVerdict, isMachineOrFaxAnswer } from "./detectors.js";
import { generateSummaryAndSentiment, OUTBOUND_OUTCOME_ENUM } from "../../services/gemini.js";
import { bumpCounter } from "../voice/metrics.js";
import { log as defaultLog } from "../logger.js";
import * as realDb from "../../services/db.js";

const ACTOR = { actor: { type: "system", id: "outbound-postcall" } };

/** Terminal outcomes close the outreach (spec §8, §12.2). */
const TERMINAL_OUTCOMES = new Set(["booked", "not_interested", "not_a_fit", "opted_out", "wrong_person"]);

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

/** Step 6 (spec §11, §12.4). No-op until Task 27 ships text-after-missed-call. */
async function maybeTextAfterMissedCall(_ctx, _deps) {}

/** Step 7 (spec §11, §12.5). No-op until Task 28 ships the outbox / results webhook. */
async function writeOutboxRows(_ctx, _deps) {}

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
export async function runPostCall({ attemptId, businessId }, deps) {
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
  const resultIfUnset = !answered ? null : isMachine ? fallbackMachineResult(ctx.answeredBy) : "connected";
  await db.withTenant(businessId, () => db.finalizeAttemptResult(attemptId, resultIfUnset), ACTOR);

  let outcome = null;
  let silentFinal = false;

  // Fix round 1, item 4: a machine/fax answer skips tiers 3-4 outright --
  // an answering machine's greeting is never scored by the LLM, and (via
  // step 5 below, since `outcome` stays null) never closes the outreach.
  // Spec §9.4: a decline diverted to voicemail is never "not interested".
  if (answered && !isMachine) {
    // Step 2, tiers 1+2 (no DB call -- both already in `ctx`). See the
    // Ruling in the module doc: they collapse onto the same column today
    // because the `outcome` tool (stage 3) does not exist yet, and both are
    // skipped when the session never finished (resolve from the summary
    // only, taken literally from the brief).
    if (hasSession && ctx.outcomeCode) outcome = ctx.outcomeCode;

    // Tier 3: effects (its own short read txn). A booking or a
    // tool-inserted opt-out beats the summary guess.
    if (!outcome && hasSession) {
      const effects = await db.withTenant(businessId, () => db.outboundCallEffects(ctx.callId), ACTOR);
      if (effects.booked) outcome = "booked";
      else if (effects.optedOut) outcome = "opted_out";
    }

    // Tier 4: the summary, extended with the outbound enum -- OUTSIDE any
    // transaction, and bounded (fix round 1, item 2). Tier 5 ('unknown') is
    // either generateSummaryAndSentiment's own fallback or the timeout's.
    let summaryResult = null;
    if (!outcome) {
      summaryResult = await withTimeout(summarize(transcriptRows, OUTBOUND_OUTCOME_ENUM), SUMMARY_TIMEOUT_MS, SUMMARY_FALLBACK);
      outcome = summaryResult.outcome;
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

    // Step 3 + §13.2: the detectors, over the transcript read in TXN 1 --
    // run regardless of hasSession, because a caller's own "stop calling
    // me" said just before a crash is still worth catching.
    if (transcriptRows.length > 0) {
      const assistantText = sideText(transcriptRows, "ai");
      const callerText = sideText(transcriptRows, "caller");

      const optOut = detectOptOut({ assistantText, callerText });
      if (optOut.hit) {
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
          log.info("outbound_optout_detector_fired", { attemptId, callSid: ctx.callSid, side: optOut.side });
        }
      }

      if (detectClaimedHuman(assistantText)) {
        bumpCounter("outbound_claimed_human");
        log.info("outbound_claimed_human", { attemptId, callSid: ctx.callSid });
      }
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
  if (answered && !isMachine && TERMINAL_OUTCOMES.has(outcome)) {
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
    if (outcome === "callback_requested") {
      const requested = ctx.answers?.callback_requested_at ? new Date(ctx.answers.callback_requested_at) : null;
      if (requested && !Number.isNaN(requested.getTime())) next = requested;
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

  // Steps 6-7: seams only (Tasks 27/28).
  await maybeTextAfterMissedCall(ctx, deps);
  await writeOutboxRows(ctx, deps);

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
 * }} [deps]
 */
export function createPostCall(deps = {}) {
  const { db = realDb, log = defaultLog, now, rand, summarize } = deps;
  // Fix round 1, item 7: mutable, not frozen at construction -- the real
  // singleton (`postCall`, below) is created at MODULE LOAD, before
  // server.js has resolved `buildOutboundDeps` (which is what builds the
  // real, Cloud-Tasks-backed enqueue function). `setEnqueue` lets server.js
  // wire it in once it exists, without needing a second shared instance.
  let enqueueFn = deps.enqueue ?? null;
  const buildRunDeps = () => ({
    db,
    log,
    ...(now ? { now } : {}),
    ...(rand ? { rand } : {}),
    ...(summarize ? { summarize } : {}),
    enqueue: enqueueFn,
  });

  /** @returns {Promise<boolean>} true iff THIS call claimed the run */
  async function tryClaimByAttempt(attemptId, businessId) {
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
      await runPostCall({ attemptId, businessId }, buildRunDeps());
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
  };
}

/** The real, wired-up instance: server.js and the Live session share this ONE. */
export const postCall = createPostCall({ db: realDb });
