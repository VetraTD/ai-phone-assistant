import { DEFAULT_HANGOVER_MS } from "./constants.js";

/**
 * Arm B — manual activity detection, flat hangover.
 *
 * This is exactly what the spike ran, and it is here to be the control: the one
 * arm whose behaviour on a real phone line is already known, so a live round
 * comparing A and C has a third point it can check itself against.
 *
 * It is also the arm that showed what manual detection costs when the timer is
 * not priced from content: ~900 ms per turn, every turn, paid by every caller
 * including the ones who spoke in whole sentences and needed none of it.
 *
 * @param {object} [opts]
 * @param {number} [opts.hangoverMs]
 */
export function createFlatHangover({ hangoverMs = DEFAULT_HANGOVER_MS } = {}) {
  let turnOpen = false;
  let lastVoicedMs = 0;

  return {
    name: "hangover",
    manual: true,

    connectConfig() {
      return { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } };
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
      // `turnOpen` is the latch that makes this fire once per turn rather than
      // on every frame for the rest of the call.
      if (turnOpen && !isActive && atMs - lastVoicedMs >= hangoverMs) {
        turnOpen = false;
        return { close: true, rule: "flat_hangover" };
      }
      return {};
    },

    onTranscript() {},

    reset() {
      turnOpen = false;
      lastVoicedMs = 0;
    },
  };
}
