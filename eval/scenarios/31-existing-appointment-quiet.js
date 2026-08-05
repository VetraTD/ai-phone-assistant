/**
 * THE REPORTED SYMPTOM, in one scenario.
 *
 * A caller who already has an appointment rings back and asks about something
 * else entirely. On the live calls the receptionist answered, then offered to
 * book a "strategy call" or a "general consultation" — having completely
 * forgotten the appointment already sitting in the database under that number.
 *
 * Two rules have to hold at once here, and they pull in opposite directions:
 *   * do NOT offer to book anything, because the caller did not ask to;
 *   * do NOT volunteer the existing appointment either, because they did not
 *     ask about that.
 * "Stay quiet unless relevant" is exactly the middle of those two.
 *
 * The seed and the callerContext are kept consistent BY HAND: the eval harness
 * never calls fetchCallerContext, so the scenario author supplies both halves of
 * what production would derive from one phone number.
 *
 * Load-bearing: remove the CALLER CONTEXT clause in services/gemini.js
 * (buildCallerContextSection) and this fails.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("tue", "14:00", { timezone: TZ });

export default {
  name: "existing-appointment-quiet",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  extrasPatch: {
    callerPhone: CALLER_PHONE,
    callerContext: {
      callCount: 2,
      lastCallSummary: "booked an appointment",
      upcomingAppointments: [{ id: "appt-existing", client_name: "Marcus Webb", scheduled_at: EXISTING }],
    },
  },
  seedAppointments: [
    {
      id: "appt-existing",
      client_name: "Marcus Webb",
      client_phone: CALLER_PHONE,
      scheduled_at: EXISTING,
      status: "scheduled",
    },
  ],
  caller: {
    mode: "persona",
    persona:
      "You are Marcus Webb. You are calling to ask ONE practical question — what time they open on Saturday. " +
      "You are NOT calling to book anything and you do not mention appointments at all. If you are offered a " +
      "booking, say no thanks. Once your question is answered, thank them and end the call.",
    goal: "Find out the Saturday opening hours, then hang up.",
    maxTurns: 5,
  },
  hard: [
    // Nothing was booked, and nothing was even attempted.
    (ctx) => A.toolNotCalled(ctx, "book_appointment"),
    // No unsolicited sales pitch. These are the actual phrasings from the
    // reported calls, plus the generic offer shapes around them.
    (ctx) =>
      A.replyNeverMatches(
        ctx,
        /(strategy call|general consultation|would you like (me )?to (book|schedule|set up)|shall i (book|schedule|get you)|can i (book|schedule) (you|that))/i
      ),
    // ...and it did not volunteer the appointment either. The caller never
    // asked about it, so bringing it up is the other half of the same failure.
    (ctx) => A.replyNeverMatches(ctx, /you (already )?have an (upcoming )?appointment|i see you'?re (booked|scheduled)/i),
    // A one-question call should not sprawl.
    (ctx) => A.turnsAtMost(ctx, 4),
  ],
  judge: [
    "Did the receptionist answer the opening-hours question directly?",
    "Did it avoid offering to book anything the caller had not asked for?",
    "Did it avoid bringing up the caller's existing appointment unprompted?",
  ],
};
