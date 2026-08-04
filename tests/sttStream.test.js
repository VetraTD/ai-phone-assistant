import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));

vi.mock("@deepgram/sdk", () => ({
  DeepgramClient: vi.fn().mockImplementation(() => ({
    listen: { v1: { connect: mockConnect } },
  })),
}));

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createSttStream } from "../lib/voice/sttStream.js";

/** A controllable fake Deepgram V1Socket. */
function createFakeSocket() {
  const handlers = {};
  const socket = {
    handlers,
    on: vi.fn((event, cb) => {
      handlers[event] = cb;
    }),
    sendMedia: vi.fn(),
    sendKeepAlive: vi.fn(),
    connect: vi.fn(),
    waitForOpen: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      // Real V1Socket.close() synchronously fires its own close handler.
      handlers.close?.({ code: 1000 });
    }),
    emit(event, payload) {
      handlers[event]?.(payload);
    },
  };
  return socket;
}

function resultsMsg({ transcript, is_final = false, speech_final = false, confidence = 0.9 }) {
  return {
    type: "Results",
    is_final,
    speech_final,
    channel: { alternatives: [{ transcript, confidence }] },
  };
}

describe("sttStream.js — Deepgram nova-3 STT wrapper with reconnect", () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = "test-key";
    mockConnect.mockReset();
  });

  it("1. passes the exact connection config to connect(), including the Authorization header", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({ language: "en-US", callSid: "CA1" });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    const configArg = mockConnect.mock.calls[0][0];
    expect(configArg).toEqual({
      model: "nova-3",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      language: "en-US",
      smart_format: true,
      punctuate: true,
      numerals: true,
      interim_results: true,
      // Lowered 300 -> 150 on 2026-08-04. stt_endpoint_ms measured 700ms, of
      // which only the endpointing window is ours to spend; the rest is
      // Deepgram inference plus network. See docs/latency-and-tts-tests.md for
      // the probe D/E comparison that justified it, including whether
      // classifyHold started firing on the premature finals this invites.
      endpointing: 150,
      utterance_end_ms: 1000,
      vad_events: true,
      Authorization: "Token test-key",
    });

    handle.close();
  });

  it("1b. language=multi + explicit endpointing override passes endpointing through to connect()", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({ language: "multi", endpointing: 100, callSid: "CA1b" });

    const configArg = mockConnect.mock.calls[0][0];
    expect(configArg.language).toBe("multi");
    expect(configArg.endpointing).toBe(100);

    handle.close();
  });

  it("1c. English + keyterms passes repeated keyterm query params via the queryParams passthrough", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({
      language: "en-US",
      keyterms: ["Brightwork Dental", "John Smith"],
      callSid: "CA1c",
    });

    const configArg = mockConnect.mock.calls[0][0];
    // Passed through `queryParams` (NOT the top-level `keyterm` option): the
    // SDK JSON-encodes a top-level array into a single param, whereas the
    // passthrough is serialized by the ws layer with arrayFormat:"repeat" into
    // the repeated keyterm=A&keyterm=B params Deepgram's API actually wants.
    expect(configArg.queryParams).toEqual({ keyterm: ["Brightwork Dental", "John Smith"] });
    expect(configArg.keyterm).toBeUndefined();

    handle.close();
  });

  it("1d. no keyterms leaves the connect options byte-identical (no queryParams key)", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({ language: "en-US", keyterms: [], callSid: "CA1d" });

    expect(mockConnect.mock.calls[0][0]).not.toHaveProperty("queryParams");

    handle.close();
  });

  it("1e. skips keyterms entirely for language=multi (nova-3 keyterm is English-only)", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({
      language: "multi",
      endpointing: 100,
      keyterms: ["Brightwork Dental"],
      callSid: "CA1e",
    });

    expect(mockConnect.mock.calls[0][0]).not.toHaveProperty("queryParams");

    handle.close();
  });

  it("1f. skips keyterms for a non-English single language (e.g. es)", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({
      language: "es",
      keyterms: ["Brightwork Dental"],
      callSid: "CA1f",
    });

    expect(mockConnect.mock.calls[0][0]).not.toHaveProperty("queryParams");

    handle.close();
  });

  it("2. accumulates is_final fragments and fires onFinal on speech_final with joined text", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    const onFinal = vi.fn();

    const handle = await createSttStream({ callSid: "CA2", onFinal });

    fakeSocket.emit("message", resultsMsg({ transcript: "hello", is_final: true }));
    fakeSocket.emit("message", resultsMsg({ transcript: "world", is_final: true, speech_final: true }));

    expect(onFinal).toHaveBeenCalledTimes(1);
    // The second argument is the transcript's confidence, forwarded so
    // turnManager can refuse to let a low-confidence scrap interrupt.
    expect(onFinal).toHaveBeenCalledWith("hello world", expect.objectContaining({ confidence: expect.any(Number) }));

    handle.close();
  });

  // Confidence is the cheapest signal separating a real word from noise forced
  // into the nearest vocabulary item, and the pipeline threw it away for the
  // whole of its life: sttStream produced it on interims, session.js dropped
  // it, and no threshold existed anywhere in the repo. turnManager now refuses
  // to let a low-confidence scrap interrupt the assistant, which only works if
  // finals carry it too.
  it("2b. reports the MINIMUM confidence across the fragments making up a final", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    const onFinal = vi.fn();

    const handle = await createSttStream({ callSid: "CA2b", onFinal });

    // A final is assembled from several is_final results. The question being
    // asked downstream is "could any part of this be noise?", so the weakest
    // fragment is the honest answer — a mean would let one confident word
    // launder a garbage one.
    fakeSocket.emit("message", resultsMsg({ transcript: "hello", is_final: true, confidence: 0.95 }));
    fakeSocket.emit("message", resultsMsg({ transcript: "world", is_final: true, speech_final: true, confidence: 0.31 }));

    expect(onFinal).toHaveBeenCalledWith("hello world", { confidence: 0.31 });

    handle.close();
  });

  it("2c. reports undefined confidence rather than inventing one when Deepgram omits it", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    const onFinal = vi.fn();

    const handle = await createSttStream({ callSid: "CA2c", onFinal });

    // Downstream treats "not reported" as acceptable, not as "not confident" —
    // so a fabricated 0 here would silently suppress real interruptions.
    fakeSocket.emit("message", {
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "stop" }] },
    });

    expect(onFinal).toHaveBeenCalledWith("stop", { confidence: undefined });

    handle.close();
  });

  it("3. flushes buffered non-punctuated text on UtteranceEnd (bare 'Stop' reaches onFinal)", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    const onFinal = vi.fn();
    const onUtteranceEnd = vi.fn();

    const handle = await createSttStream({ callSid: "CA3", onFinal, onUtteranceEnd });

    fakeSocket.emit("message", resultsMsg({ transcript: "Stop", is_final: true, speech_final: false }));
    expect(onFinal).not.toHaveBeenCalled();

    fakeSocket.emit("message", { type: "UtteranceEnd" });

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("Stop", expect.objectContaining({ confidence: expect.any(Number) }));
    expect(onUtteranceEnd).toHaveBeenCalledTimes(1);

    handle.close();
  });

  it("4. forwards interim (non-final) results with confidence", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    const onInterim = vi.fn();

    const handle = await createSttStream({ callSid: "CA4", onInterim });

    fakeSocket.emit("message", resultsMsg({ transcript: "hel", is_final: false, confidence: 0.42 }));

    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onInterim).toHaveBeenCalledWith("hel", { confidence: 0.42 });

    handle.close();
  });

  it("5. reconnects with identical options after unexpected close, buffering and flushing audio sent mid-reconnect", async () => {
    const fakeSocket1 = createFakeSocket();
    const fakeSocket2 = createFakeSocket();
    mockConnect.mockResolvedValueOnce(fakeSocket1).mockResolvedValueOnce(fakeSocket2);
    const onReconnect = vi.fn();
    const onFinal = vi.fn();
    const onInterim = vi.fn();

    const handle = await createSttStream({ callSid: "CA5", onReconnect, onFinal, onInterim });
    expect(handle.isAlive()).toBe(true);

    // Unexpected close (not via handle.close())
    fakeSocket1.emit("close");
    expect(handle.isAlive()).toBe(false);

    // The superseded socket must be torn down immediately (not left dangling
    // with our handlers attached) so its own auto-reconnect can't silently
    // resurrect it later and deliver duplicate events.
    expect(fakeSocket1.close).toHaveBeenCalledTimes(1);

    // Audio sent while reconnecting should be buffered, not sent to any socket.
    const chunkA = Buffer.from("A".repeat(10));
    const chunkB = Buffer.from("B".repeat(10));
    handle.sendAudio(chunkA);
    handle.sendAudio(chunkB);
    expect(fakeSocket1.sendMedia).not.toHaveBeenCalled();
    expect(fakeSocket2.sendMedia).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    // Second connect() call used identical options.
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockConnect.mock.calls[1][0]).toEqual(mockConnect.mock.calls[0][0]);

    // Buffered audio flushed, in order, to the new socket.
    expect(fakeSocket2.sendMedia.mock.calls.map((c) => c[0])).toEqual([chunkA, chunkB]);
    expect(onReconnect).toHaveBeenCalledWith(1);
    expect(handle.isAlive()).toBe(true);

    // Passthrough resumed: new audio goes straight to the new socket.
    const chunkC = Buffer.from("C".repeat(10));
    handle.sendAudio(chunkC);
    expect(fakeSocket2.sendMedia).toHaveBeenLastCalledWith(chunkC);

    // Events fired on the abandoned old socket after replacement (e.g. its
    // own underlying auto-reconnect delivering a late message) must be
    // ignored — our handlers were detached from it during teardown.
    fakeSocket1.emit("message", resultsMsg({ transcript: "late", is_final: true, speech_final: true }));
    fakeSocket1.emit("close");
    expect(onFinal).not.toHaveBeenCalled();
    expect(onInterim).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledTimes(2); // no extra reconnect triggered by the stale socket

    handle.close();
  });

  it("6. calls onError with STT_RECONNECT_FAILED after 3 failed reconnect attempts", async () => {
    const fakeSocket1 = createFakeSocket();
    mockConnect
      .mockResolvedValueOnce(fakeSocket1) // initial connect
      .mockRejectedValueOnce(new Error("boom1"))
      .mockRejectedValueOnce(new Error("boom2"))
      .mockRejectedValueOnce(new Error("boom3"));
    const onError = vi.fn();

    const handle = await createSttStream({ callSid: "CA6", onError });

    fakeSocket1.emit("close");

    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 3000, interval: 20 });

    expect(mockConnect).toHaveBeenCalledTimes(4); // 1 initial + 3 reconnect attempts
    const err = onError.mock.calls[0][0];
    expect(err.code).toBe("STT_RECONNECT_FAILED");
    expect(handle.isAlive()).toBe(false);

    handle.close();
  });

  it("7. close() marks intentional close and does not trigger a reconnect", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({ callSid: "CA7" });
    handle.close();

    expect(fakeSocket.close).toHaveBeenCalledTimes(1);

    // Give any (incorrect) reconnect logic a chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(mockConnect).toHaveBeenCalledTimes(1); // no reconnect attempt
    expect(handle.isAlive()).toBe(false);
  });

  it("8. caps the reconnect audio buffer at 16,000 bytes, dropping oldest first", async () => {
    const fakeSocket1 = createFakeSocket();
    const fakeSocket2 = createFakeSocket();
    mockConnect.mockResolvedValueOnce(fakeSocket1).mockResolvedValueOnce(fakeSocket2);
    const onReconnect = vi.fn();

    const handle = await createSttStream({ callSid: "CA8", onReconnect });

    fakeSocket1.emit("close");

    // Buffer well past the 16,000-byte cap with distinguishable chunks.
    const chunkSize = 4000;
    const first = Buffer.alloc(chunkSize, 1); // should be dropped (oldest)
    const second = Buffer.alloc(chunkSize, 2);
    const third = Buffer.alloc(chunkSize, 3);
    const fourth = Buffer.alloc(chunkSize, 4);
    const fifth = Buffer.alloc(chunkSize, 5); // total 20,000 bytes -> first dropped

    handle.sendAudio(first);
    handle.sendAudio(second);
    handle.sendAudio(third);
    handle.sendAudio(fourth);
    handle.sendAudio(fifth);

    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    const flushed = fakeSocket2.sendMedia.mock.calls.map((c) => c[0]);
    expect(flushed).toEqual([second, third, fourth, fifth]);
    expect(flushed).not.toContainEqual(first);

    handle.close();
  });
});

// ---------------------------------------------------------------------------
// The instant the caller stopped talking is NOT the instant we get the final:
// Deepgram waits out its endpointing window, then the result crosses the
// network. That gap is pure caller-perceived latency and is invisible to this
// process unless it is reconstructed from Deepgram's own audio-relative word
// timings against how much audio we had streamed by then.
// ---------------------------------------------------------------------------
describe("sttStream.js — reconstructed speech-end timestamp", () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = "test-key";
    mockConnect.mockReset();
  });

  /** mu-law @ 8kHz is 1 byte per sample, so 8 bytes == 1ms of audio. */
  function audioMs(ms) {
    return Buffer.alloc(ms * 8, 0xff);
  }

  function finalWithWordEnd(transcript, endSec) {
    return {
      type: "Results",
      is_final: true,
      speech_final: true,
      channel: {
        alternatives: [{ transcript, confidence: 0.9, words: [{ word: "x", start: 0, end: endSec }] }],
      },
    };
  }

  it("back-dates speech end by the gap between streamed audio and the last word", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    let clock = 10_000;

    const handle = await createSttStream({ callSid: "CA-lag", now: () => clock });
    handle.sendAudio(audioMs(500)); // 500ms of audio streamed
    clock = 10_500;
    fakeSocket.emit("message", finalWithWordEnd("hello", 0.2)); // last word ended at 200ms

    // 500ms streamed - 200ms of speech = 300ms of endpointing + network.
    expect(handle.getLastSpeechEndAt()).toBe(10_200);

    handle.close();
  });

  it("falls back to result start+duration when word timings are absent", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    let clock = 5_000;

    const handle = await createSttStream({ callSid: "CA-nowords", now: () => clock });
    handle.sendAudio(audioMs(800));
    clock = 5_800;
    fakeSocket.emit("message", {
      type: "Results",
      is_final: true,
      speech_final: true,
      start: 0.1,
      duration: 0.4, // speech ended at 500ms
      channel: { alternatives: [{ transcript: "hi", confidence: 0.9 }] },
    });

    expect(handle.getLastSpeechEndAt()).toBe(5_500); // 800 - 500 = 300ms tail

    handle.close();
  });

  it("returns null before any final has arrived", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);

    const handle = await createSttStream({ callSid: "CA-nofinal" });
    handle.sendAudio(audioMs(200));

    expect(handle.getLastSpeechEndAt()).toBeNull();

    handle.close();
  });

  it("counts only audio Deepgram actually received, not audio the socket rejected", async () => {
    const fakeSocket = createFakeSocket();
    mockConnect.mockResolvedValue(fakeSocket);
    let clock = 1_000;

    const handle = await createSttStream({ callSid: "CA-drop", now: () => clock });
    handle.sendAudio(audioMs(100)); // delivered

    // A rejected send is re-buffered, not received. Counting it would advance
    // our clock past Deepgram's and back-date every later speech-end by the
    // difference, permanently, for the rest of the call.
    fakeSocket.sendMedia.mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    handle.sendAudio(audioMs(900));

    clock = 1_100;
    fakeSocket.emit("message", finalWithWordEnd("hi", 0.05));

    expect(handle.getLastSpeechEndAt()).toBe(1_050); // 100ms received - 50ms speech

    handle.close();
  });

  it("realigns the audio clock after a reconnect restarts Deepgram's stream time", async () => {
    const fakeSocket1 = createFakeSocket();
    const fakeSocket2 = createFakeSocket();
    mockConnect.mockResolvedValueOnce(fakeSocket1).mockResolvedValueOnce(fakeSocket2);
    const onReconnect = vi.fn();
    let clock = 20_000;

    const handle = await createSttStream({ callSid: "CA-realign", onReconnect, now: () => clock });
    handle.sendAudio(audioMs(1_000)); // 1s on the first socket
    fakeSocket1.emit("close");

    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    // New socket, new Deepgram stream clock starting at 0.
    handle.sendAudio(audioMs(400));
    clock = 21_400;
    fakeSocket2.emit("message", finalWithWordEnd("again", 0.3));

    // 400ms streamed on THIS socket - 300ms speech = 100ms tail. If the byte
    // counter had not been reset it would read 1400 - 300 and back-date the
    // speech end by 1.1 seconds.
    expect(handle.getLastSpeechEndAt()).toBe(21_300);

    handle.close();
  });
});
