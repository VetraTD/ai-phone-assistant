/**
 * MEMORY: the caller gives their name early and doesn't repeat it. Several turns
 * later, when the booking is written, the name must still be exactly right — and
 * the receptionist must never re-ask for information already provided.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("thu", "14:00", { timezone: TZ });

export default {
  name: "name-recall",
  tags: ["memory"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Priya Nair. You mention your name naturally at the very start of the call and never repeat it " +
      "unless truly necessary. You are friendly and cooperative but a little chatty about small things first.",
    goal:
      `First make some small talk (ask if they're having a good day), THEN book a checkup for ` +
      `${spokenSlot(SLOT, TZ)}. You already gave your name at the start — do not volunteer it again. Confirm when asked.`,
    maxTurns: 8,
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /priya\s+nair/i.test(args.client_name || ""),
        "client_name = Priya Nair"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = agreed slot"
      ),
  ],
  judge: [
    "Did the receptionist use the caller's name without asking for it a second time?",
    "Did the receptionist avoid re-asking for any information the caller had already given?",
  ],
};
