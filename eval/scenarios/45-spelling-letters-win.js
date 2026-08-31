/**
 * WHEN THE SPELLING DISAGREES WITH WHAT WAS HEARD, THE LETTERS WIN.
 *
 * From a staging call on 2026-08-31: the caller spelled N-I-T-H-I-N and the
 * booking was still written as "Nathan". The rule was added to the tool
 * contract in services/gemini.js and moved to the unconditional prefix, but
 * nothing has ever asserted on it, because in a text harness there is no
 * speech recognizer to do the mishearing.
 *
 * So the scenario manufactures the disagreement instead of waiting for one:
 * the caller SAYS one name and SPELLS a different one. That is exactly the
 * state a mis-transcription produces — two spellings of the same name in one
 * conversation, one of them right — and the receptionist has to pick the
 * letters. A model that averages the two, or prefers what it heard first,
 * fails here for the same reason it failed on the real call.
 *
 * The name is also settled by this exchange, so the gate must not go on to
 * refuse the write: spelling it IS the answer the gate was waiting for.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("tue", "09:00", { timezone: TZ });

export default {
  name: "spelling-letters-win",
  tags: ["regression", "booking"],
  fixture: "appointments-availability",
  caller: {
    mode: "scripted",
    turns: [
      `Hello, could I book something for ${spokenSlot(SLOT, TZ)}?`,
      // What the receptionist "hears" — the wrong one.
      "My name is Nathan.",
      // ...and the correction, in the only form that can carry a spelling.
      "Actually it's N-I-T-H-I-N.",
      "Yes, that's right. Please book it.",
      "No, that's all. Thank you!",
    ],
  },
  hard: [
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    // Rebuilt from the letters...
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /\bnithin\b/i.test(args.client_name || ""),
        "client_name rebuilt from the spelling"
      ),
    // ...and NOT from what it thought it heard. Asserted separately so a
    // "Nathan Nithin" hedge fails rather than passing the check above.
    (ctx) =>
      A.toolNotCalledWith(
        ctx,
        "book_appointment",
        (args) => /\bnathan\b/i.test(args.client_name || ""),
        "client_name still carrying the misheard form"
      ),
  ],
  judge: [
    "After the caller spelled their name, did the receptionist use the spelled version rather than the one it first heard?",
    "Did the receptionist avoid asking the caller to spell the name again after they had already spelled it?",
  ],
};
