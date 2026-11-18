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
 * ---------------------------------------------------------------------------
 * `silenceDurationMs` — measured 2026-09-16, and it is the patience knob
 * ---------------------------------------------------------------------------
 *
 * This file used to return `{}` unconditionally, so every call ever made ran
 * Google's DEFAULT VAD and nobody had tried tuning it. It is tunable, and
 * `scripts/probes/results-vadknobs.json` (60 sessions, gemini-3.1) shows the
 * knob is ENFORCED rather than accepted-and-ignored — which had to be proven,
 * because `toolConfig.functionCallingConfig` is accepted and ignored on 3.8.
 * Time-to-speak after the caller stops, p50:
 *
 *   default   trail-off 1,686 ms   complete 1,580 ms
 *   1,600 ms  trail-off 2,480 ms   complete 2,264 ms
 *   2,000 ms  trail-off 2,830 ms   complete 2,662 ms
 *   2,500 ms  trail-off 3,373 ms   complete 3,194 ms
 *
 * It shifts BOTH fixtures together — silence still cannot tell a finished
 * sentence from an unfinished one, exactly as this file's header says. What it
 * buys is the ability to choose that uniform patience deliberately.
 *
 * At 1,600 ms this arm beats `LIVE_TURN_END=hold` on both axes at once: more
 * patient on a trail-off (2,480 vs 2,291) and FASTER on the ordinary turn
 * (2,264 vs 2,441). And it keeps `inputAudioTranscription` flowing — arriving
 * ~557 ms before the model speaks — where arm C's
 * `automaticActivityDetection:{disabled:true}` suppresses it until after
 * `activityEnd`, which would delay the echo guard, the spelling gate and the
 * turn history along with it.
 *
 * Unset leaves the vendor default, so an unconfigured deploy behaves exactly as
 * every call before today did.
 *
 * @param {object} [opts]
 * @param {number} [opts.bookkeepingHangoverMs]
 * @param {number} [opts.silenceDurationMs] - vendor VAD patience; unset = vendor default
 */
export function createVendorAd({ bookkeepingHangoverMs = DEFAULT_HANGOVER_MS, silenceDurationMs } = {}) {
  let turnOpen = false;
  let lastVoicedMs = 0;

  return {
    name: "vendor",
    manual: false,

    /**
     * Nothing at all unless a silence duration was chosen. The vendor's
     * detector is on by default and stays on either way; this only tells it how
     * long to wait before calling the turn over.
     */
    connectConfig() {
      if (!(typeof silenceDurationMs === "number" && silenceDurationMs > 0)) return {};
      return { realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs } } };
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
