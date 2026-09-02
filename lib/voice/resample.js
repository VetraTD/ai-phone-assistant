import { encodeMulaw, decodeMulaw } from "./mulaw.js";

// ---------------------------------------------------------------------------
// Sample-rate conversion between Gemini Live and Twilio.
//
// Gemini Live speaks PCM16 at 24 kHz and listens at 16 kHz. Twilio Media
// Streams speak G.711 mu-law at 8 kHz in both directions. Neither rate matches,
// and the two directions are not symmetric problems:
//
//   OUT (24 kHz -> 8 kHz) is a DECIMATION and it is the dangerous one. 24/8 is
//   exactly 3, so it is tempting to keep every third sample — but everything
//   between 4 and 12 kHz then folds straight back into the voice band. A 6 kHz
//   sibilant reappears at 2 kHz at nearly full amplitude: not a subtle
//   degradation, a loud tone that was never in the input. So the band is
//   removed with an FIR low-pass BEFORE the decimation, never after.
//
//   IN (8 kHz -> 16 kHz) is an INTERPOLATION and it is benign. The source is
//   already band-limited to 4 kHz by the phone network, so the images the
//   upsample creates sit above 4 kHz where there was never any signal, and
//   linear interpolation is itself a mild low-pass. This is the same reasoning
//   scripts/probes/lib/audio.js recorded, and the probes' measurements were
//   taken through it.
//
// State is carried in a closure per call, the way lib/voice/inboundVad.js and
// lib/voice/audioOut.js do it. That is not decoration: Gemini sends audio in
// chunks whose length is its business, not a multiple of anything, and a filter
// whose history or decimation phase resets at every chunk boundary clicks once
// per chunk.
// ---------------------------------------------------------------------------

/** Decimation factor. 24000 / 8000, and it is exact — no fractional phase. */
const DECIMATION = 3;

/**
 * Low-pass corner, in Hz. Chosen at the top of the telephone band rather than
 * at the 4 kHz Nyquist limit: everything above ~3.4 kHz is discarded by the
 * PSTN anyway, so filtering there costs nothing audible and buys a wider
 * transition band, which is what turns into stopband attenuation for a given
 * number of taps.
 */
const CUTOFF_HZ = 3400;

/**
 * Filter length. Odd, so the filter is symmetric about a whole sample and its
 * group delay is an integer.
 *
 * 63 taps of Hamming-windowed sinc gives roughly 53 dB of stopband rejection
 * with a transition width of about 3.3/N — around 1.25 kHz here, so the
 * stopband is fully established by 4.7 kHz and the fold-down band is inside it.
 * tests/resample.test.js asserts better than 30 dB at 6 kHz, which is the
 * margin this is sized for.
 */
const TAPS = 63;

/** Windowed-sinc low-pass, normalised to unity gain at DC. */
function lowPassCoefficients(taps, cutoffHz, sampleRate) {
  const fc = cutoffHz / sampleRate; // cycles per sample
  const centre = (taps - 1) / 2;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - centre;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    // Hamming. Its first sidelobe is what sets the stopband floor above.
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

const COEFFS = lowPassCoefficients(TAPS, CUTOFF_HZ, 24000);
const HISTORY = TAPS - 1;

/**
 * Create a 24 kHz PCM16 -> 8 kHz mu-law converter for one call.
 *
 * `process` may be called with chunks of any length, including zero, and the
 * concatenated output is identical to what the same audio fed as one buffer
 * would produce. tests/resample.test.js asserts that directly, because it is
 * the property every chunk-boundary click comes from losing.
 *
 * @returns {{ process: (pcm16le: Buffer) => Buffer }}
 */
export function createDownsampler() {
  // The last HISTORY input samples, so the first output of the next chunk sees
  // the same taps it would have seen mid-stream. Zeroed at the start, which is
  // the correct assumption: before the call there was silence.
  let history = new Int16Array(HISTORY);
  // Total input samples consumed. An output is produced wherever this index is
  // a multiple of DECIMATION, so the phase survives any chunk split.
  let consumed = 0;
  // A trailing odd byte. A chunk boundary is not obliged to fall between two
  // 16-bit samples, and dropping the orphan byte would not merely lose 1/48000
  // of a second -- it would shift every subsequent sample by one byte, so the
  // whole rest of the call decodes as byte-swapped noise. Silent, total, and
  // one line to prevent.
  let byteCarry = Buffer.alloc(0);

  function process(pcm16le) {
    const chunk = pcm16le && pcm16le.length ? pcm16le : Buffer.alloc(0);
    const bytes = byteCarry.length ? Buffer.concat([byteCarry, chunk]) : chunk;
    const sampleCount = bytes.length >> 1;
    byteCarry = bytes.length & 1 ? Buffer.from(bytes.subarray(sampleCount * 2)) : Buffer.alloc(0);
    if (sampleCount === 0) return Buffer.alloc(0);

    const incoming = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) incoming[i] = bytes.readInt16LE(i * 2);

    const buf = new Int16Array(HISTORY + incoming.length);
    buf.set(history, 0);
    buf.set(incoming, HISTORY);

    const out = [];
    for (let b = HISTORY; b < buf.length; b++) {
      // Global stream index of buf[b]. `consumed` is the index of the first
      // incoming sample, which sits at buf[HISTORY].
      if ((consumed + b - HISTORY) % DECIMATION !== 0) continue;
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += COEFFS[k] * buf[b - k];
      out.push(acc);
    }

    consumed += incoming.length;
    history = buf.slice(buf.length - HISTORY);

    return encodeMulaw(out);
  }

  return { process };
}

/**
 * 8 kHz mu-law -> 16 kHz PCM16 LE, which is the only input format Gemini Live
 * accepts.
 *
 * Moved from scripts/probes/lib/audio.js unchanged, deliberately: every latency
 * and behaviour number in docs/speech-to-speech-handoff.md was measured through
 * this exact interpolation, and swapping in a better one here would mean the
 * spike is no longer comparable to the probes it is meant to extend.
 *
 * @param {Buffer} ulaw
 * @returns {Buffer} PCM16 little-endian, 16 kHz
 */
export function mulaw8kToPcm16k(ulaw) {
  if (!ulaw || ulaw.length === 0) return Buffer.alloc(0);
  const pcm8 = decodeMulaw(ulaw);
  const n = pcm8.length;
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const cur = pcm8[i];
    const next = i + 1 < n ? pcm8[i + 1] : cur;
    out[i * 2] = cur;
    out[i * 2 + 1] = (cur + next) >> 1;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Accumulate arbitrary byte chunks and emit only whole frames.
 *
 * lib/voice/audioOut.js paces in 160-byte (20 ms) mu-law frames and computes
 * the playback window from byte counts, so handing it a short frame both clicks
 * and skews `playingUntil`. Gemini's chunk sizes have no relationship to 160,
 * hence the carry.
 *
 * @param {number} [frameBytes=160]
 * @returns {{ push: (chunk: Buffer) => Buffer[], pending: () => number }}
 */
export function createFramer(frameBytes = 160) {
  let carry = Buffer.alloc(0);

  function push(chunk) {
    const buf = chunk && chunk.length ? Buffer.concat([carry, chunk]) : carry;
    const frames = [];
    let offset = 0;
    while (buf.length - offset >= frameBytes) {
      frames.push(buf.subarray(offset, offset + frameBytes));
      offset += frameBytes;
    }
    carry = Buffer.from(buf.subarray(offset));
    return frames;
  }

  return { push, pending: () => carry.length };
}
