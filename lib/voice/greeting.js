import { getStrings } from "./strings.js";

/**
 * The words a caller should hear first, composed once for both front-ends.
 *
 * The cascade speaks this over TTS (lib/voice/session.js buildGreeting, which
 * delegates here). The Live front-end has no TTS leg, so it hands the same text
 * to the model as the line to open on -- see the greetingSpoken branch in
 * services/gemini.js buildDynamicTail.
 *
 * It lives HERE rather than in services/gemini.js for a reason worth keeping:
 * tests/session.test.js partially mocks that module, so a helper the cascade
 * depends on becomes undefined the moment it moves in there. A shared primitive
 * belongs in the layer both callers already import, not in one caller's
 * service.
 *
 * The recording disclosure leads, unconditionally: a business that enabled it
 * is saying something it may be legally required to say before anything else
 * happens, and a second copy of that rule is a second place for it to go
 * missing.
 *
 * @param {object} config
 * @returns {string}
 */
export function greetingTextFor(config) {
  let text = "";
  if (config?.recordingDisclosureEnabled) {
    text =
      (config.recordingDisclosureText ||
        "This call may be recorded for quality and training purposes.") + " ";
  }
  if (!config?._hasCustomGreeting) {
    // The default greeting is a generic "Hi, how can I help you today?" —
    // prepending a time-of-day word to it produced a double greeting with no
    // business name. Synthesize one natural line instead.
    const S = getStrings(config);
    const tz = config?.timezone || "America/Chicago";
    const hour = parseInt(
      new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).split(":")[0],
      10
    );
    const tod = hour < 12 ? S.todMorning : hour < 17 ? S.todAfternoon : S.todEvening;
    text += S.greetingDefault(tod, config?.businessName || "our office");
  } else {
    text += config.greeting;
  }
  return text;
}
