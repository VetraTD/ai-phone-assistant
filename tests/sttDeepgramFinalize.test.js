// ---------------------------------------------------------------------------
// Hammersleys round 4 (2026-11-26), item 6. The streaming Deepgram client had
// no way to end a stream without losing its last words: close() closed the
// socket at once, so speech Deepgram had heard but not yet finalised was
// dropped, and late Results could still reach onFinal after close(). The
// shadow transcript ends every call, so it needs finalize(): Finalize, then
// CloseStream, wait (bounded) for the server to finish, then detach.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const sockets = [];
const failNextOpen = { value: false };
vi.mock("@deepgram/sdk", () => {
  class FakeSocket {
    constructor() {
      this.handlers = {};
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    connect() {}
    async waitForOpen() {
      if (failNextOpen.value) {
        failNextOpen.value = false;
        throw new Error("open refused");
      }
    }
    on(event, cb) {
      this.handlers[event] = cb; // the SDK keeps one handler per event
    }
    emit(event, arg) {
      this.handlers[event]?.(arg);
    }
    sendMedia(buf) {
      this.sent.push({ media: buf.length });
    }
    sendKeepAlive(m) {
      this.sent.push(m);
    }
    sendFinalize(m) {
      this.sent.push(m);
    }
    sendCloseStream(m) {
      this.sent.push(m);
    }
    close() {
      this.closed = true;
    }
  }
  return {
    DeepgramClient: vi.fn(() => ({ listen: { v1: { connect: async () => new FakeSocket() } } })),
  };
});
vi.mock("../lib/logger.js", () => ({ log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { createDeepgramSttStream } from "../lib/voice/sttDeepgram.js";

const final = (text) => ({ type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: text, confidence: 0.9 }] } });

describe("sttDeepgram finalize() — end a stream without losing its last words", () => {
  beforeEach(() => {
    sockets.length = 0;
    process.env.DEEPGRAM_API_KEY = "test-key";
  });

  it("sends Finalize then CloseStream, keeps the words that arrive before the server closes, then detaches", async () => {
    const finals = [];
    const s = await createDeepgramSttStream({ callSid: "CA_f1", onFinal: (t) => finals.push(t) });
    const sock = sockets[0];
    const done = s.finalize({ timeoutMs: 1000 });
    expect(sock.sent.map((m) => m.type).filter(Boolean)).toEqual(expect.arrayContaining(["Finalize", "CloseStream"]));
    expect(sock.sent.findIndex((m) => m.type === "Finalize")).toBeLessThan(sock.sent.findIndex((m) => m.type === "CloseStream"));
    // Deepgram answers Finalize with the pending final (not speech_final), then closes.
    sock.emit("message", final("Plaistow Street"));
    sock.emit("close");
    await done;
    expect(finals).toEqual(["Plaistow Street"]);
    // Detached: a late message is inert, and the socket is closed.
    sock.emit("message", { ...final("late"), speech_final: true });
    expect(finals).toEqual(["Plaistow Street"]);
    expect(sock.closed).toBe(true);
    expect(s.isAlive()).toBe(false);
  });

  it("does not wait forever: a server that never closes is left after timeoutMs", async () => {
    const s = await createDeepgramSttStream({ callSid: "CA_f2", onFinal: () => {} });
    const t0 = Date.now();
    await s.finalize({ timeoutMs: 60 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sockets[0].closed).toBe(true);
  });

  it("a server close during finalize never triggers a reconnect", async () => {
    const s = await createDeepgramSttStream({ callSid: "CA_f3", onFinal: () => {} });
    const done = s.finalize({ timeoutMs: 1000 });
    sockets[0].emit("close");
    await done;
    await new Promise((r) => setTimeout(r, 400));
    expect(sockets.length).toBe(1);
  });

  // Opus review P1: the SDK socket is a ReconnectingWebSocket (30 retries by
  // default). A connect whose open fails must close it, or it keeps
  // handshaking with the API key for minutes with nobody holding it.
  it("review P1: a failed open closes the SDK socket and rejects", async () => {
    failNextOpen.value = true;
    await expect(createDeepgramSttStream({ callSid: "CA_p1", onFinal: () => {} })).rejects.toThrow("open refused");
    expect(sockets[0].closed).toBe(true);
  });

  it("finalize after close(), and twice, is a no-op", async () => {
    const s = await createDeepgramSttStream({ callSid: "CA_f4", onFinal: () => {} });
    s.close();
    await s.finalize({ timeoutMs: 50 });
    await s.finalize({ timeoutMs: 50 });
    expect(sockets[0].sent.some((m) => m.type === "Finalize")).toBe(false);
  });
});
