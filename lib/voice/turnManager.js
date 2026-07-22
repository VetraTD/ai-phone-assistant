import { performance } from "node:perf_hooks";
import { log } from "../logger.js";
import { stripFillers } from "../transcriptUtils.js";

// ---------------------------------------------------------------------------
// Barge-in decision layer — standalone module for the voice-pipeline
// rewrite. One `createTurnManager(opts)` instance per call.
//
// There is no acoustic echo cancellation in this pipeline, so the AI's own
// synthesized speech can bleed back into the caller's inbound audio and get
// transcribed by STT as if the caller said it. This module combines three
// signals to decide whether an interim/final transcript represents a real
// caller interruption or just AI-audio echo / a passive acknowledgment:
//   1. content of the transcript itself (backchannel vs. interrupt cue vs.
//      long enough to be a real utterance)
//   2. energy VAD on the inbound audio (lib/voice/inboundVad.js)
//   3. whether the AI is currently playing audio (lib/voice/audioOut.js)
//
// It owns no audio or STT connection itself — vad and audioOut are injected,
// and callers wire handleAudioFrame/handleInterim/handleFinal into their
// STT/media event handlers.
// ---------------------------------------------------------------------------

/** Phrases that, alone or in any combination, should never interrupt the AI. */
export const BACKCHANNELS = [
  "yeah", "yes", "yep", "yup", "uh-huh", "uh huh", "mm-hmm", "mm hmm", "mhm",
  // Deepgram transcribes "mm-hmm" inconsistently — "mm", "mmm", "hmm", "hm",
  // "mhmm" are all observed variants of the same acknowledgment sound.
  "mm", "mmm", "hmm", "hm", "mhmm",
  "ok", "okay", "right", "sure", "got it", "gotcha", "alright", "all right",
  "i see", "cool",
];

/** Phrases whose presence signals a deliberate interruption attempt. */
export const INTERRUPT_CUES = [
  "stop", "wait", "hold on", "hang on", "no", "actually", "excuse me",
  "one second", "one sec", "question", "sorry", "pause", "shut up", "listen",
];

/**
 * Normalize transcript text for matching: lowercase, punctuation replaced
 * with spaces (so hyphenated forms like "uh-huh" become "uh huh", matching
 * the space-separated BACKCHANNELS/INTERRUPT_CUES entries), whitespace
 * collapsed and trimmed.
 * @param {*} text
 * @returns {string}
 */
function normalize(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhrase(phrase) {
  return normalize(phrase);
}

const BACKCHANNEL_SET = new Set(BACKCHANNELS.map(normalizePhrase));
const BACKCHANNEL_MAX_WORDS = Math.max(
  ...BACKCHANNELS.map((p) => normalizePhrase(p).split(" ").length)
);

const INTERRUPT_CUE_PHRASES = INTERRUPT_CUES.map(normalizePhrase);

/**
 * Is every word of the normalized text consumable as a backchannel phrase
 * (greedy longest-match over BACKCHANNELS, treating multi-word entries like
 * "got it" as a single unit)? Empty text is not considered a backchannel.
 * @param {string} normalizedText
 * @returns {boolean}
 */
function isPureBackchannel(normalizedText) {
  const words = normalizedText.split(" ").filter(Boolean);
  if (words.length === 0) return false;

  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let len = Math.min(BACKCHANNEL_MAX_WORDS, words.length - i); len >= 1; len--) {
      const phrase = words.slice(i, i + len).join(" ");
      if (BACKCHANNEL_SET.has(phrase)) {
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * Does the normalized text contain any INTERRUPT_CUE as a whole-word/phrase
 * match (not a substring inside a larger word)?
 * @param {string} normalizedText
 * @returns {boolean}
 */
function containsInterruptCue(normalizedText) {
  const padded = ` ${normalizedText} `;
  return INTERRUPT_CUE_PHRASES.some((cue) => padded.includes(` ${cue} `));
}

/**
 * Create a barge-in turn manager for one call.
 *
 * @param {object} opts
 * @param {{isActive: function(number): boolean}} opts.vad - lib/voice/inboundVad.js instance
 * @param {{isPlaying: function(number=): boolean}} opts.audioOut - lib/voice/audioOut.js instance
 * @param {function(string): void} [opts.onInterrupt] - called (at most once per speaking turn) when a real interruption is detected
 * @param {function(string): void} [opts.onTurnEnd] - called when the caller's turn is considered complete
 * @param {function(): void} [opts.onVoiceActive] - called for every frame the VAD reports voiceActive. Lets a caller observe "the caller is making sound right now" (e.g. to hold off an idle/silence prompt) without reaching into the vad instance directly. Fires often — roughly every 20ms frame — so handlers must be cheap.
 * @param {function(): number} [opts.now] - injectable clock (ms), defaults to performance.now()
 * @returns {{
 *   handleInterim: function(string): object,
 *   handleFinal: function(string): object,
 *   handleAudioFrame: function(Buffer): object,
 *   reset: function(): void,
 * }}
 */
// How far back to look for real mic energy when judging whether a short
// final was actually spoken. Deepgram only emits a final after ~300ms
// (endpointing) of silence plus network time, so by final-arrival the VAD's
// 300ms hangover has ALWAYS lapsed — vad.isActive(now) alone can never
// confirm a genuine one-word interjection. Instead remember when voice
// energy was last active and accept a final whose utterance window overlaps
// that memory.
const FINAL_VOICE_WINDOW_MS = 1500;

export function createTurnManager({ vad, audioOut, onInterrupt, onTurnEnd, onVoiceActive, now = () => performance.now() } = {}) {
  let interruptedThisTurn = false;
  let lastVoiceActiveMs = null; // most recent frame where the VAD reported voiceActive

  function aiSpeaking() {
    try {
      return !!audioOut?.isPlaying?.(150);
    } catch {
      return false;
    }
  }

  /** Fire onInterrupt at most once per speaking turn (dedupe until reset()/turn end). */
  function triggerInterrupt(text) {
    if (interruptedThisTurn) return;
    interruptedThisTurn = true;
    try {
      onInterrupt?.(text);
    } catch (err) {
      log.error("turn_manager_on_interrupt_error", { reason: err?.message });
    }
  }

  function endTurn(text) {
    try {
      onTurnEnd?.(text);
    } catch (err) {
      log.error("turn_manager_on_turn_end_error", { reason: err?.message });
    }
    interruptedThisTurn = false; // a completed turn always clears the dedupe latch
  }

  function logBargeIn(reason, extra = {}) {
    try {
      log.info("barge_in", { reason, ...extra });
    } catch {
      // logging must never break the call
    }
  }

  /**
   * Handle one interim (non-final) STT transcript.
   * @param {string} text
   * @returns {{action: string, reason?: string}}
   */
  function handleInterim(text) {
    try {
      const normalized = normalize(text);
      if (!normalized) {
        // Empty/null interim (e.g. an STT silence artifact) is not content
        // to react to at all — never treat it as a decision, let alone a
        // trigger for a callback.
        return { action: "ignore", reason: "empty" };
      }

      if (!aiSpeaking()) {
        return { action: "ignore", reason: "not_speaking" };
      }

      if (isPureBackchannel(normalized)) {
        return { action: "ignore", reason: "backchannel" };
      }

      const words = normalized.split(" ").filter(Boolean);
      const hasCue = containsInterruptCue(normalized);

      // No-cue threshold is 4 words: 3-word interims during AI speech are
      // frequently echo of the AI's own audio or a mutter; explicit cues
      // ("stop", "wait") interrupt at any length.
      if (hasCue || words.length >= 4) {
        const vadOk = !!vad?.isActive?.(now());
        if (vadOk) {
          triggerInterrupt(text);
          logBargeIn("interrupt", { text, source: "interim" });
          return { action: "interrupt" };
        }
        logBargeIn("no_vad", { text, source: "interim" });
        return { action: "ignore", reason: "no_vad" };
      }

      return { action: "defer" };
    } catch (err) {
      log.error("turn_manager_handle_interim_error", { reason: err?.message });
      return { action: "ignore", reason: "error" };
    }
  }

  /**
   * Handle a final STT transcript (end of a caller utterance).
   * @param {string} text
   * @returns {{action: string, reason?: string}}
   */
  function handleFinal(text) {
    try {
      const normalized = normalize(text);
      if (!normalized) {
        // Real STT engines emit empty finals on silence timeouts. Treat as
        // no-op: no interrupt, no turn end — there is no actual utterance
        // here to react to or to close a turn on.
        return { action: "ignore", reason: "empty" };
      }

      const speaking = aiSpeaking();
      const pureBackchannel = isPureBackchannel(normalized);

      if (speaking && !pureBackchannel) {
        // A final that is pure filler after stripping ("mm mm", "er", any
        // acknowledgment-noise combo Deepgram invents) is never a real
        // interruption — treat it like a backchannel regardless of spelling.
        const stripped = stripFillers(text);
        if (!stripped) {
          return { action: "ignore", reason: "filler_only" };
        }

        // A short cue-less final with no recent mic energy is an STT phantom
        // (echo artifact, line noise), not a caller interjection. "Recent" is
        // judged over FINAL_VOICE_WINDOW_MS — see the constant's comment for
        // why vad.isActive(now) alone is never true by final-arrival time.
        const strippedWords = stripped.split(/\s+/).filter(Boolean);
        const voicedRecently =
          (lastVoiceActiveMs !== null && now() - lastVoiceActiveMs <= FINAL_VOICE_WINDOW_MS) ||
          !!vad?.isActive?.(now());
        if (!containsInterruptCue(normalized) && strippedWords.length < 2 && !voicedRecently) {
          logBargeIn("no_vad_final", { text, source: "final" });
          return { action: "ignore", reason: "no_vad" };
        }

        // Finals are otherwise trustworthy even without VAD confirmation: an
        // echo of the AI's own speech would come back as the AI's own words,
        // not as unrelated caller content.
        logBargeIn("final_interrupt", { text, source: "final" });
        triggerInterrupt(text);
        endTurn(text);
        return { action: "interrupt", turnEnded: true };
      }

      if (speaking && pureBackchannel) {
        return { action: "ignore", reason: "backchannel" };
      }

      endTurn(text);
      return { action: "turn_end" };
    } catch (err) {
      log.error("turn_manager_handle_final_error", { reason: err?.message });
      return { action: "ignore", reason: "error" };
    }
  }

  /**
   * Forward one inbound audio frame to the VAD. Called for every inbound
   * media frame in parallel with feeding STT.
   * @param {Buffer} mulawBuf
   * @returns {object|null} the vad.processFrame() result, or null on error
   */
  function handleAudioFrame(mulawBuf) {
    try {
      const result = vad?.processFrame?.(mulawBuf, now()) ?? null;
      if (result?.voiceActive) {
        lastVoiceActiveMs = now();
        try {
          onVoiceActive?.();
        } catch (err) {
          log.error("turn_manager_on_voice_active_error", { reason: err?.message });
        }
      }
      return result;
    } catch (err) {
      log.error("turn_manager_handle_audio_frame_error", { reason: err?.message });
      return null;
    }
  }

  /** Clear the per-turn interrupt dedupe latch. */
  function reset() {
    interruptedThisTurn = false;
  }

  return { handleInterim, handleFinal, handleAudioFrame, reset };
}
