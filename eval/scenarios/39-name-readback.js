/**
 * NAME READ-BACK — the first item on the Digile Media feedback list: "the AI
 * does not always capture the caller's name correctly... One possible
 * improvement would be for the AI to repeat the name back to the caller for
 * confirmation before continuing."
 *
 * It already did, for some tenants. capabilities/appointments.js told the model
 * to "repeat it back naturally in your next sentence" — but only in the branch
 * that renders when the scheduling adapter has NO checkAvailability, i.e.
 * athenahealth and webhook. Every business on the built-in calendar, Digile
 * Media included, got the other branch, which never mentioned the name at all.
 * The instruction was dead code for exactly the tenants that reported it.
 *
 * So this scenario runs on `appointments-availability` ON PURPOSE. Run it
 * against `clinic-athena` and it passed before the fix too, which is precisely
 * why the gap survived: the behaviour existed, just not where anyone called.
 *
 * NOTE ON WHAT THIS CAN AND CANNOT PROVE. The eval harness feeds the model
 * perfect text — lib/harness/textSession.js has no audio path — so it is
 * structurally incapable of mishearing a name. This proves the receptionist
 * OFFERS the caller a chance to catch an error. Whether that catch actually
 * fires against a real recognizer is a question only `npm run stt:ab` can
 * answer, and the ledger already records Deepgram/Google returning
 * "niton / nithan / Nathan" for "Nithin" on a live call.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("wed", "11:00", { timezone: TZ });

export default {
  name: "name-readback",
  tags: ["regression", "stt"],
  fixture: "appointments-availability",
  caller: {
    mode: "persona",
    persona:
      "You are Marcus Bell. You say your name once, clearly, when asked and never repeat it unless the " +
      "receptionist gets it wrong. You are agreeable and answer briefly.",
    goal:
      `Book an appointment for ${spokenSlot(SLOT, TZ)}. Give your name as Marcus Bell when asked. Confirm the ` +
      `booking when the details are read back to you.`,
    // 12, not 8. The fix under test DELIBERATELY makes booking longer: the
    // name is read back, and the day/time questions are no longer stacked.
    // At 8 this scenario passed alone and failed in a full run — the booking
    // simply ran out of turns, and replyMatchesBeforeTool then passed
    // VACUOUSLY because the tool it orders against was never called.
    maxTurns: 12,
  },
  hard: [
    // The heart of it: the assistant must SAY the name back before it writes
    // the booking, so a mishearing has somewhere to surface. This is a hard
    // assert rather than a judge question because it is a fact about the
    // transcript, not a matter of taste.
    (ctx) => A.replyMatchesBeforeTool(ctx, /marcus/i, "book_appointment"),
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => /marcus\s+bell/i.test(args.client_name || ""),
        "client_name = Marcus Bell",
      ),
  ],
  judge: [
    "Did the receptionist repeat the caller's name back to them naturally (e.g. 'Thanks, Marcus —') after being given it, rather than silently recording it?",
    "Did the receptionist avoid demanding the caller spell their name when nothing suggested it had been misheard?",
  ],
};
