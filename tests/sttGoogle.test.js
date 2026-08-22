import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockStreamingRecognize, mockGetConfig } = vi.hoisted(() => ({
  mockStreamingRecognize: vi.fn(),
  mockGetConfig: vi.fn(),
}));

vi.mock("@google-cloud/speech", () => ({
  v2: {
    SpeechClient: vi.fn().mockImplementation(function (opts) {
      this.opts = opts;
      this._streamingRecognize = mockStreamingRecognize;
      this.getConfig = mockGetConfig;
      this.close = vi.fn();
    }),
  },
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createGoogleSttStream, assertSttEncryption } from "../lib/voice/sttGoogle.js";

/**
 * A controllable fake of the gRPC duplex returned by `_streamingRecognize()`.
 *
 * Deliberately models the two behaviours that bit the live probe: writes after
 * a destroy throw, and every response may carry SEVERAL results at once.
 */
function createFakeStream() {
  const handlers = {};
  return {
    handlers,
    writes: [],
    destroyed: false,
    on: vi.fn(function (event, cb) {
      handlers[event] = cb;
      return this;
    }),
    write: vi.fn(function (msg) {
      if (this.destroyed) throw Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
      this.writes.push(msg);
    }),
    end: vi.fn(function () {
      this.destroyed = true;
    }),
    destroy: vi.fn(function () {
      this.destroyed = true;
    }),
    emit(event, payload) {
      handlers[event]?.(payload);
    },
  };
}

/** One StreamingRecognizeResponse carrying results. */
function resultsMsg(results) {
  return { results: results.map((r) => ({
    isFinal: !!r.isFinal,
    stability: r.stability ?? 0,
    resultEndOffset: r.endOffset != null ? { seconds: Math.floor(r.endOffset), nanos: Math.round((r.endOffset % 1) * 1e9) } : null,
    alternatives: [{
      transcript: r.text,
      confidence: r.confidence ?? 0,
      ...(r.lastWordEnd != null
        ? { words: [{ endOffset: { seconds: Math.floor(r.lastWordEnd), nanos: Math.round((r.lastWordEnd % 1) * 1e9) } }] }
        : {}),
    }],
  })) };
}

/** One StreamingRecognizeResponse carrying a speech event. */
function eventMsg(type) {
  return { speechEventType: type, results: [] };
}

const BASE_ENV = {
  GOOGLE_CLOUD_PROJECT: "vetra-us-staging-c3a3bd",
  STT_LOCATION: "us-central1",
};

describe("sttGoogle.js — Google Speech-to-Text v2 streaming", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    Object.assign(process.env, BASE_ENV);
    mockStreamingRecognize.mockReset();
    mockGetConfig.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Connection configuration
  // -------------------------------------------------------------------------

  it("1. opens with the telephony model, 8kHz mulaw, and voice-activity events", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    await createGoogleSttStream({ language: "en-US", callSid: "CA1" });

    const first = fake.writes[0];
    expect(first.recognizer).toBe(
      "projects/vetra-us-staging-c3a3bd/locations/us-central1/recognizers/_"
    );
    const cfg = first.streamingConfig.config;
    expect(cfg.explicitDecodingConfig).toEqual({
      encoding: "MULAW",
      sampleRateHertz: 8000,
      audioChannelCount: 1,
    });
    expect(cfg.model).toBe("telephony");
    expect(cfg.languageCodes).toEqual(["en-US"]);
    // Word offsets are not decoration: getLastSpeechEndAt is built on them.
    expect(cfg.features.enableWordTimeOffsets).toBe(true);
    expect(cfg.features.enableAutomaticPunctuation).toBe(true);
    // Without voice-activity events there is no endpointing signal at all —
    // the live probe showed the final only lands when the stream closes.
    expect(first.streamingConfig.streamingFeatures).toMatchObject({
      interimResults: true,
      enableVoiceActivityEvents: true,
    });
  });

  it("2. talks to the REGIONAL endpoint for the configured location", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const { v2 } = await import("@google-cloud/speech");

    await createGoogleSttStream({ callSid: "CA2" });

    expect(v2.SpeechClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiEndpoint: "us-central1-speech.googleapis.com" })
    );
  });

  it("3. REFUSES the `global` location — it routes audio anywhere on earth", async () => {
    process.env.STT_LOCATION = "global";
    await expect(createGoogleSttStream({ callSid: "CA3" })).rejects.toThrow(/global/i);
  });

  it("4. refuses to open without GOOGLE_CLOUD_PROJECT", async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    await expect(createGoogleSttStream({ callSid: "CA4" })).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  // -------------------------------------------------------------------------
  // Utterance assembly — the part that decides turn-taking
  // -------------------------------------------------------------------------

  it("5. flushes the accumulated final on SPEECH_ACTIVITY_END, not on is_final", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onFinal = vi.fn();
    const onUtteranceEnd = vi.fn();

    await createGoogleSttStream({ callSid: "CA5", onFinal, onUtteranceEnd });

    fake.emit("data", resultsMsg([{ text: "My number is", isFinal: true, confidence: 0.9 }]));
    // Google has no `speech_final`. An is_final alone must NOT end the turn, or
    // every multi-fragment utterance is cut in half.
    expect(onFinal).not.toHaveBeenCalled();

    fake.emit("data", resultsMsg([{ text: "five five five two", isFinal: true, confidence: 0.8 }]));
    fake.emit("data", eventMsg("SPEECH_ACTIVITY_END"));

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal.mock.calls[0][0]).toBe("My number is five five five two");
    expect(onUtteranceEnd).toHaveBeenCalledTimes(1);
  });

  it("6. concatenates EVERY result in one response, not just the first", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onInterim = vi.fn();

    await createGoogleSttStream({ callSid: "CA6", onInterim });

    // The live probe's actual shape: a settled prefix and an unstable tail
    // arrive as two results in ONE response. Taking results[0] drops the tail.
    fake.emit("data", resultsMsg([
      { text: "my number", stability: 0.9 },
      { text: " is,", stability: 0.01 },
    ]));

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onInterim.mock.calls[0][0]).toBe("my number is,");
  });

  it("7. reports confidence 0 as UNKNOWN, because 0 would suppress every barge-in", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onFinal = vi.fn();

    await createGoogleSttStream({ callSid: "CA7", onFinal });

    // Google returns confidence 0 on interims and on some finals. turnManager
    // treats a number below BARGE_MIN_CONFIDENCE as "do not interrupt", so
    // forwarding a literal 0 would make the caller unable to interrupt at all.
    fake.emit("data", resultsMsg([{ text: "hello there", isFinal: true, confidence: 0 }]));
    fake.emit("data", eventMsg("SPEECH_ACTIVITY_END"));

    expect(onFinal).toHaveBeenCalledWith("hello there", { confidence: undefined });
  });

  it("8. reports the MINIMUM confidence across the fragments of one utterance", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onFinal = vi.fn();

    await createGoogleSttStream({ callSid: "CA8", onFinal });

    fake.emit("data", resultsMsg([{ text: "book me", isFinal: true, confidence: 0.95 }]));
    fake.emit("data", resultsMsg([{ text: "tuesday", isFinal: true, confidence: 0.42 }]));
    fake.emit("data", eventMsg("SPEECH_ACTIVITY_END"));

    expect(onFinal).toHaveBeenCalledWith("book me tuesday", { confidence: 0.42 });
  });

  it("9. SPEECH_ACTIVITY_BEGIN fires onSpeechStarted", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onSpeechStarted = vi.fn();

    await createGoogleSttStream({ callSid: "CA9", onSpeechStarted });
    fake.emit("data", eventMsg("SPEECH_ACTIVITY_BEGIN"));

    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
  });

  it("10. an empty utterance does not fire onFinal, but still fires onUtteranceEnd", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    const onFinal = vi.fn();
    const onUtteranceEnd = vi.fn();

    await createGoogleSttStream({ callSid: "CA10", onFinal, onUtteranceEnd });
    fake.emit("data", eventMsg("SPEECH_ACTIVITY_END"));

    expect(onFinal).not.toHaveBeenCalled();
    // The ladder re-arms off onUtteranceEnd. Swallowing it on a silent
    // endpoint is how a call goes permanently quiet.
    expect(onUtteranceEnd).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Speech-end reconstruction
  // -------------------------------------------------------------------------

  it("11. back-dates speech end using the last word offset against delivered audio", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    let clock = 10_000;

    const handle = await createGoogleSttStream({ callSid: "CA11", now: () => clock });

    // 4,000 bytes of mulaw = 500ms of audio delivered.
    handle.sendAudio(Buffer.alloc(4000, 0xff));
    // The last word ended 0.3s in, so 200ms of the delivered audio is tail.
    fake.emit("data", resultsMsg([{ text: "yes", isFinal: true, confidence: 0.9, lastWordEnd: 0.3 }]));

    expect(handle.getLastSpeechEndAt()).toBe(10_000 - 200);
  });

  it("12. never back-dates into the future when the clocks disagree", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    let clock = 5_000;

    const handle = await createGoogleSttStream({ callSid: "CA12", now: () => clock });
    handle.sendAudio(Buffer.alloc(800, 0xff)); // 100ms delivered
    // A word ending at 2s describes audio we never sent.
    fake.emit("data", resultsMsg([{ text: "hi", isFinal: true, confidence: 0.9, lastWordEnd: 2 }]));

    expect(handle.getLastSpeechEndAt()).toBe(5_000);
  });

  // -------------------------------------------------------------------------
  // Audio delivery
  // -------------------------------------------------------------------------

  it("13. sends audio as { audio } messages after the config message", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    const handle = await createGoogleSttStream({ callSid: "CA13" });
    const chunk = Buffer.alloc(160, 0xff);
    handle.sendAudio(chunk);

    expect(fake.writes).toHaveLength(2);
    expect(fake.writes[1]).toEqual({ audio: chunk });
  });

  it("14. buffers audio instead of throwing when the stream is gone", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    const handle = await createGoogleSttStream({ callSid: "CA14" });
    fake.destroyed = true;

    // The live failure mode: 200+ ERR_STREAM_DESTROYED throws per second once
    // the server aborts a stream. A dead socket must never reach the caller.
    expect(() => handle.sendAudio(Buffer.alloc(160, 0xff))).not.toThrow();
  });

  it("15. close() is idempotent and stops further writes", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    const handle = await createGoogleSttStream({ callSid: "CA15" });
    handle.close();
    handle.close();

    const before = fake.writes.length;
    handle.sendAudio(Buffer.alloc(160, 0xff));
    expect(fake.writes.length).toBe(before);
    expect(handle.isAlive()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The CMEK assertion (the owner's chosen unlogged-tier control)
  // -------------------------------------------------------------------------

  it("16. assertSttEncryption passes when the location Config carries a CMEK key", async () => {
    mockGetConfig.mockResolvedValue([
      { name: "projects/536266051432/locations/us-central1/config", kmsKeyName: "projects/p/locations/us-central1/keyRings/r/cryptoKeys/k" },
    ]);

    await expect(assertSttEncryption()).resolves.toMatchObject({
      kmsKeyName: expect.stringContaining("cryptoKeys/k"),
    });
  });

  it("17. assertSttEncryption THROWS when the location Config has no CMEK key", async () => {
    mockGetConfig.mockResolvedValue([
      { name: "projects/536266051432/locations/us-central1/config", kmsKeyName: "" },
    ]);

    await expect(assertSttEncryption()).rejects.toThrow(/CMEK|kms/i);
  });

  // -------------------------------------------------------------------------
  // Language and domain terms
  // -------------------------------------------------------------------------

  it("18. expands Deepgram's \"multi\" into an explicit language list", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);
    process.env.STT_MULTI_LANGUAGES = "en-US,es-US";

    await createGoogleSttStream({ language: "multi", callSid: "CA18" });

    // "multi" is a Deepgram concept. Google needs real codes, and passing the
    // literal string would transcribe every Spanish caller as English.
    expect(fake.writes[0].streamingConfig.config.languageCodes).toEqual(["en-US", "es-US"]);
  });

  it("19. boosts business terms via an inline phrase set", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    await createGoogleSttStream({
      language: "en-US",
      keyterms: ["Excel Cardiac Care", "Szymanski"],
      callSid: "CA19",
    });

    const adaptation = fake.writes[0].streamingConfig.config.adaptation;
    expect(adaptation.phraseSets).toHaveLength(1);
    expect(adaptation.phraseSets[0].inlinePhraseSet.phrases).toEqual([
      { value: "Excel Cardiac Care", boost: expect.any(Number) },
      { value: "Szymanski", boost: expect.any(Number) },
    ]);
  });

  it("20. sends NO adaptation block when there are no keyterms", async () => {
    const fake = createFakeStream();
    mockStreamingRecognize.mockReturnValue(fake);

    await createGoogleSttStream({ language: "en-US", keyterms: [], callSid: "CA20" });

    expect(fake.writes[0].streamingConfig.config.adaptation).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The 5-minute wall-clock cap
  // -------------------------------------------------------------------------

  it("21. rotates the stream before the 5-minute server cap, replaying buffered audio", async () => {
    vi.useFakeTimers();
    const first = createFakeStream();
    const second = createFakeStream();
    mockStreamingRecognize.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onReconnect = vi.fn();

    const handle = await createGoogleSttStream({ callSid: "CA21", onReconnect });
    expect(mockStreamingRecognize).toHaveBeenCalledTimes(1);

    // The cap is on WALL-CLOCK stream age, measured live at 295.3s. A rotation
    // keyed to delivered audio would fire after the server had already killed
    // the stream.
    await vi.advanceTimersByTimeAsync(241_000);

    expect(mockStreamingRecognize).toHaveBeenCalledTimes(2);
    // The replacement must be configured, not raw.
    expect(second.writes[0].streamingConfig).toBeDefined();
    expect(first.end).toHaveBeenCalled();

    handle.sendAudio(Buffer.alloc(160, 0xff));
    expect(second.writes.at(-1)).toEqual({ audio: Buffer.alloc(160, 0xff) });
    handle.close();
  });

  it("22. a rotation mid-utterance does not lose the words already transcribed", async () => {
    vi.useFakeTimers();
    const first = createFakeStream();
    const second = createFakeStream();
    mockStreamingRecognize.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onFinal = vi.fn();

    const handle = await createGoogleSttStream({ callSid: "CA22", onFinal });
    fake_emit_final(first, "I would like to book");

    // Rotation comes due mid-utterance. It must NOT swap here — that would cut
    // the caller off mid-sentence — so the old stream stays up.
    await vi.advanceTimersByTimeAsync(241_000);
    expect(mockStreamingRecognize).toHaveBeenCalledTimes(1);

    // ...but it cannot wait forever, or it walks into the 5-minute cap it
    // exists to dodge. At the deadline it forces the swap, flushing first.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockStreamingRecognize).toHaveBeenCalledTimes(2);

    fake_emit_final(second, "for Tuesday");
    second.emit("data", eventMsg("SPEECH_ACTIVITY_END"));

    // Whatever happens to the socket, the caller's words survive it.
    const said = onFinal.mock.calls.map((c) => c[0]).join(" ");
    expect(said).toContain("I would like to book");
    expect(said).toContain("for Tuesday");
    handle.close();
  });

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  it("23. reconnects after a stream error and replays buffered audio", async () => {
    vi.useFakeTimers();
    const first = createFakeStream();
    const second = createFakeStream();
    mockStreamingRecognize.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onReconnect = vi.fn();

    const handle = await createGoogleSttStream({ callSid: "CA23", onReconnect });

    first.destroyed = true;
    first.emit("error", Object.assign(new Error("10 ABORTED: Max duration of 5 minutes reached for stream."), { code: 10 }));

    // Audio arriving mid-reconnect is held, not dropped.
    handle.sendAudio(Buffer.alloc(160, 0x01));
    await vi.advanceTimersByTimeAsync(1000);

    expect(onReconnect).toHaveBeenCalled();
    const replayed = second.writes.filter((w) => w.audio);
    expect(replayed.length).toBeGreaterThan(0);
    handle.close();
  });

  it("24. gives up after 3 failed reconnects and reports a terminal error", async () => {
    vi.useFakeTimers();
    const first = createFakeStream();
    mockStreamingRecognize.mockReturnValueOnce(first).mockImplementation(() => {
      throw new Error("connect refused");
    });
    const onError = vi.fn();

    const handle = await createGoogleSttStream({ callSid: "CA24", onError });
    first.emit("error", new Error("boom"));
    await vi.advanceTimersByTimeAsync(5000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("STT_RECONNECT_FAILED");
    handle.close();
  });
});

/** Emit one is_final fragment on a fake stream. */
function fake_emit_final(stream, text) {
  stream.emit("data", {
    results: [{
      isFinal: true,
      stability: 0,
      resultEndOffset: null,
      alternatives: [{ transcript: text, confidence: 0.9 }],
    }],
  });
}
