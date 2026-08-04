import { encodeMulaw } from "../voice/mulaw.js";

// ---------------------------------------------------------------------------
// Band-limited conversion of TTS output to telephony format.
//
// Two of the four A/B candidates (Gemini TTS, Inworld) return 24kHz or 48kHz
// linear PCM rather than 8kHz mu-law. Getting them to 8kHz by taking every
// Nth sample would fold everything above 4kHz back into the speech band as
// broadband grit — and sibilance, the loudest speech content above 4kHz, would
// be the worst affected. The blind test would then reliably prefer whichever
// vendors happened to support mu-law natively, for reasons having nothing to
// do with how their voices sound.
//
// So: low-pass first, then resample. The cutoff is 3400Hz, the top of the
// G.711 passband — the same ceiling the phone network imposes on the native
// candidates, which is what makes the comparison like-for-like.
// ---------------------------------------------------------------------------

/** Top of the telephony passband. Everything above this is discarded anyway. */
const CUTOFF_HZ = 3400;

/**
 * FIR length. 127 taps at 24kHz is ~5ms of latency and gives a transition band
 * narrow enough that nothing meaningful survives above 4kHz. Latency does not
 * matter here — this runs offline over complete utterances, not in a call.
 */
const NUM_TAPS = 127;

/**
 * Windowed-sinc low-pass kernel (Hamming window).
 *
 * Hamming rather than a rectangular window because an untapered sinc rings:
 * its stopband leakage is around -21dB, which would let audible alias energy
 * through and defeat the point of filtering at all.
 *
 * @param {number} cutoffHz
 * @param {number} sampleRate
 * @param {number} taps - forced odd so the kernel is symmetric about a sample
 * @returns {Float64Array}
 */
function buildLowPassKernel(cutoffHz, sampleRate, taps = NUM_TAPS) {
  const n = taps % 2 === 0 ? taps + 1 : taps;
  const kernel = new Float64Array(n);
  const fc = cutoffHz / sampleRate; // normalized cutoff (cycles/sample)
  const mid = (n - 1) / 2;
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }

  // Normalize to unity DC gain so filtering doesn't change loudness — a
  // quieter candidate would be judged as worse for the wrong reason.
  for (let i = 0; i < n; i++) kernel[i] /= sum;
  return kernel;
}

/**
 * Convolve, clamping index at the edges (equivalent to edge-padding).
 * @param {Int16Array} samples
 * @param {Float64Array} kernel
 * @returns {Float64Array}
 */
function convolve(samples, kernel) {
  const out = new Float64Array(samples.length);
  const mid = (kernel.length - 1) / 2;
  const last = samples.length - 1;

  for (let i = 0; i < samples.length; i++) {
    let acc = 0;
    for (let k = 0; k < kernel.length; k++) {
      let idx = i + k - mid;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      acc += samples[idx] * kernel[k];
    }
    out[i] = acc;
  }
  return out;
}

function clampToInt16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return Math.round(v);
}

/**
 * Low-pass filter and resample PCM16 to a target rate.
 *
 * Linear interpolation for the rate change is sufficient BECAUSE the signal is
 * already band-limited to 3.4kHz by the time it gets there — interpolation
 * error lives above the surviving content. Handles non-integer ratios (44.1kHz
 * sources) for the same reason.
 *
 * @param {Int16Array} samples
 * @param {number} inputRate
 * @param {number} [targetRate=8000]
 * @returns {Int16Array}
 */
export function lowPassResample(samples, inputRate, targetRate = 8000) {
  if (!samples || samples.length === 0) return new Int16Array(0);
  if (!inputRate || inputRate === targetRate) return Int16Array.from(samples);

  const filtered = convolve(samples, buildLowPassKernel(CUTOFF_HZ, inputRate));

  const ratio = inputRate / targetRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLength);
  const last = filtered.length - 1;

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    out[i] = clampToInt16(filtered[i0] * (1 - frac) + filtered[i1] * frac);
  }
  return out;
}

/**
 * Convert PCM16 at any rate into the 8kHz mu-law bytes a phone call carries.
 *
 * This is the single conversion point for every non-native A/B candidate, so
 * they all take an identical path and no vendor gets an accidental advantage.
 *
 * @param {Int16Array|Buffer} samples - PCM16 samples, or a little-endian PCM16 buffer
 * @param {number} inputRate
 * @returns {Buffer} 8kHz mu-law, one byte per sample
 */
export function downsampleToMulaw(samples, inputRate) {
  const pcm = Buffer.isBuffer(samples)
    ? new Int16Array(samples.buffer, samples.byteOffset, Math.floor(samples.length / 2))
    : samples;
  return encodeMulaw(lowPassResample(pcm, inputRate, 8000));
}
