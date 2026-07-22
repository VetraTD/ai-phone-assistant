import { performance } from "node:perf_hooks";
import * as geminiService from "../../services/gemini.js";
import { ACTION_TOOL_NAMES } from "../../services/gemini.js";
import { getPack as packForCapability } from "../../capabilities/index.js";
import * as db from "../../services/supabase.js";
import * as notifications from "../../services/notifications.js";
import * as googleTts from "../../services/googleTts.js";
import * as callState from "../callState.js";
import { STEPS } from "../callState.js";
import { log, createRequestId } from "../logger.js";
import { captureException } from "../sentry.js";
import { escapeXml } from "../twiml.js";
import {
  cleanTranscript,
  isIncomplete,
  extractFinalIntent,
  classifyHold,
} from "../transcriptUtils.js";
import { createTurnMetrics, bumpCounter } from "./metrics.js";
import { createSttStream } from "./sttStream.js";
import { runLlmTurn } from "./llmTurn.js";
import { createTtsTurn } from "./ttsStream.js";
import { createAudioOut } from "./audioOut.js";
import { createVad } from "./inboundVad.js";
import { createTurnManager } from "./turnManager.js";
import { createFallbackFlow } from "./fallbackFlow.js";
import { resolveGoogleVoice, resolveRingTone } from "./voiceLocale.js";
import { getStrings } from "./strings.js";
import { VOICE_CATALOG } from "../../config/voices.js";
import { toSpeakable } from "./speakableText.js";
import { createUtteranceCache } from "./utteranceCache.js";

// ---------------------------------------------------------------------------
// session.js — per-call orchestrator for the v2 real-time voice pipeline.
//
// Composes the reviewed building blocks (metrics, sttStream, llmTurn,
// ttsStream, audioOut, inboundVad, turnManager) into one real-time call
// handler. This is the DEFAULT pipeline (see server.js
// selectPipelineHandler); the legacy lib/mediaStream.js is only used when
// PIPELINE_V2=false, as a rollback escape hatch. Behavioral parity with
// mediaStream.js (greeting, silence nudges, transfer, max-duration hangup,
// transcript/history persistence, call completion) is preserved while the
// latency/turn-taking mechanics are replaced by the streaming pipeline.
// ---------------------------------------------------------------------------

// Default Google fallback voice when no per-call locale has been resolved
// yet (see lib/voice/voiceLocale.js resolveGoogleVoice — each call stores its
// locale-matched voice on state.googleVoice at "start").
const GOOGLE_TTS_VOICE = "en-US-Chirp3-HD-Aoede";
const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || "";
const CALL_MAX_DURATION_MS =
  (parseInt(process.env.CALL_MAX_DURATION_MINUTES, 10) || 30) * 60 * 1000;

// Must express transfer INTENT — identity questions like "are you a real
// person or a robot?" must NOT match; the LLM answers those honestly and the
// request_transfer tool covers phrasings this regex misses.
export const TRANSFER_TRIGGERS =
  /\b(representative|operator|manager|supervisor|speak to someone|talk to someone|talk to a (?:person|human)|speak (?:to|with) a (?:person|human)|transfer me|get me a (?:person|human))\b/i;

// Silence thresholds (ms after AI finishes speaking) — ported verbatim from
// lib/mediaStream.js so the caller experience is identical.
const SILENCE_THRESHOLDS = {
  greeting:        { nudge1:  6_000, nudge2: 12_000, hangup: 20_000 },
  identify_intent: { nudge1:  6_000, nudge2: 12_000, hangup: 20_000 },
  gather_details:  { nudge1: 10_000, nudge2: 18_000, hangup: 28_000 },
  confirm:         { nudge1:  8_000, nudge2: 15_000, hangup: 24_000 },
  ending:          { nudge1:  4_000, nudge2:  8_000, hangup: 12_000 },
};
const SILENCE_THRESHOLDS_DEFAULT = { nudge1: 8_000, nudge2: 15_000, hangup: 24_000 };
const SILENCE_RETRY_MS = 2_000;

// Upper bound on a whole hold CHAIN (see classifyHold in
// lib/transcriptUtils.js for the per-final durations). A caller who keeps
// trailing off ("and... and... and...") must still eventually reach the LLM,
// so once the chain has run this long the text is flushed regardless of how
// incomplete it still looks. 3s matches LiveKit's published `max_delay`.
//
// A 4.5s ceiling was tried and reverted — see the note in classifyHold
// (lib/transcriptUtils.js) for the live call that showed a longer wait buys
// nothing once the caller's gap exceeds it.
const MAX_TOTAL_HOLD_MS = 3_000;

// When a hold expires but the caller has been heard since it started, extend
// by this much rather than flushing — they aren't finished. Bounded by
// MAX_TOTAL_HOLD_MS above.
const HOLD_VAD_EXTENSION_MS = 500;

// How long a single caller-speech signal (Deepgram SpeechStarted, a non-empty
// interim, or a voiced VAD frame) suppresses the silence ladder for. Slightly
// longer than sttStream's utterance_end_ms (1000) so a caller pausing between
// words inside one utterance never lets the ladder slip through.
const CALLER_SPEECH_GRACE_MS = 2_000;

// Length of the amplitude ramp audioOut appends when a barge-in cuts the AI
// off (see lib/voice/audioOut.js clear()). Env-overridable there; this is the
// value session.js asks for.
const BARGE_FADE_MS = Number.parseInt(process.env.VOICE_BARGE_FADE_MS, 10) || 40;

// Absolute bound on continuous caller-speech suppression. Without it, a call
// left on a noisy line (TV, speakerphone in a cafe) would renew the grace
// window forever and never reach the nudge -> hangup ladder. Once suppression
// has deferred the ladder this long with no caller final arriving, the ladder
// runs anyway. CALL_MAX_DURATION_MS remains the outer backstop.
const MAX_SUPPRESSION_MS = 30_000;

// Fallback close delay if the expected -done playback mark never echoes back
// (e.g. audio failed mid-goodbye) — guarantees the call still ends. Re-armed
// while audio is still playing (see armCloseFallback), so it is a backstop
// for a missing mark, never a cap on how long a goodbye may run.
const CLOSE_FALLBACK_MS = 8_000;

// Absolute bound on the re-arming above, so a stuck playback estimate can
// still never hold a finished call open indefinitely.
const CLOSE_HARD_CEILING_MS = 45_000;

// Trailing silence after the goodbye finishes playing, before the line is
// actually dropped. Without it the hangup lands on the final syllable and
// reads as the call cutting out rather than ending.
const HANGUP_GRACE_MS = 800;

// Fixed caller-audible strings (max-duration goodbye, filler, nudges, error
// apologies, ...) live in lib/voice/strings.js, localized per the business's
// primary configured language — see getStrings().

// Once the LLM has failed this many times in a row (see handleTurnError),
// stop retrying it and drop into the deterministic no-LLM fallbackFlow
// (take-a-message script) so the caller is never stuck in an error loop.
const FALLBACK_FAILURE_THRESHOLD = 2;

// utteranceCache is keyed per synthesis backend/voice; the cache's
// synthesize function (below) is always Google TTS, at the per-call
// locale-resolved voice (state.googleVoice, defaulting to GOOGLE_TTS_VOICE)
// — the voice name itself is the cache key, so different businesses'
// locales never collide. See the module-level comment above utteranceCache
// for the ElevenLabs-vs-cache tradeoff.

// If a streamed LLM sentence-batch buffer grows past this with no sentence
// boundary in sight (a long run-on reply), flush at the last whitespace
// instead of waiting indefinitely — keeps TTS latency bounded.
const SENTENCE_BUFFER_SOFT_CAP = 200;

// ---------------------------------------------------------------------------
// Pre-cached micro-utterances (lib/voice/utteranceCache.js)
//
// One module-wide instance, shared by every call. synthesize is Google TTS
// (already the pipeline's non-ElevenLabs fallback voice/path — see
// playFiller below) rather than a per-business ElevenLabs voice: the two
// permitted ttsStream.js changes for this task are voiceSettings passthrough
// and forceFallback, not a new one-shot (non-streaming) ElevenLabs REST
// client, and reusing the streaming WS client for a single cached phrase
// isn't a good fit for that connection's per-turn lifecycle. Tradeoff: cached
// micro-utterances play in the Google fallback voice, not the business's
// chosen ElevenLabs voice — that mismatch already exists today for
// playFiller's on-demand synth, so this isn't a new inconsistency for
// *those* lines. It is NOT an acceptable tradeoff for the greeting though —
// the first thing a caller hears is the most identity-defining moment of the
// call, so the greeting is deliberately EXCLUDED from this cache (see the
// "start" handler: it always goes through the live per-business ttsTurn
// path, never speakTextCacheable/utteranceCache). Only short, mid-call lines
// (filler/nudges/goodbye) use the cache.
// ---------------------------------------------------------------------------
const utteranceCache = createUtteranceCache({
  synthesize: (text, voiceKey) => googleTts.synthesizeMulaw(text, voiceKey, null),
});

/**
 * Fixed micro-utterances worth pre-warming for a call's voice: the slow-LLM
 * filler and the silence-nudge/goodbye lines that don't depend on which step
 * the call is later in. (Stage-2 nudge text varies by step/intent — see
 * buildSilenceNudge — so only the step-only variants are warmed here; a
 * nudge for a less common intent-specific phrasing simply falls through to
 * live synthesis, same as before this feature.) Deliberately does NOT
 * include the greeting (see the module comment above utteranceCache) or any
 * text no code path ever get()s — every entry here must have a
 * corresponding speakTextCacheable()/get() call site, or it's dead
 * synthesis on every call start.
 */
function buildUtteranceWarmEntries(config) {
  const S = getStrings(config);
  const entries = [
    { kind: "filler", text: S.filler },
    { kind: "nudge-stage1", text: buildSilenceNudge(1, null, null, config) },
    { kind: "nudge-greeting", text: buildSilenceNudge(2, STEPS.GREETING, null, config) },
    { kind: "nudge-identify", text: buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, config) },
    { kind: "nudge-gather", text: buildSilenceNudge(2, STEPS.GATHER_DETAILS, null, config) },
    { kind: "nudge-confirm", text: buildSilenceNudge(2, STEPS.CONFIRM, null, config) },
    { kind: "nudge-default", text: buildSilenceNudge(2, "__default__", null, config) },
    { kind: "goodbye", text: buildSilenceGoodbye(config) },
  ];
  return entries.filter((e) => e.text);
}

/**
 * Split off any "complete" sentences from accumulated streamed LLM delta
 * text, holding back the trailing partial sentence. A sentence is "ready"
 * once a '.', '!', or '?' is followed by whitespace or end-of-buffer — this
 * keeps toSpeakable()'s transforms (phone-number grouping, "$5.50" -> "5
 * dollars 50", markdown stripping) from ever operating on a token an LLM
 * delta happened to split in the middle. If the buffer grows past
 * SENTENCE_BUFFER_SOFT_CAP with no boundary (a long run-on reply), flush at
 * the last whitespace instead, to keep speaking latency bounded.
 * @param {string} buf
 * @returns {{ready: string, rest: string}}
 */
function splitReadySentences(buf) {
  let boundary = -1;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const next = buf[i + 1];
      if (next === undefined || /\s/.test(next)) boundary = i + 1;
    }
  }
  if (boundary === -1 && buf.length > SENTENCE_BUFFER_SOFT_CAP) {
    const lastSpace = buf.lastIndexOf(" ");
    if (lastSpace > 0) boundary = lastSpace + 1;
  }
  if (boundary === -1) return { ready: "", rest: buf };
  return { ready: buf.slice(0, boundary), rest: buf.slice(boundary).replace(/^\s+/, "") };
}

// ---------------------------------------------------------------------------
// Shared helpers (pure)
// ---------------------------------------------------------------------------

function resolveTransferAllowed(config) {
  if (config.transferPolicy === "never") return false;
  if (config.transferPolicy === "always") return true;
  if (config.transferPolicy === "business_hours_only") {
    return geminiService.isBusinessOpen(config);
  }
  return true;
}

/**
 * Map a business's configured languages to a Deepgram nova-3 `language`
 * connect option. When more than one language is configured, use "multi"
 * (nova-3 code-switching) instead of picking just the first one — per
 * Deepgram's docs, nova-3 supports `language=multi` for automatic
 * per-utterance language detection across the call.
 * @param {object} config
 * @returns {string}
 */
export function mapLanguage(config) {
  if (Array.isArray(config?.languagesSpoken) && config.languagesSpoken.length > 1) {
    return "multi";
  }
  const first = Array.isArray(config?.languagesSpoken) && config.languagesSpoken[0];
  if (!first) return "en-US";
  if (first.includes("-")) return first;
  // Bare ISO codes map to what nova-3 actually accepts: blindly appending
  // "-US" produced invalid codes ("es" -> "es-US" is not a Deepgram
  // language), which silently broke single-language Spanish businesses.
  const NOVA3_LANGUAGE_MAP = { en: "en-US", es: "es", fr: "fr" };
  return NOVA3_LANGUAGE_MAP[first] || "en-US";
}

/**
 * Resolve which TTS backend/voice a call should use from the business's
 * loaded config (see services/supabase.js loadConfig -> voiceProvider/
 * voiceId, database/015_voice_settings.sql).
 *   - voice_provider="google": ElevenLabs is skipped entirely for this call
 *     (forceFallback=true) — every turn goes straight to the Google TTS
 *     fallback voice.
 *   - voice_provider="elevenlabs" (default): config.voiceId is used, falling
 *     back to ELEVENLABS_DEFAULT_VOICE_ID when unset. If that voice ID
 *     matches a config/voices.js VOICE_CATALOG entry, its curated
 *     voiceSettings are threaded through to ttsStream/elevenlabs.js.
 * @param {object} config
 * @returns {{voiceId: string, voiceSettings: object|undefined, forceFallback: boolean}}
 */
function resolveVoice(config) {
  if (config?.voiceProvider === "google") {
    return { voiceId: "", voiceSettings: undefined, forceFallback: true };
  }
  const voiceId = config?.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID || "";
  const catalogEntry = VOICE_CATALOG.find((v) => v.elevenVoiceId === voiceId);
  return { voiceId, voiceSettings: catalogEntry?.voiceSettings, forceFallback: false };
}

/**
 * Multilingual note (Part 4 base): when a business's primary/only language
 * isn't English (e.g. languagesSpoken: ["es"]), config.greeting is spoken
 * exactly as the owner wrote it (see `!config._hasCustomGreeting` below —
 * the auto-generated "Good morning/afternoon/evening" time-of-day prefix is
 * English-only and only gets prepended to the DEFAULT English greeting, so a
 * custom non-English greeting is never mixed with it). There is no
 * automatic translation of the greeting (or any other prompt copy) into the
 * caller's language — the owner is expected to write config.greeting in
 * whichever language(s) they want spoken. Auto-translating business-authored
 * copy is out of scope for this base multilingual pass; left as future work.
 */
function buildGreeting(config) {
  let text = "";
  if (config.recordingDisclosureEnabled) {
    text = (config.recordingDisclosureText ||
      "This call may be recorded for quality and training purposes.") + " ";
  }
  if (!config._hasCustomGreeting) {
    // The default greeting (services/supabase.js DEFAULT_GREETING) is a
    // generic "Hi, how can I help you today?" — prepending a time-of-day
    // word to it produced a double greeting ("Good afternoon! Hi, how can I
    // help you today?") with no business name. Synthesize one natural line
    // instead: time-of-day integrated, business name present, in the
    // business's primary language (lib/voice/strings.js).
    const S = getStrings(config);
    const tz = config.timezone || "America/Chicago";
    const hour = parseInt(
      new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).split(":")[0],
      10
    );
    const tod = hour < 12 ? S.todMorning : hour < 17 ? S.todAfternoon : S.todEvening;
    const businessName = config.businessName || "our office";
    text += S.greetingDefault(tod, businessName);
  } else {
    // Custom (owner-authored) greeting — played exactly as written, no
    // time-of-day prefix.
    text += config.greeting;
  }
  return text;
}

/** Stage-2 silence nudge text (ported from mediaStream.js), localized. */
function buildSilenceNudge(stage, step, intent, config) {
  const S = getStrings(config);
  if (stage === 1) {
    return S.nudge1;
  }
  switch (step) {
    case STEPS.IDENTIFY_INTENT:
    case STEPS.GREETING:
      return S.nudgeIdentify;
    case STEPS.GATHER_DETAILS:
      if (intent === "book_appointment") return S.nudgeGatherBooking;
      if (intent === "take_message" || intent === "callback_request") return S.nudgeGatherMessage;
      return S.nudgeGatherDefault;
    case STEPS.CONFIRM:
      return S.nudgeConfirm;
    default:
      return S.nudgeDefault;
  }
}

function buildSilenceGoodbye(cfg) {
  const S = getStrings(cfg);
  // The number to call back on is the business's OWN public line
  // (main_phone). It used to read transferPhoneNumber — the internal
  // forwarding target — so callers were told to ring whatever back-office or
  // answering-service number the transfer points at. The `cfg.phone` fallback
  // behind it was dead code: loadConfig has no such key, it's `mainPhone`.
  //
  // toSpeakable turns the stored E.164 form into digit groups a TTS engine
  // pronounces cleanly ("+18175803291" -> "817 580 3291"). Fixed strings like
  // this one never pass through the LLM path that normally applies it, so it
  // has to happen here or the number is read as one long mumble.
  const phone = cfg?.mainPhone || "";
  return phone ? S.goodbyeWithPhone(toSpeakable(phone)) : S.goodbyeNoPhone;
}

// ---------------------------------------------------------------------------
// Core: handle one incoming Media Streams WebSocket connection (v2 pipeline)
// ---------------------------------------------------------------------------

/**
 * Entry point wired from server.js for every Media Streams connection unless
 * PIPELINE_V2=false selects the legacy pipeline instead.
 * Manages the full lifecycle of one phone call over Media Streams using the
 * streaming STT -> LLM -> TTS pipeline.
 *
 * @param {import("ws").WebSocket} ws
 * @param {import("http").IncomingMessage} [req]
 */
export function handleVoiceSessionConnection(ws, _req) {
  let callSid = null;
  let state = null;

  // Building-block instances (created on `start`).
  let stt = null;
  let audioOut = null;
  let vad = null;
  let turnManager = null;

  // Per-turn mutable references.
  let activeTts = null;
  let activeGenerator = null;

  // Deterministic no-LLM take-message fallback (see handleTurnError). Once
  // set, this becomes the sole handler of caller finals for the rest of the
  // call — the LLM is never invoked again.
  let lastFallbackMark = null;

  // Timers.
  let silenceTimer = null;
  let silenceStage = 0;
  let callDurationTimer = null;
  let holdTimer = null;
  let closeFallbackTimer = null;
  let transferFallbackTimer = null;

  // Turn queueing (a caller final arriving while a turn's LLM is still in
  // flight but no audio is playing yet — barge-in is not appropriate).
  let queuedText = "";

  // Incomplete-final hold (mid-number / mid-date). `holdStartedAt` is the
  // perf-clock time the CURRENT hold chain began — a continuation that is
  // itself incomplete re-holds, so this bounds the whole chain (not each
  // link) against MAX_TOTAL_HOLD_MS.
  let heldText = "";
  let holdStartedAt = null;
  // Watermark for the extension check in onHoldExpired: the last time that
  // check ran, so each extension has to be earned by NEW speech rather than
  // by one sound heard earlier in the chain. Set when a hold chain starts.
  let lastHoldCheckAtMs = 0;

  // Caller-speech suppression of the silence ladder (see noteCallerSpeech).
  // `callerSpeakingUntil` is a perf-clock deadline; while now() is before it
  // the caller is treated as mid-utterance and the nudge ladder must not
  // fire. `suppressionStartedAt` bounds how long that may continue.
  let callerSpeakingUntil = 0;
  let suppressionStartedAt = null;
  // When the caller was last heard, ever. Unlike callerSpeakingUntil this is
  // NEVER cleared — see noteCallerSpeech / onHoldExpired for why the hold
  // needs a different question answered than the silence ladder does.
  let lastCallerSpeechAtMs = 0;

  // Background context (knowledge / integrations / callerContext) fetch.
  let contextLoaded = false;

  // Lazily-synthesized "one moment" filler buffer, cached per call.
  let fillerBuf = null;

  let cleaned = false;

  /**
   * Log fields shared by every line emitted while handling one caller turn.
   * `requestId` (lib/logger.js createRequestId, set at the top of startTurn)
   * lets one turn's lines be grouped in aggregated logs even when concurrent
   * calls interleave — parity with lib/mediaStream.js, which has stamped a
   * per-turn request id on its turn lines since before the v2 rebuild.
   * Omitted rather than emitted as null outside a turn (greeting, silence
   * nudges), so a line either carries a real correlation id or none at all.
   * @param {Record<string, unknown>} [extra]
   */
  function turnCtx(extra = {}) {
    return { callSid, ...(state?.requestId ? { requestId: state.requestId } : {}), ...extra };
  }

  // ------------------------------------------------------------------
  // Outbound speech
  // ------------------------------------------------------------------

  /**
   * Create a TTS turn wired into audioOut. For real caller-triggered turns
   * (isTurn=true) it records the tts_first_byte / first_audio_sent latency
   * marks; fixed utterances (greeting, nudges, error/goodbye lines) do not,
   * mirroring mediaStream.js's processingTurn guard.
   */
  function beginSpeaking(markName, isTurn) {
    const epoch = state.speakEpoch;
    let firstFrame = false;
    const { voiceId, voiceSettings, forceFallback } = resolveVoice(state.config);
    const tts = createTtsTurn({
      voiceId,
      voiceSettings,
      forceFallback,
      callSid,
      epoch,
      getEpoch: () => state.speakEpoch,
      googleFallbackVoice: state.googleVoice || GOOGLE_TTS_VOICE,
      onFirstAudio: () => {
        if (isTurn) state.turnMetrics?.mark("tts_first_byte");
      },
      onAudioChunk: (chunk) => {
        if (isTurn && !firstFrame) {
          firstFrame = true;
          state.turnMetrics?.mark("first_audio_sent");
        }
        audioOut?.enqueue(chunk);
      },
      onDone: ({ truncated } = {}) => {
        if (truncated) {
          log.error("tts_turn_truncated", { callSid, turnIndex: state.turnId, markName });
        }
        // Only emit the completion mark if this turn is still current; a
        // superseded (barged) turn must not re-arm silence or trigger a close.
        if (state.speakEpoch === epoch) audioOut?.sendMark(markName);
      },
      onError: (err) => {
        // Both ElevenLabs and the Google fallback failed for this utterance.
        log.error("tts_turn_failed", { callSid, markName, reason: err?.message });
        captureException(err, { callSid, context: "session.tts" });
        // Still emit the mark so downstream lifecycle (silence re-arm, or a
        // pending close for a goodbye line) is not stuck waiting forever.
        if (state.speakEpoch === epoch) audioOut?.sendMark(markName);
      },
    });
    return tts;
  }

  /** Speak a fixed string (greeting / nudge / error / goodbye). */
  function speakText(text, markName) {
    const tts = beginSpeaking(markName, false);
    activeTts = tts;
    tts.write(text);
    tts.end();
    return tts;
  }

  /**
   * Speak a fixed string, preferring a pre-cached buffer (see
   * lib/voice/utteranceCache.js) when one has already been warmed for this
   * exact text — zero-latency, no live TTS turn at all. Falls back to the
   * normal live speakText() path on a cache miss (or, for an ElevenLabs
   * business, unconditionally — see below). Used for every fixed
   * (non-LLM-streamed) utterance: greeting, silence nudges, goodbye lines.
   *
   * The cache's synthesize backend is always the Google fallback voice (see
   * the module comment above utteranceCache), so a cache hit only produces
   * the CORRECT voice when the business itself is Google-provider (every
   * other line in the call is already Google too, via resolveVoice's
   * forceFallback). For an ElevenLabs business, a cache hit would play this
   * line in the wrong voice — an audible mid-call flip — so the cache is
   * bypassed entirely and the line is spoken live through the same
   * per-business voice every other turn uses.
   */
  function speakTextCacheable(text, markName) {
    if (!resolveVoice(state.config).forceFallback) {
      return speakText(text, markName);
    }
    const cached = text ? utteranceCache.get(state.googleVoice || GOOGLE_TTS_VOICE, null, text) : null;
    if (!cached) return speakText(text, markName);

    // No live TTS turn for this utterance — nothing for onInterrupt to abort
    // (audioOut.clear() alone is enough to stop a barge-in mid-playback).
    activeTts = null;
    const epoch = state.speakEpoch;
    audioOut?.enqueue(cached);
    // Mirrors beginSpeaking's onDone: send the completion mark right after
    // handing the audio to audioOut (Twilio echoes it back once it has
    // actually finished playing everything queued before it) — same timing
    // semantics as the live path, just without waiting on TTS generation.
    if (state.speakEpoch === epoch) audioOut?.sendMark(markName);
    return null;
  }

  /**
   * Arm the backstop that force-closes the call if the goodbye's playback
   * mark never echoes back.
   *
   * It must never cut audio that is still playing. It used to be a flat
   * 8s timer started when the goodbye began speaking, which made it a hard
   * CAP on goodbye length rather than a safety net: the silence goodbye runs
   * 9.6s once it reads a phone number back, so the line was dropped ~1.6s
   * early, mid-sentence, and the mark never arrived at all. So when the
   * timer fires while audio is still in flight, re-arm instead of closing.
   * audioOut's playback estimate is wall-clock based and self-expiring, so
   * this cannot spin forever; CLOSE_HARD_CEILING_MS is a belt-and-braces
   * bound anyway.
   */
  function armCloseFallback(startedAt = Date.now()) {
    clearTimeout(closeFallbackTimer);
    closeFallbackTimer = setTimeout(() => {
      const waited = Date.now() - startedAt;
      if (audioOut?.isPlaying() && waited < CLOSE_HARD_CEILING_MS) {
        armCloseFallback(startedAt);
        return;
      }
      closeWs();
    }, CLOSE_FALLBACK_MS);
    closeFallbackTimer.unref?.();
  }

  /** Speak a fixed string, then close the call once its playback mark echoes. */
  function speakThenClose(text, markName) {
    state.step = STEPS.ENDING;
    state.closeAfterMark = markName;
    speakTextCacheable(text, markName);
    armCloseFallback();
  }

  function closeWs() {
    try {
      if (ws.readyState === 1) ws.close();
    } catch (err) {
      log.error("session_ws_close_failed", { callSid, reason: err?.message });
    }
  }

  /**
   * Speak a short "one moment" filler while the LLM is slow. For an
   * ElevenLabs business, write it straight into the turn's own (already
   * business-voiced) live TTS stream — activeTts at this point is the same
   * open stream the turn's actual reply text will follow, so the filler and
   * the reply play back-to-back in the same voice, no cache involved. Only
   * a Google-provider business (whose whole call already uses Google, see
   * resolveVoice) uses the pre-synthesized cache/fallback path.
   */
  async function playFiller() {
    const epoch = state.speakEpoch;
    if (!resolveVoice(state.config).forceFallback) {
      if (state.speakEpoch !== epoch || !activeTts) return;
      try {
        activeTts.write(getStrings(state.config).filler);
      } catch (err) {
        log.error("session_filler_failed", { callSid, reason: err?.message });
      }
      return;
    }
    try {
      const fillerText = getStrings(state.config).filler;
      const googleVoice = state.googleVoice || GOOGLE_TTS_VOICE;
      const cached = utteranceCache.get(googleVoice, "filler", fillerText);
      const buf = cached || fillerBuf || (fillerBuf = await googleTts.synthesizeMulaw(fillerText, googleVoice, callSid));
      if (state.speakEpoch !== epoch) return;
      audioOut?.enqueue(buf);
    } catch (err) {
      log.error("session_filler_failed", { callSid, reason: err?.message });
    }
  }

  // ------------------------------------------------------------------
  // Transcript persistence
  // ------------------------------------------------------------------

  function logCallerTranscript(text) {
    if (!state.dbCallId) return null;
    const seq = state.sequenceCounter;
    state.sequenceCounter += 2;
    db.addTranscriptEntry(state.dbCallId, "caller", text, seq).catch((err) =>
      log.error("transcript_write_failed", turnCtx({ speaker: "caller", reason: err?.message }))
    );
    return seq;
  }

  function logAiTranscript(text, callerSeq) {
    if (!state.dbCallId || callerSeq == null) return;
    db.addTranscriptEntry(state.dbCallId, "ai", text, callerSeq + 1).catch((err) =>
      log.error("transcript_write_failed", turnCtx({ speaker: "ai", reason: err?.message }))
    );
  }

  // ------------------------------------------------------------------
  // Background context
  // ------------------------------------------------------------------

  async function ensureContext() {
    if (contextLoaded) return;
    if (state.contextPromise) {
      try {
        await state.contextPromise;
      } catch (err) {
        log.error("context_load_failed", { callSid, reason: err?.message });
      }
    }
    contextLoaded = true;
  }

  function buildExtras(config) {
    return {
      knowledge: state.knowledge || [],
      transferAllowed: resolveTransferAllowed(config),
      integrations: state.integrations || [],
      businessId: state.businessId || null,
      callerPhone: state.callerNumber || null,
      callId: state.dbCallId || null,
      selectedAppointmentId: state.selectedAppointmentId || null,
      identityVerifiedApptId: state.identityVerifiedApptId || null,
      lastBookedAppointment: state.lastBookedAppointment || null,
      callerContext: state.callerContext || null,
      // Per-capability scratchpad carried across turns, so a capability can
      // remember what it already established with this caller without the
      // engine holding a named field for it.
      capabilityState: state.capabilityState || {},
    };
  }

  // ------------------------------------------------------------------
  // Silence handling
  // ------------------------------------------------------------------

  function clearSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  /**
   * Record that the caller is speaking RIGHT NOW, deferring the silence
   * ladder for CALLER_SPEECH_GRACE_MS.
   *
   * This is the fix for the ladder nudging (and eventually hanging up on) a
   * caller mid-monologue: before this, the only inputs to the ladder were
   * "is AI audio playing" and "is a turn processing", so a caller whose
   * request ran past nudge1 (6s in identify_intent) got interrupted by
   * "still there?" while still talking.
   *
   * `source` is one of:
   *   - "speech_started" — Deepgram vad_events SpeechStarted (fastest)
   *   - "interim"        — a non-empty interim transcript (strongest evidence)
   *   - "vad"            — a voiced frame from the local energy VAD
   *
   * ECHO GUARD: there is no acoustic echo cancellation in this pipeline, so
   * while AI audio is playing the "caller speech" the STT reports may be the
   * AI's own voice bleeding back. Callers must not stamp the window in that
   * case — see the call sites, which gate on !audioOut.isPlaying(). Nothing
   * is lost by ignoring them there, because armSilenceTimer already
   * retry-arms for the whole duration of AI playback.
   *
   * @param {"speech_started"|"interim"|"vad"} source
   */
  function noteCallerSpeech(source) {
    const now = Date.now();
    const wasSuppressing = now < callerSpeakingUntil;
    callerSpeakingUntil = now + CALLER_SPEECH_GRACE_MS;
    lastCallerSpeechAtMs = now;
    if (suppressionStartedAt === null) suppressionStartedAt = now;
    // One line per suppression EPISODE, not per frame — the VAD source fires
    // every 20ms and would otherwise drown the log.
    if (!wasSuppressing) {
      log.debug("caller_speech_started", { callSid, source });
    }
  }

  /** Clear the suppression window — the caller's utterance is over. */
  function endCallerSpeech() {
    callerSpeakingUntil = 0;
    suppressionStartedAt = null;
  }

  /**
   * One line per ladder check deferred by caller speech. Emitted from both
   * deferral sites — armSilenceTimer (the ladder never got scheduled) and
   * onSilence (it was scheduled and fired into a talking caller) — so the
   * two are distinguishable by `at` while reading the same log.
   * @param {"arm"|"fire"} at
   */
  function logSuppression(at) {
    bumpCounter("nudges_suppressed");
    log.debug("silence_suppressed", {
      callSid,
      at,
      stage: silenceStage,
      reason: "caller_speaking",
      suppressedForMs:
        suppressionStartedAt === null ? 0 : Math.round(Date.now() - suppressionStartedAt),
    });
  }

  /**
   * Is the caller mid-utterance, such that the silence ladder must hold off?
   * Returns false once suppression has run past MAX_SUPPRESSION_MS, so a
   * permanently noisy line still reaches the hangup ladder.
   * @returns {boolean}
   */
  function callerIsSpeaking() {
    const now = Date.now();
    if (now >= callerSpeakingUntil) return false;
    if (suppressionStartedAt !== null && now - suppressionStartedAt >= MAX_SUPPRESSION_MS) {
      log.info("silence_suppression_capped", {
        callSid,
        suppressedForMs: Math.round(now - suppressionStartedAt),
      });
      endCallerSpeech();
      return false;
    }
    return true;
  }

  function armSilenceTimer(reset = true) {
    clearSilenceTimer();
    if (reset) silenceStage = 0;
    if (!state || state.step === STEPS.ENDING) return;
    // While a turn is processing or AI audio is (estimated to be) still
    // playing, retry-arm instead of bailing out: audioOut.isPlaying() is an
    // ESTIMATE from enqueued byte counts, and Twilio can echo a -done mark
    // while the estimate still says "playing" — a bare return here would
    // orphan silence handling for the rest of the call (observed as ~30s of
    // dead air after the greeting).
    //
    // The caller-speaking check joins the same retry branch rather than
    // returning: the window self-expires, so re-checking every
    // SILENCE_RETRY_MS is what lets the ladder resume the moment they stop.
    if (state.processingTurn || audioOut?.isPlaying() || callerIsSpeaking()) {
      // Log the caller-speech case specifically. This branch used to be
      // silent, which meant the most common shape of the fix working — the
      // ladder never even getting scheduled while someone talks for 30
      // seconds — produced no evidence at all, only the absence of a nudge.
      if (callerIsSpeaking()) logSuppression("arm");
      silenceTimer = setTimeout(() => armSilenceTimer(false), SILENCE_RETRY_MS);
      silenceTimer.unref?.();
      return;
    }
    const step = state.step || STEPS.GREETING;
    const th = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    const delay =
      silenceStage === 0 ? th.nudge1 :
      silenceStage === 1 ? th.nudge2 - th.nudge1 :
      th.hangup - th.nudge2;
    log.debug("silence_armed", { callSid, stage: silenceStage, delayMs: delay, step });
    silenceTimer = setTimeout(onSilence, delay);
    silenceTimer.unref?.();
  }

  async function onSilence() {
    silenceTimer = null;
    if (!state || state.step === STEPS.ENDING) return;
    // Guard against firing while AI is speaking, a turn is being processed,
    // or the caller is mid-utterance. The last one is the load-bearing fix
    // for nudging over a talking caller: the ladder is armed from the AI's
    // playback mark, so without it a long request simply outran nudge1.
    if (audioOut?.isPlaying() || state.processingTurn || callerIsSpeaking()) {
      if (callerIsSpeaking()) logSuppression("fire");
      silenceTimer = setTimeout(onSilence, SILENCE_RETRY_MS);
      silenceTimer.unref?.();
      return;
    }

    // The deterministic take-message fallback owns silence handling once
    // active — routing into the generic step/intent nudge ladder below
    // would ask an incoherent "are you calling to book, leave a message, or
    // something else?" question mid-script. Feed the flow an empty input
    // instead: its own emptyStreak logic already does the right thing
    // (re-prompt once, then salvage what it has or give up), and its
    // resulting onSay -> speakText -> mark naturally re-arms this timer for
    // the next silence window (see the "mark" handler's non-nudge re-arm).
    if (state.fallbackFlow) {
      state.fallbackFlow.handleInput("");
      return;
    }

    const step = state.step || STEPS.GREETING;
    const th = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    silenceStage++;

    if (silenceStage === 1) {
      const text = buildSilenceNudge(1, step, state.intent, state.config);
      log.info("silence_nudge", { callSid, nudgeNumber: 1, step, intent: state.intent });
      bumpCounter("nudges_fired");
      speakTextCacheable(text, `nudge-1-${state.turnId}-done`);
      silenceTimer = setTimeout(onSilence, th.nudge2 - th.nudge1);
      silenceTimer.unref?.();
    } else if (silenceStage === 2) {
      const text = buildSilenceNudge(2, step, state.intent, state.config);
      log.info("silence_nudge", { callSid, nudgeNumber: 2, step, intent: state.intent });
      bumpCounter("nudges_fired");
      speakTextCacheable(text, `nudge-2-${state.turnId}-done`);
      silenceTimer = setTimeout(onSilence, th.hangup - th.nudge2);
      silenceTimer.unref?.();
    } else {
      log.info("silence_hangup", { callSid, step, intent: state.intent });
      bumpCounter("silence_hangups");
      speakThenClose(buildSilenceGoodbye(state.config), "silence-goodbye-done");
    }
  }

  // ------------------------------------------------------------------
  // Caller turn assembly (transcript quality pipeline + incomplete hold)
  // ------------------------------------------------------------------

  /** turnManager.onTurnEnd — the caller finished an utterance. */
  function handleCallerFinal(text) {
    if ((text || "").trim()) {
      state.sawCallerFinal = true;
      // When the caller actually stopped talking, in turnMetrics' clock
      // (performance.now()). startTurn stamps "speech_end" from this rather
      // than from its own entry, because a held final can reach startTurn
      // seconds later — and that wait is latency the caller experiences.
      // Stamping at startTurn made every hold invisible to the metric.
      state.lastFinalAtMs = performance.now();
    }
    // The utterance is over — stop suppressing the ladder. Every branch
    // below either starts a turn (which re-arms via its playback mark) or
    // calls armSilenceTimer itself, so the ladder resumes from a clean slate.
    endCallerSpeech();
    clearTimeout(holdTimer);
    holdTimer = null;
    const combined = heldText ? `${heldText} ${text}` : text;
    heldText = "";

    // Fallback active: route the raw final straight into the deterministic
    // script, bypassing cleanTranscript/isIncomplete entirely — those exist
    // to shape input for the LLM (e.g. dropping bare single-word utterances
    // like "yes"/"no" as noise), which would break the fallback script's
    // yes/no confirmation steps.
    //
    // Checked by TRUTHINESS, not .isActive(): once fallbackFlow is created it
    // must be the permanent handler for the rest of the call, even in the
    // brief window after the flow completes internally (flow.isActive()
    // already false) but before completeFallbackFlow's async DB write
    // resolves and sets state.step = ENDING. Routing on .isActive() alone
    // left that window able to fall through to startTurn -> runLlmTurn — a
    // final delivered right then would violate "never call the LLM again
    // once the fallback is active". flow.handleInput is a no-op once the
    // flow itself is inactive, so finals arriving after completion are
    // simply (and safely) dropped.
    if (state.fallbackFlow) {
      state.fallbackFlow.handleInput((combined || "").trim());
      return;
    }

    const clean = cleanTranscript(combined);
    if (!clean) {
      log.debug("transcript_discarded", { callSid, reason: "filler_only" });
      // Invariant: every path that ends caller-audio handling without
      // starting a turn must leave the silence timer armed. A barge-in
      // ("wait") clears the timer in onInterrupt expecting startTurn to
      // re-arm via its -done mark — if the final is then discarded here,
      // nothing else ever re-arms it and the call goes silent forever.
      //
      // Stage deliberately NOT reset: a caller emitting only "um" over and
      // over hasn't engaged, and must still escalate to the goodbye.
      armSilenceTimer(false);
      return;
    }

    // Real words — the caller is engaged, so the escalation ladder starts
    // over even if a nudge had already fired. (Contrast the filler-only
    // branch above, which preserves the stage.)
    silenceStage = 0;

    // A continuation that is ITSELF incomplete re-holds, so the ceiling has
    // to be applied to the elapsed chain here too — not just in
    // onHoldExpired — or "and... and... and..." would renew indefinitely.
    const elapsedHold = holdStartedAt === null ? 0 : Date.now() - holdStartedAt;
    const incomplete = isIncomplete(clean);
    const { holdMs: wantedHoldMs, rule } = incomplete
      ? classifyHold(clean)
      : { holdMs: 0, rule: "complete" };
    const holdMs = Math.min(wantedHoldMs, Math.max(0, MAX_TOTAL_HOLD_MS - elapsedHold));
    if (holdMs > 0) {
      heldText = clean;
      if (holdStartedAt === null) {
        holdStartedAt = Date.now();
        // Speech from before this hold must not count toward extending it.
        lastHoldCheckAtMs = holdStartedAt;
      }
      bumpCounter("holds_started");
      log.debug("transcript_held", {
        callSid,
        reason: "incomplete_utterance",
        holdMs,
        totalHeldMs: Math.round(elapsedHold),
        // Which rule fired, plus the tail it fired on. Every hold costs the
        // caller waiting time, so tuning is guesswork without knowing what
        // actually matched. Only the last few words are logged — enough to
        // judge the rule, short of recording what the caller said.
        rule,
        tail: clean.slice(-40),
      });
      startHoldTimer(holdMs);
      // Same invariant as the discard branch: if the hold flushes into a
      // turn, startTurn's mark re-arms; until then keep the ladder alive.
      armSilenceTimer(false);
      return;
    }
    holdStartedAt = null;
    startTurn(extractFinalIntent(clean));
  }

  function startHoldTimer(ms) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(onHoldExpired, ms);
    holdTimer.unref?.();
  }

  /**
   * A hold elapsed. If the caller is audibly still going (energy VAD), give
   * them more time rather than sending a half-sentence to the LLM — this is
   * the cheapest high-signal end-of-turn cue available without a dedicated
   * turn-detection model. Bounded by MAX_TOTAL_HOLD_MS so a caller who never
   * stops trailing off still gets a reply.
   */
  function onHoldExpired() {
    holdTimer = null;
    const elapsed = holdStartedAt === null ? 0 : Date.now() - holdStartedAt;
    // The question here is NOT the ladder's question.
    //
    // The ladder asks "is the caller talking right now?", and that answer is
    // deliberately cleared by onUtteranceEnd so a caller who genuinely stops
    // gets a prompt promptly. The hold has to ask something different:
    // "has the caller made any sound SINCE I started waiting?" — because
    // their continuation is what we're waiting for.
    //
    // Reusing the ladder's flag made the extension unfirable. Deepgram emits
    // UtteranceEnd after 1s of silence and the hold runs 2s, so the flag was
    // wiped roughly halfway through every hold, before it was ever read.
    // Observed live: speech at 21596ms, 140ms into a hold started at
    // 21456ms, and the hold still flushed at 23465ms. `holds_extended` was 0
    // across every test call. Two earlier attempts at this check — bare
    // vad.isActive(), then callerIsSpeaking() — both failed for this reason.
    //
    // lastCallerSpeechAtMs is never cleared, so it survives UtteranceEnd and
    // answers the right question.
    //
    // Compared against the PREVIOUS CHECK, not against holdStartedAt: neither
    // of those changes during a chain, so "spoke since the hold began" latches
    // true and every subsequent expiry extends on the strength of one old
    // sound. Observed live — a single signal at 14724ms produced extensions at
    // 16326, 16828 and 17341ms with nothing new in between, marching the hold
    // to its ceiling and costing 6.7s voice-to-voice. Each extension must earn
    // itself: one cough buys 500ms, not the whole budget.
    const spokeSinceLastCheck = lastCallerSpeechAtMs > lastHoldCheckAtMs;
    lastHoldCheckAtMs = Date.now();
    if (heldText && elapsed < MAX_TOTAL_HOLD_MS && spokeSinceLastCheck) {
      const extension = Math.min(HOLD_VAD_EXTENSION_MS, MAX_TOTAL_HOLD_MS - elapsed);
      bumpCounter("holds_extended");
      log.debug("hold_extended", {
        callSid,
        reason: "spoke_during_hold",
        totalHeldMs: Math.round(elapsed),
        extensionMs: Math.round(extension),
      });
      startHoldTimer(extension);
      return;
    }
    flushHeld({ cappedByCeiling: elapsed >= MAX_TOTAL_HOLD_MS });
  }

  function flushHeld({ cappedByCeiling = false } = {}) {
    holdTimer = null;
    const t = heldText;
    heldText = "";
    const totalHeldMs = holdStartedAt === null ? 0 : Math.round(Date.now() - holdStartedAt);
    holdStartedAt = null;
    if (!t) return;
    if (cappedByCeiling) bumpCounter("holds_capped");
    log.debug("hold_flushed", { callSid, totalHeldMs, cappedByCeiling });
    if (state.fallbackFlow) {
      state.fallbackFlow.handleInput(t);
      return;
    }
    startTurn(extractFinalIntent(t));
  }

  // ------------------------------------------------------------------
  // Barge-in
  // ------------------------------------------------------------------

  /** turnManager.onInterrupt — a real caller interruption during AI speech. */
  function onInterrupt(_text) {
    // Tapered stop, not a hard clear: audioOut drops the locally queued
    // remainder and ramps the few frames that were about to play down to
    // silence, so the AI trails off mid-thought the way a person does
    // instead of vanishing mid-syllable. See audioOut.clear's docstring.
    const cut = audioOut?.clear({ fadeMs: BARGE_FADE_MS });
    state.speakEpoch++; // suppress in-flight ttsTurn chunks + stale done marks
    if (activeTts) {
      try { activeTts.abort(); } catch (err) { log.error("session_tts_abort_failed", { callSid, reason: err?.message }); }
      activeTts = null;
    }
    if (activeGenerator) {
      try {
        Promise.resolve(activeGenerator.return?.()).catch(() => {});
      } catch (err) {
        log.error("session_llm_abort_failed", { callSid, reason: err?.message });
      }
      activeGenerator = null;
    }
    state.turnMetrics?.finishTurn({ barged_in: true });
    // Allow the following onTurnEnd -> handleCallerFinal -> startTurn to run.
    state.processingTurn = false;
    clearSilenceTimer();
    bumpCounter("barge_ins");
    log.debug("barge_in", {
      callSid,
      fadeMs: cut?.fadedMs ?? 0,
      droppedFrames: cut?.droppedFrames ?? 0,
    });
  }

  // ------------------------------------------------------------------
  // Transfer (regex escape-trigger, ported from mediaStream.js)
  // ------------------------------------------------------------------

  /**
   * @param {string} userText
   * @param {number} callerSeq
   * @param {{skipAnnouncement?: boolean, markName?: string|null}} [opts]
   *   - skipAnnouncement: the model already spoke its own transfer
   *     announcement this turn (request_transfer tool path) — don't re-speak
   *     the hardcoded "Transferring you now" line on top of it. Only applies
   *     when the transfer can actually proceed; if it can't, we still speak
   *     the "unable to transfer" apology regardless, so a caller told
   *     "transferring you now" isn't left hanging.
   *   - markName: that turn's own playback mark, so the skipAnnouncement path
   *     knows which audio has to drain before the redial.
   *
   * The redial itself is DEFERRED to the playback mark (see the "mark"
   * handler and runPendingTransfer): `client.calls().update({twiml: <Dial>})`
   * replaces the call's TwiML and tears the media stream down immediately, so
   * firing it before the announcement has played means the caller hears
   * silence — or, on the skipAnnouncement path, the model's own sentence cut
   * off mid-word. This mirrors the close-after-mark mechanism used for
   * goodbyes, with its own field because the outcome is a redial, not a
   * socket close. CLOSE_FALLBACK_MS is the backstop for a mark that never
   * echoes back.
   */
  async function doTransfer(userText, callerSeq, { skipAnnouncement = false, markName = null } = {}) {
    const config = state.config;
    const transferNumber = config.transferPhoneNumber || TRANSFER_NUMBER;
    const canTransfer = !!transferNumber && resolveTransferAllowed(config);
    log.info("transfer_requested", turnCtx({ canTransfer }));

    if (!canTransfer) {
      const msg = getStrings(config).transferUnavailable;
      logAiTranscript(msg, callerSeq);
      speakText(msg, `turn-${state.turnId}-done`);
      return;
    }

    state.step = STEPS.ENDING;

    // Which mark must finish playing before the redial?
    let waitMark = markName;
    if (!skipAnnouncement) {
      const msg = getStrings(config).transferring;
      logAiTranscript(msg, callerSeq);
      waitMark = "transfer-done";
      speakText(msg, waitMark);
    }

    if (!waitMark) {
      // Nothing to wait on (model spoke nothing and we have no mark) — redial
      // straight away rather than stalling for the full backstop.
      await redialForTransfer(transferNumber, "immediate");
      return;
    }

    state.transferAfterMark = waitMark;
    state.pendingTransferNumber = transferNumber;
    clearTimeout(transferFallbackTimer);
    transferFallbackTimer = setTimeout(() => {
      runPendingTransfer("fallback_timeout");
    }, CLOSE_FALLBACK_MS);
    transferFallbackTimer.unref?.();
  }

  /**
   * Fire the deferred redial exactly once, whether triggered by the playback
   * mark or by the CLOSE_FALLBACK_MS backstop.
   * @param {string} trigger - "mark" | "fallback_timeout"
   */
  function runPendingTransfer(trigger) {
    if (!state || !state.transferAfterMark) return; // already fired, or none pending
    state.transferAfterMark = null;
    clearTimeout(transferFallbackTimer);
    transferFallbackTimer = null;
    const number = state.pendingTransferNumber;
    state.pendingTransferNumber = null;
    if (!number) return;
    redialForTransfer(number, trigger).catch((err) => {
      log.error("transfer_flow_failed", { callSid, reason: err?.message });
      captureException(err, { callSid });
    });
  }

  /** Redial the live call into a <Dial> to the transfer number. */
  async function redialForTransfer(transferNumber, trigger) {
    try {
      const twilio = (await import("twilio")).default;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      // ringTone forces Twilio-generated ringback so the caller hears ringing
      // even when the downstream carrier supplies no early media; callerId
      // presents the original caller's number to the transfer target.
      const callerIdAttr = state?.callerNumber
        ? ` callerId="${escapeXml(state.callerNumber)}"`
        : "";
      await client.calls(callSid).update({
        twiml: `<Response><Dial ringTone="${state?.ringTone || "us"}"${callerIdAttr}>${escapeXml(transferNumber)}</Dial></Response>`,
      });
      log.info("transfer_outcome", turnCtx({ success: true, trigger }));
      db.markCallTransferred(callSid).catch((err) => {
        log.error("mark_call_transferred_failed", turnCtx({ message: err?.message }));
      });
    } catch (err) {
      log.error("transfer_outcome", turnCtx({ success: false, trigger, reason: err?.message }));
      captureException(err, { callSid });
    }
  }

  // ------------------------------------------------------------------
  // Deterministic no-LLM take-message fallback (session wiring)
  //
  // Entered once the LLM has failed FALLBACK_FAILURE_THRESHOLD times in a
  // row for this call (see handleTurnError). From that point on, every
  // caller final is routed straight to fallbackFlow.handleInput — the LLM
  // is never called again for this call, guaranteeing the caller can always
  // leave a message and hang up even if the model/API stays down.
  // ------------------------------------------------------------------

  function enterFallbackFlow() {
    if (state.fallbackFlow) return; // already active — idempotent
    log.info("fallback_flow_entered", { callSid, consecutiveFailures: state.consecutiveFailures });

    const flow = createFallbackFlow({
      businessName: state.config?.businessName || "our team",
      callerPhone: state.callerNumber || "",
      onSay: (text) => {
        state.turnId++;
        const markName = `fallback-${state.turnId}-done`;
        lastFallbackMark = markName;
        speakText(text, markName);
      },
      onComplete: (result) => completeFallbackFlow(result),
      onFail: () => failFallbackFlow(),
    });
    state.fallbackFlow = flow;
    flow.start();
  }

  async function completeFallbackFlow({ callerName, callbackNumber, message }) {
    log.info("fallback_flow_completed", { callSid });

    if (state.dbCallId) {
      const seq = state.sequenceCounter;
      state.sequenceCounter += 2;
      db.addTranscriptEntry(
        state.dbCallId,
        "caller",
        `[fallback message taken] name: ${callerName || "n/a"}; callback number: ${callbackNumber || "n/a"}; message: ${message}`,
        seq
      ).catch((err) => log.error("transcript_write_failed", { callSid, speaker: "caller", reason: err?.message }));
    }

    if (state.businessId) {
      try {
        const id = await db.createCustomerRequest({
          businessId: state.businessId,
          callId: state.dbCallId || null,
          requestType: "message",
          callerName: callerName || null,
          callbackNumber: callbackNumber || null,
          message: message || null,
        });
        if (id) {
          notifications.notifyCustomerRequest({
            businessId: state.businessId,
            customerRequest: {
              caller_name: callerName,
              callback_number: callbackNumber,
              message,
              request_type: "message",
            },
            call: { callerNumber: state.callerNumber },
          }).catch((err) => log.error("notify_request_failed", { callSid, reason: err?.message }));
          notifications.sendCallerSms(state.config, state.callerNumber, "message_received", {
            name_part: callerName ? ` ${callerName}` : "",
            business: state.config?.businessName,
            sla: notifications.MESSAGE_SLA_TEXT,
          }).catch((err) => log.error("sms_followup_failed", { callSid, kind: "message_received", reason: err?.message }));
        }
      } catch (err) {
        captureException(err, { callSid, context: "session.fallbackFlow.complete" });
      }
    }

    // Close only once the flow's own goodbye line has finished playing.
    state.step = STEPS.ENDING;
    state.closeAfterMark = lastFallbackMark;
    armCloseFallback();
  }

  function failFallbackFlow() {
    log.info("fallback_flow_failed", { callSid });
    speakThenClose(getStrings(state.config).fallbackFail, "fallback-fail-goodbye-done");
  }

  // ------------------------------------------------------------------
  // Main turn: caller text -> LLM stream -> TTS -> Twilio
  // ------------------------------------------------------------------

  async function startTurn(userText) {
    if (!state || !userText) return;

    // Deterministic fallback active — the LLM must never be called again
    // for this call. Belt-and-braces guard: normal callers are routed here
    // via handleCallerFinal/flushHeld, which already branch before reaching
    // startTurn, but any other path (e.g. the queuedText replay below) must
    // also respect this.
    if (state.fallbackFlow) {
      state.fallbackFlow.handleInput(userText);
      return;
    }

    // A turn is already in flight and not interrupted — queue this text.
    if (state.processingTurn) {
      queuedText = queuedText ? `${queuedText} ${userText}` : userText;
      log.debug("transcript_queued", turnCtx({ reason: "processing_in_flight" }));
      return;
    }

    // Hard call-duration limit.
    if (Date.now() - state.startedAt > CALL_MAX_DURATION_MS) {
      const seq = logCallerTranscript(userText);
      const maxDurationMsg = getStrings(state.config).maxDuration;
      logAiTranscript(maxDurationMsg, seq);
      speakThenClose(maxDurationMsg, "maxdur-goodbye-done");
      return;
    }

    // Already ending — just hang up.
    if (state.step === STEPS.ENDING) {
      closeWs();
      return;
    }

    state.processingTurn = true;
    // New correlation id for this turn — every log line below (and in
    // applyReply / handleTurnError / doTransfer) carries it via turnCtx().
    state.requestId = createRequestId();
    clearSilenceTimer();
    // Durable tool outcomes streamed from THIS turn's FC loop (see
    // recordDurableEffect); consumed by applyReply on a normal finish or by
    // salvageDurableEffects if the turn is barged / times out. Turn-local on
    // purpose: a successor turn started after a barge must never clobber or
    // inherit the dying turn's pending effects.
    const turnEffects = [];
    const myEpoch = state.speakEpoch;
    const metrics = state.turnMetrics;

    try {
      // Lazily resolve knowledge/integrations/callerContext on the first turn.
      await ensureContext();
      if (state.speakEpoch !== myEpoch) return; // barged during context load

      const config = state.config;

      // Persist the caller row now that dbCallId is guaranteed available.
      const callerSeq = logCallerTranscript(userText);

      // Escape-trigger transfer (before invoking the LLM), same as legacy.
      if (TRANSFER_TRIGGERS.test(userText)) {
        state.processingTurn = false;
        await doTransfer(userText, callerSeq);
        return;
      }

      // Marks recorded here (after the transfer escape check) for parity
      // with lib/mediaStream.js — a turn that escapes to transfer never
      // reaches finishTurn(), so marking earlier would leak "speech_end"/
      // "stt_final" timestamps into the next real turn's metrics payload.
      //
      // The two are deliberately NOT the same instant any more:
      //   speech_end — when the caller stopped talking (last STT final)
      //   stt_final  — when that text was released to the LLM
      // so stt_tail_ms is the time spent holding an unfinished sentence, and
      // voice_to_voice_ms counts the wait the caller actually experienced.
      // Previously both were stamped here, making stt_tail_ms a constant 0
      // and hiding multi-second holds from every latency number.
      metrics?.mark("speech_end", state.lastFinalAtMs);
      metrics?.mark("stt_final");

      state.turnId++;
      const turnId = state.turnId;
      const markName = `turn-${turnId}-done`;

      const tts = beginSpeaking(markName, true);
      activeTts = tts;

      metrics?.mark("llm_request");
      const gen = runLlmTurn({
        history: state.history,
        userText,
        step: state.step,
        intent: state.intent,
        config,
        extras: buildExtras(config),
      });
      activeGenerator = gen;

      let reply = null;
      let firstDelta = true;
      let producedText = false;
      // Sentence-batched (not per-delta) so toSpeakable()'s transforms
      // (phone-number grouping, "$5.50" -> "5 dollars 50", markdown
      // stripping, ...) always see a whole token — never a fragment an LLM
      // delta happened to split mid-transform. See splitReadySentences.
      let sentenceBuf = "";

      for await (const ev of gen) {
        if (state.speakEpoch !== myEpoch) break; // barged mid-stream
        if (ev.type === "delta") {
          if (firstDelta) {
            metrics?.mark("llm_first_chunk");
            firstDelta = false;
          }
          producedText = true;
          sentenceBuf += ev.text;
          const { ready, rest } = splitReadySentences(sentenceBuf);
          sentenceBuf = rest;
          if (ready) tts.write(toSpeakable(ready));
        } else if (ev.type === "slow") {
          if (!producedText) await playFiller();
        } else if (ev.type === "toolEffect") {
          recordDurableEffect(ev.effect, turnEffects);
        } else if (ev.type === "done") {
          reply = ev.reply;
        }
      }
      // Epoch check BEFORE touching shared refs: if we were barged, the
      // successor turn already owns activeGenerator/activeTts — nulling them
      // here would clobber it. The DB writes the barged turn already made
      // are still real — salvage them before bailing.
      if (state.speakEpoch !== myEpoch) {
        salvageDurableEffects(turnEffects, "barge_in");
        return;
      }
      activeGenerator = null;

      // Flush whatever's left in the sentence buffer (a final partial
      // sentence with no trailing punctuation, e.g. "...call us back!").
      if (sentenceBuf) {
        tts.write(toSpeakable(sentenceBuf));
        sentenceBuf = "";
      }

      tts.end();

      if (!reply) {
        // Generator ended without a done event (rare). tts.end() still drives
        // the completion mark; salvage any tool outcomes that did happen.
        salvageDurableEffects(turnEffects, "no_done_event");
        return;
      }

      // applyReply owns the effects from here — clear BEFORE applying so an
      // exception inside applyReply can't lead to a double-notify salvage.
      turnEffects.length = 0;
      applyReply(userText, reply, callerSeq, markName, producedText);
    } catch (err) {
      handleTurnError(err, myEpoch, turnEffects);
    } finally {
      // Only the still-current turn owns processingTurn; a superseded (barged)
      // turn must not clobber the successor's state.
      if (state && state.speakEpoch === myEpoch) {
        state.processingTurn = false;
        if (queuedText) {
          const q = queuedText;
          queuedText = "";
          startTurn(q);
        }
      }
    }
  }

  /**
   * Fire the owner notification + caller confirmation SMS for a successful
   * booking. Shared by applyReply (normal turn completion) and
   * salvageDurableEffects (barged/timed-out turn whose insert already
   * happened) — each turn's booking notifies exactly once, from whichever
   * path runs.
   */
  function notifyBooking(appointmentArgs) {
    if (!appointmentArgs || !state.businessId) return;
    const notes = [appointmentArgs.service_type, appointmentArgs.notes].filter(Boolean).join(" — ") || null;
    notifications.notifyAppointmentBooked({
      businessId: state.businessId,
      appointment: {
        scheduled_at: appointmentArgs.scheduled_at,
        client_name: appointmentArgs.client_name || null,
        client_phone: state.callerNumber || null,
        notes,
      },
      call: { callerNumber: state.callerNumber, twilioNumber: state.twilioNumber || null },
    }).catch((err) => log.error("notify_appointment_failed", turnCtx({ reason: err?.message })));
    notifications.sendCallerSms(state.config, state.callerNumber, "appointment_confirmation", {
      name: appointmentArgs.client_name || "there",
      business: state.config?.businessName,
      datetime: appointmentArgs.scheduled_at ? new Date(appointmentArgs.scheduled_at).toLocaleString() : "your requested time",
    }).catch((err) => log.error("sms_followup_failed", turnCtx({ kind: "appointment_confirmation", reason: err?.message })));
  }

  /**
   * Persist the idempotent state bits of one streamed tool outcome the
   * moment it happens (a later barge can't un-happen a DB write). Non-pure
   * effects (step transition, notifications, history note) wait for
   * applyReply or salvageDurableEffects.
   */
  /**
   * Merge a per-capability scratchpad patch into session state.
   *
   * Shallow per capability so two tools from the same capability in one turn
   * both contribute; a null value clears that capability's slot, which is how
   * an undo (a cancel invalidating a booking anchor) is expressed.
   */
  function mergeCapabilityState(patch) {
    if (!patch || !state) return;
    state.capabilityState = state.capabilityState || {};
    for (const [capability, value] of Object.entries(patch)) {
      if (value === null) {
        delete state.capabilityState[capability];
      } else {
        state.capabilityState[capability] = {
          ...(state.capabilityState[capability] || {}),
          ...value,
        };
      }
    }
  }

  /**
   * Hand a capability's deferred effects to the pack that owns them.
   *
   * This is the seam that lets a new capability cause a step transition, a
   * notification or a history note without an engine edit. The engine supplies
   * primitives and call context; it never learns what "booked" or "recorded"
   * means.
   *
   * History notes are collected rather than pushed per effect so several
   * effects in one turn produce a single bracketed system note, matching the
   * shape the model is told to trust in the TOOL CONTRACT prompt section.
   *
   * @param {Array<{capability: string, type: string, data?: object}>} effects
   * @returns {string[]} history notes the caller should emit
   */
  function dispatchCapabilityEffects(effects) {
    const notes = [];
    if (!Array.isArray(effects) || effects.length === 0 || !state) return notes;

    const engine = {
      setStep(nextStep, trigger) {
        state.step = nextStep;
        log.info("step_transition", turnCtx({ toStep: nextStep, trigger }));
      },
      addHistoryNote(note) {
        if (note) notes.push(note);
      },
      setCapabilityState(patch) {
        mergeCapabilityState(patch);
      },
      STEPS,
      // Read-only call context. A pack gets what it needs to notify, and
      // nothing that would let it reach into turn machinery.
      call: {
        businessId: state.businessId,
        callId: state.dbCallId || null,
        callerNumber: state.callerNumber,
        twilioNumber: state.twilioNumber || null,
        config: state.config,
      },
      deps: { notifications, db, log, captureException },
    };

    for (const effect of effects) {
      const pack = packForCapability(effect?.capability);
      if (!pack || typeof pack.onEffect !== "function") {
        log.warn("capability_effect_unhandled", turnCtx({
          capability: effect?.capability,
          type: effect?.type,
        }));
        continue;
      }
      try {
        pack.onEffect(effect, engine);
      } catch (err) {
        // One misbehaving capability must not take down the turn — the caller
        // is mid-call and the other effects still need applying.
        log.error("capability_effect_failed", turnCtx({
          capability: effect.capability,
          type: effect.type,
          reason: err?.message,
        }));
        captureException(err, { callSid });
      }
    }

    return notes;
  }

  function recordDurableEffect(effect, turnEffects) {
    if (!effect || !state) return;
    turnEffects?.push(effect);
    if (effect.capabilityState) mergeCapabilityState(effect.capabilityState);
    if (effect.identityVerifiedApptId) state.identityVerifiedApptId = effect.identityVerifiedApptId;
    if ("selectedAppointmentId" in effect && effect.selectedAppointmentId != null) {
      state.selectedAppointmentId = effect.selectedAppointmentId;
    }
    if (effect.success && effect.name === "book_appointment" && effect.appointmentArgs) {
      state.lastBookedAppointment = {
        scheduled_at: effect.appointmentArgs.scheduled_at,
        client_name: effect.appointmentArgs.client_name || null,
      };
    }
    if (effect.success && effect.name === "cancel_appointment_db") {
      state.selectedAppointmentId = null;
      state.lastBookedAppointment = null;
    }
  }

  /**
   * A turn died before applyReply (barge-in, LLM timeout/error, missing done
   * event) but its tools already ran — apply the outcomes that must survive:
   * step transition, booking notifications/SMS, and a history note so the
   * model remembers the action happened and never redoes it.
   */
  function salvageDurableEffects(turnEffects, trigger) {
    if (!state || !turnEffects?.length) return;
    const effects = turnEffects.slice();
    turnEffects.length = 0; // consume exactly once

    const notes = [];
    for (const e of effects) {
      if (!e.success) continue;
      if (e.name === "book_appointment" && e.appointmentArgs) {
        state.step = STEPS.CONFIRM;
        notifyBooking(e.appointmentArgs);
        const who = e.appointmentArgs.client_name ? ` for client ${e.appointmentArgs.client_name}` : "";
        notes.push(`book_appointment succeeded${who} at ${e.appointmentArgs.scheduled_at}. Do not book it again`);
      } else if (e.name === "cancel_appointment_db" || e.name === "reschedule_appointment_db") {
        state.step = STEPS.CONFIRM;
        notes.push(`${e.name} succeeded`);
      }
      // Capability-declared effects travel the same salvage path: a tool that
      // already wrote to a system of record must still notify and still leave
      // a history note when the caller barges over the confirmation sentence.
      notes.push(...dispatchCapabilityEffects(e.capabilityEffects));
    }
    if (notes.length > 0) {
      state.history.push({
        role: "user",
        parts: [{ text: `[system note — not the caller speaking: ${notes.join("; ")}.]` }],
      });
      log.info("turn_effects_salvaged", turnCtx({ trigger, count: notes.length }));
    }
  }

  /**
   * Apply the LLM final reply's state effects (ported from mediaStream.js).
   * @param {boolean} producedText - did the model stream any delta text this
   *   turn? Threaded into doTransfer to avoid double-speaking a transfer
   *   announcement when the model already said one.
   */
  function applyReply(userText, reply, callerSeq, markName, producedText) {
    // A successful LLM turn resets the failure streak so a transient blip
    // followed by a good turn doesn't leave the fallback threshold primed.
    state.consecutiveFailures = 0;

    const {
      text: replyText,
      appointmentArgs,
      intentArgs,
      endCallArgs,
      customerRequestArgs,
      toolResults,
      selectedAppointmentId,
      identityVerifiedApptId,
      transferRequested,
    } = reply;

    // Conversation history.
    state.history.push({ role: "user", parts: [{ text: userText }] });
    state.history.push({ role: "model", parts: [{ text: replyText }] });

    // Action-tool outcomes as a bracketed system note: tool calls/results are
    // NOT replayed into chat history (only text turns are), so without this
    // a later turn has no record that a booking/cancel already succeeded and
    // the model may redo or deny it. The TOOL CONTRACT prompt section marks
    // bracketed notes as trusted state, never caller speech.
    const actionNotes = (toolResults || [])
      .filter((tr) => tr.success && ACTION_TOOL_NAMES.includes(tr.name))
      .map((tr) => {
        if (tr.name === "book_appointment" && appointmentArgs?.scheduled_at) {
          const who = appointmentArgs.client_name ? ` for client ${appointmentArgs.client_name}` : "";
          return `book_appointment succeeded${who} at ${appointmentArgs.scheduled_at}. Do not book it again`;
        }
        return `${tr.name} succeeded`;
      });
    if (actionNotes.length > 0) {
      state.history.push({
        role: "user",
        parts: [{ text: `[system note — not the caller speaking: ${actionNotes.join("; ")}.]` }],
      });
    }

    if (toolResults?.length > 0) {
      for (const tr of toolResults) {
        log.info("tool_result", turnCtx({ tool: tr.name, success: tr.success }));
      }
    }
    if (selectedAppointmentId != null) state.selectedAppointmentId = selectedAppointmentId;
    if (identityVerifiedApptId != null) state.identityVerifiedApptId = identityVerifiedApptId;
    if (toolResults?.some((tr) => tr.name === "cancel_appointment_db" && tr.success)) {
      state.selectedAppointmentId = null;
      // The booking idempotency anchor must die with the appointment — a
      // cancel followed by "book me back in for that time" must perform a
      // REAL insert, not short-circuit to "already booked".
      state.lastBookedAppointment = null;
    }

    // A completed cancel/reschedule moves the call to CONFIRM — leaving the
    // step at GATHER_DETAILS re-injects the cancel-flow identity guidance
    // every turn, which is what sent the model in circles re-confirming an
    // already-verified caller.
    const completedChange = toolResults?.find(
      (tr) => (tr.name === "cancel_appointment_db" || tr.name === "reschedule_appointment_db") && tr.success
    );
    if (completedChange) {
      state.step = STEPS.CONFIRM;
      log.info("step_transition", turnCtx({ toStep: STEPS.CONFIRM, trigger: completedChange.name }));
    }

    if (intentArgs) {
      const prevStep = state.step;
      state.intent = intentArgs.intent;
      if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) {
        state.step = STEPS.GATHER_DETAILS;
      }
      log.info("intent_set", turnCtx({ intent: intentArgs.intent, prevStep, newStep: state.step }));
    }

    // Capability-declared effects. Dispatched AFTER intentArgs so a completed
    // action wins the step over an intent change in the same turn — the caller
    // did the thing, and the call should reflect that rather than dropping back
    // to gathering details.
    //
    // (The legacy named paths disagree on this: a completed cancel is applied
    // before intentArgs and therefore loses, while a completed booking is
    // applied after and wins. When those migrate onto this channel they adopt
    // the booking ordering, which is the intended one.)
    mergeCapabilityState(reply.capabilityState);
    const capabilityNotes = dispatchCapabilityEffects(reply.capabilityEffects);
    if (capabilityNotes.length > 0) {
      state.history.push({
        role: "user",
        parts: [{ text: `[system note — not the caller speaking: ${capabilityNotes.join("; ")}.]` }],
      });
    }

    if (appointmentArgs && state.businessId) {
      state.step = STEPS.CONFIRM;
      // Cross-turn idempotency anchor: book_appointment short-circuits to
      // success (no second insert, no second SMS) if the model re-books this
      // exact slot on a later turn.
      state.lastBookedAppointment = {
        scheduled_at: appointmentArgs.scheduled_at,
        client_name: appointmentArgs.client_name || null,
      };
      notifyBooking(appointmentArgs);
    }

    if (endCallArgs) {
      state.step = STEPS.ENDING;
      log.info("step_transition", turnCtx({ toStep: STEPS.ENDING, trigger: "end_call", reason: endCallArgs.reason }));
      // Close only after the goodbye audio has actually played out — the
      // turn's own completion mark is the trigger (see the mark handler).
      state.closeAfterMark = markName;
      armCloseFallback();
    }

    if (customerRequestArgs && state.businessId) {
      db.createCustomerRequest({
        businessId: state.businessId,
        callId: state.dbCallId || null,
        requestType: customerRequestArgs.request_type || "message",
        callerName: customerRequestArgs.caller_name || null,
        callbackNumber: customerRequestArgs.callback_number || null,
        message: customerRequestArgs.message || null,
        preferredTime: customerRequestArgs.preferred_time || null,
      }).then((id) => {
        if (id) {
          notifications.notifyCustomerRequest({
            businessId: state.businessId,
            customerRequest: customerRequestArgs,
            call: { callerNumber: state.callerNumber },
          }).catch((err) => log.error("notify_request_failed", { callSid, reason: err?.message }));
          notifications.sendCallerSms(state.config, state.callerNumber, "message_received", {
            name_part: customerRequestArgs.caller_name ? ` ${customerRequestArgs.caller_name}` : "",
            business: state.config?.businessName,
            sla: notifications.MESSAGE_SLA_TEXT,
          }).catch((err) => log.error("sms_followup_failed", { callSid, kind: "message_received", reason: err?.message }));
        }
      }).catch((err) => captureException(err, { callSid }));
    }

    logAiTranscript(replyText, callerSeq);

    // request_transfer tool call (language-agnostic fallback to the English
    // TRANSFER_TRIGGERS regex escape-hatch in startTurn). Reuses the same
    // doTransfer flow the regex path calls, so behavior (policy check,
    // Twilio redial) is identical either way — just triggered by the model
    // recognizing intent instead of pattern-matching English phrases. Not
    // awaited: applyReply is a synchronous tail call from startTurn, and
    // doTransfer manages its own speech/redial lifecycle independently.
    if (transferRequested) {
      doTransfer(userText, callerSeq, { skipAnnouncement: producedText, markName }).catch((err) => {
        log.error("transfer_flow_failed", turnCtx({ reason: err?.message }));
        captureException(err, { callSid });
      });
    }

    // Note: no legacy-shape recordTurnLatency(businessId, ms) call here (it
    // previously always passed a hardcoded 0 — pure noise in the per-business
    // rolling latency_stats window). finishTurn() already emits a structured
    // "turn_latency" log line (callSid, turnIndex, all marks, and the
    // voice_to_voice_ms / stt_tail_ms / llm_ttfb_ms / tts_ttfb_ms deltas) once
    // the turn's playback mark echoes back — see the "mark" event handler
    // below — which covers this turn's timing without a fabricated value.
    log.info("turn_completed", turnCtx({ step: state.step, intent: state.intent }));
  }

  function handleTurnError(err, myEpoch, turnEffects) {
    // The dying turn's tools may already have written to the DB (e.g. a
    // successful round-1 booking before a round-2 timeout) — persist those
    // outcomes regardless of who owns the pipeline now.
    salvageDurableEffects(turnEffects, err?.code === "LLM_TIMEOUT" ? "llm_timeout" : "llm_error");
    if (state.speakEpoch !== myEpoch) return; // barged — successor owns shared refs
    activeGenerator = null;

    // Close out this turn's metrics so its marks don't leak into the next.
    state.turnMetrics?.finishTurn({ error: true });
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;

    const isTimeout = err?.code === "LLM_TIMEOUT";
    log.error("llm_turn_error", turnCtx({
      code: isTimeout ? "llm_timeout" : "llm_error",
      message: err?.message,
      consecutiveFailures: state.consecutiveFailures,
    }));
    captureException(err, { callSid, context: "session.llmTurn" });

    // Abort any partial TTS for this turn.
    if (activeTts) {
      try { activeTts.abort(); } catch { /* noop */ }
      activeTts = null;
    }

    // Two (or more) LLM failures in a row for this call — stop retrying the
    // LLM and drop into the deterministic take-message script instead of
    // speaking another "could you repeat that?" apology.
    if (state.consecutiveFailures >= FALLBACK_FAILURE_THRESHOLD) {
      enterFallbackFlow();
      return;
    }

    const S = getStrings(state.config);
    const msg = isTimeout ? S.llmSlowApology : S.llmErrorApology;
    speakText(msg, `turn-${state.turnId}-error-done`);
  }

  // ------------------------------------------------------------------
  // STT setup + terminal failure handling
  // ------------------------------------------------------------------

  function startStt(language, endpointing) {
    createSttStream({
      language,
      ...(endpointing != null ? { endpointing } : {}),
      callSid,
      onFinal: (text) => turnManager?.handleFinal(text),
      onInterim: (text) => {
        // A non-empty interim is the strongest available evidence that the
        // caller is producing words right now — hold the silence ladder off.
        // Gated on !isPlaying because with no AEC the AI's own audio comes
        // back as interims; see noteCallerSpeech's echo-guard note.
        if ((text || "").trim() && !audioOut?.isPlaying()) noteCallerSpeech("interim");
        turnManager?.handleInterim(text);
      },
      onUtteranceEnd: () => {
        // The caller's utterance closed. Drop the suppression window
        // immediately rather than waiting out CALLER_SPEECH_GRACE_MS, so a
        // caller who genuinely goes quiet gets a timely nudge.
        endCallerSpeech();
      },
      onSpeechStarted: () => {
        if (!audioOut?.isPlaying()) noteCallerSpeech("speech_started");
      },
      onError: (err) => handleSttError(err),
      onReconnect: (attempt) => log.info("stt_reconnected", { callSid, attempt }),
    }).then((s) => {
      if (cleaned) { try { s.close(); } catch { /* noop */ } return; }
      stt = s;
    }).catch((err) => {
      log.error("stt_init_failed", { callSid, reason: err?.message });
      handleSttError(err);
    });
  }

  let sttFailed = false;
  function handleSttError(err) {
    if (sttFailed) return;
    sttFailed = true;
    log.error("stt_terminal_failure", { callSid, code: err?.code, reason: err?.message });
    captureException(err, { callSid, context: "session.stt" });
    // The call cannot continue deaf — apologize and end gracefully.
    speakThenClose(getStrings(state?.config).sttFailGoodbye, "stt-error-goodbye-done");
  }

  // ------------------------------------------------------------------
  // WebSocket event dispatch
  // ------------------------------------------------------------------

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        log.info("media_stream_connected", { pipeline: "v2" });
        break;

      case "start": {
        const startData = msg.start || {};
        callSid = startData.callSid;
        const streamSid = startData.streamSid;
        const customParams = startData.customParameters || {};
        const businessPhone = customParams.businessPhone || "";
        const callerPhone = customParams.callerPhone || "";

        log.info("media_stream_start", { callSid, streamSid, businessPhone, callerPhone, pipeline: "v2" });

        state = callState.getState(callSid);
        state.ws = ws;
        state.streamSid = streamSid;
        state.mediaStream = true;
        state.callerNumber = callerPhone;
        state.twilioNumber = businessPhone;
        if (!state.turnMetrics) state.turnMetrics = createTurnMetrics(callSid);

        // ---- Fast pickup: await ONLY lookup + loadConfig ----
        let business = null;
        if (db.isEnabled()) {
          business = await db.lookupBusinessByPhone(businessPhone);
          if (!business) log.error("no_business_found", { callSid, businessPhone, severity: "warn" });
        }
        state.config = db.loadConfig(business);
        if (!state.knowledge) state.knowledge = [];
        if (!state.integrations) state.integrations = [];
        const config = state.config;

        // Locale-matched fallback voice + transfer ringback tone — resolved
        // once per call so a US business never flips to a British Google
        // voice during an ElevenLabs outage (see lib/voice/voiceLocale.js).
        state.googleVoice = resolveGoogleVoice(config);
        state.ringTone = resolveRingTone(config);

        // ---- Background: createCall + knowledge/integrations/callerContext ----
        state.contextPromise = (async () => {
          if (!business || !db.isEnabled()) return;
          try {
            const dbId = await db.createCall(business.id, callSid, callerPhone, businessPhone);
            if (dbId) {
              state.dbCallId = dbId;
              state.businessId = business.id;
            }
            const [knowledge, integrations, callerContext] = await Promise.all([
              db.fetchBusinessKnowledge(business.id),
              db.listIntegrationsForBusiness(business.id, { enabledOnly: true }),
              callerPhone ? db.fetchCallerContext(business.id, callerPhone) : Promise.resolve(null),
            ]);
            state.knowledge = knowledge || [];
            state.integrations = integrations || [];
            state.callerContext = callerContext;
          } catch (err) {
            log.error("context_load_failed", { callSid, reason: err?.message });
          }
        })();
        // Never let an unawaited context promise surface as an unhandled
        // rejection (it already catches internally; this is belt-and-braces).
        state.contextPromise.catch(() => {});

        // ---- Build the outbound-audio + barge-in stack ----
        audioOut = createAudioOut({
          sendFrame: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
          streamSid,
        });
        vad = createVad();
        turnManager = createTurnManager({
          vad,
          audioOut,
          onInterrupt,
          onTurnEnd: handleCallerFinal,
          // Energy VAD is the fastest of the three caller-speech signals and
          // the only one that works before STT has produced any text at all.
          // Unlike the STT-derived signals it is NOT echo-gated here: the VAD
          // is what turnManager itself trusts to confirm barge-in, and
          // suppressing the ladder during AI playback is a no-op anyway
          // (armSilenceTimer already retry-arms for the whole playback).
          onVoiceActive: () => noteCallerSpeech("vad"),
        });

        // ---- Open STT in parallel with the greeting (do not block pickup) ----
        // Deepgram recommends endpointing=100 (vs. the default 300) for
        // multi-language code-switching — shorter silence gaps are more
        // meaningful when the model is also working harder per-utterance to
        // detect language.
        const sttLanguage = mapLanguage(config);
        startStt(sttLanguage, sttLanguage === "multi" ? 100 : undefined);

        // ---- Speak greeting immediately ----
        state.step = STEPS.IDENTIFY_INTENT;
        state.callStartTime = Date.now();
        log.info("call_started", {
          callSid,
          callerNumber: callerPhone,
          businessName: config.businessName || "Unknown",
          recordingDisclosure: config.recordingDisclosureEnabled ?? false,
          businessOpen: geminiService.isBusinessOpen(config),
        });
        // Always live, never cached: the greeting is the most
        // identity-defining moment of the call, and utteranceCache's
        // synthesize backend is the Google fallback voice, not the
        // business's chosen ElevenLabs voice (see the module comment above
        // utteranceCache) — a cache hit here would mean every caller after
        // the first hears the wrong voice for the greeting specifically.
        speakText(buildGreeting(config), "greeting-done");

        // ---- Background: warm this call's voice's micro-utterance cache
        // (filler/nudges/goodbye — NOT the greeting, see above) for later in
        // this call and for whichever call comes next — never awaited, never
        // blocks pickup.
        utteranceCache
          .warm(state.googleVoice || GOOGLE_TTS_VOICE, buildUtteranceWarmEntries(config))
          .catch((err) => log.error("utterance_cache_warm_failed", { callSid, reason: err?.message }));

        // ---- Hard call-duration limit ----
        callDurationTimer = setTimeout(() => {
          if (state.step === STEPS.ENDING) return;
          speakThenClose(getStrings(state.config).maxDuration, "maxdur-goodbye-done");
        }, CALL_MAX_DURATION_MS);
        callDurationTimer.unref?.();
        break;
      }

      case "media": {
        const payload = msg.media?.payload;
        if (!payload) break;
        const buf = Buffer.from(payload, "base64");
        if (stt) stt.sendAudio(buf);
        turnManager?.handleAudioFrame(buf);
        break;
      }

      case "mark": {
        const markName = msg.mark?.name || "";
        audioOut?.notifyMarkPlayed(markName);
        log.debug("playback_complete", turnCtx({ markName }));

        // Hoisted out of the branches below (each of which did this) so a
        // deferred transfer can break early without losing the turn metrics.
        //
        // Only close metrics on the mark belonging to the turn that is still
        // current. After a barge-in, audio already handed to Twilio keeps
        // playing, so the interrupted turn's mark echoes back once its
        // successor has started — and onInterrupt has already recorded that
        // turn as barged. Closing again on the stale mark emitted a junk row
        // (no LLM or TTS numbers) AND wiped the live turn's marks, so every
        // interruption corrupted two latency rows.
        const turnMark = /^turn-(\d+)-done$/.exec(markName);
        if (state && turnMark && Number(turnMark[1]) === state.turnId) {
          state.turnMetrics?.finishTurn();
        }

        // A deferred transfer redial takes priority over a deferred close:
        // if a turn somehow armed both, closing the socket would hang up on a
        // caller who was just told they're being transferred.
        if (state && markName && markName === state.transferAfterMark) {
          runPendingTransfer("mark");
          break;
        }

        if (state && markName && markName === state.closeAfterMark) {
          state.closeAfterMark = null;
          // Twilio echoes this mark the instant the final audio frame has
          // played, so hanging up right here clips the line the moment the
          // last syllable lands — the caller hears the goodbye and then an
          // abrupt dead drop. Let it breathe first. This is the single exit
          // for every ending (silence goodbye, end_call, max duration,
          // fallback failure), so one pause covers all of them. Reuses
          // closeFallbackTimer, which cleanup() already clears.
          clearTimeout(closeFallbackTimer);
          closeFallbackTimer = setTimeout(() => closeWs(), HANGUP_GRACE_MS);
          closeFallbackTimer.unref?.();
          break;
        }

        if (state && markName.endsWith("-done")) {
          // A nudge's own playback drives escalation via onSilence's timers;
          // re-arming here would reset the stage and break the escalation.
          if (!/^nudge-/.test(markName)) {
            armSilenceTimer(true);
          }
        }
        break;
      }

      case "stop": {
        log.info("media_stream_stop", { callSid });
        log.info("call_ended", {
          callSid,
          reason: "media_stream_stop",
          durationMs: state?.callStartTime ? Date.now() - state.callStartTime : 0,
          finalOutcome: state?.intent ?? "no_outcome",
        });
        cleanup();
        break;
      }
    }
  });

  ws.on("close", () => {
    log.debug("media_stream_ws_close", { callSid });
    log.info("call_ended", {
      callSid,
      reason: "ws_close",
      durationMs: state?.callStartTime ? Date.now() - state.callStartTime : 0,
      finalOutcome: state?.intent ?? "no_outcome",
    });
    cleanup();
  });

  ws.on("error", (err) => {
    log.error("ws_error", { callSid, message: err?.message });
    captureException(err, { callSid });
    cleanup();
  });

  // ------------------------------------------------------------------
  // Cleanup — idempotent teardown of streams, turns, and timers
  // ------------------------------------------------------------------
  function cleanup() {
    if (cleaned) return;
    cleaned = true;

    clearSilenceTimer();
    clearTimeout(callDurationTimer);
    clearTimeout(holdTimer);
    clearTimeout(closeFallbackTimer);
    clearTimeout(transferFallbackTimer);
    heldText = "";
    holdStartedAt = null;
    queuedText = "";
    endCallerSpeech();

    if (activeGenerator) {
      try { Promise.resolve(activeGenerator.return?.()).catch(() => {}); } catch { /* noop */ }
      activeGenerator = null;
    }
    if (activeTts) {
      try { activeTts.abort(); } catch { /* noop */ }
      activeTts = null;
    }
    if (stt) {
      try { stt.close(); } catch { /* noop */ }
      stt = null;
    }
    // Releases audioOut's playout pump interval (see audioOut.stop()).
    try { audioOut?.stop(); } catch { /* noop */ }
    // Note: DB call completion (summary/sentiment/outcome + state removal) is
    // handled by the /twilio/status callback, exactly as in mediaStream.js.
  }
}
