import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake `ws` WebSocket — controllable from tests (open/message/close/error).
// Defined inside vi.hoisted so both the mock factory and the test body can
// reach it before the real modules (services/elevenlabs.js) are imported.
// ---------------------------------------------------------------------------
const { instances, FakeWebSocket } = vi.hoisted(() => {
  const instances = [];

  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sentRaw = [];
      this.listeners = {};
      instances.push(this);
    }
    on(event, cb) {
      (this.listeners[event] ||= []).push(cb);
      return this;
    }
    send(data) {
      this.sentRaw.push(data);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this._emit("close");
    }
    terminate() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this._emit("close");
    }
    _emit(event, ...args) {
      (this.listeners[event] || []).slice().forEach((cb) => cb(...args));
    }
    _open() {
      this.readyState = FakeWebSocket.OPEN;
      this._emit("open");
    }
    _message(obj) {
      this._emit("message", Buffer.from(JSON.stringify(obj)));
    }
    sentMessages() {
      return this.sentRaw.map((s) => JSON.parse(s));
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  return { instances, FakeWebSocket };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));

const { mockSynthesizeMulaw } = vi.hoisted(() => ({ mockSynthesizeMulaw: vi.fn() }));
vi.mock("../services/googleTts.js", () => ({ synthesizeMulaw: mockSynthesizeMulaw }));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createTtsTurn } from "../lib/voice/ttsStream.js";
import { ttsHealth } from "../lib/voice/ttsHealth.js";
import { trimPreviousText } from "../services/elevenlabs.js";

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

describe("ttsStream.js — per-turn TTS orchestration with ElevenLabs + Google fallback", () => {
  beforeEach(() => {
    instances.length = 0;
    mockSynthesizeMulaw.mockReset();
    process.env.ELEVENLABS_API_KEY = "test-xi-key";
    // ELEVENLABS_MODEL is an optional A/B knob — a value leaked from one test
    // must not change the default model URL asserted by the others.
    delete process.env.ELEVENLABS_MODEL;
    // The circuit breaker is a process-wide singleton — EL failures triggered
    // by earlier tests must not leak "breaker open" into later ones.
    ttsHealth.recordSuccess();
  });

  it("1. opens the correct WS URL with model_id/ulaw_8000/auto_mode, sends xi-api-key header, and sends the handshake frame on open", () => {
    createTtsTurn({ voiceId: "voice123", callSid: "CA1", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() });

    expect(instances).toHaveLength(1);
    const sock = instances[0];

    expect(sock.url).toBe(
      "wss://api.elevenlabs.io/v1/text-to-speech/voice123/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000&auto_mode=true"
    );
    // Auth must actually reach the wire as a real header on the handshake.
    expect(sock.options.headers["xi-api-key"]).toBe("test-xi-key");

    sock._open();

    expect(sock.sentMessages()).toEqual([
      {
        text: " ",
        voice_settings: { stability: 0.65, similarity_boost: 0.8, use_speaker_boost: false, speed: 1 },
      },
    ]);
  });

  it("2. sendText appends a trailing space; write() forwards text deltas to the connection (even queued before open)", () => {
    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA2", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    turn.write("Hello"); // written before the socket is open — must be queued, not dropped

    const sock = instances[0];
    sock._open();
    turn.write("world"); // written after open — sent directly

    const msgs = sock.sentMessages();
    expect(msgs[0].text).toBe(" "); // handshake first

    const textFrames = msgs.filter((m) => m.text && m.text !== " ");
    expect(textFrames.map((m) => m.text)).toEqual(["Hello ", "world "]);
  });

  it("3. decodes base64 audio into Buffers for onAudioChunk; onFirstAudio fires exactly once", () => {
    const onAudioChunk = vi.fn();
    const onFirstAudio = vi.fn();
    createTtsTurn({
      voiceId: "v1",
      callSid: "CA3",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk,
      onFirstAudio,
      onDone: vi.fn(),
      onError: vi.fn(),
    }).write("Hi");

    const sock = instances[0];
    sock._open();

    const chunk1 = Buffer.from([1, 2, 3]);
    const chunk2 = Buffer.from([4, 5, 6]);
    sock._message({ audio: b64(chunk1) });
    sock._message({ audio: b64(chunk2) });

    expect(onAudioChunk).toHaveBeenCalledTimes(2);
    expect(onAudioChunk.mock.calls[0][0]).toEqual(chunk1);
    expect(onAudioChunk.mock.calls[1][0]).toEqual(chunk2);
    expect(onFirstAudio).toHaveBeenCalledTimes(1);
  });

  it("4. end() sends the end-of-input frame, then isFinal triggers onDone", () => {
    const onDone = vi.fn();
    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA4", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone, onError: vi.fn() });
    turn.write("Hello there");

    const sock = instances[0];
    sock._open();
    turn.end();

    const msgs = sock.sentMessages();
    // Empty text, NOT {flush:true} — with auto_mode the server answers a
    // flush frame with audio but never isFinal, which stalled every turn's
    // completion mark until the 20s server-side idle timeout.
    expect(msgs[msgs.length - 1]).toEqual({ text: "" });
    expect(msgs.some((m) => m.flush)).toBe(false);
    expect(onDone).not.toHaveBeenCalled();

    sock._message({ isFinal: true });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("5. abort() suppresses further onAudioChunk even if late audio messages arrive, and sends a close frame", () => {
    const onAudioChunk = vi.fn();
    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA5", epoch: 1, getEpoch: () => 1, onAudioChunk, onDone: vi.fn(), onError: vi.fn() });
    turn.write("Hello");

    const sock = instances[0];
    sock._open();
    sock._message({ audio: b64(Buffer.from([9])) });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    turn.abort();

    const msgs = sock.sentMessages();
    expect(msgs.some((m) => m.text === "")).toBe(true); // close frame sent

    // Late audio arriving after abort must not reach onAudioChunk.
    sock._message({ audio: b64(Buffer.from([10])) });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);
  });

  it("6. epoch mismatch (barge-in elsewhere) suppresses onAudioChunk without calling abort()", () => {
    const onAudioChunk = vi.fn();
    let epoch = 1;
    const turn = createTtsTurn({
      voiceId: "v1",
      callSid: "CA6",
      epoch: 1,
      getEpoch: () => epoch,
      onAudioChunk,
      onDone: vi.fn(),
      onError: vi.fn(),
    });
    turn.write("Hello");

    const sock = instances[0];
    sock._open();
    sock._message({ audio: b64(Buffer.from([1])) });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    epoch = 2; // a newer turn started; this turn's epoch (1) is now stale
    sock._message({ audio: b64(Buffer.from([2])) });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);
  });

  it("7. connect timeout falls back to Google TTS per sentence on end(), emitting chunks and onDone", async () => {
    vi.useFakeTimers();
    try {
      const onAudioChunk = vi.fn();
      const onDone = vi.fn();
      const onError = vi.fn();
      const fallbackBuf1 = Buffer.from([1, 1]);
      const fallbackBuf2 = Buffer.from([2, 2]);
      mockSynthesizeMulaw.mockResolvedValueOnce(fallbackBuf1).mockResolvedValueOnce(fallbackBuf2);

      const turn = createTtsTurn({ voiceId: "v1", callSid: "CA7", epoch: 1, getEpoch: () => 1, onAudioChunk, onDone, onError });
      turn.write("Hello there. How are you?");

      // Never call sock._open() — let the 3000ms connect timeout elapse.
      await vi.advanceTimersByTimeAsync(3001);

      turn.end();
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

      expect(mockSynthesizeMulaw).toHaveBeenCalledTimes(2);
      expect(mockSynthesizeMulaw).toHaveBeenNthCalledWith(1, "Hello there.", "en-US-Chirp3-HD-Aoede", "CA7");
      expect(mockSynthesizeMulaw).toHaveBeenNthCalledWith(2, "How are you?", "en-US-Chirp3-HD-Aoede", "CA7");
      expect(onAudioChunk).toHaveBeenCalledWith(fallbackBuf1);
      expect(onAudioChunk).toHaveBeenCalledWith(fallbackBuf2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("8. both ElevenLabs and Google fallback fail -> onError is called, nothing throws", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const onDone = vi.fn();
      const fallbackErr = new Error("google tts down");
      mockSynthesizeMulaw.mockRejectedValueOnce(fallbackErr);

      const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone, onError });
      turn.write("Hello there.");

      expect(() => {
        // no sock._open(); force the connect timeout below
      }).not.toThrow();

      await vi.advanceTimersByTimeAsync(3001);
      turn.end();

      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError.mock.calls[0][0]).toBe(fallbackErr);
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("8b. ElevenLabs dying AFTER end() (mid-flush, before isFinal) with only a trickle of audio played REPAIRS the unspoken remainder via Google, not silently", async () => {
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const repairBuf = Buffer.from([7, 7, 7]);
    // Only a few bytes were voiced, so the whole sentence is the remainder.
    mockSynthesizeMulaw.mockResolvedValue(repairBuf);

    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8b", epoch: 1, getEpoch: () => 1, onAudioChunk, onDone, onError });
    turn.write("Hello there, here is the first part.");

    const sock = instances[0];
    sock._open();
    sock._message({ audio: b64(Buffer.from([1, 2, 3])) }); // a trickle of audio played (3 bytes)
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    turn.end(); // flush sent, waiting on isFinal
    expect(onDone).not.toHaveBeenCalled();

    // ElevenLabs dies right here — no isFinal ever arrives.
    sock._emit("error", new Error("socket died mid-flush"));

    // 3 bytes is ~0 chars voiced, so the boundary rounds down to 0 and the
    // whole sentence is resynthesized (not dropped).
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mockSynthesizeMulaw).toHaveBeenCalledWith("Hello there, here is the first part.", "en-US-Chirp3-HD-Aoede", "CA8b");
    expect(onAudioChunk).toHaveBeenCalledWith(repairBuf);
    expect(onError).not.toHaveBeenCalled();

    const payload = onDone.mock.calls[0][0];
    expect(payload.truncated).toBe(true);
    expect(payload.repairedFrom).toBe("duration");
    expect(payload.remainderChars).toBe("Hello there, here is the first part.".length);
    // spokenText = voiced prefix ("") + emitted remainder = the full sentence.
    expect(payload.spokenText).toBe("Hello there, here is the first part.");
    expect(turn.getStatus()).toEqual({ truncated: true, elErrored: true, doneFired: true });
  });

  it("8d. EL dies mid-turn after enough audio to have voiced sentence 1 -> repairs from the sentence boundary (remainder = sentences 2+3)", async () => {
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    mockSynthesizeMulaw.mockImplementation((sentence) => Promise.resolve(Buffer.from(sentence)));

    const text = "One sentence here. Two sentence here. Three sentence here.";
    const remainder = "Two sentence here. Three sentence here.";

    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8d", epoch: 1, getEpoch: () => 1, onAudioChunk, onDone, onError });
    turn.write(text);

    const sock = instances[0];
    sock._open();
    // 15000 mulaw bytes = 1.875s ≈ 28 chars voiced — lands mid-sentence-2, so
    // the boundary rounds DOWN to the end of sentence 1 (char 19). Remainder =
    // sentences 2 + 3.
    sock._message({ audio: b64(Buffer.alloc(15000)) });
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    turn.end();
    sock._emit("error", new Error("socket died mid-turn"));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    // Only the two remainder sentences are resynthesized — sentence 1 (already
    // voiced) is NOT re-spoken.
    const synthArgs = mockSynthesizeMulaw.mock.calls.map((c) => c[0]);
    expect(synthArgs).toEqual(["Two sentence here.", "Three sentence here."]);

    const payload = onDone.mock.calls[0][0];
    expect(payload.truncated).toBe(true);
    expect(payload.repairedFrom).toBe("duration");
    expect(payload.remainderChars).toBe(remainder.length);
    // spokenText = voiced prefix (sentence 1, incl. trailing space) + emitted
    // remainder sentences.
    expect(payload.spokenText).toBe("One sentence here. Two sentence here. Three sentence here.");
    expect(onError).not.toHaveBeenCalled();
  });

  it("8e. a barge (epoch bump) DURING repair synthesis cancels emission of the remaining sentences; onDone reports only what was voiced", async () => {
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    let epoch = 1;
    // Deferred synthesis so the test can barge between the error and the
    // remainder audio being produced.
    const resolvers = [];
    mockSynthesizeMulaw.mockImplementation(
      (sentence) => new Promise((resolve) => resolvers.push({ sentence, resolve }))
    );

    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8e", epoch: 1, getEpoch: () => epoch, onAudioChunk, onDone, onError });
    turn.write("One sentence here. Two sentence here. Three sentence here.");

    const sock = instances[0];
    sock._open();
    sock._message({ audio: b64(Buffer.alloc(15000)) }); // sentence 1 voiced
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    turn.end();
    sock._emit("error", new Error("socket died mid-turn"));

    // Repair synthesis has been kicked off for the remainder sentences.
    await vi.waitFor(() => expect(resolvers.length).toBeGreaterThan(0));

    // Caller barges in: a newer turn bumps the epoch. The repair must stop
    // emitting the remainder over them.
    epoch = 2;
    resolvers.forEach((r) => r.resolve(Buffer.from(r.sentence)));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    // No fallback audio was emitted after the barge — only the single
    // pre-error ElevenLabs chunk ever reached onAudioChunk.
    expect(onAudioChunk).toHaveBeenCalledTimes(1);
    const payload = onDone.mock.calls[0][0];
    expect(payload.truncated).toBe(true);
    // spokenText = voiced prefix only; no repaired remainder was emitted.
    expect(payload.spokenText).toBe("One sentence here. ");
    expect(onError).not.toHaveBeenCalled();
  });

  it("8c. ElevenLabs erroring before ANY audio played is a clean fallback, not truncated", async () => {
    const onDone = vi.fn();
    const fallbackBuf = Buffer.from([9, 9]);
    mockSynthesizeMulaw.mockResolvedValueOnce(fallbackBuf);

    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8c", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone, onError: vi.fn() });
    turn.write("Hello there.");

    const sock = instances[0];
    sock._open();
    sock._emit("error", new Error("connection reset")); // dies before any audio at all
    turn.end();

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith({ truncated: false });
    expect(mockSynthesizeMulaw).toHaveBeenCalledWith("Hello there.", "en-US-Chirp3-HD-Aoede", "CA8c");
  });

  it("9. voiceSettings opt is passed through to the ElevenLabs handshake, merged over its defaults", () => {
    createTtsTurn({
      voiceId: "voice123",
      callSid: "CA9",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      voiceSettings: { stability: 0.6, similarity_boost: 0.75 },
    });

    const sock = instances[0];
    sock._open();

    expect(sock.sentMessages()).toEqual([
      {
        text: " ",
        // merged over elevenlabs.js's DEFAULT_VOICE_SETTINGS — stability/
        // similarity_boost overridden, use_speaker_boost/speed kept.
        voice_settings: { stability: 0.6, similarity_boost: 0.75, use_speaker_boost: false, speed: 1 },
      },
    ]);
  });

  it("10. forceFallback=true opens no ElevenLabs connection and routes the whole turn through Google TTS", async () => {
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const buf = Buffer.from([7, 7]);
    mockSynthesizeMulaw.mockResolvedValueOnce(buf);

    const turn = createTtsTurn({
      voiceId: "voice123",
      callSid: "CA10",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk,
      onDone,
      onError,
      forceFallback: true,
      googleFallbackVoice: "en-GB-Chirp3-HD-Aoede",
    });

    turn.write("Hello there.");
    turn.end();

    // No ElevenLabs WS connection was ever opened.
    expect(instances).toHaveLength(0);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mockSynthesizeMulaw).toHaveBeenCalledWith("Hello there.", "en-GB-Chirp3-HD-Aoede", "CA10");
    expect(onAudioChunk).toHaveBeenCalledWith(buf);
    expect(onError).not.toHaveBeenCalled();
  });

  it("11. forceFallback=true still respects abort() (no ElevenLabs conn to close, must not throw)", () => {
    const turn = createTtsTurn({
      voiceId: "voice123",
      callSid: "CA11",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      forceFallback: true,
    });
    turn.write("Hello");
    expect(() => turn.abort()).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("12. breaker open -> no ElevenLabs connection is attempted; turn goes straight to Google", async () => {
    // Two consecutive EL failures open the breaker (transient policy).
    const err = new Error("socket error");
    ttsHealth.recordFailure(err);
    ttsHealth.recordFailure(err);
    expect(ttsHealth.isHealthy()).toBe(false);

    mockSynthesizeMulaw.mockResolvedValue(Buffer.from([1]));
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const turn = createTtsTurn({
      voiceId: "voice123",
      callSid: "CA12",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk,
      onDone,
      onError: vi.fn(),
    });
    turn.write("Hello there.");
    turn.end();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(instances).toHaveLength(0); // EL never attempted
    expect(mockSynthesizeMulaw).toHaveBeenCalled();
    expect(onAudioChunk).toHaveBeenCalled();
  });

  it("13. fallback synthesizes sentences concurrently but emits audio strictly in order", async () => {
    const resolvers = [];
    mockSynthesizeMulaw.mockImplementation(
      (sentence) => new Promise((resolve) => resolvers.push({ sentence, resolve }))
    );

    const chunks = [];
    const onDone = vi.fn();
    const turn = createTtsTurn({
      voiceId: "voice123",
      callSid: "CA13",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk: (buf) => chunks.push(buf.toString()),
      onDone,
      onError: vi.fn(),
      forceFallback: true,
    });
    turn.write("One. Two. Three.");
    turn.end();

    // All three synth calls were fired up-front (concurrency 3), before any
    // has resolved — the old serial loop would have fired only the first.
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));

    // Resolve out of order: 3rd, then 1st, then 2nd.
    resolvers[2].resolve(Buffer.from("three"));
    await Promise.resolve();
    expect(chunks).toEqual([]); // sentence 1 not ready — nothing emitted yet

    resolvers[0].resolve(Buffer.from("one"));
    resolvers[1].resolve(Buffer.from("two"));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(chunks).toEqual(["one", "two", "three"]); // strict order preserved
  });

  it("15. previousText opt is sent as previous_text on the handshake frame (prosody continuity) when non-empty", () => {
    createTtsTurn({
      voiceId: "voice123",
      callSid: "CA15",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      previousText: "Thanks so much for calling. This is the front desk.",
    });

    const sock = instances[0];
    sock._open();

    const handshake = sock.sentMessages()[0];
    expect(handshake.text).toBe(" ");
    expect(handshake.previous_text).toBe("Thanks so much for calling. This is the front desk.");
    expect(handshake.voice_settings).toMatchObject({ stability: 0.65, similarity_boost: 0.8 });
  });

  it("16. previousText that is empty/whitespace/undefined omits the previous_text field entirely", () => {
    for (const [i, prev] of [undefined, "", "   "].entries()) {
      instances.length = 0;
      createTtsTurn({
        voiceId: "voice123",
        callSid: `CA16-${i}`,
        epoch: 1,
        getEpoch: () => 1,
        onAudioChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        previousText: prev,
      });
      const sock = instances[0];
      sock._open();
      const handshake = sock.sentMessages()[0];
      expect(handshake).not.toHaveProperty("previous_text");
    }
  });

  it("17. a long previousText is trimmed to the last ~300 chars at a word boundary before sending", () => {
    // 40 words * ~10 chars each = ~400 chars, well over the 300 cap.
    const long = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(" ");
    createTtsTurn({
      voiceId: "voice123",
      callSid: "CA17",
      epoch: 1,
      getEpoch: () => 1,
      onAudioChunk: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      previousText: long,
    });
    const sock = instances[0];
    sock._open();
    const sent = sock.sentMessages()[0].previous_text;
    expect(sent.length).toBeLessThanOrEqual(300);
    expect(long.endsWith(sent)).toBe(true); // it is a suffix of the original
    expect(sent).toMatch(/^word\d{4}/); // starts cleanly on a whole word, not mid-token
  });

  it("18. ELEVENLABS_MODEL env overrides the model_id in the connection URL; unset/empty falls back to eleven_flash_v2_5", () => {
    process.env.ELEVENLABS_MODEL = "eleven_turbo_v2_5";
    createTtsTurn({ voiceId: "v1", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    expect(instances[0].url).toContain("model_id=eleven_turbo_v2_5");

    // Empty string is treated as unset.
    instances.length = 0;
    process.env.ELEVENLABS_MODEL = "   ";
    createTtsTurn({ voiceId: "v1", epoch: 1, getEpoch: () => 1, onAudioChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    expect(instances[0].url).toContain("model_id=eleven_flash_v2_5");
  });

  it("19. ELEVENLABS_DISABLE_PREVIOUS_TEXT=true (or \"1\") omits previous_text even when previousText is set; unset sends it normally", () => {
    const prevEnv = process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT;
    try {
      for (const [i, killSwitch] of ["true", "1"].entries()) {
        instances.length = 0;
        process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT = killSwitch;
        createTtsTurn({
          voiceId: "voice123",
          callSid: `CA19-${i}`,
          epoch: 1,
          getEpoch: () => 1,
          onAudioChunk: vi.fn(),
          onDone: vi.fn(),
          onError: vi.fn(),
          previousText: "Thanks so much for calling. This is the front desk.",
        });
        const sock = instances[0];
        sock._open();
        expect(sock.sentMessages()[0]).not.toHaveProperty("previous_text");
      }

      // Unset (and any other value, e.g. "false") restores normal behavior.
      instances.length = 0;
      delete process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT;
      createTtsTurn({
        voiceId: "voice123",
        callSid: "CA19-unset",
        epoch: 1,
        getEpoch: () => 1,
        onAudioChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        previousText: "Thanks so much for calling. This is the front desk.",
      });
      let sock = instances[0];
      sock._open();
      expect(sock.sentMessages()[0].previous_text).toBe("Thanks so much for calling. This is the front desk.");

      instances.length = 0;
      process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT = "false";
      createTtsTurn({
        voiceId: "voice123",
        callSid: "CA19-false",
        epoch: 1,
        getEpoch: () => 1,
        onAudioChunk: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
        previousText: "Thanks so much for calling. This is the front desk.",
      });
      sock = instances[0];
      sock._open();
      expect(sock.sentMessages()[0].previous_text).toBe("Thanks so much for calling. This is the front desk.");
    } finally {
      if (prevEnv === undefined) delete process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT;
      else process.env.ELEVENLABS_DISABLE_PREVIOUS_TEXT = prevEnv;
    }
  });

  describe("trimPreviousText helper", () => {
    it("returns '' for empty, whitespace, or non-string input", () => {
      expect(trimPreviousText("")).toBe("");
      expect(trimPreviousText("   ")).toBe("");
      expect(trimPreviousText(undefined)).toBe("");
      expect(trimPreviousText(null)).toBe("");
      expect(trimPreviousText(123)).toBe("");
    });

    it("returns short text unchanged (trimmed)", () => {
      expect(trimPreviousText("  Hello there.  ")).toBe("Hello there.");
    });

    it("keeps the last <=maxChars, starting on a word boundary", () => {
      const out = trimPreviousText("alpha beta gamma delta epsilon", 12);
      expect(out.length).toBeLessThanOrEqual(12);
      expect("alpha beta gamma delta epsilon".endsWith(out)).toBe(true);
      expect(out.startsWith(" ")).toBe(false);
      // Must not begin mid-word: the char before `out` in the source is a space.
      const idx = "alpha beta gamma delta epsilon".lastIndexOf(out);
      expect("alpha beta gamma delta epsilon"[idx - 1]).toBe(" ");
    });

    it("never splits a UTF-16 surrogate pair at the cut point", () => {
      // A run of emoji (each a surrogate pair) with no spaces.
      const emoji = "😀".repeat(50); // 100 UTF-16 code units
      const out = trimPreviousText(emoji, 15);
      // No lone surrogate at either end.
      const first = out.charCodeAt(0);
      const last = out.charCodeAt(out.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // not a lone low surrogate
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // not a lone high surrogate
    });
  });

  it("14. a later sentence rejecting while an earlier one is still pending does not raise an unhandled rejection", async () => {
    let resolveFirst;
    mockSynthesizeMulaw.mockImplementation((sentence) => {
      if (sentence === "One.") return new Promise((res) => { resolveFirst = res; });
      return Promise.reject(new Error("google down"));
    });

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const onError = vi.fn();
      const chunks = [];
      const turn = createTtsTurn({
        voiceId: "voice123",
        callSid: "CA14",
        epoch: 1,
        getEpoch: () => 1,
        onAudioChunk: (buf) => chunks.push(buf.toString()),
        onDone: vi.fn(),
        onError,
        forceFallback: true,
      });
      turn.write("One. Two.");
      turn.end();

      // Sentence 2 rejects immediately while the consumer is still awaiting
      // sentence 1 — the rejection must already be observed (handled).
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));

      resolveFirst(Buffer.from("one"));
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());

      expect(chunks).toEqual(["one"]); // sentence 1 still played
      expect(unhandled).toEqual([]); // no process-killing unhandled rejection
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
