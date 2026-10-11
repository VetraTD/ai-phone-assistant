// The per-call clock (pure module) and the harness seams Task B/C will lean on.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_WRAP_UP_SEC,
  DEFAULT_GOODBYE_SEC,
  DEFAULT_HARD_END_SEC,
  GOOGLE_LIMIT_SEC,
  WRAP_UP_NOTE,
  GOODBYE_NOTE,
  NOTE_FORCE_AFTER_MS,
  HARD_END_REDIRECT_TIMEOUT_MS,
  resolveClockConfig,
  createCallClock,
} from "../lib/voice/live/callClock.js";
import { bootLive, counters, fakeDb, fakeLive, fakeTwilioClient } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const DEFAULTS = { wrapUpSec: 510, goodbyeSec: 540, hardEndSec: 570 };

/** Reads the real stdout lines for one event (lib/logger.js writes there directly). */
function captureEvents(event) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string" && chunk.includes(`"event":"${event}"`)) {
      for (const l of chunk.split("\n")) if (l.includes(`"event":"${event}"`)) lines.push(JSON.parse(l));
    }
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, unref: vi.fn() };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
    // Fire what is still armed, like the event loop would, in time order.
    fireAll() {
      for (const t of [...timers].sort((a, b) => a.ms - b.ms)) if (!t.cleared) t.fn();
    },
    fireAt(ms) {
      for (const t of timers) if (t.ms === ms && !t.cleared) t.fn();
    },
  };
}

describe("resolveClockConfig", () => {
  it("defaults are 510 / 540 / 570 and the constants say so", () => {
    expect(resolveClockConfig({})).toEqual(DEFAULTS);
    expect([DEFAULT_WRAP_UP_SEC, DEFAULT_GOODBYE_SEC, DEFAULT_HARD_END_SEC, GOOGLE_LIMIT_SEC]).toEqual([
      510, 540, 570, 589,
    ]);
  });

  it("honours each env var on its own", () => {
    expect(resolveClockConfig({ LIVE_CALL_WRAP_UP_SEC: "300" })).toEqual({ ...DEFAULTS, wrapUpSec: 300 });
    expect(resolveClockConfig({ LIVE_CALL_GOODBYE_SEC: "560" })).toEqual({ ...DEFAULTS, goodbyeSec: 560 });
    expect(resolveClockConfig({ LIVE_CALL_HARD_END_SEC: "580" })).toEqual({ ...DEFAULTS, hardEndSec: 580 });
  });

  it("honours all three together", () => {
    expect(
      resolveClockConfig({
        LIVE_CALL_WRAP_UP_SEC: "60",
        LIVE_CALL_GOODBYE_SEC: "90",
        LIVE_CALL_HARD_END_SEC: "120",
      }),
    ).toEqual({ wrapUpSec: 60, goodbyeSec: 90, hardEndSec: 120 });
  });

  it("an order violation falls back to ALL THREE defaults with one log line", () => {
    const cap = captureEvents("live_call_clock_config_refused");
    let cfg;
    try {
      cfg = resolveClockConfig({ LIVE_CALL_WRAP_UP_SEC: "560", LIVE_CALL_GOODBYE_SEC: "100" });
    } finally {
      cap.restore();
    }
    expect(cfg).toEqual(DEFAULTS);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0].severity).toBe("warn");
  });

  it("equal values are refused (strictly increasing)", () => {
    expect(resolveClockConfig({ LIVE_CALL_WRAP_UP_SEC: "540" })).toEqual(DEFAULTS);
  });

  it("HARD_END=600 is refused: it is past Google's limit", () => {
    expect(resolveClockConfig({ LIVE_CALL_HARD_END_SEC: "600" })).toEqual(DEFAULTS);
  });

  it("HARD_END=589 is refused: strictly below the limit; 588 is allowed", () => {
    expect(resolveClockConfig({ LIVE_CALL_HARD_END_SEC: "589" })).toEqual(DEFAULTS);
    expect(resolveClockConfig({ LIVE_CALL_HARD_END_SEC: "588" })).toEqual({ ...DEFAULTS, hardEndSec: 588 });
  });

  it("non-numeric, zero, negative and non-finite values are refused", () => {
    for (const bad of ["abc", "0", "-5", "Infinity", "NaN"]) {
      expect(resolveClockConfig({ LIVE_CALL_WRAP_UP_SEC: bad })).toEqual(DEFAULTS);
    }
  });

  it("an empty string counts as unset", () => {
    expect(resolveClockConfig({ LIVE_CALL_WRAP_UP_SEC: "" })).toEqual(DEFAULTS);
  });
});

describe("createCallClock", () => {
  function build(overrides = {}) {
    const sch = fakeScheduler();
    const order = [];
    const clock = createCallClock({
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      config: DEFAULTS,
      onWrapUp: () => order.push("wrap"),
      onGoodbye: () => order.push("goodbye"),
      onHardEnd: () => order.push("hard"),
      ...overrides,
    });
    return { sch, order, clock };
  }

  it("start() schedules exactly three timers at 510/540/570 s, unref'd, and fires nothing yet", () => {
    const { sch, order, clock } = build();
    clock.start();
    expect(sch.timers.map((t) => t.ms)).toEqual([510_000, 540_000, 570_000]);
    expect(sch.timers.every((t) => t.unref.mock.calls.length === 1)).toBe(true);
    expect(order).toEqual([]);
  });

  it("fires each callback once, in order", () => {
    const { sch, order, clock } = build();
    clock.start();
    sch.fireAt(510_000);
    expect(order).toEqual(["wrap"]);
    sch.fireAt(540_000);
    sch.fireAt(570_000);
    sch.fireAll(); // a timer firing twice must not call twice
    expect(order).toEqual(["wrap", "goodbye", "hard"]);
  });

  it("a second start() is a no-op: three timers, not six", () => {
    const { sch, clock } = build();
    clock.start();
    clock.start();
    expect(sch.timers).toHaveLength(3);
  });

  it("stop() before any fire: none fire, every timer cleared", () => {
    const { sch, order, clock } = build();
    clock.start();
    clock.stop();
    expect(sch.timers.every((t) => t.cleared)).toBe(true);
    // Even a timer that was already queued in the event loop stays silent.
    for (const t of sch.timers) t.fn();
    expect(order).toEqual([]);
  });

  it("stop() between goodbye and hard end: hard end never fires", () => {
    const { sch, order, clock } = build();
    clock.start();
    sch.fireAt(510_000);
    sch.fireAt(540_000);
    clock.stop();
    for (const t of sch.timers) t.fn();
    expect(order).toEqual(["wrap", "goodbye"]);
  });

  it("stop() twice is fine, and a start() after stop() arms nothing", () => {
    const { sch, clock } = build();
    clock.start();
    clock.stop();
    clock.stop();
    clock.start();
    expect(sch.timers).toHaveLength(3);
  });

  it("stop() before start() is harmless", () => {
    const { sch, clock } = build();
    clock.stop();
    clock.start();
    expect(sch.timers).toHaveLength(0);
  });

  it("a throwing callback does not stop the next one, and is logged with its stage", () => {
    const cap = captureEvents("live_call_clock_callback_failed");
    const order = [];
    const { sch, clock } = build({
      onWrapUp: () => {
        throw new Error("boom");
      },
      onGoodbye: () => order.push("goodbye"),
      onHardEnd: () => order.push("hard"),
    });
    try {
      clock.start();
      sch.fireAll();
    } finally {
      cap.restore();
    }
    expect(order).toEqual(["goodbye", "hard"]);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0].stage).toBe("wrap_up");
  });

  it("exports the note texts and the force-after window", () => {
    expect(WRAP_UP_NOTE).toMatch(/about one minute left/);
    expect(GOODBYE_NOTE).toMatch(/one short, warm goodbye/);
    expect(NOTE_FORCE_AFTER_MS).toBe(20_000);
  });
});

describe("Live harness seams (batch-3 S2)", () => {
  const CONFIG = {
    businessName: "Digile Media",
    greeting: "Thanks for calling Digile Media.",
    mainPhone: "+18176011171",
    timezone: "America/Chicago",
    locale: "en-US",
    allowedTasks: [],
    afterHoursPolicy: "take_message",
    capabilities: {},
  };

  beforeEach(() => clearStats());

  it("live.close({code: 1011}) reaches the session's onclose (abnormal counter)", async () => {
    const { live } = await bootLive({ config: CONFIG, callSid: "CA_close_a" });
    expect(counters().live_close_abnormal ?? 0).toBe(0);
    const cap = captureEvents("live_close_abnormal");
    try {
      live.close({ code: 1011, reason: "internal error" });
    } finally {
      cap.restore();
    }
    expect(counters().live_close_abnormal).toBe(1);
    expect(cap.lines[0]).toMatchObject({ code: 1011, reason: "internal error" });
  });

  it("live.close({code: 1000}) is a clean close", async () => {
    const { live } = await bootLive({ config: CONFIG, callSid: "CA_close_c" });
    live.close({ code: 1000 });
    expect(counters().live_close_clean).toBe(1);
  });

  it("close() before connect is a harmless no-op", () => {
    expect(() => fakeLive().close()).not.toThrow();
  });

  it("connectError: connect rejects, and bootLive still returns", async () => {
    const err = new Error("no AI today");
    const { live } = await bootLive({ config: CONFIG, callSid: "CA_conn_rej", connectError: err });
    expect(live.connect).toHaveBeenCalled();
    await expect(live.connect.mock.results[0].value).rejects.toBe(err);
  });

  it('connectGate: "reject" rejects with the default message', async () => {
    const live = fakeLive({ connectGate: "reject" });
    await expect(live.connect({ callbacks: {} })).rejects.toThrow("connect refused");
  });

  it("fakeTwilioClient records updates, and rejects with failWith AFTER recording", async () => {
    const ok = fakeTwilioClient();
    await ok.calls("CA1").update({ twiml: "<Response/>" });
    expect(ok.updates).toEqual([{ sid: "CA1", twiml: "<Response/>" }]);
    expect(ok.calls).toHaveBeenCalledTimes(1);

    const boom = new Error("twilio down");
    const bad = fakeTwilioClient({ failWith: boom });
    await expect(bad.calls("CA2").update({ twiml: "<Response><Say/></Response>" })).rejects.toBe(boom);
    expect(bad.updates).toEqual([{ sid: "CA2", twiml: "<Response><Say/></Response>" }]);
  });

  it("bootLive passes setTimer / clearTimer / twilioClient / accountSid through only when set", async () => {
    const sch = fakeScheduler();
    const tw = fakeTwilioClient();
    const booted = await bootLive({
      config: CONFIG,
      callSid: "CA_pass",
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClient: tw,
      accountSid: "AC123",
    });
    expect(booted.live.connect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WIRING (batch-3 S2, Task B). The clock inside a real Live session, driven by
// bootLive and a hand-rolled scheduler, so 9.5 minutes pass in milliseconds.
//
// The real timers the session also owns (exit fallback, hang-up grace) run on
// vitest's fake clock; the CALL clock's own timers run on `fakeScheduler`, so a
// test fires "9:30" without moving the other clock at all.
// ---------------------------------------------------------------------------
describe("the call clock inside a Live session", () => {
  const OPEN = { open: "09:00", close: "18:00", closed: false };
  const CLOSED = { open: null, close: null, closed: true };
  const WIRE_CONFIG = {
    businessName: "Digile Media",
    greeting: "Thanks for calling Digile Media.",
    mainPhone: "+18176011171",
    timezone: "America/Chicago",
    businessHours: { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: CLOSED, sun: CLOSED },
    locale: "en-US",
    allowedTasks: ["book_appointment", "check_appointment", "transfer_human"],
    transferPhoneNumber: "+441111222333",
    transferPolicy: "always",
    capabilities: {
      appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
    },
  };
  const SLOT = "2026-09-18T15:30:00";
  const READ_BACK =
    "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";
  const ASKED = "That is now booked for you. Is there anything else I can help you with today?";
  const T = { WRAP: 510_000, GOODBYE: 540_000, HARD: 570_000, FORCE: NOTE_FORCE_AFTER_MS };

  let priorSpellPolicy;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    clearStats();
    priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
    process.env.VOICE_SPELL_POLICY = "off";
  });
  afterEach(() => {
    vi.useRealTimers();
    if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
  });

  async function bootClock({ twilioClient = fakeTwilioClient(), ...rest } = {}) {
    const sch = fakeScheduler();
    const s = await bootLive({
      config: WIRE_CONFIG,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClient,
      ...rest,
    });
    // bootLive's socket discards what Twilio would receive; keep the marks.
    const marks = [];
    s.ws.send = (raw) => {
      const m = JSON.parse(raw);
      if (m.event === "mark") marks.push(m.mark.name);
    };
    const timeNotes = (text) =>
      s.live.sent.clientContent.filter((m) => m.turns?.[0]?.parts?.[0]?.text === text);
    return { s, sch, tw: twilioClient, marks, timeNotes };
  }

  /** Fire one clock timer by its delay, then let the async work settle. */
  async function fire(s, sch, ms) {
    sch.fireAt(ms);
    await s.settle();
  }

  async function bookedCall(opts) {
    const c = await bootClock(opts);
    await c.s.callTool("check_appointment_availability", { requested_at: SLOT });
    await c.s.callerSays("I'd like Friday afternoon.");
    await c.s.assistantTurn(READ_BACK);
    await c.s.callerSays("Yes, that works.");
    await c.s.callTool("book_appointment", { client_name: "Marcus Bell", scheduled_at: SLOT });
    return c;
  }

  /** An allowed transfer, armed at turn end: the mark is out, the echo is not. */
  async function transferArmed(c) {
    await c.s.callTool("request_transfer", { reason: "billing" });
    await c.s.assistantTurn("Putting you through now.");
    expect(c.marks).toContain("live-exit-transfer");
  }
  const echo = (c, name) => c.s.ws.deliver({ event: "mark", mark: { name }, streamSid: "MZ1" });

  it("starts exactly three timers, at 510 / 540 / 570 s, once the session is open", async () => {
    const { sch } = await bootClock();
    expect(sch.timers.map((t) => t.ms)).toEqual([T.WRAP, T.GOODBYE, T.HARD]);
  });

  it("1. wrap-up mid-generation waits for the turn end, goes once, never twice", async () => {
    const { s, sch, timeNotes } = await bootClock();
    await s.assistantSays("Our office opens at nine tomorrow");
    await fire(s, sch, T.WRAP);
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);

    await s.turnEnds();
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
    expect(timeNotes(WRAP_UP_NOTE)[0].turnComplete).toBe(true);

    await s.assistantTurn("Anything else?");
    await s.assistantTurn("Still here.");
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
  });

  it("1b. a guard note at the same turn end defers the wrap-up to the next turn end", async () => {
    const { s, sch, timeNotes } = await bootClock();
    // A promise with no tool behind it: the promise-only-turn guard speaks a note.
    await s.assistantSays("Let me look at that for you");
    await fire(s, sch, T.WRAP);
    const cap = captureEvents("live_time_note_deferred");
    try {
      await s.turnEnds();
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ kind: "wrap", reason: "guard_note" });
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);

    await s.assistantTurn("Our office opens at nine tomorrow.");
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
  });

  it("2. wrap-up with no turn end is sent by the 20 s force timer, once", async () => {
    const { s, sch, timeNotes } = await bootClock();
    await s.assistantSays("Mid sentence");
    await fire(s, sch, T.WRAP);
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
    const force = sch.timers.filter((t) => t.ms === T.FORCE && !t.cleared);
    expect(force).toHaveLength(1);

    const cap = captureEvents("live_time_note");
    try {
      force[0].fn();
    } finally {
      cap.restore();
    }
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ callSid: "CA_test", kind: "wrap", forced: true });
    expect(force[0].cleared).toBe(true);
    await s.turnEnds();
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
  });

  it("3. goodbye mid-generation: no note and no exit at that turn end; note at it; its own turn arms the exit", async () => {
    const c = await bookedCall();
    const { s, sch, marks, timeNotes } = c;
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    await s.assistantSays("Let me finish up");
    await fire(s, sch, T.GOODBYE);
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(0);

    // The turn that was already generating ends: the note goes out, and the
    // exit is NOT armed off this turn.
    await s.turnEnds();
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(1);
    expect(marks).not.toContain("live-exit-end_call");

    // The goodbye's own turn arms the exit; the mark echo then ends the call.
    await s.assistantTurn("Thank you for calling Digile Media. Goodbye.");
    expect(marks).toContain("live-exit-end_call");
    echo(c, "live-exit-end_call");
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.ws.readyState).toBe(3);
  });

  it("4. a goodbye replaces an undelivered wrap-up: only the goodbye is sent", async () => {
    const { s, sch, timeNotes } = await bootClock();
    await s.assistantSays("Thinking");
    await fire(s, sch, T.WRAP);
    await fire(s, sch, T.GOODBYE);
    // The wrap-up's force timer died with the note it carried.
    expect(sch.timers.filter((t) => t.ms === T.FORCE && !t.cleared)).toHaveLength(1);
    await s.turnEnds();
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(1);
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
  });

  it("5. the goodbye is skipped, with a reason, when an exit is already queued", async () => {
    const c = await bookedCall();
    const { s, sch, marks, timeNotes } = c;
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(true);
    await s.assistantTurn("Thanks for calling. Goodbye.");
    expect(marks).toContain("live-exit-end_call");

    const cap = captureEvents("live_time_note_skipped");
    try {
      await fire(s, sch, T.GOODBYE);
      await s.turnEnds();
    } finally {
      cap.restore();
    }
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(0);
    expect(cap.lines.length).toBeGreaterThan(0);
    expect(cap.lines[0]).toMatchObject({ kind: "goodbye", reason: "exit_queued" });
  });

  it("6. hard end: one update with the time-up line and <Hangup/>, then the call finishes", async () => {
    const { s, sch, tw } = await bootClock();
    const cap = captureEvents("live_max_duration_hard_end");
    try {
      await fire(s, sch, T.HARD);
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expect(tw.updates[0].sid).toBe("CA_test");
    expect(tw.updates[0].twiml).toContain("reached the time limit");
    expect(tw.updates[0].twiml).toContain("<Hangup/>");
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ callSid: "CA_test", severity: "warn" });
    expect(s.ws.readyState).toBe(3);
  });

  it("7. a transfer at 9:20 leaves nothing for 9:30: only the transfer's own update exists", async () => {
    const c = await bootClock();
    await transferArmed(c);
    echo(c, "live-exit-transfer");
    await vi.waitFor(() => expect(c.tw.updates).toHaveLength(1));
    expect(c.tw.updates[0].twiml).toContain("<Dial");
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(3);

    // Every timer the clock ever armed, fired as if already queued in the loop.
    for (const t of c.sch.timers) t.fn();
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
    expect(c.timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
  });

  it("8. a caller who hangs up at 5:00 leaves no clock callback behind", async () => {
    const { s, sch, tw, timeNotes } = await bootClock();
    await s.hangUp();
    expect(sch.timers.slice(0, 3).every((t) => t.cleared)).toBe(true);
    for (const t of sch.timers) t.fn();
    await s.settle();
    expect(tw.updates).toHaveLength(0);
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(0);
  });

  it("9. LIVE_CALL_HARD_END_SEC=600 is refused: the defaults stand and 570 s still ends the call", async () => {
    const { s, sch, tw } = await bootClock({ env: { LIVE_CALL_HARD_END_SEC: "600" } });
    expect(sch.timers.map((t) => t.ms)).toEqual([T.WRAP, T.GOODBYE, T.HARD]);
    await fire(s, sch, T.HARD);
    expect(tw.updates).toHaveLength(1);
  });

  it("10. (O1) an end_call armed at 9:29 is left alone at 9:30; the caller speaking releases the hard end", async () => {
    const c = await bookedCall();
    const { s, sch, tw, marks } = c;
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    await s.callTool("end_call", {});
    await s.assistantTurn("Thanks for calling. Goodbye.");
    expect(marks).toContain("live-exit-end_call");

    const cap = captureEvents("live_max_duration_deferred");
    try {
      await fire(s, sch, T.HARD);
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(0);
    expect(s.ws.readyState).toBe(1);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ callSid: "CA_test", kind: "end_call" });

    await s.callerSays("Actually, one more thing.");
    await s.settle();
    expect(tw.updates).toHaveLength(1);
    expect(tw.updates[0].twiml).toContain("reached the time limit");
    expect(s.ws.readyState).toBe(3);
  });

  it("11. (O1) a transfer still in flight at 9:30 gets no hard-end update", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const tw = fakeTwilioClient();
    const slow = {
      updates: tw.updates,
      calls: (sid) => ({
        update: async (params) => {
          tw.updates.push({ sid, twiml: params.twiml });
          await gate;
          return {};
        },
      }),
    };
    const c = await bootClock({ twilioClient: slow });
    await transferArmed(c);
    echo(c, "live-exit-transfer");
    await vi.waitFor(() => expect(tw.updates).toHaveLength(1));

    const cap = captureEvents("live_max_duration_deferred");
    try {
      await fire(c.s, c.sch, T.HARD);
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expect(cap.lines).toHaveLength(1);

    release();
    await c.s.settle();
    expect(tw.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("12. (S1/I3) an end_call the ask-gate refused AFTER the goodbye was delivered still ends the call", async () => {
    const c = await bookedCall();
    const { s, sch, tw, timeNotes } = c;
    await s.assistantTurn("You're all set for Friday at three thirty.");
    await s.assistantSays("Our office is closed on weekends");
    await fire(s, sch, T.GOODBYE);
    await s.turnEnds();
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(1);

    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(res.response.message).toMatch(/anything else/i);
    await s.assistantTurn("Is there anything else I can help with?");

    await fire(s, sch, T.HARD);
    // Either the armed exit (still waiting on its mark) was left alone and then
    // finished the call, or the hard end did: never two updates, always closed.
    echo(c, "live-exit-end_call");
    await vi.advanceTimersByTimeAsync(3000);
    await s.settle();
    expect(tw.updates.length).toBeLessThanOrEqual(1);
    expect(s.ws.readyState).toBe(3);
  });

  it("12b. a refused end_call with the goodbye never delivered: the hard end still ends the call", async () => {
    const { s, sch, tw } = await bookedCall();
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    await fire(s, sch, T.HARD);
    expect(tw.updates).toHaveLength(1);
    expect(tw.updates[0].twiml).toContain("<Hangup/>");
    expect(s.ws.readyState).toBe(3);
  });

  it("I1. a fast tool's continuation is not cut: the turn end that follows a tool call defers the wrap-up", async () => {
    const { s, sch, timeNotes } = await bootClock();
    await s.assistantSays("Our office opens at nine tomorrow");
    await fire(s, sch, T.WRAP);
    // The tool finishes and its response is sent BEFORE the model's turnComplete
    // arrives (3.8: ~17 ms after the call). Live is already generating the
    // continuation, so a note now would chop it.
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    const cap = captureEvents("live_time_note_deferred");
    try {
      await s.turnEnds();
    } finally {
      cap.restore();
    }
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
    expect(cap.lines[0]).toMatchObject({ kind: "wrap", reason: "tool_continuation" });

    // The continuation's own turn end is a real pause.
    await s.assistantTurn("That day is fully open.");
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
  });

  it("I1b. the latch is spent at every turn end: a tool call two turns ago defers nothing", async () => {
    const { s, sch, timeNotes } = await bootClock();
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.assistantTurn("That day is fully open.");
    await s.assistantTurn("Anything else I can do?");
    await fire(s, sch, T.WRAP);
    await s.turnEnds();
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(1);
  });

  it("I2. the wrap-up does not spend a 'question outranks a hang-up' hold", async () => {
    const c = await bookedCall();
    const { s, sch, marks, timeNotes } = c;
    await s.assistantSays(ASKED);
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(true);
    await fire(s, sch, T.WRAP);
    await s.turnEnds();
    // The hold is in force (the model just asked the caller a question): no
    // exit, and no wrap-up note to provoke a reply that could end without one.
    expect(marks).not.toContain("live-exit-end_call");
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
  });

  it("I2b. a forced wrap-up is dropped, with a reason, while a hang-up is armed-but-held", async () => {
    const c = await bookedCall();
    const { s, sch, timeNotes } = c;
    await s.assistantSays(ASKED);
    await s.callTool("end_call", {});
    await fire(s, sch, T.WRAP);
    const cap = captureEvents("live_time_note_skipped");
    try {
      sch.timers.filter((t) => t.ms === T.FORCE && !t.cleared).forEach((t) => t.fn());
    } finally {
      cap.restore();
    }
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
    expect(cap.lines[0]).toMatchObject({ kind: "wrap", reason: "end_call_armed" });
  });

  it("S2. the goodbye is skipped when the SILENCE LADDER already said its goodbye", async () => {
    const { s, sch, timeNotes } = await bootClock();
    const audio = Buffer.alloc(24000 * 0.4 * 2);
    for (let i = 0; i < audio.length / 2; i++) audio.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
    // The greeting reaching the caller arms the ladder; then 21 s of silence.
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio.toString("base64") } }] } } });
    await s.feed(21_000);
    expect(counters().silence_hangups).toBe(1);

    const cap = captureEvents("live_time_note_skipped");
    try {
      await fire(s, sch, T.GOODBYE);
    } finally {
      cap.restore();
    }
    expect(timeNotes(GOODBYE_NOTE)).toHaveLength(0);
    expect(cap.lines[0]).toMatchObject({ kind: "goodbye", reason: "exit_after_turn" });
  });

  it("M6. a goodbye skipped at set time takes the pending wrap-up and its force timer with it", async () => {
    const c = await bookedCall();
    const { s, sch, timeNotes } = c;
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    await s.assistantSays("Mid sentence");
    await s.callTool("end_call", {});
    await fire(s, sch, T.WRAP); // pending, with a force timer
    await s.turnEnds(); // the exit arms; the wrap stays pending behind it
    expect(sch.timers.filter((t) => t.ms === T.FORCE && !t.cleared)).toHaveLength(1);
    await fire(s, sch, T.GOODBYE); // skipped: an exit is queued
    expect(sch.timers.filter((t) => t.ms === T.FORCE && !t.cleared)).toHaveLength(0);
    await s.assistantTurn("Goodbye.");
    expect(timeNotes(WRAP_UP_NOTE)).toHaveLength(0);
  });

  it("M2. a redirect that never answers is abandoned after the bound, and the call still ends", async () => {
    const hung = {
      updates: [],
      calls: (sid) => ({
        update: (p) => {
          hung.updates.push({ sid, twiml: p.twiml });
          return new Promise(() => {});
        },
      }),
    };
    const { s, sch } = await bootClock({ twilioClient: hung });
    const cap = captureEvents("live_max_duration_redirect_failed");
    try {
      await fire(s, sch, T.HARD);
      expect(s.ws.readyState).toBe(1);
      const bound = sch.timers.filter((t) => t.ms === HARD_END_REDIRECT_TIMEOUT_MS && !t.cleared);
      expect(bound).toHaveLength(1);
      bound[0].fn();
      await s.settle();
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0].message).toMatch(/timed out/);
    expect(s.ws.readyState).toBe(3);
  });

  it("M3. a transfer cannot start while the hard end's redirect is in flight", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = {
      updates: [],
      calls: (sid) => ({
        update: async (p) => {
          slow.updates.push({ sid, twiml: p.twiml });
          await gate;
          return {};
        },
      }),
    };
    const c = await bootClock({ twilioClient: slow });
    await fire(c.s, c.sch, T.HARD);
    expect(slow.updates).toHaveLength(1);

    const cap = captureEvents("live_exit_refused_hard_end");
    try {
      await c.s.callTool("request_transfer", { reason: "billing" });
      await c.s.assistantTurn("Putting you through now.");
    } finally {
      cap.restore();
    }
    expect(c.marks).not.toContain("live-exit-transfer");
    expect(cap.lines.length).toBeGreaterThan(0);
    release();
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("M5. the clock also runs on an OUTBOUND call (hard end fires, account via twilioClientFor)", async () => {
    const BIZ = "biz-clock-out";
    const SID = "CAclockoutbound1";
    const CALLER_ID = "+441372656055";
    const OUT_CONFIG = {
      businessId: BIZ,
      businessName: "Digile Media",
      mainPhone: CALLER_ID,
      timezone: "Europe/London",
      businessHours: {},
      locale: null,
      liveVoice: null,
      allowedTasks: ["general_question"],
      capabilities: {},
    };
    const base = fakeDb(OUT_CONFIG, BIZ);
    const database = {
      ...base,
      withTenant: async (_id, fn) => fn(),
      outboundAttemptByCallSid: async (sid) =>
        sid === SID
          ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
          : null,
      outboundCallContext: async () => ({
        attemptNo: 1,
        openerAudio: null,
        toNumber: "+15559876543",
        outreachId: "out-1",
        campaignId: "camp-1",
        campaignVersion: 1,
        contactId: "contact-1",
        trigger: {},
        templateKey: "speed_to_lead",
        complianceClass: "solicited",
        audience: "business",
        config: { persona_name: "Ava", caller_id: CALLER_ID, capabilities: [] },
        firstName: "Priya",
        contactTimezone: "America/Chicago",
      }),
      fetchBusinessById: async () => ({
        id: BIZ,
        name: "Digile Media",
        timezone: "Europe/London",
        phone_number: CALLER_ID,
      }),
      fetchBusinessCapabilities: async () => [],
    };
    const outClient = fakeTwilioClient();
    const twilioClientFor = vi.fn(async () => outClient);
    const sch = fakeScheduler();
    const s = await bootLive({
      config: OUT_CONFIG,
      callSid: SID,
      customParameters: { direction: "outbound" },
      authorizedCallSid: SID,
      database,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClientFor,
    });
    expect(sch.timers.map((t) => t.ms)).toEqual([T.WRAP, T.GOODBYE, T.HARD]);
    await fire(s, sch, T.HARD);
    expect(twilioClientFor).toHaveBeenCalledWith(CALLER_ID);
    expect(outClient.updates).toHaveLength(1);
    expect(outClient.updates[0].twiml).toContain("<Hangup/>");
    expect(s.ws.readyState).toBe(3);
  });

  it("13. on an account-B call the hard-end update goes through account B's client", async () => {
    const clientB = fakeTwilioClient();
    const lookup = vi.fn(async (sid) => (sid === "ACbbbb" ? clientB : null));
    const sch = fakeScheduler();
    const s = await bootLive({
      config: WIRE_CONFIG,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClientForAccountSid: lookup,
      accountSid: "ACbbbb",
    });
    await fire(s, sch, T.HARD);
    expect(lookup).toHaveBeenCalledWith("ACbbbb");
    expect(clientB.updates).toHaveLength(1);
    expect(clientB.updates[0].twiml).toContain("<Hangup/>");
    expect(s.ws.readyState).toBe(3);
  });

  it("14. a failing redirect is logged and the socket closes anyway", async () => {
    const tw = fakeTwilioClient({ failWith: new Error("twilio down") });
    const { s, sch } = await bootClock({ twilioClient: tw });
    const cap = captureEvents("live_max_duration_redirect_failed");
    try {
      await fire(s, sch, T.HARD);
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ callSid: "CA_test", message: "twilio down" });
    expect(s.ws.readyState).toBe(3);
  });
});
