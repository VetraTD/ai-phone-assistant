// ---------------------------------------------------------------------------
// LVX132. DO NOT HANG UP WITHOUT ASKING.
//
// The mirror of live_exit_held_question, which shipped in d57c31f: "do not hang
// up WHILE asking" now has its twin.
//
// THE PROMPT ALREADY SAYS TO ASK. The confirm step's guidance has said so for
// weeks. What it cannot do is arrive in time -- the step advances in
// applyReplyState, at turn end, after the tool round, so on CAb08e4e the model
// was told to ask five seconds after it had hung up:
//
//   06:18:22  cancel_appointment_db   success
//   06:18:25  end_call                success            <- 3 s later, same turn
//   06:18:30  live_step_transition    toStep=confirm     <- the instruction
//
// Measured over ten calls that reached end_call: 0 of 3 asked when end_call
// came first, 4 of 6 when confirm did. Necessary, not sufficient.
//
// WHY THIS FILE USES bootLive. A suite that stubs `execute` -- liveHangup,
// liveExitPrecedence, liveGoodbyeExit all do -- hand-rolls end_call's return
// shape and therefore cannot see this decision at all. Here the real
// services/tools.js gate runs and ctx is filled by the real turnState wire.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { executeToolCall } from "../services/tools.js";

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
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};

const SLOT = "2026-09-18T15:30:00";
const CLIENT = "Marcus Bell";
const READ_BACK =
  "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";
/** The wording CA2556d4 actually used, which is what closingTicRe is scored against. */
const ASKED = "That is now cancelled for you. Is there anything else I can help you with today?";

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

/** A completed booking, so end_call's "did something" gate is satisfied as it was live. */
async function bookedCall(callSid) {
  const s = await bootLive({ config: CONFIG, callSid });
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("I'd like Friday afternoon.");
  await s.assistantTurn(READ_BACK);
  await s.callerSays("Yes, that works.");
  await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });
  expect(s.store.scheduled()).toHaveLength(1);
  return s;
}

const ok = (responses) => responses[0]?.response?.success === true;

describe("the first hang-up on a call nobody was asked", () => {
  it("is refused, and the line stays open", async () => {
    const s = await bookedCall("CA_ask_refuse");
    const [res] = await s.callTool("end_call", {});

    expect(res.response.success).toBe(false);
    expect(res.response.message).toMatch(/anything else/i);
    expect(counters().end_call_refused_no_ask).toBe(1);
    // The positive twin, and the situation counter beside it.
    expect(counters().end_call_ask_check_ran).toBeGreaterThan(0);
    expect(counters().end_call_would_refuse_no_ask).toBe(1);

    // Nothing armed an exit. A refusal that still lets the line drop is the
    // shape LVX96 route A had, and it is reversed by the sign-off detector
    // rather than by this gate.
    await s.settle();
    expect(s.ws.readyState).toBe(1);
    expect(counters().live_exit_arm_checked).toBe(0);
  });

  it("hands the model the ask alone — nothing before it, no goodbye (LVX178)", async () => {
    // Round A1. The old refusal said "Do NOT say goodbye again ... Say ONE short
    // sentence asking whether there is anything else". On Live the tool runs
    // BEFORE the turn's speech, so the model had not said goodbye yet: it then
    // spoke its planned farewell AND the ask -- goodbye-then-ask, 2 of 434
    // corpus turns. The refusal now gives it the one sentence to say.
    const s = await bookedCall("CA_ask_words");
    const [res] = await s.callTool("end_call", {});
    const msg = res.response.message;
    expect(msg).toMatch(/Say only this, nothing before it, no goodbye/);
    expect(msg).toContain("Before you go — is there anything else I can help you with?");
    expect(msg).not.toMatch(/Do NOT say goodbye again/);
  });

  it("does not refuse the existing gates' cases differently", async () => {
    // The generic branch still owns a hang-up on turn one with nothing done.
    const s = await bootLive({ config: CONFIG, callSid: "CA_ask_generic" });
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_generic).toBe(1);
    // Not ours: the four existing ways in were never satisfied, so this never
    // reached the ask check at all.
    expect(counters().end_call_refused_no_ask).toBe(0);
    expect(counters().end_call_ask_check_ran).toBe(0);
  });
});

describe("the latch", () => {
  it("lets the second hang-up through, so one refusal cannot become a trap", async () => {
    const s = await bookedCall("CA_ask_latch");
    const [first] = await s.callTool("end_call", {});
    expect(first.response.success).toBe(false);

    // The model says nothing new and asks again. LVX21 is what a hair trigger
    // costs here: one refusal is a question the caller can answer, two is a
    // caller held on the line with no way out.
    const second = await s.callTool("end_call", {});
    expect(ok(second)).toBe(true);
    expect(counters().end_call_refused_no_ask).toBe(1);
    // The SITUATION is still true on the second attempt, and still counted.
    // That divergence is the only way a second attempt is visible at all.
    expect(counters().end_call_would_refuse_no_ask).toBe(2);
  });
});

describe("a caller who was asked", () => {
  it("is not held up when the question came on an earlier turn", async () => {
    const s = await bookedCall("CA_ask_earlier");
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");

    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_no_ask).toBe(0);
    expect(counters().end_call_would_refuse_no_ask).toBe(0);
  });

  // -------------------------------------------------------------------------
  // THE ONE THAT IS ABOUT TIMING RATHER THAN ABOUT POLICY.
  //
  // The latch above is written in auditTurn, at turnComplete, AFTER the tool
  // round -- so on the turn where the model asks and hangs up in one breath it
  // is still false. The only thing that can answer for that turn is the reply
  // text as it stands at tool time, and it exists for exactly that long:
  // applyTurn() clears turnReplyText a few lines later.
  //
  // A guard in this file was written to read that value one line too late once
  // already. It was present, plausible, and silently never fired.
  // -------------------------------------------------------------------------
  it("is not held up when the question is still being asked in this very turn", async () => {
    const s = await bookedCall("CA_ask_same_turn");
    await s.assistantSays(ASKED); // spoken, turn NOT complete
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_no_ask).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The per-call record. A process-global counter cannot say which call refused,
// which is the gap LVX96 was found by reading a twenty-five second call by hand
// to fill.
// ---------------------------------------------------------------------------
describe("the call record", () => {
  it("carries the refusal on the call that made it", async () => {
    const chunks = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string" && chunk.includes('"event":"live_call_summary"')) chunks.push(chunk);
      return true;
    });
    try {
      const s = await bookedCall("CA_ask_summary");
      await s.callTool("end_call", {});
      await s.hangUp();
    } finally {
      spy.mockRestore();
    }
    const summaries = chunks
      .flatMap((c) => c.split("\n"))
      .filter((l) => l.includes('"event":"live_call_summary"'))
      .map((l) => JSON.parse(l));

    expect(summaries).toHaveLength(1);
    expect(summaries[0].end_call_refusals.no_ask).toBe(1);
    expect(summaries[0].end_call_refusals.generic).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE CALLER'S OWN "I'M DONE" ANSWERS "ANYTHING ELSE?" -- owner, 2026-10-02.
//
// Smoke CAfd993a ("A nice day. That's all. Thanks."), I3 CA1198b0 ("That's all.
// I just wanted to know what Digital Media actually does."): end_call refused
// by this gate, the model asked "Is there anything else...?", the caller said
// "No." and was thanked a second time. A clear close is the answer the ask is
// fishing for. A bare "Thank you." is NOT one -- it is as often thanks for what
// the AI just did, before the caller's next question -- so it keeps the ask.
// ---------------------------------------------------------------------------
describe("a caller who closed the call themselves", () => {
  it.each([["That's all. Thanks."], ["A nice day. That's all. Thanks."], ["No, thanks."], ["Okay, bye."], ["Eso es todo, gracias."]])(
    "is not asked 'anything else?' after %j",
    async (said) => {
      const s = await bookedCall("CA_close_" + said.length);
      await s.assistantTurn("You're all booked for Friday at three thirty.");
      await s.callerSays(said);
      const res = await s.callTool("end_call", {});
      expect(ok(res)).toBe(true);
      expect(counters().end_call_refused_no_ask).toBe(0);
      expect(counters().end_call_ask_satisfied_by_caller_close).toBe(1);
    }
  );

  it.each([["Thank you."], ["That's all, but can I ask one more thing"], ["That's it, and also my wife wants one."], ["That's all for now?"]])(
    "is still asked after %j",
    async (said) => {
      const s = await bookedCall("CA_noclose_" + said.length);
      await s.assistantTurn("You're all booked for Friday at three thirty.");
      await s.callerSays(said);
      const [res] = await s.callTool("end_call", {});
      expect(res.response.success).toBe(false);
      expect(counters().end_call_refused_no_ask).toBe(1);
      expect(counters().end_call_ask_satisfied_by_caller_close).toBeFalsy();
    }
  );

  it("the farewell door (no end_call) closes on it too, instead of holding the line a turn", async () => {
    const s = await bookedCall("CA_close_door");
    await s.assistantTurn("You're all booked for Friday at three thirty.");
    await s.callerSays("That's all, thanks.");
    await s.assistantTurn("Thank you for calling Brightwork, and have a great day.");
    expect(counters().live_goodbye_exit_held_no_ask || 0).toBe(0);
    expect(counters().live_goodbye_exit_caller_closed).toBe(1);
  });
});

// Final review 2026-10-02 (batch 2), I4. "Yes, that's it." answering a READ-BACK
// is a confirmation, not "I'm done": if the model books and signs off in that
// same turn -- the CAb08e4e shape LVX132 was built for -- the caller must still
// be asked. The close counts only when the previous assistant turn was not a
// read-back and nothing was completed in this turn.
describe("a close that is really the answer to a read-back (review I4)", () => {
  async function confirmedWith(callSid, said) {
    const s = await bootLive({ config: CONFIG, callSid });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("I'd like Friday afternoon.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays(said);
    await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });
    expect(s.store.scheduled()).toHaveLength(1);
    return s;
  }

  it("end_call in the same turn as the booking is still asked 'anything else?'", async () => {
    const s = await confirmedWith("CA_i4_gate", "Yes, that's it.");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(1);
    expect(counters().end_call_ask_satisfied_by_caller_close).toBeFalsy();
  });

  it("a farewell (no end_call) in that same turn is held for the ask", async () => {
    const s = await confirmedWith("CA_i4_door", "Yes, we're all set.");
    await s.assistantTurn("You're all booked. Thank you for calling Brightwork, and have a great day.");
    expect(counters().live_goodbye_exit_held_no_ask).toBe(1);
    expect(counters().live_goodbye_exit_caller_closed || 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LVX185. A QUESTION BACK IS NOT "NO, NOTHING ELSE".
//
// CA86103cd, 2026-10-22: end_call refused once (no_ask), the model asked
// "Before you go -- is there anything else I can help you with?", and the
// caller answered with a question. The model answered it and called end_call
// in the same turn; the no_ask refusal was spent and the caller HAD said
// something since the ask, so every gate let it through, and the line dropped
// while the caller was still mid-confusion.
//
// The caller lines here are the brief's examples or invented -- never corpus
// words.
// ---------------------------------------------------------------------------
const QUESTION_BACK = "Wait, what? Wait, hold on. Wait, so this isn't the car insurance company number?";
const CALLER_QUESTION_REFUSAL =
  '[not caller speech] NOT A FAILURE, the call is still open. The caller just asked you something. Answer it in one short sentence if you have not, then ask: "Is there anything else I can help you with?" Then stop and wait. Do not say goodbye.';
const ASK_AGAIN = "Is there anything else I can help you with?";

/** CA86103cd's shape: refused once for no_ask, asked, and the caller asked something back. */
async function questionedAfterAsk(callSid, said = QUESTION_BACK) {
  const s = await bookedCall(callSid);
  const [first] = await s.callTool("end_call", {});
  expect(first.response.success).toBe(false);
  expect(counters().end_call_refused_no_ask).toBe(1);
  await s.assistantTurn("Before you go — is there anything else I can help you with?");
  await s.callerSays(said);
  return s;
}

describe("LVX185: a caller's question back keeps the call open", () => {
  it("end_call after a caller question is refused with caller_question, even when the no_ask refusal is spent", async () => {
    const s = await questionedAfterAsk("CA_q_refused");
    const [res] = await s.callTool("end_call", {});

    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_caller_question).toBe(1);
    expect(counters().end_call_question_check_ran).toBe(1);
    // The no_ask one-shot was the FIRST refusal and is still the only one.
    expect(counters().end_call_refused_no_ask).toBe(1);
    await s.settle();
    expect(s.ws.readyState).toBe(1);
  });

  it("holds a request to hold on the same way", async () => {
    const s = await questionedAfterAsk("CA_q_hold", "Hold on a second.");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_caller_question).toBe(1);
  });

  it('the refusal asks for "Is there anything else I can help you with?" and no goodbye', async () => {
    const s = await questionedAfterAsk("CA_q_words");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.message).toBe(CALLER_QUESTION_REFUSAL);

    // The model signs off anyway, in the turn the refusal belongs to. That
    // farewell must not arm the exit (LVX96 route A), or the refusal is
    // reversed inside its own turn.
    await s.assistantTurn("No, this is Digile Media. Thanks for calling Digile Media, and have a wonderful day.");
    expect(counters().live_goodbye_suppressed_by_refusal).toBe(1);
    expect(counters().live_goodbye_armed_exit || 0).toBe(0);
    expect(counters().live_exit_arm_checked || 0).toBe(0);
    expect(s.ws.readyState).toBe(1);
  });

  it("after two holds end_call goes through: a caller asking three questions in a row", async () => {
    const s = await questionedAfterAsk("CA_q_three");
    const [r1] = await s.callTool("end_call", {});
    expect(r1.response.success).toBe(false);
    await s.assistantTurn(`No, this is Digile Media, a marketing agency. ${ASK_AGAIN}`);

    await s.callerSays("Did you just say goodbye?");
    const [r2] = await s.callTool("end_call", {});
    expect(r2.response.success).toBe(false);
    await s.assistantTurn(`Sorry about that. ${ASK_AGAIN}`);

    // The third question. Two holds are spent; a third would be a caller who
    // can never be let go (LVX21's trap), so this one goes through.
    await s.callerSays("Can you say that one more time?");
    const r3 = await s.callTool("end_call", {});
    expect(ok(r3)).toBe(true);
    expect(counters().end_call_refused_caller_question).toBe(2);
    // The check still ran on the attempt it let through.
    expect(counters().end_call_question_check_ran).toBe(3);
  });

  it("the sign-off door and end_call share the one limit of two", async () => {
    const s = await questionedAfterAsk("CA_q_doors");
    // Hold 1, at the OTHER door: a farewell spoken without end_call.
    await s.assistantTurn("No, this is Digile Media. Thanks for calling Digile Media, and have a wonderful day.");
    expect(counters().live_goodbye_exit_held_caller_question).toBe(1);
    expect(counters().live_goodbye_armed_exit || 0).toBe(0);

    // Hold 2, at end_call.
    await s.callerSays("Did you just say goodbye?");
    const [r2] = await s.callTool("end_call", {});
    expect(r2.response.success).toBe(false);
    expect(counters().end_call_refused_caller_question).toBe(1);
    await s.assistantTurn(`Sorry about that. ${ASK_AGAIN}`);

    // Both holds are spent, whichever door spent them.
    await s.callerSays("Can you say that one more time?");
    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_caller_question).toBe(1);
  });

  it.each([["No thanks."], ["No, that's all, thanks."], ["Okay, bye."]])("a clear no goes through: %j", async (said) => {
    const s = await questionedAfterAsk("CA_q_no_" + said.length, said);
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_caller_question || 0).toBe(0);
    // The positive twin: the check ran, and found nothing open.
    expect(counters().end_call_question_check_ran).toBe(1);
  });

  it("a caller question on a call nobody asked is still LVX132's refusal, not this one", async () => {
    // Additive, like LVX132 itself: this gate only turns an otherwise-ALLOWED
    // hang-up into a refusal. The no_ask refusal already holds this caller, and
    // it keeps its own counter's meaning.
    const s = await bookedCall("CA_q_precedence");
    await s.assistantTurn("You're all booked for Friday at three thirty.");
    await s.callerSays("Did you just say goodbye?");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(1);
    expect(counters().end_call_refused_caller_question || 0).toBe(0);
  });

  it("the caller's answer to a read-back is not a question back", async () => {
    // Review I4's exclusion, at this gate too: "That's the one?" in answer to a
    // read-back confirms it, and the model is free to close.
    const s = await bookedCall("CA_q_readback");
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("That's the one?");
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_caller_question || 0).toBe(0);
  });

  it("carries the refusals and the holds on the call record", async () => {
    const chunks = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string" && chunk.includes('"event":"live_call_summary"')) chunks.push(chunk);
      return true;
    });
    try {
      const s = await questionedAfterAsk("CA_q_summary");
      await s.callTool("end_call", {});
      await s.hangUp();
    } finally {
      spy.mockRestore();
    }
    const [summary] = chunks
      .flatMap((c) => c.split("\n"))
      .filter((l) => l.includes('"event":"live_call_summary"'))
      .map((l) => JSON.parse(l));

    expect(summary.end_call_refusals.caller_question).toBe(1);
    expect(summary.end_call_refusals.no_ask).toBe(1);
    expect(summary.closing.caller_question_holds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The same gate, with the wires the drivers actually pass. services/tools.js is
// shared and stateless; the per-call count lives on the Live front-end.
// ---------------------------------------------------------------------------
describe("LVX185 at the shared gate", () => {
  const liveCtx = {
    businessId: "biz-1",
    config: CONFIG,
    step: "confirm",
    callerTurnCount: 4,
    lastCallerText: "Did you just say goodbye?",
    askedAnythingElse: true,
    anythingElseRefusalSpent: true,
  };

  it("no callerQuestionHolds wire means no gate (the cascade)", async () => {
    // The ask wire alone, then no wire at all: the cascade passes neither, and
    // a gate without its count could refuse forever.
    const withAskWire = await executeToolCall({ id: "q1", name: "end_call", args: {} }, liveCtx);
    expect(withAskWire.functionResponse.response.success).toBe(true);
    const cascadeCtx = { ...liveCtx };
    delete cascadeCtx.askedAnythingElse;
    delete cascadeCtx.anythingElseRefusalSpent;
    const cascade = await executeToolCall({ id: "q2", name: "end_call", args: {} }, cascadeCtx);
    expect(cascade.functionResponse.response.success).toBe(true);
    // The positive twin stays 0: it did not run, rather than ran and passed.
    expect(counters().end_call_question_check_ran || 0).toBe(0);
    expect(counters().end_call_refused_caller_question || 0).toBe(0);
  });

  it("refuses with the wire, and stops at two", async () => {
    const held = await executeToolCall({ id: "q3", name: "end_call", args: {} }, { ...liveCtx, callerQuestionHolds: 1 });
    expect(held.functionResponse.response.success).toBe(false);
    expect(held.stateEffects.endCallRefusal).toBe("caller_question");
    // Not LVX132's latch: this refusal must not spend the no_ask one-shot.
    expect(held.stateEffects.endCallNoAskRefusal).toBeUndefined();
    expect(held.stateEffects.toolResult).toEqual({
      name: "end_call",
      success: false,
      message: ASK_AGAIN,
      callerSafe: true,
    });

    const spent = await executeToolCall({ id: "q4", name: "end_call", args: {} }, { ...liveCtx, callerQuestionHolds: 2 });
    expect(spent.functionResponse.response.success).toBe(true);
  });

  it("skipped on outbound", async () => {
    // S3-1: Ava placed the call, so there is no "anything else" to ask.
    const { functionResponse, stateEffects } = await executeToolCall(
      { id: "q5", name: "end_call", args: {} },
      { ...liveCtx, callerQuestionHolds: 0, outboundCall: { config: {}, contact: {}, campaign: {} } }
    );
    expect(functionResponse.response.success).toBe(true);
    expect(stateEffects.endCallRefusal).toBeUndefined();
    expect(counters().end_call_refused_caller_question || 0).toBe(0);
    expect(counters().end_call_question_check_ran || 0).toBe(0);
  });
});

