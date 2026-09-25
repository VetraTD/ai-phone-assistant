// lib/outbound/firstSeconds.js
/**
 * The first seconds of an outbound call (spec §9.3, revised after spikes A
 * and B, owner-approved). Pure: no timers, no socket, no clock of its own.
 * lib/voice/live/index.js drives it from Twilio's 20 ms media frames -- NOT
 * from audioOut's pump, which stops when its queue is empty and would never
 * fire the silence backstop.
 *
 * THE RULE IS OFCOM'S, AND IT HAS TWO LIMBS: the person hears us within 2 s
 * of starting to speak, or within 2 s of pickup if they never speak. People
 * say "Hello?" 1.87-2.2 s after answering (the owner's two calls), so a line
 * played at pickup talks over them. So:
 *
 *   1. LISTEN FIRST. Nothing plays while the person is silent; their audio
 *      goes to Live from the first frame (index.js does that, as for inbound).
 *   2. THE PERSON SPEAKS: the first voiced frame is speech onset. If Live's
 *      audio arrives first, that is the path (`live_reply`). If none has
 *      arrived `slowLiveMs` after onset, the backstop plays (`backstop_slow`).
 *   3. NOBODY SPEAKS: at `silenceBackstopMs` after pickup -- the stream start
 *      minus the measured answer->stream offset -- the backstop plays
 *      (`backstop_silence`).
 *   4. THE BACKSTOP IS SHORT AND INTERRUPTIBLE. It is ordinary audio through
 *      the normal audioOut path, so the normal barge-in and the vendor
 *      `interrupted` handler stop it like any assistant audio. Nothing here
 *      protects it.
 *   5. IT IS SEEDED as Live's own turn (spike A's S1 shape, GO 6/6), and any
 *      model audio produced while it plays is dropped until its end mark
 *      echoes -- or until the audio is cleared, because a cleared mark never
 *      echoes and Live would otherwise stay muted for the rest of the call.
 *   6. FIRST-TURN CHECK (G3): the first assistant turn (or the backstop, when
 *      it played) must carry an AI disclosure and the business name. If not,
 *      Live is told once to say it now. Detect-and-correct: on Live a sentence
 *      cannot be blocked before it is spoken (live-removes-the-text-chokepoint).
 *
 * NO CLIP (the render failed, or the call-time re-render was over budget):
 * the silence path prompts Live to say the line itself; the slow path only
 * logs, because Live is already making a reply and a second instruction would
 * race it. Either way `outbound_backstop_missing` is logged and G2 is
 * monitored on that call, not guaranteed.
 */
import { AI_DISCLOSURE_RE } from "./campaignSchema.js";
import { log as defaultLog } from "../logger.js";

/** The mark queued behind the backstop clip. Its echo lifts the suppression. */
export const BACKSTOP_END_MARK = "outbound-backstop-end";

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

/** Lower-cased, whitespace-collapsed, for a name match that survives transcription casing. */
function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Does this turn carry the §7 disclosure AND the business name?
 * @param {string} text
 * @param {string} businessName
 */
export function firstTurnComplete(text, businessName) {
  const t = String(text || "");
  if (!AI_DISCLOSURE_RE.test(t)) return false;
  const name = norm(businessName);
  return name.length > 0 && norm(t).includes(name);
}

/**
 * @param {object} o
 * @param {() => number} [o.now] - the session clock; only used when onModelAudio is given no time
 * @param {Buffer|null} o.backstopAudio - 8 kHz mu-law; null/empty = no clip
 * @param {string} o.backstopText - the rendered opener, what the clip says
 * @param {{enqueue: (buf: Buffer) => void}} o.audioOut - the NORMAL audio path
 * @param {(name: string) => void} o.sendMark
 * @param {(text: string) => void} o.seed - S1: a lone role:"model" turn, turnComplete:false
 * @param {(text: string) => void} o.noteToModel - the first-turn correction
 * @param {(text: string) => void} [o.promptModel] - the no-clip silence line; defaults to noteToModel
 * @param {(text: string, atMs: number) => void} [o.noteSpoken] - echoGuard.noteSpoken
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
  const hasClip = Buffer.isBuffer(backstopAudio) && backstopAudio.length > 0;
  // "2,000 ms after pickup", on the stream clock.
  const silenceDeadline = streamStartAtMs + (silenceBackstopMs - answerToStreamMs);

  let onsetAt = null;
  let first = null;
  let backstopFired = false;
  /** The no-clip silence path: Live was asked to say the line, and its audio is the backstop. */
  let promptedPath = null;
  let suppressing = false;
  let turnChecked = false;

  function recordFirst(atMs, path) {
    if (first) return;
    first = {
      from_answer_ms: Math.round(atMs - streamStartAtMs + answerToStreamMs),
      from_speech_ms: onsetAt === null ? null : Math.round(atMs - onsetAt),
      path,
    };
    log.info("outbound_first_audio", { ...logFields, ...first });
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
    if (!hasClip) {
      log.error("outbound_backstop_missing", { ...logFields, path });
      if (path === "backstop_silence") {
        promptedPath = path;
        prompt(`The person hasn't spoken. Say: ${backstopText}`);
      }
      return;
    }
    // Ordinary audio, the buffer alone: the normal barge-in stops it.
    audioOut.enqueue(backstopAudio);
    sendMark(BACKSTOP_END_MARK);
    suppressing = true;
    noteSpoken(backstopText, atMs);
    seed(backstopText);
    recordFirst(atMs, path);
    log.info("outbound_backstop_played", { ...logFields, path });
    // The backstop IS the first turn when it plays.
    checkFirstTurn(backstopText);
  }

  return {
    /** Every inbound frame, ungated: the VAD's verdict. */
    onCallerFrame({ voiced, atMs }) {
      if (voiced && onsetAt === null && first === null && !backstopFired) onsetAt = atMs;
    },

    /** Every inbound frame, after onCallerFrame: Twilio's 20 ms clock. */
    tick(atMs) {
      if (first !== null || backstopFired) return;
      if (onsetAt === null) {
        if (atMs >= silenceDeadline) fireBackstop(atMs, "backstop_silence");
      } else if (atMs >= onsetAt + slowLiveMs) {
        fireBackstop(atMs, "backstop_slow");
      }
    },

    /**
     * Model audio is about to be enqueued.
     * @returns {boolean} true to play it, false to drop it (the seeded backstop is playing)
     */
    onModelAudio(atMs = now()) {
      if (suppressing) return false;
      recordFirst(atMs, promptedPath ?? "live_reply");
      return true;
    },

    /** A whole assistant turn's transcript (turnComplete, or cut by an interruption). */
    onAssistantTurnText(text) {
      checkFirstTurn(text);
    },

    /** Twilio echoed a mark. */
    onMark(name) {
      if (name === BACKSTOP_END_MARK) suppressing = false;
    },

    /**
     * Our audio was cleared -- a local barge, the vendor's `interrupted`, any
     * clearAudio. The backstop's end mark went with the queue and will never
     * echo, so the suppression has to lift here.
     */
    onAudioCleared() {
      suppressing = false;
    },

    /** @returns {{from_answer_ms: number, from_speech_ms: number|null, path: string}|null} */
    firstAudio() {
      return first ? { ...first } : null;
    },

    /** Test/diagnostic seam. */
    suppressing: () => suppressing,
  };
}
