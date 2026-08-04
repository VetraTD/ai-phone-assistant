import { performance } from "node:perf_hooks";
import * as geminiService from "../../services/gemini.js";
import { ACTION_TOOL_NAMES } from "../../services/gemini.js";
import {
  dispatchCapabilityEffects as dispatchEffects,
  mergeCapabilityState as mergeCapabilityStateInto,
} from "../capabilities/effects.js";
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
import { createTurnMetrics, bumpCounter, recordHoldRule } from "./metrics.js";
import { createSttStream } from "./sttStream.js";
import { runLlmTurn } from "./llmTurn.js";
import { createTtsTurn, remainderBoundary, REPAIR_CHARS_PER_SEC } from "./ttsStream.js";
import { createAudioOut } from "./audioOut.js";
import { createVad } from "./inboundVad.js";
import { createTurnManager } from "./turnManager.js";
import { createEchoGuard } from "./echoGuard.js";
import { createFallbackFlow } from "./fallbackFlow.js";
import { resolveGoogleVoice, resolveRingTone } from "./voiceLocale.js";
import { getStrings } from "./strings.js";
import { VOICE_CATALOG } from "../../config/voices.js";
import { toSpeakable } from "./speakableText.js";
import { createUtteranceCache } from "./utteranceCache.js";
import { ttsHealth } from "./ttsHealth.js";
import { synthesizeMulawOnce } from "../../services/elevenlabs.js";
import { applyReplyState, systemNoteEntry } from "./replyState.js";

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

// ---------------------------------------------------------------------------
// Post-barge settle
//
// After the caller interrupts, the AI must not answer the instant STT
// finalizes. Deepgram endpoints at 300ms, so a caller who cuts in and pauses
// to gather their thought gets a fresh reply roughly a second later — exactly
// as they resume. Both talk, the caller barges again, and the call collapses
// into a start/stop loop that only ends when the caller gives up and goes
// silent (observed live, speakerphone).
//
// This is a SILENCE requirement, not a fixed delay: handleCallerFinal charges
// the caller only the difference between how long they have actually been
// quiet (lastCallerSpeechAtMs, stamped per voiced VAD frame) and the window
// below. In the common case endpointing has already bought most of it, so the
// added latency is a couple hundred ms; a caller who is still making noise
// gets the whole window and then the existing earned-extension logic.
//
// 700ms sits above the ~200ms gap that separates two speakers' turns and
// inside the 500-1000ms band of a hesitation pause WITHIN one turn — the two
// cases this has to tell apart. Tune by ear on real calls.
const POST_BARGE_SETTLE_MS = (() => {
  const v = Number.parseInt(process.env.VOICE_POST_BARGE_SETTLE_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 5_000 ? v : 700;
})();

// Hold-chain ceiling while a settle is active. Broken out from
// MAX_TOTAL_HOLD_MS so post-barge patience can be raised without lengthening
// ordinary mid-sentence holds (which are latency on every single turn).
const POST_BARGE_MAX_HOLD_MS = (() => {
  const v = Number.parseInt(process.env.VOICE_POST_BARGE_MAX_HOLD_MS, 10);
  return Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : MAX_TOTAL_HOLD_MS;
})();

// How long a barge stays "recent" for settle purposes. Without a TTL a single
// barge early in a call would make every later final settle-eligible.
const BARGE_SETTLE_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// Loop breaker
//
// A backstop, not a fix. The echo guard and the settle window above target the
// two known causes of a start/stop loop; this catches the case where something
// gets past them, because the reported failure mode does not end on its own —
// it runs until the caller gives up and stops talking.
//
// It deliberately knows nothing about echo, endpointing or VAD. It watches one
// thing: how often the AI is being cut off. Nothing legitimate interrupts an
// AI receptionist three times in six seconds, so that rate is taken as proof
// the call is in a loop rather than a conversation, and the AI stops talking
// until it hears one clean caller utterance.
//
// VOICE_LOOP_BREAKER_BARGES=0 disables it.
const LOOP_BREAKER_BARGES = (() => {
  const v = Number.parseInt(process.env.VOICE_LOOP_BREAKER_BARGES, 10);
  return Number.isFinite(v) && v >= 0 && v <= 20 ? v : 3;
})();
const LOOP_BREAKER_WINDOW_MS = (() => {
  const v = Number.parseInt(process.env.VOICE_LOOP_BREAKER_WINDOW_MS, 10);
  return Number.isFinite(v) && v >= 1_000 && v <= 60_000 ? v : 6_000;
})();

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
// One module-wide LRU, shared by every call, keyed by voice+text. The
// DEFAULT synthesize is Google TTS (for Google-provider businesses, whose
// whole call is Google anyway). For an ElevenLabs business the SAME LRU also
// holds that business's EL voice: at call start warm() is passed a per-call
// EL synthesizer (services/elevenlabs.js synthesizeMulawOnce) and keyed by
// the EL voiceId, so mid-call fixed lines (silence nudges, goodbye, filler)
// play back in the business's OWN voice instead of flipping to the Google
// fallback voice — the mid-call voice-consistency fix. Playback preference
// (see speakTextCacheable): warm EL cache hit -> live EL synth (if the
// breaker is closed) -> Google cache/synth only as a last resort.
//
// The greeting is deliberately EXCLUDED from the cache: it is the most
// identity-defining moment of the call and always goes through the live
// per-business ttsTurn path (see the "start" handler), never
// speakTextCacheable/utteranceCache.
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
    { kind: "stillWorking", text: S.stillWorking },
    { kind: "nudge-stage1", text: buildSilenceNudge(1, null, null, config) },
    { kind: "nudge-greeting", text: buildSilenceNudge(2, STEPS.GREETING, null, config) },
    { kind: "nudge-identify", text: buildSilenceNudge(2, STEPS.IDENTIFY_INTENT, null, config) },
    { kind: "nudge-gather", text: buildSilenceNudge(2, STEPS.GATHER_DETAILS, null, config) },
    { kind: "nudge-confirm", text: buildSilenceNudge(2, STEPS.CONFIRM, null, config) },
    { kind: "nudge-default", text: buildSilenceNudge(2, "__default__", null, config) },
    { kind: "goodbye", text: buildSilenceGoodbye(config) },
  ];
  // Normalize through toSpeakable at warm time so the cached audio is
  // pronounced correctly (times/abbreviations/phone digit-grouping) AND its
  // cache key matches what speakTextCacheable() looks up at playback — both
  // sides run the identical transform (toSpeakable is idempotent). This is the
  // fix for the fixed strings historically bypassing toSpeakable on the EL
  // path (only the goodbye's phone number was pre-normalized before).
  return entries
    .map((e) => ({ kind: e.kind, text: toSpeakable(e.text || "") }))
    .filter((e) => e.text);
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
 * Business-domain terms to feed Deepgram nova-3 keyterm prompting, so the words
 * a caller is most likely to say for THIS business ("Szymanski", the practice
 * name, a custom identity label) are recognized instead of mangled into a
 * near-homophone. Pure and exported for direct unit testing.
 *
 * Sourced from what the config actually carries at STT-open time:
 *   - businessName (skipping the generic "our office" placeholder), and
 *   - custom identity labels (capabilities.*.require.identity.custom[].label).
 * Knowledge-base categories and service-type strings are NOT sourced: knowledge
 * loads in the background contextPromise (not yet resolved when STT opens), and
 * no config field enumerates service types (service_type is free-form).
 *
 * Keyterm prompting works best with a handful of short terms, so we dedupe
 * case-insensitively, drop terms over five words, and cap the list at 20.
 * @param {object} config - normalised business config
 * @returns {string[]}
 */
export function keytermsFromConfig(config) {
  if (!config || typeof config !== "object") return [];

  const raw = [];
  const name = typeof config.businessName === "string" ? config.businessName.trim() : "";
  if (name && name.toLowerCase() !== "our office") raw.push(name);

  const caps = config.capabilities && typeof config.capabilities === "object" ? config.capabilities : {};
  for (const cap of Object.values(caps)) {
    const custom = cap?.require?.identity?.custom;
    if (!Array.isArray(custom)) continue;
    for (const field of custom) {
      const label = typeof field?.label === "string" ? field.label.trim() : "";
      if (label) raw.push(label);
    }
  }

  const seen = new Set();
  const out = [];
  for (const term of raw) {
    if (!term) continue;
    if (term.split(/\s+/).length > 5) continue; // keyterm prompting favors short terms
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 20) break;
  }
  return out;
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
 * Resolve the prosody anchor (the next turn's previous_text) from a settled
 * TTS turn's onDone payload. Normally the full text this turn intended to
 * speak — but when the turn was truncated by a mid-turn ElevenLabs failure,
 * ttsStream reports `spokenText`: only what the caller actually heard (the
 * voiced prefix plus whatever repaired remainder was emitted before any
 * barge). Anchoring the next turn's prosody to text the caller never heard is
 * exactly what this guards against.
 * @param {string} fullText
 * @param {{truncated?: boolean, spokenText?: string}} [payload]
 * @returns {string}
 */
function anchorFromSettle(fullText, payload) {
  if (payload?.truncated && typeof payload.spokenText === "string" && payload.spokenText.trim()) {
    return payload.spokenText;
  }
  return fullText;
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
  let echoGuard = null;

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

  // The text the AI last actually spoke (greeting, then each turn's reply, in
  // toSpeakable form). Threaded into the NEXT turn's TTS as `previous_text` so
  // ElevenLabs continues its prosody from it instead of resetting — each turn
  // is its own socket with no cross-turn state. Trimmed in elevenlabs.js.
  let lastSpokenText = "";

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

  // Wall-clock time of the most recent barge-in, or null once a turn has
  // consumed it. Read by handleCallerFinal to decide whether the post-barge
  // settle applies to the final it is holding (see POST_BARGE_SETTLE_MS).
  let bargeSettleArmedAt = null;

  // Loop breaker (see LOOP_BREAKER_BARGES). `recentBargeTimes` is a sliding
  // window of barge timestamps; `awaitingCleanFinal` is true while the AI is
  // deliberately holding its tongue after a runaway was detected.
  let recentBargeTimes = [];
  let awaitingCleanFinal = false;

  // The turn currently being generated/spoken, or null between turns. Exists
  // so a barge can record what the caller asked and how far the answer got
  // (see recordInterruptedTurn) — a barged turn returns before applyReply, so
  // without this BOTH sides of the exchange are missing from state.history and
  // the next reply is generated as if the interruption never happened.
  let inFlightTurn = null;

  // Background context (knowledge / integrations / callerContext) fetch.
  let contextLoaded = false;

  // Lazily-synthesized "one moment" filler buffer, cached per call.
  let fillerBuf = null;

  let cleaned = false;

  /**
   * The voice this call should speak with RIGHT NOW. Normally resolveVoice()
   * of the config, but once this call has actually played a full-turn Google
   * fallback (state.stickyGoogle — set in beginSpeaking's onDone), every
   * remaining turn is forced to Google too. That stops the jarring engine
   * ping-pong where the ttsHealth breaker opening/half-opening across turns
   * would alternate a single call between ElevenLabs and Google. The breaker
   * still protects OTHER calls, and a recovered ElevenLabs still applies to
   * NEW calls — stickiness is per-call only.
   */
  function currentVoice() {
    const v = resolveVoice(state.config);
    if (state?.stickyGoogle && !v.forceFallback) {
      return { ...v, forceFallback: true };
    }
    return v;
  }

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
   *
   * @param {function} [onSettled] - called from onDone, but ONLY if
   *   state.speakEpoch is still the epoch captured when this turn began —
   *   i.e. the caller did NOT barge in during playback. Mirrors the turn
   *   loop's own lastSpokenText guard (see startTurn: "if (state.speakEpoch
   *   !== myEpoch) ... return" before committing spokenThisTurn) for fixed
   *   utterances, which have no equivalent await point in their caller.
   */
  function beginSpeaking(markName, isTurn, onSettled) {
    const epoch = state.speakEpoch;
    let firstFrame = false;
    const { voiceId, voiceSettings, forceFallback } = currentVoice();
    const tts = createTtsTurn({
      voiceId,
      voiceSettings,
      previousText: lastSpokenText,
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
      onDone: (payload = {}) => {
        const { truncated, repairedFrom, remainderChars, usedFallback } = payload;
        if (truncated) {
          // repairedFrom/remainderChars are present once ttsStream repaired the
          // mid-turn cut by resynthesizing the unspoken remainder (see
          // ttsStream.handleElError); null on the rare 0-remainder case.
          log.error("tts_turn_truncated", {
            callSid,
            turnIndex: state.turnId,
            markName,
            repairedFrom: repairedFrom ?? null,
            remainderChars: remainderChars ?? null,
          });
        }
        // Fallback audio was emitted on this turn (usedFallback) and it was an
        // actual caller turn — not a fixed micro-utterance (isTurn) — for a
        // business whose intended engine was ElevenLabs (!forceFallback).
        // usedFallback covers BOTH a full-turn Google fallback AND a mid-turn
        // repair where EL cut out and Google resynthesized the remainder; either
        // way EL has shown itself unreliable for this call. Make the rest of
        // THIS call sticky-Google so later turns don't ping-pong back to EL as
        // the breaker half-opens. A micro-utterance fallback (isTurn=false)
        // deliberately does NOT stick.
        if (isTurn && usedFallback && !forceFallback && state && !state.stickyGoogle) {
          state.stickyGoogle = true;
          log.info("tts_sticky_google_engaged", { callSid, turnIndex: state.turnId });
        }
        // Only emit the completion mark if this turn is still current; a
        // superseded (barged) turn must not re-arm silence or trigger a close.
        if (state.speakEpoch === epoch) {
          audioOut?.sendMark(markName);
          onSettled?.(payload);
        }
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

  /**
   * Record text the caller is about to hear, so the echo guard can recognize
   * it if it comes back through their microphone (lib/voice/echoGuard.js).
   *
   * Called explicitly at each outbound-speech site rather than by wrapping
   * tts.write: the wrapper approach replaces the TTS turn's own write with a
   * closure, which is invisible to anything holding a reference to the
   * original (including every test that asserts on what was spoken).
   * @param {string} text
   */
  function noteSpokenText(text) {
    echoGuard?.noteSpoken(text, performance.now());
  }

  /** Speak a fixed string (greeting / nudge / error / goodbye). */
  function speakText(text, markName, onSettled) {
    const tts = beginSpeaking(markName, false, onSettled);
    activeTts = tts;
    noteSpokenText(text);
    tts.write(text);
    tts.end();
    return tts;
  }

  /**
   * Play a pre-cached micro-utterance buffer straight to audioOut, then send
   * its completion mark — zero-latency, no live TTS turn at all (so nothing
   * for onInterrupt to abort; audioOut.clear() alone stops a barge-in
   * mid-playback). Mirrors beginSpeaking's onDone timing: the mark is sent
   * right after the audio is handed off (Twilio echoes it back once it has
   * finished playing everything queued before it).
   */
  /**
   * @param {string} [text] - what this buffer says. Cache hits bypass the TTS
   *   stream entirely, so this is the one outbound-speech path beginSpeaking's
   *   write() wrapper cannot see — without it, a cached nudge or goodbye could
   *   echo back and be answered as caller speech.
   */
  function playCachedBuffer(buf, markName, text) {
    activeTts = null;
    const epoch = state.speakEpoch;
    noteSpokenText(text);
    audioOut?.enqueue(buf);
    if (state.speakEpoch === epoch) audioOut?.sendMark(markName);
  }

  /**
   * Speak a fixed (non-LLM-streamed) micro-utterance — silence nudges, goodbye
   * lines — keeping the caller's voice consistent through the whole call.
   *
   * The text is always run through toSpeakable() first (fixed strings used to
   * bypass it on the EL path), and the SAME normalized text is what was warmed
   * into the cache, so keys line up.
   *
   * Source preference:
   *   ElevenLabs business (not sticky-Google):
   *     1. warm EL cache hit (business voice, zero latency) — see the "start"
   *        handler warming utteranceCache under the EL voiceId.
   *     2. else, if the ElevenLabs breaker is closed, speak it LIVE through the
   *        same per-business ttsTurn every real turn uses (nudges/goodbye are
   *        not latency-critical). speakText's own EL->Google fallback still
   *        covers a live failure.
   *     3. else (breaker open) a Google cache hit, else live Google — LAST
   *        resort only, and consistent with every other line while EL is down.
   *   Google business (or a call gone sticky-Google): Google cache hit, else
   *   live Google — exactly as before.
   *
   * A warmup miss never breaks the call: the nudge/goodbye still fires on time
   * via the live path. Logs which source served the line (cache_hit_el /
   * live_el / google_fallback).
   */
  function speakTextCacheable(text, markName) {
    const speakable = text ? toSpeakable(text) : text;
    const { forceFallback, voiceId } = currentVoice();
    const googleVoice = state.googleVoice || GOOGLE_TTS_VOICE;

    if (!forceFallback) {
      // 1. Warm ElevenLabs cache hit — the business's own voice, no latency.
      const elCached = speakable ? utteranceCache.get(voiceId, null, speakable) : null;
      if (elCached) {
        log.debug("micro_utterance_source", turnCtx({ markName, source: "cache_hit_el" }));
        playCachedBuffer(elCached, markName, speakable);
        return null;
      }
      // 2. Live ElevenLabs, while the breaker is closed.
      if (ttsHealth.isHealthy()) {
        log.debug("micro_utterance_source", turnCtx({ markName, source: "live_el" }));
        return speakText(speakable, markName);
      }
      // 3. Breaker open — Google as a last resort (cache hit, else live).
      const gCached = speakable ? utteranceCache.get(googleVoice, null, speakable) : null;
      log.debug("micro_utterance_source", turnCtx({ markName, source: "google_fallback" }));
      if (gCached) {
        playCachedBuffer(gCached, markName, speakable);
        return null;
      }
      return speakText(speakable, markName);
    }

    // Google-provider business (or a call gone sticky-Google).
    const cached = speakable ? utteranceCache.get(googleVoice, null, speakable) : null;
    log.debug("micro_utterance_source", turnCtx({ markName, source: "google_fallback" }));
    if (!cached) return speakText(speakable, markName);
    playCachedBuffer(cached, markName, speakable);
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
   * Speak a short hold line while the LLM is slow or mid-tool. For an
   * ElevenLabs business, write it straight into the turn's own (already
   * business-voiced) live TTS stream — activeTts at this point is the same
   * open stream the turn's actual reply text will follow, so the line and
   * the reply play back-to-back in the same voice, no cache involved. Only
   * a Google-provider business (whose whole call already uses Google, see
   * resolveVoice) uses the pre-synthesized cache/fallback path.
   *
   * @param {"filler"|"stillWorking"} [kind] - which line, and its cache key.
   *   "filler" ("One moment.") covers a slow FIRST chunk; "stillWorking"
   *   ("Still working on that.") covers a turn that has already spoken and
   *   then went quiet, which in practice means a slow tool round.
   */
  async function playHoldLine(kind = "filler") {
    const epoch = state.speakEpoch;
    const text = getStrings(state.config)[kind];
    if (!text) return;
    if (!currentVoice().forceFallback) {
      if (state.speakEpoch !== epoch || !activeTts) return;
      try {
        noteSpokenText(text);
        activeTts.write(text);
      } catch (err) {
        log.error("session_filler_failed", { callSid, kind, reason: err?.message });
      }
      return;
    }
    try {
      const googleVoice = state.googleVoice || GOOGLE_TTS_VOICE;
      const cached = utteranceCache.get(googleVoice, kind, text);
      // fillerBuf memoizes only the "One moment." line — it is the one played
      // often enough per call for a second synthesis to be worth avoiding.
      const buf = cached
        || (kind === "filler" ? fillerBuf : null)
        || await googleTts.synthesizeMulaw(text, googleVoice, callSid);
      if (kind === "filler" && !cached) fillerBuf = buf;
      if (state.speakEpoch !== epoch) return;
      noteSpokenText(text);
      audioOut?.enqueue(buf);
    } catch (err) {
      log.error("session_filler_failed", { callSid, kind, reason: err?.message });
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

  /**
   * Token counts for the turn being finished, as finishTurn() extras.
   *
   * Consume-once: read and cleared, so a turn that never produced a `done`
   * event (barged, errored) cannot inherit the previous turn's counts and
   * report a cache hit that never happened. Absent fields are omitted rather
   * than nulled — getLatencyStats skips turns without both counts, and a
   * present-but-null pair would be counted as a 0% hit.
   *
   * @returns {{cached_tokens?: number, prompt_tokens?: number}}
   */
  function usageExtras() {
    const usage = state?.lastUsage;
    if (state) state.lastUsage = null;
    if (!usage) return {};
    return {
      ...(usage.cachedTokens != null ? { cached_tokens: usage.cachedTokens } : {}),
      ...(usage.promptTokens != null ? { prompt_tokens: usage.promptTokens } : {}),
    };
  }

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
      // ...and when they ACTUALLY stopped, which is earlier by Deepgram's
      // endpointing window plus network. lastFinalAtMs is when the news
      // reached us; the caller started waiting before that, and the gap is
      // otherwise unmeasurable from inside this process. Null when Deepgram
      // gave no usable word timings — the mark is simply skipped then.
      state.audioSpeechEndAtMs = stt?.getLastSpeechEndAt?.() ?? null;
    }
    // The utterance is over — stop suppressing the ladder. Every branch
    // below either starts a turn (which re-arms via its playback mark) or
    // calls armSilenceTimer itself, so the ladder resumes from a clean slate.
    endCallerSpeech();
    clearTimeout(holdTimer);
    holdTimer = null;
    const combined = heldText ? `${heldText} ${text}` : text;
    heldText = "";

    // Belt-and-braces echo check on the COMBINED text. turnManager already
    // rejects an echo final on its own, but held text is re-examined here and
    // this is the last point before the LLM is handed something to answer —
    // and answering its own sentence is what kept the stutter loop running.
    if (echoGuard?.isEcho(combined, performance.now())) {
      log.debug("transcript_discarded", { callSid, reason: "echo" });
      bumpCounter("echo_suppressed_final");
      armSilenceTimer(false); // same invariant as the filler-only branch below
      return;
    }

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

    // Loop breaker released. This final survived the echo guard and the filler
    // filter, and arrives with the AI verifiably quiet — a real person saying
    // a real thing, which is exactly what the yield was waiting for. Anything
    // arriving while audio is still playing is not that, and is dropped
    // (ladder left armed) rather than restarting the loop.
    if (awaitingCleanFinal) {
      if (audioOut?.isPlaying()) {
        log.debug("transcript_discarded", { callSid, reason: "loop_breaker_yield" });
        armSilenceTimer(false);
        return;
      }
      awaitingCleanFinal = false;
      log.info("loop_breaker_released", { callSid });
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
    const { holdMs: wantedHoldMs, rule: classifiedRule } = incomplete
      ? classifyHold(clean)
      : { holdMs: 0, rule: "complete" };

    // Post-barge settle. A final arriving just after the caller interrupted is
    // the one most likely to be a fragment of a thought they are still
    // forming, so it waits for real silence before becoming a turn — see
    // POST_BARGE_SETTLE_MS. Charged relative to how long they have ALREADY
    // been quiet, so the common case (Deepgram's own 300ms endpointing plus
    // delivery has already covered most of the window) costs almost nothing.
    const settleActive = isBargeSettleActive();
    // Silence is measured from the LATER of "last voiced frame" and "the
    // barge itself". The barge is proof the caller was speaking at that
    // instant, and lastCallerSpeechAtMs can be stale — the STT-derived
    // signals that stamp it are echo-gated on !isPlaying (see
    // noteCallerSpeech), which is exactly false during the AI speech being
    // interrupted. Without this floor a barge could produce a zero settle.
    const spokeAtMs = Math.max(lastCallerSpeechAtMs, bargeSettleArmedAt ?? 0);
    const settleMs = settleActive
      ? Math.max(0, POST_BARGE_SETTLE_MS - (Date.now() - spokeAtMs))
      : 0;
    const rule = settleMs > wantedHoldMs ? "post_barge_settle" : classifiedRule;
    const holdMs = Math.min(
      Math.max(wantedHoldMs, settleMs),
      Math.max(0, holdChainCeiling() - elapsedHold)
    );
    // Attribute the decision before branching, so the zero-hold cases are
    // counted too. The share of finals that cost nothing is the denominator
    // that says whether holding is a common tax or an edge case — a rule
    // firing thirty times for 1500ms matters more than one firing twice for
    // 2000ms, and neither is visible from a per-hold log line.
    recordHoldRule(rule, holdMs);
    if (holdMs > 0) {
      if (rule === "post_barge_settle") bumpCounter("barge_settles");
      heldText = clean;
      if (holdStartedAt === null) {
        holdStartedAt = Date.now();
        // Speech from before this hold must not count toward extending it.
        lastHoldCheckAtMs = holdStartedAt;
      }
      bumpCounter("holds_started");
      log.debug("transcript_held", {
        callSid,
        reason: rule === "post_barge_settle" ? "post_barge_settle" : "incomplete_utterance",
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

  /**
   * Is a recent barge-in still close enough to govern how patiently the next
   * final is handled? Bounded by BARGE_SETTLE_TTL_MS so one barge early in a
   * call doesn't make every later final settle-eligible.
   * @returns {boolean}
   */
  function isBargeSettleActive() {
    if (POST_BARGE_SETTLE_MS <= 0) return false; // env revert switch
    if (bargeSettleArmedAt === null) return false;
    return Date.now() - bargeSettleArmedAt <= BARGE_SETTLE_TTL_MS;
  }

  /**
   * Ceiling for the CURRENT hold chain. Post-barge holds get their own budget
   * so waiting longer after an interruption never costs latency on ordinary
   * mid-sentence holds. Read by both handleCallerFinal and onHoldExpired so
   * the two can never disagree about when to give up and flush.
   * @returns {number}
   */
  function holdChainCeiling() {
    return isBargeSettleActive() ? POST_BARGE_MAX_HOLD_MS : MAX_TOTAL_HOLD_MS;
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
    // Same ceiling handleCallerFinal used to size this hold (post-barge holds
    // have their own budget) — reading it from one helper keeps the two from
    // disagreeing about when the chain is over.
    const ceiling = holdChainCeiling();
    if (heldText && elapsed < ceiling && spokeSinceLastCheck) {
      const extension = Math.min(HOLD_VAD_EXTENSION_MS, ceiling - elapsed);
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
    flushHeld({ cappedByCeiling: elapsed >= ceiling });
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

  /**
   * Record this barge and decide whether the call has stopped being a
   * conversation. Returns true when the loop breaker just tripped.
   * @returns {boolean}
   */
  function noteBargeForLoopBreaker() {
    if (LOOP_BREAKER_BARGES <= 0) return false; // env kill switch
    const now = Date.now();
    recentBargeTimes.push(now);
    recentBargeTimes = recentBargeTimes.filter((t) => now - t <= LOOP_BREAKER_WINDOW_MS);
    if (recentBargeTimes.length < LOOP_BREAKER_BARGES) return false;

    // Tripped. Stop talking — a HARD clear, not the usual tapered one: a
    // graceful trail-off still emits audio, and emitting audio is what has
    // been feeding this. Then wait for one clean caller utterance before
    // speaking again (see handleCallerFinal).
    recentBargeTimes = [];
    awaitingCleanFinal = true;
    audioOut?.clear();
    bumpCounter("loop_breaker_trips");
    log.info("loop_breaker_tripped", {
      callSid,
      barges: LOOP_BREAKER_BARGES,
      windowMs: LOOP_BREAKER_WINDOW_MS,
    });
    return true;
  }

  /**
   * Write the interrupted exchange into history, so the next turn is generated
   * by a model that knows what just happened.
   *
   * A barged turn returns before applyReply, and applyReply is what pushes the
   * caller's question AND the model's reply. So without this, an interruption
   * silently erases both: the successor turn sees history ending BEFORE the
   * question, plus whatever fragment the caller interrupted with. With no
   * anchor the model answers the fragment on its own terms, which is why the
   * post-interruption reply reads as new-but-unrelated rather than as a
   * continuation.
   *
   * Called synchronously from onInterrupt, NOT from the generator's epoch
   * bail-out: handleFinal runs onInterrupt then onTurnEnd -> startTurn on the
   * same tick, while the dying generator resumes on a later microtask. Only
   * the synchronous path is guaranteed to land before the successor turn
   * builds its request.
   *
   * @param {number} playingUntilMs - audioOut's playback estimate as it was
   *   BEFORE clear() collapsed it; the difference from now is how much of the
   *   reply the caller never heard.
   */
  function recordInterruptedTurn(playingUntilMs) {
    const turn = inFlightTurn;
    inFlightTurn = null;
    if (!turn || !turn.userText) return; // greeting/nudge barge — nothing owed

    // What did the caller actually HEAR? spokenThisTurn is everything handed
    // to TTS, which overstates it: the tapered clear drops whatever was still
    // queued. Convert the unplayed remainder back into characters with
    // ttsStream's own rate constant, then round DOWN to a sentence boundary
    // with its own helper — one shared estimate of one physical quantity.
    const unheardMs = Math.max(0, (playingUntilMs ?? 0) - performance.now());
    const written = turn.spokenText || "";
    const unheardChars = Math.round((unheardMs / 1000) * REPAIR_CHARS_PER_SEC);
    const heard = written.slice(0, remainderBoundary(written, written.length - unheardChars)).trim();

    state.history.push({ role: "user", parts: [{ text: turn.userText }] });
    if (heard) state.history.push({ role: "model", parts: [{ text: heard }] });
    state.history.push(
      systemNoteEntry([
        heard
          ? `the caller interrupted you here — you had only said "${heard}", so they did not hear the rest; do not repeat it, just respond to what they say next`
          : "the caller interrupted before you said anything they could hear; respond to what they say next",
      ])
    );

    // The caller row was written by startTurn; without this the barged turn
    // leaves a question with no answer beside it, which the post-call summary
    // and sentiment pass both read.
    if (heard) logAiTranscript(heard, turn.callerSeq);

    log.debug("barge_history_recorded", {
      callSid,
      heardChars: heard.length,
      writtenChars: written.length,
    });
  }

  /** turnManager.onInterrupt — a real caller interruption during AI speech. */
  function onInterrupt(_text) {
    // Tapered stop, not a hard clear: audioOut drops the locally queued
    // remainder and ramps the few frames that were about to play down to
    // silence, so the AI trails off mid-thought the way a person does
    // instead of vanishing mid-syllable. See audioOut.clear's docstring.
    // Read the playback estimate BEFORE clear() collapses it — it is the only
    // evidence of how much of the reply the caller actually heard.
    const playingUntilMs = audioOut?.aiAudioPlayingUntil?.() ?? 0;
    const cut = audioOut?.clear({ fadeMs: BARGE_FADE_MS });
    // clear() collapses the playback estimate to roughly now+140ms, but the
    // echo that caused this barge is still inside Deepgram's buffer and its
    // final will not arrive for another 300ms (endpointing) to 1000ms
    // (utterance_end_ms). Stamping the stop keeps the echo window open long
    // enough to catch it — otherwise the single worst echo, the one that
    // triggered the interruption, is the one that gets answered.
    echoGuard?.noteAudioStopped(performance.now());
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
    // Remember which turn that was, so its own -done mark (still on its way
    // back from Twilio, since barge-in leaves already-queued audio playing)
    // cannot close the metrics a second time. See the "mark" handler.
    state.bargedTurnId = state.turnId;
    // Allow the following onTurnEnd -> handleCallerFinal -> startTurn to run.
    state.processingTurn = false;
    clearSilenceTimer();
    bumpCounter("barge_ins");
    noteBargeForLoopBreaker();
    recordInterruptedTurn(playingUntilMs);

    // Arm the settle window. handleCallerFinal turns this into a hold so the
    // AI waits for a real pause instead of answering the instant Deepgram
    // endpoints — see POST_BARGE_SETTLE_MS.
    bargeSettleArmedAt = Date.now();

    // ---- Everything below leaves the call in a state it can recover from ----
    //
    // The three hazards, all of which have to be handled HERE because a barge
    // may be followed by no further caller final at all (an interim triggered
    // it, and the utterance that follows is empty, filler-only, or echo):

    // (1) The silence ladder. clearSilenceTimer() above killed it, and this
    // turn's -done mark is now epoch-suppressed, so the mark-driven re-arm
    // never fires either. Re-arm unconditionally rather than relying on a
    // successor turn: armSilenceTimer retry-arms while the caller is speaking
    // (which they are, by definition, right now), and startTurn clears it
    // again if a turn does start. reset=false preserves the escalation stage.
    armSilenceTimer(false);

    // (2) The interrupt latch inside turnManager, which is otherwise cleared
    // only by a completed turn. An interim-triggered barge whose final never
    // arrives non-empty would leave it set, and the caller could not interrupt
    // a second time for the rest of the call. Safe to clear here because
    // onInterrupt IS the consumption of the latch — the dedupe it exists for
    // is already enforced by the speakEpoch bump above.
    turnManager?.reset();

    // (3) The hold chain and any orphaned queued text. The pre-barge hold
    // budget was spent on a different intention, so the chain clock restarts
    // (heldText itself is real caller words and is kept). A hold already armed
    // must not flush on its pre-barge schedule — that is a direct route back
    // into the loop this is fixing. And queuedText is orphaned by every barge:
    // startTurn's finally only replays it when the epoch still matches, so
    // without folding it in here it resurfaces minutes later as if the caller
    // had just said it.
    if (queuedText) {
      heldText = [queuedText, heldText].filter(Boolean).join(" ");
      queuedText = "";
    }
    holdStartedAt = null;
    lastHoldCheckAtMs = Date.now();
    if (holdTimer) startHoldTimer(Math.max(POST_BARGE_SETTLE_MS, 1));

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
    // The settle did its job — this turn is the reply to the interruption, so
    // the next final is judged on its own merits again.
    bargeSettleArmedAt = null;
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

      // From here until this turn completes, a barge can arrive at any moment.
      // recordInterruptedTurn needs to know what the caller asked, which row
      // to attach the partial answer to, and how much of that answer had been
      // handed to TTS — kept current as sentences stream out below.
      inFlightTurn = { userText, callerSeq, spokenText: "" };

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
      // audio_speech_end is stamped first and sits BEFORE speech_end: the gap
      // between them is Deepgram's endpointing window + network + inference,
      // time the caller spends waiting that no in-process clock can observe.
      // Without it, "our hold logic is slow" and "the STT tail is slow" look
      // identical in the numbers.
      // Loose null check on purpose: undefined (no final yet this call) must
      // skip the mark too, or mark() would fall back to performance.now() and
      // silently report a zero-length STT tail.
      if (state.audioSpeechEndAtMs != null) {
        metrics?.mark("audio_speech_end", state.audioSpeechEndAtMs);
      }
      metrics?.mark("speech_end", state.lastFinalAtMs);
      metrics?.mark("stt_final");

      state.turnId++;
      const turnId = state.turnId;
      const markName = `turn-${turnId}-done`;

      // onSettled corrects the anchor ONLY when this turn was truncated: line
      // ~1447 commits the full spokenThisTurn synchronously after tts.end(),
      // and this async settle then narrows it to what was actually voiced if a
      // mid-turn ElevenLabs failure cut it short (see anchorFromSettle).
      const tts = beginSpeaking(markName, true, (payload) => {
        if (payload?.truncated && typeof payload.spokenText === "string" && payload.spokenText.trim()) {
          lastSpokenText = payload.spokenText;
        }
      });
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
      // Accumulates exactly the toSpeakable text handed to TTS this turn, so
      // the NEXT turn can continue its prosody from it (previous_text).
      let spokenThisTurn = "";

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
          if (ready) {
            const spoken = toSpeakable(ready);
            spokenThisTurn += spoken;
            if (inFlightTurn) inFlightTurn.spokenText = spokenThisTurn;
            noteSpokenText(spoken);
            tts.write(spoken);
          }
        } else if (ev.type === "slow") {
          if (!producedText) await playHoldLine("filler");
        } else if (ev.type === "stalled") {
          // The model has already spoken this turn and then went quiet — in
          // practice a tool round running long. Keep the line alive.
          //
          // Gated on audio, not on text: the prompt has the model announce its
          // own "one moment while I check that" in the same response as the
          // tool call, so the guarantee that matters is never speaking OVER
          // that announcement. isPlaying() answers exactly that question;
          // inspecting what was said would only approximate it.
          if (!audioOut?.isPlaying()) {
            bumpCounter("llm_stalls");
            log.info("llm_stalled", turnCtx({ sinceLastChunkMs: ev.sinceLastChunkMs }));
            await playHoldLine("stillWorking");
          }
        } else if (ev.type === "toolEffect") {
          // First tool of the turn. mark() is first-write-wins, so this lands on
          // the earliest one and llm_tool_ms measures the round-trip the caller
          // waited through before any text existed.
          metrics?.mark("llm_first_tool");
          recordDurableEffect(ev.effect, turnEffects);
        } else if (ev.type === "done") {
          reply = ev.reply;
          // Stashed on state because finishTurn() runs from the Twilio mark
          // handler, which has no access to this turn's reply. Overwritten (to
          // null) every turn so a turn that reported no usage can't inherit
          // the previous turn's numbers and fake a cache hit.
          state.lastUsage = ev.reply?.usage ?? null;
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
        const spoken = toSpeakable(sentenceBuf);
        spokenThisTurn += spoken;
        if (inFlightTurn) inFlightTurn.spokenText = spokenThisTurn;
        noteSpokenText(spoken);
        tts.write(spoken);
        sentenceBuf = "";
      }

      tts.end();

      // Anchor the next turn's prosody to what this turn just spoke. Guarded so
      // an empty turn (tool-only, no text) doesn't wipe the prior anchor.
      if (spokenThisTurn.trim()) lastSpokenText = spokenThisTurn;
      // The turn survived to its own completion, so there is no interrupted
      // exchange to record; applyReply owns the history from here.
      inFlightTurn = null;

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
        // Same ownership rule: a turn that died some other way (LLM timeout,
        // error) must not leave itself behind for a LATER barge to record as
        // if it had just been interrupted. A barged turn's own epoch is
        // already stale here, and onInterrupt has consumed the record.
        inFlightTurn = null;
        if (queuedText) {
          const q = queuedText;
          queuedText = "";
          startTurn(q);
        }
      }
    }
  }

  /**
   * Persist the idempotent state bits of one streamed tool outcome the
   * moment it happens (a later barge can't un-happen a DB write). Non-pure
   * effects (step transition, notifications, history note) wait for
   * applyReply or salvageDurableEffects.
   */
  /** Merge a capability scratchpad patch into this call's state. */
  function mergeCapabilityState(patch) {
    if (state) mergeCapabilityStateInto(state, patch);
  }

  /**
   * Hand a capability's deferred effects to the pack that owns them, with the
   * engine primitives and call context it is allowed to see.
   *
   * @returns {string[]} history notes the caller should emit
   */
  function dispatchCapabilityEffects(effects) {
    if (!state) return [];
    return dispatchEffects(effects, {
      STEPS,
      setStep(nextStep, trigger) {
        state.step = nextStep;
        log.info("step_transition", turnCtx({ toStep: nextStep, trigger }));
      },
      setCapabilityState: mergeCapabilityState,
      call: {
        callSid,
        businessId: state.businessId,
        callId: state.dbCallId || null,
        callerNumber: state.callerNumber,
        twilioNumber: state.twilioNumber || null,
        config: state.config,
      },
      deps: { notifications, db, log, captureException },
    });
  }

  function recordDurableEffect(effect, turnEffects) {
    if (!effect || !state) return;
    turnEffects?.push(effect);
    // Capabilities own what is worth remembering; the engine only merges it.
    if (effect.capabilityState) mergeCapabilityState(effect.capabilityState);
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

    // A tool that already wrote to a system of record must still notify and
    // still leave a history note when the caller barges over the confirmation
    // sentence — the write does not un-happen because they interrupted.
    const notes = [];
    for (const e of effects) {
      if (!e.success) continue;
      notes.push(...dispatchCapabilityEffects(e.capabilityEffects));
    }
    if (notes.length > 0) {
      state.history.push(systemNoteEntry(notes));
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
    const {
      text: replyText,
      endCallArgs,
      toolResults,
      transferRequested,
    } = reply;

    // The pure reducer owns every state mutation — failure-streak reset,
    // history pushes (incl. the capability system note), intent/step transition,
    // capability merge, effects dispatch, and the end-call step change — in the
    // exact order the live session has always applied them. It stays free of
    // I/O; session.js keeps the logging (below) and the timers/transfers. The
    // eval harness (tests/) drives this same reducer so the channels can't drift.
    //
    // Effects are dispatched AFTER intentArgs inside the reducer so a completed
    // action wins the step over an intent change in the same turn — the caller
    // did the thing, and the call should reflect that rather than dropping back
    // to gathering details. (The legacy named paths disagree: a completed cancel
    // is applied before intentArgs and loses, while a completed booking is
    // applied after and wins. Migrating paths adopt the booking ordering, which
    // is the intended one.) The dispatch closure below may itself move the step
    // (logging its own step_transition); the reducer's end-call runs last and
    // wins over it.
    const { intentSet, ended } = applyReplyState(
      state,
      { userText, reply },
      { STEPS, mergeCapabilityState, dispatchEffects: dispatchCapabilityEffects }
    );

    if (toolResults?.length > 0) {
      for (const tr of toolResults) {
        log.info("tool_result", turnCtx({ tool: tr.name, success: tr.success }));
      }
    }
    if (intentSet) {
      log.info("intent_set", turnCtx({ intent: intentSet.intent, prevStep: intentSet.prevStep, newStep: intentSet.newStep }));
    }

    if (ended) {
      log.info("step_transition", turnCtx({ toStep: STEPS.ENDING, trigger: "end_call", reason: endCallArgs.reason }));
      // Close only after the goodbye audio has actually played out — the
      // turn's own completion mark is the trigger (see the mark handler).
      state.closeAfterMark = markName;
      armCloseFallback();
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
    // Read BEFORE salvaging: salvageDurableEffects consumes the array
    // (turnEffects.length = 0), so anything asking "did this turn's tools
    // actually run?" has to ask first.
    const toolsRan = Array.isArray(turnEffects) && turnEffects.length > 0;
    // The dying turn's tools may already have written to the DB (e.g. a
    // successful round-1 booking before a round-2 timeout) — persist those
    // outcomes regardless of who owns the pipeline now.
    salvageDurableEffects(turnEffects, err?.code === "LLM_TIMEOUT" ? "llm_timeout" : "llm_error");
    if (state.speakEpoch !== myEpoch) return; // barged — successor owns shared refs
    activeGenerator = null;

    // Close out this turn's metrics so its marks don't leak into the next.
    state.turnMetrics?.finishTurn({ error: true });

    // A turn that timed out AFTER its tools ran is a slow integration, not a
    // broken LLM. Counting it toward the fallback threshold meant two slow
    // lookups dropped the whole call into the deterministic take-a-message
    // script even though both tools had succeeded — the caller loses the
    // assistant over someone else's latency.
    const isTimeout = err?.code === "LLM_TIMEOUT";
    if (isTimeout && toolsRan) {
      log.info("llm_timeout_after_tool_work", turnCtx({}));
    } else {
      state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    }

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

  function startStt(language, endpointing, keyterms = []) {
    createSttStream({
      language,
      ...(endpointing != null ? { endpointing } : {}),
      ...(keyterms.length ? { keyterms } : {}),
      callSid,
      onFinal: (text) => {
        const decision = turnManager?.handleFinal(text);
        // An echo-classified final never reaches onTurnEnd, so nothing
        // downstream re-arms the silence ladder — the same invariant
        // handleCallerFinal's discard branch exists to protect. Without this
        // the call could go quiet permanently on a line that echoes.
        if (decision?.action === "ignore" && decision.reason === "echo") {
          bumpCounter("echo_suppressed_final");
          armSilenceTimer(false);
        }
      },
      onInterim: (text) => {
        // A non-empty interim is the strongest available evidence that the
        // caller is producing words right now — hold the silence ladder off.
        //
        // Two echo gates, not one. !isPlaying covers audio still in flight;
        // the echoGuard covers the window AFTER playback where the estimate
        // says "quiet" but the room does not. Without the second gate, an
        // echo interim landing just after a barge stamps the caller-speech
        // window and extends the post-barge settle indefinitely — trading the
        // stutter loop for a hold that never releases.
        const trimmed = (text || "").trim();
        const isEcho = trimmed ? !!echoGuard?.isEcho(text, performance.now()) : false;
        if (isEcho) bumpCounter("echo_suppressed_interim");
        if (trimmed && !audioOut?.isPlaying() && !isEcho) noteCallerSpeech("interim");
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
          // first_audio_sent marks when audio was handed to the pacing queue;
          // this marks when it reached Twilio. The pump deliberately holds
          // everything past LOOKAHEAD_MS back, so the two differ and the
          // difference was outside every reported latency number.
          onFirstFrameWire: () => state.turnMetrics?.mark("first_frame_wire"),
        });
        vad = createVad();
        // Content-based self-echo detection. This pipeline has no acoustic
        // echo cancellation, so on a speakerphone the AI's own voice returns
        // through the caller's mic as transcribed "caller speech" — loud
        // enough to satisfy the energy VAD. Only what was actually said can
        // tell the two apart. aiAudioPlayingUntil() gives it the window in
        // which that audio could still be bouncing around the room.
        echoGuard = createEchoGuard({
          aiAudibleUntil: () => audioOut?.aiAudioPlayingUntil?.() ?? 0,
        });
        turnManager = createTurnManager({
          vad,
          audioOut,
          echoGuard,
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
        // Boost recognition of this business's domain terms (name, custom
        // identity labels) — English calls only; buildConnectOptions drops them
        // for "multi"/non-English, so it's safe to always compute and pass.
        startStt(sttLanguage, sttLanguage === "multi" ? 100 : undefined, keytermsFromConfig(config));

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
        const greetingText = buildGreeting(config);
        // Greeting is turn 1's prosody anchor: the first real reply's TTS
        // continues from what the caller just heard. Committed from onSettled
        // (fires only if state.speakEpoch is unchanged when the greeting
        // finishes) so a caller who barges in mid-greeting — onInterrupt bumps
        // speakEpoch and aborts activeTts — does NOT leave the FULL greeting
        // as the next turn's previous_text; lastSpokenText simply stays "".
        speakText(greetingText, "greeting-done", (payload) => {
          lastSpokenText = anchorFromSettle(greetingText, payload);
        });

        // ---- Background: warm this call's voice's micro-utterance cache
        // (filler/nudges/goodbye — NOT the greeting, see above) for later in
        // this call and for whichever call comes next — never awaited, never
        // blocks pickup. Warmup failures are swallowed per-entry inside warm()
        // and never break the call: a miss simply falls through to live
        // synthesis at playback time.
        //
        // An ElevenLabs business warms its OWN voice (voiceId) via a one-shot
        // EL synthesizer so mid-call fixed lines play in that voice, not the
        // Google fallback. A Google-provider business warms its locale-matched
        // Google voice with the default backend. Keyed by voice, both live in
        // the same shared LRU without colliding.
        const warmVoice = resolveVoice(config);
        const warmEntries = buildUtteranceWarmEntries(config);
        if (warmVoice.forceFallback) {
          utteranceCache
            .warm(state.googleVoice || GOOGLE_TTS_VOICE, warmEntries)
            .catch((err) => log.error("utterance_cache_warm_failed", { callSid, reason: err?.message }));
        } else if (warmVoice.voiceId) {
          utteranceCache
            .warm(warmVoice.voiceId, warmEntries, {
              synthesize: (text, voiceId) =>
                synthesizeMulawOnce({ voiceId, text, voiceSettings: warmVoice.voiceSettings }),
            })
            .catch((err) => log.error("utterance_cache_warm_failed", { callSid, reason: err?.message }));
        }

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
        // current AND was not already closed as barged. After a barge-in,
        // audio already handed to Twilio keeps playing, so the interrupted
        // turn's mark echoes back later — and onInterrupt has already recorded
        // that turn as barged. Closing again on the stale mark emitted a junk
        // row (no LLM or TTS numbers) AND wiped the live turn's marks, so
        // every interruption corrupted two latency rows.
        //
        // The turn-id check alone is NOT sufficient. It only worked because a
        // successor turn used to start on the same tick as the barge, bumping
        // state.turnId before the stale mark arrived. The post-barge settle
        // deliberately delays that successor (see POST_BARGE_SETTLE_MS), which
        // reopens the exact window this guard exists to close — so the barged
        // turn is now identified explicitly rather than inferred from timing.
        const turnMark = /^turn-(\d+)-done$/.exec(markName);
        if (
          state &&
          turnMark &&
          Number(turnMark[1]) === state.turnId &&
          Number(turnMark[1]) !== state.bargedTurnId
        ) {
          state.turnMetrics?.finishTurn(usageExtras());
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
