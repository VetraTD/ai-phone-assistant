/**
 * MEMORY: after a successful booking the caller asks "did that go through?" The
 * receptionist should confirm from what it already did this call — NOT book a
 * second time. Exactly one booking is the hard line.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("tue", "11:00", { timezone: TZ });

export default {
  name: "already-booked-note",
  tags: ["memory"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Marcus Webb, a slightly anxious first-time caller who likes to double-check things.",
    goal:
      `Book a consultation for ${spokenSlot(SLOT, TZ)} under the name Marcus Webb, confirming when asked. ` +
      `AFTER the receptionist confirms the booking, ask once: "Sorry, did that actually go through?" ` +
      `Accept their reassurance and end the call.`,
    maxTurns: 8,
  },
  hard: [
    (ctx) => A.toolCalledTimes(ctx, "book_appointment", 1),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
  ],
  judge: [
    'When the caller asked "did that go through?", did the receptionist confirm the existing booking from memory rather than starting a new one?',
    "Did the receptionist reassure the caller clearly and specifically about the appointment?",
  ],
};
