/**
 * CONFIRM — the default policy, and the safety floor under it.
 *
 * A caller who genuinely wants a SECOND appointment must be able to get one.
 * What must never happen is getting one without being asked first, which is the
 * silent failure nobody discovers until they turn up twice.
 *
 * So the assertion that matters is not "it booked" — it is "it was refused
 * once, it asked, and only then did it book". The config is deliberately
 * untouched: this also proves the default is `confirm` for a business that has
 * never seen the setting.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot, hoursOpenNow } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const CALLER_PHONE = "+15558675309";
const EXISTING = nextWeekdayAt("tue", "14:00", { timezone: TZ });
const WANTED = nextWeekdayAt("thu", "10:00", { timezone: TZ });

export default {
  name: "second-appointment-confirm",
  tags: ["existing-appointment", "rules"],
  fixture: "appointments-db",
  // existingAppointment is deliberately NOT set — an unconfigured business must
  // behave as "confirm", and this scenario is what proves it. businessHours is
  // pinned open only because the after-hours policy otherwise diverts booking to
  // a callback depending on what time of day the suite happens to run.
  configPatch: { businessHours: hoursOpenNow() },
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
      "You are Marcus Webb. You already have an appointment and you are keeping it. You want a SECOND, " +
      `separate appointment on ${spokenSlot(WANTED, TZ)} — a different matter entirely. If they ask whether ` +
      "this is in addition to the one you already have, say yes, as well as that one, and be clear the " +
      "existing one stays. If they offer to move the existing appointment instead, say no, you want both. " +
      "Give your name as Marcus Webb when asked. Answer one question at a time.",
    goal: `Book a second appointment for ${spokenSlot(WANTED, TZ)} while keeping the one you already have.`,
    maxTurns: 10,
  },
  hard: [
    // AT MOST two, not exactly two.
    //
    // There are two correct routes through this and the difference between them
    // is which layer caught it. If the model reads CALLER CONTEXT and raises the
    // existing appointment on its own, it books ONCE, already carrying the
    // caller's confirmation — the prompt did the work and the guard never fired.
    // If it does not, the guard refuses the first call and it books on the
    // second. Both are correct; asserting "exactly 2" would fail the better one.
    //
    // What must hold either way is the safety property, and that is the next
    // three assertions: the flag was set, the caller was told BEFORE the write,
    // and both appointments exist afterwards. A blind booking fails all three.
    (ctx) => A.toolCalledAtMost(ctx, "book_appointment", 2),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => args.in_addition_to_existing === true,
        "in_addition_to_existing set after the caller confirmed"
      ),
    // It told the caller about the existing appointment BEFORE the booking went
    // through — the whole point of the refusal.
    (ctx) =>
      A.replyMatchesBeforeTool(
        ctx,
        /already (have|got)|existing appointment|second (one|appointment)|as well as/i,
        "book_appointment"
      ),
    // The outcome, not the trace: both appointments exist.
    (ctx) => {
      const rows = ctx.store?.scheduled?.() || [];
      return {
        pass: rows.length === 2,
        name: "two-appointments-stored",
        detail: `scheduled rows = ${rows.length}`,
      };
    },
  ],
  judge: [
    "Did the receptionist point out the caller already had an appointment before booking another?",
    "Did it make clear the existing appointment was being kept, not replaced?",
  ],
};
