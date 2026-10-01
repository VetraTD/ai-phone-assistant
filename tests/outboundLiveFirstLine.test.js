import { describe, it, expect } from "vitest";
import { createLiveFirstLine, LIVE_FIRST_LINE_DEFAULTS } from "../lib/outbound/liveFirstLine.js";

// Pure controller tests (spec 2026-10-01 §2/§4/§5, plan Task 2). Fake clock:
// every method takes the session time explicitly; stream start is t=0.

function rig({ speakHelloReturns = true, ...overrides } = {}) {
  const calls = { hello: [], end: [], info: [], error: [], counters: [] };
  const ctl = createLiveFirstLine({
    streamStartAtMs: 0,
    speakHello: () => {
      calls.hello.push(true);
      return typeof speakHelloReturns === "function" ? speakHelloReturns() : speakHelloReturns;
    },
    endCall: (reason) => calls.end.push(reason),
    log: {
      info: (event, fields) => calls.info.push({ event, fields }),
      error: (event, fields) => calls.error.push({ event, fields }),
    },
    bumpCounter: (name) => calls.counters.push(name),
    logFields: { callSid: "CA1" },
    ...overrides,
  });
  return { ctl, calls };
}

/** Feed 20 ms caller frames on [from, to); `voiced(t)` says which are speech. Ticks every frame. */
function run(ctl, from, to, voiced = () => false) {
  for (let t = from; t < to; t += 20) {
    const v = voiced(t);
    ctl.onCallerFrame(t, v, v);
    ctl.tick(t);
  }
}

const events = (list, name) => list.filter((e) => e.event === name);

describe("liveFirstLine: defaults", () => {
  it("are the spec numbers", () => {
    expect(LIVE_FIRST_LINE_DEFAULTS).toMatchObject({
      silenceHelloMs: 3000,
      cueLeadMs: 800,
      unresponsiveMs: 6000,
      holdMaxMs: 120000,
      holdReleaseVoicedMs: 400,
    });
  });
});

describe("liveFirstLine: silence -> a live 'Hello?' heard at ~3 s", () => {
  it("cues the Hello once at 2,200 ms stream time (3,000 - 800 lead), never again", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 2180);
    expect(calls.hello).toHaveLength(0);
    run(ctl, 2180, 2220);
    expect(calls.hello).toHaveLength(1);
    run(ctl, 2220, 20000);
    expect(calls.hello).toHaveLength(1);
  });

  it("the first reply on that path is silence_hello", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 2300);
    ctl.onModelAudio(3000);
    expect(ctl.firstReply()).toMatchObject({ path: "silence_hello", from_speech_end_ms: null, from_answer_ms: 3350 });
    expect(events(calls.info, "outbound_first_reply")).toHaveLength(1);
  });
});

describe("liveFirstLine: speech before the cue (Review Focus 4)", () => {
  it("speech at 2,180 ms (before the 2,200 cue) cancels the Hello for good", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 3000, (t) => t >= 2180 && t < 2600);
    run(ctl, 3000, 30000);
    expect(calls.hello).toHaveLength(0);
  });

  it("one loud frame at pickup (voiced, never voiceActive -- O-6) does NOT cancel the Hello", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 1000);
    ctl.onCallerFrame(1000, true, false);
    ctl.tick(1000);
    run(ctl, 1020, 2300);
    expect(calls.hello).toHaveLength(1);
  });

  // Paid sim hold_transfer-1 (2026-10-01): a short "Reception?" -- 640 ms
  // voiced over 1,177 ms, gappy, so the VAD's 200 ms continuous rule
  // (voiceActive) never latched; the Hello cue went out over the reply.
  // Speech is also confirmed by COUNT: 11 voiced frames in 800 ms (the clip
  // path's own CLIP_CONFIRM_* rule).
  const gappy = (from, to) => (t) => t >= from && t < to && (t / 20) % 3 !== 2; // 40 ms on, 20 ms off

  it("gappy speech that never sets voiceActive (\"Reception?\") still cancels the Hello", () => {
    const { ctl, calls } = rig();
    for (let t = 0; t < 4000; t += 20) {
      ctl.onCallerFrame(t, gappy(1100, 2300)(t), false);
      ctl.tick(t);
    }
    expect(calls.hello).toHaveLength(0);
  });

  it("a few scattered loud frames (10 in 800 ms) still do NOT cancel it", () => {
    const { ctl, calls } = rig();
    for (let t = 0; t < 2400; t += 20) {
      ctl.onCallerFrame(t, t >= 1000 && t < 1800 && t % 80 === 0, false);
      ctl.tick(t);
    }
    expect(calls.hello).toHaveLength(1);
  });

  it("speech at 2,220 ms (cue already sent) sends no second cue; the next model turn is the reply", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 2220);
    expect(calls.hello).toHaveLength(1);
    run(ctl, 2220, 3000, (t) => t < 2700);
    ctl.onModelAudio(4300);
    run(ctl, 3000, 20000);
    expect(calls.hello).toHaveLength(1);
    expect(ctl.firstReply()).toMatchObject({ path: "silence_hello" });
  });
});

describe("liveFirstLine: Live never answers the cue", () => {
  it("speakHello() false (no session yet) retries, and ends the call live_unresponsive at cue + 6,000", () => {
    const { ctl, calls } = rig({ speakHelloReturns: false });
    run(ctl, 0, 8180);
    expect(calls.end).toEqual([]);
    expect(calls.hello.length).toBeGreaterThan(1); // retried each tick
    run(ctl, 8180, 8240);
    expect(calls.end).toEqual(["live_unresponsive"]);
    expect(events(calls.error, "outbound_live_unresponsive")).toHaveLength(1);
    run(ctl, 8240, 20000);
    expect(calls.end).toEqual(["live_unresponsive"]);
  });

  it("a late session that finally takes the cue stops the retries", () => {
    let open = false;
    const { ctl, calls } = rig({ speakHelloReturns: () => open });
    run(ctl, 0, 2600);
    open = true;
    run(ctl, 2600, 2700);
    const n = calls.hello.length;
    run(ctl, 2700, 6000);
    expect(calls.hello).toHaveLength(n);
  });

  it("cue sent but no model audio by cue + 6,000 -> live_unresponsive; audio at cue + 5,900 -> no end", () => {
    const a = rig();
    run(a.ctl, 0, 8300);
    expect(a.calls.end).toEqual(["live_unresponsive"]);
    const b = rig();
    run(b.ctl, 0, 8100);
    b.ctl.onModelAudio(8100);
    run(b.ctl, 8100, 30000);
    expect(b.calls.end).toEqual([]);
  });
});

describe("liveFirstLine: first-reply metric (spec §5)", () => {
  it("utterance ends at T, first model audio at T+1,600 -> from_speech_end_ms 1600, one info log, no slow log", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 2000, (t) => t >= 800 && t <= 1200); // last voiced frame at 1,200
    ctl.onModelAudio(2800);
    ctl.onModelAudio(2820);
    expect(ctl.firstReply()).toEqual({ path: "speech", from_speech_end_ms: 1600, from_answer_ms: 3150 });
    expect(events(calls.info, "outbound_first_reply")).toEqual([
      { event: "outbound_first_reply", fields: { callSid: "CA1", path: "speech", from_speech_end_ms: 1600, from_answer_ms: 3150 } },
    ]);
    expect(events(calls.error, "outbound_first_reply_slow")).toHaveLength(0);
  });

  it("at T+2,100 also logs outbound_first_reply_slow (warn)", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 2000, (t) => t >= 800 && t <= 1200);
    run(ctl, 2000, 3300);
    ctl.onModelAudio(3300);
    expect(ctl.firstReply().from_speech_end_ms).toBe(2100);
    expect(events(calls.error, "outbound_first_reply_slow")).toEqual([
      { event: "outbound_first_reply_slow", fields: expect.objectContaining({ from_speech_end_ms: 2100, severity: "warn" }) },
    ]);
  });

  it("a session that ends with no reply at all still logs one outbound_first_reply, path none", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 1500);
    ctl.onSessionEnd(1500);
    expect(events(calls.info, "outbound_first_reply")).toEqual([
      { event: "outbound_first_reply", fields: { callSid: "CA1", path: "none", from_speech_end_ms: null, from_answer_ms: null } },
    ]);
  });
});

describe("liveFirstLine: Live unresponsive after the person speaks", () => {
  it("utterance ends at T, no model audio by T+6,000 -> end + ERROR; audio at T+5,900 -> no end", () => {
    const a = rig();
    run(a.ctl, 0, 7180, (t) => t >= 800 && t <= 1200);
    expect(a.calls.end).toEqual([]);
    run(a.ctl, 7180, 7300);
    expect(a.calls.end).toEqual(["live_unresponsive"]);
    expect(events(a.calls.error, "outbound_live_unresponsive")).toHaveLength(1);

    const b = rig();
    run(b.ctl, 0, 7100, (t) => t >= 800 && t <= 1200);
    b.ctl.onModelAudio(7100);
    run(b.ctl, 7100, 30000);
    expect(b.calls.end).toEqual([]);
  });

  it("a second utterance re-arms the deadline (a cough, then 'Hello?' at 6 s)", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 7000, (t) => (t >= 800 && t <= 1100) || (t >= 6000 && t <= 6500));
    run(ctl, 7000, 12400);
    expect(calls.end).toEqual([]);
    run(ctl, 12400, 12600);
    expect(calls.end).toEqual(["live_unresponsive"]);
  });

  it("Live activity (a tool call) before any audio re-arms the deadline", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 5000, (t) => t >= 800 && t <= 1200);
    ctl.noteLiveActivity(5000);
    run(ctl, 5000, 10900);
    expect(calls.end).toEqual([]);
    run(ctl, 10900, 11100);
    expect(calls.end).toEqual(["live_unresponsive"]);
  });

  it("no deadline while the person is still talking", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 12000, (t) => t >= 800);
    expect(calls.end).toEqual([]);
  });
});

describe("liveFirstLine: hold (spec §4, Review Focus 2)", () => {
  function onHoldRig(overrides = {}) {
    const r = rig(overrides);
    run(r.ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    r.ctl.onModelAudio(2500); // first reply
    r.ctl.onTurnComplete(3000);
    r.ctl.enterHold(3000);
    return r;
  }

  it("enterHold -> onHold() true, forwardModelAudio() false", () => {
    const { ctl } = onHoldRig();
    expect(ctl.onHold()).toBe(true);
    expect(ctl.forwardModelAudio()).toBe(false);
    expect(ctl.onModelAudio(3500)).toBe(false);
  });

  it("'hello?' with 500 ms voiced -> released", () => {
    const { ctl, calls } = onHoldRig();
    run(ctl, 3000, 10000, (t) => t >= 9000 && t < 9500);
    ctl.onCallerTranscript("hello?", 9600);
    expect(ctl.onHold()).toBe(false);
    expect(ctl.forwardModelAudio()).toBe(true);
    expect(events(calls.info, "outbound_hold_released")).toHaveLength(1);
  });

  it("'la la love you' with 300 ms voiced -> still on hold", () => {
    const { ctl } = onHoldRig();
    run(ctl, 3000, 10000, (t) => t >= 9000 && t < 9300);
    ctl.onCallerTranscript("la la love you", 9400);
    expect(ctl.onHold()).toBe(true);
    expect(ctl.forwardModelAudio()).toBe(false);
  });

  it("gappy speech (voiceActive never latched) with 600 ms voiced still releases -- a person must never be held to the 120 s cap", () => {
    const { ctl } = onHoldRig();
    for (let t = 3000; t < 10000; t += 20) {
      const v = t >= 9000 && t < 9900 && (t / 20) % 3 !== 2;
      ctl.onCallerFrame(t, v, false);
      ctl.tick(t);
    }
    ctl.onCallerTranscript("Hi, this is Sam.", 10000);
    expect(ctl.onHold()).toBe(false);
  });

  it("words without letters ('...', '♪') never release, however long the audio", () => {
    const { ctl } = onHoldRig();
    run(ctl, 3000, 10000, (t) => t >= 5000 && t < 9000);
    ctl.onCallerTranscript(" ... ", 9100);
    ctl.onCallerTranscript("♪♪", 9200);
    expect(ctl.onHold()).toBe(true);
  });

  it("words that arrive before the voiced audio is long enough release once it is (same utterance)", () => {
    const { ctl } = onHoldRig();
    run(ctl, 3000, 9200, (t) => t >= 9000);
    ctl.onCallerTranscript("hi it's", 9200);
    expect(ctl.onHold()).toBe(true);
    run(ctl, 9200, 9600, () => true);
    expect(ctl.onHold()).toBe(false);
  });

  it("no release by +120,000 ms -> endCall(hold_timeout), once", () => {
    const { ctl, calls } = onHoldRig();
    run(ctl, 3000, 122980);
    expect(calls.end).toEqual([]);
    run(ctl, 122980, 123100);
    expect(calls.end).toEqual(["hold_timeout"]);
    run(ctl, 123100, 130000);
    expect(calls.end).toEqual(["hold_timeout"]);
  });

  it("a generation that started muted stays unheard when it ends on hold; one released mid-generation is heard", () => {
    const a = onHoldRig();
    a.ctl.onModelAudio(4000);
    expect(a.ctl.droppedThisGeneration()).toBe(true);
    expect(a.ctl.onTurnComplete(4500)).toMatchObject({ heard: false });
    expect(a.ctl.droppedThisGeneration()).toBe(false);

    // Live answered the new person before its transcript reached us: the
    // muted start is not lost -- onRelease tells the engine to flush it.
    const released = [];
    const b = onHoldRig({ onRelease: (fields) => released.push(fields) });
    run(b.ctl, 3000, 9500, (t) => t >= 9000);
    expect(b.ctl.onModelAudio(9500)).toBe(false);
    expect(b.ctl.droppedThisGeneration()).toBe(true);
    b.ctl.onCallerTranscript("hello?", 9550);
    expect(b.ctl.onHold()).toBe(false);
    expect(released).toEqual([{ midGeneration: true }]);
    expect(b.ctl.droppedThisGeneration()).toBe(false);
    expect(b.ctl.onModelAudio(9600)).toBe(true);
    expect(b.ctl.onTurnComplete(10500)).toMatchObject({ heard: true });
  });
});

describe("liveFirstLine: the first answer turn (disclosure check target, ruling R4)", () => {
  it("speech path: the first heard generation is the first answer, exactly once", () => {
    const { ctl } = rig();
    run(ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    ctl.onModelAudio(2500);
    expect(ctl.onTurnComplete(3000)).toEqual({ heard: true, firstAnswer: true });
    ctl.onModelAudio(5000);
    expect(ctl.onTurnComplete(6000)).toEqual({ heard: true, firstAnswer: false });
  });

  it("silence path: the 'Hello?' cue generation is skipped; the reply after it is the first answer", () => {
    const { ctl } = rig();
    run(ctl, 0, 2300);
    ctl.onModelAudio(2900);
    expect(ctl.onTurnComplete(3300)).toEqual({ heard: true, firstAnswer: false });
    run(ctl, 3300, 5000, (t) => t >= 3600 && t <= 4000);
    ctl.onModelAudio(5600);
    expect(ctl.onTurnComplete(6500)).toEqual({ heard: true, firstAnswer: true });
  });

  it("an interrupted first reply is offered (judged on what was said) but not consumed: the next completed turn is offered too", () => {
    const { ctl } = rig();
    run(ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    ctl.onModelAudio(2500);
    expect(ctl.onInterrupted(2700)).toEqual({ heard: true, firstAnswer: true });
    ctl.onModelAudio(4000);
    expect(ctl.onTurnComplete(5000)).toEqual({ heard: true, firstAnswer: true });
    ctl.onModelAudio(6000);
    expect(ctl.onTurnComplete(7000)).toEqual({ heard: true, firstAnswer: false });
  });
});

describe("liveFirstLine: silent verdict (ruling R8, spec §1 end-of-speech reading)", () => {
  it("speech, reply 1,600 ms after its end -> not silent; 2,100 ms -> silent", () => {
    const a = rig();
    run(a.ctl, 0, 2000, (t) => t >= 800 && t <= 1200);
    a.ctl.onModelAudio(2800);
    expect(a.ctl.sessionSilent(20000)).toBe(false);
    const b = rig();
    run(b.ctl, 0, 2000, (t) => t >= 800 && t <= 1200);
    b.ctl.onModelAudio(3300);
    expect(b.ctl.sessionSilent(20000)).toBe(true);
  });

  it("silent pickup that hears the Hello at ~3 s -> not silent; Hello later than 3.5 s -> silent", () => {
    const a = rig();
    run(a.ctl, 0, 3000);
    a.ctl.onModelAudio(3000);
    expect(a.ctl.sessionSilent(20000)).toBe(false);
    const b = rig();
    run(b.ctl, 0, 3600);
    b.ctl.onModelAudio(3600);
    expect(b.ctl.sessionSilent(20000)).toBe(true);
  });

  it("no AI audio ever: spoke and waited > 2 s -> silent; hung up silent before 3.5 s -> not silent; silent past 3.5 s -> silent", () => {
    const a = rig();
    run(a.ctl, 0, 3500, (t) => t >= 500 && t <= 900);
    expect(a.ctl.sessionSilent(3500)).toBe(true);
    const b = rig();
    run(b.ctl, 0, 2500);
    expect(b.ctl.sessionSilent(2500)).toBe(false);
    const c = rig();
    run(c.ctl, 0, 4000);
    expect(c.ctl.sessionSilent(4000)).toBe(true);
  });
});

describe("liveFirstLine: after the end", () => {
  it("onSessionEnd stops every timer (no Hello, no end)", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 1000);
    ctl.onSessionEnd(1000);
    run(ctl, 1000, 200000);
    expect(calls.hello).toEqual([]);
    expect(calls.end).toEqual([]);
  });
});
