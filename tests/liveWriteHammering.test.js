// ---------------------------------------------------------------------------
// THE HAMMERING LOOP, AND THE ONE THING THAT MUST NOT BE BROKEN TO STOP IT.
//
// CA03558d, 2026-09-17: five book_appointment calls in 2.3 seconds, then
// live_tool_rounds_capped three times. Six attempts on the call, zero rows, and
// "Yes, I have confirmed that your appointment is booked." CA919b69 did the
// same and landed a row only when the shared attempt budget gave up.
//
// Nothing bounded it. A refused write is never cached (lib/voice/live/guards.js
// freezes successes only, and deliberately). Both refusal budgets key on
// ctx.callerTurnCount, so five calls inside one caller turn spend nothing. The
// only in-turn brake is MAX_TOOL_ROUNDS = 5, counted per MODEL turn and reset
// in applyTurn -- and on 3.8 turnComplete arrives a median 17 ms after a tool
// call, so the counter resets and the model gets another five.
//
// THE SECOND TEST IS THE IMPORTANT ONE. The obvious brake -- cache a refusal by
// tool and arguments -- would lose bookings, because the legitimate shape is
// exactly a retry: the model is refused, THEN reads the details back, then
// calls again. That is what the gate is supposed to reward and what CA919b69
// spent four attempts trying to do. So the echo is keyed on the gate's own
// inputs, and a read-back changes them.
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
const ARGS = { client_name: CLIENT, scheduled_at: SLOT, notes: "strategy call" };
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

const boot = () => bootLive({ config: CONFIG, callSid: "CA_hammer" });

describe("a model hammering one refused write", () => {
  it("is answered from the refusal it already has, not re-gated five times", async () => {
    const s = await boot();
    await s.callTool("check_appointment_availability", { requested_at: SLOT });

    // No read-back, no agreement: the write is refused, and correctly.
    //
    // The caller has to have SAID something, or this tests the wrong gate: the
    // whole write-order stack is nested inside `lastCallerText.trim() !== ""`,
    // so a silent turn is refused higher up, by LVX117's check, and never
    // reaches the gate at all. CA03558d's attempts all had gate_ran=true.
    await s.assistantTurn("Let me get that sorted for you.");
    await s.callerSays("What have you got on Friday?");

    const responses = [];
    for (let i = 0; i < 5; i += 1) responses.push(await s.callTool("book_appointment", ARGS));

    // Every one answered -- an unanswered tool call is a Live session waiting
    // in silence, which is worse than a refusal.
    expect(responses.every((r) => r.length === 1)).toBe(true);
    expect(responses.every((r) => r[0].response.success === false)).toBe(true);
    expect(s.store.scheduled()).toHaveLength(0);

    const c = counters();
    // One real refusal, four echoes. Without the brake this is five refusals,
    // five passes through the whole gate stack, and five entries in the
    // transcript for the model to argue with.
    expect(c.live_write_refusal_replayed).toBe(4);
    expect(c.write_consent_checked).toBe(1);
  });

  it("does NOT echo once the model has read the details back", async () => {
    // The shape the brake must not break, and the one CA919b69 spent four
    // attempts on: refused, then the model does the thing the refusal asked
    // for, then calls again. lastReplyText changes, so the key changes, so the
    // gate runs -- and this time it passes.
    const s = await boot();
    await s.callTool("check_appointment_availability", { requested_at: SLOT });

    await s.assistantTurn("Let me get that sorted for you.");
    const first = await s.callTool("book_appointment", ARGS);
    expect(first[0].response.success).toBe(false);

    // The model reads the details back and the caller agrees.
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that's right.");
    const second = await s.callTool("book_appointment", ARGS);

    expect(second[0].response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
    // The echo never fired: nothing was replayed, the gate decided twice.
    expect(counters().live_write_refusal_replayed).toBeFalsy();
  });

  it("does not echo a refusal onto a DIFFERENT time", async () => {
    // Same tool, same turn, different arguments is a different proposal and has
    // to reach the gate on its own.
    const s = await boot();
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callTool("check_appointment_availability", { requested_at: "2026-09-18T16:00:00" });
    await s.assistantTurn("Let me get that sorted for you.");
    await s.callerSays("What have you got on Friday?");

    await s.callTool("book_appointment", ARGS);
    await s.callTool("book_appointment", { ...ARGS, scheduled_at: "2026-09-18T16:00:00" });

    expect(counters().live_write_refusal_replayed).toBeFalsy();
    expect(counters().write_consent_checked).toBe(2);
  });

  it("never echoes a SUCCESS, which is the duplicate guard's job", async () => {
    // A successful write is frozen by lib/voice/live/guards.js and handed back
    // as the success it earned. The echo must not be what does that, or a
    // refusal and a booking would be cached by the same rule and a bug in one
    // would move the other.
    const s = await boot();
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");

    await s.callTool("book_appointment", ARGS);
    await s.callTool("book_appointment", ARGS);

    expect(s.store.scheduled()).toHaveLength(1);
    expect(counters().live_write_refusal_replayed).toBeFalsy();
    expect(counters().live_guard_duplicate_suppressed).toBe(1);
  });
});
