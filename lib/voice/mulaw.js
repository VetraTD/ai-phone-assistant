// ---------------------------------------------------------------------------
// G.711 mu-law <-> linear PCM16 codec.
//
// Standard ITU-T/CCITT mu-law companding (the same public-domain algorithm
// used by SoX, FFmpeg's g711.c, and Sun's reference implementation).
//
// Extracted into its own module because two unrelated parts of the pipeline
// need it: lib/voice/inboundVad.js decodes inbound caller audio to measure
// energy, and lib/voice/audioOut.js needs a full round trip (decode, scale,
// re-encode) to build the amplitude ramp that tapers outbound speech on a
// barge-in. Everything here is pure and allocation-light — audioOut calls it
// on the interrupt path, where latency is the whole point.
// ---------------------------------------------------------------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function decodeMulawByte(byte) {
  const u_val = ~byte & 0xff;
  let t = ((u_val & 0x0f) << 3) + MULAW_BIAS;
  t <<= (u_val & 0x70) >> 4;
  return u_val & 0x80 ? MULAW_BIAS - t : t - MULAW_BIAS;
}

/** 256-entry decode lookup table, computed once at module load. */
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  MULAW_DECODE_TABLE[i] = decodeMulawByte(i);
}

/**
 * Decode a Buffer of mu-law bytes to an Int16Array of linear PCM samples.
 * @param {Buffer|Uint8Array} buf
 * @returns {Int16Array}
 */
export function decodeMulaw(buf) {
  if (!buf || buf.length === 0) return new Int16Array(0);
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = MULAW_DECODE_TABLE[buf[i]];
  }
  return out;
}

/**
 * Encode one linear PCM16 sample to a mu-law byte.
 * @param {number} sample - clamped internally to the mu-law range
 * @returns {number} 0-255
 */
export function encodeMulawSample(sample) {
  let s = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, Math.round(sample) | 0));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s += MULAW_BIAS;

  // Find the segment: the position of the highest set bit at or below 0x4000.
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    // walk down
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Encode an array of linear PCM16 samples to a mu-law Buffer.
 * @param {Int16Array|number[]} samples
 * @returns {Buffer}
 */
export function encodeMulaw(samples) {
  if (!samples || samples.length === 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = encodeMulawSample(samples[i]);
  }
  return out;
}

/**
 * Return a copy of `frame` with every sample scaled by a gain that ramps
 * linearly from `fromGain` to `toGain` across the frame. Used to taper
 * outbound speech to silence on a barge-in instead of chopping it dead.
 *
 * @param {Buffer} frame - mu-law bytes
 * @param {number} fromGain - gain at the first sample (0..1)
 * @param {number} toGain - gain at the last sample (0..1)
 * @returns {Buffer} mu-law bytes, same length as `frame`
 */
export function rampFrame(frame, fromGain, toGain) {
  if (!frame || frame.length === 0) return Buffer.alloc(0);
  const samples = decodeMulaw(frame);
  const n = samples.length;
  const span = toGain - fromGain;
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) {
    const gain = fromGain + (span * i) / Math.max(1, n - 1);
    out[i] = encodeMulawSample(samples[i] * gain);
  }
  return out;
}
