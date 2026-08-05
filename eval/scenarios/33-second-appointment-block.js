/**
 * BLOCK — a business that allows exactly one upcoming appointment per caller.
 *
 * The assertion is deliberately on the OUTCOME, not the tool trace: exactly one
 * upcoming appointment survives. Offering to move the existing one is a
 * legitimate resolution and so is leaving it alone, so asserting which tool ran
 * would fail a receptionist that did the right thing by a different route.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, hoursOpenNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("tue", "14:00", { timezone: TZ });
const WANTED = nextWeekdayAt("thu", "10:00", { timezone: TZ });

export default {
  name: "second-appointment-block",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  // businessHours pinned open: the after-hours policy otherwise diverts
  // booking to a callback depending on the time of day the suite runs.
  configPatch: {
    businessHours: hoursOpenNow(),
    capabilities: {
      appointments: { enabled: true, adapter: "internal", existingAppointment: "block" },
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
      "You are Marcus Webb. You already have an appointment. You want to ADD a second one on " +
      `${spokenSlot(WANTED, TZ)}. Ask for it plainly. If you are told they can't give you two, accept it — ` +
      "say that's fine, leave the existing one where it is, and end the call politely. Do not argue more than once.",
    goal: `Try to add a second appointment on ${spokenSlot(WANTED, TZ)}.`,
    maxTurns: 8,
  },
  hard: [
    // The invariant, whatever route the model took to honour it.
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      return {
        pass: rows.length === 1,
        name: "exactly-one-upcoming-appointment",
        detail: `scheduled rows = ${rows.length}`,
      };
    },
    // It explained the alternative rather than simply refusing.
    (ctx) => A.replySomewhereMatches(ctx, /(move|reschedule|change|shift) (that|your|the existing|it)/i),
    // No raw internals in the refusal — the tool message is written for the
    // model, and only the caller-safe line may be spoken.
    (ctx) => A.replyNeverMatches(ctx, /in_addition_to_existing|default_api|book_appointment/i),
  ],
  judge: [
    "Did the receptionist explain it could not add a second appointment?",
    "Did it offer to move the existing appointment as the alternative?",
    "Did it avoid sounding like it had hit an error, as opposed to a policy?",
  ],
};
