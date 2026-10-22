// tests/outboundLiveRender.test.js
/**
 * Spec §9.3 step 1 / D6 (revised): the backstop and voicemail clips are
 * rendered by a short Gemini Live session IN THE TENANT'S LIVE VOICE, then
 * verified against the line and stored as 8 kHz mu-law.
 *
 * Every Live interaction here is a FAKE `connect` that emits canned 24 kHz
 * PCM and an output transcript. No real Gemini call is made (Task 15 owns the
 * paid run).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Fix round 1 (M8): the modules' own default logger is replaced, so importing
// services/db.js without a DATABASE_URL (for loadConfig) prints nothing. Every
// assertion on a log line here goes through an injected `log` instead.
vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

import {
  renderLines,
  createLiveRenderAudio,
  RENDER_TIMEOUT_MS,
  RENDER_TRANSCRIPT_GRACE_MS,
  RENDER_SYSTEM_PROMPT,
  RENDER_MAX_WORD_RATIO,
  wordOverlap,
  wordRatio,
} from "../lib/outbound/liveRender.js";
import { loadConfig } from "../services/db.js";

const OPENER = "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.";
const VOICEMAIL =
  "Hi Sam, it's Ava, an AI assistant from Digile Media, about your enquiry. We'll try you again soon. This call may be transcribed to help us assist you.";

/** `ms` of a loud 24 kHz PCM16 tone, base64, as Live sends it. */
function pcm24k(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  return buf.toString("base64");
}

/**
 * A fake connectLive. Once the user turn arrives it emits two audio chunks
 * (500 ms each), the transcript `say(line)`, then turnComplete -- the shape
 * a real render produced in spike A.
 */
function fakeConnect({ say = (line) => line, hang = false, failConnect = false, closeEarly = false, gate = () => null, usage = null } = {}) {
  const sessions = [];
  const connect = vi.fn(async ({ config, callbacks }) => {
    if (failConnect) throw new Error("connect refused");
    const session = {
      config,
      sent: [],
      closed: false,
      sendClientContent(msg) {
        this.sent.push(msg);
        if (hang) return;
        const line = msg.turns[0].parts[0].text.replace(/^Say exactly: "/, "").replace(/"$/, "");
        // `gate(line)` may return a promise that holds this line back -- a
        // render that is still running while the other one finishes.
        Promise.resolve(gate(line)).then(() => setImmediate(() => {
          if (closeEarly) {
            callbacks.onclose?.({ code: 1011, reason: "internal" });
            return;
          }
          callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(500) } }] } } });
          callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(500) } }] } } });
          callbacks.onmessage({ serverContent: { outputTranscription: { text: say(line) } } });
          if (usage) callbacks.onmessage({ usageMetadata: usage });
          callbacks.onmessage({ serverContent: { turnComplete: true } });
        }));
      },
      close() {
        this.closed = true;
      },
    };
    sessions.push(session);
    return { session, languagePinned: true, surface: "aistudio", model: "m" };
  });
  return { connect, sessions };
}

const quietLog = () => ({ info: vi.fn(), error: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("renderLines", () => {
  it("returns an 8 kHz mu-law buffer of the right length: one second of 24 kHz PCM16 -> 8,000 bytes", async () => {
    const { connect } = fakeConnect();
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Aoede", languageCode: "en-GB", connect, log: quietLog() });
    expect(Buffer.isBuffer(out.opener)).toBe(true);
    expect(out.opener.length).toBe(8000);
    expect(out).not.toHaveProperty("voicemail");
  });

  it("asks Live, in the given voice and language, to speak the line verbatim -- then closes the session", async () => {
    const { connect, sessions } = fakeConnect();
    await renderLines({ lines: { opener: OPENER }, voiceName: "Aoede", languageCode: "en-GB", connect, log: quietLog() });

    expect(connect).toHaveBeenCalledTimes(1);
    const { config } = connect.mock.calls[0][0];
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.systemInstruction).toEqual({ parts: [{ text: RENDER_SYSTEM_PROMPT }] });
    expect(RENDER_SYSTEM_PROMPT).toBe("Speak the user's text exactly, nothing else.");
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, languageCode: "en-GB" });
    expect(sessions[0].sent).toEqual([
      { turns: [{ role: "user", parts: [{ text: `Say exactly: "${OPENER}"` }] }], turnComplete: true },
    ]);
    expect(sessions[0].closed).toBe(true);
  });

  it("renders the opener and the voicemail, one short session each", async () => {
    const { connect } = fakeConnect();
    const out = await renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(out.opener.length).toBe(8000);
    expect(out.voicemail.length).toBe(8000);
  });

  it("REFUSES a clip whose transcript drops 'AI assistant' -- the backstop must say the disclosure verbatim", async () => {
    const { connect } = fakeConnect({ say: (line) => line.replace("an AI assistant ", "") });
    const log = quietLog();
    // graceMs: 5 -- h2 (checkpoint 2b review): this fake connect never sends
    // anything past turnComplete, so the mismatched transcript is never going
    // to improve; a small grace keeps this test fast without changing what
    // it tests (the grace mechanism itself has its own describe block below).
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log, logFields: { outreachId: "out-1" }, graceMs: 5 });
    expect(out.opener).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "outbound_backstop_render_refused",
      expect.objectContaining({ outreachId: "out-1", reason: "transcript_mismatch" })
    );
  });

  it("refuses a clip that drops ONLY the word 'AI' even though the word overlap stays above 0.9", async () => {
    const say = (line) => line.replace("an AI assistant", "an assistant");
    expect(wordOverlap(OPENER, say(OPENER))).toBeGreaterThanOrEqual(0.9);
    const { connect } = fakeConnect({ say });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog(), graceMs: 5 });
    expect(out.opener).toBeNull();
  });

  it("accepts a transcript that differs only in case, punctuation and 'A.I.' spelling", async () => {
    const say = () => "hi is that sam its ava an A.I. assistant from digile media";
    const { connect } = fakeConnect({ say });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).not.toBeNull();
  });

  it("a refused voicemail is logged under its own name and does not take the opener with it", async () => {
    const { connect } = fakeConnect({ say: (line) => (line === VOICEMAIL ? "Hello." : line) });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log, graceMs: 5 });
    expect(out.opener.length).toBe(8000);
    expect(out.voicemail).toBeNull();
    expect(log.error).toHaveBeenCalledWith("outbound_voicemail_render_refused", expect.objectContaining({ reason: "transcript_mismatch" }));
  });

  it("a connect failure or an early close gives null for that line, never a throw", async () => {
    const failed = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: fakeConnect({ failConnect: true }).connect, log: quietLog() });
    expect(failed.opener).toBeNull();
    const closed = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: fakeConnect({ closeEarly: true }).connect, log: quietLog() });
    expect(closed.opener).toBeNull();
  });

  it("a hung Live session is bounded: after RENDER_TIMEOUT_MS the line is null and the session is closed", async () => {
    vi.useFakeTimers();
    const { connect, sessions } = fakeConnect({ hang: true });
    const log = quietLog();
    let settled = null;
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log }).then((v) => (settled = v));

    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled.opener).toBeNull();
    expect(sessions[0].closed).toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", expect.objectContaining({ reason: "timeout" }));
  });

  it("the timeout is the ruled value", () => {
    expect(RENDER_TIMEOUT_MS).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// h2 (checkpoint 2b review). Paid-run evidence, session 2c speaks-first #4:
// turnComplete fired with an EMPTY outputTranscription although the audio
// was real (172 audio-out tokens, first audio 1,013 ms) -- refused as
// transcript_mismatch overlap 0, correctly fail-closed but at the cost of the
// clip path on a silent pickup. `fakeConnect` above always bundles audio,
// transcript and turnComplete into one delivery, so it cannot produce this
// shape; these tests drive the callbacks directly, one message at a time.
// ---------------------------------------------------------------------------
describe("h2: trailing outputTranscription can arrive after turnComplete", () => {
  function splitConnect() {
    let cb = null;
    const session = { sent: [], closed: false, sendClientContent(msg) { this.sent.push(msg); }, close() { this.closed = true; } };
    const connect = vi.fn(async ({ callbacks }) => {
      cb = callbacks;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    });
    return {
      connect,
      session,
      audio: () => cb.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(500) } }] } } }),
      turnComplete: () => cb.onmessage({ serverContent: { turnComplete: true } }),
      transcript: (text) => cb.onmessage({ serverContent: { outputTranscription: { text } } }),
      usage: (u) => cb.onmessage({ usageMetadata: u }),
      close: () => cb.onclose?.(),
    };
  }

  /** Two microtask hops: enough for renderOne's `Promise.resolve().then(() => connect(...))` chain to have called connect and set `cb`. */
  const untilConnected = () => Promise.resolve().then(() => Promise.resolve());

  it("transcription arriving 300 ms after turnComplete is still accepted", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: RENDER_TRANSCRIPT_GRACE_MS });
    await untilConnected();
    rig.audio();
    rig.turnComplete(); // no transcript yet: does not cover the line
    await vi.advanceTimersByTimeAsync(300);
    rig.transcript(OPENER);
    const out = await p;
    expect(out.opener).not.toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("never arriving: refused after the grace, timer bounded (the session is closed, no leak)", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: RENDER_TRANSCRIPT_GRACE_MS });
    await untilConnected();
    rig.audio();
    rig.turnComplete(); // no transcript, ever
    await vi.advanceTimersByTimeAsync(RENDER_TRANSCRIPT_GRACE_MS - 1);
    const out = await Promise.race([p, Promise.resolve("pending")]);
    expect(out).toBe("pending"); // not yet -- the grace has not elapsed
    await vi.advanceTimersByTimeAsync(1);
    const settled = await p;
    expect(settled.opener).toBeNull();
    expect(rig.session.closed).toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", expect.objectContaining({ reason: "transcript_mismatch", overlap: 0 }));
  });

  it("covered already at turnComplete: no added delay (resolves with the grace timer never firing)", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    // A grace long enough that a test awaiting it directly would time out --
    // the point is that this path never starts the timer at all.
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: 10_000 });
    await untilConnected();
    rig.audio();
    rig.transcript(OPENER); // the line's own text, in full, before turnComplete
    rig.turnComplete();
    const out = await p; // resolves without any advanceTimersByTimeAsync at all
    expect(out.opener).not.toBeNull();
  });

  it("audio after turnComplete is not appended", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: RENDER_TRANSCRIPT_GRACE_MS });
    await untilConnected();
    rig.audio(); // 500ms
    rig.turnComplete();
    rig.audio(); // arrives during the grace window -- must be dropped
    await vi.advanceTimersByTimeAsync(50);
    rig.transcript(OPENER);
    const out = await p;
    // One chunk's worth (downsampled 8kHz mu-law, half the 24kHz PCM sample
    // count), not two -- the second audio() call must not have been appended.
    expect(out.opener.length).toBe(4000);
  });

  it("usage arriving during the grace window is still recorded (M2)", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: RENDER_TRANSCRIPT_GRACE_MS });
    await untilConnected();
    rig.audio();
    rig.turnComplete();
    await vi.advanceTimersByTimeAsync(50);
    rig.usage({ promptTokenCount: 10, responseTokenCount: 5 });
    rig.transcript(OPENER);
    await p;
    expect(log.info).toHaveBeenCalledWith(
      "outbound_render_usage",
      expect.objectContaining({ kind: "opener", outcome: "accepted", text_in: 10, audio_out: 5 })
    );
  });

  it("a vendor close arriving during the grace window keeps the already-captured audio (refused on the transcript alone, not as no_audio)", async () => {
    vi.useFakeTimers();
    const rig = splitConnect();
    const log = quietLog();
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: rig.connect, log, graceMs: RENDER_TRANSCRIPT_GRACE_MS });
    await untilConnected();
    rig.audio();
    rig.turnComplete(); // no transcript yet
    rig.close(); // the vendor tears the session down mid-grace
    const out = await p;
    expect(out.opener).toBeNull();
    // The distinguishing evidence: audio was retained (a real render that
    // just lacks transcript confirmation), not discarded as though nothing
    // had been generated at all.
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", expect.objectContaining({ reason: "transcript_mismatch" }));
  });
});

describe("createLiveRenderAudio (dispatch's renderAudio)", () => {
  const BIZ = "biz-digile";
  function fakeDb(business) {
    return {
      withTenant: vi.fn(async (_id, fn) => fn()),
      fetchBusinessById: vi.fn(async () => business),
      fetchBusinessCapabilities: vi.fn(async () => []),
      // The real one: the voice comes from config.liveVoice, which only
      // loadConfig maps from the row's live_voice column.
      loadConfig,
    };
  }

  it("renders in the voice and language resolved from the BUSINESS (its number and its config), never the contact's", async () => {
    // No locale on the row, so the language derives from a NUMBER -- and the
    // business number (+44) and the contact's (+1) disagree on purpose.
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: "Aoede", locale: null });
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });

    const row = {
      id: "out-1",
      business_id: BIZ,
      phone_e164: "+15551230000",
      config: { caller_id: "+441372656055" },
    };
    const audio = await renderAudio({ row, attemptNo: 1, lines: { opener: OPENER } });

    expect(db.withTenant.mock.calls[0][0]).toBe(BIZ);
    expect(db.fetchBusinessById).toHaveBeenCalledWith(BIZ);
    const { config } = connect.mock.calls[0][0];
    expect(config.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, languageCode: "en-GB" });
    expect(audio.opener.length).toBe(8000);
    expect(audio.voicemail).toBeNull();
  });

  // S3-6 (spec §19, S3-D4): the campaign's own `language`, when set, renders
  // the clip in that language -- the SAME rung the live session itself reads
  // (lib/voice/live/index.js resolveLiveLanguage), so the pre-rendered clip
  // and the live call can never disagree about which language they are in.
  it("the campaign's own language overrides the tenant's own locale/number-derived default", async () => {
    // Tenant locale says en-GB (and the business number is UK too), but the
    // campaign itself asked for en-US.
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: null, locale: "en-GB" });
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });

    const row = {
      id: "out-1",
      business_id: BIZ,
      phone_e164: "+15551230000",
      config: { caller_id: "+441372656055", language: "en-US" },
    };
    await renderAudio({ row, attemptNo: 1, lines: { opener: OPENER } });

    const { config } = connect.mock.calls[0][0];
    expect(config.speechConfig.languageCode).toBe("en-US");
  });

  it("no campaign language set: falls through to the tenant's own locale exactly as before this task", async () => {
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: null, locale: "en-GB" });
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });
    const row = { id: "out-1", business_id: BIZ, phone_e164: "+15551230000", config: { caller_id: "+441372656055" } };
    await renderAudio({ row, attemptNo: 1, lines: { opener: OPENER } });
    expect(connect.mock.calls[0][0].config.speechConfig.languageCode).toBe("en-GB");
  });

  it("a refused line comes back as null for that key", async () => {
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: null, locale: "en-GB" });
    const { connect } = fakeConnect({ say: (line) => (line === VOICEMAIL ? "nope" : line) });
    // graceMs: 5 -- h2 (checkpoint 2b review): see the note on the first
    // refusal test in this file; a fast grace keeps this test's runtime
    // unaffected by the (correct) production wait.
    const renderAudio = createLiveRenderAudio({
      db,
      env: {},
      connect,
      log: quietLog(),
      render: (opts) => renderLines({ ...opts, graceMs: 5 }),
    });
    const audio = await renderAudio({
      row: { id: "out-1", business_id: BIZ, config: { caller_id: "+441372656055" } },
      attemptNo: 1,
      lines: { opener: OPENER, voicemail: VOICEMAIL },
    });
    expect(audio.opener.length).toBe(8000);
    expect(audio.voicemail).toBeNull();
    // No live_voice on the row: the per-language default, as the call uses.
    expect(connect.mock.calls[0][0].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });

  it("a business that cannot be loaded throws (dispatch logs outbound_backstop_render_failed) rather than rendering in a default voice", async () => {
    const db = fakeDb(null);
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });
    await expect(
      renderAudio({ row: { id: "out-1", business_id: BIZ, config: { caller_id: "+441372656055" } }, attemptNo: 1, lines: { opener: OPENER } })
    ).rejects.toThrow(/business/);
    expect(connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fix round 1.
// ---------------------------------------------------------------------------

describe("M1: a transcript that says MORE than the line is refused", () => {
  it("'Sure! Here you go. <line> Let me know...' contains every word and is still not the line", async () => {
    const say = (line) => `Sure! Here you go. ${line} Let me know if you need anything else.`;
    expect(wordOverlap(OPENER, say(OPENER))).toBe(1);
    const { connect } = fakeConnect({ say });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log, graceMs: 5 });
    expect(out.opener).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "outbound_backstop_render_refused",
      expect.objectContaining({ reason: "transcript_mismatch", overlap: 1 })
    );
    const [, fields] = log.error.mock.calls.find(([e]) => e === "outbound_backstop_render_refused");
    expect(fields.word_ratio).toBeGreaterThan(RENDER_MAX_WORD_RATIO);
  });

  it("one extra word on a 12-word line is within the ratio", async () => {
    expect(RENDER_MAX_WORD_RATIO).toBe(1.15);
    const { connect } = fakeConnect({ say: (line) => `${line} Okay.` });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).not.toBeNull();
  });
});

describe("M2: every render is metered", () => {
  const USAGE = {
    promptTokenCount: 40,
    responseTokenCount: 150,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 40 }],
    responseTokensDetails: [{ modality: "AUDIO", tokenCount: 140 }, { modality: "TEXT", tokenCount: 10 }],
  };

  it("logs outbound_render_usage with the line kind, the outcome and the token buckets", async () => {
    const { connect } = fakeConnect({ usage: USAGE });
    const log = quietLog();
    await renderLines({
      lines: { opener: OPENER, voicemail: VOICEMAIL },
      voiceName: "Kore",
      languageCode: "en-GB",
      connect,
      log,
      logFields: { outreachId: "out-1", attemptNo: 1 },
    });
    const usageLines = log.info.mock.calls.filter(([e]) => e === "outbound_render_usage").map(([, f]) => f);
    expect(usageLines).toHaveLength(2);
    expect(usageLines.find((f) => f.kind === "opener")).toEqual({
      outreachId: "out-1",
      attemptNo: 1,
      kind: "opener",
      outcome: "accepted",
      text_in: 40,
      audio_in: 0,
      text_out: 10,
      audio_out: 140,
      cached_in: 0,
      turns_billed: 1,
    });
    expect(usageLines.find((f) => f.kind === "voicemail")).toMatchObject({ outcome: "accepted", audio_out: 140 });
  });

  it("a refused render is metered too -- it was billed", async () => {
    const { connect } = fakeConnect({ usage: USAGE, say: () => "Hello." });
    const log = quietLog();
    await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log, graceMs: 5 });
    expect(log.info).toHaveBeenCalledWith(
      "outbound_render_usage",
      expect.objectContaining({ kind: "opener", outcome: "transcript_mismatch", audio_out: 140 })
    );
  });
});

describe("I4: each verified clip is handed over as soon as its own render finishes", () => {
  it("the opener reaches onLine while the voicemail render is still running", async () => {
    let releaseVoicemail;
    const voicemailHeld = new Promise((r) => (releaseVoicemail = r));
    const { connect } = fakeConnect({ gate: (line) => (line === VOICEMAIL ? voicemailHeld : null) });
    const onLine = vi.fn(async () => {});
    let settled = false;
    const p = renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog(), onLine }).then((v) => {
      settled = true;
      return v;
    });

    await vi.waitFor(() => expect(onLine).toHaveBeenCalledTimes(1));
    expect(onLine.mock.calls[0][0]).toBe("opener");
    expect(onLine.mock.calls[0][1].length).toBe(8000);
    expect(settled).toBe(false);

    releaseVoicemail();
    const out = await p;
    expect(onLine).toHaveBeenCalledTimes(2);
    expect(onLine.mock.calls[1][0]).toBe("voicemail");
    expect(out.voicemail.length).toBe(8000);
  });

  it("a refused line is never handed over; a throwing onLine is logged and does not fail the render", async () => {
    const { connect } = fakeConnect({ say: (line) => (line === VOICEMAIL ? "nope" : line) });
    const log = quietLog();
    const onLine = vi.fn(async () => {
      throw new Error("store refused");
    });
    const out = await renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log, onLine, graceMs: 5 });
    expect(onLine.mock.calls.map((c) => c[0])).toEqual(["opener"]);
    expect(out.opener.length).toBe(8000);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_store_refused", expect.objectContaining({ kind: "opener", error: "store refused" }));
  });

  it("the adapter passes dispatch's onClip through", async () => {
    const db = {
      withTenant: vi.fn(async (_id, fn) => fn()),
      fetchBusinessById: vi.fn(async () => ({ id: "biz-digile", name: "Digile Media", locale: "en-GB" })),
      fetchBusinessCapabilities: vi.fn(async () => []),
      loadConfig,
    };
    const { connect } = fakeConnect();
    const onClip = vi.fn(async () => {});
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });
    await renderAudio({ row: { id: "out-1", business_id: "biz-digile", config: { caller_id: "+441372656055" } }, attemptNo: 1, lines: { opener: OPENER }, onClip });
    expect(onClip).toHaveBeenCalledWith("opener", expect.any(Buffer));
  });
});

describe("round 3: the clip check shares the session's dotted-AI fold", () => {
  it("a transcript that spells it 'A. I.' keeps the disclosure", async () => {
    const { connect } = fakeConnect({ say: () => "Hi, is that Sam? It's Ava, an A. I. assistant from Digile Media." });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).not.toBeNull();
  });

  it("'A. I' with no dot after the I is two words, not the disclosure: refused", async () => {
    const { connect } = fakeConnect({ say: () => "Hi, is that Sam? It's Ava, an A. I assistant from Digile Media." });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log, graceMs: 5 });
    expect(out.opener).toBeNull();
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", expect.objectContaining({ reason: "transcript_mismatch" }));
  });
});

// ---------------------------------------------------------------------------
// H1 (2026-09-26 paid harness run): a correct opener clip was refused because
// Gemini's output transcription glued words together ("isthat", "It'sAva",
// "AIassistant", "HarnessTest") -- the clip was right, only the transcript's
// spacing was wrong. Real evidence, used verbatim.
// ---------------------------------------------------------------------------

describe("H1: a glued transcript token is re-split into the line's own words before scoring", () => {
  const LINE = "Hi, is that Sam? It's Ava, an AI assistant from Harness Test Clinic.";
  // The real transcript from the paid run: overlap was 0.385, word_ratio 0.692,
  // refused -- with every word actually said correctly.
  const GLUED_TRANSCRIPT = "Hi, isthat Sam? It'sAva, an AIassistant from HarnessTest Clinic.";

  it("scores as a perfect match once glued tokens are re-split (overlap 1, ratio 1)", () => {
    expect(wordOverlap(LINE, GLUED_TRANSCRIPT)).toBe(1);
    expect(wordRatio(LINE, GLUED_TRANSCRIPT)).toBe(1);
  });

  it("renders and is ACCEPTED end-to-end (the harness's real failure mode)", async () => {
    const { connect } = fakeConnect({ say: () => GLUED_TRANSCRIPT });
    const out = await renderLines({ lines: { opener: LINE }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).not.toBeNull();
  });

  it("still refused when the SAME gluing also drops the AI disclosure", async () => {
    const gluedAndDroppedAi = "Hi, isthat Sam? It'sAva, an assistant from HarnessTest Clinic.";
    const { connect } = fakeConnect({ say: () => gluedAndDroppedAi });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: LINE }, voiceName: "Kore", languageCode: "en-GB", connect, log, graceMs: 5 });
    expect(out.opener).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "outbound_backstop_render_refused",
      expect.objectContaining({ reason: "transcript_mismatch" })
    );
  });

  it("a glued token that is NOT composed of the line's own words stays as-is (still a miss)", () => {
    // "isthot" cannot be segmented into line words ("thot" is not one), so it
    // stays a single unmatched token: both "is" and "that" are missed.
    const brokenGlue = "Hi, isthot Sam? It'sAva, an AIassistant from HarnessTest Clinic.";
    expect(wordOverlap(LINE, brokenGlue)).toBeCloseTo(11 / 13, 5);
  });
});
