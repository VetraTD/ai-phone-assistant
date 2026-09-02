import { describe, it, expect } from "vitest";
import { decodeMulaw } from "../lib/voice/mulaw.js";
import { createDownsampler, mulaw8kToPcm16k, createFramer } from "../lib/voice/resample.js";

// ---------------------------------------------------------------------------
// The spike's one non-throwaway module. Gemini Live emits 24 kHz PCM16 and
// Twilio takes 8 kHz mu-law, and a naive 3:1 decimation folds everything
// between 4 and 12 kHz straight back into the voice band. That would make the
// spike call sound bad for a reason that is OUR bug rather than the vendor's,
// which is the one way the spike can produce a wrong verdict — so the anti-
// alias filter is asserted, not assumed.
//
// The alias test is the load-bearing one: 6 kHz decimated by 3 without a
// filter reappears at |6000 - 8000| = 2000 Hz at nearly full amplitude, so a
// missing filter is not a subtle degradation, it is a loud tone that was never
// in the input.
// ---------------------------------------------------------------------------

const SR_IN = 24000;

/** PCM16 LE buffer holding a sine at `hz`, `seconds` long, sampled at 24 kHz. */
function tone(hz, seconds, amplitude = 10000, sampleRate = SR_IN) {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Skip the filter's group delay and any tail, so we measure steady state. */
function middle(samples, skip = 400) {
  return samples.subarray(skip, Math.max(skip, samples.length - skip));
}

const dB = (a, b) => 20 * Math.log10(a / Math.max(b, 1e-9));

/** Goertzel magnitude of one frequency bin — enough to ask "is this tone here". */
function goertzel(samples, hz, sampleRate = 8000) {
  const k = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (samples.length / 2);
}

function pcm16leToInt16(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

describe("createDownsampler — 24 kHz PCM16 to 8 kHz mu-law", () => {
  it("passes a 1 kHz tone with under 1 dB of loss", () => {
    const input = tone(1000, 1.0);
    const out = decodeMulaw(createDownsampler().process(input));

    const inRms = rms(middle(pcm16leToInt16(input), 1200));
    const outRms = rms(middle(out));

    expect(out.length).toBeGreaterThan(7000); // ~8000 samples for 1 s at 8 kHz
    expect(Math.abs(dB(outRms, inRms))).toBeLessThan(1);
  });

  it("keeps the period of a 1 kHz tone — 8 samples per cycle at 8 kHz", () => {
    const out = middle(decodeMulaw(createDownsampler().process(tone(1000, 0.5))));

    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1] < 0 && out[i] >= 0) crossings++;
    }
    // 1 kHz over out.length samples at 8 kHz: one rising crossing per cycle.
    const cycles = (out.length / 8000) * 1000;
    expect(crossings).toBeGreaterThan(cycles * 0.95);
    expect(crossings).toBeLessThan(cycles * 1.05);
  });

  it("attenuates a 6 kHz tone by more than 30 dB instead of aliasing it to 2 kHz", () => {
    const input = tone(6000, 1.0);
    const out = decodeMulaw(createDownsampler().process(input));

    const inRms = rms(middle(pcm16leToInt16(input), 1200));
    const outRms = rms(middle(out));

    // Without a filter the fold-down is nearly lossless, so this ratio is ~0 dB.
    expect(dB(inRms, outRms)).toBeGreaterThan(30);
  });

  it("leaves no 2 kHz component behind when fed 6 kHz", () => {
    const aliased = middle(decodeMulaw(createDownsampler().process(tone(6000, 1.0))));
    const real2k = middle(decodeMulaw(createDownsampler().process(tone(2000, 1.0))));

    // A real 2 kHz tone is inside the passband, so it is the honest reference
    // for "what 2 kHz of this amplitude looks like".
    expect(goertzel(aliased, 2000)).toBeLessThan(goertzel(real2k, 2000) * 0.03);
  });

  it("produces byte-identical output whether fed whole or in uneven chunks", () => {
    const input = tone(1000, 0.4);
    const whole = createDownsampler().process(input);

    const chunked = createDownsampler();
    const parts = [];
    // Deliberately not multiples of 6 bytes, so both the filter history and the
    // decimation phase have to survive a chunk boundary mid-output-sample.
    for (const [start, end] of [[0, 1001], [1001, 5003], [5003, 5004], [5004, input.length]]) {
      parts.push(chunked.process(input.subarray(start, end)));
    }

    expect(Buffer.concat(parts).equals(whole)).toBe(true);
  });

  it("returns an empty buffer for an empty chunk without disturbing phase", () => {
    const input = tone(1000, 0.2);
    const a = createDownsampler();
    const withEmpty = Buffer.concat([
      a.process(input.subarray(0, 1200)),
      a.process(Buffer.alloc(0)),
      a.process(input.subarray(1200)),
    ]);
    expect(withEmpty.equals(createDownsampler().process(input))).toBe(true);
  });
});

describe("mulaw8kToPcm16k", () => {
  it("doubles the sample count and widens each sample to 16 bits", () => {
    const out = mulaw8kToPcm16k(Buffer.alloc(160, 0xff));
    expect(out.length).toBe(160 * 2 * 2);
  });

  it("decodes mu-law silence to PCM near zero, not to full scale", () => {
    // 0x00 decodes to near full-scale NEGATIVE; 0xff is the silence byte. A
    // sign error here is inaudible in a test that only checks lengths and
    // deafening on a phone call.
    const samples = pcm16leToInt16(mulaw8kToPcm16k(Buffer.alloc(160, 0xff)));
    expect(Math.max(...samples.map(Math.abs))).toBeLessThan(16);
  });

  it("holds a constant input constant across the interpolation", () => {
    const constant = Buffer.alloc(64, 0x30);
    const samples = pcm16leToInt16(mulaw8kToPcm16k(constant));
    const expected = decodeMulaw(Buffer.from([0x30]))[0];
    for (const s of samples) expect(s).toBe(expected);
  });
});

describe("createFramer", () => {
  it("emits only whole 160-byte frames and carries the remainder", () => {
    const framer = createFramer(160);

    const first = framer.push(Buffer.alloc(250, 1));
    expect(first).toHaveLength(1);
    expect(first[0].length).toBe(160);
    expect(framer.pending()).toBe(90);

    const second = framer.push(Buffer.alloc(100, 2));
    expect(second).toHaveLength(1);
    expect(framer.pending()).toBe(30);
  });

  it("splits the carry at the right byte — the frame is not re-aligned", () => {
    const framer = createFramer(4);
    framer.push(Buffer.from([1, 2, 3, 4, 5, 6]));
    const [frame] = framer.push(Buffer.from([7, 8]));
    expect([...frame]).toEqual([5, 6, 7, 8]);
  });

  it("emits nothing until a whole frame exists", () => {
    const framer = createFramer(160);
    expect(framer.push(Buffer.alloc(159))).toEqual([]);
    expect(framer.push(Buffer.alloc(1))).toHaveLength(1);
  });
});
