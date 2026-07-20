import * as geminiService from "../../services/gemini.js";
import * as db from "../../services/supabase.js";
import * as notifications from "../../services/notifications.js";
import * as googleTts from "../../services/googleTts.js";
import * as callState from "../callState.js";
import { STEPS } from "../callState.js";
import { log } from "../logger.js";
import { captureException } from "../sentry.js";
import { escapeXml } from "../twiml.js";
import { cleanTranscript, isIncomplete, extractFinalIntent } from "../transcriptUtils.js";
import { createTurnMetrics } from "./metrics.js";
import { createSttStream } from "./sttStream.js";
import { runLlmTurn } from "./llmTurn.js";
import { createTtsTurn } from "./ttsStream.js";
import { createAudioOut } from "./audioOut.js";
import { createVad } from "./inboundVad.js";
import { createTurnManager } from "./turnManager.js";
import { createFallbackFlow } from "./fallbackFlow.js";
import { VOICE_CATALOG } from "../../config/voices.js";
import { toSpeakable } from "./speakableText.js";
import { createUtteranceCache } from "./utteranceCache.js";

// ---------------------------------------------------------------------------
// session.js — per-call orchestrator for the v2 real-time voice pipeline.
//
// Composes the reviewed building blocks (metrics, sttStream, llmTurn,
// ttsStream, audioOut, inboundVad, turnManager) into one real-time call
// handler. Selected via PIPELINE_V2=true in server.js; the legacy
// lib/mediaStream.js remains the default. Behavioral parity with
// mediaStream.js (greeting, silence nudges, transfer, max-duration hangup,
// transcript/history persistence, call completion) is preserved while the
// latency/turn-taking mechanics are replaced by the streaming pipeline.
// ---------------------------------------------------------------------------

const GOOGLE_TTS_VOICE = "en-GB-Chirp3-HD-Aoede";
const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || "";
const CALL_MAX_DURATION_MS =
  (parseInt(process.env.CALL_MAX_DURATION_MINUTES, 10) || 30) * 60 * 1000;

const TRANSFER_TRIGGERS =
  /\b(representative|human|operator|real person|speak to someone|talk to someone|talk to a person|manager|supervisor)\b/i;

// SMS follow-up (Part 2) — generic "someone will get back to you {sla}" text
// used for the message_received caller text-back. Kept as a constant rather
// than per-business config for now (see task brief: base implementation).
const MESSAGE_SLA_TEXT = "as soon as possible";

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

// How long to wait for a held incomplete final to be completed before flushing
// it anyway. sttStream's utterance_end_ms is 1000, so a genuine continuation
// arrives (as another final) well within this window.
const INCOMPLETE_HOLD_MS = 1_000;

// Fallback close delay if the expected -done playback mark never echoes back
// (e.g. audio failed mid-goodbye) — guarantees the call still ends.
const CLOSE_FALLBACK_MS = 8_000;

const MAX_DURATION_MSG =
  "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!";

// Once the LLM has failed this many times in a row (see handleTurnError),
// stop retrying it and drop into the deterministic no-LLM fallbackFlow
// (take-a-message script) so the caller is never stuck in an error loop.
const FALLBACK_FAILURE_THRESHOLD = 2;

const FALLBACK_FAIL_MSG =
  "I'm sorry, I'm having trouble helping you right now. Please call back and we'll be happy to assist. Goodbye!";

const FILLER_TEXT = "One moment.";

// utteranceCache is keyed per synthesis backend/voice; the cache's
// synthesize function (below) is always Google TTS at GOOGLE_TTS_VOICE (see
// createUtteranceCache instantiation), regardless of a business's chosen
// ElevenLabs voice — see the module-level comment above utteranceCache for
// the tradeoff this implies.
const UTTERANCE_VOICE_KEY = GOOGLE_TTS_VOICE;

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
  const entries = [
    { kind: "filler", text: FILLER_TEXT },
    { kind: "nudge-stage1", text: buildSilenceNudge(1, null, null) },
    { kind: "nudge-greeting", text: buildSilenceNudge(2, STEPS.GREETING, null) },
    { kind: "nudge-identify", text: buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null) },
    { kind: "nudge-gather", text: buildSilenceNudge(2, STEPS.GATHER_DETAILS, null) },
    { kind: "nudge-confirm", text: buildSilenceNudge(2, STEPS.CONFIRM, null) },
    { kind: "nudge-default", text: buildSilenceNudge(2, "__default__", null) },
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
function mapLanguage(config) {
  if (Array.isArray(config?.languagesSpoken) && config.languagesSpoken.length > 1) {
    return "multi";
  }
  const first = Array.isArray(config?.languagesSpoken) && config.languagesSpoken[0];
  if (!first) return "en-US";
  return first.includes("-") ? first : first + "-US";
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
    const tz = config.timezone || "America/Chicago";
    const hour = parseInt(
      new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).split(":")[0],
      10
    );
    const tod = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    text += `${tod}! ${config.greeting}`;
  } else {
    text += config.greeting;
  }
  return text;
}

/** Stage-2 silence nudge text (ported from mediaStream.js). */
function buildSilenceNudge(stage, step, intent) {
  if (stage === 1) {
    return "I'm still here whenever you're ready.";
  }
  switch (step) {
    case STEPS.IDENTIFY_INTENT:
    case STEPS.GREETING:
      return "I'm here to help — are you calling to book an appointment, leave a message, or something else?";
    case STEPS.GATHER_DETAILS:
      if (intent === "book_appointment") {
        return "Take your time — I just need something like a preferred date or time to get started.";
      }
      if (intent === "take_message" || intent === "callback_request") {
        return "Whenever you're ready — I just need your name and a brief message.";
      }
      return "Take your time — just let me know what you need and I'll help.";
    case STEPS.CONFIRM:
      return "Just say yes to confirm, or let me know if anything needs to change.";
    default:
      return "I'm still here — feel free to continue whenever you're ready.";
  }
}

function buildSilenceGoodbye(cfg) {
  const phone = cfg?.transferPhoneNumber || cfg?.phone || "";
  if (phone) {
    return `It seems like you may have stepped away. Feel free to call us back at ${phone} anytime. Goodbye!`;
  }
  return "It seems like you may have stepped away. Feel free to call us back anytime. Goodbye!";
}

// ---------------------------------------------------------------------------
// Core: handle one incoming Media Streams WebSocket connection (v2 pipeline)
// ---------------------------------------------------------------------------

/**
 * Entry point wired from server.js when PIPELINE_V2 === "true".
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

  // Turn queueing (a caller final arriving while a turn's LLM is still in
  // flight but no audio is playing yet — barge-in is not appropriate).
  let queuedText = "";

  // Incomplete-final hold (mid-number / mid-date).
  let heldText = "";

  // Background context (knowledge / integrations / callerContext) fetch.
  let contextLoaded = false;

  // Lazily-synthesized "one moment" filler buffer, cached per call.
  let fillerBuf = null;

  let cleaned = false;

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
      googleFallbackVoice: GOOGLE_TTS_VOICE,
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
      onDone: () => {
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
   * normal live speakText() path on a cache miss. Used for every fixed
   * (non-LLM-streamed) utterance: greeting, silence nudges, goodbye lines.
   */
  function speakTextCacheable(text, markName) {
    const cached = text ? utteranceCache.get(UTTERANCE_VOICE_KEY, null, text) : null;
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

  /** Speak a fixed string, then close the call once its playback mark echoes. */
  function speakThenClose(text, markName) {
    state.step = STEPS.ENDING;
    state.closeAfterMark = markName;
    speakTextCacheable(text, markName);
    clearTimeout(closeFallbackTimer);
    closeFallbackTimer = setTimeout(() => closeWs(), CLOSE_FALLBACK_MS);
    closeFallbackTimer.unref?.();
  }

  function closeWs() {
    try {
      if (ws.readyState === 1) ws.close();
    } catch (err) {
      log.error("session_ws_close_failed", { callSid, reason: err?.message });
    }
  }

  /** Lazily synthesize and enqueue a short "one moment" filler (slow LLM). */
  async function playFiller() {
    const epoch = state.speakEpoch;
    try {
      const cached = utteranceCache.get(UTTERANCE_VOICE_KEY, "filler", FILLER_TEXT);
      const buf = cached || fillerBuf || (fillerBuf = await googleTts.synthesizeMulaw(FILLER_TEXT, GOOGLE_TTS_VOICE, callSid));
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
      log.error("transcript_write_failed", { callSid, speaker: "caller", reason: err?.message })
    );
    return seq;
  }

  function logAiTranscript(text, callerSeq) {
    if (!state.dbCallId || callerSeq == null) return;
    db.addTranscriptEntry(state.dbCallId, "ai", text, callerSeq + 1).catch((err) =>
      log.error("transcript_write_failed", { callSid, speaker: "ai", reason: err?.message })
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
      callerContext: state.callerContext || null,
    };
  }

  // ------------------------------------------------------------------
  // Silence handling
  // ------------------------------------------------------------------

  function clearSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function armSilenceTimer(reset = true) {
    clearSilenceTimer();
    if (reset) silenceStage = 0;
    if (!state || state.step === STEPS.ENDING || state.processingTurn) return;
    // Never run the clock while AI audio is (estimated to be) still playing —
    // it will be re-armed by the -done playback mark when the audio ends.
    if (audioOut?.isPlaying()) return;
    const step = state.step || STEPS.GREETING;
    const th = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    const delay =
      silenceStage === 0 ? th.nudge1 :
      silenceStage === 1 ? th.nudge2 - th.nudge1 :
      th.hangup - th.nudge2;
    silenceTimer = setTimeout(onSilence, delay);
    silenceTimer.unref?.();
  }

  async function onSilence() {
    silenceTimer = null;
    if (!state || state.step === STEPS.ENDING) return;
    // Guard against firing while AI is speaking or a turn is being processed.
    if (audioOut?.isPlaying() || state.processingTurn) {
      silenceTimer = setTimeout(onSilence, SILENCE_RETRY_MS);
      silenceTimer.unref?.();
      return;
    }

    const step = state.step || STEPS.GREETING;
    const th = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    silenceStage++;

    if (silenceStage === 1) {
      const text = buildSilenceNudge(1, step, state.intent);
      log.info("silence_nudge", { callSid, nudgeNumber: 1, step, intent: state.intent });
      speakTextCacheable(text, `nudge-1-${state.turnId}-done`);
      silenceTimer = setTimeout(onSilence, th.nudge2 - th.nudge1);
      silenceTimer.unref?.();
    } else if (silenceStage === 2) {
      const text = buildSilenceNudge(2, step, state.intent);
      log.info("silence_nudge", { callSid, nudgeNumber: 2, step, intent: state.intent });
      speakTextCacheable(text, `nudge-2-${state.turnId}-done`);
      silenceTimer = setTimeout(onSilence, th.hangup - th.nudge2);
      silenceTimer.unref?.();
    } else {
      log.info("silence_hangup", { callSid, step, intent: state.intent });
      speakThenClose(buildSilenceGoodbye(state.config), "silence-goodbye-done");
    }
  }

  // ------------------------------------------------------------------
  // Caller turn assembly (transcript quality pipeline + incomplete hold)
  // ------------------------------------------------------------------

  /** turnManager.onTurnEnd — the caller finished an utterance. */
  function handleCallerFinal(text) {
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
      return;
    }
    if (isIncomplete(clean)) {
      heldText = clean;
      log.debug("transcript_held", { callSid, reason: "incomplete_utterance" });
      holdTimer = setTimeout(flushHeld, INCOMPLETE_HOLD_MS);
      holdTimer.unref?.();
      return;
    }
    startTurn(extractFinalIntent(clean));
  }

  function flushHeld() {
    holdTimer = null;
    const t = heldText;
    heldText = "";
    if (!t) return;
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
    audioOut?.clear();
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
    log.debug("barge_in", { callSid });
  }

  // ------------------------------------------------------------------
  // Transfer (regex escape-trigger, ported from mediaStream.js)
  // ------------------------------------------------------------------

  /**
   * @param {string} userText
   * @param {number} callerSeq
   * @param {{skipAnnouncement?: boolean}} [opts] - skipAnnouncement: the model
   *   already spoke its own transfer announcement this turn (request_transfer
   *   tool path) — don't re-speak the hardcoded "Transferring you now" line
   *   on top of it. Only applies when the transfer can actually proceed; if
   *   it can't, we still speak the "unable to transfer" apology regardless,
   *   so a caller told "transferring you now" isn't left hanging.
   */
  async function doTransfer(userText, callerSeq, { skipAnnouncement = false } = {}) {
    const config = state.config;
    const transferNumber = config.transferPhoneNumber || TRANSFER_NUMBER;
    const canTransfer = !!transferNumber && resolveTransferAllowed(config);
    log.info("transfer_requested", { callSid, canTransfer });

    if (!canTransfer) {
      const msg = "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.";
      logAiTranscript(msg, callerSeq);
      speakText(msg, `turn-${state.turnId}-done`);
      return;
    }

    if (!skipAnnouncement) {
      const msg = "Transferring you now. Please hold.";
      logAiTranscript(msg, callerSeq);
      speakText(msg, `transfer-done`);
    }
    state.step = STEPS.ENDING;
    try {
      const twilio = (await import("twilio")).default;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(callSid).update({
        twiml: `<Response><Dial>${escapeXml(transferNumber)}</Dial></Response>`,
      });
      log.info("transfer_outcome", { callSid, success: true });
      db.markCallTransferred(callSid).catch((err) => {
        log.error("mark_call_transferred_failed", { callSid, message: err?.message });
      });
    } catch (err) {
      log.error("transfer_outcome", { callSid, success: false, reason: err?.message });
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
            sla: MESSAGE_SLA_TEXT,
          }).catch((err) => log.error("sms_followup_failed", { callSid, kind: "message_received", reason: err?.message }));
        }
      } catch (err) {
        captureException(err, { callSid, context: "session.fallbackFlow.complete" });
      }
    }

    // Close only once the flow's own goodbye line has finished playing.
    state.step = STEPS.ENDING;
    state.closeAfterMark = lastFallbackMark;
    clearTimeout(closeFallbackTimer);
    closeFallbackTimer = setTimeout(() => closeWs(), CLOSE_FALLBACK_MS);
    closeFallbackTimer.unref?.();
  }

  function failFallbackFlow() {
    log.info("fallback_flow_failed", { callSid });
    speakThenClose(FALLBACK_FAIL_MSG, "fallback-fail-goodbye-done");
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
      log.debug("transcript_queued", { callSid, reason: "processing_in_flight" });
      return;
    }

    // Hard call-duration limit.
    if (Date.now() - state.startedAt > CALL_MAX_DURATION_MS) {
      const seq = logCallerTranscript(userText);
      logAiTranscript(MAX_DURATION_MSG, seq);
      speakThenClose(MAX_DURATION_MSG, "maxdur-goodbye-done");
      return;
    }

    // Already ending — just hang up.
    if (state.step === STEPS.ENDING) {
      closeWs();
      return;
    }

    state.processingTurn = true;
    clearSilenceTimer();
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
      metrics?.mark("speech_end");
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
        } else if (ev.type === "done") {
          reply = ev.reply;
        }
      }
      // Epoch check BEFORE touching shared refs: if we were barged, the
      // successor turn already owns activeGenerator/activeTts — nulling them
      // here would clobber it.
      if (state.speakEpoch !== myEpoch) return;
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
        // the completion mark; nothing else to apply.
        return;
      }

      applyReply(userText, reply, callerSeq, markName, producedText);
    } catch (err) {
      handleTurnError(err, myEpoch);
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
      transferRequested,
    } = reply;

    // Conversation history.
    state.history.push({ role: "user", parts: [{ text: userText }] });
    state.history.push({ role: "model", parts: [{ text: replyText }] });

    if (toolResults?.length > 0) {
      for (const tr of toolResults) {
        log.info("tool_result", { callSid, tool: tr.name, success: tr.success });
      }
    }
    if (selectedAppointmentId != null) state.selectedAppointmentId = selectedAppointmentId;
    if (toolResults?.some((tr) => tr.name === "cancel_appointment_db" && tr.success)) {
      state.selectedAppointmentId = null;
    }

    if (intentArgs) {
      const prevStep = state.step;
      state.intent = intentArgs.intent;
      if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) {
        state.step = STEPS.GATHER_DETAILS;
      }
      log.info("intent_set", { callSid, intent: intentArgs.intent, prevStep, newStep: state.step });
    }

    if (appointmentArgs && state.businessId) {
      state.step = STEPS.CONFIRM;
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
      }).catch((err) => log.error("notify_appointment_failed", { callSid, reason: err?.message }));
      notifications.sendCallerSms(state.config, state.callerNumber, "appointment_confirmation", {
        name: appointmentArgs.client_name || "there",
        business: state.config?.businessName,
        datetime: appointmentArgs.scheduled_at ? new Date(appointmentArgs.scheduled_at).toLocaleString() : "your requested time",
      }).catch((err) => log.error("sms_followup_failed", { callSid, kind: "appointment_confirmation", reason: err?.message }));
    }

    if (endCallArgs) {
      state.step = STEPS.ENDING;
      log.info("step_transition", { callSid, toStep: STEPS.ENDING, trigger: "end_call", reason: endCallArgs.reason });
      // Close only after the goodbye audio has actually played out — the
      // turn's own completion mark is the trigger (see the mark handler).
      state.closeAfterMark = markName;
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = setTimeout(() => closeWs(), CLOSE_FALLBACK_MS);
      closeFallbackTimer.unref?.();
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
            sla: MESSAGE_SLA_TEXT,
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
      doTransfer(userText, callerSeq, { skipAnnouncement: producedText }).catch((err) => {
        log.error("transfer_flow_failed", { callSid, reason: err?.message });
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
    log.info("turn_completed", { callSid, step: state.step, intent: state.intent });
  }

  function handleTurnError(err, myEpoch) {
    if (state.speakEpoch !== myEpoch) return; // barged — successor owns shared refs
    activeGenerator = null;

    // Close out this turn's metrics so its marks don't leak into the next.
    state.turnMetrics?.finishTurn({ error: true });
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;

    const isTimeout = err?.code === "LLM_TIMEOUT";
    log.error("llm_turn_error", {
      callSid,
      code: isTimeout ? "llm_timeout" : "llm_error",
      message: err?.message,
      consecutiveFailures: state.consecutiveFailures,
    });
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

    const msg = isTimeout
      ? "Sorry, I'm taking a bit longer. Could you repeat that?"
      : "Sorry, I'm having a technical issue. Could you repeat that?";
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
      onInterim: (text) => turnManager?.handleInterim(text),
      onUtteranceEnd: () => {},
      onSpeechStarted: () => {},
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
    speakThenClose(
      "I'm having trouble hearing you. Please call back and we'll be happy to help. Goodbye!",
      "stt-error-goodbye-done"
    );
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
        turnManager = createTurnManager({ vad, audioOut, onInterrupt, onTurnEnd: handleCallerFinal });

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
          .warm(UTTERANCE_VOICE_KEY, buildUtteranceWarmEntries(config))
          .catch((err) => log.error("utterance_cache_warm_failed", { callSid, reason: err?.message }));

        // ---- Hard call-duration limit ----
        callDurationTimer = setTimeout(() => {
          if (state.step === STEPS.ENDING) return;
          speakThenClose(MAX_DURATION_MSG, "maxdur-goodbye-done");
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
        log.debug("playback_complete", { callSid, markName });

        if (state && markName && markName === state.closeAfterMark) {
          state.closeAfterMark = null;
          if (/^turn-\d+-done$/.test(markName)) state.turnMetrics?.finishTurn();
          clearTimeout(closeFallbackTimer);
          closeWs();
          break;
        }

        if (state && markName.endsWith("-done")) {
          if (/^turn-\d+-done$/.test(markName)) {
            state.turnMetrics?.finishTurn();
          }
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
    heldText = "";
    queuedText = "";

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
    // Note: DB call completion (summary/sentiment/outcome + state removal) is
    // handled by the /twilio/status callback, exactly as in mediaStream.js.
  }
}
