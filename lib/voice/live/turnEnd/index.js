import { createVendorAd } from "./vendorAd.js";
import { createFlatHangover } from "./flatHangover.js";
import { createClassifyHoldStrategy } from "./classifyHold.js";
import { DEFAULT_HANGOVER_MS, DEFAULT_MIN_SILENCE_MS, DEFAULT_BACKSTOP_MS } from "./constants.js";

export { createVendorAd, createFlatHangover, createClassifyHoldStrategy };

/**
 * Who decides the caller's turn ended.
 *
 * ---------------------------------------------------------------------------
 * A seam, not a decision
 * ---------------------------------------------------------------------------
 *
 * Three arms, scored on the same calls, per
 * docs/speech-to-speech-handoff.md section 6:
 *
 *   vendor    the vendor's automaticActivityDetection      INCUMBENT, DEFAULT
 *   hangover  manual + a flat timer                        the spike's control
 *   hold      manual + classifyHold                        the candidate
 *
 * The default is `vendor` because it is the incumbent and because it is
 * currently winning: 1,325 ms felt against 2,246 ms, on matched speakerphone
 * calls. `hold` is a prediction that has never run in a Live front-end.
 *
 * **Lock nothing until `hold` beats `vendor` on a real handset.** The case for
 * manual detection rests on a synthetic harness (round 3, 5/5 trail-off cut-ins
 * at default VAD) plus one real call in the manual arm. Nobody has run a
 * trailing-off caller through the vendor arm on a phone line, which is the
 * single measurement that would settle it.
 *
 * ---------------------------------------------------------------------------
 * The interface
 * ---------------------------------------------------------------------------
 *
 *   name          which arm, for the call summary
 *   manual        do we send activityStart/activityEnd at all
 *   connectConfig fragment merged into the Live session config
 *   onFrame       per 20 ms inbound frame -> { open?, close?, rule?, shape? }
 *   onTranscript  the caller's own words, when they land
 *   reset         between calls
 *
 * `onFrame` is the only place a turn ends, in every arm. Twilio streams frames
 * continuously — silence included — so no arm needs a timer, and a strategy
 * with no timer is one a test can drive deterministically.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function selectStrategy(env = process.env) {
  const arm = String(env.LIVE_TURN_END || "").trim().toLowerCase();

  if (arm === "hangover") {
    return createFlatHangover({ hangoverMs: intFromEnv(env.LIVE_HANGOVER_MS, DEFAULT_HANGOVER_MS) });
  }
  if (arm === "hold") {
    return createClassifyHoldStrategy({
      minSilenceMs: intFromEnv(env.LIVE_MIN_SILENCE_MS, DEFAULT_MIN_SILENCE_MS),
      backstopMs: intFromEnv(env.LIVE_HOLD_BACKSTOP_MS, DEFAULT_BACKSTOP_MS),
    });
  }
  // Anything else, including an unset or misspelt value, is the incumbent.
  // A typo in a deploy variable must not silently move a live call onto an
  // unmeasured arm.
  return createVendorAd({
    bookkeepingHangoverMs: intFromEnv(env.LIVE_HANGOVER_MS, DEFAULT_HANGOVER_MS),
  });
}

/** @returns {number} a sane positive integer, or the fallback. */
function intFromEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : fallback;
}
