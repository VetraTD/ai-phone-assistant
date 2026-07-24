/**
 * ORDERING (happy path): a free slot. The receptionist should check
 * availability, then — after confirming — book with args that echo the agreed
 * time and the caller's name. Persona mode because this fixture requires the
 * caller to provide name AND date of birth, which a scripted turn list can't
 * adapt to.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, slotMatches } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "10:00", { timezone: TZ });

export default {
  name: "availability-free-path",
  tags: ["ordering"],
  fixture: "appointments-availability",
  caller: {
    mode: "persona",
    persona:
      "You are Jordan Blake, a calm existing patient. Your date of birth is March 4, 1990. " +
      "You answer questions directly and agree to reasonable confirmations.",
    goal:
      `Book a cleaning for ${spokenSlot(SLOT, TZ)}. Give your name (Jordan Blake) and, if asked, your ` +
      `date of birth (1990-03-04). When the receptionist reads the details back, confirm clearly with "yes".`,
    maxTurns: 8,
  },
  hard: [
    (ctx) => A.toolOrder(ctx, ["check_appointment_availability", "book_appointment"]),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => slotMatches(args.scheduled_at, SLOT, TZ),
        "scheduled_at = agreed slot"
      ),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /jordan/i.test(args.client_name || ""),
        "client_name contains Jordan"
      ),
  ],
  judge: [
    "Did the receptionist confirm the appointment details before booking?",
    "Was the final spoken confirmation consistent with the time the caller asked for?",
  ],
};
