/**
 * THE SPELLING LIVELOCK, made visible.
 *
 * Recorded in the migration ledger as a parked defect: the receptionist asked
 * "could you spell your last name?" on NINE consecutive turns, in 2 of 5 runs,
 * while every hard assert in the suite stayed green. A caller-facing failure
 * that the gate could not see, because nothing counted repetition. The quotes
 * flow produced the same shape: "looped asking the caller to spell a name it
 * already had and never recorded the request."
 *
 * The prompt was never the problem for lack of trying. capabilities/appointments.js
 * has said "Ask this at most once" and "never ask them to spell it a second
 * time" throughout. The model drifted anyway, because a rule about what it did
 * EARLIER is something it has to remember across a long call.
 *
 * Two changes are under test here:
 *   - a counter in lib/voice/replyState.js (shared by the live session AND this
 *     harness), surfaced to the prompt as an ALREADY ASKED fact rather than as
 *     a rule the model must recall;
 *   - the name landing in KNOWN CALLER FACTS as soon as any write tool carries
 *     it, including a write that was REFUSED for some other missing field —
 *     which is how the name used to get lost and re-asked in the first place.
 *
 * The caller deliberately drags the call out and declines to spell, because the
 * livelock needs length and an unsatisfied request to appear at all. A short,
 * cooperative call hides it.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("thu", "15:00", { timezone: TZ });

/** Any way the model phrases "please spell that". Mirrors strings.js spellRequestRe. */
const SPELL_REQUEST =
  /\b(spell (that|it|your|the)|spelling of|could you spell|can you spell|how do you spell)\b/i;

export default {
  name: "spelling-asked-once",
  tags: ["regression", "long-call"],
  fixture: "appointments-availability",
  caller: {
    mode: "persona",
    persona:
      "You are Aoife Nic Ghabhann. Your surname is unusual. You say your name once and you DO NOT spell it — if " +
      "you are asked to spell it you deflect politely ('it's fine, just put it down as it sounds') and move the " +
      "conversation on. You are chatty: you ask about parking, about how long the appointment takes, and whether " +
      "you need to bring anything. You never get annoyed.",
    goal:
      `Book an appointment for ${spokenSlot(SLOT, TZ)}. Give your name as Aoife Nic Ghabhann once. Never spell it, ` +
      `however many times you are asked. Ask your side questions about parking and what to bring along the way. ` +
      `Confirm the booking when it is read back to you.`,
    maxTurns: 12,
  },
  hard: [
    // THE assertion. One request is correct craft; two is the livelock
    // beginning. Before the fix this scenario is expected to exceed it.
    (ctx) => A.replyMatchesAtMost(ctx, SPELL_REQUEST, 1),
    // ...and the call must still finish. A receptionist that never asks but
    // also never books has not fixed anything.
    (ctx) => A.toolSucceeded(ctx, "book_appointment"),
  ],
  judge: [
    "After the caller declined to spell their name, did the receptionist accept it and move on rather than asking again?",
    "Did the receptionist keep the caller's name throughout the call without re-asking for it?",
    "Did the call reach a confirmed booking without getting stuck repeating itself?",
  ],
};
