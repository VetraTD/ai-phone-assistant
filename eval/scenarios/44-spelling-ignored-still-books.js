/**
 * THE HARD BLOCK MUST NOT TRAP THE CALL.
 *
 * The 2026-08-31 change makes the write gate stay shut until the caller has
 * actually spelled the name, actually declined, or ignored the question its
 * allotted number of times. The first two are the point; this scenario is the
 * third, and it exists because a gate that only ever closes is a worse bug
 * than the one it fixed.
 *
 * The caller here never engages with the spelling question at all — no
 * letters, no refusal, just a different subject each time. That is the case
 * neither detector in lib/spellingSignal.js can classify, so what has to
 * rescue the call is VOICE_SPELL_MISS_CAP. If the booking does not happen, the
 * escape hatch is not wired.
 *
 * Note this is deliberately NOT a polite deflection — scenario 40 covers that,
 * and a deflection settles immediately as a refusal. The gap between the two
 * scenarios is the gap between "said no" and "never answered", which is
 * exactly the distinction the old code could not make.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";
import { getStrings } from "../../lib/voice/strings.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "11:00", { timezone: TZ });

// IMPORTED, not transcribed.
//
// The hand-copied version of this regex was missing one of strings.js's seven
// alternatives — `spell (that|it) (out|for me)` — so a model asking "could you
// spell that out for me?" repeatedly would be counted by the live cap and
// scored as ZERO asks by this scenario. The assertion below would have gone
// green on exactly the livelock it exists to catch. Found in review; the fix
// is to stop keeping a second copy.
const SPELL_REQUEST = getStrings("en").spellRequestRe;

export default {
  name: "spelling-ignored-still-books",
  tags: ["regression", "booking"],
  fixture: "appointments-availability",
  caller: {
    mode: "scripted",
    turns: [
      `Hi, I'd like to book an appointment for ${spokenSlot(SLOT, TZ)}.`,
      "It's Nithin Jayadev.",
      // Asked to spell. Answers a different question instead — not a refusal,
      // just a caller who is thinking about something else.
      "Sorry, do you have parking there?",
      // Asked again. Still elsewhere.
      "Right. And how long does the appointment usually take?",
      "Yes, go ahead and book it please.",
      "No, that's everything. Thanks!",
    ],
  },
  hard: [
    // The escape hatch. Without it the gate refuses forever and this is the
    // assertion that goes red.
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    // ...with the name we heard, since no better one was ever offered.
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /nithin/i.test(args.client_name || ""),
        "client_name kept from what was heard"
      ),
    // And the caller is not interrogated on the way there. VOICE_SPELL_ASK_CAP
    // is 3; more than that is the livelock scenario 40 exists to catch.
    (ctx) => A.replyMatchesAtMost(ctx, SPELL_REQUEST, 3),
  ],
  judge: [
    "When the caller repeatedly did not answer the spelling question, did the receptionist eventually stop asking and get on with the booking?",
    "Did the receptionist avoid sounding like it was nagging or stuck?",
    "Did the call reach a confirmed booking?",
  ],
};
