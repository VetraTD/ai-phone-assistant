/**
 * A CALLER ALREADY ON FILE IS NEVER ASKED TO SPELL.
 *
 * The other half of the 2026-08-29 spelling complaint. One report was names
 * stored wrong; the other was a call where the receptionist asked for the name
 * and its spelling two or three separate times. A returning caller whose name
 * the business already has is the clearest case of an ask that buys nothing:
 * the record IS the spelling.
 *
 * The gate in services/tools.js now reads ctx.callerContext before it decides.
 * Note what this scenario does NOT permit: skipping the ask must not mean
 * skipping the booking, and it must not mean reading the stored name out to the
 * caller for confirmation (services/gemini.js NON-NEGOTIABLE RULE 4 forbids
 * verifying that way round). A question is simply not asked.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("thu", "14:00", { timezone: TZ });
const EXISTING = nextWeekdayAt("mon", "10:00", { timezone: TZ });

/** Mirrors lib/voice/strings.js spellRequestRe, including the 2026-08-29 widening. */
const SPELL_REQUEST =
  /\b(spell (that|it|your|the|them|those)|spelling of|(could|can|would|will) you spell|how (do|would) (you|i) spell|letter by letter|how (do|would) (you|i) write (that|it)|write that down)\b/i;

export default {
  name: "spelling-known-caller",
  tags: ["regression", "booking"],
  fixture: "appointments-availability",
  // What puts the name ON FILE.
  //
  // seedAppointments alone would NOT do it: eval/run.js:189 feeds those to
  // makeFakeDeps (the tool-facing store) and never derives callerContext from
  // them, so a scenario relying on that would silently prove nothing. This is
  // the call-start snapshot, supplied the same shape services/supabase.js
  // fetchCallerContext returns and lib/voice/session.js resolves before turn 1.
  extrasPatch: {
    callerContext: {
      callCount: 2,
      lastCallSummary: null,
      upcomingAppointments: [
        { client_name: "Aoife Nic Ghabhann", scheduled_at: EXISTING },
      ],
    },
  },
  seedAppointments: [
    {
      client_name: "Aoife Nic Ghabhann",
      client_phone: "+15550001111",
      scheduled_at: EXISTING,
      status: "scheduled",
    },
  ],
  caller: {
    mode: "scripted",
    turns: [
      `Hi, it's Aoife Nic Ghabhann. I'd like to book another appointment for ${spokenSlot(SLOT, TZ)}.`,
      "Yes, that's right.",
      "Yes please, go ahead and book it.",
      "No, that's everything. Thank you!",
    ],
  },
  hard: [
    // The whole point. Not "at most once" — zero.
    (ctx) => A.replyMatchesAtMost(ctx, SPELL_REQUEST, 0),
  ],
  judge: [
    "Did the receptionist avoid asking the caller to spell their name at any point?",
    "Did the receptionist avoid asking the caller the same question more than once?",
  ],
};
