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
    // Final review #4: the person spoke before any AI audio, so this IS the
    // reply to them (path speech), not the Hello.
    expect(ctl.firstReply()).toMatchObject({ path: "speech" });
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
    // generation that opens after their speech IS the release (Gatekeeper
    // call 2026-10-01: transcript lag p50 9,397 ms -- waiting for words could
    // leave a returning person in silence for seconds). Heard from its start.
    const released = [];
    const b = onHoldRig({ onRelease: (fields) => released.push(fields) });
    run(b.ctl, 3000, 9500, (t) => t >= 9000);
    expect(b.ctl.onModelAudio(9500)).toBe(true);
    expect(b.ctl.onHold()).toBe(false);
    expect(released).toEqual([{ midGeneration: true, droppedOnHold: 0 }]);
    expect(b.ctl.droppedThisGeneration()).toBe(false);
    b.ctl.onCallerTranscript("hello?", 9550); // the late transcript changes nothing
    expect(released).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Final review fix pass (2026-10-01).
// ---------------------------------------------------------------------------
describe("review #1: the speech end is dated from confirmed speech, never a stray loud frame", () => {
  it("a click at 100 ms, then the Hello heard at 3.0 s: not silent, no slow log, path silence_hello", () => {
    const { ctl, calls } = rig();
    ctl.onCallerFrame(100, true, false);
    ctl.tick(100);
    run(ctl, 120, 3000);
    ctl.onModelAudio(3000);
    expect(ctl.firstReply()).toMatchObject({ path: "silence_hello", from_speech_end_ms: null });
    expect(ctl.sessionSilent(20000)).toBe(false);
    expect(events(calls.error, "outbound_first_reply_slow")).toEqual([]);
  });

  it("stray noise after real speech does not push the end later (a 2.1 s reply still reads slow)", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 1220, (t) => t >= 800 && t <= 1200);
    ctl.onCallerFrame(2000, true, false); // one stray loud frame later
    run(ctl, 2020, 3300);
    ctl.onModelAudio(3300);
    expect(ctl.firstReply().from_speech_end_ms).toBe(2100);
    expect(events(calls.error, "outbound_first_reply_slow")).toHaveLength(1);
  });
});

describe("review #4: speech at 2.9 s, after the cue was sent but before its audio -> exactly one AI turn", () => {
  it("the cue's own generation (opened before the speech) is muted and unheard; the reply after it is the first answer, path speech", () => {
    const { ctl } = rig();
    run(ctl, 0, 2600);
    ctl.noteAssistantText(2600); // the Hello generation opens (text first)
    run(ctl, 2600, 3300, (t) => t >= 2900 && t < 3300); // the person speaks at 2.9 s
    expect(ctl.onModelAudio(3350)).toBe(false); // the Hello's audio never plays
    expect(ctl.onTurnComplete(3500)).toEqual({ heard: false, firstAnswer: false });
    expect(ctl.onModelAudio(4800)).toBe(true); // the reply plays
    expect(ctl.firstReply()).toMatchObject({ path: "speech" });
    expect(ctl.onTurnComplete(5500)).toEqual({ heard: true, firstAnswer: true });
  });

  it("speech after the cue when no generation had opened yet: the next generation is the reply, not the cue's", () => {
    const { ctl } = rig();
    run(ctl, 0, 2300);
    run(ctl, 2300, 3300, (t) => t >= 2900 && t < 3300);
    expect(ctl.onModelAudio(4500)).toBe(true);
    expect(ctl.onTurnComplete(5000)).toEqual({ heard: true, firstAnswer: true });
  });
});

describe("review #5: a hold releases only on a person after the hold began, never on music", () => {
  function onHoldRig(overrides = {}) {
    const r = rig(overrides);
    run(r.ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    r.ctl.onModelAudio(2500);
    r.ctl.onTurnComplete(3000);
    r.ctl.enterHold(3000);
    return r;
  }

  it("a late transcript of speech from BEFORE the hold does not count as words", () => {
    const { ctl } = onHoldRig();
    ctl.onCallerTranscript("Hold on, I'll get him.", 3100); // pre-hold speech, transcribed late
    run(ctl, 3100, 9600, (t) => t >= 9000 && t < 9500); // a short noise/word with no transcript of its own
    expect(ctl.onHold()).toBe(true);
  });

  it("an utterance continuously voiced for more than 8 s is music: its lyrics never release the hold", () => {
    const { ctl } = onHoldRig();
    run(ctl, 3000, 15000, (t) => t >= 4000); // 11 s of continuous 'voiced' hold music
    ctl.onCallerTranscript("la la love you", 15000);
    expect(ctl.onHold()).toBe(true);
  });

  it("after the music stops, a person's short worded utterance releases it", () => {
    const { ctl } = onHoldRig();
    run(ctl, 3000, 15000, (t) => t >= 4000 && t < 13000); // music 4-13 s
    run(ctl, 15000, 16000, (t) => t < 15600); // "Hi, this is Sam" 600 ms
    ctl.onCallerTranscript("Hi, this is Sam.", 16000);
    expect(ctl.onHold()).toBe(false);
  });

  it("a muted generation that opened BEFORE the person spoke is not flushed on release (it was talking to the music)", () => {
    const released = [];
    const { ctl } = onHoldRig({ onRelease: (f) => released.push(f) });
    run(ctl, 3000, 8000);
    ctl.noteAssistantText(8000); // Live chatting on hold
    expect(ctl.onModelAudio(8100)).toBe(false);
    run(ctl, 8100, 9600, (t) => t >= 9000 && t < 9500);
    ctl.onCallerTranscript("Hello?", 9600);
    expect(ctl.onHold()).toBe(false);
    expect(released).toEqual([expect.objectContaining({ midGeneration: false })]);
    expect(ctl.onModelAudio(9700)).toBe(false); // the stale generation stays muted to its end
    expect(ctl.onTurnComplete(9800)).toMatchObject({ heard: false });
    expect(ctl.onModelAudio(10500)).toBe(true); // the next one is the reply to the person
  });
});

// Gatekeeper call 2026-10-01: input_transcript_lag_ms_p50 9,397 ms (Hello 255
// ms). A hold that waits for a WORDED transcript can leave the person who comes
// back in silence for seconds. Live answering = a person spoke: a muted
// generation that OPENS after a confirmed speech onset since the hold began
// releases the hold -- with the same music guards as the transcript path
// (utterance <= 8 s and >= 400 ms voiced; nothing from before the hold).
describe("hold release when Live answers a person (no transcript needed)", () => {
  function onHoldRig(overrides = {}) {
    const released = [];
    const r = rig({ onRelease: (f) => released.push(f), ...overrides });
    run(r.ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    r.ctl.onModelAudio(2500);
    r.ctl.onTurnComplete(3000);
    r.ctl.enterHold(3000);
    return { ...r, released };
  }

  it("600 ms of speech after the hold, then Live opens a generation -> released at the open, heard, one release", () => {
    const { ctl, calls, released } = onHoldRig();
    run(ctl, 3000, 9700, (t) => t >= 9000 && t < 9600);
    expect(ctl.onHold()).toBe(true); // no words yet: still holding
    expect(ctl.onModelAudio(9700)).toBe(true);
    expect(ctl.onHold()).toBe(false);
    expect(released).toEqual([{ midGeneration: true, droppedOnHold: 0 }]);
    expect(events(calls.info, "outbound_hold_released")).toHaveLength(1);
  });

  it("a text-first generation (output transcript before audio) releases the same way", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 9700, (t) => t >= 9000 && t < 9600);
    ctl.noteAssistantText(9700);
    expect(ctl.onHold()).toBe(false);
    expect(released).toEqual([{ midGeneration: true, droppedOnHold: 0 }]);
    expect(ctl.onModelAudio(9750)).toBe(true);
  });

  it("no speech since the hold began (only the pre-hold 'hold on') -> a generation stays muted", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 8000);
    expect(ctl.onModelAudio(8000)).toBe(false);
    expect(ctl.onHold()).toBe(true);
    expect(released).toEqual([]);
  });

  it("9 s of continuous 'voiced' hold music, then Live talks -> muted (music guard)", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 13500, (t) => t >= 4000);
    expect(ctl.onModelAudio(13500)).toBe(false);
    expect(ctl.onHold()).toBe(true);
    expect(released).toEqual([]);
  });

  it("a 300 ms blip (under the 400 ms voiced floor), then Live talks -> muted", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 9500, (t) => t >= 9000 && t < 9300);
    expect(ctl.onModelAudio(9500)).toBe(false);
    expect(ctl.onHold()).toBe(true);
    expect(released).toEqual([]);
  });

  // Final review #1 (Critical): Live talking to hold MUSIC is why the mute
  // exists. Music with short breaks makes each phrase a fresh onset under 8 s,
  // and a "hold please" said after the hold began stays the last utterance
  // through continuous music. The open-release needs the MOST RECENT
  // utterance to be releasable AND to have started after >= 1 s of quiet (a
  // person after the music stopped). Anything else waits for words (the
  // transcript path, today's behaviour).
  it("gappy hold music (2 s phrases, 400 ms breaks), then Live talks -> muted", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 12000, (t) => t >= 4000 && (t - 4000) % 2400 < 2000);
    expect(ctl.onModelAudio(12000)).toBe(false);
    expect(ctl.onHold()).toBe(true);
    expect(released).toEqual([]);
  });

  it("'hold please' after the hold began, then continuous music, Live talks during the music -> muted", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 15000, (t) => (t >= 3500 && t < 4500) || t >= 5500);
    expect(ctl.onModelAudio(15000)).toBe(false);
    expect(ctl.onHold()).toBe(true);
    expect(released).toEqual([]);
  });

  it("music, then 1.5 s of quiet, then a person (600 ms), Live answers -> released", () => {
    const { ctl, released } = onHoldRig();
    run(ctl, 3000, 16200, (t) => (t >= 4000 && t < 13000) || (t >= 14500 && t < 15100));
    expect(ctl.onModelAudio(16200)).toBe(true);
    expect(released).toEqual([{ midGeneration: true, droppedOnHold: 0 }]);
  });

  it("speech still going on when the hold engaged (onset before the hold) -> a generation stays muted", () => {
    const r = rig();
    run(r.ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    r.ctl.onModelAudio(2500);
    r.ctl.onTurnComplete(3000);
    run(r.ctl, 3000, 3200, () => true); // "...I'll get him" -- onset before the hold
    r.ctl.enterHold(3200);
    run(r.ctl, 3200, 3700, () => true); // the same utterance runs on
    expect(r.ctl.onModelAudio(3700)).toBe(false);
    expect(r.ctl.onHold()).toBe(true);
  });
});

describe("review #6: release re-arms the first-answer check and reports dropped hold talk", () => {
  it("the first heard turn after the release is offered as a first answer again; droppedOnHold counts the muted generations", () => {
    const released = [];
    const r = rig({ onRelease: (f) => released.push(f) });
    run(r.ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    r.ctl.onModelAudio(2500);
    expect(r.ctl.onTurnComplete(3000)).toMatchObject({ firstAnswer: true });
    r.ctl.enterHold(3000);
    r.ctl.onModelAudio(4000); // muted, then dropped
    r.ctl.onTurnComplete(4500);
    run(r.ctl, 4500, 9600, (t) => t >= 9000 && t < 9500);
    r.ctl.onCallerTranscript("Hello?", 9600);
    expect(released).toEqual([{ midGeneration: false, droppedOnHold: 1 }]);
    r.ctl.onModelAudio(10000);
    expect(r.ctl.onTurnComplete(11000)).toEqual({ heard: true, firstAnswer: true });
  });
});

describe("review minor (re-graded): no unresponsive end while on hold", () => {
  it("wait_on_hold before any AI audio, then silence: no live_unresponsive", () => {
    const { ctl, calls } = rig();
    run(ctl, 0, 1500, (t) => t >= 500 && t <= 900);
    ctl.enterHold(1500);
    run(ctl, 1500, 30000);
    expect(calls.end).toEqual([]);
  });
});

// Final review #4/#5: the AMD door's "real exchange" read used transcript rows,
// which land only at a turn's close and only with the caller's TEXT (transcript
// lag reached 9.4 s p50 on 2026-10-01), and clip mode seeds an AI row before any
// caller row. The exchange is now measured on AUDIO, here: a completed AI turn
// that was heard, then the person's confirmed speech after it. Reported once.
describe("onExchange: the AI's turn was heard and the person answered it (audio, not transcripts)", () => {
  function exRig() {
    const exchanges = [];
    const r = rig({ onExchange: (atMs) => exchanges.push(atMs) });
    return { ...r, exchanges };
  }

  it("person speaks, the AI's reply plays and completes, the person answers -> one exchange", () => {
    const { ctl, exchanges } = exRig();
    run(ctl, 0, 2000, (t) => t >= 500 && t <= 900); // "Reception?"
    ctl.onModelAudio(2500);
    ctl.onTurnComplete(3000);
    expect(exchanges).toEqual([]);
    run(ctl, 3000, 4500, (t) => t >= 3500 && t < 4100); // "Let me check, one sec."
    expect(exchanges).toHaveLength(1);
    run(ctl, 4500, 8000, (t) => t >= 6000 && t < 6600);
    expect(exchanges).toHaveLength(1);
  });

  it("the silence 'Hello?' completes and the person answers -> an exchange (the cue is a heard AI turn)", () => {
    const { ctl, exchanges } = exRig();
    run(ctl, 0, 2300);
    ctl.onModelAudio(2900);
    ctl.onTurnComplete(3300);
    run(ctl, 3300, 5000, (t) => t >= 3600 && t < 4000);
    expect(exchanges).toHaveLength(1);
  });

  it("an AI turn that was INTERRUPTED (a greeting talking over it) does not count; speech before any completed turn does not count", () => {
    const { ctl, exchanges } = exRig();
    run(ctl, 0, 2000, (t) => t >= 500 && t <= 1500); // a voicemail greeting
    ctl.onModelAudio(2500);
    ctl.onInterrupted(2700); // the greeting resumes over the AI
    run(ctl, 2700, 6000, (t) => t >= 2700 && t < 5500); // "...leave a message after the tone"
    expect(exchanges).toEqual([]);
  });

  it("a muted (on-hold) turn is not a heard turn", () => {
    const { ctl, exchanges } = exRig();
    run(ctl, 0, 2000, (t) => t >= 500 && t <= 900);
    ctl.enterHold(2000);
    ctl.onModelAudio(2500);
    ctl.onTurnComplete(3000);
    run(ctl, 3000, 4000, (t) => t >= 3200 && t < 3300); // a blip
    expect(exchanges).toEqual([]);
  });
});
