import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootLive, fakeTwilioClient } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX174 through the real Live front-end: every fixed line a Live call can end
// on plays its recorded clip when one is ready, and is said in Polly exactly as
// before when it is not. Each call prepares its clips at pickup, in the call's
// own language and voice.
// ---------------------------------------------------------------------------

const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  timezone: "Europe/London",
  locale: "en-GB",
  liveVoice: "Kore",
  businessHours: {},
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};
const ENV = { BASE_URL: "https://voice.example.test" };
const HARD_MS = 570_000;

function fakeScheduler() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, unref: vi.fn() };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
    fireAt(ms) {
      for (const t of timers) if (t.ms === ms && !t.cleared) t.fn();
    },
  };
}

const urlOf = (key, v) => `https://voice.example.test/media/line/${key}-${v.liveVoice}-${v.languageCode}.wav`;
function fakeFixedLines({ ready = true } = {}) {
  return {
    prepare: vi.fn(async () => {}),
    urlFor: vi.fn((key, v) => (ready ? urlOf(key, v) : null)),
  };
}

async function boot(opts = {}) {
  const sch = fakeScheduler();
  const tw = fakeTwilioClient();
  const s = await bootLive({ config: CONFIG, env: ENV, setTimer: sch.setTimer, clearTimer: sch.clearTimer, twilioClient: tw, ...opts });
  return { s, sch, tw };
}

describe("LVX174: fixed lines in the receptionist's voice", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    clearStats();
  });
  afterEach(() => vi.useRealTimers());

  it("prepares this call's clips at pickup, in its own language and voice", async () => {
    const fixedLines = fakeFixedLines();
    await boot({ fixedLines });
    expect(fixedLines.prepare).toHaveBeenCalledWith({ languageCode: "en-GB", liveVoice: "Kore" });
  });

  it("the AI could not start: the technical line plays as a clip, then the message is recorded", async () => {
    const fixedLines = fakeFixedLines();
    const c = await boot({ fixedLines, connectError: new Error("no AI today") });
    await c.s.settle();
    const twiml = c.tw.updates[0].twiml;
    expect(twiml).toContain(`<Play>${urlOf("technical", { liveVoice: "Kore", languageCode: "en-GB" })}</Play>`);
    expect(twiml).toContain("<Record");
    expect(twiml).not.toContain("<Say");
  });

  it("the 10-minute end plays the time-up clip", async () => {
    const fixedLines = fakeFixedLines();
    const c = await boot({ fixedLines });
    c.sch.fireAt(HARD_MS);
    await c.s.settle();
    expect(c.tw.updates[0].twiml).toContain(`<Play>${urlOf("timeUp", { liveVoice: "Kore", languageCode: "en-GB" })}</Play><Hangup/>`);
  });

  it("no clip ready: Polly says the line exactly as before", async () => {
    const c = await boot({ fixedLines: fakeFixedLines({ ready: false }), connectError: new Error("no AI today") });
    await c.s.settle();
    expect(c.tw.updates[0].twiml).toContain("<Say");
    expect(c.tw.updates[0].twiml).toContain("technical problem");
    expect(c.tw.updates[0].twiml).not.toContain("<Play>");
  });
});
