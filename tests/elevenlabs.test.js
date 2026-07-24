import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake `ws` WebSocket — controllable from tests (open/message/close/error).
// Mirrors the pattern in tests/ttsStream.test.js.
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
    on(event, cb) { (this.listeners[event] ||= []).push(cb); return this; }
    send(data) { this.sentRaw.push(data); }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this._emit("close");
    }
    terminate() { this.close(); }
    _emit(event, ...args) { (this.listeners[event] || []).slice().forEach((cb) => cb(...args)); }
    _open() { this.readyState = FakeWebSocket.OPEN; this._emit("open"); }
    _message(obj) { this._emit("message", Buffer.from(JSON.stringify(obj))); }
    sentMessages() { return this.sentRaw.map((s) => JSON.parse(s)); }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  return { instances, FakeWebSocket };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("../lib/logger.js", () => ({ log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { synthesizeMulawOnce } from "../services/elevenlabs.js";

function b64(buf) { return Buffer.from(buf).toString("base64"); }

describe("services/elevenlabs.js synthesizeMulawOnce — one-shot micro-utterance warm synthesis", () => {
  beforeEach(() => {
    instances.length = 0;
    process.env.ELEVENLABS_API_KEY = "test-xi-key";
  });

  it("resolves the concatenated mulaw buffer once isFinal arrives, in the requested voice", async () => {
    const p = synthesizeMulawOnce({ voiceId: "voiceA", text: "I'm still here whenever you're ready.", voiceSettings: { stability: 0.7 } });

    const sock = instances[0];
    expect(sock.url).toContain("/text-to-speech/voiceA/stream-input");
    sock._open();

    // Handshake carries the voice settings; the phrase text is sent after.
    const handshake = sock.sentMessages()[0];
    expect(handshake.voice_settings).toMatchObject({ stability: 0.7 });
    expect(sock.sentMessages().some((m) => m.text && m.text.startsWith("I'm still here"))).toBe(true);

    sock._message({ audio: b64(Buffer.from([1, 2])) });
    sock._message({ audio: b64(Buffer.from([3, 4])) });
    sock._message({ isFinal: true });

    await expect(p).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects if the socket errors before finishing", async () => {
    const p = synthesizeMulawOnce({ voiceId: "voiceA", text: "One moment." });
    const sock = instances[0];
    sock._open();
    sock._emit("error", new Error("socket died"));
    await expect(p).rejects.toThrow("socket died");
  });

  it("resolves an empty buffer for empty text without opening a connection", async () => {
    const buf = await synthesizeMulawOnce({ voiceId: "voiceA", text: "" });
    expect(buf).toEqual(Buffer.alloc(0));
    expect(instances).toHaveLength(0);
  });
});
