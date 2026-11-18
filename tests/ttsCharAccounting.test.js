import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// TTS character accounting — the billing unit, not the audible one.
//
// ElevenLabs and Google Cloud TTS both charge per character SENT, not per
// character heard. scripts/call-report.js prices a call from these numbers, so
// the property under test is not "the count is plausible" but "the count is
// what the vendor invoices".
//
// The two cases that make it wrong if missed:
//
//   1. A BARGED-IN TURN. abort() does not go through finishDone(), so a report
//      emitted only from the completion path would silently omit every
//      interrupted turn — and those are the turns where sent and heard differ
//      most. Under-reporting there is worse than not reporting at all, because
//      the number still looks like an answer.
//
//   2. A SUPPRESSED FALLBACK CHUNK. The Google fallback checks isSuppressed()
//      AFTER synthesizing, so a barge can discard audio that was already
//      requested and already charged for. Counting after that check would
//      quietly refund something the vendor does not.
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
      this.close();
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
import { log } from "../lib/logger.js";

/** Every tts_turn_chars payload emitted so far. */
function charReports() {
  return log.info.mock.calls.filter(([event]) => event === "tts_turn_chars").map(([, p]) => p);
}

function newTurn(overrides = {}) {
  return createTtsTurn({
    voiceId: "v1",
    callSid: "CAchars",
    epoch: 1,
    getEpoch: () => 1,
    onAudioChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  });
}

describe("ttsStream.js — character accounting is the billing unit", () => {
  beforeEach(() => {
    instances.length = 0;
    mockSynthesizeMulaw.mockReset();
    log.info.mockClear();
    log.error.mockClear();
    process.env.ELEVENLABS_API_KEY = "test-xi-key";
    delete process.env.ELEVENLABS_MODEL;
    ttsHealth.recordSuccess();
  });

  it("counts exactly the characters handed to ElevenLabs, and reports them once on completion", () => {
    const turn = newTurn();
    const sock = instances[0];
    sock._open();

    turn.write("Hello there.");
    turn.write(" Booking you in.");
    turn.end();

    // The turn is not finished until ElevenLabs says so.
    expect(charReports()).toHaveLength(0);

    sock._message({ isFinal: true });

    expect(charReports()).toEqual([
      { callSid: "CAchars", el_chars: "Hello there.".length + " Booking you in.".length, google_chars: 0 },
    ]);
  });

  it("REPORTS A BARGED-IN TURN, which never reaches the completion path", () => {
    const turn = newTurn();
    instances[0]._open();

    turn.write("The first thing I was going to say");
    // The caller cuts in. The audio stops; the invoice does not.
    turn.abort();

    expect(charReports()).toEqual([
      { callSid: "CAchars", el_chars: "The first thing I was going to say".length, google_chars: 0 },
    ]);
  });

  it("reports once, not twice, when a barge races completion", () => {
    const turn = newTurn();
    const sock = instances[0];
    sock._open();

    turn.write("Some words");
    turn.abort();
    // A late isFinal from the vendor must not double-count the same turn.
    sock._message({ isFinal: true });

    expect(charReports()).toHaveLength(1);
  });

  it("stays silent for a turn that sent nothing, so an empty turn is not a zero row", () => {
    const turn = newTurn();
    instances[0]._open();
    turn.abort();

    expect(charReports()).toHaveLength(0);
  });

  it("counts a fallback chunk that was synthesized and then discarded, because the request was billed", async () => {
    // The barge has to land DURING synthesis, not before it. Suppressed before
    // the loop, runFallback breaks without calling Google at all and nothing is
    // charged — correct, and not the case under test. The case that matters is
    // the request completing into a turn that has since gone stale: the audio
    // is dropped on the isSuppressed() check after the await, and Google bills
    // for it regardless.
    let epoch = 1;
    mockSynthesizeMulaw.mockImplementation(async () => {
      epoch = 2;
      return Buffer.from([0x01, 0x02]);
    });

    const turn = newTurn({ getEpoch: () => epoch, forceFallback: true });

    turn.write("Sorry, the line dropped.");
    turn.end();
    await vi.waitFor(() => expect(charReports()).toHaveLength(1));

    // Proves the discard actually happened — otherwise this would be asserting
    // the ordinary path and passing for the wrong reason.
    expect(mockSynthesizeMulaw).toHaveBeenCalled();
    const [report] = charReports();
    expect(report.el_chars).toBe(0);
    expect(report.google_chars).toBeGreaterThan(0);
  });

  it("keeps the two vendors separate — they are billed at different rates", async () => {
    mockSynthesizeMulaw.mockResolvedValue(Buffer.from([0x01]));
    const turn = newTurn({ forceFallback: true });

    turn.write("Fallback only.");
    turn.end();
    await vi.waitFor(() => expect(charReports()).toHaveLength(1));

    const [report] = charReports();
    expect(report).toHaveProperty("el_chars");
    expect(report).toHaveProperty("google_chars");
    expect(report.el_chars).toBe(0);
  });
});
