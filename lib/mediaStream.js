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

// Silence timers
const SILENCE_PROMPT_MS = 10_000;  // 10 s of silence → "Are you still there?"
const SILENCE_HANGUP_MS = 20_000;  // 20 s total → hang up

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
  if (!state.ws || state.ws.readyState !== 1) return;

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

  // ------------------------------------------------------------------
  // Utility: synthesize + stream one sentence of AI speech.
  // Captures the speak-epoch at call time; if barge-in fires and
  // increments the epoch before synthesis completes, the audio is
  // silently discarded rather than sent to Twilio.
  // ------------------------------------------------------------------
  async function speakSentence(text, markName) {
    const epoch = state.speakEpoch;
    try {
      const audio = await googleTts.synthesizeMulaw(text, GOOGLE_TTS_VOICE);
      if (state.speakEpoch !== epoch) return; // barge-in cancelled this speech
      streamAudioToTwilio(state, audio, markName);
    } catch (err) {
      log("error", { callSid, message: "TTS synthesis failed", code: "tts_error", detail: err?.message });
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
  // Reset silence timer (called after each transcript)
  // ------------------------------------------------------------------
  function resetSilenceTimer() {
    silenceStage = 0;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => onSilence(), SILENCE_PROMPT_MS);
  }

  async function onSilence() {
    if (!state || state.aiSpeaking) {
      // Don't count silence while AI is talking
      silenceTimer = setTimeout(() => onSilence(), SILENCE_PROMPT_MS);
      return;
    }
    silenceStage++;
    if (silenceStage === 1) {
      await speakFull("Are you still there?");
      silenceTimer = setTimeout(() => onSilence(), SILENCE_HANGUP_MS - SILENCE_PROMPT_MS);
    } else {
      // 2nd silence → hang up
      await speakFull("It seems like you may have stepped away. Goodbye!");
      state.step = STEPS.ENDING;
      setTimeout(() => ws.close(), 3000); // allow audio to play out
    }
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
    log("barge_in", { callSid });
  }

  // ------------------------------------------------------------------
  // Process a Deepgram final transcript — the main turn handler
  // ------------------------------------------------------------------
  async function onTranscript(text) {
    if (!state || !text) return;

    // If the AI is currently speaking, treat this as a barge-in.
    // We do NOT use the Deepgram SpeechStarted event for barge-in because it
    // fires on the AI's own audio echoing back through the caller's mic.
    if (state.aiSpeaking) {
      onBargeIn();
    }

    // Drop duplicate / overlapping turns while one is already in flight.
    if (state.processingTurn) {
      log("transcript_dropped", { callSid, reason: "processing_in_flight", text: text.slice(0, 60) });
      return;
    }

    resetSilenceTimer();
    state.bargedIn = false;
    state.processingTurn = true;

    const requestId = createRequestId();
    const config = state.config;

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
      log("transfer_requested", { callSid, requestId, transferred: canTransfer });

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
        } catch (err) {
          log("error", { callSid, message: "Transfer failed", code: "transfer_error" });
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
      await Promise.all(state.audioQueue);
      state.audioQueue = [];

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
        for (const tr of toolResults) log("tool_called", { callSid, requestId, tool: tr.name, success: tr.success });
      }
      if (selectedAppointmentId != null) state.selectedAppointmentId = selectedAppointmentId;
      if (toolResults?.some((tr) => tr.name === "cancel_appointment_db" && tr.success)) state.selectedAppointmentId = null;

      if (intentArgs) {
        const prevStep = state.step;
        state.intent = intentArgs.intent;
        if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) state.step = STEPS.GATHER_DETAILS;
        log("intent_set", { callSid, requestId, intent: intentArgs.intent, prevStep, newStep: state.step });
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
        log("step_transition", { callSid, requestId, newStep: STEPS.ENDING, reason: endCallArgs.reason });
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
      log("turn_completed", { callSid, requestId, step: state.step, intent: state.intent, turn_latency_ms: turnLatencyMs });
      recordTurnLatency(state.businessId, turnLatencyMs);

    } catch (err) {
      state.aiSpeaking = false;
      const isTimeout = err?.message === "TURN_TIMEOUT";
      log("error", { callSid, requestId, message: isTimeout ? "Gemini turn timeout" : err?.message, code: isTimeout ? "gemini_timeout" : "gemini_error" });
      captureException(err, { callSid, requestId });

      const errMsg = isTimeout
        ? "Sorry, I'm taking a bit longer. Could you repeat that?"
        : "Sorry, I'm having a technical issue. Could you repeat that?";
      await speakFull(errMsg);
    } finally {
      if (state) state.processingTurn = false;
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
        log("media_stream_connected", {});
        break;

      // ---- Stream started — initialize call state ----
      case "start": {
        const startData = msg.start || {};
        callSid = startData.callSid;
        const streamSid = startData.streamSid;
        const customParams = startData.customParameters || {};
        const businessPhone = customParams.businessPhone || "";
        const callerPhone = customParams.callerPhone || "";

        log("media_stream_start", { callSid, streamSid, businessPhone, callerPhone });

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
              log("warn", { message: `No business found for ${businessPhone}`, code: "no_business" });
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
          onTranscript,
          // SpeechStarted is NOT used for barge-in — it fires on the AI's own
          // audio echoing back through the caller's mic and causes false triggers.
          // Barge-in is instead triggered at the top of onTranscript when aiSpeaking.
          onSpeechStart: () => {},
          onError: (err) => log("error", { callSid, message: "Deepgram error", code: "deepgram", detail: err?.message }),
          onClose: () => log("deepgram_closed", { callSid }),
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

        log("call_started", { callSid, mode: "media_stream" });
        await speakFull(greetingText, "greeting");

        // Start silence timer
        resetSilenceTimer();

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
        if (markName.endsWith("-done")) {
          // All audio for this turn finished playing
          if (state) state.aiSpeaking = false;
        }
        break;
      }

      // ---- Stream stopped — call ended ----
      case "stop": {
        log("media_stream_stop", { callSid });
        cleanup();
        break;
      }
    }
  });

  // ------------------------------------------------------------------
  // WebSocket close / error
  // ------------------------------------------------------------------
  ws.on("close", () => {
    log("media_stream_ws_close", { callSid });
    cleanup();
  });

  ws.on("error", (err) => {
    log("error", { callSid, message: "WebSocket error", code: "ws_error", detail: err?.message });
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

    if (state?.deepgramConn) {
      deepgram.closeStream(state.deepgramConn);
      state.deepgramConn = null;
    }

    // Note: don't remove callState here — the /twilio/status callback will
    // handle DB updates (summary, sentiment, outcome) and then remove state.
  }
}
