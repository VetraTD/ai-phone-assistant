import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAudioOut } from "../lib/voice/audioOut.js";

const STREAM_SID = "MZtestsid123";

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advanceTo: (ms) => {
      t = ms;
    },
  };
}

describe("audioOut.js — createAudioOut", () => {
  let sendFrame;
  let clock;
  let audioOut;

  beforeEach(() => {
    sendFrame = vi.fn();
    clock = makeClock(0);
    audioOut = createAudioOut({ sendFrame, streamSid: STREAM_SID, now: clock.now });
  });

  describe("framing", () => {
    it("splits a 400-byte buffer into 3 frames, padding the last to 160 with 0xFF mu-law silence", () => {
      const buf = Buffer.alloc(400, 0x01);
      audioOut.enqueue(buf);

      const mediaCalls = sendFrame.mock.calls.filter(([msg]) => msg.event === "media");
      expect(mediaCalls.length).toBe(3);

      const decoded = mediaCalls.map(([msg]) => Buffer.from(msg.media.payload, "base64"));
      expect(decoded[0].length).toBe(160);
      expect(decoded[1].length).toBe(160);
      expect(decoded[2].length).toBe(160);

      // Last frame: 400 - 320 = 80 real bytes, then 80 bytes of 0xFF padding.
      expect(decoded[2].subarray(0, 80).every((b) => b === 0x01)).toBe(true);
      expect(decoded[2].subarray(80, 160).every((b) => b === 0xff)).toBe(true);

      for (const [msg] of mediaCalls) {
        expect(msg.event).toBe("media");
        expect(msg.streamSid).toBe(STREAM_SID);
      }
    });

    it("sends no mark event when markName is omitted", () => {
      audioOut.enqueue(Buffer.alloc(160, 0x01));
      const markCalls = sendFrame.mock.calls.filter(([msg]) => msg.event === "mark");
      expect(markCalls.length).toBe(0);
    });

    it("sends a mark event after the media frames when markName is given", () => {
      audioOut.enqueue(Buffer.alloc(160, 0x01), "turn-1");
      const calls = sendFrame.mock.calls;
      expect(calls[calls.length - 1][0]).toEqual({
        event: "mark",
        streamSid: STREAM_SID,
        mark: { name: "turn-1" },
      });
    });

    it("does not throw on an empty buffer", () => {
      expect(() => audioOut.enqueue(Buffer.alloc(0))).not.toThrow();
      expect(sendFrame.mock.calls.filter(([m]) => m.event === "media").length).toBe(0);
    });
  });

  describe("playback-window estimate", () => {
    it("advances playingUntil by bytes/8 ms on enqueue (1600 bytes -> +200ms)", () => {
      clock.advanceTo(1000);
      audioOut.enqueue(Buffer.alloc(1600, 0x01));
      expect(audioOut.aiAudioPlayingUntil()).toBe(1200);
    });

    it("counts the padded (wire) byte length, not the raw input length, for a non-160-multiple buffer", () => {
      clock.advanceTo(0);
      // 250 bytes -> 2 frames on the wire (160 + 160, the second padded
      // with 90 bytes of silence) = 320 wire bytes = 40ms, not 250/8=31.25ms.
      audioOut.enqueue(Buffer.alloc(250, 0x01));
      expect(audioOut.aiAudioPlayingUntil()).toBe(40);
    });

    it("stacks successive enqueues (does not reset on each call)", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(800, 0x01)); // +100ms -> playingUntil=100
      expect(audioOut.aiAudioPlayingUntil()).toBe(100);

      clock.advanceTo(10);
      audioOut.enqueue(Buffer.alloc(800, 0x01)); // max(100,10)+100=200
      expect(audioOut.aiAudioPlayingUntil()).toBe(200);
    });

    it("uses now() instead of the stale window when now() has passed playingUntil", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(160, 0x01)); // playingUntil = 20
      clock.advanceTo(5000); // long silence gap
      audioOut.enqueue(Buffer.alloc(160, 0x01)); // playingUntil = max(20,5000)+20=5020
      expect(audioOut.aiAudioPlayingUntil()).toBe(5020);
    });
  });

  describe("isPlaying()", () => {
    it("is true while within the estimated playback window", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(1600, 0x01)); // playingUntil = 200
      clock.advanceTo(100);
      expect(audioOut.isPlaying()).toBe(true);
    });

    it("respects the grace period after playingUntil", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(1600, 0x01)); // playingUntil = 200
      clock.advanceTo(300); // 100ms past playingUntil, within default 150ms grace
      expect(audioOut.isPlaying(150)).toBe(true);
      clock.advanceTo(351); // 151ms past playingUntil, beyond grace
      expect(audioOut.isPlaying(150)).toBe(false);
    });

    it("supports a custom grace period", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(160, 0x01)); // playingUntil = 20
      clock.advanceTo(25);
      expect(audioOut.isPlaying(0)).toBe(false);
      expect(audioOut.isPlaying(10)).toBe(true);
    });
  });

  describe("clear()", () => {
    it("sends a clear event", () => {
      audioOut.clear();
      expect(sendFrame).toHaveBeenCalledWith({ event: "clear", streamSid: STREAM_SID });
    });

    it("resets the playback window to now (audio stops immediately)", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(1600, 0x01)); // playingUntil = 200
      clock.advanceTo(50);
      audioOut.clear();
      expect(audioOut.aiAudioPlayingUntil()).toBe(50);
      expect(audioOut.isPlaying(0)).toBe(false);
    });
  });

  describe("mark bookkeeping", () => {
    it("tracks outstanding marks and removes them on notifyMarkPlayed", () => {
      audioOut.enqueue(Buffer.alloc(160, 0x01), "m1");
      expect(audioOut.hasOutstandingMarks()).toBe(true);
      audioOut.notifyMarkPlayed("m1");
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });

    it("sendMark() tracks a standalone mark not tied to an enqueue", () => {
      audioOut.sendMark("standalone");
      expect(sendFrame).toHaveBeenCalledWith({
        event: "mark",
        streamSid: STREAM_SID,
        mark: { name: "standalone" },
      });
      expect(audioOut.hasOutstandingMarks()).toBe(true);
      audioOut.notifyMarkPlayed("standalone");
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });

    it("does not throw when notifyMarkPlayed is called for an unknown mark", () => {
      expect(() => audioOut.notifyMarkPlayed("never-sent")).not.toThrow();
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });

    it("silently ignores marks echoed back by Twilio after clear()", () => {
      audioOut.enqueue(Buffer.alloc(160, 0x01), "pre-clear-mark");
      expect(audioOut.hasOutstandingMarks()).toBe(true);

      audioOut.clear();
      expect(audioOut.hasOutstandingMarks()).toBe(false);

      // Twilio echoes the queued-but-unplayed mark back after clear.
      expect(() => audioOut.notifyMarkPlayed("pre-clear-mark")).not.toThrow();
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });

    it("tracks multiple outstanding marks independently", () => {
      audioOut.enqueue(Buffer.alloc(160, 0x01), "a");
      audioOut.enqueue(Buffer.alloc(160, 0x01), "b");
      expect(audioOut.hasOutstandingMarks()).toBe(true);
      audioOut.notifyMarkPlayed("a");
      expect(audioOut.hasOutstandingMarks()).toBe(true);
      audioOut.notifyMarkPlayed("b");
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });
  });

  describe("reset()", () => {
    it("clears the playback window and outstanding marks", () => {
      clock.advanceTo(0);
      audioOut.enqueue(Buffer.alloc(1600, 0x01), "m1");
      expect(audioOut.aiAudioPlayingUntil()).toBe(200);
      expect(audioOut.hasOutstandingMarks()).toBe(true);

      audioOut.reset();
      expect(audioOut.aiAudioPlayingUntil()).toBe(0);
      expect(audioOut.hasOutstandingMarks()).toBe(false);
    });
  });

  describe("never throws", () => {
    it("swallows a sendFrame that throws", () => {
      const throwingSend = vi.fn(() => {
        throw new Error("ws closed");
      });
      const out = createAudioOut({ sendFrame: throwingSend, streamSid: STREAM_SID, now: clock.now });
      expect(() => out.enqueue(Buffer.alloc(160, 0x01), "m1")).not.toThrow();
      expect(() => out.clear()).not.toThrow();
      expect(() => out.sendMark("x")).not.toThrow();
    });

    it("handles a null/undefined buffer gracefully", () => {
      expect(() => audioOut.enqueue(null)).not.toThrow();
      expect(() => audioOut.enqueue(undefined)).not.toThrow();
    });
  });
});
