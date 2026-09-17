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
