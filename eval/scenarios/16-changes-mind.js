/**
 * PERSONA: the caller names 10 AM, then switches to 2 PM BEFORE confirming. The
 * receptionist must book the final choice (2 PM) exactly once — never the
 * abandoned 10 AM, and never both.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const FIRST = nextWeekdayAt("thu", "10:00", { timezone: TZ });
const FINAL = nextWeekdayAt("thu", "14:00", { timezone: TZ });

export default {
  name: "changes-mind",
  tags: ["persona"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Elena Ruiz, decisive but you reconsider once. You give your name as Elena Ruiz when asked.",
    goal:
      `Start by asking to book for ${spokenSlot(FIRST, TZ)}. Then, BEFORE you confirm anything, change your mind ` +
      `and say you'd actually prefer ${spokenSlot(FINAL, TZ)} instead. Confirm the 2 PM booking when read back.`,
    maxTurns: 8,
  },
  hard: [
    (ctx) => A.toolCalledAtMost(ctx, "book_appointment", 1),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, FINAL, TZ),
        "scheduled_at = the 2 PM final choice"
      ),
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, FIRST, TZ),
        "scheduled_at = the abandoned 10 AM"
      ),
  ],
  judge: [
    "Did the receptionist book the caller's final choice (2 PM) rather than the abandoned 10 AM?",
    "Did the receptionist handle the change of mind smoothly without confusion or double-booking?",
  ],
};
