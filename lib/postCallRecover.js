import * as dbModule from "../services/db.js";
import { log as defaultLog } from "./logger.js";
import { bumpCounter } from "./voice/metrics.js";
import { judgeCall, selectAgreedSlot } from "./postCallJudge.js";
// The SAME reader the live booking path uses, imported rather than copied. A
// duplicated `length: 30` here would go on agreeing with it right up until
// someone changed one of them, and the recovered row would then be a different
// length from every row the call itself would have written.
import { availabilitySettings } from "../capabilities/appointments.js";
import { capabilityConfig } from "./capabilities/requirements.js";

// ---------------------------------------------------------------------------
// THE BOOKING THE CALL AGREED TO AND NEVER MADE, BOOKED.
//
// Every other safety net in this repository ends by telling a human. That is the
// right fallback and the wrong default: the caller was told they were booked, so
// the truthful outcome is that they ARE booked, not that somebody rings them back
// tomorrow to ask what they wanted.
//
// ---------------------------------------------------------------------------
// Why this is not claimSlot.js, which was reverted for writing wrong times
// ---------------------------------------------------------------------------
//
// That attempt failed on ONE thing: it had to pick a slot out of `verifiedSlots`
// with no information about which, and a whole-day query puts sixteen in there.
// "Use the time this call verified" is ambiguous sixteen ways, so it wrote a
// verified-but-wrong time with every guard passing. LVX115 measured it: 16
// verified, 1 point-checked, and the booking landed on neither.
//
// The missing information was never the times. It was the caller's CHOICE among
// them. So:
//
//   the candidate set   <- availability tool RESPONSES (guards.verifiedSlotList)
//   the choice          <- a reader, returning an INDEX into that set
//   the time written    <- slots[index], never a parsed timestamp
//
// A reader that invents a time cannot express it, because the only thing it can
// return is a position in a list it was handed. The worst it can do is pick the
// wrong member of a set of real openings, and `selectAgreedSlot`'s rules make
// "none" the answer on ambiguity or on a time that is not in the set.
//
// ---------------------------------------------------------------------------
// The name, and why it is null rather than guessed
// ---------------------------------------------------------------------------
//
// LVX77: a booking retry wrote "Jane Doe" -- a name the caller never said -- into
// an appointment, and that is why the end-of-call sweep re-issues messages and
// refuses bookings. The lesson is not "never book"; it is never to invent an
// identifier.
//
// `create_appointment_if_available` takes a nullable client_name, and the CALLER'S
// PHONE NUMBER comes from the phone network rather than from the model. So the row
// is identified by something no model touched, the name is taken only from a
// booking this caller previously completed, and otherwise it is left NULL. A
// business looking at a held slot with a real number can ring the person. A
// business looking at the wrong name cannot tell that anything is wrong.
//
// Nothing here reads the name out of this call's transcript. The provenance check
// cannot tell a fabricated name from an ASR-mangled one -- measured, it refuses
// four in five, two of them legitimate -- so a name from prose would be a guess
// wearing a guard.
//
// ---------------------------------------------------------------------------
// What cannot go wrong, structurally
// ---------------------------------------------------------------------------
//
//   DOUBLE BOOKING -- `create_appointment_if_available` is one atomic statement
//   that checks capacity and inserts. A slot taken between the call ending and
//   this running returns no id, and that is a clean decline rather than a clash.
//
//   BOOKING OVER A ROW THAT EXISTS -- the row read happens FIRST and skips
//   everything, so this can only ever run on a call that recorded nothing. It is
//   also why the common case costs no model call at all.
//
//   AN UNSCOPED WRITE -- the service runs as vetra_app NOBYPASSRLS, so a
//   tenantless insert matches no policy, writes nothing, and reports success.
//   Every statement here goes through withTenantSafe.
//
//   A FAILED READ READING AS "NOTHING BOOKED" -- listAppointmentsByCallId returns
//   null for a failed read and [] for a genuinely empty one. null aborts.
//
// Never throws. It runs fire-and-forget at call teardown, so every failure
// resolves to a result.
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.businessId
 * @param {string} input.callId - the database call id
 * @param {string|null} [input.callSid]
 * @param {string|null} [input.callerNumber]
 * @param {string[]} [input.slots] - guards.verifiedSlotList()
 * @param {"off"|"shadow"|"act"} [input.mode]
 * @param {number} [input.lengthMinutes]
 * @param {number} [input.capacity]
 * @param {object} [deps] - test seam: { db, log, judge, select }
 */
export async function recoverOwedBooking(input, deps = {}) {
  const {
    businessId = null,
    callId = null,
    callSid = null,
    callerNumber = null,
    config = null,
    slots = [],
    // Did the ENGINE record the caller affirming a read-back, at any point on
    // this call? Structural: caller audio through isAffirmative, and the
    // assistant's previous turn through confirmReadBackRe. No prose
    // classification, and the same signal verifyCall's bookingOwed already uses.
    agreed = false,
    mode = "off",
  } = input || {};
  // Read from the tenant's own appointments config by the same function the live
  // booking path uses, so a recovered row is the same shape as a live one.
  const { length: lengthMinutes, capacity } = availabilitySettings(capabilityConfig(config, "appointments"));

  const db = deps.db || dbModule;
  const log = deps.log || defaultLog;
  const judge = deps.judge || judgeCall;
  const select = deps.select || selectAgreedSlot;

  // Only the acting rung writes. Turning the judge on for measurement must never
  // start authoring a booking, which is why this is a third value and not a
  // boolean beside `shadow`.
  if (mode !== "act") return { ran: false, reason: "not_act", booked: false };
  if (!businessId || !callId) return { ran: false, reason: "no_tenant", booked: false };

  // THE ROW READ FIRST, before any model call. Two reasons: a call that booked
  // normally must cost nothing, and a booking that exists must never be
  // second-guessed by a reader.
  //
  // SCOPED, and that is not belt-and-braces. The service runs as vetra_app
  // NOBYPASSRLS, so this SELECT outside a tenant scope matches no policy and
  // returns ZERO ROWS -- indistinguishable, to the line below, from a call that
  // genuinely booked nothing. An unscoped read here would therefore make the
  // recovery try to book over an appointment that already exists. server.js wraps
  // the identical call for the same reason.
  const existing = await db
    .withTenantSafe(businessId, () => db.listAppointmentsByCallId(callId, businessId), {
      operation: "recoverExistingRows",
      callSid,
      fallback: null,
    })
    .catch(() => null);
  if (existing == null) {
    // A FAILED read, not an empty one. Booking here would be booking during an
    // outage on the strength of not being able to look.
    bumpCounter("recover_row_read_failed");
    log.error("recover_row_read_failed", { callSid, severity: "warn" });
    return { ran: false, reason: "row_read_failed", booked: false };
  }
  // ANY ROW AT ALL, not just a scheduled one, and the difference is a hazard this
  // would otherwise have.
  //
  // A call that books and then cancels leaves a row with status `cancelled` and
  // nothing scheduled. On a `scheduled > 0` test this would proceed, the reader
  // would see a transcript in which a booking WAS agreed, and the recovery would
  // re-book the appointment the caller had just asked to kill. That shape is not
  // hypothetical: it is what call CA25e323 did on 2026-09-12, and what CA422f58
  // did before it.
  //
  // So the rule is narrower and states its own scope: this recovers calls that
  // recorded NOTHING. A call that touched the calendar and deliberately ended
  // with nothing scheduled has already been decided by the caller, and the
  // transcript cannot be trusted to tell those two apart -- the reader returns one
  // action for a call that contained two.
  if (existing.length > 0) {
    bumpCounter("recover_skipped_row_exists");
    return { ran: false, reason: "row_exists", booked: false };
  }

  // -------------------------------------------------------------------------
  // THE CALLER MUST HAVE AGREED TO SOMETHING, AS A STRUCTURAL FACT.
  //
  // Everything else on this path is a reader's judgement about prose, and the
  // reader's rules are the only thing standing between "they browsed times and
  // never approved anything" and a booking appearing in someone's calendar. Its
  // record is 6 of 6, which is a streak and not a rate.
  //
  // So this gate is the agreement ledger: the engine records a token only when
  // the caller's turn was affirmative AND the assistant's previous turn was a
  // read-back. Caller audio and the model's own output, no prose classification.
  // A caller who got most of the way through and never said yes produces no
  // token, and no verdict from the reader can override that.
  //
  // The token is action-BLIND -- measured, it carried a cancellation's consent to
  // a booking write ten turns later -- so it is used here exactly as LVX117 uses
  // it: only ever to REFUSE. It is not evidence that a booking was agreed; its
  // absence is evidence that nothing was.
  //
  // THE CASE THIS DOES NOT COVER, stated rather than discovered later: a caller
  // who agrees and then says "never mind". The ledger is a monotonic latch, so
  // the earlier agreement survives the withdrawal, and only the reader's rule 4
  // is between that and a recovered booking. Making it structural would need
  // prose heuristics over the caller's last turns, which is the treadmill this
  // work exists to get off. What bounds it is that verifyCall texts the caller a
  // confirmation off the new row, so a wrong recovery is visible to them in
  // minutes rather than at the appointment.
  // -------------------------------------------------------------------------
  if (agreed !== true) {
    bumpCounter("recover_skipped_never_agreed");
    return { ran: false, reason: "never_agreed", booked: false };
  }

  // No candidate times means no selection is possible, and a recovery with
  // nothing to choose from is exactly the case a human still has to own.
  if (!Array.isArray(slots) || slots.length === 0) {
    bumpCounter("recover_skipped_no_slots");
    return { ran: false, reason: "no_candidate_slots", booked: false };
  }

  // Scoped for the same reason, though this one fails CLOSED rather than open:
  // fetchCallTranscript takes no businessId and leans entirely on RLS, so
  // unscoped it returns [] and the recovery declines. Still wrong to rely on --
  // a feature that only ever declines is indistinguishable from one that is off.
  const transcript = await db
    .withTenantSafe(businessId, () => db.fetchCallTranscript(callId), {
      operation: "recoverTranscript",
      callSid,
      fallback: null,
    })
    .catch(() => null);
  if (!Array.isArray(transcript) || transcript.length === 0) {
    bumpCounter("recover_no_transcript");
    return { ran: false, reason: "no_transcript", booked: false };
  }

  // WAS a booking owed at all. The same reader, the same question it has been
  // answering in shadow -- this is the rung that acts on the answer.
  const verdict = await judge({ transcript, callSid, bookedRowCount: 0, mode: "shadow" });
  if (!verdict?.ran) return { ran: false, reason: "judge_did_not_run", booked: false };
  if (verdict.agreedAction !== "book") return { ran: true, reason: "nothing_owed", booked: false };
  bumpCounter("recover_booking_owed");

  const choice = await select({ transcript, slots, callSid, mode: "act" });
  if (!choice?.slot) {
    // Declined, ambiguous, or a time that was not among the openings. The
    // fallback is the existing escalation, which runs straight after this.
    bumpCounter("recover_no_selection");
    log.error("recover_no_selection", { callSid, candidates: slots.length, severity: "warn" });
    return { ran: true, reason: "no_selection", booked: false };
  }

  // A NAME ONLY IF THIS CALLER ALREADY GAVE ONE ON A BOOKING THAT SUCCEEDED.
  // Never from this call's prose. Null is a better row than a wrong name.
  let clientName = null;
  if (callerNumber) {
    const history = await db
      .withTenantSafe(businessId, () => db.listAppointmentsByCaller(businessId, { clientPhone: callerNumber }), {
        operation: "recoverCallerName",
        callSid,
        fallback: [],
      })
      .catch(() => []);
    const named = (history || []).find((r) => typeof r?.client_name === "string" && r.client_name.trim());
    clientName = named ? named.client_name.trim() : null;
  }

  let appointmentId = null;
  try {
    appointmentId = await db.withTenantSafe(
      businessId,
      () =>
        db.createAppointmentIfAvailable({
          businessId,
          callId,
          clientName,
          clientPhone: callerNumber || null,
          scheduledAt: choice.slot,
          // No caller speech. What it is and why it exists, so a human reading
          // the row knows it was not taken down live.
          notes:
            "Booked after the call by an automated check: the caller agreed to this time, " +
            "the calendar had confirmed it was open, and no booking was recorded during the call.",
          lengthMinutes,
          capacity,
        }),
      { operation: "recoverOwedBooking", callSid, fallback: null }
    );
  } catch (err) {
    // The insert throws on a real database error and returns null when the slot
    // is gone; those are different outcomes and only one of them is a fault.
    bumpCounter("recover_book_failed");
    log.error("recover_book_failed", { callSid, reason: err?.message, severity: "warn" });
    return { ran: true, reason: "book_error", booked: false };
  }

  if (!appointmentId) {
    // Either the slot went between the call ending and now, or the scoped write
    // matched no policy. Both mean no row, and the escalation behind this is what
    // the caller is owed.
    bumpCounter("recover_slot_unavailable");
    log.error("recover_slot_unavailable", { callSid, severity: "warn" });
    return { ran: true, reason: "slot_unavailable", booked: false };
  }

  bumpCounter("recover_booked");
  if (!clientName) bumpCounter("recover_booked_without_name");
  // An index and whether a name was carried. NOT the time and NOT the name: this
  // row is a caller's appointment.
  log.error("recover_booked", {
    callSid,
    businessId,
    appointmentId,
    slot_index: choice.slotIndex ?? null,
    candidates: slots.length,
    named: Boolean(clientName),
    confidence: choice.confidence || null,
    severity: "warn",
  });

  // NO MESSAGE SENT FROM HERE, deliberately. verifyCall runs immediately after
  // this and builds the caller's confirmation from the appointment ROW (LVX29) --
  // so the caller is told they are booked because a row says so, by the one path
  // that already dedupes against a confirmation the call itself sent. A second
  // sender here would be a second source of truth about the same appointment.
  return { ran: true, reason: null, booked: true, appointmentId };
}
