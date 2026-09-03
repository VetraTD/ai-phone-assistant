import * as dbModule from "../services/db.js";
import * as notificationsModule from "../services/notifications.js";
import { log as defaultLog } from "./logger.js";
import { bumpCounter } from "./voice/metrics.js";
import { isValidE164 } from "./validate.js";
import { speakableDateTime } from "./capabilities/datetime.js";
import { resolveProfile } from "./voice/voiceLocale.js";

// ---------------------------------------------------------------------------
// LVX29 -- confirm from the database, not from what the model said.
//
// The owner's bar is zero fabrications. No LLM that IS the voice meets that
// bar: on the speech-to-speech front-end there is no layer between the model
// and the caller that can refuse to say a sentence. Both LVX27 guards detect
// two shapes of a fabricated action after the fact and prevent neither.
//
// So the problem inverts. Stop trying to make the model incapable of lying and
// make the lie unable to survive the call: after the call, the caller's
// confirmation is built from the appointment ROW. No row, no message -- and a
// fabricated booking becomes a caller who rings back in a minute instead of
// one who turns up on the day to nothing.
//
// The same read, in the other direction, is the reconciliation half: when a
// claim and the database disagree, that is a fact about the call worth
// recording whether or not anybody is texted.
//
// NOTHING HERE IS LIVE-SPECIFIC. It acts on the row and on a list of what the
// call claimed, so the cascade -- which has never checked what it said against
// what it wrote either -- can drive the identical function. It ships
// Live-only behind POSTCALL_VERIFY because the cascade is the mature path and
// this one has never run.
//
// Why a `count` rung exists before `send`: the same reason LIVE_CLAIM_GUARD
// has one. A verdict computed from a database read nobody has watched is not
// evidence, and the first thing to establish is that the rows are being found
// at all -- which is answerable without messaging a single caller.
// ---------------------------------------------------------------------------

/** @typedef {"off"|"count"|"send"} PostCallMode */

/**
 * How far the post-call read is allowed to go.
 *
 * Unrecognised values resolve to `off` rather than throwing. This is read at
 * the end of a real call, and a typo in a deploy variable should not be the
 * thing that raises in a teardown handler.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PostCallMode}
 */
export function postCallMode(env = process.env) {
  const raw = String(env.POSTCALL_VERIFY || "").trim().toLowerCase();
  if (raw === "send") return "send";
  if (raw === "count") return "count";
  return "off";
}

/** Written by `book_appointment`; the row carries this call's id. */
const BOOKED = "booked";
/** Written by cancel/reschedule; the row exists already and is read back by id. */
const CHANGED = "changed";

/**
 * Read what a finished call actually wrote, confirm it to the caller from the
 * row, and record where the row and the call's own account of itself differ.
 *
 * Never throws. It runs inside a teardown path with the socket already
 * closing, so every failure resolves to a verdict rather than a rejection.
 *
 * @param {object} input
 * @param {string|null} input.businessId
 * @param {string|null} input.callId - `calls.id`, which is `appointments.call_id`
 * @param {object} input.config - loadConfig() output
 * @param {string|null} [input.callerNumber] - recorded, never used as a fallback
 *   destination: the owner's decision is that a booking with no number on the
 *   row is reported to the business, not texted to whoever happened to ring.
 * @param {Array<{type: string, tool?: string, appointmentId?: string}>} [input.writes]
 * @param {Array<{turn: number, kind: string, step?: string}>} [input.claims]
 * @param {PostCallMode} [input.mode]
 * @param {string} [input.callSid] - for the log line only
 * @param {object} [deps] - test seam
 */
export async function verifyCall(input, deps = {}) {
  const {
    businessId = null,
    callId = null,
    config = null,
    callerNumber = null,
    writes = [],
    claims = [],
    mode = "off",
    callSid = null,
  } = input || {};

  const db = deps.db || dbModule;
  const notifications = deps.notifications || notificationsModule;
  const log = deps.log || defaultLog;

  // An unscoped appointment read would cross every tenant in the table, which
  // is the refusal services/db.js already makes at getAppointmentById.
  if (mode === "off" || !businessId || !config) return { mode, verdict: "skipped", rows: [], sent: [], skipped: [] };

  bumpCounter("postcall_verify_runs");

  /** @type {Map<string, {row: object, kind: string}>} */
  const confirmable = new Map();
  let bookedRows = [];
  let changedRows = [];
  let changedIds = [];
  // "The read failed" and "the read found nothing" are the SAME VALUE in most
  // of services/db.js, and here they are opposite conclusions: one is a
  // database outage, the other is an accusation that the model fabricated a
  // booking. listAppointmentsByCallId returns null on failure specifically so
  // this distinction survives, and withTenantSafe is given an explicit null
  // fallback so its own catch cannot flatten it back into an empty list.
  let readFailed = false;

  try {
    // Bookings resolve by call_id. This is the whole of LVX29's claim to be
    // reading the database rather than the model: `appointments.call_id` is
    // written from ctx.callId on every booking and has never been read until
    // now, so "what did THIS call write" needs no heuristic.
    if (callId) {
      const found = await db.withTenantSafe(
        businessId,
        () => db.listAppointmentsByCallId(callId, businessId),
        { operation: "listAppointmentsByCallId", fallback: null }
      );
      if (found == null) readFailed = true;
      else bookedRows = found;
    }

    // Cancels and reschedules create no row, so call_id cannot find them. The
    // appointment id arrives on the effect the appointments pack already emits
    // ({type:"changed", data:{tool, appointmentId}}), and the row is then read
    // back so the STATUS and the TIME come from the database either way.
    //
    // A fabricated cancellation emits no effect, so there is no id, so there
    // is no message -- which is the wanted behaviour, not a gap.
    changedIds = [
      ...new Set(writes.filter((w) => w?.type === CHANGED && w.appointmentId).map((w) => w.appointmentId)),
    ];
    for (const id of changedIds) {
      const found = await db.withTenantSafe(businessId, () => db.getAppointmentById(id, businessId), {
        operation: "getAppointmentById",
      });
      if (found) changedRows.push(found);
    }
  } catch (err) {
    log.error("postcall_verify_failed", { callSid, businessId, reason: err?.message, severity: "warn" });
    return { mode, verdict: "error", rows: [], sent: [], skipped: [] };
  }

  // Booked first, changed second, keyed by row id: a call that books and then
  // reschedules the same appointment is one outcome to the caller, not two
  // messages, and the later read is the truer one.
  for (const r of bookedRows) confirmable.set(r.id, { row: r, kind: "appointment_confirmation" });
  for (const r of changedRows) {
    confirmable.set(r.id, {
      row: r,
      kind: r.status === "cancelled" ? "appointment_cancelled" : "appointment_confirmation",
    });
  }

  // A read that failed cannot support ANY verdict, least of all an accusation.
  // Nothing is counted and nothing is sent: a caller who really was booked gets
  // no message this time, which is the safe direction to fail in.
  if (readFailed) {
    log.error("postcall_verify_read_failed", { callSid, businessId, severity: "warn" });
    return { mode, verdict: "error", rows: [], sent: [], skipped: [] };
  }

  const verdict = reconcile({ claims, writes, bookedRows, changedRows, changedIds });
  if (verdict === "claim_without_row") bumpCounter("postcall_claim_without_row");
  if (verdict === "row_without_claim") bumpCounter("postcall_row_without_claim");
  if (verdict === "row_mismatch") bumpCounter("postcall_row_mismatch");

  const sent = [];
  const skipped = [];

  if (mode === "send") {
    for (const { row, kind } of confirmable.values()) {
      const to = row.client_phone;
      if (!isValidE164(to)) {
        // Counted and reported, never redirected. See the note on callerNumber.
        skipped.push({ appointmentId: row.id, reason: "no_phone" });
        bumpCounter("postcall_confirm_skipped_no_phone");
        continue;
      }
      try {
        await notifications.sendCallerSms(
          config,
          to,
          kind,
          {
            name: row.client_name || "there",
            business: config.businessName,
            // Business timezone and locale profile, matching the booking-time
            // sender in capabilities/appointments.js so the two cannot drift
            // into quoting different times for the same row.
            datetime: row.scheduled_at
              ? speakableDateTime(row.scheduled_at, config.timezone, resolveProfile(config))
              : "your requested time",
          },
          // The consent gate's own justification (services/notifications.js)
          // is TCPA and HIPAA 164.522(b), both US and both written for a US
          // clinic. The owner's decision on 2026-09-03 is that a
          // confirmation of a booking the caller just made is a transactional
          // service message. Passed explicitly, per call site, so no existing
          // sender's behaviour moves and the choice is greppable.
          { transactional: true }
        );
        sent.push({ appointmentId: row.id, kind });
        bumpCounter("postcall_confirm_sent");
      } catch (err) {
        skipped.push({ appointmentId: row.id, reason: "send_failed" });
        bumpCounter("postcall_confirm_failed");
        log.error("postcall_confirm_failed", { callSid, kind, reason: err?.message, severity: "warn" });
      }
    }
  }

  // Shapes and counts only. The caller's name, number and appointment time are
  // all in scope here and none of them belong in a log line -- LVX24 was
  // exactly this mistake, made by a sanitizer logging the text it caught.
  log.info("postcall_verify", {
    callSid,
    businessId,
    mode,
    verdict,
    booked_rows: bookedRows.length,
    changed_rows: changedRows.length,
    claims: claims.length,
    sent: sent.length,
    skipped: skipped.map((s) => s.reason),
  });

  return { mode, verdict, rows: [...confirmable.values()].map((c) => c.row), sent, skipped };
}

/**
 * Where the call's account of itself and the database disagree.
 *
 * `row_mismatch` is checked before `claim_without_row` deliberately: a booked
 * EFFECT means the tool ran and returned success, so a missing row is a write
 * that failed or was scoped out, which is a different failure from the model
 * narrating a booking it never attempted.
 */
function reconcile({ claims, writes, bookedRows, changedRows, changedIds = [] }) {
  const claimed = claims.some((c) => c?.kind === "claim");
  const bookedEffect = writes.some((w) => w?.type === BOOKED);

  if (bookedEffect && bookedRows.length === 0) return "row_mismatch";
  // A changed row that cannot be read back is the same shape: the tool ran and
  // reported success, and the row is not there to confirm it.
  if (changedRows.length < changedIds.length) return "row_mismatch";

  // An EFFECT is itself evidence that a tool ran and succeeded, so a call that
  // wrote something is not accused of fabricating merely because its rows were
  // unreadable. Only a claim with no effect AND no row is a fabrication.
  const wroteAnything = bookedRows.length > 0 || changedRows.length > 0 || writes.length > 0;

  if (claimed && !wroteAnything) return "claim_without_row";
  if (!claimed && wroteAnything) return "row_without_claim";
  return "ok";
}
