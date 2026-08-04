import { describe, it, expect } from "vitest";
import { downsampleToMulaw, lowPassResample } from "../lib/audio/resample.js";
import { decodeMulaw } from "../lib/voice/mulaw.js";

// ---------------------------------------------------------------------------
// Two of the four TTS candidates cannot emit 8kHz mu-law natively, so their
// audio has to be converted before the blind comparison. How that conversion
// is done decides the outcome of the test.
//
// Dropping samples to get from 24kHz to 8kHz folds everything above 4kHz back
// into the speech band as broadband grit. Sibilance — the loudest thing above
// 4kHz in speech — becomes the worst offender. The result would be a listening
// test that reliably prefers whichever vendors happened to support mu-law
// natively, for reasons that have nothing to do with their voices.
//
// So the anti-aliasing here is not polish. It is the difference between a fair
// test and a rigged one, and it is worth asserting rather than assuming.
// ---------------------------------------------------------------------------

/** A pure tone as PCM16. */
function tone(freqHz, rate, ms, amplitude = 12000) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / rate));
  }
  return out;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Ignore filter start-up transient at both ends. */
function middle(samples, dropFraction = 0.25) {
  const drop = Math.floor(samples.length * dropFraction);
  return samples.slice(drop, samples.length - drop);
}

describe("lowPassResample — band-limited conversion to 8kHz", () => {
  it("passes speech-band content through largely intact", () => {
    const input = tone(500, 24000, 200);
    const out = lowPassResample(input, 24000, 8000);

    // A 500Hz tone is deep inside the telephony band; it must survive.
    expect(rms(middle(out))).toBeGreaterThan(rms(input) * 0.6);
  });

  it("rejects content above the telephony band instead of aliasing it down", () => {
    // 6kHz at 24kHz input. Naive decimation by 3 folds this to |6000-8000| =
    // 2kHz — a loud, entirely fabricated tone in the middle of the voice band.
    const input = tone(6000, 24000, 200);
    const out = lowPassResample(input, 24000, 8000);

    expect(rms(middle(out))).toBeLessThan(rms(input) * 0.05);
  });

  it("rejects near-Nyquist content from a 48kHz source too", () => {
    const input = tone(12000, 48000, 200);
    const out = lowPassResample(input, 48000, 8000);

    expect(rms(middle(out))).toBeLessThan(rms(input) * 0.05);
  });

  it("produces the right number of samples for the target rate", () => {
    const out = lowPassResample(tone(400, 24000, 1000), 24000, 8000);
    expect(out.length).toBeCloseTo(8000, -2);
  });

  it("handles a non-integer rate ratio without falling over", () => {
    // 44100 -> 8000 is not an integer decimation; a decimate-only
    // implementation silently mangles the pitch here.
    const out = lowPassResample(tone(400, 44100, 500), 44100, 8000);

    expect(out.length).toBeCloseTo(4000, -2);
    expect(rms(middle(out))).toBeGreaterThan(1000);
  });

  it("passes audio through unchanged when it is already at the target rate", () => {
    const input = tone(400, 8000, 100);
    const out = lowPassResample(input, 8000, 8000);
    expect(out.length).toBe(input.length);
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(lowPassResample(new Int16Array(0), 24000, 8000).length).toBe(0);
  });
});

describe("downsampleToMulaw — the conversion the A/B harness actually calls", () => {
  it("emits one mu-law byte per 8kHz sample", () => {
    const out = downsampleToMulaw(tone(400, 24000, 1000), 24000);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeCloseTo(8000, -2); // 1 second at 8kHz, 1 byte/sample
  });

  it("survives the mu-law round trip with the tone still audible", () => {
    const out = downsampleToMulaw(tone(400, 24000, 200), 24000);
    const back = decodeMulaw(out);

    expect(rms(middle(back))).toBeGreaterThan(1000);
  });

  it("does not alias a 6kHz source tone into the voice band", () => {
    // The end-to-end version of the fairness check above: this is the exact
    // path Gemini and Inworld audio takes into the listening pack.
    const clean = decodeMulaw(downsampleToMulaw(tone(6000, 24000, 200), 24000));
    const speech = decodeMulaw(downsampleToMulaw(tone(500, 24000, 200), 24000));

    expect(rms(middle(clean))).toBeLessThan(rms(middle(speech)) * 0.1);
  });
});
