import { DEFAULT_HANGOVER_MS } from "./constants.js";

/**
 * Arm A — the vendor's own `automaticActivityDetection`.
 *
 * ---------------------------------------------------------------------------
 * This is the INCUMBENT, and it is the default
 * ---------------------------------------------------------------------------
 *
 * It is also, on the only numbers anyone has, winning. Matched speakerphone
 * calls in the spike (scripts/spike/VERDICT.md): 1,325 ms from the caller
 * falling silent to hearing a reply, against 2,246 ms for a flat 1,200 ms
 * hangover. The owner heard no misbehaviour on either call.
 *
 * docs/speech-to-speech-handoff.md section 6 makes the case against it, and
 * that case is real but it is not yet a measurement: silence cannot tell
 *
 *     "I'd like to book an appointment."     finished    -> answer now
 *     "I'd like to book an appointment for"  unfinished  -> wait
 *
 * apart, and round 3 saw 3.1 cut into a trailing-off caller 5/5 at default VAD.
 * But round 3 was a synthetic harness, and the ONE trail-off case ever run on a
 * real phone line was run in the manual arm. Nobody has put a trailing-off
 * caller through this arm on a handset.
 *
 * So it stays the default until something beats it on a handset, and this file
 * exists to make the comparison possible rather than to lose it.
 *
 * ---------------------------------------------------------------------------
 * The bookkeeping hangover is NOT an endpointing decision
 * ---------------------------------------------------------------------------
 *
 * `manual` is false, so nothing here sends `activityStart` or `activityEnd` —
 * the vendor decides, entirely. The open/close events this returns exist only
 * to stamp turn boundaries into the metrics, and the spike found out the hard
 * way why they are needed: without them the auto arm produced ONE latency
 * sample per call and the two arms could not be compared at all, which is the
 * single thing this arm exists for.
 *
 * The number therefore does not affect what the caller hears. It affects only
 * where a turn boundary lands in the log.
 *
 * @param {object} [opts]
 * @param {number} [opts.bookkeepingHangoverMs]
 */
export function createVendorAd({ bookkeepingHangoverMs = DEFAULT_HANGOVER_MS } = {}) {
  let turnOpen = false;
  let lastVoicedMs = 0;

  return {
    name: "vendor",
    manual: false,

    /** Nothing. The vendor's detector is on by default and stays on. */
    connectConfig() {
      return {};
    },

    onFrame({ voiced, isActive, atMs }) {
      if (voiced) {
        lastVoicedMs = atMs;
        if (!turnOpen) {
          turnOpen = true;
          return { open: true };
        }
        return {};
      }
      if (turnOpen && !isActive && atMs - lastVoicedMs >= bookkeepingHangoverMs) {
        turnOpen = false;
        return { close: true, rule: "vendor_bookkeeping" };
      }
      return {};
    },

    /** Recorded by the session for its own metrics; this arm does not act on it. */
    onTranscript() {},

    reset() {
      turnOpen = false;
      lastVoicedMs = 0;
    },
  };
}
