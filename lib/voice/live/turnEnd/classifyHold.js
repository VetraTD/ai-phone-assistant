import { classifyHold } from "../../../transcriptUtils.js";
import { DEFAULT_MIN_SILENCE_MS, DEFAULT_BACKSTOP_MS } from "./constants.js";

/**
 * Arm C — manual activity detection, priced by `classifyHold`.
 *
 * ---------------------------------------------------------------------------
 * A CANDIDATE. Not the design.
 * ---------------------------------------------------------------------------
 *
 * The bet: pay only the callers who are actually mid-thought. `classifyHold`
 * returns 0 ms for a sentence ending in terminal punctuation — the common case
 * — and 2,000 ms for one ending on a conjunction. A flat timer charges both the
 * same. So a caller who speaks in whole sentences should be answered at roughly
 * the silence floor, where arm B makes them wait 1,200 ms.
 *
 * That is a prediction, and docs/speech-to-speech-handoff.md section 3 is a
 * table of twelve confident predictions that measurement disproved. It ships as
 * an arm, behind a flag, defaulting off.
 *
 * ---------------------------------------------------------------------------
 * The dependency nobody has checked
 * ---------------------------------------------------------------------------
 *
 * `classifyHold`'s terminal-punctuation branch tests the RAW transcript for
 * `[.!?]` at the end (lib/transcriptUtils.js). It was written against Deepgram
 * with `smart_format` on, which punctuates. Gemini's `inputAudioTranscription`
 * may or may not — nobody has looked.
 *
 * If it does not punctuate, every utterance falls through to the
 * `no_terminal_punctuation` branch at 500 ms and this arm's entire advantage
 * over a well-chosen flat hangover disappears. It does NOT break: 500 ms still
 * beats 1,200 ms. But the reason to prefer it would be gone.
 *
 * `holdRule` and `hasTerminalPunct` are reported per turn so the first real
 * call settles this. The TEXT is never logged — tests/logPhiLint.test.js, and a
 * caller's utterance is the most sensitive thing on the wire.
 *
 * @param {object} [opts]
 * @param {number} [opts.minSilenceMs]
 * @param {number} [opts.backstopMs]
 */
export function createClassifyHoldStrategy({
  minSilenceMs = DEFAULT_MIN_SILENCE_MS,
  backstopMs = DEFAULT_BACKSTOP_MS,
} = {}) {
  let turnOpen = false;
  let lastVoicedMs = 0;
  /** The most recent transcript's verdict, or null once spent or invalidated. */
  let pending = null;
  /** Reported alongside the close, so the punctuation question above is answerable. */
  let lastShape = null;

  return {
    name: "hold",
    manual: true,

    connectConfig() {
      return { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } };
    },

    onFrame({ voiced, isActive, atMs }) {
      if (voiced) {
        lastVoicedMs = atMs;
        // A continuation cancels the hold. This is what makes a hold cost
        // nothing when it guesses wrong: the caller carried on, so the verdict
        // was about a fragment that is no longer the end of anything.
        pending = null;
        if (!turnOpen) {
          turnOpen = true;
          return { open: true };
        }
        return {};
      }

      if (!turnOpen || isActive) return {};

      const silenceMs = atMs - lastVoicedMs;
      if (silenceMs < minSilenceMs) return {};

      if (pending && silenceMs >= pending.holdMs) {
        const rule = pending.rule;
        const shape = lastShape;
        pending = null;
        turnOpen = false;
        return { close: true, rule, shape };
      }

      if (silenceMs >= backstopMs) {
        // No transcript, or one whose hold has not yet elapsed but which is
        // already out-waiting the backstop. Either way the caller has been
        // silent long enough that continuing to wait is dead air.
        pending = null;
        turnOpen = false;
        return { close: true, rule: "hold_backstop", shape: lastShape };
      }

      return {};
    },

    /**
     * Record what the caller's own words say about whether they finished.
     *
     * Deliberately does NOT close the turn itself. `onFrame` is the single
     * decision point, which costs at most one 20 ms frame of latency and buys a
     * strategy whose timing can be reasoned about in one place.
     */
    onTranscript({ text }) {
      const t = typeof text === "string" ? text : "";
      if (!t.trim()) return;
      // Both arguments are the same string: Gemini gives one transcript, not
      // Deepgram's cleaned/raw pair. classifyHold's punctuation branch reads
      // the second, so passing the text as raw is what keeps that branch alive.
      const verdict = classifyHold(t, t);
      pending = { holdMs: verdict.holdMs, rule: verdict.rule };
      lastShape = {
        rule: verdict.rule,
        hold_ms: verdict.holdMs,
        // Shape, never content. See the header.
        has_terminal_punct: /[.!?]\s*$/.test(t.trim()),
        length: t.trim().length,
      };
    },

    reset() {
      turnOpen = false;
      lastVoicedMs = 0;
      pending = null;
      lastShape = null;
    },
  };
}
