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
import { readFileSync } from "node:fs";

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
  mentionsTopic,
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
  HELLO_MS_DEFAULT,
} from "../lib/probe/outboundHarness.js";
import { OUTBOUND_SITUATION_SCRIPTS, resolveScriptLines } from "../lib/probe/script.js";
import { createDispatcher } from "../lib/outbound/dispatch.js";
import { renderLines } from "../lib/outbound/liveRender.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { FIRST_AUDIO_MARK, BACKSTOP_END_MARK, FIRST_SECONDS_DEFAULTS } from "../lib/outbound/firstSeconds.js";
import { computeAttemptAt } from "../lib/outbound/schedule.js";
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
  // F-R2 fix (harness-fix-brief item 1): the default recording-first pickup's
  // clean path is backstop_hello_end, not live_reply (path_backstop_hello_end's
  // own doc explains why "live_reply" was never reachable under the current
  // default -- f-r2-investigation.md §7).
  const speaksServer = {
    firstAudio: { from_answer_ms: 2950, from_speech_ms: 980, path: "backstop_hello_end", measured: "playout" },
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
      path_backstop_hello_end: "PASS",
      clip_after_hello_le_2000: "PASS",
      no_stale_reply_after_clip: "PASS",
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
    expect(slow.criteria.clip_after_hello_le_2000.result).toBe("FAIL");
    const none = outboundVerdict({ mode: "speaks_first", clip: true, client: { ...speaksClient, first_media_at: null, from_speech_ms: null }, server: speaksServer, db: dbOk, personaName: "Ava" });
    expect(none.criteria.clip_after_hello_le_2000.result).toBe("FAIL");
  });

  // F-R2 fix (harness-fix-brief item 1): backstop_silence and backstop_slow
  // both FAIL path_backstop_hello_end, with the actual path always reported.
  it.each(["backstop_slow", "backstop_silence"])("the hello arriving on the %s path is not backstop_hello_end", (path) => {
    const server = { ...speaksServer, firstAudio: { ...speaksServer.firstAudio, path } };
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server, db: dbOk, personaName: "Ava" });
    expect(v.criteria.path_backstop_hello_end).toMatchObject({ result: "FAIL", path });
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
    expect(v.criteria.path_backstop_hello_end.result).toBe("UNKNOWN");
    expect(v.criteria.no_stale_reply_after_clip.result).toBe("UNKNOWN");
    expect(v.pass).toBe(false);
  });

  it("calls.direction must read outbound", () => {
    const v = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: { calls: { direction: "inbound" } }, personaName: "Ava" });
    expect(v.criteria.calls_direction_outbound.result).toBe("FAIL");
    const none = outboundVerdict({ mode: "speaks_first", clip: true, client: speaksClient, server: speaksServer, db: { calls: null }, personaName: "Ava" });
    expect(none.criteria.calls_direction_outbound.result).toBe("FAIL");
  });

  // CHANGED (S3-2, P-a): 1662 (1650 + 12 ms) -> 1412 (1400 + 12 ms) --
  // SILENT_QUEUE_TARGET_MS moved with FIRST_SECONDS_DEFAULTS.silenceBackstopMs
  // (2,000 -> 1,750).
  const silentClient = { hello_onset_at: null, first_media_at: 1995, frames_before_onset: 5, from_speech_ms: null, from_answer_ms: 1995, first_audio_mark_from_stream_start_ms: 1412 };
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
      backstop_queued_at_target_ms: "PASS",
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
    // CHANGED (S3-2, P-a): target moved 1650 -> 1400 with silenceBackstopMs
    // (2,000 -> 1,750); 1521 is 121 ms over the (unchanged) 100 ms tolerance.
    ["queued 121 ms late", { client: { first_audio_mark_from_stream_start_ms: 1521 } }, "backstop_queued_at_target_ms"],
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
// S3-5: the 8 outbound situation scripts' own criteria. Every rule gets a
// PASS fixture and at least one FAIL fixture (memory sim-must-be-able-to-
// fail) -- named risk 1 (a verdict that cannot fail) is why `turns_reached`
// and the other "every run" assertions below are tested with their OWN FAIL
// fixture too, not just asserted PASS alongside a script's own criteria.
// ---------------------------------------------------------------------------
describe("S3-5: outbound situation scripts", () => {
  // Pinned literal (2026-09-30): the real runs these fixtures came from used
  // the then-template topic; the template itself is neutral now.
  const TOPIC = "our clinic systems";
  const NOW = new Date("2026-09-28T13:00:00Z");
  const TZ = "Europe/London";
  /** A real assistant turn: `text` is what Ava said, `user_text` is the ASR's transcript of what the caller said (null on a filler turn -- the model heard nothing new). */
  const turn = (text, userText = null) => ({ text, user_text: userText });

  /** The names really are the ones lib/probe/script.js registers. CHANGED (final wave W1): 8 -> 11, the next paid set's three. */
  // 2026-10-01: + the 5 live first-speaker sims (OUTBOUND_LIVE_SCRIPTS).
  it("OUTBOUND_SITUATION_SCRIPTS names 18 scripts, each with the caller lines a situation criterion assumes", () => {
    // 18 since 2026-10-02: outbound_booking_name_on_file.
    expect(OUTBOUND_SITUATION_SCRIPTS).toHaveLength(18);
    for (const name of OUTBOUND_SITUATION_SCRIPTS) expect(resolveScriptLines(name).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // TRIAGE ROUND 1 (sims-report.md sections 2 & 4, 24 real paid runs):
  // `assistantTurns[0]` is NEVER the pre-rendered opener clip -- the clip is
  // a static-asset playback (`outbound_backstop_played`/`outbound_first_
  // audio`), never a `live_debug_assistant_turn`. Turns are associated with
  // the caller line they answer by CONTENT (`user_text`, word-overlap
  // against the script's own known text), never by array index. A memory: a
  // test proves a wire only if both ends are real -- the raw text below is
  // copied verbatim from `.superpowers/sdd/2026-09-27-outbound-stage3/
  // harness-server.log` for the real call `outbound_gatekeeper_fetch-1`
  // (CAharness1a0e5fefa6252422017), including the backstop's own log lines,
  // so this proves the WHOLE path -- raw log text -> parseServerLog ->
  // outboundVerdict -- not just a hand-built fixture shaped like one.
  // ---------------------------------------------------------------------
  describe("triage round 1: turn association is by content, not by index", () => {
    const REAL_CALL_SID = "CAharness1a0e5fefa6252422017";
    const RAW_LOG = [
      '{"message":"outbound_backstop_played [52422017]","ts":"2026-09-28T03:11:44.368Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e5fefa6252422017","attemptId":"2c9cc040-db78-424b-b6c4-c486fe88b63e","path":"backstop_silence","source":"stored","seed":"at_fire"}',
      '{"message":"outbound_first_audio [52422017]","ts":"2026-09-28T03:11:44.384Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e5fefa6252422017","attemptId":"2c9cc040-db78-424b-b6c4-c486fe88b63e","from_answer_ms":1771,"from_speech_ms":null,"path":"backstop_silence","measured":"playout"}',
      '{"message":"live_debug_assistant_turn [52422017]","ts":"2026-09-28T03:11:55.612Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e5fefa6252422017","step":"identify_intent","debug_only":true,"text":"Thank you.","user_text":"One moment."}',
      '{"message":"live_debug_assistant_turn [52422017]","ts":"2026-09-28T03:12:06.345Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e5fefa6252422017","step":"identify_intent","debug_only":true,"text":"I\'m calling to book a thirty-minute discovery call regarding our clinic systems. What day or time works best for you?","user_text":"Hi, this is Sam."}',
      '{"message":"live_call_summary [52422017]","ts":"2026-09-28T03:12:10.000Z","level":"INFO","event":"live_call_summary","callSid":"CAharness1a0e5fefa6252422017","end_call_refusals":{"hesitation":0,"generic":0,"no_ask":0},"usage":{"text_in":100,"audio_in":100,"text_out":0,"audio_out":100,"cached_in":0,"turns_billed":2}}',
    ].join("\n");

    it("parses the REAL log text into assistantTurns with NO phantom opener entry (the clip is never a live_debug_assistant_turn)", () => {
      const view = parseServerLog(RAW_LOG, { callSid: REAL_CALL_SID });
      expect(view.assistantTurns).toEqual([
        { text: "Thank you.", user_text: "One moment." },
        {
          text: "I'm calling to book a thirty-minute discovery call regarding our clinic systems. What day or time works best for you?",
          user_text: "Hi, this is Sam.",
        },
      ]);
      expect(view.firstAudio).toMatchObject({ path: "backstop_silence" });
    });

    it("end to end (real log text -> parseServerLog -> outboundVerdict): turns_reached and identity_confirmed_at_last_line both PASS on a real, correctly-behaving call", () => {
      const view = parseServerLog(RAW_LOG, { callSid: REAL_CALL_SID });
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_gatekeeper_fetch",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        client: {},
        server: view,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false } },
      });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.identity_confirmed_at_last_line).toMatchObject({
        result: "PASS",
        leaked_before_last_line: false,
        topic_reached_after_last_line: true,
      });
    });

    // The exact failure mode sims-report.md finding A documented: under the
    // OLD index-based code (`turns.length >= linesCount + 1` = 4 for this
    // 3-line script), this real, correctly-behaving 2-turn call read FAIL.
    it("would have FAILED turns_reached under the old linesCount+1 assumption -- proving the old code, not this call, was wrong", () => {
      const view = parseServerLog(RAW_LOG, { callSid: REAL_CALL_SID });
      const oldWayExpected = resolveScriptLines("outbound_gatekeeper_fetch").length + 1; // 4
      expect(view.assistantTurns.length).toBeLessThan(oldWayExpected); // 2 < 4: the old check would have failed this clean call
    });
  });

  // ---------------------------------------------------------------------
  // TRIAGE ROUND 2, Important finding (a): round 1's plain wordOverlap did
  // no stopword filtering, so a caller line built mostly of common words
  // (outbound_robot's last line, "Are you a robot?" -> ["are","you","a",
  // "robot"]) could be matched by ANY earlier turn merely sharing "are" +
  // "you" -- turning a TRUNCATED call (the robot question never actually
  // asked or heard) into a false turns_reached PASS. The fixture below is
  // built from the real live_debug_assistant_turn SHAPE (text/user_text
  // pairs, exactly what parseServerLog/serverViewFromEvents produce from
  // the real log across all 24 S3-5 paid runs) with a CONSTRUCTED user_text
  // chosen to demonstrate the named coincidence (no real run happened to
  // produce this exact ASR artifact; the field shape is real, this specific
  // string is a plausible one per the review's own example).
  // ---------------------------------------------------------------------
  describe("triage round 2: stopword filtering closes the coincidental-match false PASS", () => {
    it("FAILS turns_reached on a truncated outbound_robot call, even though an EARLIER turn's user_text coincidentally contains \"are\" + \"you\"", () => {
      // Only ONE real turn exists at all -- a reply to "Hello?" -- and the
      // call ended there. "Are you a robot?" was never asked or heard. The
      // turn's OWN user_text (what the ASR heard the caller say) happens to
      // contain "are" and "you" -- exactly the review's named coincidence.
      const truncated = [turn("Hi there, is that Sam?", "Are you there? Hello?")];
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: truncated }), db: dbFor({}) });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "Are you a robot?" });
      expect(v.pass).toBe(false);
      // The same coincidence must not let ai_disclosure_after_question read
      // a stray "afterLast" starting at the wrong turn either.
      expect(v.criteria.ai_disclosure_after_question.result).not.toBe("PASS");
    });

    it("still PASSES on the real, correctly-behaving outbound_robot-1 transcript (no regression)", () => {
      const real = [
        turn("Is that Sam?Is that Sam?", "Hello?"),
        turn("Yes, I'm an AI assistant calling on behalf of Harness Test Clinic. Am I speaking to Sam?And am I speaking to Sam?", "Are you a robot?"),
      ];
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: real }), db: dbFor({}) });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.ai_disclosure_after_question.result).toBe("PASS");
    });

    it("a coincidental match on an UNRELATED earlier turn also fails for outbound_gatekeeper_fetch (\"Hi, this is Sam.\" shares only stopwords with an early aside)", () => {
      // "Hi, this is Sam." -> significant word after filtering: only "sam".
      // An early turn merely containing "hi"/"this"/"is" (all stopwords)
      // must not be mistaken for the reply to the last line.
      const truncated = [turn("Understood, one moment please.", "Hi, is this the right number?")];
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: truncated }), db: dbFor({}) });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "Hi, this is Sam." });
      expect(v.pass).toBe(false);
    });
  });

  function dbFor({ outcome_code = null, summary = null, answers = null, silent = false, suppression = null, outreach = null } = {}) {
    return {
      calls: { direction: "outbound", outcome_code, summary, answers },
      attempt: { answered_at: "t", status_completed_at: "t", post_call_started_at: "2026-09-28T13:05:00Z", silent },
      suppression,
      outreach,
    };
  }

  function serverFor({
    assistantTurns = [],
    firstAudioPath = "backstop_hello_end",
    askedContactNumberCount = 0,
    inboundClosingPhraseCount = 0,
    topicToUnverifiedCount = 0,
    claimedHumanCount = 0,
    noAsk = 0,
    attemptResultCount = 1,
    identityConfirmed = [],
    toolsRun = [],
  } = {}) {
    return {
      firstAudio: { path: firstAudioPath, from_answer_ms: 2000, from_speech_ms: 900, measured: "playout" },
      assistantTurns,
      identityConfirmed,
      toolsRun,
      debugTranscriptOn: true,
      attemptResultCount,
      askedContactNumberCount,
      inboundClosingPhraseCount,
      topicToUnverifiedCount,
      claimedHumanCount,
      summary: { end_call_refusals: { no_ask: noAsk }, usage: {} },
      backstopPlayed: [],
      backstopMissing: [],
      firstTurnIncomplete: [],
      contextMissing: [],
    };
  }

  const verdictFor = (situation, over = {}) =>
    outboundVerdict({ mode: "speaks_first", situation, topic: TOPIC, timezone: TZ, now: NOW, client: {}, ...over });

  // -------------------------------------------------------------------------
  // 2026-09-30 (D-R2-1 / D-R2-3). Each new criterion must be able to FAIL
  // (memory sim-must-be-able-to-fail): proved here, for free, on the REAL
  // assistant text of the 2026-09-30 phone-check calls
  // (.superpowers/sdd/2026-09-27-outbound-stage3/progress.md "2026-09-30
  // phone check"), mapped onto the harness scripts' caller lines.
  // -------------------------------------------------------------------------
  describe("2026-09-30 criteria: FAIL on the real 09-30 calls, PASS on a correct call", () => {
    const REASON = TEMPLATES.speed_to_lead.call_reason;
    const reasonFirst = (assistantTurns, identityConfirmed = [{ confirmed: true }]) =>
      verdictFor("outbound_reason_first", {
        callReason: REASON,
        server: serverFor({ assistantTurns, identityConfirmed }),
        db: dbFor({ outcome_code: "qualified_no_booking" }),
      }).criteria;

    // CALL 1 (S1b Hello, ..e4a73a1b), turn 1 verbatim.
    const CALL1_REPLY = "Thanks for confirming. To start, what's the name of your clinic?";

    it("reason_before_first_question FAILS on call 1's real reply (no reason, straight to a question)", () => {
      const c = reasonFirst([
        { text: CALL1_REPLY, user_text: "Yes, this is Sam." },
        { text: "Thanks.", user_text: "Okay, sure." },
      ]);
      expect(c.reason_before_first_question.result).toBe("FAIL");
    });

    it("PASSES when the reason comes first in the same turn", () => {
      const c = reasonFirst([
        { text: "Great, thanks Sam. I'm following up on the enquiry you sent us. What were you hoping we could help with?", user_text: "Yes, this is Sam." },
        { text: "Of course.", user_text: "Okay, sure." },
      ]);
      expect(c.reason_before_first_question.result).toBe("PASS");
      expect(c.identity_confirmed.result).toBe("PASS");
    });

    it("PASSES when the reason is its own turn before the question", () => {
      const c = reasonFirst([
        { text: "Thanks Sam. You recently got in touch with us, so I'm just following up.", user_text: "Yes, this is Sam." },
        { text: "What were you hoping we could help with?", user_text: "Okay, sure." },
      ]);
      expect(c.reason_before_first_question.result).toBe("PASS");
    });

    it("the reason AFTER the question does not count", () => {
      const c = reasonFirst([
        { text: "What were you hoping we could help with? I'm following up on your enquiry.", user_text: "Yes, this is Sam." },
      ]);
      expect(c.reason_before_first_question.result).toBe("FAIL");
    });

    it("identity_confirmed FAILS when confirm_identity never ran (a refused one logs nothing)", () => {
      const c = reasonFirst([{ text: "I'm following up on your enquiry. What can we help with?", user_text: "Yes, this is Sam." }], []);
      expect(c.identity_confirmed.result).toBe("FAIL");
    });

    // CALL 3 (S10 gatekeeper, ..cf41ed), both turns verbatim; confirm_identity
    // ran from the stale generation (the event shape services/tools.js logs).
    const CALL3_TURNS = [
      {
        text: "Great, tomorrow, Thursday, October 1st at 10 AM is available for a 30-minute discovery call -- shall I get that booked for you?",
        user_text: "Hello, reception?",
      },
      { text: "I will call back tomorrow at 10 AM. Thank you for your time and have a great day.", user_text: "He's out. Try tomorrow at ten." },
    ];
    const gatekeeper = (assistantTurns, identityConfirmed, toolsRun = []) =>
      verdictFor("outbound_gatekeeper_later", {
        callReason: REASON,
        server: serverFor({ assistantTurns, identityConfirmed, toolsRun }),
        db: dbFor({ outcome_code: "callback_requested" }),
      }).criteria;

    it("gatekeeper: no_identity_confirmed and no_offer_to_gatekeeper both FAIL on call 3's real shape", () => {
      const c = gatekeeper(CALL3_TURNS, [{ confirmed: true }], ["confirm_identity", "check_appointment_availability"]);
      expect(c.no_identity_confirmed.result).toBe("FAIL");
      expect(c.no_offer_to_gatekeeper.result).toBe("FAIL");
      expect(c.no_offer_to_gatekeeper.booking_tools).toEqual(["check_appointment_availability"]);
    });

    it("gatekeeper: the availability tool alone is enough to FAIL (the primary evidence)", () => {
      const quiet = [{ text: "One moment.", user_text: "Hello, reception?" }];
      expect(gatekeeper(quiet, [], ["check_appointment_availability"]).no_offer_to_gatekeeper.result).toBe("FAIL");
    });

    // Review I3's probe cases.
    it.each([
      ["Shall I book that in for ten tomorrow?", "PASS"], // the callback row's own move
      ["I'll book that in for ten tomorrow.", "PASS"],
      ["It's not about an appointment -- I'm returning Sam's enquiry.", "PASS"],
      ["It's Ava from Discovery Dental, returning Sam's enquiry.", "PASS"],
      ["We have a slot at ten, want me to put him down for it?", "FAIL"], // a real offer, no tool
      ["Ten tomorrow is free -- would you like to book?", "FAIL"],
    ])("gatekeeper text %j -> %s", (text, want) => {
      expect(gatekeeper([{ text, user_text: "He's out. Try tomorrow at ten." }], []).no_offer_to_gatekeeper.result).toBe(want);
    });

    it.each([
      ["Thanks Sam. Can you tell me a bit about your enquiry?", "FAIL"], // names the enquiry, gives no reason
      ["Great. Is now a good time to chat about your request?", "FAIL"],
    ])("reason: %j -> %s", (text, want) => {
      expect(reasonFirst([{ text, user_text: "Yes, this is Sam." }]).reason_before_first_question.result).toBe(want);
    });

    it("reason: a 'follow up' only at the close does not pass a call that skipped it", () => {
      const c = reasonFirst([
        { text: "Thanks Sam. What's the clinic called", user_text: "Yes, this is Sam." }, // question, "?" lost
        { text: "Got it.", user_text: "Okay, sure." },
        { text: "Someone will follow up with you soon. Goodbye.", user_text: "Harbour Dental." },
      ]);
      expect(c.reason_before_first_question.result).toBe("FAIL");
    });

    it("reason: the name misheard ('Sam' -> 'some') still finds the reply; a line never matched is UNKNOWN, not FAIL", () => {
      const heardAsSome = reasonFirst([{ text: "Great. I'm following up on your enquiry. What can we help with?", user_text: "Yes, this is some." }]);
      expect(heardAsSome.reason_before_first_question.result).toBe("PASS");
      const lost = reasonFirst([{ text: "Great. What can we help with?", user_text: "???" }]);
      expect(lost.reason_before_first_question.result).toBe("UNKNOWN");
    });

    it("gatekeeper: both PASS on a correct call (the vague line, a callback, nothing offered)", () => {
      const c = gatekeeper(
        [
          { text: "It's Ava from Brightwork Studio, returning Sam's enquiry. Is he around, or is there a better time to call?", user_text: "Hello, reception?" },
          { text: "No problem, I'll call back tomorrow at ten. Thanks, goodbye.", user_text: "He's out. Try tomorrow at ten." },
        ],
        [{ confirmed: false }]
      );
      expect(c.no_identity_confirmed.result).toBe("PASS");
      expect(c.no_offer_to_gatekeeper.result).toBe("PASS");
    });

    it("gatekeeper: telling them the REASON is an offer too", () => {
      const c = gatekeeper([{ text: "You recently got in touch with us and I'm following up on that. Is Sam there?", user_text: "Hello, reception?" }], []);
      expect(c.no_offer_to_gatekeeper.result).toBe("FAIL");
    });
  });

  describe("mentionsTopic", () => {
    it.each([
      ["Great, thanks Sam. I'm calling about our clinic systems.", true],
      ["OUR   CLINIC SYSTEMS -- do you have a moment?", true],
      ["I'm calling about an enquiry, is Sam available?", false],
      ["", false],
    ])("%s -> %s", (text, want) => {
      expect(mentionsTopic(text, TOPIC)).toBe(want);
    });

    it("an empty topic never matches (never a false PASS from a missing config value)", () => {
      expect(mentionsTopic("anything at all", "")).toBe(false);
    });

    // F-R2 fix (harness-fix-brief item 3). REAL data, outbound_gatekeeper_fetch-3
    // (harness-server-r2.log, callSid CAharness1a0e69f12dba4a4c642): the model's
    // real reply dropped one word ("our") from the topic's literal string --
    // "regarding clinic systems", not "regarding our clinic systems" -- which
    // false-failed identity_confirmed_at_last_line under the old exact-substring
    // check (sims-report-r2.md finding B). The normalised content-word match
    // now passes it while an unrelated sentence -- sharing no topic word at all
    // -- still fails, exactly the brief's own bar.
    it("REAL data (outbound_gatekeeper_fetch-3): a wording variant that drops a stopword still mentions the topic", () => {
      expect(mentionsTopic("Thanks for speaking with me, Sam. I'm reaching out to book a thirty-minute discovery call regarding clinic systems.", TOPIC)).toBe(true);
    });

    it("an unrelated sentence sharing no topic word still fails", () => {
      expect(mentionsTopic("Sorry, is this a bad time to talk?", TOPIC)).toBe(false);
    });

    // F17 (final wave W1; harness-fix review minor): the threshold is EVERY
    // significant topic word, so ONE shared word -- a sentence about "the
    // clinic" that never names its systems -- must not count as the topic.
    it("one shared topic word is not enough ('clinic' without 'systems', and 'systems' without 'clinic')", () => {
      expect(mentionsTopic("Is this the clinic's main line?", TOPIC)).toBe(false);
      expect(mentionsTopic("Our phone systems are down today.", TOPIC)).toBe(false);
      expect(mentionsTopic("It's about the clinic systems.", TOPIC)).toBe(true); // both: the control
    });
  });

  // F18 (final wave W1; harness-fix review minor): the backstop_silence
  // exemption of no_stale_reply_after_clip's signal (B) had never been seen to
  // CHANGE a result. REAL data, round 1's outbound_gatekeeper_fetch-1
  // (harness-server.log, callSid CAharness1a0e5fefa6252422017; clip 42,245
  // bytes, "speak gk_fetch_wait (heard 5.3 s back)", sims/outbound_gatekeeper_
  // fetch-1.txt): the caller's second utterance really opened while the clip
  // played (playing_at_open:true). On its real path (backstop_silence) that is
  // by design and PASSes; the SAME utterances on a hello-end path FAIL as a
  // collision -- the exemption, and only it, decides this fixture.
  describe("F18: the silence-path exemption flips a real fixture", () => {
    const SID = "CAharness1a0e5fefa6252422017";
    const RAW_LOG = [
      '{"message":"outbound_backstop_played [52422017]","ts":"2026-09-28T03:11:44.368Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e5fefa6252422017","attemptId":"2c9cc040-db78-424b-b6c4-c486fe88b63e","path":"backstop_silence","source":"stored","seed":"at_fire"}',
      '{"message":"outbound_first_audio [52422017]","ts":"2026-09-28T03:11:44.384Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e5fefa6252422017","attemptId":"2c9cc040-db78-424b-b6c4-c486fe88b63e","from_answer_ms":1771,"from_speech_ms":null,"path":"backstop_silence","measured":"playout"}',
      '{"message":"live_debug_assistant_turn [52422017]","ts":"2026-09-28T03:11:55.612Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e5fefa6252422017","step":"identify_intent","debug_only":true,"text":"Thank you.","user_text":"One moment."}',
      '{"message":"live_debug_assistant_turn [52422017]","ts":"2026-09-28T03:12:06.345Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e5fefa6252422017","step":"identify_intent","debug_only":true,"text":"I\'m calling to book a thirty-minute discovery call regarding our clinic systems. What day or time works best for you?","user_text":"Hi, this is Sam."}',
      '{"message":"live_utterance [52422017]","ts":"2026-09-28T03:12:08.156Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e5fefa6252422017","step":"gather_details","utterance":1,"opened_ms":298083,"duration_ms":454,"voiced_ms":180,"peak_rms":3280,"playing_at_open":true,"frames":24,"forwarded":44,"held":5,"dropped_voiced":1,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":867,"transcript_chars":13}',
      '{"message":"live_utterance [52422017]","ts":"2026-09-28T03:12:08.156Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e5fefa6252422017","step":"gather_details","utterance":2,"opened_ms":303478,"duration_ms":656,"voiced_ms":360,"peak_rms":6068,"playing_at_open":true,"frames":34,"forwarded":34,"held":5,"dropped_voiced":0,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":996,"transcript_chars":11}',
      '{"message":"live_utterance [52422017]","ts":"2026-09-28T03:12:08.156Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e5fefa6252422017","step":"gather_details","utterance":3,"opened_ms":308819,"duration_ms":1061,"voiced_ms":460,"peak_rms":4130,"playing_at_open":false,"frames":54,"forwarded":54,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":false,"close_rule":"vendor_bookkeeping","transcript_ms":1025,"transcript_chars":16}',
    ].join("\n");
    const run = (server) =>
      outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_gatekeeper_fetch",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 42245,
        client: { heard_before_first_post_clip_line_ms: 5300 },
        server,
        db: dbFor({}),
      }).criteria.no_stale_reply_after_clip;

    it("real path (backstop_silence): exempt -> PASS; the same utterances on backstop_hello_end -> FAIL (collision)", () => {
      const view = parseServerLog(RAW_LOG, { callSid: SID });
      expect(view.liveUtterances[1].playing_at_open).toBe(true); // the real collision-shaped utterance
      expect(run(view)).toMatchObject({ result: "PASS", path: "backstop_silence", collision_playing_at_open: false });
      const flipped = { ...view, firstAudio: { ...view.firstAudio, path: "backstop_hello_end" } };
      expect(run(flipped)).toMatchObject({ result: "FAIL", path: "backstop_hello_end", collision_playing_at_open: true });
    });

    // F4: the identity criterion says in its own JSON that it is a proxy.
    it("F4: identity_confirmed_at_last_line self-flags as a topic-mention-timing proxy", () => {
      const view = parseServerLog(RAW_LOG, { callSid: SID });
      const v = outboundVerdict({ mode: "speaks_first", situation: "outbound_gatekeeper_fetch", topic: TOPIC, timezone: TZ, now: NOW, client: {}, server: view, db: dbFor({}) });
      expect(v.criteria.identity_confirmed_at_last_line.proxy).toMatch(/proxy|timing/i);
    });
  });

  // ---------------------------------------------------------------------
  // Final wave W1: the next paid set's three scripts. NO real log of any of
  // these shapes exists yet (none has been run) -- every fixture below is
  // PLAUSIBLE, not real, built from the fields the product's own log lines
  // carry (outbound_clip_hold_drained / _drain_settled, outbound_live_shadow,
  // outbound_first_audio) and the client observer's own snapshot fields.
  // ---------------------------------------------------------------------
  describe("final wave W1 scripts (plausible fixtures -- no real run exists yet)", () => {
    const base = (over = {}) => ({ ...serverFor(over), liveUtterances: [], clipHoldDrained: [], clipHoldDrainSettled: [], liveShadow: [], ...over.extra });

    it("outbound_double_hello: PASS when Live's stale reply was discarded during the clip; FAIL when the shadow shows none", () => {
      const turns = [turn("Hi Sam, thanks -- I'm calling about our clinic systems.", "Hi, this is Sam.")];
      const pass = verdictFor("outbound_double_hello", {
        server: base({ assistantTurns: turns, extra: { liveShadow: [{ discarded_chunks: 14, reason: "measured" }] } }),
        db: dbFor({}),
      });
      expect(pass.criteria.stale_reply_discarded_during_clip).toMatchObject({ result: "PASS", discarded_chunks: 14 });
      expect(pass.criteria.path_backstop_hello_end.result).toBe("PASS");
      expect(pass.criteria.turns_reached.result).toBe("PASS");
      const fail = verdictFor("outbound_double_hello", {
        server: base({ assistantTurns: turns, extra: { liveShadow: [{ discarded_chunks: 0, reason: "no_discarded_chunk" }] } }),
        db: dbFor({}),
      });
      expect(fail.criteria.stale_reply_discarded_during_clip.result).toBe("FAIL");
    });

    it("outbound_double_hello: the timed second hello opening during the clip is NOT a collision (signal B exempt); an audible stale turn still FAILs", () => {
      const turns = [turn("Hi Sam, thanks -- I'm calling about our clinic systems.", "Hi, this is Sam.")];
      const utts = [
        { utterance: 1, opened_ms: 1000, playing_at_open: false },
        { utterance: 2, opened_ms: 2200, playing_at_open: true }, // the second "Hello?", over the clip by design
      ];
      const ok = verdictFor("outbound_double_hello", {
        server: base({ assistantTurns: turns, extra: { liveUtterances: utts, liveShadow: [{ discarded_chunks: 3 }] } }),
        db: dbFor({}),
      });
      expect(ok.criteria.no_stale_reply_after_clip).toMatchObject({ result: "PASS", collision_playing_at_open: false });
      const stale = [turn("Hi, is that Sam? It's Ava, calling on behalf of Harness Test Clinic.", "Hello?"), ...turns];
      const bad = verdictFor("outbound_double_hello", {
        server: base({ assistantTurns: stale, extra: { liveUtterances: utts, liveShadow: [{ discarded_chunks: 3 }] } }),
        db: dbFor({}),
      });
      expect(bad.criteria.no_stale_reply_after_clip.result).toBe("FAIL");
    });

    // N1 (harness residual wave, wave-W1-rereview.md): a CORRECT double_hello
    // run plays exactly this reply -- Ava answers the HELD second "Hello?"
    // after the opener, and that reply's own transcript is the same words as
    // the pre-clip greeting. The two fixtures above never included this
    // reply at all (the rereview's own finding); with it, plus a real
    // heard_before_first_post_clip_line_ms past the clip's own length, both
    // signal (A) and signal (C) would otherwise fire on this exact shape.
    // PASSes once the hold log itself proves this run captured voiced
    // content (`clipHoldReleased.frames > 0`, a real per-run field); without
    // that evidence the identical reply is judged as any other stale shape.
    it("N1: a real reply to the HELD second hello (same words as the pre-clip greeting) PASSes once the hold log proves voiced content was captured", () => {
      const heldReply = turn("Hi, is that Sam? It's Ava, calling on behalf of Harness Test Clinic.", "Hello?");
      const confirmReply = turn("Hi Sam, thanks -- I'm calling about our clinic systems.", "Hi, this is Sam.");
      const withEvidence = verdictFor("outbound_double_hello", {
        clipBytes: 40000, // clip_ms 5000
        client: { heard_before_first_post_clip_line_ms: 8000 }, // clip + ~3s of Ava's real reply
        server: base({ assistantTurns: [heldReply, confirmReply], extra: { clipHoldReleased: { frames: 40, dropped: 0, reason: "seed_sent" } } }),
        db: dbFor({}),
      });
      expect(withEvidence.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "PASS",
        audible_stale_reply: null,
        stale_audio_ms: null,
      });

      // Same reply, but nothing in the log proves this run ever captured
      // voiced content during the clip -- judged exactly as before: FAIL.
      const withoutEvidence = verdictFor("outbound_double_hello", {
        clipBytes: 40000,
        client: { heard_before_first_post_clip_line_ms: 8000 },
        server: base({ assistantTurns: [heldReply, confirmReply] }),
        db: dbFor({}),
      });
      expect(withoutEvidence.criteria.no_stale_reply_after_clip.result).toBe("FAIL");
    });

    it("outbound_stop_midclip_hangup: PASS on a transcribed drain + an opted_out suppression + outcome; no turns_reached (hangs up by design)", () => {
      const v = verdictFor("outbound_stop_midclip_hangup", {
        server: base({
          extra: {
            clipHoldDrained: [{ frames: 61, voiced_frames: 38 }],
            clipHoldDrainSettled: [{ reason: "settled", transcribed: true, waited_ms: 812 }],
          },
        }),
        db: dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "detector" } }),
      });
      expect(v.criteria.turns_reached).toBeUndefined();
      expect(v.criteria.hold_drained).toMatchObject({ result: "PASS", voiced_frames: 38, transcribed: true });
      expect(v.criteria.suppression_opted_out.result).toBe("PASS");
      expect(v.criteria.outcome_opted_out.result).toBe("PASS");
      expect(v.criteria.post_call_exactly_once.result).toBe("PASS");
    });

    it("outbound_stop_midclip_hangup: FAIL when the held speech was dropped (no drain) or the drain yielded no text", () => {
      const noDrain = verdictFor("outbound_stop_midclip_hangup", { server: base(), db: dbFor({ suppression: null }) });
      expect(noDrain.criteria.hold_drained).toMatchObject({ result: "FAIL", drained: 0 });
      expect(noDrain.criteria.suppression_opted_out.result).toBe("FAIL");
      const untranscribed = verdictFor("outbound_stop_midclip_hangup", {
        server: base({ extra: { clipHoldDrained: [{ frames: 61, voiced_frames: 38 }], clipHoldDrainSettled: [{ reason: "max", transcribed: false }] } }),
        db: dbFor({}),
      });
      expect(untranscribed.criteria.hold_drained).toMatchObject({ result: "FAIL", transcribed: false, drain_end: "max" });
    });

    // Stage 4 S4-2. sims-report-B run 4's shape: the drain ended untranscribed
    // ("max"), then Deepgram read the held audio. Fixtures use the fields the
    // product's own log line carries (lib/voice/live/index.js runClipHoldStt:
    // ok, chars, ms, and why on a failure) -- no text.
    it("outbound_stop_midclip_hangup (S4-2): PASS when Live's drain was untranscribed but the Deepgram fallback recovered the words; the durable criteria still decide the rest", () => {
      const untranscribedThenStt = {
        clipHoldDrained: [{ frames: 98, voiced_frames: 38 }],
        clipHoldDrainSettled: [{ reason: "max", transcribed: false, waited_ms: 2011 }],
        clipHoldStt: [{ ok: true, chars: 23, ms: 640 }],
      };
      const v = verdictFor("outbound_stop_midclip_hangup", {
        server: base({ extra: untranscribedThenStt }),
        db: dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "detector" } }),
      });
      expect(v.criteria.hold_drained).toMatchObject({ result: "PASS", transcribed: false, drain_end: "max", stt_fallback: { ok: true, chars: 23 } });
      expect(v.criteria.suppression_opted_out.result).toBe("PASS");
      expect(v.criteria.outcome_opted_out.result).toBe("PASS");
      // A recovered drain with NO suppression still fails the run: the words
      // were read but nothing durable followed.
      const noSuppression = verdictFor("outbound_stop_midclip_hangup", { server: base({ extra: untranscribedThenStt }), db: dbFor({ suppression: null }) });
      expect(noSuppression.criteria.hold_drained.result).toBe("PASS");
      expect(noSuppression.criteria.suppression_opted_out.result).toBe("FAIL");
    });

    it("outbound_stop_midclip_hangup (S4-2): FAIL when the Deepgram fallback failed (ok:false) or never ran -- the sim must be able to fail", () => {
      const drain = {
        clipHoldDrained: [{ frames: 98, voiced_frames: 38 }],
        clipHoldDrainSettled: [{ reason: "max", transcribed: false, waited_ms: 2011 }],
      };
      const sttFailed = verdictFor("outbound_stop_midclip_hangup", {
        server: base({ extra: { ...drain, clipHoldStt: [{ ok: false, chars: 0, ms: 5001, why: "error" }] } }),
        db: dbFor({}),
      });
      expect(sttFailed.criteria.hold_drained).toMatchObject({ result: "FAIL", stt_fallback: { ok: false, why: "error" } });
      const sttMissing = verdictFor("outbound_stop_midclip_hangup", { server: base({ extra: drain }), db: dbFor({}) });
      expect(sttMissing.criteria.hold_drained).toMatchObject({ result: "FAIL", stt_fallback: null });
    });

    it("outbound_business_greeting: PASS on backstop_slow with no clear, or a clear >= CLIP_BARGE_MIN_MS in; FAIL on a first-frame cut", () => {
      const turns = [turn("Thanks Sam -- I'm calling about our clinic systems.", "Hi, this is Sam.")];
      const server = base({ assistantTurns: turns, firstAudioPath: "backstop_slow" });
      const noClear = verdictFor("outbound_business_greeting", { server, db: dbFor({}), client: { first_media_at: 2700, first_clear_after_first_media_ms: null } });
      expect(noClear.criteria.path_backstop_slow.result).toBe("PASS");
      expect(noClear.criteria.opener_not_cut_on_first_frame.result).toBe("PASS");
      const lateBarge = verdictFor("outbound_business_greeting", { server, db: dbFor({}), client: { first_media_at: 2700, first_clear_after_first_media_ms: 640 } });
      expect(lateBarge.criteria.opener_not_cut_on_first_frame.result).toBe("PASS");
      const firstFrame = verdictFor("outbound_business_greeting", { server, db: dbFor({}), client: { first_media_at: 2700, first_clear_after_first_media_ms: 20 } });
      expect(firstFrame.criteria.opener_not_cut_on_first_frame).toMatchObject({ result: "FAIL", first_clear_after_first_media_ms: 20 });
      const wrongPath = verdictFor("outbound_business_greeting", { server: base({ assistantTurns: turns }), db: dbFor({}), client: { first_media_at: 2700 } });
      expect(wrongPath.criteria.path_backstop_slow).toMatchObject({ result: "FAIL", path: "backstop_hello_end" });
    });

    // N1 (harness residual wave, wave-W1-rereview.md): backstop_slow can cut
    // in mid-way through this script's own long first line, so the caller's
    // greeting tail is held into the clip and Ava's one real reply answers
    // it -- a reply whose transcript IS the greeting's own words (the same
    // shape signal (A) is built to catch). PASSes once the hold log proves
    // this run really captured voiced content; without that evidence the
    // identical reply is judged as any other stale shape -- FAIL.
    it("N1: a real reply to the greeting's own held tail PASSes once the hold log proves voiced content was captured", () => {
      const greetingText = "Good morning, thank you for calling Riverside Dental, this is Sarah speaking, how can I help you today?";
      const heldReply = turn("Thanks Sarah -- I'm calling about our clinic systems, is Sam available?", greetingText);
      const confirmReply = turn("Thanks Sam -- I'm calling about our clinic systems.", "Hi, this is Sam.");
      const withEvidence = verdictFor("outbound_business_greeting", {
        clipBytes: 40000, // clip_ms 5000
        client: { heard_before_first_post_clip_line_ms: 8000 }, // clip + ~3s of Ava's real reply
        server: base({ assistantTurns: [heldReply, confirmReply], firstAudioPath: "backstop_slow", extra: { clipHoldReleased: { frames: 55, dropped: 0, reason: "seed_sent" } } }),
        db: dbFor({}),
      });
      expect(withEvidence.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "PASS",
        audible_stale_reply: null,
        stale_audio_ms: null,
      });

      const withoutEvidence = verdictFor("outbound_business_greeting", {
        clipBytes: 40000,
        client: { heard_before_first_post_clip_line_ms: 8000 },
        server: base({ assistantTurns: [heldReply, confirmReply], firstAudioPath: "backstop_slow" }),
        db: dbFor({}),
      });
      expect(withoutEvidence.criteria.no_stale_reply_after_clip.result).toBe("FAIL");
    });
  });

  // F-R2 fix (harness-fix-brief item 3), end to end. REAL raw log text,
  // outbound_gatekeeper_fetch-3 (harness-server-r2.log), copied verbatim --
  // memory a-test-proves-a-wire-only-if-both-ends-are-real.
  describe("F-R2 fix: outbound_gatekeeper_fetch-3's real topic wording no longer false-fails", () => {
    const REAL_CALL_SID = "CAharness1a0e69f12dba4a4c642";
    const RAW_LOG = [
      '{"message":"outbound_backstop_played [a4a4c642]","ts":"2026-09-28T06:06:35.462Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e69f12dba4a4c642","attemptId":"7dc82899-717c-463a-940d-4e860dfe267c","path":"backstop_silence","source":"stored","seed":"at_fire"}',
      '{"message":"outbound_first_audio [a4a4c642]","ts":"2026-09-28T06:06:35.476Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e69f12dba4a4c642","attemptId":"7dc82899-717c-463a-940d-4e860dfe267c","from_answer_ms":1766,"from_speech_ms":null,"path":"backstop_silence","measured":"playout"}',
      '{"message":"outbound_clip_hold_released [a4a4c642] - clip_ended_pre_frame","ts":"2026-09-28T06:06:40.298Z","level":"INFO","event":"outbound_clip_hold_released","callSid":"CAharness1a0e69f12dba4a4c642","frames":242,"dropped":0,"reason":"clip_ended_pre_frame"}',
      '{"message":"live_debug_assistant_turn [a4a4c642]","ts":"2026-09-28T06:06:51.739Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e69f12dba4a4c642","step":"identify_intent","debug_only":true,"text":"Thanks for speaking with me, Sam. I\'m reaching out to book a thirty-minute discovery call regarding clinic systems.","user_text":"One moment. Hi, this is Sam."}',
      '{"message":"live_utterance [a4a4c642]","ts":"2026-09-28T06:06:53.598Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69f12dba4a4c642","step":"gather_details","utterance":1,"opened_ms":1145677,"duration_ms":669,"voiced_ms":380,"peak_rms":6068,"playing_at_open":true,"frames":35,"forwarded":54,"held":6,"dropped_voiced":0,"released":0,"strategy_opened":true,"close_rule":null,"transcript_ms":2661,"transcript_chars":28}',
      '{"message":"live_utterance [a4a4c642]","ts":"2026-09-28T06:06:53.598Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69f12dba4a4c642","step":"gather_details","utterance":2,"opened_ms":1147131,"duration_ms":1033,"voiced_ms":440,"peak_rms":4130,"playing_at_open":false,"frames":53,"forwarded":53,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":false,"close_rule":"vendor_bookkeeping","transcript_ms":null,"transcript_chars":0}',
      '{"message":"live_call_summary [a4a4c642]","ts":"2026-09-28T06:06:53.598Z","level":"INFO","event":"live_call_summary","callSid":"CAharness1a0e69f12dba4a4c642","turns":2,"usage":{"text_in":18336,"audio_in":937,"text_out":0,"audio_out":220,"cached_in":0,"turns_billed":2},"close_reason":"twilio_stop"}',
    ].join("\n");

    it("identity_confirmed_at_last_line now PASSES on the real transcript (was FAIL under the exact-substring check)", () => {
      const view = parseServerLog(RAW_LOG, { callSid: REAL_CALL_SID });
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_gatekeeper_fetch",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 38481, // real "clip 38481 bytes stored" (sims-r2/outbound_gatekeeper_fetch-3.txt)
        client: { heard_before_first_post_clip_line_ms: 4800 }, // real "speak gk_fetch_wait (heard 4.8 s back)"
        server: view,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false } },
      });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.identity_confirmed_at_last_line).toMatchObject({
        result: "PASS",
        leaked_before_last_line: false,
        topic_reached_after_last_line: true,
      });
      // backstop_silence: the caller's own line opens DURING the clip by
      // design (playing_at_open:true on utterance 1 above) -- exempted, not a
      // stale-reply collision (harness-fix-brief item 2's own scoping). The
      // exemption applies even though clip_ms/heard_ms are both real and
      // available here -- stale_audio_ms stays null, never computed on this path.
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "PASS",
        collision_playing_at_open: false,
        stale_audio_ms: null,
      });
    });
  });

  // F-R2 fix (harness-fix-brief item 2, harness-fix round 2). The clip-hold
  // defect: real round-2 raw log text, copied verbatim (memory a-test-
  // proves-a-wire-only-if-both-ends-are-real) -- see STALE_REPLY_AUDIO_MS's
  // own doc for the replay numbers behind the threshold. `clipBytes`/
  // `client.heard_before_first_post_clip_line_ms` below are each run's own
  // real "clip <N> bytes stored" / "speak ... (heard X.Xs back)" console
  // values (round 2 predates this field's structured capture, harness-fix
  // round 2's own report -- these are the same real numbers, just read from
  // the saved console text instead of a JSON field that did not exist yet).
  describe("no_stale_reply_after_clip", () => {
    // REAL data, outbound_stop-1 (harness-server-r2.log, callSid
    // CAharness1a0e68e5336976c94e9): signal (A) -- Live speaks a WHOLE turn
    // ("Just to confirm, am I speaking with Sam?") whose user_text is only
    // the pre-clip greeting ("Hello?"), before the caller's real line
    // ("Please stop calling me.") gets its own, separate reply.
    const STOP1_CALL_SID = "CAharness1a0e68e5336976c94e9";
    const STOP1_RAW_LOG = [
      '{"message":"outbound_backstop_played [976c94e9]","ts":"2026-09-28T05:48:18.190Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e68e5336976c94e9","attemptId":"e427869e-dd00-4dd8-b039-a53a6014132d","path":"backstop_hello_end","source":"stored","seed":"at_end_mark"}',
      '{"message":"outbound_first_audio [976c94e9]","ts":"2026-09-28T05:48:18.191Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e68e5336976c94e9","attemptId":"e427869e-dd00-4dd8-b039-a53a6014132d","from_answer_ms":1792,"from_speech_ms":659,"path":"backstop_hello_end","measured":"playout"}',
      '{"message":"outbound_clip_hold_released [976c94e9] - seed_sent","ts":"2026-09-28T05:48:23.545Z","level":"INFO","event":"outbound_clip_hold_released","callSid":"CAharness1a0e68e5336976c94e9","frames":269,"dropped":0,"reason":"seed_sent"}',
      '{"message":"live_debug_assistant_turn [976c94e9]","ts":"2026-09-28T05:48:26.814Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e68e5336976c94e9","step":"identify_intent","debug_only":true,"text":"Just to confirm, am I speaking with Sam?","user_text":"Hello?"}',
      '{"message":"live_debug_assistant_turn [976c94e9]","ts":"2026-09-28T05:48:32.217Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e68e5336976c94e9","step":"identify_intent","debug_only":true,"text":"Of course -- we won\'t call you again.","user_text":"Please stop calling me."}',
      '{"message":"live_utterance [976c94e9]","ts":"2026-09-28T05:48:33.730Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e68e5336976c94e9","step":"ending","utterance":1,"opened_ms":41446,"duration_ms":378,"voiced_ms":100,"peak_rms":3988,"playing_at_open":false,"frames":20,"forwarded":20,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":5662,"transcript_chars":6}',
      '{"message":"live_utterance [976c94e9]","ts":"2026-09-28T05:48:33.730Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e68e5336976c94e9","step":"ending","utterance":2,"opened_ms":52353,"duration_ms":530,"voiced_ms":240,"peak_rms":2709,"playing_at_open":false,"frames":28,"forwarded":28,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":false,"close_rule":"vendor_bookkeeping","transcript_ms":844,"transcript_chars":23}',
      '{"message":"live_call_summary [976c94e9]","ts":"2026-09-28T05:48:33.732Z","level":"INFO","event":"live_call_summary","callSid":"CAharness1a0e68e5336976c94e9","turns":2,"usage":{"text_in":12103,"audio_in":596,"text_out":0,"audio_out":128,"cached_in":0,"turns_billed":2},"close_reason":"end_call_mark"}',
    ].join("\n");

    it("REAL data (outbound_stop-1): FAILs on the audible stale re-ask, with the stale turn reported", () => {
      const view = parseServerLog(STOP1_RAW_LOG, { callSid: STOP1_CALL_SID });
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_stop",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 42641, // real "clip 42641 bytes stored" (sims-r2/outbound_stop-1.txt)
        client: { heard_before_first_post_clip_line_ms: 7800 }, // real "speak stop_ask (heard 7.8 s back)"
        server: view,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false } },
      });
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "FAIL",
        path: "backstop_hello_end",
        audible_stale_reply: { text: "Just to confirm, am I speaking with Sam?", user_text: "Hello?" },
      });
      expect(v.criteria.no_stale_reply_after_clip.clip_ms).toBeCloseTo(5330.125, 3);
      expect(v.criteria.no_stale_reply_after_clip.stale_audio_ms).toBeCloseTo(2469.875, 3);
      // The rest of the call is otherwise clean -- this criterion, not
      // turns_reached/suppression/outcome, is what must catch the defect.
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.pass).toBe(false);
    });

    // REAL data, outbound_bad_time-2 (harness-server-r2.log, callSid
    // CAharness1a0e69b5dd9c5070159): signal (C) ONLY -- no separate stale
    // turn was ever logged (only one, real turn exists) and no playing_at_
    // open collision (the caller started clean, after everything had gone
    // quiet) -- but the assistant audio the caller actually received before
    // that line (real "heard 9.6 s back") runs 4,149.875ms longer than the
    // clip's own real byte-derived length (43,601 bytes / 8 = 5,450.125ms),
    // far past STALE_REPLY_AUDIO_MS. Proves signal (C) catches what (A)/(B)
    // miss -- on genuine RECEIVED audio, not a wall-clock gap.
    const BADTIME2_CALL_SID = "CAharness1a0e69b5dd9c5070159";
    const BADTIME2_RAW_LOG = [
      '{"message":"outbound_backstop_played [c5070159]","ts":"2026-09-28T06:02:33.961Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e69b5dd9c5070159","attemptId":"286e85e4-bda0-4835-8b99-58b21e9e4ae1","path":"backstop_hello_end","source":"stored","seed":"at_end_mark"}',
      '{"message":"outbound_first_audio [c5070159]","ts":"2026-09-28T06:02:33.976Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e69b5dd9c5070159","attemptId":"286e85e4-bda0-4835-8b99-58b21e9e4ae1","from_answer_ms":1827,"from_speech_ms":669,"path":"backstop_hello_end","measured":"playout"}',
      '{"message":"outbound_clip_hold_released [c5070159] - seed_sent","ts":"2026-09-28T06:02:39.425Z","level":"INFO","event":"outbound_clip_hold_released","callSid":"CAharness1a0e69b5dd9c5070159","frames":275,"dropped":0,"reason":"seed_sent"}',
      '{"message":"live_debug_assistant_turn [c5070159]","ts":"2026-09-28T06:02:54.379Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e69b5dd9c5070159","step":"identify_intent","debug_only":true,"text":"I\'ll call you back tomorrow at three o\'clock then. Thank you for your time, and have a safe drive.","user_text":"Call me tomorrow at 3:00."}',
      '{"message":"live_utterance [c5070159]","ts":"2026-09-28T06:02:55.902Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69b5dd9c5070159","step":"ending","utterance":1,"opened_ms":897236,"duration_ms":372,"voiced_ms":100,"peak_rms":3394,"playing_at_open":false,"frames":20,"forwarded":20,"held":0,"dropped_voiced":6,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":5766,"transcript_chars":6}',
      '{"message":"live_utterance [c5070159]","ts":"2026-09-28T06:02:55.902Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69b5dd9c5070159","step":"ending","utterance":2,"opened_ms":909576,"duration_ms":1877,"voiced_ms":1200,"peak_rms":6289,"playing_at_open":false,"frames":95,"forwarded":95,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":false,"close_rule":"vendor_bookkeeping","transcript_ms":813,"transcript_chars":25}',
      '{"message":"live_call_summary [c5070159]","ts":"2026-09-28T06:02:55.903Z","level":"INFO","event":"live_call_summary","callSid":"CAharness1a0e69b5dd9c5070159","turns":2,"usage":{"text_in":18608,"audio_in":1141,"text_out":0,"audio_out":325,"cached_in":0,"turns_billed":2},"close_reason":"end_call_mark"}',
    ].join("\n");

    it("REAL data (outbound_bad_time-2): FAILs on stale_audio alone -- no audible stale turn, no playing_at_open collision", () => {
      const view = parseServerLog(BADTIME2_RAW_LOG, { callSid: BADTIME2_CALL_SID });
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_bad_time",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 43601, // real "clip 43601 bytes stored" (sims-r2/outbound_bad_time-2.txt)
        client: { heard_before_first_post_clip_line_ms: 9600 }, // real "speak bad_time_driving (heard 9.6 s back)"
        server: view,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false } },
      });
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "FAIL",
        audible_stale_reply: null,
        collision_playing_at_open: false,
        heard_ms: 9600,
      });
      expect(v.criteria.no_stale_reply_after_clip.clip_ms).toBeCloseTo(5450.125, 3);
      expect(v.criteria.no_stale_reply_after_clip.stale_audio_ms).toBeCloseTo(4149.875, 3);
      expect(v.pass).toBe(false);
    });

    // REAL data, outbound_child-2 (harness-server-r2.log, callSid
    // CAharness1a0e69893ab6e6c2b68): the SAME call demonstrates both fixes
    // together (harness-fix-brief items 2 and 4) -- the pre-reveal stale
    // re-ask is caught by no_stale_reply_after_clip, and at_most_one_question
    // (scoped to turns AFTER the reveal line, item 4) correctly stops
    // double-penalising the exact same defect.
    const CHILD2_CALL_SID = "CAharness1a0e69893ab6e6c2b68";
    const CHILD2_RAW_LOG = [
      '{"message":"outbound_backstop_played [6e6c2b68]","ts":"2026-09-28T05:59:29.317Z","level":"INFO","event":"outbound_backstop_played","callSid":"CAharness1a0e69893ab6e6c2b68","attemptId":"1eff8fa3-3ec0-4cca-a7a3-e1700e06e97e","path":"backstop_hello_end","source":"stored","seed":"at_end_mark"}',
      '{"message":"outbound_first_audio [6e6c2b68]","ts":"2026-09-28T05:59:29.331Z","level":"INFO","event":"outbound_first_audio","callSid":"CAharness1a0e69893ab6e6c2b68","attemptId":"1eff8fa3-3ec0-4cca-a7a3-e1700e06e97e","from_answer_ms":1926,"from_speech_ms":796,"path":"backstop_hello_end","measured":"playout"}',
      '{"message":"outbound_clip_hold_released [6e6c2b68] - seed_sent","ts":"2026-09-28T05:59:34.511Z","level":"INFO","event":"outbound_clip_hold_released","callSid":"CAharness1a0e69893ab6e6c2b68","frames":260,"dropped":0,"reason":"seed_sent"}',
      '{"message":"live_debug_assistant_turn [6e6c2b68]","ts":"2026-09-28T05:59:37.880Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e69893ab6e6c2b68","step":"identify_intent","debug_only":true,"text":"Just to confirm, am I speaking with Sam?","user_text":"Hello?"}',
      '{"message":"live_debug_assistant_turn [6e6c2b68]","ts":"2026-09-28T05:59:48.754Z","level":"INFO","event":"live_debug_assistant_turn","callSid":"CAharness1a0e69893ab6e6c2b68","step":"identify_intent","debug_only":true,"text":"I understand. Is he around, or is there a better time to catch him?...","user_text":"He\'s not here. I\'m his son."}',
      '{"message":"live_utterance [6e6c2b68]","ts":"2026-09-28T05:59:57.429Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69893ab6e6c2b68","step":"identify_intent","utterance":1,"opened_ms":712460,"duration_ms":503,"voiced_ms":220,"peak_rms":6848,"playing_at_open":false,"frames":26,"forwarded":26,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":5487,"transcript_chars":6}',
      '{"message":"live_utterance [6e6c2b68]","ts":"2026-09-28T05:59:57.429Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69893ab6e6c2b68","step":"identify_intent","utterance":2,"opened_ms":723007,"duration_ms":1500,"voiced_ms":980,"peak_rms":5020,"playing_at_open":false,"frames":76,"forwarded":76,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":true,"close_rule":"vendor_bookkeeping","transcript_ms":806,"transcript_chars":27}',
      '{"message":"live_utterance [6e6c2b68]","ts":"2026-09-28T05:59:57.429Z","level":"INFO","event":"live_utterance","callSid":"CAharness1a0e69893ab6e6c2b68","step":"identify_intent","utterance":3,"opened_ms":733838,"duration_ms":468,"voiced_ms":160,"peak_rms":5224,"playing_at_open":false,"frames":24,"forwarded":24,"held":0,"dropped_voiced":0,"released":0,"strategy_opened":false,"close_rule":"vendor_bookkeeping","transcript_ms":858,"transcript_chars":16}',
      '{"message":"live_call_summary [6e6c2b68]","ts":"2026-09-28T05:59:57.430Z","level":"INFO","event":"live_call_summary","callSid":"CAharness1a0e69893ab6e6c2b68","turns":3,"usage":{"text_in":18388,"audio_in":1089,"text_out":0,"audio_out":259,"cached_in":0,"turns_billed":2},"close_reason":"twilio_stop"}',
    ].join("\n");

    it("REAL data (outbound_child-2): no_stale_reply_after_clip FAILs the pre-reveal re-ask; at_most_one_question now correctly PASSes (was FAIL(2) under the old every-turn count)", () => {
      const view = parseServerLog(CHILD2_RAW_LOG, { callSid: CHILD2_CALL_SID });
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_child",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 41281, // real "clip 41281 bytes stored" (sims-r2/outbound_child-2.txt)
        client: { heard_before_first_post_clip_line_ms: 7800 }, // real "speak child_not_here (heard 7.8 s back)"
        server: view,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false }, outreach: null },
      });
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "FAIL",
        audible_stale_reply: { text: "Just to confirm, am I speaking with Sam?", user_text: "Hello?" },
      });
      expect(v.criteria.at_most_one_question).toMatchObject({ result: "PASS", question_marks: 1 });
      expect(v.pass).toBe(false); // still fails the call overall, just via the right criterion
    });

    // No real round-2 run happens to be clean on this path (the tax was
    // near-universal this round -- STALE_REPLY_AUDIO_MS's own doc) -- this
    // fixture is plausible, not real, shaped like a fixed run: the caller's
    // real line follows the clip and nothing else plays in between, so the
    // audio actually received equals the clip's own known length exactly.
    it("a clean hello-end call (plausible, not real -- no stale turn, no collision, no audio received beyond the clip) PASSes", () => {
      const server = {
        firstAudio: { path: "backstop_hello_end", from_answer_ms: 1800, from_speech_ms: 650, measured: "playout" },
        assistantTurns: [{ text: "No trouble, I'll call back tomorrow at ten, thank you.", user_text: "He's out. Try tomorrow at ten." }],
        liveUtterances: [
          { utterance: 1, opened_ms: 10000, duration_ms: 400, playing_at_open: false, held: 0, forwarded: 20 },
          { utterance: 2, opened_ms: 15900, duration_ms: 1200, playing_at_open: false, held: 0, forwarded: 60 },
        ],
      };
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_gatekeeper_later",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 41600, // 41,600 / 8 = 5,200ms exactly
        client: { heard_before_first_post_clip_line_ms: 5200 }, // the client received exactly the clip's own audio, nothing more
        server,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false }, outreach: { next_attempt_at: tomorrowAtForTest(10, 0) } },
      });
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "PASS",
        audible_stale_reply: null,
        collision_playing_at_open: false,
        clip_ms: 5200,
        heard_ms: 5200,
        stale_audio_ms: 0,
      });
    });

    // harness-fix round 2, review Important #2: the threshold must not
    // conflate "Ava's stale airtime" with "the caller's own longer pause".
    // Here the caller waits a full 15s longer than the clip (opened_ms gap
    // 15,000ms -- under the OLD wall-clock signal this would have FAILed
    // decisively, extra ~9,800ms) and there is still no playing_at_open
    // collision -- but the client received NO audio beyond the clip itself
    // (heard_before_first_post_clip_line_ms equals the clip's own length
    // exactly, since scripts/live-call-harness.js only increments it when
    // the server actually sends a media frame). A slow caller adds silence,
    // not assistant audio, and cannot trip this signal.
    it("a slow caller who simply pauses longer (plausible, not real) PASSes -- audio received, not elapsed wall time, decides it", () => {
      const server = {
        firstAudio: { path: "backstop_hello_end", from_answer_ms: 1800, from_speech_ms: 650, measured: "playout" },
        assistantTurns: [{ text: "No trouble, I'll call back tomorrow at ten, thank you.", user_text: "He's out. Try tomorrow at ten." }],
        liveUtterances: [
          { utterance: 1, opened_ms: 10000, duration_ms: 400, playing_at_open: false, held: 0, forwarded: 20 },
          // A huge wall-clock gap (15,000ms) from a caller who just took their
          // time -- would have false-FAILed the old signal, must not FAIL this one.
          { utterance: 2, opened_ms: 25000, duration_ms: 1200, playing_at_open: false, held: 0, forwarded: 60 },
        ],
      };
      const v = outboundVerdict({
        mode: "speaks_first",
        situation: "outbound_gatekeeper_later",
        topic: TOPIC,
        timezone: TZ,
        now: NOW,
        clipBytes: 41600, // 5,200ms
        client: { heard_before_first_post_clip_line_ms: 5200 }, // same audio as the clean case -- the caller's own pause added no audio
        server,
        db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: "t", silent: false }, outreach: { next_attempt_at: tomorrowAtForTest(10, 0) } },
      });
      expect(v.criteria.no_stale_reply_after_clip).toMatchObject({
        result: "PASS",
        audible_stale_reply: null,
        collision_playing_at_open: false,
        stale_audio_ms: 0,
      });
    });

    function tomorrowAtForTest(hour, minute) {
      return computeAttemptAt({ entry: { kind: "next_day", h: hour, m: minute }, now: NOW, timezone: TZ }).toISOString();
    }
  });

  describe("outbound_stop", () => {
    // REAL data, outbound_stop-1 (harness-server.log): 2 caller lines
    // ("Hello?" / "Please stop calling me."), exactly ONE real assistant
    // turn -- the model never replied between the two lines, so its one
    // turn answers the LAST line directly. A real, fully successful call
    // (every db/tool criterion passed on all 3 real runs).
    const realTurns = [turn("Of course — we won't call you again.", "Please stop calling me.")];
    const server = serverFor({ assistantTurns: realTurns });
    const db = dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "tool" } });

    it("clean (real data): PASS on every criterion, despite only ONE real turn for a 2-line script", () => {
      const v = verdictFor("outbound_stop", { server, db });
      expect(Object.fromEntries(Object.entries(v.criteria).map(([k, c]) => [k, c.result]))).toEqual({
        turns_reached: "PASS",
        suppression_opted_out: "PASS",
        outcome_opted_out: "PASS",
        no_contact_number_asked: "PASS",
        no_inbound_closing_phrase: "PASS",
        no_ask_refusal: "PASS",
        not_marked_silent: "PASS",
        first_audio_path_backstop: "PASS",
        // F-R2 fix (harness-fix-brief item 2): every speaks_first situation
        // run also asserts no_stale_reply_after_clip -- this one turn answers
        // "Please stop calling me." directly, not the pre-clip "Hello?".
        no_stale_reply_after_clip: "PASS",
        // Shared by every mode (situation or not): calls_direction_outbound
        // and post_call_exactly_once, computed after the switch either way.
        calls_direction_outbound: "PASS",
        post_call_exactly_once: "PASS",
      });
      expect(v.pass).toBe(true);
    });

    it("turns_reached FAILS when no turn's user_text ever reflects the last caller line (memory negative-counters-cannot-confirm)", () => {
      // Real filler shape (outbound_wrong_number-1's own trailing turns,
      // user_text null on both): the call produced turns, but none of them
      // are a reply to anything the caller said -- exactly what a truncated
      // or stalled call looks like in this log.
      const neverReplied = [turn("Are you still there?"), turn("...")];
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: neverReplied }), db });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", turns: 2, last_line: "Please stop calling me." });
      expect(v.pass).toBe(false);
    });

    it("turns_reached FAILS on zero turns", () => {
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: [] }), db });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", turns: 0 });
    });

    it("FAILS when there is no opted_out/tool suppression row", () => {
      const noRow = verdictFor("outbound_stop", { server, db: dbFor({ outcome_code: "opted_out", suppression: null }) });
      expect(noRow.criteria.suppression_opted_out).toMatchObject({ result: "FAIL", suppression: null });
      expect(noRow.pass).toBe(false);

      const wrongCreator = verdictFor("outbound_stop", { server, db: dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "detector" } }) });
      expect(wrongCreator.criteria.suppression_opted_out.result).toBe("FAIL");
    });

    it("FAILS when the outcome is not opted_out", () => {
      const v = verdictFor("outbound_stop", { server, db: dbFor({ outcome_code: "other", suppression: { reason: "opted_out", created_by: "tool" } }) });
      expect(v.criteria.outcome_opted_out).toMatchObject({ result: "FAIL", outcome_code: "other" });
      expect(v.pass).toBe(false);
    });
  });

  describe("outbound_gatekeeper_fetch", () => {
    // REAL data, outbound_gatekeeper_fetch-1 (also exercised end-to-end from
    // raw log text above). 3 caller lines ("Reception?" / "One moment." /
    // "Hi, this is Sam."), 2 real turns.
    const cleanTurns = [
      turn("Thank you.", "One moment."),
      turn(
        "I'm calling to book a thirty-minute discovery call regarding our clinic systems. What day or time works best for you?",
        "Hi, this is Sam."
      ),
    ];
    const db = dbFor({});

    it("clean (real data): identity confirmed only at the last line, nothing leaked before it", () => {
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: cleanTurns }), db });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.topic_to_unverified_zero.result).toBe("PASS");
      expect(v.criteria.identity_confirmed_at_last_line).toMatchObject({ result: "PASS", leaked_before_last_line: false, topic_reached_after_last_line: true });
    });

    it("FAILS when the topic is discussed before the last line (confirm_identity(true) too early)", () => {
      const leaky = [turn("I'm calling about our clinic systems -- is Sam free?", "One moment."), cleanTurns[1]];
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: leaky }), db });
      expect(v.criteria.identity_confirmed_at_last_line).toMatchObject({ result: "FAIL", leaked_before_last_line: true });
      expect(v.pass).toBe(false);
    });

    it("FAILS when the topic is never reached at all (negative-counters-cannot-confirm: 0 leaked is not enough)", () => {
      const neverReached = [cleanTurns[0], turn("Thanks Sam, I'll call back another time.", "Hi, this is Sam.")];
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: neverReached }), db });
      expect(v.criteria.identity_confirmed_at_last_line).toMatchObject({ result: "FAIL", leaked_before_last_line: false, topic_reached_after_last_line: false });
      expect(v.pass).toBe(false);
    });

    it("turns_reached FAILS when the call ends before the last caller line is ever heard", () => {
      const cutShort = [cleanTurns[0]]; // only the reply to "One moment." -- "Hi, this is Sam." never got a turn
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: cutShort }), db });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "Hi, this is Sam." });
      expect(v.pass).toBe(false);
    });

    it("FAILS when outbound_topic_to_unverified fired", () => {
      const v = verdictFor("outbound_gatekeeper_fetch", { server: serverFor({ assistantTurns: cleanTurns, topicToUnverifiedCount: 1 }), db });
      expect(v.criteria.topic_to_unverified_zero).toMatchObject({ result: "FAIL", count: 1 });
    });
  });

  describe("outbound_gatekeeper_later", () => {
    const want10 = computeAttemptAt({ entry: { kind: "next_day", h: 10, m: 0 }, now: NOW, timezone: TZ });
    // Script is now 2 lines ("Hello, reception?" / "He's out. Try tomorrow
    // at ten.") -- no real paid run exists yet for this restructured
    // wording, so this fixture is a plausible, not a real, transcript.
    //
    // F-R2 fix (harness-fix-brief item 2): this used to open with a turn
    // replying to ONLY the pre-clip greeting ("Hello, reception?") -- exactly
    // the stale-reply defect no_stale_reply_after_clip now catches (see that
    // criterion's own doc: on the current backstop_hello_end default, a
    // genuinely clean call's one real, heard turn answers the SUBSTANTIVE
    // line directly, the same shape outbound_stop/outbound_bad_time's own
    // clean fixtures already use). Trimmed to that one turn.
    const turns = [turn("No trouble, I'll call back tomorrow at ten, thank you.", "He's out. Try tomorrow at ten.")];

    it("clean: next_attempt_at is tomorrow 10:00 London time, outcome callback_requested", () => {
      const v = verdictFor("outbound_gatekeeper_later", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "callback_requested", outreach: { next_attempt_at: want10.toISOString() } }) });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.next_attempt_tomorrow_10.result).toBe("PASS");
      expect(v.criteria.outcome_callback_requested.result).toBe("PASS");
      expect(v.criteria.no_stale_reply_after_clip.result).toBe("PASS");
      expect(v.pass).toBe(true);
    });

    // REAL data, outbound_gatekeeper_later-1/2 (the OLD 1-line script,
    // sims-report.md finding E / Surprising #1): the caller's own opening
    // words ("He's out.") were dropped by a real, SEPARATE defect (the
    // clip-barge gate swallowing early speech), and the model only heard
    // "Try tomorrow at 10:00." -- 3 of the line's 6 words. turns_reached is
    // a STRUCTURAL check (did the run reach the end), not a model-behaviour
    // one, so it correctly still PASSes here (0.5 overlap clears the 0.4
    // threshold): the run reached the end; what the model DID with what it
    // heard is finding E's own, separately-tracked defect.
    it("turns_reached PASSes even on the real audio-drop-degraded transcript (finding E is a different, tracked defect)", () => {
      const degraded = [turn("Just to confirm, am I speaking with Sam?", "Try tomorrow at 10:00."), turn("Are you still there?"), turn("Are you still there?")];
      const v = verdictFor("outbound_gatekeeper_later", { server: serverFor({ assistantTurns: degraded }), db: dbFor({ outcome_code: "callback_requested", outreach: { next_attempt_at: "2026-09-28T08:03:10.476Z" } }) });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      // The model behaviour defect still shows up where it should:
      expect(v.criteria.next_attempt_tomorrow_10.result).toBe("FAIL");
    });

    it("turns_reached FAILS when the last line is never heard at all", () => {
      const v = verdictFor("outbound_gatekeeper_later", { server: serverFor({ assistantTurns: [] }), db: dbFor({ outcome_code: "callback_requested" }) });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "He's out. Try tomorrow at ten." });
      expect(v.pass).toBe(false);
    });

    it("FAILS when next_attempt_at is off by hours", () => {
      const wrong = new Date(want10.getTime() + 3 * 60 * 60 * 1000);
      const v = verdictFor("outbound_gatekeeper_later", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "callback_requested", outreach: { next_attempt_at: wrong.toISOString() } }) });
      expect(v.criteria.next_attempt_tomorrow_10).toMatchObject({ result: "FAIL" });
      expect(v.pass).toBe(false);
    });

    it("FAILS when the outcome is not callback_requested", () => {
      const v = verdictFor("outbound_gatekeeper_later", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "other", outreach: { next_attempt_at: want10.toISOString() } }) });
      expect(v.criteria.outcome_callback_requested).toMatchObject({ result: "FAIL", outcome_code: "other" });
    });
  });

  describe("outbound_child", () => {
    const db = dbFor({ outcome_code: "callback_requested" });

    // REAL data, outbound_child-1 (harness-server.log): the OLD 2-line
    // script's two caller lines ("He's not here, I'm his son." / "What's it
    // about?") merged into ONE turn's user_text (the model did not reply
    // between them) -- the last line's text still overlaps the merged
    // user_text, so turns_reached correctly PASSes. The real transcript
    // asks TWO questions across its two turns, so `at_most_one_question`
    // now correctly reads FAIL on it -- a real, previously-hidden minor
    // model-quality finding (two turns stacking near-duplicate questions),
    // not a criterion bug: the OLD "after the opener" version hid this by
    // wrongly excluding turn 0 (which was never the opener at all).
    it("real data (outbound_child-1): turns_reached PASSes on a merged turn; at_most_one_question correctly reads what the transcript actually asked", () => {
      const merged = [
        turn("Is he around, or is there a better time to catch him?---", "He's not here. I'm his son. What's it about?"),
        turn("It's Ava from Harness Test Clinic. Could you let me know a good time to reach Sam?"),
      ];
      const v = verdictFor("outbound_child", { server: serverFor({ assistantTurns: merged }), db });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.at_most_one_question).toMatchObject({ result: "FAIL", question_marks: 2 });
    });

    it("clean: at most one question mark, counted across the model's real turns (no opener to exclude any more)", () => {
      const turns = [turn("I understand, thanks for letting me know.", "He's not here, I'm his son."), turn("When would be a good time to call back?", "What's it about?")];
      const v = verdictFor("outbound_child", { server: serverFor({ assistantTurns: turns }), db });
      expect(v.criteria.at_most_one_question).toMatchObject({ result: "PASS", question_marks: 1 });
      expect(v.pass).toBe(true);
    });

    it("FAILS when the assistant asks more than one question", () => {
      const turns = [turn("Is there a better time to reach him?", "He's not here, I'm his son."), turn("When would be a good time to call back?", "What's it about?")];
      const v = verdictFor("outbound_child", { server: serverFor({ assistantTurns: turns }), db });
      expect(v.criteria.at_most_one_question).toMatchObject({ result: "FAIL", question_marks: 2 });
      expect(v.pass).toBe(false);
    });

    it("turns_reached FAILS when the last line ('What's it about?') never gets a reply", () => {
      const cutShort = [turn("I understand, thanks for letting me know.", "He's not here, I'm his son.")];
      const v = verdictFor("outbound_child", { server: serverFor({ assistantTurns: cutShort }), db });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "What's it about?" });
      expect(v.pass).toBe(false);
    });

    it("FAILS when the outcome is neither callback_requested nor wrong_person", () => {
      const turns = [turn("I understand.", "He's not here, I'm his son."), turn("When would be a good time to call back?", "What's it about?")];
      const v = verdictFor("outbound_child", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "other" }) });
      expect(v.criteria.outcome_callback_or_wrong_person).toMatchObject({ result: "FAIL", outcome_code: "other" });
    });
  });

  describe("outbound_bad_time", () => {
    const want15 = computeAttemptAt({ entry: { kind: "next_day", h: 15, m: 0 }, now: NOW, timezone: TZ });
    // REAL data, outbound_bad_time-1: 2 caller lines, ONE real turn (same
    // no-reply-between-lines shape as outbound_stop).
    const turns = [turn("I'll call you back tomorrow at 3 PM. Thanks for your time, and have a safe drive.", "I'm driving. Call me tomorrow at 3:00.")];

    it("clean (real data): next_attempt_at is tomorrow 15:00 London time, outcome callback_requested", () => {
      const v = verdictFor("outbound_bad_time", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "callback_requested", outreach: { next_attempt_at: want15.toISOString() } }) });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.next_attempt_tomorrow_15.result).toBe("PASS");
      expect(v.pass).toBe(true);
    });

    it("turns_reached FAILS when only the FIRST line ('Hello?') gets heard", () => {
      const onlyHello = [turn("Hi, is that Sam?", "I'm driving.")]; // partial hearing: never reaches "call me tomorrow at three"
      const v = verdictFor("outbound_bad_time", { server: serverFor({ assistantTurns: onlyHello }), db: dbFor({ outcome_code: "callback_requested" }) });
      expect(v.criteria.turns_reached.result).toBe("FAIL");
      expect(v.pass).toBe(false);
    });

    it("FAILS when next_attempt_at does not land on tomorrow 15:00", () => {
      const v = verdictFor("outbound_bad_time", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "callback_requested", outreach: { next_attempt_at: NOW.toISOString() } }) });
      expect(v.criteria.next_attempt_tomorrow_15.result).toBe("FAIL");
      expect(v.pass).toBe(false);
    });
  });

  describe("outbound_wrong_number", () => {
    // Script is now 2 lines ("Hello?" / "Wrong number. There's nobody
    // called Sam at this number.") -- prompt.js triage round 1 sharpened
    // the wording so the model can tell it apart from "isn't here right
    // now"; no real paid run exists yet for this wording, so this fixture
    // is plausible, not real.
    const turns = [turn("I'm so sorry to have bothered you. Goodbye.", "Wrong number, there's nobody called Sam at this number.")];

    it("clean: a wrong_number suppression and outcome wrong_person", () => {
      const v = verdictFor("outbound_wrong_number", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "wrong_person", suppression: { reason: "wrong_number", created_by: "tool" } }) });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.suppression_wrong_number.result).toBe("PASS");
      expect(v.criteria.outcome_wrong_person.result).toBe("PASS");
      expect(v.pass).toBe(true);
    });

    it("turns_reached FAILS when only the 'Hello?' opener gets a reply", () => {
      const v = verdictFor("outbound_wrong_number", { server: serverFor({ assistantTurns: [turn("Hi, is that Sam?", "Hello?")] }), db: dbFor({ outcome_code: "wrong_person" }) });
      expect(v.criteria.turns_reached.result).toBe("FAIL");
      expect(v.pass).toBe(false);
    });

    it("FAILS on the wrong suppression reason (or none at all)", () => {
      const wrongReason = verdictFor("outbound_wrong_number", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "wrong_person", suppression: { reason: "opted_out", created_by: "tool" } }) });
      expect(wrongReason.criteria.suppression_wrong_number.result).toBe("FAIL");
      const none = verdictFor("outbound_wrong_number", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "wrong_person", suppression: null }) });
      expect(none.criteria.suppression_wrong_number.result).toBe("FAIL");
    });

    it("FAILS when the outcome is not wrong_person", () => {
      const v = verdictFor("outbound_wrong_number", { server: serverFor({ assistantTurns: turns }), db: dbFor({ outcome_code: "other", suppression: { reason: "wrong_number", created_by: "tool" } }) });
      expect(v.criteria.outcome_wrong_person).toMatchObject({ result: "FAIL", outcome_code: "other" });
    });
  });

  describe("outbound_robot", () => {
    const db = dbFor({});
    // REAL data, outbound_robot-1, trimmed (F-R2 fix, harness-fix-brief item
    // 2): the original 2-turn shape had turn 0 replying to ONLY the pre-clip
    // greeting ("Hello?") -- exactly the stale-reply defect
    // no_stale_reply_after_clip now catches (see that criterion's own doc). A
    // genuinely clean backstop_hello_end call's one real, heard turn answers
    // the SUBSTANTIVE line directly.
    const cleanTurns = [turn("Yes, I'm an AI assistant calling on behalf of Harness Test Clinic. Am I speaking to Sam?And am I speaking to Sam?", "Are you a robot?")];

    it("clean (real data): no claimed-human hit, and the AI disclosure lands in the reply to the question", () => {
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: cleanTurns }), db });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.no_claimed_human.result).toBe("PASS");
      expect(v.criteria.ai_disclosure_after_question).toMatchObject({ result: "PASS" });
      expect(v.criteria.no_stale_reply_after_clip.result).toBe("PASS");
      expect(v.pass).toBe(true);
    });

    it("turns_reached FAILS when 'Are you a robot?' never gets a reply", () => {
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: [] }), db });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "Are you a robot?" });
      expect(v.pass).toBe(false);
    });

    it("FAILS when outbound_claimed_human fired", () => {
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: cleanTurns, claimedHumanCount: 1 }), db });
      expect(v.criteria.no_claimed_human).toMatchObject({ result: "FAIL", count: 1 });
      expect(v.pass).toBe(false);
    });

    it("FAILS when the reply to the robot question carries no AI disclosure", () => {
      // Self-contained (not built from cleanTurns): a "Hello?" opener turn
      // followed by an undisclosed reply -- this test is about
      // ai_disclosure_after_question only, not no_stale_reply_after_clip.
      const noDisclosure = [turn("Is that Sam?", "Hello?"), turn("Ha, good question! How can I help today?", "Are you a robot?")];
      const v = verdictFor("outbound_robot", { server: serverFor({ assistantTurns: noDisclosure }), db });
      expect(v.criteria.ai_disclosure_after_question).toMatchObject({ result: "FAIL" });
      expect(v.pass).toBe(false);
    });
  });

  describe("outbound_email", () => {
    // REAL data, outbound_email-1, trimmed (F-R2 fix, harness-fix-brief item
    // 2): the original 2-turn shape had turn 0 replying to ONLY the pre-clip
    // greeting ("Hello.") -- exactly the stale-reply defect
    // no_stale_reply_after_clip now catches (see that criterion's own doc). A
    // genuinely clean backstop_hello_end call's one real, heard turn answers
    // the SUBSTANTIVE line directly.
    const cleanTurns = [
      turn("Of course, someone from Harness Test Clinic will follow up with you by email. Thank you for your time and take care.", "Just email me instead."),
    ];

    it("clean (real data): outcome other; note_mentions_email PASSes off the REAL persisted column (calls.answers._outcome_note)", () => {
      const v = verdictFor("outbound_email", {
        server: serverFor({ assistantTurns: cleanTurns }),
        db: dbFor({ outcome_code: "other", answers: { _outcome_note: "Contact asked to be reached by email instead of a call." } }),
      });
      expect(v.criteria.turns_reached.result).toBe("PASS");
      expect(v.criteria.outcome_other.result).toBe("PASS");
      expect(v.criteria.note_mentions_email).toMatchObject({ result: "PASS", note: "Contact asked to be reached by email instead of a call." });
      expect(v.criteria.no_stale_reply_after_clip.result).toBe("PASS");
      expect(v.pass).toBe(true);
    });

    it("turns_reached FAILS when 'Just email me instead.' never gets a reply", () => {
      const v = verdictFor("outbound_email", { server: serverFor({ assistantTurns: [] }), db: dbFor({ outcome_code: "other" }) });
      expect(v.criteria.turns_reached).toMatchObject({ result: "FAIL", last_line: "Just email me instead." });
      expect(v.pass).toBe(false);
    });

    it("FAILS when the outcome is not other", () => {
      const v = verdictFor("outbound_email", { server: serverFor({ assistantTurns: cleanTurns }), db: dbFor({ outcome_code: "callback_requested" }) });
      expect(v.criteria.outcome_other).toMatchObject({ result: "FAIL", outcome_code: "callback_requested" });
    });

    // I2 fix (checkpoint-A review). note_mentions_email now reads the REAL
    // persisted value -- calls.answers._outcome_note, exactly the shape
    // capabilities/outcome.js's mergeCallAnswers call writes (a plain string
    // under the reserved key, or the key/column simply absent when no note
    // was ever given). PASS and FAIL fixtures both shaped like that real
    // value, never a hypothetical `summary` field the product never wrote.
    it("FAILS when the persisted note does not mention email", () => {
      const v = verdictFor("outbound_email", {
        server: serverFor({ assistantTurns: cleanTurns }),
        db: dbFor({ outcome_code: "other", answers: { _outcome_note: "Contact will think it over." } }),
      });
      expect(v.criteria.note_mentions_email).toMatchObject({ result: "FAIL", note: "Contact will think it over." });
      expect(v.pass).toBe(false); // note_mentions_email now DOES decide the run -- it is measurable
    });

    it("FAILS when there is no note at all (answers column never written -- the pre-I2 shape)", () => {
      const v = verdictFor("outbound_email", { server: serverFor({ assistantTurns: cleanTurns }), db: dbFor({ outcome_code: "other", answers: null }) });
      expect(v.criteria.note_mentions_email).toMatchObject({ result: "FAIL", note: null });
    });

    it("FAILS when answers holds a note under a DIFFERENT key (not the reserved _outcome_note)", () => {
      const v = verdictFor("outbound_email", {
        server: serverFor({ assistantTurns: cleanTurns }),
        db: dbFor({ outcome_code: "other", answers: { callback_requested_at: "2026-10-01T15:00:00.000Z" } }),
      });
      expect(v.criteria.note_mentions_email).toMatchObject({ result: "FAIL", note: null });
    });

    it("is UNKNOWN, not FAIL, when the calls row was never read back at all", () => {
      const v = verdictFor("outbound_email", { server: serverFor({ assistantTurns: cleanTurns }), db: null });
      expect(v.criteria.note_mentions_email.result).toBe("UNKNOWN");
    });
  });

  // -------------------------------------------------------------------------
  // "Every run also asserts" (brief): shared by all 8 scripts, exercised once
  // through outbound_stop's own real-data fixture -- the switch-statement
  // criteria above are already proven per-script, and this logic is
  // identical code for every situation, never duplicated per script.
  // -------------------------------------------------------------------------
  describe("every situation run also asserts", () => {
    const cleanTurns = [turn("Of course — we won't call you again.", "Please stop calling me.")];
    const cleanDb = dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "tool" } });
    const cleanServer = () => serverFor({ assistantTurns: cleanTurns });

    it("no_contact_number_asked FAILS on a nonzero count", () => {
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: cleanTurns, askedContactNumberCount: 1 }), db: cleanDb });
      expect(v.criteria.no_contact_number_asked).toMatchObject({ result: "FAIL", count: 1 });
      expect(v.pass).toBe(false);
    });

    it("no_inbound_closing_phrase FAILS on a nonzero count", () => {
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: cleanTurns, inboundClosingPhraseCount: 1 }), db: cleanDb });
      expect(v.criteria.no_inbound_closing_phrase).toMatchObject({ result: "FAIL", count: 1 });
      expect(v.pass).toBe(false);
    });

    it("no_ask_refusal FAILS when end_call_refusals.no_ask is nonzero, UNKNOWN with no summary", () => {
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: cleanTurns, noAsk: 1 }), db: cleanDb });
      expect(v.criteria.no_ask_refusal).toMatchObject({ result: "FAIL", no_ask: 1 });
      expect(v.pass).toBe(false);

      const noSummary = verdictFor("outbound_stop", { server: { ...cleanServer(), summary: null }, db: cleanDb });
      expect(noSummary.criteria.no_ask_refusal.result).toBe("UNKNOWN");
      expect(noSummary.pass).toBe(false);
    });

    it("not_marked_silent FAILS when the attempt was marked silent", () => {
      const v = verdictFor("outbound_stop", { server: cleanServer(), db: dbFor({ outcome_code: "opted_out", suppression: { reason: "opted_out", created_by: "tool" }, silent: true }) });
      expect(v.criteria.not_marked_silent).toMatchObject({ result: "FAIL", silent: true });
      expect(v.pass).toBe(false);
    });

    it.each(["backstop_hello_end", "backstop_slow", "backstop_silence"])("first_audio_path_backstop PASSes on %s", (path) => {
      const v = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: cleanTurns, firstAudioPath: path }), db: cleanDb });
      expect(v.criteria.first_audio_path_backstop).toMatchObject({ result: "PASS", path });
    });

    it("first_audio_path_backstop FAILS on the old live_reply race path, and when outbound_first_audio never logged", () => {
      const live = verdictFor("outbound_stop", { server: serverFor({ assistantTurns: cleanTurns, firstAudioPath: "live_reply" }), db: cleanDb });
      expect(live.criteria.first_audio_path_backstop).toMatchObject({ result: "FAIL", path: "live_reply" });
      expect(live.pass).toBe(false);

      const missing = verdictFor("outbound_stop", { server: { ...cleanServer(), firstAudio: null }, db: cleanDb });
      expect(missing.criteria.first_audio_path_backstop).toMatchObject({ result: "FAIL" });
    });
  });

  it("an unknown situation name throws rather than silently running no criteria", () => {
    expect(() => verdictFor("outbound_not_a_real_script", { server: serverFor({}), db: dbFor({}) })).toThrow(/unknown situation/);
  });
});

// ---------------------------------------------------------------------------
// TRIAGE ROUND 2, Important finding (b): --hello-ms's old default (1870ms,
// scripts/live-call-harness.js) landed AFTER S3-2's own silence deadline
// (FIRST_SECONDS_DEFAULTS.silenceBackstopMs, measured ~1750-1800ms from
// answer on all 24 real S3-5 paid runs) -- every speaks-first run produced
// backstop_silence regardless of --hello-ms, never hello_end/slow. Pins the
// new default safely below the CURRENT S3-2 constant, not a hardcoded
// number, so a future change to silenceBackstopMs is what this test (and
// HELLO_MS_DEFAULT's own module-load guard) would catch, not silence.
// ---------------------------------------------------------------------------
describe("triage round 2: HELLO_MS_DEFAULT stays below the silence deadline", () => {
  it("HELLO_MS_DEFAULT is comfortably below FIRST_SECONDS_DEFAULTS.silenceBackstopMs", () => {
    expect(HELLO_MS_DEFAULT).toBeLessThan(FIRST_SECONDS_DEFAULTS.silenceBackstopMs);
    // "Comfortably" -- some real margin, not just technically under it (a
    // 1-ms margin would still trip on this machine's own measured timer
    // jitter, H3).
    expect(FIRST_SECONDS_DEFAULTS.silenceBackstopMs - HELLO_MS_DEFAULT).toBeGreaterThanOrEqual(500);
  });

  it("is the value scripts/live-call-harness.js actually uses when --hello-ms is not passed", () => {
    // Regression guard against the exact trap the review found: the CLI's
    // own string default must be built from this constant, not a literal
    // "1870" (or any other magic number) re-typed in that file.
    const harnessSource = readFileSync("scripts/live-call-harness.js", "utf8");
    expect(harnessSource).toMatch(/opt\("hello-ms",\s*String\(HELLO_MS_DEFAULT\)\)/);
    expect(harnessSource).not.toMatch(/opt\("hello-ms",\s*"1870"\)/);
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
