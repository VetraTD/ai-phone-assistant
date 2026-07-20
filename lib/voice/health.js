// ---------------------------------------------------------------------------
// health.js — module-level degraded-mode flag for the voice pipeline.
//
// When the real-time pipeline's dependencies (Deepgram STT, ElevenLabs/
// Google TTS) are known to be down, setDegraded() flips this flag so
// /twilio/voice falls back to a voicemail-only TwiML response instead of
// connecting a Media Streams call that can't actually converse.
//
// This module intentionally has no wiring into lib/voice/session.js's
// failure paths yet (that's a follow-up task) — for now it's a simple,
// independently-testable flag that server.js reads per request.
// ---------------------------------------------------------------------------

let degraded = false;
let reason = null;

/**
 * Flip the pipeline into degraded mode.
 * @param {string} [why] - Short machine-readable reason (for logs/tests).
 */
export function setDegraded(why = "unknown") {
  degraded = true;
  reason = why;
}

/** Clear degraded mode (e.g. once the dependency recovers). */
export function clearDegraded() {
  degraded = false;
  reason = null;
}

/** @returns {boolean} true if the pipeline is currently degraded. */
export function isDegraded() {
  return degraded;
}

/** @returns {string|null} the reason passed to the most recent setDegraded(), or null. */
export function getDegradedReason() {
  return reason;
}
