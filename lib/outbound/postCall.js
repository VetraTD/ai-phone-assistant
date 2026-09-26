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
 */
import { nextScheduled } from "./dispatch.js";
import { contactTimezone } from "./schedule.js";
import { detectOptOut, detectClaimedHuman, resolveSilentVerdict } from "./detectors.js";
import { generateSummaryAndSentiment, OUTBOUND_OUTCOME_ENUM } from "../../services/gemini.js";
import { bumpCounter } from "../voice/metrics.js";
import { log as defaultLog } from "../logger.js";
import * as realDb from "../../services/db.js";

const ACTOR = { actor: { type: "system", id: "outbound-postcall" } };

/** Terminal outcomes close the outreach (spec §8, §12.2). */
const TERMINAL_OUTCOMES = new Set(["booked", "not_interested", "not_a_fit", "opted_out", "wrong_person"]);

/** 72 hours, in ms (spec §13.4's silent-call hold). */
const SILENT_HOLD_MS = 72 * 60 * 60 * 1000;

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
 * Run the seven steps of spec §11 for one already-CLAIMED attempt. Runs
 * inside `withTenant(businessId, …)`.
 *
 * @param {{attemptId: string, businessId: string}} o
 * @param {{
 *   db: typeof import("../../services/db.js"),
 *   log?: typeof defaultLog,
 *   now?: () => Date,
 *   rand?: () => number,
 *   summarize?: typeof generateSummaryAndSentiment,
 * }} deps
 */
export async function runPostCall({ attemptId, businessId }, deps) {
  const { db, log = defaultLog, now = () => new Date(), rand = Math.random, summarize = generateSummaryAndSentiment } = deps;

  await db.withTenant(
    businessId,
    async () => {
      const ctx = await db.outboundPostCallContext(attemptId);
      if (!ctx) {
        log.error("outbound_postcall_attempt_missing", { attemptId, severity: "warn" });
        return;
      }

      const answered = ctx.answeredAt != null;
      const hasSession = ctx.sessionFinishedAt != null;

      // Step 1: result + ended_at (COALESCE -- never clobbers a door/AMD
      // verdict already in place), and clear the two audio columns.
      await db.finalizeAttemptResult(attemptId, answered ? "connected" : null);

      let outcome = null;
      let silentFinal = false;
      let transcriptRows = null;
      const loadTranscript = async () => {
        if (transcriptRows === null) transcriptRows = ctx.callId ? await db.fetchCallTranscript(ctx.callId) : [];
        return transcriptRows;
      };

      if (answered) {
        if (!hasSession) {
          bumpCounter("outbound_postcall_without_session");
          log.info("outbound_postcall_without_session", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId });
        }

        // Step 2: resolve the outcome (Ruling P-6). Tiers 1 (the tool) and 2
        // (a door-set outcome_code) read the SAME column today -- the
        // `outcome` capability pack is stage 3 and does not exist yet, so
        // there is no second place a tool-set value could live -- and both
        // are skipped outright when the session never finished (Ruling: "no
        // session -> resolve from the summary only", taken literally).
        if (hasSession && ctx.outcomeCode) {
          outcome = ctx.outcomeCode;
        }

        // Tier 3: effects. A booking or a tool-inserted opt-out beats the
        // summary guess.
        if (!outcome && hasSession) {
          const effects = await db.outboundCallEffects(ctx.callId);
          if (effects.booked) outcome = "booked";
          else if (effects.optedOut) outcome = "opted_out";
        }

        // Tier 4: the summary, extended with the outbound enum. Tier 5
        // (unknown) is generateSummaryAndSentiment's own fallback for an
        // empty transcript or no API key.
        let summaryResult = null;
        if (!outcome) {
          const rows = await loadTranscript();
          summaryResult = await summarize(rows, OUTBOUND_OUTCOME_ENUM);
          outcome = summaryResult.outcome;
        }

        if (ctx.callSid) {
          await db.setCallOutcomeCode(ctx.callSid, outcome);
          if (summaryResult) await db.updateCallSummary(ctx.callSid, summaryResult.summary, summaryResult.sentiment, null);
        }

        // Step 3 + §13.2: the detectors, over whatever transcript exists --
        // run regardless of hasSession, because a caller's own "stop calling
        // me" said just before a crash is still worth catching.
        const rows = await loadTranscript();
        if (rows.length > 0) {
          const assistantText = sideText(rows, "ai");
          const callerText = sideText(rows, "caller");

          const optOut = detectOptOut({ assistantText, callerText });
          if (optOut.hit) {
            const already = await db.isSuppressed(ctx.phoneE164);
            if (!already) {
              const inserted = await db.insertDetectorSuppression({ phone: ctx.phoneE164, sourceCallId: ctx.callId });
              if (inserted) {
                bumpCounter("outbound_optout_detector_fired");
                log.info("outbound_optout_detector_fired", { attemptId, callSid: ctx.callSid, side: optOut.side });
              }
            }
          }

          if (detectClaimedHuman(assistantText)) {
            bumpCounter("outbound_claimed_human");
            log.info("outbound_claimed_human", { attemptId, callSid: ctx.callSid });
          }
        }

        // §13.4: the final silent verdict -- the machine/fax exclusion and
        // the "no stream" case are applied HERE, once, because the AMD
        // verdict (answered_by) can land after the session finishes.
        const sessionSilent = hasSession ? Boolean(ctx.silent) : false;
        silentFinal = resolveSilentVerdict({ hasSession, sessionSilent, answeredBy: ctx.answeredBy });
        await db.setAttemptSilent(attemptId, silentFinal);
        if (silentFinal) {
          bumpCounter("outbound_silent_call");
          await db.setOutreachHold(ctx.outreachId, new Date(new Date(ctx.answeredAt).getTime() + SILENT_HOLD_MS));
          log.info("outbound_silent_call", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId });
        }
      }

      // Step 5: the state machine (spec §8), and the no-double-reschedule
      // guard in one atomic UPDATE (applyOutreachResult). `busy`/`no-answer`
      // never reach `outcome` at all (the block above only runs when
      // `answered`), so a decline can never be scored `not_interested` --
      // this is structural, not a check.
      let terminal = false;
      let closeReason = null;
      let nextAttemptAt = null;
      if (answered && TERMINAL_OUTCOMES.has(outcome)) {
        terminal = true;
        closeReason = "terminal_outcome";
      } else {
        // `callback_requested` schedules at the REQUESTED time when one
        // exists (`schedule_callback`, stage 3, would write
        // calls.answers.callback_requested_at). With no requested time --
        // today's only real case, the transfer-unanswered door path (Task
        // 19) never sets one -- it takes the next schedule entry, exactly
        // like everything else (mechanical ruling, spec §11/§12.2). Passes
        // the ATTEMPT's own attempt_no, never outreach.attempts_made
        // (dispatch.js's rule, carried here).
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

      const applied = await db.applyOutreachResult(ctx.outreachId, ctx.attemptNo, {
        terminal,
        closeReason,
        outcome: terminal ? outcome : null,
        nextAttemptAt: terminal ? null : nextAttemptAt,
      });

      if (terminal && applied) {
        log.info("outbound_outreach_closed", { attemptId, callSid: ctx.callSid, outreachId: ctx.outreachId, reason: closeReason });
      } else if (!applied) {
        // dispatch's own failAndReschedule (or an earlier post-call run) has
        // already applied the schedule for a LATER attempt on this outreach
        // -- guarded by applyOutreachResult's WHERE clause, not a race.
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
    },
    ACTOR
  );
}

/**
 * Wrap `runPostCall` with the exactly-once claim (spec §11). `tryClaim`
 * (the shape doorRoutes.js and the Live session already call) resolves a
 * Twilio CallSid to its attempt first; `tryClaimByAttempt` is for callers
 * that already have both ids (the Live session's own `finish()`, and the
 * sweep's `postcall_pending`/`lost_callback` branches).
 *
 * @param {{db: typeof import("../../services/db.js"), log?: typeof defaultLog, now?: () => Date, rand?: () => number, summarize?: typeof generateSummaryAndSentiment}} [deps]
 */
export function createPostCall(deps = {}) {
  const { db = realDb, log = defaultLog, now, rand, summarize } = deps;
  const runDeps = { db, log, ...(now ? { now } : {}), ...(rand ? { rand } : {}), ...(summarize ? { summarize } : {}) };

  /** @returns {Promise<boolean>} true iff THIS call claimed the run (and ran it) */
  async function tryClaimByAttempt(attemptId, businessId) {
    if (!attemptId || !businessId) return false;
    let claimed = false;
    try {
      claimed = await db.withTenant(businessId, () => db.claimPostCall(attemptId), ACTOR);
    } catch (err) {
      log.error("outbound_postcall_claim_failed", { attemptId, businessId, message: err?.message, severity: "warn" });
      return false;
    }
    if (!claimed) return false;
    try {
      await runPostCall({ attemptId, businessId }, runDeps);
    } catch (err) {
      log.error("outbound_postcall_failed", { attemptId, businessId, message: err?.message, severity: "warn" });
    }
    return true;
  }

  /** @returns {Promise<boolean>} true iff THIS call claimed the run (and ran it) */
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

  return { tryClaim, tryClaimByAttempt };
}

/** The real, wired-up instance: server.js and the Live session share this ONE. */
export const postCall = createPostCall({ db: realDb });
