import { describe, it, expect, beforeEach } from "vitest";
import { createVad } from "../lib/voice/inboundVad.js";

// ---------------------------------------------------------------------------
// Independent reference implementation of the standard ITU-T/CCITT G.711
// mu-law expansion (the same public-domain algorithm used by SoX, FFmpeg's
// g711.c, Sun's reference implementation, etc.) — used here to spot-check
// the module's own decode table against the spec math, rather than trusting
// the module to grade its own homework.
// ---------------------------------------------------------------------------
const BIAS = 0x84;
function referenceMulawDecode(byte) {
  let u_val = ~byte & 0xff;
  let t = ((u_val & 0x0f) << 3) + BIAS;
  t <<= (u_val & 0x70) >> 4;
  return u_val & 0x80 ? BIAS - t : t - BIAS;
}

/** Encode a linear PCM16 sample to a mu-law byte (standard G.711 compression). */
function referenceMulawEncode(sample) {
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find the highest set bit segment
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

describe("inboundVad.js — mu-law decode table", () => {
  it("matches the independently computed G.711 spec math for representative bytes", () => {
    const vad = createVad();
    for (const byte of [0x00, 0x01, 0x0f, 0x7e, 0x7f, 0x80, 0x81, 0xfe, 0xff, 0x55, 0xaa]) {
      const samples = vad._decodeMulaw(Buffer.from([byte]));
      expect(samples[0]).toBe(referenceMulawDecode(byte));
    }
  });

  it("decodes 0xFF (mu-law silence byte) to 0", () => {
    const vad = createVad();
    expect(vad._decodeMulaw(Buffer.from([0xff]))[0]).toBe(0);
  });

  it("decodes the full-scale negative byte 0x00 to the largest-magnitude negative sample", () => {
    const vad = createVad();
    const samples = vad._decodeMulaw(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    const min = Math.min(...samples);
    expect(samples[0]).toBe(min);
    expect(samples[0]).toBeLessThan(-30000);
  });

  it("decodes an entire buffer to one sample per byte", () => {
    const vad = createVad();
    const buf = Buffer.from([0xff, 0x00, 0x80, 0x7f]);
    const samples = vad._decodeMulaw(buf);
    expect(samples.length).toBe(4);
  });
});

describe("inboundVad.js — createVad", () => {
  let vad;

  beforeEach(() => {
    vad = createVad();
  });

  /** Build a 160-byte (20ms) mu-law frame where every sample decodes to ~amplitude. */
  function loudFrame(amplitude, length = 160) {
    // Search the module's own decode table for the mu-law byte whose decoded
    // magnitude is closest to the requested amplitude — avoids relying on a
    // second, possibly-inconsistent encoder for amplitude control.
    let bestByte = 0xff;
    let bestDiff = Infinity;
    for (let b = 0; b < 256; b++) {
      const decoded = vad._decodeMulaw(Buffer.from([b]))[0];
      const diff = Math.abs(Math.abs(decoded) - amplitude);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestByte = b;
      }
    }
    return Buffer.alloc(length, bestByte);
  }

  function silenceFrame(length = 160) {
    return Buffer.alloc(length, 0xff);
  }

  it("never throws, even with a garbage/empty buffer", () => {
    expect(() => vad.processFrame(Buffer.alloc(0), 0)).not.toThrow();
    expect(() => vad.processFrame(null, 0)).not.toThrow();
    expect(() => vad.processFrame(undefined, 0)).not.toThrow();
  });

  it("classifies a silence frame (all 0xFF bytes) as not voiced", () => {
    const result = vad.processFrame(silenceFrame(), 0);
    expect(result.voiced).toBe(false);
    expect(result.rms).toBe(0);
    expect(result.voiceActive).toBe(false);
  });

  it("classifies a loud synthetic frame (amplitude ~8000) as voiced", () => {
    const result = vad.processFrame(loudFrame(8000), 0);
    expect(result.voiced).toBe(true);
  });

  it("round-trips a real sine-derived signal through a local encoder as an integration sanity check", () => {
    const samples = new Int16Array(160);
    for (let i = 0; i < 160; i++) {
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 10 * i) / 160));
    }
    const buf = Buffer.from(samples.map((s) => referenceMulawEncode(s)));
    const result = vad.processFrame(buf, 0);
    expect(result.voiced).toBe(true);
  });

  describe("activeMs gating", () => {
    it("does not become active for continuous voiced frames spanning less than activeMs", () => {
      // activeMs default 200ms — feed voiced frames spanning only 150ms.
      let result;
      for (const atMs of [0, 50, 100, 150]) {
        result = vad.processFrame(loudFrame(8000), atMs);
      }
      expect(result.voiced).toBe(true);
      expect(result.voiceActive).toBe(false);
      expect(vad.isActive(150)).toBe(false);
    });

    it("becomes active once continuous voiced frames span >= activeMs", () => {
      let result;
      for (const atMs of [0, 50, 100, 150, 200]) {
        result = vad.processFrame(loudFrame(8000), atMs);
      }
      expect(result.voiceActive).toBe(true);
      expect(vad.isActive(200)).toBe(true);
    });

    it("resets the continuous streak when a frame is unvoiced before reaching activeMs", () => {
      vad.processFrame(loudFrame(8000), 0);
      vad.processFrame(loudFrame(8000), 100);
      vad.processFrame(silenceFrame(), 150); // breaks the streak
      const result = vad.processFrame(loudFrame(8000), 200);
      // A fresh streak started at 200ms, nowhere near activeMs yet.
      expect(result.voiceActive).toBe(false);
    });
  });

  describe("hangoverMs", () => {
    it("stays active through hangoverMs of unvoiced frames after the last voiced frame", () => {
      // Reach active state first (default activeMs=200, hangoverMs=300).
      for (const atMs of [0, 50, 100, 150, 200]) {
        vad.processFrame(loudFrame(8000), atMs);
      }
      expect(vad.isActive(200)).toBe(true);

      // Unvoiced frames within the 300ms hangover window keep it active.
      const r1 = vad.processFrame(silenceFrame(), 300);
      expect(r1.voiceActive).toBe(true);
      expect(vad.isActive(450)).toBe(true);
    });

    it("becomes inactive once hangoverMs of unvoiced time has elapsed since the last voiced frame", () => {
      for (const atMs of [0, 50, 100, 150, 200]) {
        vad.processFrame(loudFrame(8000), atMs);
      }
      // Last voiced frame at 200ms; hangoverMs default 300ms -> inactive by 501ms.
      const r = vad.processFrame(silenceFrame(), 501);
      expect(r.voiceActive).toBe(false);
      expect(vad.isActive(501)).toBe(false);
    });

    it("isActive() reflects hangover expiry even without a new processFrame call", () => {
      for (const atMs of [0, 50, 100, 150, 200]) {
        vad.processFrame(loudFrame(8000), atMs);
      }
      expect(vad.isActive(200)).toBe(true);
      expect(vad.isActive(600)).toBe(false); // 400ms since last voiced frame > hangoverMs
    });

    it("requires a fresh activeMs streak to reactivate after hangover has expired (no stale latch)", () => {
      for (const atMs of [0, 50, 100, 150, 200]) {
        vad.processFrame(loudFrame(8000), atMs);
      }
      // Silence long enough for hangover to expire.
      vad.processFrame(silenceFrame(), 600);
      expect(vad.isActive(600)).toBe(false);

      // A single new voiced frame right after must NOT instantly reactivate.
      const r = vad.processFrame(loudFrame(8000), 650);
      expect(r.voiceActive).toBe(false);

      // Only after a fresh activeMs (200ms) of continuous voiced frames does
      // it become active again.
      let result;
      for (const atMs of [650, 700, 750, 800, 850]) {
        result = vad.processFrame(loudFrame(8000), atMs);
      }
      expect(result.voiceActive).toBe(true);
    });
  });

  describe("adaptive noise floor", () => {
    it("rises with sustained moderate noise, raising the voiced threshold", () => {
      // Custom instance with a lower minRms so the adaptive floor (not the
      // minRms floor) governs the threshold once it rises.
      const v = createVad({ minRms: 100 });
      const noiseFrame = loudFrameFor(v, 300);

      let atMs = 0;
      for (let i = 0; i < 2000; i++) {
        v.processFrame(noiseFrame, atMs);
        atMs += 20;
      }

      // A frame at amplitude 250 would have been voiced against the initial
      // floor (200*3=600 -> no; actually let's use amplitude comfortably
      // between old and new thresholds).
      const probe = loudFrameFor(v, 850);
      const probeResult = v.processFrame(probe, atMs);
      // Against the *initial* floor (200), threshold would be
      // max(200*3, 100) = 600, so 850 would have been voiced immediately.
      // After sustained ~300 rms noise, the EMA floor approaches 300, so the
      // threshold approaches max(300*3, 100) = 900, making 850 NOT voiced.
      expect(probeResult.voiced).toBe(false);
    });

    it("does not update the floor on voiced frames", () => {
      const v = createVad({ minRms: 100 });
      const loud = loudFrameFor(v, 8000);
      let atMs = 0;
      for (let i = 0; i < 50; i++) {
        v.processFrame(loud, atMs);
        atMs += 20;
      }
      // Floor should still be near its initial value (200), so a moderate
      // frame well below 8000 but above the initial threshold is voiced.
      const probe = loudFrameFor(v, 700);
      const result = v.processFrame(probe, atMs);
      expect(result.voiced).toBe(true);
    });
  });

  describe("reset()", () => {
    it("clears activation state and the adaptive floor back to initial conditions", () => {
      for (const atMs of [0, 50, 100, 150, 200]) {
        vad.processFrame(loudFrame(8000), atMs);
      }
      expect(vad.isActive(200)).toBe(true);

      vad.reset();
      expect(vad.isActive(200)).toBe(false);

      // Needs a fresh activeMs streak after reset.
      let result;
      for (const atMs of [1000, 1050, 1100, 1150]) {
        result = vad.processFrame(loudFrame(8000), atMs);
      }
      expect(result.voiceActive).toBe(false);
    });
  });
});

/** Same helper as loudFrame() above but bound to an arbitrary vad instance. */
function loudFrameFor(vadInstance, amplitude, length = 160) {
  let bestByte = 0xff;
  let bestDiff = Infinity;
  for (let b = 0; b < 256; b++) {
    const decoded = vadInstance._decodeMulaw(Buffer.from([b]))[0];
    const diff = Math.abs(Math.abs(decoded) - amplitude);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestByte = b;
    }
  }
  return Buffer.alloc(length, bestByte);
}
