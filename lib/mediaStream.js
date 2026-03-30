import * as geminiService from "../services/gemini.js";
import * as db from "../services/supabase.js";
import * as googleTts from "../services/googleTts.js";
import * as deepgram from "../services/deepgram.js";
import * as notifications from "../services/notifications.js";
import * as callState from "./callState.js";
import { STEPS } from "./callState.js";
import { log, createRequestId, recordTurnLatency } from "./logger.js";
import { captureException } from "./sentry.js";
import { escapeXml } from "./twiml.js";
import { cleanTranscript, isIncomplete, extractFinalIntent } from "./transcriptUtils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_TTS_VOICE = "en-US-Chirp3-HD-Aoede";
const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || "";
const CALL_MAX_DURATION_MS =
  (parseInt(process.env.CALL_MAX_DURATION_MINUTES, 10) || 30) * 60 * 1000;

const TRANSFER_TRIGGERS =
  /\b(representative|human|operator|real person|speak to someone|talk to someone|talk to a person|manager|supervisor)\b/i;

// Twilio Media Streams sends 20 ms chunks of mulaw at 8 kHz = 160 bytes.
// We send our TTS audio back in the same chunk size for smooth playback.
const MULAW_CHUNK_BYTES = 160;

// 150ms of µ-law silence (0xFF = quiet in G.711 µ-law) inserted between
// consecutive sentences so they don't rush together without any breath.
const INTER_SENTENCE_SILENCE = Buffer.alloc(Math.ceil(8000 * 0.15), 0xFF);

// ---------------------------------------------------------------------------
// Silence thresholds — time (ms) after AI finishes speaking before acting.
//
// Three stages per call step: nudge1 (gentle "still here"), nudge2 (simpler
// step-aware re-prompt), and hangup (graceful goodbye).  All values are
// cumulative from when the AI finished speaking, NOT from call start.
//
// Rationale for per-step differences:
//  - identify_intent / greeting: shorter — silence likely means confusion,
//    earlier re-engagement is better than letting the caller wonder
//  - gather_details: longer — caller may be recalling a date, phone number,
//    or insurance details; interrupting early feels pushy
//  - confirm: medium — caller is processing/deciding, just needs patience
//
// Tune these values here; avoid changing them inline downstream.
// ---------------------------------------------------------------------------
const SILENCE_THRESHOLDS = {
  greeting:        { nudge1:  6_000, nudge2: 12_000, hangup: 20_000 },
  identify_intent: { nudge1:  6_000, nudge2: 12_000, hangup: 20_000 },
  gather_details:  { nudge1: 10_000, nudge2: 18_000, hangup: 28_000 },
  confirm:         { nudge1:  8_000, nudge2: 15_000, hangup: 24_000 },
  ending:          { nudge1:  4_000, nudge2:  8_000, hangup: 12_000 },
};
// Fallback used when state.step is unrecognised
const SILENCE_THRESHOLDS_DEFAULT = { nudge1: 8_000, nudge2: 15_000, hangup: 24_000 };

// How long to wait before re-checking whether the AI is still speaking.
// Prevents silence events from firing mid-AI-response.
const SILENCE_RETRY_MS = 2_000;

// Barge-in: set to true to re-enable interrupting AI mid-response when user speaks.
// Currently disabled while other reliability issues are being fixed.
const BARGE_IN_ENABLED = true;

// ---------------------------------------------------------------------------
// Helpers
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
 * Send a mulaw audio buffer to Twilio over WebSocket in 160-byte chunks.
 * After the last chunk, send a mark event so we know when playback finishes.
 */
function streamAudioToTwilio(state, mulawBuffer, markName) {
  if (!state.ws || state.ws.readyState !== 1) {
    log.debug("audio_stream_error", { callSid: state?.callSid, reason: "ws_not_ready", readyState: state?.ws?.readyState });
    return;
  }

  const chunks = Math.ceil(mulawBuffer.length / MULAW_CHUNK_BYTES);
  log.debug("audio_stream_sent", { callSid: state?.callSid, markName, chunks, bytes: mulawBuffer.length });

  for (let offset = 0; offset < mulawBuffer.length; offset += MULAW_CHUNK_BYTES) {
    const chunk = mulawBuffer.subarray(offset, offset + MULAW_CHUNK_BYTES);
    state.ws.send(JSON.stringify({
      event: "media",
      streamSid: state.streamSid,
      media: { payload: chunk.toString("base64") },
    }));
  }

  // Send a mark so Twilio notifies us when the audio finishes playing
  if (markName) {
    state.ws.send(JSON.stringify({
      event: "mark",
      streamSid: state.streamSid,
      mark: { name: markName },
    }));
  }
}

/** Clear all buffered audio on the Twilio side (barge-in). */
function clearTwilioAudio(state) {
  if (!state.ws || state.ws.readyState !== 1 || !state.streamSid) return;
  state.ws.send(JSON.stringify({ event: "clear", streamSid: state.streamSid }));
}

/** Fire-and-forget transcript logging. */
function logTranscript(state, callerText, aiText) {
  if (!state.dbCallId) return;
  const seq = state.sequenceCounter;
  state.sequenceCounter += 2;
  db.addTranscriptEntry(state.dbCallId, "caller", callerText, seq).catch(() => {});
  db.addTranscriptEntry(state.dbCallId, "ai", aiText, seq + 1).catch(() => {});
}

// ---------------------------------------------------------------------------
// Sentence accumulator — split streaming text into TTS-ready sentences
// ---------------------------------------------------------------------------

const ABBREV_RE = /\b(Dr|Mr|Mrs|Ms|St|Jr|Sr|Prof)\.\s+/g;

function createSentenceAccumulator(onSentence) {
  let buffer = "";
  const SENTINEL = "\x01";

  return {
    /** Feed new text delta into the accumulator. */
    push(delta) {
      buffer += delta;
      // Mask abbreviation dots so they don't trigger false splits
      const masked = buffer.replace(ABBREV_RE, (m) => m.replace(/\.\s+/, SENTINEL));
      const match = masked.match(/^(.*?[.!?])\s+([\s\S]*)$/);
      if (match) {
        const sentence = match[1].replace(new RegExp(SENTINEL, "g"), ". ").trim();
        buffer = match[2].replace(new RegExp(SENTINEL, "g"), ". ");
        if (sentence) onSentence(sentence);
      }
    },
    /** Flush remaining buffered text as a final sentence. */
    flush() {
      const rest = buffer.replace(new RegExp(SENTINEL, "g"), ". ").trim();
      buffer = "";
      if (rest) onSentence(rest);
    },
  };
}

// ---------------------------------------------------------------------------
// Core: handle one incoming Media Streams WebSocket connection
// ---------------------------------------------------------------------------

/**
 * Entry point called by server.js when Twilio opens a WebSocket.
 * Manages the full lifecycle of one phone call over Media Streams.
 *
 * @param {import("ws").WebSocket} ws
 * @param {import("http").IncomingMessage} req
 */
export async function handleMediaStreamConnection(ws, req) {
  let callSid = null;
  let state = null;
  let silenceTimer = null;
  let silenceStage = 0; // 0 = none, 1 = warned, 2 = hanging up
  let callDurationTimer = null;

  // Transcript debounce — accumulates Deepgram speech_final fragments before
  // firing onTranscript. Complete sentences (terminal .!?) get a 100ms buffer.
  // Incomplete phrases (no terminal punct) are held silently until UtteranceEnd
  // fires (≥1s of silence), preventing responses to mid-sentence thinking pauses
  // and filler words ("uh", "um", brief silence while choosing words).
  let pendingTranscriptText = "";
  let transcriptDebounceTimer = null;

  // Speech that arrived while processingTurn=true. Processed as one turn after
  // the current turn finishes, so nothing the user says gets lost.
  let queuedTranscriptText = "";

  // ------------------------------------------------------------------
  // Utility: synthesize + stream one sentence of AI speech.
  // Captures the speak-epoch at call time; if barge-in fires and
  // increments the epoch before synthesis completes, the audio is
  // silently discarded rather than sent to Twilio.
  // ------------------------------------------------------------------
  async function speakSentence(text, markName) {
    log.debug("tts_request", { callSid, text: text.slice(0, 80), charCount: text.length });
    const epoch = state.speakEpoch;
    // While AI is speaking, don't count silence (clear any pending nudge timer).
    // The silence clock will restart when this speech completes (mark event).
    clearTimeout(silenceTimer);
    try {
      const ttsStart = Date.now();
      const audio = await googleTts.synthesizeMulaw(text, GOOGLE_TTS_VOICE, callSid);
      const ttsLatency = Date.now() - ttsStart;
      log.debug("tts_complete", { callSid, latencyMs: ttsLatency, audioBytes: audio.length });
      if (ttsLatency > 1000) {
        log.error("tts_slow", { callSid, latencyMs: ttsLatency, text: text.slice(0, 80) });
      }
      if (state.speakEpoch !== epoch) {
        log.debug("tts_cancelled_barge_in", { callSid, epoch, currentEpoch: state.speakEpoch });
        return;
      }
      streamAudioToTwilio(state, audio, markName);
    } catch (err) {
      log.error("tts_error", { callSid, text: text.slice(0, 80), error: err.message });
      captureException(err, { callSid, context: "speakSentence" });
    }
  }

  // ------------------------------------------------------------------
  // Utility: speak a full string (non-streaming convenience).
  // Uses a "-done" mark suffix so the mark handler resets aiSpeaking
  // once Twilio has actually finished playing the audio.
  // ------------------------------------------------------------------
  async function speakFull(text, markName) {
    state.aiSpeaking = true;
    const mark = markName ? `${markName}-done` : `speak-${state.turnId}-done`;
    await speakSentence(text, mark);
  }

  // ------------------------------------------------------------------
  // Silence nudge text builders
  // ------------------------------------------------------------------

  /**
   * Return the text to speak at each silence stage.
   *
   * Stage 1 is always a neutral "still here" message — the caller may simply
   * be thinking and does not need to be re-prompted yet.
   *
   * Stage 2 is step-aware: it restates what's needed more simply, with a
   * concrete example, without repeating the AI's previous question verbatim
   * (which sounds robotic if the caller heard it fine the first time).
   */
  function buildSilenceNudge(stage, step, intent) {
    if (stage === 1) {
      return "I'm still here whenever you're ready.";
    }
    // Stage 2 — simpler, step-specific, with a concrete hint
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

  /**
   * Build the goodbye message when ending a call after repeated silence.
   * Includes the business's callback number when available so the caller
   * knows how to reach someone directly.
   */
  function buildSilenceGoodbye(cfg) {
    const phone = cfg?.transferPhoneNumber || cfg?.phone || "";
    if (phone) {
      return `It seems like you may have stepped away. Feel free to call us back at ${phone} anytime. Goodbye!`;
    }
    return "It seems like you may have stepped away. Feel free to call us back anytime. Goodbye!";
  }

  // ------------------------------------------------------------------
  // Reset silence timer (called after each transcript)
  // ------------------------------------------------------------------
  function resetSilenceTimer(trigger = "mark_playback_complete") {
    silenceStage = 0;
    clearTimeout(silenceTimer);
    const step = state?.step || STEPS.GREETING;
    const thresholds = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    log.debug("silence_timer_start", {
      callSid,
      threshold1Ms: thresholds.nudge1,
      threshold2Ms: thresholds.nudge2,
      threshold3Ms: thresholds.hangup,
    });
    log.debug("silence_timer_reset", { callSid, trigger });
    silenceTimer = setTimeout(() => onSilence(), thresholds.nudge1);
  }

  async function onSilence() {
    if (!state || state.aiSpeaking || state.processingTurn) {
      // AI is still talking or processing — this is not caller silence.
      // Reschedule the check without advancing the stage.
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => onSilence(), SILENCE_RETRY_MS);
      return;
    }

    const step = state.step || STEPS.GREETING;
    const thresholds = SILENCE_THRESHOLDS[step] ?? SILENCE_THRESHOLDS_DEFAULT;
    silenceStage++;

    if (silenceStage === 1) {
      // First nudge: neutral and non-intrusive. Caller may just be thinking.
      // Do NOT repeat the previous question — that sounds robotic if they heard it fine.
      const nudgeText = buildSilenceNudge(1, step, state.intent);
      log.info("silence_nudge", { callSid, nudgeNumber: 1, text: nudgeText, step, intent: state.intent });
      await speakFull(nudgeText);
      clearTimeout(silenceTimer);
      // Wait for the delta between nudge1 and nudge2 thresholds before stage 2
      silenceTimer = setTimeout(() => onSilence(), thresholds.nudge2 - thresholds.nudge1);
    } else if (silenceStage === 2) {
      // Second nudge: step-aware re-prompt with a concrete hint.
      // Simpler than the original question to help a confused caller.
      const nudgeText = buildSilenceNudge(2, step, state.intent);
      log.info("silence_nudge", { callSid, nudgeNumber: 2, text: nudgeText, step, intent: state.intent });
      await speakFull(nudgeText);
      clearTimeout(silenceTimer);
      // Wait for the delta between nudge2 and hangup thresholds before stage 3
      silenceTimer = setTimeout(() => onSilence(), thresholds.hangup - thresholds.nudge2);
    } else {
      // Stage 3: caller has not responded after two nudges — end gracefully.
      // Log the silence hangup so the business can follow up if needed.
      log.info("silence_hangup", { callSid, nudgesSent: 2, step, intent: state.intent });
      state.step = STEPS.ENDING;
      const goodbyeText = buildSilenceGoodbye(state.config);
      await speakFull(goodbyeText);
      setTimeout(() => ws.close(), 3_000); // allow audio to finish before closing
    }
  }

  // ------------------------------------------------------------------
  // Transcript debounce — called by Deepgram on each speech_final event.
  // Accumulates fragments and waits before firing onTranscript so we
  // don't respond mid-sentence when the user pauses briefly.
  //
  //   Complete sentence (ends in . ! ?): 100 ms wait  — near-instant
  //   Incomplete phrase (no terminal punct): 400 ms wait — collect more
  //
  // UtteranceEnd (1 s of silence) bypasses the timer entirely via
  // flushPendingTranscript(), ensuring we never delay longer than needed.
  // ------------------------------------------------------------------
  function enqueueTranscript(text) {
    pendingTranscriptText = pendingTranscriptText
      ? pendingTranscriptText + " " + text
      : text;

    // Reset silence timer whenever user speaks — even filler words like "ummm"
    // prevent the nudge from firing while they're thinking/formulating their response.
    resetSilenceTimer();

    const isComplete = /[.!?]$/.test(pendingTranscriptText.trim());

    if (isComplete) {
      // Sentence clearly finished — fire after a very short buffer (catches
      // any trailing words Deepgram sends in a follow-on event).
      clearTimeout(transcriptDebounceTimer);
      transcriptDebounceTimer = setTimeout(() => {
        transcriptDebounceTimer = null;
        const finalText = pendingTranscriptText.trim();
        pendingTranscriptText = "";
        if (finalText) onTranscript(finalText);
      }, 100);
    }
    // Incomplete phrase: no timer started. We wait for UtteranceEnd (≥1s silence)
    // to call flushPendingTranscript(). This means filler words, thinking pauses,
    // and mid-sentence speech_final events never trigger a premature AI response.
  }

  /** Immediately process any pending transcript (called on UtteranceEnd). */
  function flushPendingTranscript() {
    if (!transcriptDebounceTimer && !pendingTranscriptText) return;
    clearTimeout(transcriptDebounceTimer);
    transcriptDebounceTimer = null;
    const finalText = pendingTranscriptText.trim();
    pendingTranscriptText = "";
    // Only respond if there is at least one complete sentence (terminal punctuation).
    // Filler words, thinking pauses, and partial phrases are silently discarded.
    if (finalText && /[.!?]/.test(finalText)) onTranscript(finalText);
  }

  // ------------------------------------------------------------------
  // Barge-in handler (Deepgram detected speech while AI is talking)
  // ------------------------------------------------------------------
  function onBargeIn() {
    if (!state.aiSpeaking) return;
    state.speakEpoch++;         // invalidate any in-flight TTS synthesis
    state.bargedIn = true;
    state.aiSpeaking = false;
    state.audioQueue = [];
    clearTwilioAudio(state);
    log.debug("barge_in", { callSid, detected: true, allowed: BARGE_IN_ENABLED, reason: "ai_was_speaking" });
  }

  // ------------------------------------------------------------------
  // Process a Deepgram final transcript — the main turn handler
  // ------------------------------------------------------------------
  async function onTranscript(text) {
    if (!state || !text) return;

    log.debug("transcript_received", { callSid, text, wordCount: text.split(/\s+/).length });

    // ---- Transcript quality pipeline ----
    // Stage 1: Strip filler words and STT artifacts. Null = nothing actionable.
    const cleaned = cleanTranscript(text);
    if (!cleaned) {
      log.debug("transcript_discarded", { callSid, reason: "filler_only", raw: text.slice(0, 60), silenceTimerReset: false });
      return;
    }
    // Stage 2: Incomplete utterance check. If the cleaned text ends mid-thought
    // (trailing conjunction, partial phone number, partial date), re-queue it as
    // pending text so the next UtteranceEnd flush can combine it with the rest.
    // This supplements the terminal-punctuation check in enqueueTranscript().
    if (isIncomplete(cleaned)) {
      pendingTranscriptText = pendingTranscriptText
        ? pendingTranscriptText + " " + cleaned
        : cleaned;
      log.debug("transcript_held", { callSid, reason: "incomplete_utterance", text: cleaned.slice(0, 60) });
      return;
    }
    // Stage 3: Self-correction — discard everything before correction markers
    // ("actually", "I mean", "wait", "no,") and keep only the final intent.
    text = extractFinalIntent(cleaned);
    // ---- End transcript quality pipeline ----

    // When barge-in is disabled, don't interrupt the AI mid-sentence.
    // Queue the transcript and process it once the AI finishes speaking
    // (the mark handler drains queuedTranscriptText after each -done event).
    if (!BARGE_IN_ENABLED && state.aiSpeaking) {
      queuedTranscriptText = queuedTranscriptText
        ? queuedTranscriptText + " " + text
        : text;
      log.debug("transcript_queued", { callSid, reason: "ai_speaking_barge_in_disabled", text: text.slice(0, 60) });
      return;
    }

    // Barge-in enabled: interrupt AI mid-sentence when user speaks.
    if (BARGE_IN_ENABLED && state.aiSpeaking) {
      onBargeIn();
    }

    // If a turn is already in flight, queue this text so nothing is lost.
    // The queued text is processed as the next turn once the current one finishes.
    if (state.processingTurn) {
      queuedTranscriptText = queuedTranscriptText
        ? queuedTranscriptText + " " + text
        : text;
      log.debug("transcript_queued", { callSid, reason: "processing_in_flight", text: text.slice(0, 60) });
      return;
    }

    resetSilenceTimer("processed_transcript");
    state.bargedIn = false;
    state.processingTurn = true;
    state.callStartTime = state.callStartTime || Date.now();

    const requestId = createRequestId();
    const config = state.config;

    log.debug("turn_start", {
      callSid,
      requestId,
      step: state.step,
      intent: state.intent,
      slots: {
        name: state.collectedName ?? null,
        phone: state.collectedPhone ?? null,
        date: state.collectedDate ?? null,
        service: state.collectedService ?? null,
      },
      attempts: state.attemptCount ?? 0,
      lastSentiment: state.lastSentiment ?? null,
    });

    // ---- Hard time-limit check ----
    if (Date.now() - state.startedAt > CALL_MAX_DURATION_MS) {
      const msg = "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!";
      logTranscript(state, text, msg);
      state.step = STEPS.ENDING;
      state.processingTurn = false;
      await speakFull(msg);
      setTimeout(() => ws.close(), 4000);
      return;
    }

    // ---- If we already ended, just hang up ----
    if (state.step === STEPS.ENDING) {
      state.processingTurn = false;
      ws.close();
      return;
    }

    // ---- Escape-trigger check (transfer) ----
    if (TRANSFER_TRIGGERS.test(text)) {
      const transferNumber = config.transferPhoneNumber || TRANSFER_NUMBER;
      const canTransfer = !!transferNumber && resolveTransferAllowed(config);
      log.info("transfer_requested", { callSid, requestId, canTransfer });

      if (canTransfer) {
        const msg = "Transferring you now. Please hold.";
        logTranscript(state, text, msg);
        state.step = STEPS.ENDING;
        state.processingTurn = false;
        await speakFull(msg);
        // Transfer via Twilio REST API (Media Streams doesn't support <Dial>)
        try {
          const twilio = (await import("twilio")).default;
          const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.calls(callSid).update({
            twiml: `<Response><Dial>${escapeXml(transferNumber)}</Dial></Response>`,
          });
          log.info("transfer_outcome", { callSid, requestId, success: true, reason: "ok" });
        } catch (err) {
          log.error("transfer_outcome", { callSid, requestId, success: false, reason: err?.message });
          captureException(err, { callSid });
        }
        return;
      }
      const msg = "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.";
      logTranscript(state, text, msg);
      state.processingTurn = false;
      await speakFull(msg);
      return;
    }

    // ---- Stream Gemini → TTS → Twilio ----
    const geminiStart = Date.now();
    state.turnId++;
    const turnId = state.turnId;

    // Clear any audio Twilio still has buffered from the previous turn.
    // Each user utterance starts a clean slate — no old responses pile up.
    clearTwilioAudio(state);

    try {
      state.aiSpeaking = true;
      let sentenceIndex = 0;

      // Sentences must reach Twilio in order. We chain each sentence's
      // synthesize+send onto the previous one so they're serialized even
      // though the Gemini generator keeps yielding concurrently.
      let sentenceSendChain = Promise.resolve();

      const accumulator = createSentenceAccumulator((sentence) => {
        sentenceIndex++;
        log.debug("gemini_sentence_ready", { callSid, requestId, sentenceIndex, text: sentence.slice(0, 80) });
        const addPause = sentenceIndex > 1; // brief breath before 2nd+ sentences
        const mark = `turn-${turnId}-s${sentenceIndex}`;
        const thisPromise = sentenceSendChain.then(async () => {
          if (addPause && !state.bargedIn) {
            streamAudioToTwilio(state, INTER_SENTENCE_SILENCE, null);
          }
          await speakSentence(sentence, mark);
        });
        sentenceSendChain = thisPromise;
        state.audioQueue.push(thisPromise);
      });

      let reply = null;
      let firstChunk = true;
      const geminiStart = Date.now();
      log.info("gemini_api_call", {
        callSid,
        requestId,
        step: state.step,
        intent: state.intent,
        approxInputTokens: Math.ceil(JSON.stringify(state.history).length / 4),
      });

      for await (const chunk of geminiService.getReplyStreaming(
        state.history, text, state.step, state.intent, config, {
          knowledge: state.knowledge || [],
          transferAllowed: resolveTransferAllowed(config),
          integrations: state.integrations || [],
          businessId: state.businessId || null,
          callerPhone: state.callerNumber || null,
          callId: state.dbCallId || null,
          selectedAppointmentId: state.selectedAppointmentId || null,
          callerContext: state.callerContext || null,
        }
      )) {
        if (state.bargedIn) break;

        if (chunk.delta) {
          if (firstChunk) {
            log.debug("gemini_first_chunk", { callSid, requestId, timeToFirstChunkMs: Date.now() - geminiStart });
            firstChunk = false;
          }
          log.debug("gemini_chunk", { callSid, requestId, delta: chunk.delta.slice(0, 40) });
          accumulator.push(chunk.delta);
        }
        if (chunk.done) {
          reply = chunk.reply;
        }
      }

      // Flush remaining text
      if (!state.bargedIn) {
        accumulator.flush();
      }

      // Wait for all queued TTS to finish sending
      log.debug("gemini_waiting_tts", { callSid, requestId, queueLength: state.audioQueue.length });
      await Promise.all(state.audioQueue);
      state.audioQueue = [];
      const totalLatency = Date.now() - geminiStart;
      log.info("gemini_response_complete", { callSid, requestId, sentenceCount: sentenceIndex, totalLatencyMs: totalLatency });
      if (totalLatency > 4000) {
        log.error("gemini_slow", { callSid, requestId, latencyMs: totalLatency });
      }

      // Send a final mark to know when all audio has played out
      if (state.ws?.readyState === 1 && !state.bargedIn) {
        state.ws.send(JSON.stringify({
          event: "mark",
          streamSid: state.streamSid,
          mark: { name: `turn-${turnId}-done` },
        }));
      }

      if (!reply) {
        // Generator was interrupted (barge-in) before yielding done
        state.aiSpeaking = false;
        return;
      }

      const { text: replyText, appointmentArgs, intentArgs, endCallArgs, customerRequestArgs, toolResults, selectedAppointmentId } = reply;
      const turnLatencyMs = Date.now() - geminiStart;

      // -- Update conversation history --
      state.history.push({ role: "user", parts: [{ text }] });
      state.history.push({ role: "model", parts: [{ text: replyText }] });

      // -- Tool call results → state transitions --
      if (toolResults?.length > 0) {
        for (const tr of toolResults) log.info("tool_result", { callSid, requestId, tool: tr.name, success: tr.success, reason: tr.success ? "ok" : (tr.error ?? "unknown") });
      }
      if (selectedAppointmentId != null) state.selectedAppointmentId = selectedAppointmentId;
      if (toolResults?.some((tr) => tr.name === "cancel_appointment_db" && tr.success)) state.selectedAppointmentId = null;

      if (intentArgs) {
        const prevStep = state.step;
        state.intent = intentArgs.intent;
        if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) state.step = STEPS.GATHER_DETAILS;
        log.info("intent_set", { callSid, requestId, intent: intentArgs.intent, prevStep, newStep: state.step });
      }

      if (appointmentArgs && state.businessId) {
        state.step = STEPS.CONFIRM;
        const notes = [appointmentArgs.service_type, appointmentArgs.notes].filter(Boolean).join(" — ") || null;
        notifications.notifyAppointmentBooked({
          businessId: state.businessId,
          appointment: { scheduled_at: appointmentArgs.scheduled_at, client_name: appointmentArgs.client_name || null, client_phone: state.callerNumber || null, notes },
          call: { callerNumber: state.callerNumber, twilioNumber: state.twilioNumber || null },
        }).catch(() => {});
      }

      if (endCallArgs) {
        state.step = STEPS.ENDING;
        log.info("step_transition", { callSid, requestId, fromStep: STEPS.GATHER_DETAILS, toStep: STEPS.ENDING, trigger: "end_call", reason: endCallArgs.reason });
        // Allow audio to play out, then close
        setTimeout(() => ws.close(), 4000);
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
          if (id) notifications.notifyCustomerRequest({
            businessId: state.businessId,
            customerRequest: customerRequestArgs,
            call: { callerNumber: state.callerNumber },
          }).catch(() => {});
        }).catch((err) => captureException(err, { callSid }));
      }

      logTranscript(state, text, replyText);
      log.info("turn_completed", { callSid, requestId, step: state.step, intent: state.intent, turn_latency_ms: turnLatencyMs });
      recordTurnLatency(state.businessId, turnLatencyMs);

    } catch (err) {
      state.aiSpeaking = false;
      const isTimeout = err?.message === "TURN_TIMEOUT";
      log.error("gemini_error", { callSid, requestId, message: isTimeout ? "Gemini turn timeout" : err?.message, code: isTimeout ? "gemini_timeout" : "gemini_error" });
      captureException(err, { callSid, requestId });

      const errMsg = isTimeout
        ? "Sorry, I'm taking a bit longer. Could you repeat that?"
        : "Sorry, I'm having a technical issue. Could you repeat that?";
      await speakFull(errMsg);
    } finally {
      if (state) {
        state.processingTurn = false;
        // If the user spoke while we were busy, process it now as the next turn.
        const queued = queuedTranscriptText;
        queuedTranscriptText = "";
        if (queued) onTranscript(queued);
      }
    }
  }

  // ------------------------------------------------------------------
  // WebSocket message handler — dispatches Twilio Media Stream events
  // ------------------------------------------------------------------
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      // ---- Connection established ----
      case "connected":
        log.info("media_stream_connected", {});
        break;

      // ---- Stream started — initialize call state ----
      case "start": {
        const startData = msg.start || {};
        callSid = startData.callSid;
        const streamSid = startData.streamSid;
        const customParams = startData.customParameters || {};
        const businessPhone = customParams.businessPhone || "";
        const callerPhone = customParams.callerPhone || "";

        log.info("media_stream_start", { callSid, streamSid, businessPhone, callerPhone });

        // Initialize call state (reuse existing if status callback hasn't cleaned up yet)
        state = callState.getState(callSid);
        state.ws = ws;
        state.streamSid = streamSid;
        state.mediaStream = true;
        state.callerNumber = callerPhone;
        state.twilioNumber = businessPhone;

        // ---- Load business config (same as webhook path) ----
        if (!state.config) {
          let business = null;
          if (db.isEnabled()) {
            business = await db.lookupBusinessByPhone(businessPhone);
            if (business) {
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
              state.knowledge = knowledge;
              state.integrations = integrations;
              state.callerContext = callerContext;
            } else {
              log.error("no_business_found", { callSid, businessPhone, severity: "warn" });
            }
          }
          state.config = db.loadConfig(business);
          if (!state.knowledge) state.knowledge = [];
          if (!state.integrations) state.integrations = [];
        }

        const config = state.config;

        // ---- Open Deepgram STT connection ----
        const dgLang = Array.isArray(config.languagesSpoken) && config.languagesSpoken[0]
          ? (config.languagesSpoken[0].includes("-") ? config.languagesSpoken[0] : config.languagesSpoken[0] + "-US")
          : "en-US";

        state.deepgramConn = await deepgram.createStream({
          language: dgLang,
          callSid,
          // Route through debounce: collects fragments before firing onTranscript
          onTranscript: enqueueTranscript,
          // Flush debounce immediately on UtteranceEnd (≥1s of silence confirmed)
          onUtteranceEnd: flushPendingTranscript,
          // SpeechStarted is NOT used for barge-in — it fires on the AI's own
          // audio echoing back through the caller's mic and causes false triggers.
          // Barge-in is instead triggered at the top of onTranscript when aiSpeaking.
          onSpeechStart: () => {},
          onError: (err) => log.error("deepgram_error", { callSid, message: err?.message }),
          onClose: () => log.debug("deepgram_closed", { callSid }),
        });

        // ---- Speak greeting ----
        state.step = STEPS.IDENTIFY_INTENT;
        let greetingText = "";
        if (config.recordingDisclosureEnabled) {
          greetingText = (config.recordingDisclosureText || "This call may be recorded for quality and training purposes.") + " ";
        }

        const isDefaultGreeting = !config._hasCustomGreeting;
        if (isDefaultGreeting) {
          const tz = config.timezone || "America/Chicago";
          const hour = parseInt(
            new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }).split(":")[0], 10
          );
          const tod = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
          greetingText += `${tod}! ${config.greeting}`;
        } else {
          greetingText += config.greeting;
        }

        // Track call start time for final logging
        state.callStartTime = Date.now();

        log.info("call_started", {
          callSid,
          callerNumber: callerPhone,
          businessName: config.businessName || "Unknown",
          configLoaded: !!config,
          recordingDisclosure: config.recordingDisclosureEnabled ?? false,
          businessOpen: geminiService.isBusinessOpen(config),
          afterHoursPolicy: config.afterHoursPolicy ?? "none",
        });
        await speakFull(greetingText, "greeting");

        // Start silence timer
        resetSilenceTimer("call_start");

        // Hard call-duration limit
        callDurationTimer = setTimeout(async () => {
          if (state.step === STEPS.ENDING) return;
          const msg = "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!";
          state.step = STEPS.ENDING;
          await speakFull(msg);
          setTimeout(() => ws.close(), 4000);
        }, CALL_MAX_DURATION_MS);
        break;
      }

      // ---- Audio data from caller → forward to Deepgram ----
      case "media": {
        if (!state?.deepgramConn) break;
        const payload = msg.media?.payload;
        if (!payload) break;
        const audioBuffer = Buffer.from(payload, "base64");
        deepgram.sendAudio(state.deepgramConn, audioBuffer);
        break;
      }

      // ---- Mark event — Twilio finished playing queued audio ----
      case "mark": {
        const markName = msg.mark?.name || "";
        log.info("playback_complete", { callSid, markName });
        if (markName.endsWith("-done")) {
          if (state) {
            state.aiSpeaking = false;
            // Restart the silence clock from *now* (when AI audio actually ended,
            // not when onSilence() scheduled the nudge).  Do NOT call
            // resetSilenceTimer() — that resets silenceStage to 0 and would break
            // the multi-stage escalation (nudge1 → nudge2 → hangup).
            // Instead, compute the correct interval for the current stage.
            clearTimeout(silenceTimer);
            if (silenceStage === 0) {
              // Normal conversation: full nudge1 interval from end of AI response.
              resetSilenceTimer("mark_playback_complete");
            } else {
              // Mid-escalation: re-arm for the remaining interval of this stage.
              const _step = state?.step || STEPS.GREETING;
              const _t = SILENCE_THRESHOLDS[_step] ?? SILENCE_THRESHOLDS_DEFAULT;
              const delayMs = silenceStage === 1
                ? _t.nudge2 - _t.nudge1   // waiting between nudge1 and nudge2
                : _t.hangup - _t.nudge2;  // waiting between nudge2 and hangup
              log.debug("silence_timer_reset", { callSid, trigger: "mark_playback_complete" });
              silenceTimer = setTimeout(() => onSilence(), delayMs);
            }

            // Drain any transcript that arrived while barge-in was disabled.
            if (!state.processingTurn && queuedTranscriptText) {
              const queued = queuedTranscriptText;
              queuedTranscriptText = "";
              onTranscript(queued);
            }
          }
        }
        break;
      }

      // ---- Stream stopped — call ended ----
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

  // ------------------------------------------------------------------
  // WebSocket close / error
  // ------------------------------------------------------------------
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
    log.info("call_ended", {
      callSid,
      reason: "error",
      durationMs: state?.callStartTime ? Date.now() - state.callStartTime : 0,
      finalOutcome: state?.intent ?? "no_outcome",
    });
    captureException(err, { callSid });
    cleanup();
  });

  // ------------------------------------------------------------------
  // Cleanup — close Deepgram, clear timers, remove state
  // ------------------------------------------------------------------
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;

    clearTimeout(silenceTimer);
    clearTimeout(callDurationTimer);
    clearTimeout(transcriptDebounceTimer);
    pendingTranscriptText = "";
    queuedTranscriptText = "";

    if (state?.deepgramConn) {
      deepgram.closeStream(state.deepgramConn);
      state.deepgramConn = null;
    }

    // Note: don't remove callState here — the /twilio/status callback will
    // handle DB updates (summary, sentiment, outcome) and then remove state.
  }
}
