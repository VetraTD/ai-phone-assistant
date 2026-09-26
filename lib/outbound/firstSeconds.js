// lib/outbound/firstSeconds.js
/**
 * The first seconds of an outbound call (spec §9.3, revised after spikes A
 * and B, owner-approved; owner decisions O-6..O-8 in Task 14 fix round 2).
 * Pure: no timers, no socket, no clock of its own. lib/voice/live/index.js
 * drives it from Twilio's 20 ms media frames -- NOT from audioOut's pump,
 * which stops when its queue is empty and would never fire the silence
 * backstop.
 *
 * THE RULE IS OFCOM'S, AND IT HAS TWO LIMBS: the person hears us within 2 s
 * of starting to speak, or within 2 s of pickup if they never speak. People
 * say "Hello?" 1.87-2.2 s after answering (the owner's two calls), so a line
 * played at pickup talks over them. So:
 *
 *   1. LISTEN FIRST. Nothing plays while the person is silent; their audio
 *      goes to Live from the first frame (index.js does that, as for inbound).
 *   2. THE PERSON SPEAKS. Speech onset is the VAD's SUSTAINED flag
 *      (inboundVad `voiceActive`, ~200 ms of unbroken voice), backdated to the
 *      start of that voiced run (O-6) -- a single loud frame (pickup handling
 *      noise) is not speech, and a real hello keeps its true start. If Live's
 *      audio arrives first, that is the path (`live_reply`). If none has
 *      arrived `slowLiveMs` after onset, the backstop plays (`backstop_slow`).
 *   3. NOBODY SPEAKS: at `silenceBackstopMs` after pickup -- the stream start
 *      minus the measured answer->stream offset -- the backstop is queued
 *      (`backstop_silence`). A voiced run still unconfirmed at that moment
 *      defers it by at most ONSET_CONFIRM_DEFER_MS: confirmed -> step 2,
 *      died -> fire at once.
 *   4. THE BACKSTOP IS SHORT AND INTERRUPTIBLE. It is ordinary audio through
 *      the normal audioOut path, so the normal barge-in and the vendor
 *      `interrupted` handler stop it like any assistant audio. Nothing here
 *      protects it.
 *   5. IT IS SEEDED as Live's own turn (spike A's S1 shape, GO 6/6):
 *      - on the SILENCE path at once (Live is not generating);
 *      - on the SLOW path only when the clip's end mark echoes (O-8): a seed
 *        interrupts Live's in-progress generation, and that `interrupted`
 *        would clear our own clip. A slow-path clip cut before its end (a
 *        barge) is never seeded -- the person did not hear the whole line.
 *      Model audio produced while it plays is dropped until its end mark
 *      echoes, or the audio is cleared (a cleared mark never echoes), or,
 *      failing both, clip length + BACKSTOP_MARK_GRACE_MS after it began.
 *   6. FIRST-TURN CHECK (G3): the first assistant turn (or the backstop, when
 *      it played in full) must carry an AI disclosure and the business name.
 *      If not, Live is told once to say it now. A backstop CUT while playing
 *      does not count: the check re-arms for Live's next turn. Detect-and-
 *      correct: on Live a sentence cannot be blocked before it is spoken
 *      (live-removes-the-text-chokepoint).
 *   7. MEASURED AT PLAYOUT (O-7): `outbound_first_audio{from_answer_ms,
 *      from_speech_ms, path, measured}` is taken when a mark queued right
 *      before our first audio ECHOES -- i.e. when that audio started playing,
 *      on every path -- not when it was queued. With no echo by the end of the
 *      session, the queue-time values are logged with `measured: "enqueue"`,
 *      never silently in place of the other. The queue deadline itself is
 *      unchanged (pickup + 2.0 s).
 *
 * NO CLIP AT STREAM START: the stored clip is re-read once shortly before the
 * deadline, because on a voicemail attempt the render may still be finishing
 * when the person answers.
 *
 * NO CLIP (the render failed, or the call-time re-render refused it): the
 * silence path prompts Live to say the line itself (or, when there is no line
 * at all -- O-9, no first name and nothing usable left -- to introduce itself
 * with the disclosure); the slow path only logs, because Live is already
 * making a reply and a second instruction would race it. Either way
 * `outbound_backstop_missing` is logged and G2 is monitored on that call, not
 * guaranteed.
 */
import { AI_DISCLOSURE_RE, foldDottedAI } from "./campaignSchema.js";
import { log as defaultLog } from "../logger.js";

/** The mark queued behind the backstop clip. Its echo lifts the suppression. */
export const BACKSTOP_END_MARK = "outbound-backstop-end";

/**
 * The mark queued immediately BEFORE the first frame of our first audio, on
 * every path. Twilio echoes a mark once everything queued ahead of it has
 * played; nothing is ahead of this one, so its echo is when our first audio
 * started playing (plus the return trip, which errs late -- the safe side for
 * a compliance number). O-7.
 */
export const FIRST_AUDIO_MARK = "outbound-first-audio";

/**
 * Spec §9.3's numbers. answerToStreamMs is spike B's measured 319-334 ms
 * answer->stream offset, rounded up; the silence deadline is therefore 1,650 ms
 * after the stream starts (spike B fired at 1,500 and caught the owner's 1.87 s
 * hello by 36 ms).
 */
export const FIRST_SECONDS_DEFAULTS = Object.freeze({
  answerToStreamMs: 350,
  silenceBackstopMs: 2000,
  slowLiveMs: 1600,
});

/**
 * How long a voiced run that is still UNCONFIRMED when the silence deadline
 * arrives may hold the backstop back (O-6): the VAD confirms a run after about
 * 200 ms of unbroken voice, so a hello that started just before the deadline
 * gets that long to prove itself.
 */
export const ONSET_CONFIRM_DEFER_MS = 200;

/**
 * After the clip's own length, how long the suppression waits for the
 * backstop's end mark before lifting anyway (fix round 1, M9). A mark that
 * never echoes -- a Twilio hiccup, a dropped event -- must not mute Live for
 * the rest of the call.
 */
export const BACKSTOP_MARK_GRACE_MS = 1500;

/**
 * No clip at stream start (the render was still running when the person
 * picked up): the stored opener is re-read ONCE, this long before the backstop
 * deadline, so the answer is in hand by the time it fires and the read never
 * delays the backstop itself (fix round 1, I4). A read still outstanding at the
 * deadline counts as a miss: the prompt path.
 */
export const BACKSTOP_REFETCH_LEAD_MS = 400;

/** 8 kHz mu-law: one byte per sample. */
const MULAW_BYTES_PER_MS = 8;

const isClip = (buf) => Buffer.isBuffer(buf) && buf.length > 0;

/** Lower-cased, whitespace-collapsed, for a name match that survives transcription casing. */
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Does this turn carry the §7 disclosure AND the business name?
 *
 * Dotted spellings ("an A.I. assistant", "A. I.") are folded to "AI" first:
 * a transcript that writes the letters out still said them (fix round 1, M3).
 * The fold is campaignSchema.js's foldDottedAI, shared with liveRender.js.
 *
 * @param {string} text
 * @param {string} businessName
 */
export function firstTurnComplete(text, businessName) {
  // Only a TRUE dotted acronym -- the dot after the I is required -- so "Plan
  // A. I wanted…" is two words, not a disclosure (fix round 3).
  const t = foldDottedAI(text);
  if (!AI_DISCLOSURE_RE.test(t)) return false;
  const name = norm(businessName);
  return name.length > 0 && norm(t).includes(name);
}

/**
 * @param {object} o
 * @param {() => number} [o.now] - the session clock; used when onModelAudio/onMark/onSessionEnd are given no time
 * @param {Buffer|null} o.backstopAudio - 8 kHz mu-law; null/empty = no clip
 * @param {string|null} o.backstopText - the rendered opener, what the clip says; null = no usable line (O-9)
 * @param {{enqueue: (buf: Buffer) => void}} o.audioOut - the NORMAL audio path
 * @param {(name: string) => void} o.sendMark
 * @param {(text: string) => void} o.seed - S1: a lone role:"model" turn, turnComplete:false
 * @param {(text: string) => void} o.noteToModel - the first-turn correction
 * @param {(text: string) => void} [o.promptModel] - the no-clip silence line; defaults to noteToModel
 * @param {(text: string, atMs: number) => void} [o.noteSpoken] - echoGuard.noteSpoken
 * @param {() => Promise<Buffer|null>} [o.refetchBackstopAudio] - one late read of the stored clip, when there was none at stream start
 * @param {number} [o.refetchLeadMs]
 * @param {number} [o.markGraceMs]
 * @param {number} [o.onsetConfirmDeferMs]
 * @param {number} o.streamStartAtMs
 * @param {number} [o.answerToStreamMs]
 * @param {number} [o.silenceBackstopMs]
 * @param {number} [o.slowLiveMs]
 * @param {string} [o.businessName]
 * @param {string} [o.personaName]
 * @param {object} [o.log]
 * @param {object} [o.logFields] - ids only (callSid, attemptId), on every log line
 */
export function createFirstSecondsController({
  now = () => 0,
  backstopAudio,
  backstopText,
  audioOut,
  sendMark,
  seed,
  noteToModel,
  promptModel,
  noteSpoken = () => {},
  refetchBackstopAudio = null,
  refetchLeadMs = BACKSTOP_REFETCH_LEAD_MS,
  markGraceMs = BACKSTOP_MARK_GRACE_MS,
  onsetConfirmDeferMs = ONSET_CONFIRM_DEFER_MS,
  streamStartAtMs,
  answerToStreamMs = FIRST_SECONDS_DEFAULTS.answerToStreamMs,
  silenceBackstopMs = FIRST_SECONDS_DEFAULTS.silenceBackstopMs,
  slowLiveMs = FIRST_SECONDS_DEFAULTS.slowLiveMs,
  businessName = "",
  personaName = "",
  log = defaultLog,
  logFields = {},
}) {
  const prompt = promptModel ?? noteToModel;
  // "2,000 ms after pickup", on the stream clock.
  const silenceDeadline = streamStartAtMs + (silenceBackstopMs - answerToStreamMs);
  const lineText = typeof backstopText === "string" && backstopText.trim() ? backstopText : null;

  /** The clip to play: the one stored at stream start, or one the late re-read found. Never without its text. */
  let clip = lineText && isClip(backstopAudio) ? backstopAudio : null;
  let clipSource = clip ? "stored" : null;
  /** "idle" -> "pending" -> "done". Once per call. */
  let refetch = "idle";
  /** Confirmed speech onset (backdated to its run's start), or null. */
  let onsetAt = null;
  /** Start of the current voiced run the VAD has not confirmed yet, or null. */
  let runStart = null;
  /** When the silence deadline was first held back for an unconfirmed run. */
  let deferredFrom = null;
  /** Our first audio was QUEUED: {atMs, path}. */
  let queued = null;
  /** ...and started PLAYING (the first-audio mark echoed): the metrics, measured:"playout". */
  let played = null;
  let firstAudioLogged = false;
  let backstopFired = false;
  /** The no-clip silence path: Live was asked to say the line, and its audio is the backstop. */
  let promptedPath = null;
  let suppressing = false;
  /** When the suppression lifts even if the end mark never echoes (M9). */
  let suppressUntil = null;
  let suppressFrom = null;
  /** O-8: a slow-path clip seeds when its end mark echoes, not when it fires. */
  let slowSeedPending = false;
  let turnChecked = false;
  /**
   * Model audio was dropped since the last turn text arrived. That turn was
   * not heard (or not all of it), so its text cannot satisfy the first-turn
   * check -- the case being a barge that re-arms the check (I1) while Live's
   * suppressed reply is still to report its text.
   */
  let droppedSinceTurnText = false;

  function metrics(atMs, path, measured) {
    return {
      from_answer_ms: Math.round(atMs - streamStartAtMs + answerToStreamMs),
      from_speech_ms: onsetAt === null ? null : Math.round(atMs - onsetAt),
      path,
      measured,
    };
  }

  /**
   * Our first audio is about to be queued: the playout mark goes FIRST, so
   * nothing but it precedes the audio on the wire.
   */
  function recordQueued(atMs, path) {
    if (queued) return;
    queued = { atMs, path };
    sendMark(FIRST_AUDIO_MARK);
  }

  function liftSuppression() {
    suppressing = false;
    suppressUntil = null;
  }

  /** M9: a mark that never echoes lifts the suppression on a clock, logged. */
  function checkSuppressionTimeout(atMs) {
    if (!suppressing || suppressUntil === null || atMs < suppressUntil) return;
    // A slow-path seed waiting on that mark is dropped, not sent late: Live
    // may be mid-reply by now, and a seed would interrupt it.
    log.error("outbound_backstop_mark_timeout", { ...logFields, waited_ms: Math.round(atMs - suppressFrom), seed_dropped: slowSeedPending });
    slowSeedPending = false;
    liftSuppression();
  }

  /** I4: one scoped read of a clip stored after the stream started. Never throws, never waits. */
  function startRefetch() {
    refetch = "pending";
    let read;
    try {
      read = Promise.resolve(refetchBackstopAudio());
    } catch (err) {
      read = Promise.reject(err);
    }
    read
      .then(
        (buf) => {
          if (!backstopFired && !clip && lineText && isClip(buf)) {
            clip = buf;
            clipSource = "refetched";
          }
        },
        () => {}
      )
      .finally(() => {
        refetch = "done";
      });
  }

  function checkFirstTurn(text) {
    if (turnChecked) return;
    if (!String(text || "").trim()) return; // a tool round with no speech is not a turn
    turnChecked = true;
    if (firstTurnComplete(text, businessName)) return;
    log.error("outbound_first_turn_incomplete", { ...logFields });
    noteToModel(`Tell them now, briefly: you are ${personaName}, an AI assistant from ${businessName}.`);
  }

  function fireBackstop(atMs, path) {
    backstopFired = true;
    // Reported ONLY when this fire really was held back by an unconfirmed run
    // (O-6). A run that confirmed cleared it (fix round 3): a later slow-path
    // fire must not carry the deferral of a deadline it never used.
    const deferral = deferredFrom === null ? {} : { deferred_ms: Math.round(atMs - deferredFrom) };
    if (!clip) {
      // `refetch` says whether a late read was tried and whether it was still
      // out at the deadline ("pending" = too slow, treated as a miss).
      log.error("outbound_backstop_missing", { ...logFields, path, refetch, line: lineText ? "yes" : "none", ...deferral });
      if (path === "backstop_silence") {
        promptedPath = path;
        prompt(
          lineText
            ? `The person hasn't spoken. Say: ${lineText}`
            : `The person hasn't spoken. Say briefly, in your own words, that you are ${personaName}, an AI assistant from ${businessName}.`
        );
      }
      return;
    }
    recordQueued(atMs, path);
    // Ordinary audio, the buffer alone: the normal barge-in stops it.
    audioOut.enqueue(clip);
    sendMark(BACKSTOP_END_MARK);
    suppressing = true;
    suppressFrom = atMs;
    suppressUntil = atMs + Math.ceil(clip.length / MULAW_BYTES_PER_MS) + markGraceMs;
    noteSpoken(lineText, atMs);
    if (path === "backstop_slow") slowSeedPending = true;
    else seed(lineText);
    log.info("outbound_backstop_played", {
      ...logFields,
      path,
      source: clipSource,
      seed: path === "backstop_slow" ? "at_end_mark" : "at_fire",
      ...deferral,
    });
    // The backstop IS the first turn when it plays -- unless it is cut before
    // it finishes, which re-arms the check (onAudioCleared).
    checkFirstTurn(lineText);
  }

  function logFirstAudio(m) {
    if (firstAudioLogged) return;
    firstAudioLogged = true;
    log.info("outbound_first_audio", { ...logFields, ...m });
  }

  return {
    /**
     * Every inbound frame, ungated: the VAD's verdict. Onset is `voiceActive`
     * (the sustained flag), backdated to the start of the run it confirmed.
     */
    onCallerFrame({ voiced, voiceActive, atMs }) {
      if (onsetAt !== null || queued !== null || backstopFired) return;
      if (voiceActive) {
        onsetAt = runStart ?? atMs;
        runStart = null;
        // The run confirmed: any silence-deadline deferral is over and moot.
        deferredFrom = null;
        return;
      }
      if (voiced) {
        if (runStart === null) runStart = atMs;
      } else {
        runStart = null; // the VAD resets an unconfirmed streak on any quiet frame, and so does this
      }
    },

    /** Every inbound frame, after onCallerFrame: Twilio's 20 ms clock. */
    tick(atMs) {
      checkSuppressionTimeout(atMs);
      if (queued !== null || backstopFired) return;
      const slow = onsetAt !== null;
      const deadline = slow ? onsetAt + slowLiveMs : silenceDeadline;
      if (!clip && refetchBackstopAudio && refetch === "idle" && atMs >= deadline - refetchLeadMs) startRefetch();
      if (atMs < deadline) return;
      // O-6: a hello already under way but not yet confirmed holds the
      // silence backstop back, briefly. Confirmed -> the slow path's clock;
      // died -> runStart is null and this fires now.
      if (!slow && runStart !== null && atMs < silenceDeadline + onsetConfirmDeferMs) {
        if (deferredFrom === null) deferredFrom = silenceDeadline;
        return;
      }
      fireBackstop(atMs, slow ? "backstop_slow" : "backstop_silence");
    },

    /**
     * Model audio is about to be enqueued.
     * @returns {boolean} true to play it, false to drop it (the seeded backstop is playing)
     */
    onModelAudio(atMs = now()) {
      checkSuppressionTimeout(atMs);
      if (suppressing) {
        droppedSinceTurnText = true;
        return false;
      }
      recordQueued(atMs, promptedPath ?? "live_reply");
      return true;
    },

    /** A whole assistant turn's transcript (turnComplete, or cut by an interruption). */
    onAssistantTurnText(text) {
      const heard = !droppedSinceTurnText;
      droppedSinceTurnText = false;
      if (heard) checkFirstTurn(text);
    },

    /** Twilio echoed a mark. */
    onMark(name, atMs = now()) {
      if (name === FIRST_AUDIO_MARK) {
        if (queued && !played) {
          played = metrics(atMs, queued.path, "playout");
          logFirstAudio(played);
        }
        return;
      }
      if (name === BACKSTOP_END_MARK) {
        liftSuppression();
        // O-8: the slow-path clip played to its end; only now is Live told it
        // said the line.
        if (slowSeedPending) {
          slowSeedPending = false;
          seed(lineText);
        }
      }
    },

    /**
     * Our audio was cleared -- a local barge, the vendor's `interrupted`, any
     * clearAudio. The backstop's end mark went with the queue and will never
     * echo, so the suppression has to lift here.
     *
     * AND IF THE CLIP WAS STILL PLAYING, IT WAS CUT (fix round 1, I1): the
     * person may have heard "Hi, is that Sam?" and nothing of "It's Ava, an AI
     * assistant from …". The first-turn check is re-armed, so Live's NEXT turn
     * must carry the disclosure and the name or it is corrected -- and a
     * slow-path seed still waiting for the end mark is never sent (O-8).
     */
    onAudioCleared() {
      if (suppressing) {
        turnChecked = false;
        slowSeedPending = false;
      }
      liftSuppression();
    },

    /**
     * The session is ending. A first audio whose playout mark never echoed
     * (the person hung up first) is logged from its QUEUE time, flagged
     * `measured: "enqueue"` -- never passed off as a playout time.
     */
    onSessionEnd() {
      if (queued && !played) logFirstAudio(metrics(queued.atMs, queued.path, "enqueue"));
    },

    /**
     * @returns {{from_answer_ms: number, from_speech_ms: number|null, path: string, measured: "playout"|"enqueue"}|null}
     *   the playout measurement once the mark has echoed; until then (or if it
     *   never does) the queue-time values, flagged `measured: "enqueue"`
     */
    firstAudio() {
      if (played) return { ...played };
      return queued ? metrics(queued.atMs, queued.path, "enqueue") : null;
    },

    /** Test/diagnostic seams. */
    suppressing: () => suppressing,
    onsetAt: () => onsetAt,

    /**
     * Fix round 1, item 3: the raw inputs `detectors.js`'s `sessionEndSilent`
     * needs when `firstAudio()` could not confirm a real playout (nothing
     * queued, or an enqueue time whose mark never echoed). `streamStartAtMs`
     * and `answerToStreamMs` are this controller's own constants, closed
     * over at construction; exposed here rather than duplicated at the call
     * site.
     */
    rawState: () => ({ onsetAt, streamStartAtMs, answerToStreamMs }),
  };
}
