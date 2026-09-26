// tests/outboundHarnessVerdict.test.js
/**
 * Task 15 (session 2b): the pure half of the harness's --outbound mode,
 * lib/probe/outboundHarness.js. The CLI owns the socket, the timers and the
 * database; everything it DECIDES is here, so it can be tested without a call:
 *
 *   - the local-database guard (seeding must never reach a non-local database);
 *   - the dispatch line rendering, proven equal to what the REAL dispatcher
 *     hands renderAudio (lib/outbound/dispatch.js), so the harness renders the
 *     clip exactly as dispatch would;
 *   - the paced mark echo;
 *   - the client-side clock (onset, first frame, first-audio mark);
 *   - the server-log parser (UTF-8 or PowerShell's UTF-16);
 *   - the ONE verdict, per criterion -- and that it can FAIL;
 *   - spend: priced from usage, or the full reserve when it cannot be priced;
 *   - the render tap: word_ratio, overlap, render time, and whether
 *     usageMetadata arrived before turnComplete.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

import {
  assertLocalDatabase,
  isLoopbackBase,
  dispatchLines,
  createPlayoutClock,
  createClientObserver,
  decodeLogBuffer,
  parseServerLog,
  isIntroduction,
  outboundVerdict,
  priceHarnessRun,
  createSpendGuard,
  createRenderTap,
  summarizeRenderSessions,
  pickHarnessNumbers,
  harnessCallSid,
  HARNESS_RESERVE_USD,
  detectLeadIn,
  scheduleCallerClip,
  LEAD_IN_RMS_THRESHOLD,
  framesDue,
  startMediaTicker,
  MEDIA_TICKER_MAX_BURST,
  markMediaTickerEnd,
  pacingCheck,
  PACING_MIN_RATIO,
} from "../lib/probe/outboundHarness.js";
import { createDispatcher } from "../lib/outbound/dispatch.js";
import { renderLines } from "../lib/outbound/liveRender.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { FIRST_AUDIO_MARK, BACKSTOP_END_MARK } from "../lib/outbound/firstSeconds.js";
import { priceTokens } from "../scripts/probes/lib/spendLive.js";

// ---------------------------------------------------------------------------
describe("the local-database guard", () => {
  it.each([
    "postgresql://vetra:vetra_local_dev@localhost:55432/vetra",
    "postgres://vetra:x@127.0.0.1:55432/vetra",
    "postgresql://vetra:x@[::1]:55432/vetra",
  ])("accepts the local container: %s", (url) => {
    expect(() => assertLocalDatabase(url)).not.toThrow();
  });

  it.each([
    [undefined, /DATABASE_URL/],
    ["", /DATABASE_URL/],
    // The Cloud SQL Auth Proxy listens on loopback too -- 5432 is its default.
    ["postgresql://vetra:x@localhost:5432/vetra", /55432/],
    ["postgresql://vetra:x@10.0.0.5:55432/vetra", /loopback/],
    ["postgresql://vetra:x@localhost.evil.example:55432/vetra", /loopback/],
    ["postgresql://vetra:x@db.example.com/vetra", /loopback/],
    ["not a url", /parse/],
  ])("refuses %s", (url, why) => {
    expect(() => assertLocalDatabase(url)).toThrow(why);
  });

  it("isLoopbackBase is the harness's own loopback rule", () => {
    expect(isLoopbackBase("http://localhost:3000")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackBase("https://unpolluted.ngrok-free.dev")).toBe(false);
    expect(isLoopbackBase("http://localhost.evil.example")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("dispatchLines equals what the REAL dispatcher hands renderAudio", () => {
  // The fixture tests/outboundDispatch.test.js dials with: every gate check
  // passes at NOW, so the dispatcher reaches the render.
  const NOW = new Date("2026-09-28T13:00:00Z");
  const row = (over = {}) => ({
    id: "o1", business_id: "b1", state: "waiting", attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null,
    next_attempt_at: NOW, campaign_id: "c1", campaign_version: 1, campaign_status: "active", compliance_class: "solicited", template_key: "speed_to_lead",
    config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+447700900101" },
    contact_id: "k1", phone_e164: "+447700900202", first_name: "Sam", contact_timezone: null,
    outbound_enabled: true, outbound_max_concurrent: 2, business_timezone: "Europe/London", business_name: "Harness Test Clinic",
    ...over,
  });
  const fakeDb = (r) => ({
    withTenant: async (_b, fn) => fn(),
    lockCapacity: async () => {},
    claimOutreachForDispatch: async () => r,
    isSuppressed: async () => false,
    listConsents: async () => [{ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-28T12:58:00Z"), expires_at: null, revoked_at: null }],
    hasServiceRelationship: async () => false,
    countDialsSince: async () => 0,
    activeDialCounts: async () => ({ globalOutbound: 0, businessOutbound: 0 }),
    insertCallAttempt: async () => ({ id: "a1" }),
    markOutreachDialing: async () => {},
    setAttemptCallSid: async () => {},
    storeAttemptAudio: async () => {},
  });
  const env = { enabled: false, allowlist: new Set(["+447700900202"]), maxConcurrent: 8, inboundReserve: 2, baseUrl: "https://svc.example" };

  async function realLines(r) {
    const renderAudio = vi.fn(async () => null);
    const d = createDispatcher({
      db: fakeDb(r),
      twilio: { calls: { create: async () => ({ sid: "CA1" }) } },
      enqueue: async () => ({ created: true }),
      env,
      now: () => NOW,
      rand: () => 0,
      callerIdValid: async () => true,
      renderAudio,
      log: { info() {}, error() {} },
    });
    const out = await d({ businessId: "b1", outreachId: "o1" });
    expect(out.status).toBe("dialed");
    return renderAudio.mock.calls[0]?.[0]?.lines ?? {};
  }

  const cfg = (over) => ({ ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+447700900101", ...over });
  it.each([
    ["attempt 1 (voicemail due): both lines", row()],
    ["attempt 2 (no voicemail)", row({ attempts_made: 1 })],
    ["no first name (O-9): the first-name sentence dropped", row({ first_name: null })],
    ["an opener over 120 is omitted, never truncated", row({ config: cfg({ opener: "x".repeat(130) }) })],
    ["a voicemail over 300 is omitted", row({ config: cfg({ voicemail: "It's Ava, an AI assistant from {business_name}. " + "y".repeat(300) }) })],
  ])("%s", async (_label, r) => {
    const mine = dispatchLines({ row: r, attemptNo: r.attempts_made + 1 });
    expect(mine.lines).toEqual(await realLines(r));
  });

  it("reports what it refused and why", () => {
    const r = row({ config: cfg({ opener: "x".repeat(130) }) });
    expect(dispatchLines({ row: r, attemptNo: 1 }).refused).toEqual([{ kind: "opener", chars: 130 }]);
  });
});

// ---------------------------------------------------------------------------
describe("the paced mark echo", () => {
  it("a mark echoes once the audio ahead of it would have played, not before", () => {
    const p = createPlayoutClock();
    for (let i = 0; i < 5; i++) p.onMedia(1000);
    expect(p.markDelay(1000)).toBe(100);
    expect(p.markDelay(1060)).toBe(40);
    expect(p.markDelay(1200)).toBe(0);
  });

  it("a mark with nothing ahead of it echoes at once; a clear drops what was queued", () => {
    const p = createPlayoutClock();
    expect(p.markDelay(500)).toBe(0);
    for (let i = 0; i < 10; i++) p.onMedia(500);
    p.onClear(520);
    expect(p.markDelay(520)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H3 (2026-09-26, harness fidelity): setInterval(20) fires every ~31.4 ms on
// this Windows machine (measured: 64 ticks in 2 s), not every 20 ms. A ticker
// that sent exactly one frame per tick therefore delivered caller audio at
// ~0.64x real time. framesDue/startMediaTicker pace the ticker by WALL CLOCK
// instead, and pacingCheck is the regression guard that would catch a return
// to one-frame-per-tick.
// ---------------------------------------------------------------------------
describe("H3: the media ticker is paced by wall clock, not by counting ticks", () => {
  describe("framesDue", () => {
    it("a tick exactly on a frame boundary owes exactly one frame", () => {
      expect(framesDue({ startMs: 0, nowMs: 20, sent: 0, frameMs: 20 })).toBe(1);
    });

    it("never negative: a tick that fires before the next frame is due owes 0", () => {
      expect(framesDue({ startMs: 0, nowMs: 15, sent: 0, frameMs: 20 })).toBe(0);
      // already caught up (or ahead, which should never happen, but must not go negative)
      expect(framesDue({ startMs: 0, nowMs: 20, sent: 5, frameMs: 20 })).toBe(0);
    });

    it("a clock that reads before startMs (should never happen) clamps elapsed to 0, not negative", () => {
      expect(framesDue({ startMs: 1000, nowMs: 990, sent: 0, frameMs: 20 })).toBe(0);
    });

    it("31 ms ticks (this machine's measured setInterval(20) rate): due tracks elapsed/20 exactly, cumulatively", () => {
      const startMs = 0;
      const frameMs = 20;
      let sent = 0;
      for (let tick = 1; tick <= 64; tick++) {
        const nowMs = tick * 31.4; // the defect's own measured rate
        const due = framesDue({ startMs, nowMs, sent, frameMs, maxBurst: 100 });
        sent += due;
      }
      // 64 ticks * 31.4 ms = 2009.6 ms elapsed -> floor(2009.6 / 20) = 100 frames due.
      expect(sent).toBe(Math.floor((64 * 31.4) / frameMs));
      expect(sent).toBe(100);
      // The OLD, unpaced behaviour would have sent only 64 -- exactly the
      // defect's own measurement (633-646 frames per 20 s instead of 1000).
      expect(sent).toBeGreaterThan(64);
    });

    it("burst cap: a long stall never sends more than maxBurst frames in one tick", () => {
      const due = framesDue({ startMs: 0, nowMs: 5000, sent: 0, frameMs: 20, maxBurst: 5 });
      expect(due).toBe(5);
      expect(framesDue({ startMs: 0, nowMs: 5000, sent: 0, frameMs: 20 })).toBe(MEDIA_TICKER_MAX_BURST);
    });

    it("the default max burst is 5", () => {
      expect(MEDIA_TICKER_MAX_BURST).toBe(5);
    });
  });

  describe("startMediaTicker", () => {
    /** A fake `every` that captures the callback instead of registering a real timer. */
    function fakeRegistrar() {
      let tick = null;
      const every = (fn) => {
        tick = fn;
      };
      return { every, fire: () => tick() };
    }

    it("registers through the caller's own `every`, and returns the wall-clock instant frame 0 was due", () => {
      const reg = fakeRegistrar();
      let now = 12345;
      const sent = { count: 0 };
      const { startMs } = startMediaTicker({
        every: reg.every,
        frameMs: 20,
        now: () => now,
        getSent: () => sent.count,
        sendFrame: () => {
          sent.count += 1;
        },
      });
      expect(startMs).toBe(12345);
    });

    it("sends however many frames are due each real fire -- catch-up, not one-per-tick", () => {
      const reg = fakeRegistrar();
      let now = 0;
      const sent = { count: 0 };
      startMediaTicker({
        every: reg.every,
        frameMs: 20,
        maxBurst: 100,
        now: () => now,
        getSent: () => sent.count,
        sendFrame: () => {
          sent.count += 1;
        },
      });
      now = 31.4; // first real fire, the measured rate
      reg.fire();
      expect(sent.count).toBe(1);
      now = 62.8; // second real fire
      reg.fire();
      expect(sent.count).toBe(3); // caught up: 2 more frames became due
      now = 94.2;
      reg.fire();
      expect(sent.count).toBe(4);
    });

    it("caps a stall's catch-up at maxBurst per tick", () => {
      const reg = fakeRegistrar();
      let now = 0;
      const sent = { count: 0 };
      startMediaTicker({
        every: reg.every,
        frameMs: 20,
        maxBurst: 5,
        now: () => now,
        getSent: () => sent.count,
        sendFrame: () => {
          sent.count += 1;
        },
      });
      now = 5000; // a huge stall: 250 frames would be "due"
      reg.fire();
      expect(sent.count).toBe(5);
      // the remaining backlog catches up gradually over later ticks, never all at once
      now = 5020;
      reg.fire();
      expect(sent.count).toBe(10);
    });
  });

  describe("pacingCheck", () => {
    it("ratio 1, exactly on pace: not slow", () => {
      expect(pacingCheck({ framesSent: 100, elapsedMs: 2000, frameMs: 20 })).toEqual({ frames_expected: 100, ratio: 1, slow: false });
    });

    it("PACING_MIN_RATIO is 0.95", () => {
      expect(PACING_MIN_RATIO).toBe(0.95);
    });

    it("the OLD one-frame-per-tick defect's own numbers: slow", () => {
      // 64 ticks sent (the defect's measurement) over the 2,009.6 ms those
      // 64 real ticks actually spanned -> ratio well under 0.95.
      const r = pacingCheck({ framesSent: 64, elapsedMs: 2009.6, frameMs: 20 });
      expect(r.frames_expected).toBe(100);
      expect(r.ratio).toBeLessThan(0.95);
      expect(r.slow).toBe(true);
    });

    it("a ratio just above the floor is not slow; just below is", () => {
      expect(pacingCheck({ framesSent: 96, elapsedMs: 2000, frameMs: 20 }).slow).toBe(false); // 0.96
      expect(pacingCheck({ framesSent: 94, elapsedMs: 2000, frameMs: 20 }).slow).toBe(true); // 0.94
    });

    it("zero elapsed time: frames_expected 0, ratio 1 (never a divide-by-zero), never slow", () => {
      expect(pacingCheck({ framesSent: 0, elapsedMs: 0, frameMs: 20 })).toEqual({ frames_expected: 0, ratio: 1, slow: false });
    });
  });

  // t1 (review of 049cd83, Important): scripts/live-call-harness.js's
  // stopAllTimers() used to write stats.mediaTickerEndMs on EVERY call, and
  // a deliberate hang-up calls it twice -- once inside hangUp(), then again
  // ~500 ms later from the deferred ws.close() -> close handler -- inflating
  // the pacing window by ~500 ms and risking a false pacing_slow warning on
  // an otherwise clean run.
  describe("markMediaTickerEnd: first-write-wins", () => {
    it("the first call stamps mediaTickerEndMs", () => {
      const stats = { mediaTickerEndMs: null };
      markMediaTickerEnd(stats, () => 1000);
      expect(stats.mediaTickerEndMs).toBe(1000);
    });

    it("a second call (the double stopAllTimers/close shape) leaves the value UNCHANGED", () => {
      const stats = { mediaTickerEndMs: null };
      markMediaTickerEnd(stats, () => 1000);
      markMediaTickerEnd(stats, () => 1500); // ~500ms later, e.g. the deferred close handler
      expect(stats.mediaTickerEndMs).toBe(1000);
    });

    it("defaults to Date.now when no clock is injected", () => {
      const stats = { mediaTickerEndMs: null };
      const before = Date.now();
      markMediaTickerEnd(stats);
      expect(stats.mediaTickerEndMs).toBeGreaterThanOrEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
const media = { event: "media", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } };
const mark = (name) => ({ event: "mark", mark: { name } });

describe("the client-side clock", () => {
  it("speaks first: onset, first frame, from_speech_ms, and no frame before onset", () => {
    const o = createClientObserver();
    o.answered(1000);
    o.streamStarted(1330);
    o.helloOnset(2870);
    o.fromServer(mark(FIRST_AUDIO_MARK), 3900);
    o.fromServer(media, 3901);
    o.fromServer(media, 3921);
    const s = o.snapshot();
    expect(s).toMatchObject({
      hello_onset_from_answer_ms: 1870,
      stream_start_from_answer_ms: 330,
      from_answer_ms: 2901,
      from_speech_ms: 1031,
      first_audio_mark_from_stream_start_ms: 2570,
      frames_before_onset: 0,
      media_frames: 2,
      marks_received: 1,
    });
  });

  it("a frame that arrives before the hello is counted", () => {
    const o = createClientObserver();
    o.answered(0);
    o.streamStarted(330);
    o.fromServer(mark(FIRST_AUDIO_MARK), 1990);
    o.fromServer(media, 1990);
    o.fromServer(media, 2010);
    o.helloOnset(2500);
    o.fromServer(media, 2520);
    const s = o.snapshot();
    expect(s.frames_before_onset).toBe(2);
    expect(s.first_audio_mark_from_stream_start_ms).toBe(1660);
    expect(s.from_speech_ms).toBe(-510);
  });

  it("nothing heard: nulls, not zeros", () => {
    const o = createClientObserver();
    o.answered(0);
    o.streamStarted(300);
    const s = o.snapshot();
    expect(s.from_answer_ms).toBeNull();
    expect(s.from_speech_ms).toBeNull();
    expect(s.first_audio_mark_from_stream_start_ms).toBeNull();
    expect(s.hello_onset_from_answer_ms).toBeNull();
  });

  it("lead_in_ms is reported verbatim in the snapshot (and so in the verdict's client measurements)", () => {
    const o = createClientObserver({ leadInMs: 400 });
    o.answered(0);
    expect(o.snapshot().lead_in_ms).toBe(400);
    expect(createClientObserver().snapshot().lead_in_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// H2 (2026-09-26 paid harness run): the caller clip `outbound_hello.ulaw`
// carries ~400 ms of lead-in silence before Google TTS's "Hello?" actually
// starts. `--hello-ms` names the moment the person's VOICE starts, so the
// harness must start sending the FILE that much earlier and record onset at
// the first VOICED frame, not the first FILE frame -- else the verdict's
// no_frame_before_onset is lenient by the lead-in, and from_speech_ms is
// inflated by it.
// ---------------------------------------------------------------------------
describe("H2: onset is the first VOICED frame, not the first FILE frame", () => {
  it("the ruled RMS threshold is 500 (above the ~120 noise floor, below real voice's ~2936)", () => {
    expect(LEAD_IN_RMS_THRESHOLD).toBe(500);
  });

  it("lead-in detection on a synthetic buffer: silence, then a loud tone", () => {
    // mu-law 0xff decodes to exact silence (the same byte SILENT_FRAME_BYTES
    // uses); mu-law 0x00 decodes to a large-magnitude sample -- a loud tone.
    const silence = Buffer.alloc(160 * 5, 0xff); // 5 frames = 100 ms
    const tone = Buffer.alloc(160 * 3, 0x00); // 3 frames = 60 ms
    const buf = Buffer.concat([silence, tone]);
    expect(detectLeadIn(buf)).toEqual({ leadInMs: 100, leadInFrames: 5, frames: 8, voiced: true });
  });

  it("an all-silent buffer is never voiced: lead-in fails closed to 0, not to the whole clip", () => {
    const buf = Buffer.alloc(160 * 4, 0xff);
    expect(detectLeadIn(buf)).toEqual({ leadInMs: 0, leadInFrames: 0, frames: 4, voiced: false });
  });

  it("a custom frame size / frameMs / threshold are honoured", () => {
    const buf = Buffer.concat([Buffer.alloc(80, 0xff), Buffer.alloc(80, 0x00)]);
    expect(detectLeadIn(buf, { frameBytes: 80, frameMs: 10, rmsThreshold: 500 })).toMatchObject({ leadInMs: 10, leadInFrames: 1, voiced: true });
  });

  it("schedule math: starts the file lead_in ms earlier so the voiced frame lands at hello_ms", () => {
    expect(scheduleCallerClip(1870, 400)).toEqual({ fileStartMs: 1470, onsetMs: 1870, clamped: false });
  });

  it("schedule math: zero lead-in is the old behaviour exactly (file start = onset = hello_ms)", () => {
    expect(scheduleCallerClip(1870, 0)).toEqual({ fileStartMs: 1870, onsetMs: 1870, clamped: false });
  });

  it("schedule math: clamps the file start at 0 rather than negative, and says the onset landed late", () => {
    expect(scheduleCallerClip(300, 400)).toEqual({ fileStartMs: 0, onsetMs: 400, clamped: true });
  });
});

// ---------------------------------------------------------------------------
const SID = "CAharness0001";
const line = (event, fields = {}) => JSON.stringify({ message: event, ts: "2026-09-25T10:00:00.000Z", level: "INFO", event, ...fields });

describe("the server log", () => {
  const text = [
    "server listening on 3000",
    line("live_debug_transcript_enabled", { level: "ERROR" }),
    line("live_stream_start", { callSid: SID, direction: "outbound" }),
    line("outbound_backstop_played", { callSid: SID, attemptId: "a1", path: "backstop_silence", source: "stored", seed: "at_fire" }),
    line("outbound_first_audio", { callSid: SID, attemptId: "a1", from_answer_ms: 2012, from_speech_ms: null, path: "backstop_silence", measured: "playout" }),
    line("outbound_first_audio", { callSid: "CAother", from_answer_ms: 1, path: "live_reply", measured: "playout" }),
    line("live_debug_assistant_turn", { callSid: SID, text: "Sorry, are you there?", debug_only: true }),
    line("live_call_summary", { callSid: SID, model: "gemini-3.1-flash-live-preview", usage: { text_in: 9000, audio_in: 500, text_out: 0, audio_out: 300, cached_in: 0, turns_billed: 2 } }),
    "{not json",
  ].join("\n");

  it("keeps only this call's lines, and the session-level debug flag", () => {
    const s = parseServerLog(text, { callSid: SID });
    expect(s.firstAudio).toMatchObject({ from_answer_ms: 2012, path: "backstop_silence", measured: "playout" });
    expect(s.backstopPlayed).toHaveLength(1);
    expect(s.backstopMissing).toHaveLength(0);
    expect(s.assistantTurns.map((t) => t.text)).toEqual(["Sorry, are you there?"]);
    expect(s.debugTranscriptOn).toBe(true);
    expect(s.summary.usage.turns_billed).toBe(2);
    expect(s.events.every((e) => e.callSid === SID)).toBe(true);
  });

  it("decodes PowerShell's UTF-16LE redirect and a UTF-8 BOM", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(parseServerLog(decodeLogBuffer(utf16), { callSid: SID }).firstAudio.from_answer_ms).toBe(2012);
    const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    expect(decodeLogBuffer(bom8).startsWith("server listening")).toBe(true);
  });
});

describe("isIntroduction", () => {
  it.each([
    ["Hi, is that Sam? It's Ava, an AI assistant from Harness Test Clinic.", true],
    ["This is Ava from Harness Test Clinic.", true],
    ["I'm an A.I. assistant calling about your enquiry.", true],
    ["Great, and what's the clinic called?", false],
    ["Sorry, are you still there?", false],
    ["Plan A. I wanted to ask about your enquiry.", false],
  ])("%s -> %s", (text, want) => {
    expect(isIntroduction(text, { personaName: "Ava" })).toBe(want);
  });
});

// ---------------------------------------------------------------------------
describe("the verdict", () => {
  const dbOk = { calls: { direction: "outbound" }, attempt: { answered_at: "t", status_completed_at: "t", post_call_started_at: "2026-09-28T13:05:00Z" } };
  const speaksClient = {
    hello_onset_at: 1870,
    first_media_at: 2900,
    frames_before_onset: 0,
    from_speech_ms: 1030,
    from_answer_ms: 2900,
    first_audio_mark_from_stream_start_ms: 2550,
  };
  const speaksServer = {
    firstAudio: { from_answer_ms: 2950, from_speech_ms: 980, path: "live_reply", measured: "playout" },
    backstopPlayed: [],
    backstopMissing: [],
    firstTurnIncomplete: [],
    assistantTurns: [],
    debugTranscriptOn: true,
    attemptResultCount: 1,
  };

  it("speaks first, clean: PASS on every criterion, including post_call_exactly_once", () => {
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(v.pass).toBe(true);
    expect(Object.fromEntries(Object.entries(v.criteria).map(([k, c]) => [k, c.result]))).toEqual({
      no_frame_before_onset: "PASS",
      path_live_reply: "PASS",
      from_speech_ms_le_2000: "PASS",
      calls_direction_outbound: "PASS",
      post_call_exactly_once: "PASS",
    });
  });

  it("post_call_exactly_once fails when the attempt never claimed, or the log shows it ran more than once", () => {
    const neverClaimed = outboundVerdict({
      mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer,
      db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: null } }, personaName: "Ava",
    });
    expect(neverClaimed.criteria.post_call_exactly_once).toMatchObject({ result: "FAIL", post_call_started_at: null });

    const ranTwice = outboundVerdict({
      mode: "speaks_first", clip: true, client: speaksClient, server: { ...speaksServer, attemptResultCount: 2 }, db: dbOk, personaName: "Ava",
    });
    expect(ranTwice.criteria.post_call_exactly_once).toMatchObject({ result: "FAIL", attempt_result_log_count: 2 });
    expect(ranTwice.pass).toBe(false);
  });

  it("post_call_exactly_once is UNKNOWN (not a pass) with no db read-back or no server log", () => {
    const noDb = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: null, personaName: "Ava" });
    expect(noDb.criteria.post_call_exactly_once.result).toBe("UNKNOWN");
    expect(noDb.pass).toBe(false);

    const noServer = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: null, db: dbOk, personaName: "Ava" });
    expect(noServer.criteria.post_call_exactly_once.result).toBe("UNKNOWN");
    expect(noServer.pass).toBe(false);
  });

  it("an assistant frame BEFORE the hello onset fails no_frame_before_onset, and the run", () => {
    const client = { ...speaksClient, frames_before_onset: 3, first_media_at: 1650 };
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(v.criteria.no_frame_before_onset.result).toBe("FAIL");
    expect(v.pass).toBe(false);
  });

  // H2: with the real fixture's ~400 ms lead-in, the window between the file
  // being sent and the person's real "Hello?" is ~400 ms wide, not ~0 -- and
  // an assistant frame landing in exactly that window (the caller is still
  // silent) must still fail the criterion, the same as it always has.
  it("H2: an assistant frame between file start and the TRUE voice onset still fails no_frame_before_onset", () => {
    const LEAD_IN_MS = 400;
    const { fileStartMs, onsetMs } = scheduleCallerClip(1870, LEAD_IN_MS);
    const earlyReplyAt = fileStartMs + 100; // inside the caller's own lead-in silence
    // The gap this defect is about: sabotaging onset back to "= file start"
    // collapses it to <= 0, which is exactly what this guards against.
    expect(earlyReplyAt).toBeLessThan(onsetMs);

    const o = createClientObserver({ leadInMs: LEAD_IN_MS });
    o.answered(0);
    o.streamStarted(330);
    o.fromServer(media, earlyReplyAt); // the assistant replied while the caller was still silent
    o.helloOnset(onsetMs); // the caller's real voice only starts now
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: o.snapshot(), server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(v.criteria.no_frame_before_onset.result).toBe("FAIL");
    expect(v.pass).toBe(false);
    expect(v.measurements.client.lead_in_ms).toBe(LEAD_IN_MS);
  });

  it("a hello that was never sent is not a pass", () => {
    const client = { ...speaksClient, hello_onset_at: null, frames_before_onset: 0 };
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(v.criteria.no_frame_before_onset.result).toBe("FAIL");
  });

  it("a reply slower than 2,000 ms after onset fails; no reply at all fails", () => {
    const slow = outboundVerdict({ mode: "speaks_first", clip: true, client: { ...speaksClient, from_speech_ms: 2001 }, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(slow.criteria.from_speech_ms_le_2000.result).toBe("FAIL");
    const none = outboundVerdict({ mode: "speaks_first", clip: true, client: { ...speaksClient, first_media_at: null, from_speech_ms: null }, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(none.criteria.from_speech_ms_le_2000.result).toBe("FAIL");
  });

  it("the backstop's slow path is not a live reply", () => {
    const server = { ...speaksServer, firstAudio: { ...speaksServer.firstAudio, path: "backstop_slow" } };
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server, db: dbOk, personaName: "Ava" });
    expect(v.criteria.path_live_reply.result).toBe("FAIL");
  });

  it("a stream that started well after the simulated answer offset is WARNED about, not folded into a criterion", () => {
    const ok = outboundVerdict({ mode: "speaks_first", clip: true, client: { ...speaksClient, stream_start_from_answer_ms: 340 }, server: speaksServer, db: dbOk, personaName: "Ava", answerToStreamMs: 330 });
    expect(ok.warnings).toEqual([]);
    const late = outboundVerdict({ mode: "speaks_first", clip: true, client: { ...speaksClient, stream_start_from_answer_ms: 1650 }, server: speaksServer, db: dbOk, personaName: "Ava", answerToStreamMs: 330 });
    expect(late.warnings).toHaveLength(1);
    expect(late.warnings[0]).toMatch(/^stream_start_late: .*1650 ms.*shifted by 1320 ms/);
    expect(late.pass).toBe(true); // the criteria are unchanged; the warning is what the reader must see
  });

  // H3: pacing is a property of THIS harness's clock, never the product --
  // WARNED about (like stream_start_late), never folded into a criterion.
  it("H3: a slow-paced ticker is WARNED about (pacing_slow), not folded into a criterion", () => {
    const clean = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: dbOk, personaName: "Ava", pacing: { frames_sent: 100, frames_expected: 100, ratio: 1, slow: false } });
    expect(clean.warnings).toEqual([]);
    expect(clean.measurements.pacing).toEqual({ frames_sent: 100, frames_expected: 100, ratio: 1, slow: false });

    const slow = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: dbOk, personaName: "Ava", pacing: { frames_sent: 64, frames_expected: 100, ratio: 0.64, slow: true } });
    expect(slow.warnings).toHaveLength(1);
    expect(slow.warnings[0]).toMatch(/^pacing_slow: .*64 of an expected 100 frames.*ratio 0.64/);
    expect(slow.pass).toBe(true); // the criteria (including the ones pacing would distort) are unchanged by this warning

    const noMeasurement = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(noMeasurement.warnings).toEqual([]);
    expect(noMeasurement.measurements.pacing).toBeNull();
  });

  it("no server log: the path is UNKNOWN, and UNKNOWN is not a pass", () => {
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: null, db: dbOk, personaName: "Ava" });
    expect(v.criteria.path_live_reply.result).toBe("UNKNOWN");
    expect(v.pass).toBe(false);
  });

  it("calls.direction must read outbound", () => {
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: { calls: { direction: "inbound" } }, personaName: "Ava" });
    expect(v.criteria.calls_direction_outbound.result).toBe("FAIL");
    const none = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: { calls: null }, personaName: "Ava" });
    expect(none.criteria.calls_direction_outbound.result).toBe("FAIL");
  });

  const silentClient = { hello_onset_at: null, first_media_at: 1995, frames_before_onset: 5, from_speech_ms: null, from_answer_ms: 1995, first_audio_mark_from_stream_start_ms: 1662 };
  const silentServer = {
    firstAudio: { from_answer_ms: 2012, from_speech_ms: null, path: "backstop_silence", measured: "playout" },
    backstopPlayed: [{ path: "backstop_silence", source: "stored", seed: "at_fire" }],
    backstopMissing: [],
    firstTurnIncomplete: [],
    assistantTurns: [{ text: "Sorry, are you still there?" }],
    debugTranscriptOn: true,
    attemptResultCount: 1,
  };

  it("silent, clean: backstop queued at ~1,650, played out <= 2,500, seeded, no second introduction", () => {
    const v = outboundVerdict({ mode: "silent", clip: true, client: silentClient, server: silentServer, db: dbOk, personaName: "Ava" });
    expect(Object.fromEntries(Object.entries(v.criteria).map(([k, c]) => [k, c.result]))).toEqual({
      path_backstop_silence: "PASS",
      backstop_queued_at_1650: "PASS",
      played_out_le_2500: "PASS",
      seeded: "PASS",
      no_second_intro: "PASS",
      calls_direction_outbound: "PASS",
      post_call_exactly_once: "PASS",
    });
    expect(v.pass).toBe(true);
  });

  it("silent: a playout above 2,000 but under 2,500 passes and is RECORDED, not hidden", () => {
    const server = { ...silentServer, firstAudio: { ...silentServer.firstAudio, from_answer_ms: 2280 } };
    const v = outboundVerdict({ mode: "silent", clip: true, client: silentClient, server, db: dbOk, personaName: "Ava" });
    expect(v.criteria.played_out_le_2500).toMatchObject({ result: "PASS", server_from_answer_ms: 2280, above_2000: true });
  });

  it.each([
    ["queued 120 ms late", { client: { first_audio_mark_from_stream_start_ms: 1771 } }, "backstop_queued_at_1650"],
    ["played out after 2,500", { server: { firstAudio: { from_answer_ms: 2501, path: "backstop_silence", measured: "playout" } } }, "played_out_le_2500"],
    ["no playout echo (measured:enqueue)", { server: { firstAudio: { from_answer_ms: 2010, path: "backstop_silence", measured: "enqueue" } } }, "played_out_le_2500"],
    ["not seeded", { server: { backstopPlayed: [] } }, "seeded"],
    ["Live introduced itself again", { server: { assistantTurns: [{ text: "Hi, it's Ava, an AI assistant from Harness Test Clinic." }] } }, "no_second_intro"],
  ])("silent FAILS when %s", (_l, over, criterion) => {
    const v = outboundVerdict({
      mode: "silent",
      clip: true,
      client: { ...silentClient, ...(over.client || {}) },
      server: { ...silentServer, ...(over.server || {}) },
      db: dbOk,
      personaName: "Ava",
    });
    expect(v.criteria[criterion].result).toBe("FAIL");
    expect(v.pass).toBe(false);
  });

  it("no second introduction is UNKNOWN without LIVE_DEBUG_TRANSCRIPT=1 -- silence in the log is not evidence", () => {
    const v = outboundVerdict({ mode: "silent", clip: true, client: silentClient, server: { ...silentServer, debugTranscriptOn: false, assistantTurns: [] }, db: dbOk, personaName: "Ava" });
    expect(v.criteria.no_second_intro.result).toBe("UNKNOWN");
    expect(v.pass).toBe(false);
  });

  it("--no-render (the prompt path): the backstop is logged missing, Live's own introduction is allowed once", () => {
    const server = {
      ...silentServer,
      firstAudio: { from_answer_ms: 3100, from_speech_ms: null, path: "backstop_silence", measured: "playout" },
      backstopPlayed: [],
      backstopMissing: [{ path: "backstop_silence", refetch: "done", line: "yes" }],
      assistantTurns: [{ text: "Hi, is that Sam? It's Ava, an AI assistant from Harness Test Clinic." }],
    };
    const v = outboundVerdict({ mode: "silent", clip: false, client: { ...silentClient, first_audio_mark_from_stream_start_ms: 2750 }, server, db: dbOk, personaName: "Ava" });
    expect(v.criteria).not.toHaveProperty("seeded");
    expect(v.criteria.backstop_missing_logged.result).toBe("PASS");
    expect(v.criteria.no_second_intro.result).toBe("PASS");
    expect(v.measurements.server_from_answer_ms).toBe(3100);
    const twice = outboundVerdict({ mode: "silent", clip: false, client: silentClient, server: { ...server, assistantTurns: [...server.assistantTurns, { text: "It's Ava from Harness Test Clinic again." }] }, db: dbOk, personaName: "Ava" });
    expect(twice.criteria.no_second_intro.result).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
describe("spend: priced from usage, or the full reserve", () => {
  const usage = { text_in: 10_000, audio_in: 1_000, text_out: 0, audio_out: 500, cached_in: 0, turns_billed: 3 };
  const model = "gemini-3.1-flash-live-preview";

  it("prices the call's live_call_summary usage plus every render session, on the rate card", () => {
    const r = priceHarnessRun({
      sessionOpened: true,
      callSummary: { model, usage },
      renderSessions: [{ model, usage: { text_in: 100, audio_in: 0, text_out: 0, audio_out: 200, cached_in: 0, turns_billed: 1 } }],
    });
    const { turns_billed: _t, ...u } = usage;
    const expected = priceTokens(model, u).usd + priceTokens(model, { text_in: 100, audio_out: 200 }).usd;
    expect(r.basis).toBe("priced");
    expect(r.usd).toBeCloseTo(expected, 12);
    expect(r.usd).toBeGreaterThan(0);
  });

  it.each([
    ["no live_call_summary (no --server-log)", { sessionOpened: true, callSummary: null, renderSessions: [] }],
    ["a model with no rate card", { sessionOpened: true, callSummary: { model: "gemini-9-live", usage }, renderSessions: [] }],
    ["a render whose usageMetadata never arrived", { sessionOpened: true, callSummary: { model, usage }, renderSessions: [{ model, usage: { text_in: 0, audio_in: 0, text_out: 0, audio_out: 0, cached_in: 0, turns_billed: 0 } }] }],
  ])("unpriceable when %s", (_l, args) => {
    const r = priceHarnessRun(args);
    expect(r.basis).toBe("unpriceable");
    expect(r.usd).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("no session opened and nothing rendered: exactly $0", () => {
    expect(priceHarnessRun({ sessionOpened: false, callSummary: null, renderSessions: [] })).toMatchObject({ usd: 0, basis: "no_session" });
  });

  it("the guard reserves before and commits after, always with a numeric usd; unpriceable commits the full reserve", () => {
    const spend = { reserveP1: vi.fn(), commit: vi.fn() };
    const g = createSpendGuard({ probe: "P1-HARNESS", spend });
    g.reserve();
    expect(spend.reserveP1).toHaveBeenCalledWith("P1-HARNESS", HARNESS_RESERVE_USD);
    expect(HARNESS_RESERVE_USD).toBe(0.05);
    g.commit({ usd: null, basis: "unpriceable", reason: "no summary" }, { callSid: SID });
    expect(spend.commit).toHaveBeenCalledWith(expect.objectContaining({ probe: "P1-HARNESS", usd: 0.05, basis: "full_reserve", reason: "no summary", callSid: SID }));
    // Once only: the exit hook after a normal commit must not commit again.
    g.commit({ usd: 0.01, basis: "priced" });
    expect(spend.commit).toHaveBeenCalledTimes(1);
  });

  it("a priced run commits its priced usd; nothing is committed without a reserve", () => {
    const spend = { reserveP1: vi.fn(), commit: vi.fn() };
    const g = createSpendGuard({ probe: "P1-HARNESS", spend });
    g.commit({ usd: 0.012, basis: "priced" });
    expect(spend.commit).not.toHaveBeenCalled();
    g.reserve();
    g.commit({ usd: 0.012, basis: "priced" });
    expect(spend.commit).toHaveBeenCalledWith(expect.objectContaining({ probe: "P1-HARNESS", usd: 0.012, basis: "priced" }));
  });

  it("a refused reserve throws and leaves nothing to commit", () => {
    const spend = {
      reserveP1: vi.fn(() => {
        throw new Error("BUDGET");
      }),
      commit: vi.fn(),
    };
    const g = createSpendGuard({ probe: "P1-HARNESS", spend });
    expect(() => g.reserve()).toThrow("BUDGET");
    g.commit({ usd: 0.05, basis: "full_reserve" });
    expect(spend.commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the render tap", () => {
  function pcm24k(ms) {
    const samples = Math.round((24000 * ms) / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
    return buf.toString("base64");
  }
  /** A fake connectLive: audio, a transcript, usage before or after turnComplete. */
  function fakeConnect({ say = (l) => l, usageAfter = false } = {}) {
    return vi.fn(async ({ callbacks }) => {
      const session = {
        sendClientContent(msg) {
          const l = msg.turns[0].parts[0].text.replace(/^Say exactly: "/, "").replace(/"$/, "");
          setImmediate(() => {
            const u = { promptTokensDetails: [{ modality: "TEXT", tokenCount: 40 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 90 }] };
            callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(400) } }] } } });
            callbacks.onmessage({ serverContent: { outputTranscription: { text: say(l) } } });
            if (!usageAfter) callbacks.onmessage({ usageMetadata: u });
            callbacks.onmessage({ serverContent: { turnComplete: true } });
            // A later socket message, as it would be on the wire: a separate
            // macrotask, after the renderer has already resolved and metered.
            if (usageAfter) setTimeout(() => callbacks.onmessage({ usageMetadata: u }), 5);
          });
        },
        close() {},
      };
      return { session, languagePinned: true, surface: "aistudio", model: "gemini-3.1-flash-live-preview" };
    });
  }
  const lines = {
    opener: "Hi, is that Sam? It's Ava, an AI assistant from Harness Test Clinic.",
    voicemail: "Hi Sam, it's Ava, the AI assistant from Harness Test Clinic, about your enquiry. We'll try again later, or call us back on 07700 900 101.",
  };

  it("records each line's transcript, overlap, word_ratio, render time, model and usage -- through the real renderLines", async () => {
    let t = 0;
    const tap = createRenderTap(fakeConnect({ say: (l) => (l.includes("07700") ? l.replace("07700 900 101", "oh seven seven oh oh, nine oh oh, one oh one") : l) }), { now: () => (t += 50) });
    const events = [];
    const out = await renderLines({
      lines,
      voiceName: "Kore",
      languageCode: "en-GB",
      connect: tap.connect,
      log: { info: (event, f) => events.push({ event, ...f }), error: (event, f) => events.push({ event, ...f }) },
      // graceMs: 5 -- h2 (checkpoint 2b review): the voicemail key here is
      // MEANT to be refused (word_ratio > 1.15, below), and this fake connect
      // never sends anything past turnComplete, so a small grace keeps this
      // test's runtime unaffected by the (correct) production wait.
      graceMs: 5,
    });
    const rows = summarizeRenderSessions(tap.sessions(), lines, events);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind.opener).toMatchObject({ kind: "opener", chars: lines.opener.length, overlap: 1, word_ratio: 1, outcome: "accepted", usage_before_turn_complete: true, model: "gemini-3.1-flash-live-preview" });
    expect(byKind.opener.render_ms).toBeGreaterThan(0);
    expect(byKind.opener.usage.text_in).toBe(40);
    expect(byKind.opener.usage.audio_out).toBe(90);
    // The reviewer's suspicion, made measurable: a spelled-out number reads as
    // many more words than "07700 900 101" does.
    expect(byKind.voicemail.word_ratio).toBeGreaterThan(1.15);
    expect(byKind.voicemail.outcome).toBe("transcript_mismatch");
    expect(out.voicemail).toBeNull();
    expect(Buffer.isBuffer(out.opener)).toBe(true);
  });

  it("usageMetadata arriving AFTER turnComplete is reported as such (M2 metering depends on it)", async () => {
    const tap = createRenderTap(fakeConnect({ usageAfter: true }));
    const events = [];
    await renderLines({ lines: { opener: lines.opener }, voiceName: "Kore", languageCode: "en-GB", connect: tap.connect, log: { info: (e, f) => events.push({ event: e, ...f }), error: () => {} } });
    await new Promise((r) => setTimeout(r, 30));
    const [row] = summarizeRenderSessions(tap.sessions(), { opener: lines.opener }, events);
    expect(row.usage_before_turn_complete).toBe(false);
    expect(row.usage_messages_after_turn_complete).toBe(1);
    // What the product meter saw at the moment it logged: nothing.
    expect(events.find((e) => e.event === "outbound_render_usage")).toMatchObject({ kind: "opener", text_in: 0, audio_out: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("fake numbers and SIDs", () => {
  it("two distinct numbers in the Ofcom drama range", () => {
    const { callerId, contact } = pickHarnessNumbers(() => 0.5);
    expect(callerId).toMatch(/^\+447700900\d{3}$/);
    expect(contact).toMatch(/^\+447700900\d{3}$/);
    expect(callerId).not.toBe(contact);
  });

  it("a CAharness SID the media-stream token can bind (no . / \\)", () => {
    const sid = harnessCallSid();
    expect(sid).toMatch(/^CAharness[0-9a-f]+$/);
    expect(harnessCallSid()).not.toBe(sid);
  });
});

// The marks the harness must tell apart are the ones firstSeconds.js exports.
it("the observer keys on the product's own first-audio mark name", () => {
  expect(FIRST_AUDIO_MARK).toBe("outbound-first-audio");
  expect(BACKSTOP_END_MARK).toBe("outbound-backstop-end");
});
