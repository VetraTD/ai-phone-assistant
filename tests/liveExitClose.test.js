// ---------------------------------------------------------------------------
// HOW A CALL ENDS, taken from the two calls of 2026-09-17 where it ended wrong
// in two opposite directions.
//
// CAaef5bd82 booked an appointment, said its goodbye, and the line stayed open
// for fourteen seconds. CA2556d43d cancelled an appointment and dropped the
// line 1.6 seconds after asking the caller "Is there anything else I can help
// you with today?"
//
// The farewell half is fixed in lib/voice/strings.js and asserted in
// tests/liveGoodbyeExit.test.js. This file owns the other two, which both need
// a real tool round and so need the full session harness.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: {
    mon: OPEN,
    tue: OPEN,
    wed: OPEN,
    thu: OPEN,
    fri: OPEN,
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: {
    appointments: {
      enabled: true,
      adapter: "internal",
      availability: { length: 30, capacity: 1 },
    },
  },
};

const SLOT = "2026-09-18T15:30:00";
const CLIENT = "Marcus Bell";
const READ_BACK =
  "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

let priorSpellPolicy;
beforeEach(() => {
  clearStats();
  priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
});

/** A booking, so end_call's "did something" gate is satisfied the way it was live. */
async function bookedCall() {
  const s = await bootLive({ config: CONFIG, callSid: "CA_exit" });
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("I'd like Friday afternoon.");
  await s.assistantTurn(READ_BACK);
  await s.callerSays("Yes, that works.");
  await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });
  expect(s.store.scheduled()).toHaveLength(1);
  // -------------------------------------------------------------------------
  // THE CALLER IS ASKED HERE, and this exchange was added on 2026-09-17 when
  // LVX132 landed rather than to make a failing test pass.
  //
  // The three tests below are about what happens once end_call has been
  // ALLOWED. LVX132 puts a condition in front of that: the first hang-up on a
  // call where nobody was ever asked "is there anything else?" is refused, and
  // a refused end_call never reaches the exit machinery at all. So without
  // this exchange these cases stop being about the exit and quietly become a
  // second test of the ask gate -- which is a fixture describing a call that
  // can no longer happen, the trap this repository has already written down.
  //
  // The precedence itself is asserted directly in the block at the bottom of
  // this file, not left as an implication of these setups.
  // -------------------------------------------------------------------------
  await s.assistantTurn("You're all set. Is there anything else I can help you with today?");
  await s.callerSays("Actually, could you just confirm the time again?");
  return s;
}

// ---------------------------------------------------------------------------
// CA2556d43d, 2026-09-17, VERBATIM:
//
//   05:06:02.069  cancel_appointment_db   success=true
//   05:06:04.788  end_call                success=true    <- allowed, mid-turn
//   05:06:09.300  A: "...is now cancelled. Is there anything else I can help
//                     you with today?"
//   05:06:10.888  live_exit_run
//
// The end_call gate checks STATE -- wrapping up, did something, had a
// conversation, was the last caller word a hesitation. All four were satisfied,
// so it allowed the hang-up, correctly by its own rules. Nothing anywhere looks
// at what the assistant's own closing turn SAYS.
//
// It cannot: on Live the model composes the speech and the tool call together
// and the tool runs first, so at gate time the reply does not exist yet. But at
// TURN END it does, and that is where the exit is armed.
//
// This shape is already in the record. lib/voice/live/index.js's armExit
// comment describes call 7aef50 hanging up "on a turn that ended in a fresh
// question to the caller", and what it concluded was that the barge guard had
// DELAYED a hang-up rather than prevented one. LVX96 then closed the route
// where a REFUSED end_call produced a stray farewell. This is the route where
// end_call is legitimately allowed, and it was never closed.
// ---------------------------------------------------------------------------
describe("a question outranks a hang-up", () => {
  it("does not arm the exit when the closing turn asks the caller something", async () => {
    const s = await bookedCall();

    await s.callTool("end_call", {});
    await s.assistantTurn(
      "Your appointment on Friday, September eighteenth at three thirty PM is now booked. Is there anything else I can help you with today?"
    );

    // armExit was never asked. Its positive twin is the assertion that this is
    // a suppression rather than a code path that simply never ran.
    expect(counters().live_exit_held_question).toBe(1);
    expect(counters().live_exit_arm_checked).toBeFalsy();
    expect(s.ws.readyState).not.toBe(3);
  });

  it("arms normally when the closing turn does not ask anything", async () => {
    const s = await bookedCall();

    await s.callTool("end_call", {});
    await s.assistantTurn(
      "That's all set — I've booked your strategy call for Friday at three thirty PM. Thanks for calling Digile Media, and have a wonderful day."
    );

    expect(counters().live_exit_arm_checked).toBe(1);
    expect(counters().live_exit_held_question).toBeFalsy();
  });

  it("still lets the model close after the caller answers the question", async () => {
    // The cost of the rule, stated: one extra turn. The caller says no, the
    // model stops asking, and the line closes. A rule that could never release
    // would be worse than the bug.
    const s = await bookedCall();

    await s.callTool("end_call", {});
    await s.assistantTurn("Is there anything else I can help you with today?");
    expect(counters().live_exit_held_question).toBe(1);

    await s.callerSays("No, that's everything.");
    await s.assistantTurn("Thanks for calling Digile Media, and have a wonderful day.");

    expect(counters().live_exit_arm_checked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CAaef5bd82, 2026-09-17, VERBATIM:
//
//   05:05:00.799  end_call        success=true
//   05:05:01.029  live_turn_note  kind=zero_text  spoken=TRUE   <- speak, please
//   05:05:01.030  live_exit_armed                               <- 1 ms later
//   05:05:02.618  live_exit_run   trigger=mark
//
// The model called end_call and produced no speech at all. The zero-text guard
// exists for exactly that -- a tool ran and the caller heard nothing -- and its
// only remedy is to ask the model to say something, because on Live the model
// is the only voice.
//
// It fired one millisecond before the exit armed. The model began a reply it
// was never going to be allowed to finish, and the exit cut it off. The caller
// reported hearing it "start saying something and cut off in the middle of its
// own sentence", which is exactly what the log describes.
//
// Nothing is wrong with either mechanism. They must not both run on one turn.
// ---------------------------------------------------------------------------
describe("the zero-text nudge and the exit do not fight over one turn", () => {
  it("does not ask the model to speak on a turn that is already closing", async () => {
    const s = await bookedCall();

    // end_call, and not a word said.
    await s.callTool("end_call", {});
    await s.assistantTurn("");

    // The FACT is still recorded -- a silent tool turn happened, and a counter
    // that stopped firing would hide the model's behaviour rather than ours.
    expect(counters().live_zero_text_turns).toBe(1);
    // What must not happen is the note that provokes a reply.
    expect(counters().live_zero_text_note_suppressed_exiting).toBe(1);
  });

  it("still nudges on a silent tool turn when the call is NOT closing", async () => {
    // The guard's real job, unchanged: a lookup ran, the caller heard silence,
    // and the model has to fill it.
    const s = await bootLive({ config: CONFIG, callSid: "CA_exit2" });
    await s.callerSays("What have you got on Friday?");
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.assistantTurn("");

    expect(counters().live_zero_text_turns).toBe(1);
    expect(counters().live_zero_text_note_suppressed_exiting).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// WHICH GUARD CATCHES CA2556d4 NOW, asserted rather than assumed.
//
// That call cancelled an appointment, was allowed to hang up mid-turn, ended
// its reply with "Is there anything else I can help you with today?" and
// dropped the line 1.6 seconds later. It is the call the held-question guard
// above was built from -- and it is also a call on which the caller had never
// been asked anything, so LVX132 now catches it one step earlier, at the gate,
// before an exit is ever armed.
//
// Two guards, one call, and the order between them is a fact worth pinning: a
// later change to either could silently hand the case to the other, and both
// look green from their own suite.
// ---------------------------------------------------------------------------
describe("the ask gate runs before the held-question guard", () => {
  it("refuses the hang-up outright when the caller was never asked", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_exit_precedence" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("I'd like Friday afternoon.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });

    // No "anything else?" anywhere on this call -- CA2556d4's actual shape.
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(1);

    await s.assistantTurn(
      "Your appointment is booked. Is there anything else I can help you with today?"
    );

    // The exit machinery was never reached: nothing armed, so there was nothing
    // for the held-question guard to hold.
    expect(counters().live_exit_held_question).toBeFalsy();
    expect(counters().live_exit_arm_checked).toBeFalsy();
    expect(s.ws.readyState).not.toBe(3);
  });
});

// ---------------------------------------------------------------------------
// CA94f2b4, 2026-09-18, VERBATIM:
//
//   01:56:19  reschedule_appointment_db  success=true
//   01:56:22  end_call                   success=true   <- allowed
//   01:56:30  A: "...updated to Monday, September 21st at 1 PM. Is there
//                 anything else I can help you with today?Thank you for calling
//                 Digile Media, and have a great day."
//   01:56:32  live_exit_run
//
// Asked and signed off in ONE BREATH, then hung up. The caller never answered,
// and `end_call_refusals` read {no_ask: 0} -- so nothing refused, nothing held.
//
// BOTH GUARDS BEHAVED AS WRITTEN, which is why this is a seam and not a bug in
// either of them:
//
//   - LVX132's ask gate asks "was a question asked ANYWHERE?" The in-turn half
//     of turnState().askedAnythingElse read the reply as it stood at tool time,
//     saw the question, and allowed the hang-up. That branch exists to stop
//     FALSE refusals when a model asks and calls end_call in one turn, and it
//     did its job.
//   - live_exit_held_question asks "does the reply END with one?" This reply
//     ends with the farewell.
//
// A turn that asks mid-sentence and then signs off satisfies the first and
// evades the second. The fix is the state distinction the code already had:
// an ask carried ONLY by the in-turn read belongs to a turn that has not
// finished, so the caller cannot have answered it.
// ---------------------------------------------------------------------------

/**
 * A booking on a call where NOBODY has been asked "anything else" on a
 * completed turn. That is the whole precondition: `askedAnythingElseThisCall`
 * is written at turnComplete, so it is still false here, and the only thing
 * that can satisfy the ask gate is the sentence being spoken right now.
 */
async function bookedCallNeverAsked() {
  const s = await bootLive({ config: CONFIG, callSid: "CA94f2b4" });
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("I'd like Friday afternoon.");
  await s.assistantTurn(READ_BACK);
  await s.callerSays("Yes, that works.");
  await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });
  expect(s.store.scheduled()).toHaveLength(1);
  return s;
}

const ASK_THEN_SIGN_OFF_PART_1 =
  "Your appointment has been successfully updated to Friday, September eighteenth at three thirty PM. Is there anything else I can help you with today?";
const ASK_THEN_SIGN_OFF_PART_2 =
  "Thank you for calling Digile Media, and have a great day.";

describe("asked and signed off in one breath", () => {
  it("holds the exit when the only ask is in the turn that is closing", async () => {
    const s = await bookedCallNeverAsked();

    // The model speaks first and the tool runs mid-turn, which is the ordering
    // the Live API produces and the one the in-turn branch was written for.
    await s.assistantSays(ASK_THEN_SIGN_OFF_PART_1);
    const [res] = await s.callTool("end_call", {});

    // THE ASK GATE ALLOWED IT, and that is the premise rather than a detail. If
    // this ever starts refusing, the case below stops testing the seam and
    // becomes a second test of LVX132.
    expect(res.response.success).toBe(true);
    expect(counters().end_call_refused_no_ask).toBeFalsy();

    await s.assistantTurn(ASK_THEN_SIGN_OFF_PART_2);

    // The positional guard cannot see this: the reply ends with the farewell.
    expect(counters().live_exit_held_question).toBeFalsy();
    // The new one can.
    expect(counters().live_exit_held_in_turn_ask).toBe(1);
    expect(counters().live_exit_arm_checked).toBeFalsy();
    expect(s.ws.readyState).not.toBe(3);
  });

  it("closes on the next turn once the caller has answered", async () => {
    // The cost, stated: one turn. A hold that could never release would be a
    // line nobody can close, which is worse than the hang-up it prevents.
    const s = await bookedCallNeverAsked();
    await s.assistantSays(ASK_THEN_SIGN_OFF_PART_1);
    await s.callTool("end_call", {});
    await s.assistantTurn(ASK_THEN_SIGN_OFF_PART_2);
    expect(counters().live_exit_held_in_turn_ask).toBe(1);

    await s.callerSays("No, that's everything.");
    await s.assistantTurn("Thanks again, and have a wonderful day.");

    expect(counters().live_exit_arm_checked).toBe(1);
    // ONE HOLD, NOT TWO. The flag is spent when it fires; a latch left standing
    // would hold every remaining turn and the call could never end.
    expect(counters().live_exit_held_in_turn_ask).toBe(1);
  });

  it("does NOT hold when the caller was already asked on an earlier turn", async () => {
    // -----------------------------------------------------------------------
    // THE CLOSING TURN ASKS AGAIN, AND THAT IS THE POINT OF THIS CASE.
    //
    // The first version of it did not repeat the question, and it was worthless:
    // with no ask in the closing turn `closingTicRe` is false either way, so the
    // case passed whether or not `!askedAnythingElseThisCall` was there at all.
    // The sabotage matrix caught it -- `in-turn-ask-ignores-the-latch` came back
    // STILL GREEN -- and that is the matrix doing the job a reading of the code
    // did not.
    //
    // The state where the two disjuncts actually differ has to be written out
    // rather than assumed: the caller was asked on a COMPLETED turn, answered,
    // and the model asks a second time on its way out. That is not a rare shape
    // -- it is LVX136's transcript verbatim ("...wonderful day.Is there
    // anything else I can assist you with today?"). A caller asked once has
    // been asked, and holding here would cost an extra turn on every close a
    // repetitive model makes.
    // -----------------------------------------------------------------------
    const s = await bookedCall();

    await s.assistantSays(
      "Of course — that's Friday the eighteenth at three thirty PM. Is there anything else I can help you with today?"
    );
    await s.callTool("end_call", {});
    await s.assistantTurn("Thanks for calling Digile Media, and have a wonderful day.");

    expect(counters().live_exit_held_in_turn_ask).toBeFalsy();
    expect(counters().live_exit_arm_checked).toBe(1);
  });

  it("still holds on the positional rule when the reply ends with the question", async () => {
    // CA2556d43d's shape, re-asserted from this block: the two holds have
    // different causes and the older one must keep firing on its own case.
    const s = await bookedCall();

    await s.callTool("end_call", {});
    await s.assistantTurn(
      "That's now cancelled. Is there anything else I can help you with today?"
    );

    expect(counters().live_exit_held_question).toBe(1);
    expect(counters().live_exit_held_in_turn_ask).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// LVX145 — ASKED, AND NOT WAITED FOR. CA06cadea6, 2026-09-18:
//
//   17:28:08  A: "...I have that additional strategy call booked for you on
//                 Monday, September twenty-first at four-thirty PM. Is there
//                 anything else I can help you with today?"
//   17:28:13  caller: 40 ms of voice, 4 characters   <- starting to answer
//   17:28:14  end_call  success=TRUE                 <- allowed
//   17:28:23  line drops
//
// end_call_refusals {no_ask: 0}. Nothing refused, nothing held, and the caller
// was cut off mid-syllable six seconds after being asked a question.
//
// THE THIRD SHAPE, and neither existing guard covers it:
//
//   never asked at all                       -> LVX132's ask gate
//   asked only in the turn that is closing   -> LVX141's in-turn hold
//   asked LAST turn, caller silent, hang up  -> nothing
//
// LVX132's latch says "a caller asked once has been asked" and is never reset,
// so from the instant the question goes out the hang-up is permitted for the
// rest of the call. That is the right rule for the defect it was built on --
// ten calls that hung up having never asked at all -- and it cannot see this
// one, because it records that the question was ASKED and never whether it was
// ANSWERED. LVX141 fires only when the ask exists nowhere but the closing turn,
// which is false here: the ask completed its own turn.
//
// WHY `callerSaidThisCall.length` AND NOT A TURN COUNT. callerTurnCount is
// incremented by the VAD closing an utterance, and on this call it ticked at
// 17:28:13 on FORTY MILLISECONDS of voice -- a breath would move it. The
// accumulated transcript only grows when words actually arrive, so "has the
// caller said anything since we asked" is a length comparison and nothing else.
//
// It is also the safe direction under transcript lag: if the caller HAS spoken
// and the words have not landed yet, the length has not grown, so the exit
// waits a beat. The failure mode is a pause, not a dropped line.
// ---------------------------------------------------------------------------
const ASK_ON_ITS_OWN_TURN =
  "That's booked for you on Monday, September twenty-first at four-thirty PM. Is there anything else I can help you with today?";
const FAREWELL = "Thanks for calling Digile Media, and I hope you have a great day.";

describe("asked on the previous turn, and never answered", () => {
  it("holds the exit when the caller has said nothing since the question", async () => {
    const s = await bookedCallNeverAsked();

    await s.assistantTurn(ASK_ON_ITS_OWN_TURN);
    // The caller says NOTHING. This is the whole case.
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success, "the ask gate allows it -- they were asked").toBe(true);

    await s.assistantTurn(FAREWELL);

    expect(counters().live_exit_held_unanswered_ask).toBe(1);
    expect(counters().live_exit_arm_checked).toBeFalsy();
    expect(s.ws.readyState).not.toBe(3);
  });

  it("does NOT hold once the caller has answered", async () => {
    const s = await bookedCallNeverAsked();

    await s.assistantTurn(ASK_ON_ITS_OWN_TURN);
    await s.callerSays("No, that's everything.");
    await s.callTool("end_call", {});
    await s.assistantTurn(FAREWELL);

    expect(counters().live_exit_held_unanswered_ask).toBeFalsy();
    expect(counters().live_exit_arm_checked).toBe(1);
  });

  it("closes on the next turn, and holds only once", async () => {
    // A hold that could repeat is a line nobody can end, which is worse than
    // the hang-up it prevents. Spent when it fires, exactly like LVX141's.
    const s = await bookedCallNeverAsked();

    await s.assistantTurn(ASK_ON_ITS_OWN_TURN);
    await s.callTool("end_call", {});
    await s.assistantTurn(FAREWELL);
    expect(counters().live_exit_held_unanswered_ask).toBe(1);

    // Still nothing from the caller -- the silence ladder is the backstop and
    // the exit must not be held a second time waiting for it.
    await s.assistantTurn("I'll let you go now.");

    expect(counters().live_exit_arm_checked).toBe(1);
    expect(counters().live_exit_held_unanswered_ask).toBe(1);
  });
});
