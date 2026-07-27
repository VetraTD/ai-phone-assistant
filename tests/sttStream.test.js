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
      endpointing: 300,
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
    expect(onFinal).toHaveBeenCalledWith("hello world");

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
    expect(onFinal).toHaveBeenCalledWith("Stop");
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
