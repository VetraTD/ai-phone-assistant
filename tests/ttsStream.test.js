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

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

describe("ttsStream.js — per-turn TTS orchestration with ElevenLabs + Google fallback", () => {
  beforeEach(() => {
    instances.length = 0;
    mockSynthesizeMulaw.mockReset();
    process.env.ELEVENLABS_API_KEY = "test-xi-key";
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
        voice_settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false, speed: 1 },
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

  it("8b. ElevenLabs dying AFTER end() (mid-flush, before isFinal) with audio already played completes via onDone({truncated: true}), not silently", () => {
    const onAudioChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const turn = createTtsTurn({ voiceId: "v1", callSid: "CA8b", epoch: 1, getEpoch: () => 1, onAudioChunk, onDone, onError });
    turn.write("Hello there, here is the first part.");

    const sock = instances[0];
    sock._open();
    sock._message({ audio: b64(Buffer.from([1, 2, 3])) }); // some audio already played
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    turn.end(); // flush sent, waiting on isFinal
    expect(onDone).not.toHaveBeenCalled();

    // ElevenLabs dies right here — no isFinal ever arrives.
    sock._emit("error", new Error("socket died mid-flush"));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ truncated: true });
    expect(onError).not.toHaveBeenCalled(); // this is a truncation, not a hard failure — no Google resynthesis is attempted
    expect(turn.getStatus()).toEqual({ truncated: true, elErrored: true, doneFired: true });
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
