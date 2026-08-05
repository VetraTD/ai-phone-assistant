/**
 * THE GUARD IS NOT A GENERAL BRAKE.
 *
 * A returning caller with NO upcoming appointment must book exactly as before —
 * no extra question, no "you already have one", no extra turn. This is the
 * scenario that fails if `confirm` ever fires on an empty list, or if the new
 * booking-guidance sentence makes the model ask about an appointment nobody has.
 *
 * callerContext is deliberately non-empty on the history side and empty on the
 * appointments side: that combination is what proves the guard keys on
 * appointments rather than on "is this a returning caller".
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, hoursOpenNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const WANTED = nextWeekdayAt("thu", "10:00", { timezone: TZ });

export default {
  name: "first-appointment-unguarded",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  // businessHours pinned open: the after-hours policy otherwise diverts booking
  // to a callback depending on the time of day the suite runs.
  configPatch: { businessHours: hoursOpenNow() },
  extrasPatch: {
    callerPhone: CALLER_PHONE,
    callerContext: {
      callCount: 1,
      lastCallSummary: "asked about opening hours",
      upcomingAppointments: [],
    },
  },
  seedAppointments: [],
  caller: {
    mode: "persona",
    persona:
      "You are Marcus Webb. You have called before but you have never booked anything. You want an " +
      `appointment on ${spokenSlot(WANTED, TZ)}. Give your name as Marcus Webb when asked. Answer one ` +
      "question at a time and confirm clearly when the details are read back.",
    goal: `Book an appointment for ${spokenSlot(WANTED, TZ)}.`,
    maxTurns: 8,
  },
  hard: [
    // One call, straight through. A second call would mean the guard fired on
    // an empty list.
    (ctx) => A.toolCalledTimes(ctx, "book_appointment", 1),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    // It never claimed an appointment this caller does not have.
    (ctx) => A.replyNeverMatches(ctx, /you (already )?have an (upcoming |existing )?appointment/i),
    (ctx) => A.replyNeverMatches(ctx, /second appointment|as well as (that|the) one/i),
    // No extra turn spent on a question that had no reason to be asked.
    (ctx) => A.turnsAtMost(ctx, 8),
  ],
  judge: [
    "Did the receptionist book the appointment without inventing an existing one?",
    "Was the flow as short as a normal booking, with no extra confirmation step?",
  ],
};
