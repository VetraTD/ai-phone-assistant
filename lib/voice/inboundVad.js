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
  // Length of the longest unbroken voiced run seen so far in the CURRENT
  // activation, and when that activation began. See voicedRunMs().
  let runStartMs = null;
  let longestRunMs = 0;

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
        runStartMs = null;
        longestRunMs = 0;
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
        if (runStartMs === null) runStartMs = t;
        lastVoicedMs = t;
        if (t - runStartMs > longestRunMs) longestRunMs = t - runStartMs;
        if (!activated && t - streakStartMs >= activeMs) {
          activated = true;
        }
      } else {
        // Adaptive noise floor updates ONLY on non-voice frames.
        floor = floor * (1 - floorAlpha) + rms * floorAlpha;
        streakStartMs = null;
        // A gap ends the current run but NOT the activation — the hangover
        // above owns that. longestRunMs therefore survives the natural
        // micro-gaps inside real speech and only resets when the caller has
        // genuinely stopped.
        runStartMs = null;
      }

      return { voiced, voiceActive: isActive(t), rms };
    } catch (err) {
      log.error("vad_process_frame_error", { reason: err?.message });
      return { voiced: false, voiceActive: false, rms: 0 };
    }
  }

  /**
   * How long, in ms, the caller has actually been SPEAKING in the current
   * burst of activity — the longest unbroken voiced run since this activation
   * began, ignoring the micro-gaps that occur inside normal speech.
   *
   * WHY THIS EXISTS. isActive() answers "was there voice energy recently",
   * which a cough satisfies perfectly: activeMs is 200ms and a cough is a
   * ~200ms high-energy burst. turnManager then treated that as corroboration
   * that the caller had spoken, and let a stray transcript cut the assistant
   * off. Nothing anywhere measured DURATION, so nothing could tell a cough
   * from a sentence — and that is the whole difference between them.
   *
   * Returns 0 once the activation lapses, so a stale burst cannot vouch for a
   * transcript arriving much later.
   *
   * @param {number} atMs
   * @returns {number} ms of sustained voiced speech, 0 when not active
   */
  function voicedRunMs(atMs) {
    try {
      if (!isActive(atMs)) return 0;
      const t = typeof atMs === "number" && !Number.isNaN(atMs) ? atMs : lastVoicedMs ?? 0;
      // Include the run still in progress: mid-utterance, runStartMs is set and
      // the caller is still talking, so the live run is the honest answer.
      const live = runStartMs !== null ? Math.max(0, (lastVoicedMs ?? t) - runStartMs) : 0;
      return Math.max(longestRunMs, live);
    } catch {
      return 0;
    }
  }

  /** Reset all activation and adaptive-floor state to initial conditions. */
  function reset() {
    floor = INITIAL_FLOOR;
    streakStartMs = null;
    activated = false;
    lastVoicedMs = null;
    runStartMs = null;
    longestRunMs = 0;
  }

  return {
    processFrame,
    isActive,
    voicedRunMs,
    reset,
    _decodeMulaw: decodeMulaw,
  };
}
