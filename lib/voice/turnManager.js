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
// Signal 1 is deliberately the strongest of the three. The other two cannot
// tell the AI's own audio from the caller's: energy VAD sees echo as voice
// (it IS voice), and the playback window says only that the AI was talking.
// So an echoGuard (lib/voice/echoGuard.js) is injected as well, and a
// transcript it recognizes as the AI's own recent speech is dropped before
// either of the other signals gets a vote.
//
// It owns no audio or STT connection itself — vad, audioOut and echoGuard are
// injected, and callers wire handleAudioFrame/handleInterim/handleFinal into
// their STT/media event handlers.
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
 * @param {{classify: function(string, number): {isEcho: boolean, reason: string, ratio: number, novel: number}}} [opts.echoGuard] - lib/voice/echoGuard.js instance. Optional: when absent, no transcript is ever suppressed as echo (pre-echo-guard behavior).
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

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

// Longest transcript still treated as "short" for echo containment. 3 words
// covers the cases classify() structurally cannot judge (it needs 4+ tokens for
// bigram similarity to mean anything). 0 disables the check entirely.
const SHORT_ECHO_MAX_TOKENS = envInt("VOICE_ECHO_SHORT_TOKENS", 3, { max: 6 });

// A final shorter than this needs corroborating mic energy. 2 = today's rule
// (only a single word is doubted).
const SHORT_FINAL_MIN_WORDS = envInt("VOICE_SHORT_FINAL_MIN_WORDS", 2, { min: 1, max: 6 });

// When true, an interrupt cue no longer exempts a short final from needing mic
// energy. Default false = current behavior; flip only with probe data, since a
// genuine urgent "stop" is exactly what this would start suppressing.
const CUE_REQUIRES_VOICE = process.env.VOICE_CUE_REQUIRES_VOICE === "true";

export function createTurnManager({ vad, audioOut, echoGuard, onInterrupt, onTurnEnd, onVoiceActive, now = () => performance.now() } = {}) {
  let interruptedThisTurn = false;
  let lastVoiceActiveMs = null; // most recent frame where the VAD reported voiceActive

  function aiSpeaking() {
    try {
      return !!audioOut?.isPlaying?.(150);
    } catch {
      return false;
    }
  }

  /**
   * Is this transcript the AI's own audio bleeding back into the caller's mic
   * (see lib/voice/echoGuard.js)? Absent guard means "no" — the module is
   * optional so every existing construction site keeps its old behavior.
   * @param {string} text
   * @returns {{isEcho: boolean, reason?: string, ratio?: number, novel?: number}}
   */
  function echoCheck(text) {
    try {
      return echoGuard?.classify?.(text, now()) ?? { isEcho: false };
    } catch (err) {
      log.error("turn_manager_echo_check_error", { reason: err?.message });
      return { isEcho: false };
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
        // Echo is checked BEFORE the VAD, and takes precedence over it. The
        // VAD cannot help here — the AI's own voice coming back off a
        // speakerphone carries plenty of energy, which is precisely why an
        // energy VAD was never a sufficient defense. Content is the evidence.
        const echo = echoCheck(text);
        if (echo.isEcho) {
          logBargeIn("echo_suppressed", {
            text,
            source: "interim",
            ratio: echo.ratio,
            novel: echo.novel,
          });
          return { action: "ignore", reason: "echo" };
        }

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

      // Echo is checked ABOVE the speaking/quiet split, not inside it.
      //
      // Both branches below reach endTurn(). While the AI is still audible,
      // triggerInterrupt is a latched no-op but endTurn still runs; once it
      // has stopped, endTurn runs directly. So a check placed inside the
      // speaking branch would let exactly half the echoes through — including
      // the worst one, the echo arriving just after a barge cut the audio,
      // which is what got fed to the LLM as caller input and kept the
      // start/stop loop alive.
      const echo = echoCheck(text);
      if (echo.isEcho) {
        logBargeIn("echo_suppressed", {
          text,
          source: "final",
          ratio: echo.ratio,
          novel: echo.novel,
        });
        return { action: "ignore", reason: "echo" };
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

        // A one-or-two-word final that the AI itself just said is the AI's own
        // audio coming back, not an interruption. The main echo check above
        // cannot see this: classify() refuses transcripts under 4 tokens
        // because bigram similarity is meaningless there. Without this, the AI
        // saying "No problem, I can get that booked" and being transcribed off
        // a speakerphone as "no" cut the caller off — "no" is an INTERRUPT_CUE,
        // and a cue used to bypass every remaining gate.
        if (
          SHORT_ECHO_MAX_TOKENS > 0 &&
          strippedWords.length <= SHORT_ECHO_MAX_TOKENS &&
          echoGuard?.isShortEcho?.(text, now(), SHORT_ECHO_MAX_TOKENS)
        ) {
          // Counter bumping stays in session.js, which owns the metrics wiring;
          // this module reports through its return value and the log line.
          logBargeIn("echo_suppressed_short", { text, source: "final", words: strippedWords.length });
          return { action: "ignore", reason: "echo_short" };
        }

        // A short cue-less final with no recent mic energy is an STT phantom
        // (echo artifact, line noise), not a caller interjection. "Recent" is
        // judged over FINAL_VOICE_WINDOW_MS — see the constant's comment for
        // why vad.isActive(now) alone is never true by final-arrival time.
        //
        // An interrupt cue exempts a final from this check entirely, on the
        // theory that "stop"/"wait" is urgent enough to act on unverified. That
        // is also how a mis-transcribed noise burst cuts a caller off, so the
        // exemption is removable via VOICE_CUE_REQUIRES_VOICE — off by default
        // because suppressing a genuine urgent "stop" is its own bad outcome,
        // and this one should be chosen from probe data rather than assumed.
        const cueExempt = containsInterruptCue(normalized) && !CUE_REQUIRES_VOICE;
        if (!cueExempt && strippedWords.length < SHORT_FINAL_MIN_WORDS && !voicedRecently) {
          logBargeIn("no_vad_final", { text, source: "final" });
          return { action: "ignore", reason: "no_vad" };
        }

        // Finals are otherwise trustworthy even without VAD confirmation.
        //
        // This used to be justified by the claim that "an echo of the AI's
        // own speech would come back as the AI's own words, not as unrelated
        // caller content" — true, but nothing checked it, so every echo was
        // trusted as caller content. That check now exists and runs above
        // (lib/voice/echoGuard.js); it, not this branch, is what makes a
        // VAD-less final safe to act on.
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
