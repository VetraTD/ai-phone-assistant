/**
 * Stop the model announcing the wrong action.
 *
 * Reported live: the receptionist says "Let me check our calendar" and then,
 * with no calendar check in between, "I've booked your appointment."
 *
 * The engine's own hold lines are not the problem. lib/voice/strings.js maps
 * every tool to a line that describes what that tool actually does, and
 * session.js picks it from the tool name at the moment the call starts. The
 * wrong line is the MODEL's: services/gemini.js requires it to say something
 * whenever it calls a tool, so it volunteers a promise before it has committed
 * to which tool it is calling — and shouldPlayHoldLine then SUPPRESSES the
 * engine's correct line to avoid the two stacking on top of each other. The
 * accurate line loses to the inaccurate one, by design.
 *
 * WHAT THIS DOES
 *
 * When the model's first sentence of a turn is nothing but a promise, hold it
 * out of TTS for a moment instead of speaking it. If a tool call turns up in
 * that window, throw the sentence away and let the engine say what is really
 * happening. If nothing does, speak it as normal, slightly late.
 *
 * The delay is only ever paid on a sentence that says "hold on" — a turn that
 * was about to wait on something anyway. An ordinary answer is never gated.
 *
 * WHY A WHOLE-SENTENCE TEST
 *
 * Because swallowing half a turn would be worse than the bug. "Let me check
 * the calendar" can be discarded; "Let me check the calendar — what time were
 * you thinking?" cannot, because the question is the only thing moving the
 * call forward. So a sentence qualifies only when the promise IS the sentence.
 */

/**
 * A promise that has grown past this is carrying something else as well, and
 * something else is not ours to throw away. Ten words comfortably covers every
 * phrasing promiseRe matches ("Let me just pull up your appointment now." is
 * eight) without reaching a sentence that also answers something.
 */
const PROMISE_MAX_WORDS = 10;

/**
 * Is this sentence purely an "I am about to do something" line?
 *
 * @param {*} sentence - one batch of ready-to-speak text
 * @param {RegExp} promiseRe - the call's locale promise pattern
 *   (lib/voice/strings.js). The SAME regex shouldPlayHoldLine uses to suppress
 *   the engine's line, so the two cannot disagree about what a promise is.
 * @returns {boolean}
 */
export function isPromiseOnly(sentence, promiseRe) {
  if (!promiseRe) return false;
  const s = String(sentence || "").trim();
  if (!s) return false;
  if (!promiseRe.test(s)) return false;
  // A question is content. "One moment — what was the name again?" has to be
  // spoken whatever the tools are doing, or the call stalls waiting for an
  // answer to a question the caller never heard.
  if (s.includes("?")) return false;
  // One sentence only.
  //
  // This is documented and tested as a single-sentence test, but session.js
  // hands it whatever splitReadySentences produced, and that scans for the
  // LAST terminal boundary in the buffer — so one batch can carry several
  // sentences. "One moment. We are open until six." is eight words, has no
  // question mark, and matches promiseRe; gating it would have thrown away
  // the answer along with the promise. Exactly the failure the header above
  // says this must never cause, reached because the caller of the function
  // did not match its contract. Found in review.
  const withoutFinal = s.replace(/[.!?]+$/, "");
  if (/[.!?]/.test(withoutFinal)) return false;
  return s.split(/\s+/).filter(Boolean).length <= PROMISE_MAX_WORDS;
}

/**
 * How long to hold a promise sentence while waiting to see if a tool call
 * follows it.
 *
 * 350ms is chosen to be shorter than a caller notices in a turn that has
 * already announced a wait, and long enough to cover the gap between the
 * model's text and its function call in the same round. 0 disables the gate
 * entirely and restores the previous behaviour, where the model's line always
 * won.
 *
 * Read at call time, not module load, for the reason
 * lib/transcriptUtils.js holdNoPunctMs() documents.
 *
 * @returns {number}
 */
/**
 * Does the ENGINE own the wait line on a tool turn?
 *
 * Lives here rather than in lib/voice/session.js because two places now need
 * the same answer and they are on opposite sides of the pipeline: session.js
 * decides whether to speak the line, and services/gemini.js decides whether to
 * tell the model it may stay silent. Those two must agree — the prompt half
 * shipped unconditional at first, so with VOICE_ENGINE_FILLER="false" the
 * model obeyed "call the tool and stay quiet", the engine said nothing, and
 * the caller got the whole tool round in silence (measured ~2s for the second
 * model round-trip alone). Found in review.
 *
 * @returns {boolean}
 */
export function engineFillerEnabled() {
  return process.env.VOICE_ENGINE_FILLER !== "false";
}

export function promiseGateMs() {
  const v = Number.parseInt(process.env.VOICE_PROMISE_GATE_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 800 ? v : 350;
}
