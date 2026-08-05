/**
 * A CALLER'S OWN APPOINTMENT IS NOT "UNAVAILABILITY".
 *
 * Production call 0db83104, turn 8. The caller had a 2 PM booking and asked for
 * 2 PM:
 *
 *   [ai] "It looks like tomorrow at 2 PM is already taken. Would 1:30 PM,
 *         2:30 PM, or 1 PM tomorrow work for you instead?"
 *
 * Slot capacity counted the caller's own row like anybody else's, so the
 * assistant offered them alternatives to their own appointment. Wrong under
 * every value of existingAppointment, which is why the tool-level fix is
 * ungated by policy.
 *
 * The seeded appointment sits at exactly the time the caller will ask for.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, hoursOpenNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("thu", "14:00", { timezone: TZ });

export default {
  name: "own-slot-not-taken",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  // businessHours pinned open: the after-hours policy otherwise diverts booking
  // to a callback depending on the time of day the suite runs.
  configPatch: { businessHours: hoursOpenNow() },
  extrasPatch: {
    callerPhone: CALLER_PHONE,
    callerContext: {
      callCount: 1,
      lastCallSummary: "booked a strategy call",
      upcomingAppointments: [{ id: "appt-existing", client_name: "Boris Johnson", scheduled_at: EXISTING }],
    },
  },
  seedAppointments: [
    {
      id: "appt-existing",
      client_name: "Boris Johnson",
      client_phone: CALLER_PHONE,
      scheduled_at: EXISTING,
      status: "scheduled",
    },
  ],
  caller: {
    mode: "persona",
    // Deliberately routed through a SECOND booking. Asking plainly for the slot
    // no longer reaches the availability check at all — the receptionist now
    // raises the existing appointment first, which is the correct behaviour but
    // leaves this tool path unexercised. Asking for an additional appointment
    // and then naming the same time is how a real caller lands on the collision.
    persona:
      "You are Boris Johnson. You already have a call booked and you are keeping it — you want a " +
      "SECOND, separate call as well. Say so clearly if asked. When they ask what time you would like " +
      `for the new one, say ${spokenSlot(EXISTING, TZ)} — you have forgotten that is exactly when your ` +
      "existing call is. If they point out that this is your own existing slot, say 'oh right, of " +
      "course' and pick any other time they offer. If they simply tell you the time is taken or " +
      "unavailable without saying it is yours, ask them who has it.",
    goal: `Book a second call, initially asking for ${spokenSlot(EXISTING, TZ)}.`,
    maxTurns: 8,
  },
  hard: [
    // The exact live wording, and the family around it.
    (ctx) =>
      A.replyNeverMatches(
        ctx,
        /\b(that time|that slot|it|2 ?pm)\b[^.?!]*\b(is|looks|appears)\b[^.?!]*\b(already )?(taken|unavailable|fully booked)\b/i
      ),
    // It must say whose appointment it is.
    (ctx) => A.replySomewhereMatches(ctx, /you (already )?(have|are booked)|your (existing |current )?appointment/i),
    // Falsifiability guard: this scenario is only meaningful if the availability
    // check actually ran against the colliding time. Without this the test could
    // pass because the flow never reached the tool at all — which is how the
    // first version of this scenario passed while proving nothing.
    (ctx) => A.toolCalled(ctx, "check_appointment_availability"),
    // Nothing was double-booked into the caller's own slot.
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      const atExisting = rows.filter((r) => Date.parse(r.scheduled_at) === Date.parse(EXISTING));
      return {
        pass: atExisting.length === 1,
        name: "own-slot-not-double-booked",
        detail: `rows at the existing time = ${atExisting.length}, total = ${rows.length}`,
      };
    },
  ],
  judge: [
    "Did the receptionist recognise the requested time as the caller's own existing appointment?",
    "Did it avoid offering alternative times as though someone else held the slot?",
  ],
};
