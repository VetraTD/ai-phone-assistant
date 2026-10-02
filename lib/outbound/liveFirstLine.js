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

import { CLIP_CONFIRM_WINDOW_MS, CLIP_CONFIRM_VOICED_FRAMES } from "./firstSeconds.js";

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
  /**
   * Speech is confirmed by the VAD's sustained flag OR by a COUNT of voiced
   * frames in a window -- the clip path's own rule (CLIP_CONFIRM_*, 11 in
   * 800 ms). Paid sim hold_transfer-1: a short, gappy "Reception?" (640 ms
   * voiced over 1,177 ms) never held voiceActive's 200 ms continuous run, so
   * the Hello cue went out over the reply. One loud frame still is not speech.
   */
  speechConfirmWindowMs: CLIP_CONFIRM_WINDOW_MS,
  speechConfirmFrames: CLIP_CONFIRM_VOICED_FRAMES,
  /** An utterance ends after this much time with no voiced frame (the VAD's own hangover). */
  utteranceGapMs: 300,
  /** On hold, an utterance continuously voiced longer than this is music, not a person (final review #5). */
  holdMusicMs: 8000,
});

const HAS_LETTER_RE = /\p{L}/u;

/**
 * @param {object} o
 * @param {number} o.streamStartAtMs
 * @param {() => boolean} o.speakHello - asks Live to say the Hello; false when it could not be sent (no session)
 * @param {(reason: string) => void} o.endCall
 * @param {{info: Function, error: Function}} o.log
 * @param {(name: string) => void} [o.bumpCounter]
 * @param {(fields: {midGeneration: boolean, droppedOnHold: number}) => void} [o.onRelease] - a person is back on the line after a hold
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

  // Caller speech. "Speech" = confirmed (voiceActive, or speechConfirmFrames
  // voiced frames in speechConfirmWindowMs); utterances end on a
  // utteranceGapMs gap. The speech-end TIME is the last voiced frame of
  // CONFIRMED speech (final review #1): a stray loud frame -- a click at
  // pickup, noise later -- never dates it (it would mark a call silent, or
  // hide a slow reply).
  let speaking = false;
  let anySpeech = false;
  let speechEndAt = null;
  let lastOnsetAt = null;
  let lastVoicedAt = null;
  let lastFrameAt = streamStartAtMs;
  let utteranceStartAt = null;
  let utteranceVoicedMs = 0;
  /** The last ENDED utterance: {voicedMs, durationMs}. */
  let lastUtterance = null;
  /** Voiced-frame times inside the last speechConfirmWindowMs (the count half of "speech"). */
  const recentVoiced = [];
  let lastLiveActivityAt = null;
  /** Final review #4: the person spoke after the Hello cue went out but before any AI audio. */
  let cueOvertaken = false;

  // Generations (one model turn each).
  let genOpen = false;
  let genOpenedAt = null;
  let genHadAudio = false;
  let genMuted = false; // never forwarded: opened on hold (not released for it), or the overtaken Hello
  let genIsCue = false;
  let firstAnswerTaken = false;

  // Hold.
  let holding = false;
  let holdSince = null;
  let wordsSinceModelTurn = false;
  /** Muted generations that ended while on hold -- the model said things nobody heard. */
  let droppedOnHold = 0;

  function log1(level, event, fields) {
    log[level](event, { ...logFields, ...fields });
  }

  function end(reason) {
    if (ended) return;
    ended = true;
    endCall(reason);
  }

  function openGeneration(atMs) {
    if (genOpen) return;
    genOpen = true;
    genOpenedAt = typeof atMs === "number" ? atMs : lastFrameAt;
    genHadAudio = false;
    genMuted = holding;
    // The first generation after the cue went out is the Hello's own -- unless
    // a reply was already playing, or the person spoke first (then this one
    // answers them). Never the first answer.
    genIsCue = cueSent && firstAudioAt === null && !cueOvertaken;
    // Gatekeeper call 2026-10-01 (input transcript lag p50 9,397 ms): Live
    // answering is itself the sign a person spoke -- release now rather than
    // wait seconds for the worded transcript. Only for speech that STARTED
    // since the hold began (never the "hold on" itself) and passes the same
    // music guards as the transcript path (releasable: <= holdMusicMs long,
    // >= holdReleaseVoicedMs voiced). Opened after that onset, so release()
    // takes the mid-generation path: this generation is heard from its start.
    if (holding && lastOnsetAt !== null && lastOnsetAt >= holdSince && (releasable(currentUtterance()) || releasable(lastUtterance))) {
      release(genOpenedAt);
    }
  }

  function release(atMs) {
    holding = false;
    // Flush a muted generation only if it opened after the person started
    // speaking -- Live answering THEM before its transcript of them landed.
    // One that opened earlier was talking to the hold music: it stays muted
    // to its end (final review, re-graded minor).
    const midGeneration = genOpen && genMuted && lastOnsetAt !== null && genOpenedAt >= lastOnsetAt;
    if (midGeneration) genMuted = false;
    // Final review #6: the person now on the line has heard nothing yet, so
    // the first heard turn after the release is judged for the disclosure again.
    firstAnswerTaken = false;
    bumpCounter("outbound_hold_released");
    log1("info", "outbound_hold_released", {
      held_ms: Math.round(atMs - holdSince),
      mid_generation: midGeneration,
      dropped_generations: droppedOnHold,
    });
    onRelease({ midGeneration, droppedOnHold });
  }

  /** Utterances long enough to be hold MUSIC (energy VAD: music is "voiced") never release (final review #5). */
  function releasable(u) {
    return u !== null && u.durationMs <= cfg.holdMusicMs && u.voicedMs >= cfg.holdReleaseVoicedMs;
  }

  /** The utterance still in progress (no utteranceGapMs gap yet), or null. */
  function currentUtterance() {
    return utteranceStartAt === null ? null : { voicedMs: utteranceVoicedMs, durationMs: lastVoicedAt - utteranceStartAt + cfg.frameMs };
  }

  function maybeRelease(atMs) {
    if (!holding || !wordsSinceModelTurn) return;
    if (releasable(currentUtterance()) || releasable(lastUtterance)) release(atMs);
  }

  function recordFirstAudio(atMs) {
    firstAudioAt = atMs;
    const fromSpeechEnd = speechEndAt === null ? null : Math.max(0, Math.round(atMs - speechEndAt));
    firstReply = {
      path: cueSent && !cueOvertaken ? "silence_hello" : "speech",
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
    if (!heard && holding) droppedOnHold += 1;
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
      lastFrameAt = atMs;
      // An utterance ends after utteranceGapMs with no voiced frame -- gap
      // based, NOT voiceActive based: gappy real speech can voice 600 ms
      // without ever holding a 200 ms run, and a hold must still release.
      const quietFor = lastVoicedAt === null ? Infinity : atMs - lastVoicedAt;
      // Judged BEFORE this frame counts: a voiced frame after a gap (or after
      // a media gap with no frames at all) starts a new utterance.
      if (quietFor >= cfg.utteranceGapMs) {
        if (utteranceStartAt !== null) {
          lastUtterance = { voicedMs: utteranceVoicedMs, durationMs: lastVoicedAt - utteranceStartAt + cfg.frameMs };
          utteranceVoicedMs = 0;
          utteranceStartAt = null;
        }
        if (!voiceActive) speaking = false;
      }
      if (voiced) {
        if (utteranceStartAt === null) utteranceStartAt = atMs;
        lastVoicedAt = atMs;
        utteranceVoicedMs += cfg.frameMs;
        recentVoiced.push(atMs);
      }
      while (recentVoiced.length && atMs - recentVoiced[0] > cfg.speechConfirmWindowMs) recentVoiced.shift();
      const confirmed = voiceActive || recentVoiced.length >= cfg.speechConfirmFrames;
      if (confirmed && !speaking) {
        speaking = true;
        anySpeech = true;
        lastOnsetAt = atMs;
        if (!cueSent) {
          cueCancelled = true;
        } else if (firstAudioAt === null && !cueOvertaken) {
          // Final review #4 (spec §7: speech at 2.9 s cancels the Hello). The
          // cue already went out; if its generation has opened but not been
          // heard, it never will be -- the person gets exactly one turn, the
          // reply to what they said.
          cueOvertaken = true;
          if (genOpen && genIsCue) genMuted = true;
        }
      }
      if (speaking && voiced) speechEndAt = atMs;
      maybeRelease(atMs);
    },

    /**
     * A Live inputTranscription chunk. Words (any letter) count toward a hold
     * release -- on hold, only once the line has carried sound since the hold
     * began (final review #5: a late transcript of the "hold on" itself never
     * releases it).
     */
    onCallerTranscript(text, atMs) {
      if (ended) return;
      const freshSound = !holding || (lastVoicedAt !== null && lastVoicedAt >= holdSince);
      if (typeof text === "string" && HAS_LETTER_RE.test(text) && freshSound) wordsSinceModelTurn = true;
      maybeRelease(atMs);
    },

    /** Every model audio chunk. Returns whether to forward it to the caller. */
    onModelAudio(atMs) {
      openGeneration(atMs);
      genHadAudio = true;
      if (genMuted) return false;
      if (firstAudioAt === null && !ended) recordFirstAudio(atMs);
      else if (firstAudioAt === null) firstAudioAt = atMs;
      return true;
    },

    /** Model output text (outputTranscription) -- a text-first generation still opens here. */
    noteAssistantText(atMs) {
      openGeneration(atMs);
    },

    /** Did the person ever speak (confirmed speech, not a stray loud frame)? Gates the early-audio STT net. */
    heardSpeech() {
      return anySpeech;
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
      utteranceStartAt = null;
      lastUtterance = null;
      droppedOnHold = 0;
      bumpCounter("outbound_hold_entered");
      log1("info", "outbound_hold_entered", {});
    },

    tick(atMs) {
      if (ended) return;
      if (holding) {
        if (atMs - holdSince >= cfg.holdMaxMs) {
          bumpCounter("outbound_hold_timeout");
          log1("info", "outbound_hold_timeout", { held_ms: Math.round(atMs - holdSince) });
          end("hold_timeout");
        }
        // On hold nobody is waiting for us: no Hello, and no unresponsive end
        // (final review: a hold entered before any AI audio is not a dead Live).
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
      if (speechEndAt !== null) from = speechEndAt;
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
      if (speechEndAt !== null) return atMs - speechEndAt > cfg.slowReplyMs;
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
