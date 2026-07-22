import { log } from "../logger.js";
import { decodeMulaw } from "./mulaw.js";

// ---------------------------------------------------------------------------
// Energy-based VAD on inbound mu-law (G.711) audio — standalone module for
// the voice-pipeline rewrite. One `createVad(opts)` instance per call.
//
// There is no acoustic echo cancellation in this pipeline: the AI's own
// synthesized speech can bleed back into the caller's audio stream and be
// (mis)transcribed by STT. This module is one of three signals combined by
// turnManager.js to decide whether a caller is genuinely speaking during an
// AI turn (the other two being the outbound playback window and interim-
// transcript content). It has no knowledge of any of that — it's a plain
// energy VAD over decoded PCM.
//
// Time is always caller-supplied (`atMs`), never read from the system clock
// internally, so behavior is deterministic and testable (same pattern as
// lib/voice/metrics.js).
// ---------------------------------------------------------------------------

/**
 * RMS (root mean square) energy of a set of PCM16 samples.
 * @param {Int16Array} samples
 * @returns {number}
 */
function computeRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * Create an energy-based VAD instance for one call's inbound audio.
 *
 * @param {object} [opts]
 * @param {number} [opts.activeMs=200]      - ms of continuous voiced frames required before voiceActive becomes true
 * @param {number} [opts.hangoverMs=300]    - ms of unvoiced frames tolerated after activation before voiceActive drops
 * @param {number} [opts.minRms=700]        - absolute floor for the voiced threshold, regardless of adaptive noise floor
 * @param {number} [opts.floorAlpha=0.02]   - EMA smoothing factor for the adaptive noise floor
 * @param {number} [opts.floorMultiplier=3] - adaptive floor is multiplied by this to form the voiced threshold
 * @returns {{
 *   processFrame: function(Buffer, number): {voiced: boolean, voiceActive: boolean, rms: number},
 *   isActive: function(number): boolean,
 *   reset: function(): void,
 *   _decodeMulaw: function(Buffer): Int16Array,
 * }}
 */
export function createVad(opts = {}) {
  const {
    activeMs = 200,
    hangoverMs = 300,
    minRms = 700,
    floorAlpha = 0.02,
    floorMultiplier = 3,
  } = opts;

  const INITIAL_FLOOR = 200;

  let floor = INITIAL_FLOOR;
  let streakStartMs = null; // start of the current unbroken voiced run (while not yet active)
  let activated = false; // latched true once a streak has reached activeMs; cleared on hangover expiry
  let lastVoicedMs = null; // timestamp of the most recent voiced frame

  /**
   * Pure query: is voiceActive true as of `atMs`? Decoupled from processFrame
   * so it can be asked about hangover expiry even if no new frame has
   * arrived (e.g. turnManager checking VAD state against its own `now()`).
   * @param {number} atMs
   * @returns {boolean}
   */
  function isActive(atMs) {
    try {
      if (!activated || lastVoicedMs === null) return false;
      const t = typeof atMs === "number" && !Number.isNaN(atMs) ? atMs : lastVoicedMs;
      return t - lastVoicedMs < hangoverMs;
    } catch {
      return false;
    }
  }

  /**
   * Process one inbound audio frame.
   * @param {Buffer} mulawBuf - raw mu-law bytes (Twilio sends 160-byte/20ms frames, but any length is accepted)
   * @param {number} atMs - caller-supplied timestamp for this frame
   * @returns {{voiced: boolean, voiceActive: boolean, rms: number}}
   */
  function processFrame(mulawBuf, atMs) {
    try {
      const t = typeof atMs === "number" && !Number.isNaN(atMs) ? atMs : lastVoicedMs ?? 0;

      // Lazily expire a latched activation once hangoverMs has elapsed since
      // the last voiced frame. This must happen here (not only inside
      // isActive's read-only check) so that a *new* voiced burst arriving
      // after a long gap has to re-accumulate a fresh activeMs streak rather
      // than instantly reactivating off a stale latch.
      if (activated && lastVoicedMs !== null && t - lastVoicedMs >= hangoverMs) {
        activated = false;
        streakStartMs = null;
      }

      if (!mulawBuf || mulawBuf.length === 0) {
        return { voiced: false, voiceActive: isActive(t), rms: 0 };
      }

      const samples = decodeMulaw(mulawBuf);
      const rms = computeRms(samples);
      const threshold = Math.max(floor * floorMultiplier, minRms);
      const voiced = rms > threshold;

      if (voiced) {
        if (streakStartMs === null) streakStartMs = t;
        lastVoicedMs = t;
        if (!activated && t - streakStartMs >= activeMs) {
          activated = true;
        }
      } else {
        // Adaptive noise floor updates ONLY on non-voice frames.
        floor = floor * (1 - floorAlpha) + rms * floorAlpha;
        streakStartMs = null;
      }

      return { voiced, voiceActive: isActive(t), rms };
    } catch (err) {
      log.error("vad_process_frame_error", { reason: err?.message });
      return { voiced: false, voiceActive: false, rms: 0 };
    }
  }

  /** Reset all activation and adaptive-floor state to initial conditions. */
  function reset() {
    floor = INITIAL_FLOOR;
    streakStartMs = null;
    activated = false;
    lastVoicedMs = null;
  }

  return {
    processFrame,
    isActive,
    reset,
    _decodeMulaw: decodeMulaw,
  };
}
