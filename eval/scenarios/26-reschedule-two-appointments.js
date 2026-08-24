/**
 * RESCHEDULE — the flow that dead-aired on a live call.
 *
 * Two appointments on the caller's number is the load-bearing detail: the pack
 * only auto-selects when exactly one matches, so the receptionist has to ask
 * which one and then look again. That is the four-round chain that overran the
 * old three-round cap, and it is the flow where the model wrote its tool call
 * as text and nothing ran at all.
 *
 * The eval has no audio and cannot reproduce dead air. The closest honest proxy
 * is "no turn whose ENTIRE reply is a promise" — and that would have caught
 * turns 20, 24 and 26 of the reported call.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, sameInstant } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const KEEP = nextWeekdayAt("tue", "10:00", { timezone: TZ });
const MOVE = nextWeekdayAt("wed", "14:00", { timezone: TZ });
const TARGET = nextWeekdayAt("fri", "10:00", { timezone: TZ });

export default {
  name: "reschedule-two-appointments",
  tags: ["ordering", "identity", "reschedule", "rules"],
  fixture: "appointments-db",
  configPatch: {
    capabilities: {
      appointments: {
        enabled: true,
        adapter: "internal",
        require: { identity: { builtin: ["name", "dob"] } },
      },
    },
  },
  extrasPatch: { callerPhone: CALLER_PHONE },
  // THE IDS MUST BE REAL UUIDs, AND THAT IS NOT COSMETIC.
  //
  // `appointments.id` is `uuid PRIMARY KEY DEFAULT gen_random_uuid()` in
  // database/schema.sql, and both tool declarations describe the parameter as
  // "UUID of the appointment" (capabilities/appointments.js:241, :263). This
  // fixture used to seed "appt-keep" / "appt-move" — so the model was told the
  // argument was a UUID, handed something that plainly was not one, and
  // SYNTHESISED a UUID rather than echoing what the lookup returned. One run
  // produced `apt-22222222-2222-2222-2222-222222222222`; another passed the
  // string "Wednesday, August 26, 2026 at 2:00 PM" as an id.
  //
  // A fabricated id then resolves to no row, and `appointmentBelongsToCaller`
  // returns false for a missing row exactly as it does for someone else's — so
  // the caller was told "I can only make changes to appointments booked under
  // your number" about an appointment booked under their number, and the model
  // degraded to taking a message.
  //
  // Measured 2026-08-24, 5 runs per arm, same code, only these two ids changed:
  //
  //            hard pass    first appointment_id correct
  //   old ids     2/5                 1/5
  //   uuids       5/5                 5/5
  //
  // Fisher one-sided via scripts/eval-band.js: hard pass p=0.0833 (NOT
  // significant — the documented n=5 limit), first-id-correct p=0.0238
  // (significant). The aggregate could not see what the mechanism could.
  //
  // This scenario was one of the three carrying the whole 35-37 noise band, and
  // the band was being read as model non-determinism. It was a fixture.
  //
  // WHAT THIS DOES NOT FIX, so nobody reads the green as more than it is: the
  // model can still invent an id — services/gemini.js:818's comment records it
  // doing so on a real call, where ids ARE uuids. The fixture inflated the
  // rate; it did not create the failure.
  seedAppointments: [
    { id: "7f3a1c62-9d4e-4b18-a5c0-2e6b8d91f4a7", client_name: "Priya Nair", client_phone: CALLER_PHONE, scheduled_at: KEEP, status: "scheduled" },
    { id: "b28e5d10-6c37-4a92-8f15-3d70ae4c1b96", client_name: "Priya Nair", client_phone: CALLER_PHONE, scheduled_at: MOVE, status: "scheduled" },
  ],
  caller: {
    mode: "persona",
    persona:
      "You are Priya Nair. You have TWO appointments booked and you want to move the Wednesday afternoon one " +
      "to Friday morning at 10am — the Tuesday one stays exactly where it is. When asked which appointment, " +
      "say the Wednesday one. When asked your name say 'Priya Nair'; when asked your date of birth say " +
      "'June 14th, 1990'. Answer one question at a time. Do not say goodbye until you have been told the " +
      "change is confirmed.",
    goal:
      `Move your ${spokenSlot(MOVE, TZ)} appointment to ${spokenSlot(TARGET, TZ)}. Leave the other one alone. ` +
      "Only wrap up once the change is confirmed.",
    maxTurns: 10,
  },
  hard: [
    (ctx) => A.toolCalled(ctx, "get_caller_appointments_from_db"),
    (ctx) => A.toolBefore(ctx, "get_caller_appointments_from_db", "reschedule_appointment_db"),
    (ctx) => A.toolSucceeded(ctx, "reschedule_appointment_db"),
    (ctx) => A.replyMatchesBeforeTool(ctx, /date of birth|birth date|d\.?o\.?b/i, "reschedule_appointment_db"),
    // The outcome, not the tool trace: the right row actually moved and the
    // other one did not. On the live call the model described a reschedule that
    // never happened, and the row is still sitting at its original time.
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      const moved = rows.some((r) => sameInstant(r.scheduled_at, TARGET));
      const kept = rows.some((r) => sameInstant(r.scheduled_at, KEEP));
      return {
        pass: moved && kept,
        name: "wednesday-moved-tuesday-untouched",
        detail: `moved=${moved} kept=${kept}`,
      };
    },
    // Nothing shaped like our internals reached the caller.
    (ctx) => A.replyNeverMatches(ctx, /default_api|[a-z0-9]+_[a-z0-9_]+\s*[:{(]|[{}]/),
    // The dead-air proxy: no turn that is nothing but a promise.
    (ctx) => A.replyNeverMatches(ctx, /^\s*(one moment|let me check|i'?ll update)[^.!?]*[.!?]\s*$/i),
  ],
  judge: [
    "Did the receptionist establish which of the two appointments was being moved before changing anything?",
    "Did it read the new time back and get a clear yes?",
  ],
};
