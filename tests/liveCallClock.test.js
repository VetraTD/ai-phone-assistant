// The per-call clock (pure module) and the harness seams Task B/C will lean on.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_WRAP_UP_SEC,
  DEFAULT_GOODBYE_SEC,
  DEFAULT_HARD_END_SEC,
  GOOGLE_LIMIT_SEC,
  WRAP_UP_NOTE,
  GOODBYE_NOTE,
  NOTE_FORCE_AFTER_MS,
  resolveClockConfig,
  createCallClock,
} from "../lib/voice/live/callClock.js";
import { bootLive, counters, fakeLive, fakeTwilioClient } from "./helpers/liveBoot.js";
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
