/**
 * ORDERING: the receptionist must CHECK availability before it books, and must
 * never book a slot it just learned is taken. We seed a conflict at the exact
 * instant the caller requests, so a correct agent checks, hears "taken", and
 * pivots to alternatives instead of booking on top of it.
 *
 * This is the suite's live-verification scenario (`--filter availability-before-book`).
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const TAKEN = nextWeekdayAt("tue", "15:00", { timezone: TZ });

export default {
  name: "availability-before-book",
  tags: ["ordering"],
  fixture: "appointments-availability",
  seedAppointments: [
    { client_name: "Existing Patient", client_phone: "+15551110000", scheduled_at: TAKEN, status: "scheduled" },
  ],
  caller: {
    mode: "scripted",
    turns: [
      `Hi, I'd like to book an appointment for ${spokenSlot(TAKEN, TZ)}.`,
      "Oh, hmm. Let me think about it and I'll call back. Thanks!",
    ],
  },
  hard: [
    (ctx) => A.toolCalled(ctx, "check_appointment_availability"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "check_appointment_availability",
        (args) => slotMatches(args.requested_at, TAKEN, TZ),
        "requested_at = the taken slot"
      ),
    (ctx) => A.toolBefore(ctx, "check_appointment_availability", "book_appointment"),
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, TAKEN, TZ),
        "scheduled_at = the taken slot"
      ),
  ],
  judge: [
    "After finding the requested time unavailable, did the receptionist offer one or more alternative times, or ask about another day?",
    "Did the receptionist avoid claiming or promising a booking for the unavailable time?",
  ],
};
