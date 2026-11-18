// ---------------------------------------------------------------------------
// LVX131. THE CALL THAT NEVER ENDED.
//
// CAdfeb9d, 2026-09-17, on d57c31f. The Twilio media websocket died mid
// sentence and sent nothing to say so: no `stop`, no `close`, no `error`. So
// finish() never ran, and with it no live_call_summary, no postcall_verify and
// no escalation -- on a call that had a REFUSED booking attempt on it and a
// caller who was told nothing about it.
//
// The engine could not have noticed. Every timer in it is driven by incoming
// media frames: the silence ladder is checkSilence(), called once per frame,
// and the turn-end strategies are the same by design. The only real timers are
// the exit backstop and the hang-up grace, and both are armed AFTER an exit has
// already been requested. When the frames stop, the session freezes in place.
//
// WHAT THIS FILE NEEDED THAT DID NOT EXIST. tests/helpers/liveBoot.js injected
// `now: () => 0` and delivered no media frames at all, so no test built on it
// could stop delivering them. It now carries a mutable clock, feed() and
// starve() -- and starve() is the whole case: time passes, no frame arrives,
// nothing else happens.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

/** The default in lib/voice/live/index.js. Stated here so a default flip fails a test. */
const THRESHOLD_MS = 15_000;

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  clearStats();
});

// ---------------------------------------------------------------------------
// The summary is the POINT of this item, not a side effect of it. "The socket
// closed" is not the thing CAdfeb9d lacked -- it lacked the post-call net that
// hangs off finish(). So this file reads the real stdout line rather than
// inferring it, for the reason tests/liveSession.test.js records: a block that
// spied on console.log collected nothing and passed anyway for the life of the
// file, because lib/logger.js writes to process.stdout directly.
// ---------------------------------------------------------------------------
async function summariesDuring(run) {
  const chunks = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string" && chunk.includes('"event":"live_call_summary"')) chunks.push(chunk);
    return true;
  });
  let out;
  try {
    out = await run();
  } finally {
    spy.mockRestore();
  }
  const summaries = chunks
    .flatMap((c) => c.split("\n"))
    .filter((l) => l.includes('"event":"live_call_summary"'))
    .map((l) => JSON.parse(l));
  return { out, summaries };
}

describe("a severed media stream tears the call down", () => {
  it("arms the watchdog on the start frame, before anything is awaited", async () => {
    await bootLive({ config: CONFIG, callSid: "CA_wd_arm" });
    // The positive twin. Without it, live_media_timeout reading zero means
    // either "no call ever froze" or "this was never wired", and the second is
    // a state this repository has shipped in before.
    expect(counters().live_media_watchdog_armed).toBe(1);
    expect(counters().live_media_timeout).toBe(0);
  });

  it("closes the call and emits the summary when the frames stop", async () => {
    const { out: s, summaries } = await summariesDuring(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wd_dead" });
      await s.feed(1_000);
      expect(s.ws.readyState).toBe(1);
      // The socket is NOT closed and Twilio sends no stop. From the engine's
      // side, exactly nothing happens -- CAdfeb9d's state.
      await s.starve(THRESHOLD_MS + 1_000);
      return s;
    });

    expect(counters().live_media_timeout).toBe(1);
    expect(s.ws.readyState).toBe(3);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].close_reason).toBe("media_timeout");
  });

  it("leaves a call alone while frames are still arriving", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_wd_alive" });
    // Well past the threshold, but a frame every 20 ms the whole way -- which
    // is what a silent caller on a healthy line looks like. The silence ladder
    // owns that case and hangs up at 24 s; this must not pre-empt it.
    await s.feed(THRESHOLD_MS + 5_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(counters().live_media_timeout).toBe(0);
    expect(s.ws.readyState).toBe(1);
  });

  it("does not fire on a gap shorter than the threshold", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_wd_short" });
    await s.feed(1_000);
    await s.starve(THRESHOLD_MS - 2_000);
    expect(counters().live_media_timeout).toBe(0);
    expect(s.ws.readyState).toBe(1);
    // And it recovers: a late frame resets the gap rather than leaving the
    // session on a hair trigger for the rest of the call.
    await s.feed(200);
    await s.starve(THRESHOLD_MS - 2_000);
    expect(counters().live_media_timeout).toBe(0);
  });

  it("tears down exactly once however long the silence lasts", async () => {
    const { summaries } = await summariesDuring(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wd_once" });
      await s.feed(1_000);
      await s.starve(THRESHOLD_MS + 1_000);
      // Ten more ticks with the call already closed. finish()'s own `closed`
      // latch is what makes this a no-op, and a second summary would mean the
      // post-call net had run twice on one call.
      await s.starve(10_000);
      return s;
    });
    expect(counters().live_media_timeout).toBe(1);
    expect(summaries).toHaveLength(1);
  });

  it("reports the largest frame gap on a call that ended normally", async () => {
    const { summaries } = await summariesDuring(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wd_gap" });
      await s.feed(400);
      await s.starve(4_000); // a real gap, well inside the threshold
      await s.feed(400);
      await s.hangUp();
      return s;
    });
    expect(summaries).toHaveLength(1);
    // THE NUMBER THAT MAKES THE THRESHOLD A MEASUREMENT. 15,000 is a judgement
    // until the gap distribution on healthy calls is readable, and it is only
    // readable if it is reported on calls that did NOT time out.
    expect(summaries[0].media_gap_max_ms).toBeGreaterThanOrEqual(4_000);
    expect(summaries[0].media_timeout_ms).toBe(THRESHOLD_MS);
    expect(summaries[0].close_reason).toBe("twilio_stop");
  });

  it("honours LIVE_MEDIA_TIMEOUT_MS", async () => {
    const s = await bootLive({
      config: CONFIG,
      callSid: "CA_wd_env",
      env: { LIVE_MEDIA_TIMEOUT_MS: "5000" },
    });
    await s.feed(1_000);
    await s.starve(6_000);
    expect(counters().live_media_timeout).toBe(1);
    expect(s.ws.readyState).toBe(3);
  });
});
