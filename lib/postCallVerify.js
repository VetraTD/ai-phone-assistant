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

// Named here rather than inlined below, because this module otherwise knows
// nothing about individual tools and deals only in effect shapes. This is the
// one exception and it should be visible as one: a note changes a row without
// changing anything the caller needs telling about.
const NOTE_TOOL = "add_appointment_note";

/**
 * Verdicts that say the ROW ITSELF may be wrong, so no caller is told about it.
 *
 * `write_abandoned` is LVX72's shape: the booking exists, the name-correction
 * tool was refused and never retried, and the row carries a name the caller did
 * not give. `row_mismatch` is a tool that reported success over a row that
 * cannot be read back at all.
 *
 * Deliberately a deny-list rather than an `=== "ok"` allow-list. The verdicts
 * here describe TOOLS, and most of them say nothing about whether the row is
 * correct -- `row_without_claim` in particular means the booking is real and
 * the assistant simply never mentioned it, which is the case a post-call
 * confirmation exists for.
 */
const SUPPRESSES_CONFIRMATION = new Set(["write_abandoned", "row_mismatch"]);

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
    // Action tools that were REFUSED and never afterwards succeeded.
    //
    // A structural signal, and a stronger one than matching sentences, because
    // it does not depend on how the model phrased anything. See LVX72: the
    // model called the name-correction tool, the spelling gate refused it
    // pending a spelling, the caller gave the spelling, and the tool was never
    // called again — the change was announced as done and the row never moved.
    //
    // Defaults to empty, so every existing caller behaves exactly as before,
    // and the cascade — which will never pass it — is untouched.
    abandoned = [],
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

  // A ROW THAT ONLY GAINED A NOTE IS NOT AN OUTCOME TO TEXT SOMEBODY ABOUT.
  //
  // add_appointment_note emits {type:"changed"} because the row genuinely did
  // change, and counting it as changed is right. Confirming it is not: a caller
  // who asked for a detail to be recorded against an appointment that did not
  // move would receive an "appointment_confirmation" for a booking nothing
  // happened to, which is a message about nothing and reads as a system that
  // texts at random.
  //
  // Only ids whose ONLY change was a note are excluded. A reschedule that was
  // also noted still confirms -- the note must not suppress a real change any
  // more than it should manufacture one.
  //
  // Found on the first real call to use the tool, 2026-09-05, and it did not
  // fire there for two reasons that are both accidents: the run was
  // POSTCALL_VERIFY=count, and the note landed on a row booked in the same
  // call, so the id collision hid it behind the booking's own confirmation.
  const changedByOther = new Set(
    writes
      .filter((w) => w?.type === CHANGED && w.appointmentId && w.tool !== NOTE_TOOL)
      .map((w) => w.appointmentId)
  );
  const noteOnlyIds = new Set(
    writes
      .filter((w) => w?.type === CHANGED && w.appointmentId && w.tool === NOTE_TOOL)
      .map((w) => w.appointmentId)
      .filter((id) => !changedByOther.has(id))
  );

  // Booked first, changed second, keyed by row id: a call that books and then
  // reschedules the same appointment is one outcome to the caller, not two
  // messages, and the later read is the truer one.
  for (const r of bookedRows) confirmable.set(r.id, { row: r, kind: "appointment_confirmation" });
  for (const r of changedRows) {
    if (noteOnlyIds.has(r.id) && !confirmable.has(r.id)) continue;
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

  // The POSITIVE half, and the reason it exists is a real dead end.
  //
  // Every other counter in this module fires when something is WRONG, which
  // means a call that booked cleanly and a call that never tried to book look
  // identical from the outside: all zeros. A scripted harness run on 2026-09-03
  // drove a whole booking conversation and could not tell those two apart --
  // the instrument could not see the case it was pointed at, which is a mistake
  // this repository has already paid for once with LIVE_DEBUG_TRANSCRIPT.
  //
  // Counted per ROW rather than per call, because "one booking" and "three
  // cancellations in one turn" are different facts and LVX33 is about the
  // second one.
  for (let i = 0; i < bookedRows.length; i += 1) bumpCounter("postcall_booked_rows");
  for (let i = 0; i < changedRows.length; i += 1) bumpCounter("postcall_changed_rows");

  const verdict = reconcile({ claims, writes, bookedRows, changedRows, changedIds, abandoned });
  if (verdict === "write_abandoned") bumpCounter("postcall_write_abandoned");
  if (verdict === "claim_without_row") bumpCounter("postcall_claim_without_row");
  if (verdict === "row_without_claim") bumpCounter("postcall_row_without_claim");
  if (verdict === "row_mismatch") bumpCounter("postcall_row_mismatch");

  // -------------------------------------------------------------------------
  // LVX97's RECONCILIATION. A fabricated booking reaches a human, every time.
  //
  // This is the half of the LVX27 family that does not require the model's
  // cooperation, and that is the entire reason it exists. The claim note works
  // -- on call 7aef50 it produced a retracted claim, a real booking and a row
  // that exists -- but it works by ASKING, and an hour earlier on call 156fb2
  // the same model in the same config fabricated a consultation, was never
  // corrected, and then told the caller three times that no such appointment
  // existed, twice suggesting the mistake was theirs. Nothing in the system
  // could tell those two calls apart.
  //
  // So the model is left out of it. `claim_without_row` means the call told the
  // caller something was done and the database holds nothing that did it. That
  // is a row in customer_requests and a notification, unconditionally, and a
  // person decides what to do about it. The fabrication may still happen; what
  // changes is that nobody has to read a call by hand to find out.
  //
  // MODE-INDEPENDENT, unlike the SMS confirmations below. `send` governs
  // messages to the CALLER, and telling a caller "we think our receptionist
  // made this up" is not something to do automatically. This one goes to the
  // business, which is the party that can check a calendar.
  //
  // NO CALLER SPEECH in the row. request_type, the call id and the verdict --
  // enough for a human to pull the call up, and nothing that repeats what the
  // assistant said. LVX24 was a sanitizer logging the text it caught.
  //
  // SCOPED, because the service runs as vetra_app NOBYPASSRLS: an unscoped
  // insert matches no policy, writes nothing, and returns success.
  if (verdict === "claim_without_row") {
    try {
      const requestId = await db.withTenantSafe(
        businessId,
        () =>
          db.createCustomerRequest({
            businessId,
            callId,
            requestType: "unconfirmed_claim",
            callbackNumber: callerNumber || null,
            notes:
              "Automated check: the assistant told the caller an appointment was booked, " +
              "cancelled or changed, and no matching record exists. Please listen to this " +
              "call and contact the caller if needed.",
          }),
        { operation: "postcallClaimReconcile", callSid, fallback: null }
      );
      if (requestId) {
        bumpCounter("postcall_claim_reconciled");
        log.error("postcall_claim_reconciled", { callSid, businessId, requestId, severity: "warn" });
        await notifications.notifyUnconfirmedClaim({
          businessId,
          callbackNumber: callerNumber || null,
        });
      } else {
        // A write that returned nothing is the RLS failure mode this file
        // already knows about, and it must not read as "nothing to report".
        bumpCounter("postcall_claim_reconcile_failed");
        log.error("postcall_claim_reconcile_failed", {
          callSid,
          businessId,
          reason: "no row returned",
          severity: "warn",
        });
      }
    } catch (err) {
      bumpCounter("postcall_claim_reconcile_failed");
      log.error("postcall_claim_reconcile_failed", {
        callSid,
        businessId,
        reason: err?.message,
        severity: "warn",
      });
    }
  }

  const sent = [];
  const skipped = [];

  // A CONFIRMATION MUST NOT OUTRUN THE VERDICT THAT SAYS IT IS TRUE. LVX114.
  //
  // The loop below used to be gated on the mode and nothing else. So a call
  // whose verdict was `write_abandoned` -- LVX72's exact shape: the booking row
  // exists, the name-correction tool was refused and never retried, and the row
  // therefore carries the WRONG NAME -- still texted the caller a confirmation
  // quoting it. Same for `row_mismatch`, where a tool reported success and the
  // row cannot be read back at all.
  //
  // A confirmation is a promise that the row is RIGHT, so what suppresses it is
  // a verdict that impugns the row -- not merely a verdict that is not `ok`.
  //
  // `row_without_claim` still sends, and getting that backwards would have
  // broken the case the send path is most useful for: a real booking the
  // assistant never mentioned to the person who made it (LVX72's call). The row
  // is correct there; only the conversation was lacking, and a caller who was
  // never told is exactly who needs the text.
  //
  // `claim_without_row` is not listed because it cannot reach here anyway --
  // there is no row to build a message from, so it already sent nothing.
  if (mode === "send" && SUPPRESSES_CONFIRMATION.has(verdict)) {
    bumpCounter("postcall_confirm_skipped_verdict");
    log.info("postcall_confirm_skipped_verdict", { callSid, businessId, verdict });
  }

  // Rows THIS CALL booked, which the appointments pack has already texted about.
  //
  // capabilities/appointments.js onEffect calls sendCallerSms the moment a
  // booking succeeds, from the same row this module would read. With consent on
  // file BOTH fire and the caller gets two messages for one appointment -- and
  // to two possibly different numbers, because that sender uses the Twilio
  // caller ID and this one uses the row. The post-call message is the later of
  // the two and therefore the duplicate, so it is the one that yields.
  //
  // Only bookings. A cancellation or a reschedule of an older appointment emits
  // no booking confirmation, so there is nothing to duplicate and this cannot
  // swallow one.
  const confirmedAtBooking = new Set(
    writes.filter((w) => w?.type === BOOKED && w.appointmentId).map((w) => w.appointmentId)
  );

  if (mode === "send" && !SUPPRESSES_CONFIRMATION.has(verdict)) {
    for (const { row, kind } of confirmable.values()) {
      const to = row.client_phone;
      if (!isValidE164(to)) {
        // Counted and reported, never redirected. See the note on callerNumber.
        skipped.push({ appointmentId: row.id, reason: "no_phone" });
        bumpCounter("postcall_confirm_skipped_no_phone");
        continue;
      }

      if (kind === "appointment_confirmation" && confirmedAtBooking.has(row.id)) {
        skipped.push({ appointmentId: row.id, reason: "already_confirmed" });
        bumpCounter("postcall_confirm_skipped_duplicate");
        continue;
      }

      // THE NUMBER ON THE ROW CAME FROM THE MODEL. Counted, never redirected.
      //
      // `callerNumber` is the network's -- Twilio put it there. `client_phone`
      // is whatever the model transcribed, and LVX114 has it reading back
      // "that's 469-933-8887?" off a channel that has turned 2,480 ms of speech
      // into zero characters. One wrong digit sends a person's name and
      // appointment time to a stranger.
      //
      // NOT a reason to refuse or to substitute: booking on somebody else's
      // behalf is legitimate, and the owner's rule is that the row's number
      // wins. But nobody has ever looked at how often the two disagree, and
      // that is answerable before it is ever anything more than a number.
      if (callerNumber && to !== callerNumber) {
        bumpCounter("postcall_confirm_number_mismatch");
        log.info("postcall_confirm_number_mismatch", { callSid, businessId });
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
    // Tool NAMES only. They are engine vocabulary rather than caller data, and
    // without them "write_abandoned" says something went wrong without saying
    // which write — which is the LVX71 mistake one layer up.
    abandoned,
    sent: sent.length,
    skipped: skipped.map((s) => s.reason),
  });

  return { mode, verdict, abandoned, rows: [...confirmable.values()].map((c) => c.row), sent, skipped };
}

/**
 * Where the call's account of itself and the database disagree.
 *
 * `row_mismatch` is checked before `claim_without_row` deliberately: a booked
 * EFFECT means the tool ran and returned success, so a missing row is a write
 * that failed or was scoped out, which is a different failure from the model
 * narrating a booking it never attempted.
 */
function reconcile({ claims, writes, bookedRows, changedRows, changedIds = [], abandoned = [] }) {
  const claimed = claims.some((c) => c?.kind === "claim");
  const bookedEffect = writes.some((w) => w?.type === BOOKED);

  if (bookedEffect && bookedRows.length === 0) return "row_mismatch";
  // A changed row that cannot be read back is the same shape: the tool ran and
  // reported success, and the row is not there to confirm it.
  if (changedRows.length < changedIds.length) return "row_mismatch";

  // A tool the model was told to retry and never did. Checked BEFORE the
  // wroteAnything test below, which is the whole point: on the call that found
  // this, a booking had succeeded in the same conversation, so wroteAnything
  // was true and the verdict came back `ok` on a change that never happened.
  // An unrelated success must not vouch for an abandoned write.
  if (abandoned.length > 0) return "write_abandoned";

  // An EFFECT is itself evidence that a tool ran and succeeded, so a call that
  // wrote something is not accused of fabricating merely because its rows were
  // unreadable. Only a claim with no effect AND no row is a fabrication.
  const wroteAnything = bookedRows.length > 0 || changedRows.length > 0 || writes.length > 0;

  // THE SAME PRINCIPLE AS `abandoned`, APPLIED TO `claimed`. LVX114.
  //
  // The paragraph directly above says an unrelated success must not vouch for
  // an abandoned write. It was true of `claimed` too and nobody had extended
  // it, so `wroteAnything` let ANY write vouch for ANY claim.
  //
  // Call CAbdff67b2: the assistant said "we're all set for Monday, September
  // 14th, at 1 PM" and book_appointment NEVER RAN. Ninety seconds later a
  // cancel_appointment_db succeeded -- on the caller's real, existing Friday
  // appointment. That cancellation made `wroteAnything` true, the verdict came
  // back `ok`, notifyUnconfirmedClaim never fired, and the caller left the call
  // having lost a real appointment and gained an imaginary one, with the ledger
  // reporting a clean call. A CANCELLATION VOUCHED FOR A BOOKING.
  //
  // So a claim that named an act is now satisfied only by a write that could
  // have performed THAT act. `satisfiedBy` comes from the capability pack via
  // the claim ledger (capabilities/appointments.js claimActions) -- this module
  // still knows no tool names of its own beyond NOTE_TOOL.
  //
  // AN UNCLASSIFIED CLAIM KEEPS THE OLD RULE EXACTLY. `satisfiedBy` empty means
  // either the locale probes found no act, or two acts, or the owning pack has
  // not declared one -- and in all three cases any write vouches, as it always
  // has. That is deliberate and it is LVX57: a false alarm teaches the reader to
  // ignore the ledger, so the new verdict fires only where the claim actually
  // named something.
  //
  // Defaults to the old behaviour for callers that pass no `satisfiedBy` at
  // all, which is the cascade -- the same construction `abandoned` uses to stay
  // invisible to tier 3.
  const writtenTools = new Set(writes.map((w) => w?.tool).filter(Boolean));
  const unsatisfied = claims.filter((c) => {
    if (c?.kind !== "claim") return false;
    const satisfiedBy = Array.isArray(c.satisfiedBy) ? c.satisfiedBy.filter(Boolean) : [];
    if (satisfiedBy.length === 0) return !wroteAnything;
    return !satisfiedBy.some((tool) => writtenTools.has(tool));
  });
  if (unsatisfied.length > 0) return "claim_without_row";

  if (!claimed && wroteAnything) return "row_without_claim";
  return "ok";
}
