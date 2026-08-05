/**
 * ALLOW — a business that opts out of the check entirely.
 *
 * Two things are under test, and the second is the interesting one:
 *   1. nothing blocks, so the booking goes through on the first attempt;
 *   2. the confirm flag is NOT advertised, so the model cannot send it.
 *
 * (2) is the declaration-honesty assertion. A tool declaration that offers a
 * parameter its handler ignores is precisely the defect that had the model
 * reporting caller_phone/caller_name searches it had never run.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("tue", "14:00", { timezone: TZ });
const WANTED = nextWeekdayAt("thu", "10:00", { timezone: TZ });

export default {
  name: "second-appointment-allow",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  configPatch: {
    capabilities: {
      appointments: { enabled: true, adapter: "internal", existingAppointment: "allow" },
    },
  },
  extrasPatch: {
    callerPhone: CALLER_PHONE,
    callerContext: {
      callCount: 1,
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
      "You are Marcus Webb. You want to book an appointment on " +
      `${spokenSlot(WANTED, TZ)}. Give your name as Marcus Webb when asked. Answer one question at a ` +
      "time and confirm clearly when the details are read back to you.",
    goal: `Book an appointment for ${spokenSlot(WANTED, TZ)}.`,
    maxTurns: 8,
  },
  hard: [
    // Exactly one call — no refusal, therefore no retry round.
    (ctx) => A.toolCalledTimes(ctx, "book_appointment", 1),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    // The declaration-honesty assert: the parameter is not offered under this
    // policy, so it must never appear in the arguments.
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => "in_addition_to_existing" in (args || {}),
        "in_addition_to_existing is not advertised under allow"
      ),
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      return {
        pass: rows.length === 2,
        name: "both-appointments-stored",
        detail: `scheduled rows = ${rows.length}`,
      };
    },
  ],
  judge: [
    "Did the receptionist book the requested appointment without an unnecessary interrogation?",
    "If it mentioned the existing appointment at all, was that natural rather than obstructive?",
  ],
};
