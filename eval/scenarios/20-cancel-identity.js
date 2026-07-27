/**
 * ORDERING + IDENTITY: cancelling an existing appointment must go through the
 * ENFORCED identity path. The business requires name + date of birth before any
 * appointment change (require.identity.builtin), so a correct receptionist asks
 * for both BEFORE it reaches cancel_appointment_db — and the tool layer refuses
 * the cancel until those args are present (services/tools.js checkRequirements).
 *
 * The appointments-db fixture sets no identity requirement of its own, so this
 * scenario patches one on: that is the whole point — to exercise the enforced
 * name+dob path end to end, not the bare tool.
 *
 * callerPhone matches the seeded appointment's number so the phone-only DB
 * lookup can find it (and the pack's own ownership check passes); the enforced
 * name+dob requirement is still exercised independently, because
 * checkRequirements refuses the cancel whenever client_name / identity_dob are
 * missing regardless of the phone match.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const APPT = nextWeekdayAt("wed", "14:00", { timezone: TZ });

const DOB_ASK = /date of birth|birth date|d\.?o\.?b/i;
const NAME_ASK = /your name|name is|full name|who('?s| is) this|may i (have|take) your name/i;

export default {
  name: "cancel-identity",
  tags: ["ordering", "identity"],
  fixture: "appointments-db",
  // The fixture has no identity requirement — add the enforced name+dob path so
  // the pre-write checkRequirements gate is actually exercised.
  configPatch: {
    capabilities: {
      appointments: {
        enabled: true,
        adapter: "internal",
        require: { identity: { builtin: ["name", "dob"] } },
      },
    },
  },
  // The caller is calling FROM the number the appointment is booked under, which
  // is how the phone-only DB lookup finds it.
  extrasPatch: { callerPhone: CALLER_PHONE },
  seedAppointments: [
    {
      id: "appt-priya",
      client_name: "Priya Nair",
      client_phone: CALLER_PHONE,
      scheduled_at: APPT,
      status: "scheduled",
    },
  ],
  caller: {
    mode: "persona",
    persona:
      "You are Priya Nair, calm and cooperative. You booked an appointment and now need to cancel it. " +
      "When the receptionist asks for your name, say 'Priya Nair'. When asked for your date of birth, " +
      "say 'June 14th, 1990'. You answer every question they ask, one at a time. You do NOT end the call " +
      "or say goodbye until the receptionist has clearly told you the cancellation is confirmed/done.",
    goal:
      `Cancel your existing appointment (it is on ${spokenSlot(APPT, TZ)}). Provide your name and date of ` +
      `birth whenever asked. Only wrap up once you have heard the cancellation is confirmed.`,
    maxTurns: 8,
  },
  hard: [
    // The cancel actually happened and succeeded (only one seeded appointment,
    // so success == the right appointment was cancelled).
    (ctx) => A.toolSucceeded(ctx, "cancel_appointment_db"),
    // Correctness check independent of tool args: the seeded appointment is no
    // longer scheduled in the store.
    (ctx) => {
      const stillScheduled = (ctx.store?.scheduled?.() || []).some((r) => /priya/i.test(r.client_name || ""));
      return {
        pass: !stillScheduled,
        name: "priya-appointment-no-longer-scheduled",
        detail: stillScheduled ? "Priya's appointment is still scheduled" : "cancelled in the store",
      };
    },
    // Identity args present per requirements.js param naming: name reuses
    // client_name, dob adds identity_dob (builtinParamsFor).
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "cancel_appointment_db",
        (args) => typeof args.client_name === "string" && args.client_name.trim() !== "",
        "client_name present"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "cancel_appointment_db",
        (args) => typeof args.identity_dob === "string" && args.identity_dob.trim() !== "",
        "identity_dob present"
      ),
    // Ordering: the receptionist asked for identity BEFORE it reached the cancel
    // tool — no act-then-ask.
    (ctx) => A.replyMatchesBeforeTool(ctx, DOB_ASK, "cancel_appointment_db"),
    (ctx) => A.replyMatchesBeforeTool(ctx, NAME_ASK, "cancel_appointment_db"),
  ],
  judge: [
    "Did the receptionist verify the caller's identity (name and date of birth) before cancelling?",
    "Did the receptionist confirm the specific appointment (date/time) before cancelling it?",
  ],
};
