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
