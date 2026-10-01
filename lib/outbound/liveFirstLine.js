/**
 * OUTBOUND CALLING, `live` first-speaker mode (spec
 * docs/superpowers/specs/2026-10-01-outbound-live-first-line-design.md §2,
 * §4, §5). The default since 2026-10-01: no recorded opener -- the AI's own
 * live reply is the first thing the person hears.
 *
 * A small PURE controller, the live-mode counterpart of
 * lib/outbound/firstSeconds.js (which still runs `clip` mode, unchanged). No
 * I/O and no clock of its own: every method takes the session time, and the
 * engine (lib/voice/live/index.js) drives it from its 20 ms media frames.
 *
 * What it owns:
 *   - the silence "Hello?": cued `cueLeadMs` early so it is HEARD at
 *     `silenceHelloMs` after stream start, cancelled for good by speech
 *     first (VAD voiceActive, so one loud frame at pickup cannot cancel it);
 *   - Live unresponsive: no AI audio within `unresponsiveMs` of the person's
 *     last speech end (or of the Hello's due time, or of any Live activity)
 *     before the first AI audio -> endCall("live_unresponsive") + ERROR;
 *   - the first-reply metric `outbound_first_reply` (+ `_slow` past 2 s from
 *     the END of the person's speech -- the spec's reading of the 2-second
 *     rule) and the session's §13.4 silent verdict on the same reading;
 *   - hold (`wait_on_hold`): model audio muted until a person speaks --
 *     a transcript with letters AND >= holdReleaseVoicedMs of voiced audio
 *     in the same utterance -- capped at holdMaxMs -> endCall("hold_timeout").
 *     A generation that started muted is reported via onRelease when a
 *     person is detected mid-generation (Live often answers before its own
 *     input transcript arrives), so the engine can flush it rather than lose
 *     the reply to the new person;
 *   - which turn is the FIRST ANSWER (the disclosure check's target): the
 *     first heard generation that is not the Hello cue's own.
 */

export const LIVE_FIRST_LINE_DEFAULTS = Object.freeze({
  silenceHelloMs: 3000,
  cueLeadMs: 800,
  unresponsiveMs: 6000,
  holdMaxMs: 120000,
  holdReleaseVoicedMs: 400,
  /** How late past silenceHelloMs the Hello may be heard and still count as on time (spec: +/- 500). */
  helloToleranceMs: 500,
  /** The spec's 2-second rule, from the END of the person's speech. */
  slowReplyMs: 2000,
  /** Answer -> media stream start, the same constant firstSeconds.js uses for from_answer_ms. */
  answerToStreamMs: 350,
  frameMs: 20,
});

const HAS_LETTER_RE = /\p{L}/u;

/**
 * @param {object} o
 * @param {number} o.streamStartAtMs
 * @param {() => boolean} o.speakHello - asks Live to say the Hello; false when it could not be sent (no session)
 * @param {(reason: string) => void} o.endCall
 * @param {{info: Function, error: Function}} o.log
 * @param {(name: string) => void} [o.bumpCounter]
 * @param {(fields: {midGeneration: boolean}) => void} [o.onRelease] - a person is back on the line after a hold
 * @param {object} [o.logFields]
 */
export function createLiveFirstLine({
  streamStartAtMs,
  speakHello,
  endCall,
  log,
  bumpCounter = () => {},
  onRelease = () => {},
  logFields = {},
  ...overrides
}) {
  const cfg = { ...LIVE_FIRST_LINE_DEFAULTS, ...overrides };
  const cueDueAt = streamStartAtMs + cfg.silenceHelloMs - cfg.cueLeadMs;

  let ended = false; // endCall fired or the session ended: inert from here
  let cueCancelled = false;
  let cueSent = false;
  let firstAudioAt = null;
  let firstReply = null;
  let firstReplyLogged = false;

  // Caller speech. Utterance boundaries from voiceActive; the speech-end TIME
  // from the last raw voiced frame (voiceActive's hangover would understate
  // the reply gap).
  let speaking = false;
  let anySpeech = false;
  let lastVoicedAt = null;
  let utteranceVoicedMs = 0;
  let lastUtteranceVoicedMs = 0;
  let lastLiveActivityAt = null;

  // Generations (one model turn each).
  let genOpen = false;
  let genHadAudio = false;
  let genMuted = false; // started (audio or text) while on hold, not released since
  let genIsCue = false;
  let firstAnswerTaken = false;

  // Hold.
  let holding = false;
  let holdSince = null;
  let wordsSinceModelTurn = false;

  function log1(level, event, fields) {
    log[level](event, { ...logFields, ...fields });
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    endCall(reason);
  }

  function openGeneration() {
    if (genOpen) return;
    genOpen = true;
    genHadAudio = false;
    genMuted = holding;
    // The first generation after the cue went out is the Hello's own -- unless
    // a reply was already playing. Never the first answer.
    genIsCue = cueSent && firstAudioAt === null;
  }

  function release(atMs) {
    holding = false;
    const midGeneration = genOpen && genMuted;
    genMuted = false;
    bumpCounter("outbound_hold_released");
    log1("info", "outbound_hold_released", { held_ms: Math.round(atMs - holdSince), mid_generation: midGeneration });
    onRelease({ midGeneration });
  }

  function maybeRelease(atMs) {
    if (!holding || !wordsSinceModelTurn) return;
    if (Math.max(utteranceVoicedMs, lastUtteranceVoicedMs) >= cfg.holdReleaseVoicedMs) release(atMs);
  }

  function recordFirstAudio(atMs) {
    firstAudioAt = atMs;
    const fromSpeechEnd = lastVoicedAt === null ? null : Math.max(0, Math.round(atMs - lastVoicedAt));
    firstReply = {
      path: cueSent ? "silence_hello" : "speech",
      from_speech_end_ms: fromSpeechEnd,
      from_answer_ms: Math.round(atMs - streamStartAtMs + cfg.answerToStreamMs),
    };
    firstReplyLogged = true;
    log1("info", "outbound_first_reply", firstReply);
    if (fromSpeechEnd !== null && fromSpeechEnd > cfg.slowReplyMs) {
      bumpCounter("outbound_first_reply_slow");
      log1("error", "outbound_first_reply_slow", { ...firstReply, severity: "warn" });
    }
  }

  // An interrupted generation is OFFERED as the first answer (the engine
  // judges it on what was said of it) but never CONSUMES the offer: a reply
  // cut short before its disclosure re-arms the check for the next completed
  // turn (the clip-era I5 rule, kept for live mode).
  function closeGeneration({ complete }) {
    const heard = !(genOpen && genMuted);
    const firstAnswer = genOpen && genHadAudio && heard && !genIsCue && !firstAnswerTaken;
    if (firstAnswer && complete) firstAnswerTaken = true;
    genOpen = false;
    genHadAudio = false;
    genMuted = false;
    genIsCue = false;
    wordsSinceModelTurn = false;
    return { heard, firstAnswer };
  }

  return {
    /** One 20 ms caller frame. `voiceActive` is the VAD's sustained flag (defaults to `voiced`). */
    onCallerFrame(atMs, voiced, voiceActive = voiced) {
      if (ended) return;
      if (voiced) {
        lastVoicedAt = atMs;
        utteranceVoicedMs += cfg.frameMs;
      }
      if (voiceActive && !speaking) {
        speaking = true;
        anySpeech = true;
        if (!cueSent) cueCancelled = true;
      } else if (!voiceActive && speaking) {
        speaking = false;
        lastUtteranceVoicedMs = utteranceVoicedMs;
        utteranceVoicedMs = 0;
      } else if (!voiceActive && !speaking && !voiced) {
        // Between utterances: a stray voiced frame that never activated does
        // not carry into the next utterance's count.
        utteranceVoicedMs = 0;
      }
      maybeRelease(atMs);
    },

    /** A Live inputTranscription chunk. Words (any letter) count toward a hold release. */
    onCallerTranscript(text, atMs) {
      if (ended) return;
      if (typeof text === "string" && HAS_LETTER_RE.test(text)) wordsSinceModelTurn = true;
      maybeRelease(atMs);
    },

    /** Every model audio chunk. Returns whether to forward it to the caller. */
    onModelAudio(atMs) {
      openGeneration();
      genHadAudio = true;
      if (genMuted) return false;
      if (firstAudioAt === null && !ended) recordFirstAudio(atMs);
      else if (firstAudioAt === null) firstAudioAt = atMs;
      return true;
    },

    /** Model output text (outputTranscription) -- a text-first generation still opens here. */
    noteAssistantText() {
      openGeneration();
    },

    /** Any sign Live is alive before its first audio (a tool call): re-arms the unresponsive deadline. */
    noteLiveActivity(atMs) {
      lastLiveActivityAt = atMs;
    },

    /** @returns {{heard: boolean, firstAnswer: boolean}} */
    onTurnComplete() {
      return closeGeneration({ complete: true });
    },

    /** @returns {{heard: boolean, firstAnswer: boolean}} */
    onInterrupted() {
      return closeGeneration({ complete: false });
    },

    enterHold(atMs) {
      if (ended || holding) return;
      holding = true;
      holdSince = atMs;
      wordsSinceModelTurn = false;
      utteranceVoicedMs = 0;
      lastUtteranceVoicedMs = 0;
      bumpCounter("outbound_hold_entered");
      log1("info", "outbound_hold_entered", {});
    },

    tick(atMs) {
      if (ended) return;
      if (holding && atMs - holdSince >= cfg.holdMaxMs) {
        bumpCounter("outbound_hold_timeout");
        log1("info", "outbound_hold_timeout", { held_ms: Math.round(atMs - holdSince) });
        end("hold_timeout");
        return;
      }
      if (firstAudioAt !== null) return;
      if (!cueSent && !cueCancelled && atMs >= cueDueAt) {
        if (speakHello()) {
          cueSent = true;
          log1("info", "outbound_silence_hello", { cue_at_ms: Math.round(atMs - streamStartAtMs) });
        }
      }
      // Unresponsive: measured from the latest of the person's speech end, the
      // Hello's due time (when it was due and not cancelled), and any Live
      // activity. Never while they are still talking.
      if (speaking) return;
      let from = null;
      if (lastVoicedAt !== null && anySpeech) from = lastVoicedAt;
      if (!cueCancelled && atMs >= cueDueAt) from = Math.max(from ?? cueDueAt, cueDueAt);
      if (from === null) return;
      if (lastLiveActivityAt !== null) from = Math.max(from, lastLiveActivityAt);
      if (atMs - from >= cfg.unresponsiveMs) {
        bumpCounter("outbound_live_unresponsive");
        log1("error", "outbound_live_unresponsive", { waited_ms: Math.round(atMs - from), cue_sent: cueSent });
        end("live_unresponsive");
      }
    },

    forwardModelAudio() {
      return !holding && !genMuted;
    },

    onHold() {
      return holding;
    },

    /** True while the open generation is muted (started on hold and not released). */
    droppedThisGeneration() {
      return genOpen && genMuted;
    },

    firstReply() {
      return firstReply;
    },

    /**
     * §13.4 silent verdict, on the spec's end-of-speech reading (ruling R8).
     * @param {number} atMs - session end
     */
    sessionSilent(atMs) {
      const helloLimit = cfg.silenceHelloMs + cfg.helloToleranceMs;
      if (firstAudioAt !== null) {
        if (firstReply && firstReply.from_speech_end_ms !== null) return firstReply.from_speech_end_ms > cfg.slowReplyMs;
        return firstAudioAt - streamStartAtMs > helloLimit;
      }
      if (lastVoicedAt !== null && anySpeech) return atMs - lastVoicedAt > cfg.slowReplyMs;
      return atMs - streamStartAtMs > helloLimit;
    },

    onSessionEnd() {
      if (!firstReplyLogged) {
        firstReplyLogged = true;
        log1("info", "outbound_first_reply", { path: "none", from_speech_end_ms: null, from_answer_ms: null });
      }
      ended = true;
    },
  };
}
