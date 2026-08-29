/**
 * A DAY IS NOT A TIME.
 *
 * Reported from a live call, 2026-08-29: the caller named a date and no time,
 * and the receptionist picked an hour for them and asked them to confirm it.
 * The caller never chose it.
 *
 * There was nothing else it could have done. `check_appointment_availability`
 * required a full datetime and rejected a bare date with "I didn't catch a
 * valid date and time", `book_appointment` accepts whatever datetime the model
 * computes, and no code path anywhere turned a day into a list of open times —
 * even though adapters/scheduling/internal.js's findSlots had always been able
 * to produce one. So the model guessed an hour and carried on.
 *
 * The fix gives the tool a second input shape (a bare YYYY-MM-DD) and the
 * booking guidance a step that names the case. This scenario is what proves the
 * model actually takes it.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt } from "../scenarioUtils.js";

const TZ = "America/Chicago";
// The DAY the caller will name. The time on it is never spoken by anyone.
const DAY = nextWeekdayAt("wed", "12:00", { timezone: TZ });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TZ }).format(
  new Date(DAY)
);
const DATE_ONLY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ,
}).format(new Date(DAY));

/** A date-only requested_at: YYYY-MM-DD and nothing else. */
const isDateOnly = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

export default {
  name: "date-without-time",
  tags: ["regression", "booking"],
  fixture: "appointments-availability",
  caller: {
    mode: "persona",
    persona:
      "You are Dana Fletcher. You know which DAY you want but you genuinely have no preference about " +
      "the time and you will not name one until you are offered actual options. If you are asked an " +
      "open question like 'what time works for you?' you say 'oh, whenever you have something — what " +
      "have you got?'. Once you are offered specific times you pick one of them.",
    goal:
      `Book an appointment on ${DAY_LABEL}. Do not say a time until the receptionist offers you ` +
      `specific times to choose from. When offered, pick one and confirm the booking.`,
    maxTurns: 12,
  },
  hard: [
    // THE assertion: the day was looked up as a day.
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "check_appointment_availability",
        (args) => isDateOnly(args.requested_at),
        "requested_at is a bare date (the caller named no time)"
      ),
    // ...and nothing was written before the caller had a time to choose from.
    (ctx) => A.toolBefore(ctx, "check_appointment_availability", "book_appointment"),
    // A booking must still happen. A receptionist that asks beautifully and
    // books nothing has not fixed the complaint.
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    // Whatever it books must carry a real time, not a bare date. This is the
    // backstop in validateBookingTime, asserted so it stays.
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => isDateOnly(args.scheduled_at),
        "scheduled_at is a bare date"
      ),
  ],
  judge: [
    "Did the receptionist offer the caller specific available times to choose from, rather than proposing a single time it had chosen itself?",
    "Did the receptionist avoid asking the caller to confirm a time the caller had never mentioned?",
    `Did the receptionist keep the appointment on the day the caller asked for (${DAY_LABEL})?`,
  ],
};
