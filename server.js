import "dotenv/config";
import cors from "cors";
import { captureException } from "./lib/sentry.js"; // init Sentry early (reads SENTRY_DSN)
import express from "express";
import * as twilio from "twilio";
import crypto from "crypto";

import * as geminiService from "./services/gemini.js";
import * as db from "./services/supabase.js";
import { listIntegrationDefinitions } from "./config/integrationDefinitions.js";
import * as notifications from "./services/notifications.js";
import * as twilioNumbers from "./services/twilioNumbers.js";
import {
  buildGatherAndRedirect,
  buildSayGatherRedirect,
  buildSayAndHangup,
  buildSayAndDial,
} from "./lib/twiml.js";
import * as callState from "./lib/callState.js";
import { STEPS } from "./lib/callState.js";
import { log, createRequestId } from "./lib/logger.js";

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Env — required, fail fast
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, "");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VALIDATE_SIGNATURE = process.env.TWILIO_VALIDATE_SIGNATURE !== "false";

if (!GEMINI_API_KEY) {
  console.error("Missing required env: GEMINI_API_KEY");
  process.exit(1);
}
if (!BASE_URL) {
  console.error("Missing required env: BASE_URL (e.g. https://your-ngrok-id.ngrok.io)");
  process.exit(1);
}
if (BASE_URL.includes("example.ngrok") || BASE_URL === "https://example.ngrok.io") {
  console.error(
    "BASE_URL is set to a placeholder (example.ngrok.io). " +
      "Set BASE_URL in .env to the exact HTTPS URL shown when you run 'ngrok http 3000', then restart."
  );
  process.exit(1);
}

const VOICE_URL = `${BASE_URL}/twilio/voice`;
const STATUS_URL = `${BASE_URL}/twilio/status`;
const IDEMPOTENCY_WINDOW_MS = 15_000;

// ---------------------------------------------------------------------------
// Env — optional: transfer & time limit
// ---------------------------------------------------------------------------

const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || "";
const CALL_MAX_DURATION_MS =
  (parseInt(process.env.CALL_MAX_DURATION_MINUTES, 10) || 30) * 60 * 1000;
const TYPING_SOUND_URL = process.env.TYPING_SOUND_URL || "";

// ---------------------------------------------------------------------------
// Escape-trigger detection (case-insensitive, word-boundary)
// ---------------------------------------------------------------------------

const TRANSFER_TRIGGERS =
  /\b(representative|human|operator|real person|speak to someone|talk to someone|stop|enough)\b/i;

function isTransferRequest(speech) {
  return TRANSFER_TRIGGERS.test(speech);
}

// ---------------------------------------------------------------------------
// Transfer policy resolver
// ---------------------------------------------------------------------------

/**
 * Determine if transfer is currently allowed based on config.transferPolicy
 * and business hours.
 * @param {object} config - normalised business config
 * @returns {boolean}
 */
function resolveTransferAllowed(config) {
  if (config.transferPolicy === "never") return false;
  if (config.transferPolicy === "always") return true;
  // "business_hours_only" — need to check if currently open
  if (config.transferPolicy === "business_hours_only") {
    return geminiService.isBusinessOpen(config);
  }
  return true; // default allow
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
      : ["http://localhost:5173"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --- Root: confirm server is running ---
app.get("/", (req, res) => {
  res.type("text/plain");
  res.send(
    `AI phone assistant is running.\nVoice webhook: ${VOICE_URL}\nStatus callback: ${STATUS_URL}`
  );
});

// --- Twilio signature validation ---
function twilioValidation(req, res, next) {
  if (!TWILIO_VALIDATE_SIGNATURE) return next();
  if (!TWILIO_AUTH_TOKEN) {
    console.warn("TWILIO_VALIDATE_SIGNATURE is enabled but TWILIO_AUTH_TOKEN is missing");
    return res.status(403).send("Forbidden");
  }
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return res.status(403).send("Forbidden");
  const url = BASE_URL + (req.originalUrl || req.url);
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (!valid) return res.status(403).send("Forbidden");
  next();
}

// ---------------------------------------------------------------------------
// Helper: log a transcript pair (fire-and-forget)
// ---------------------------------------------------------------------------

function logTranscript(state, callerText, aiText) {
  if (!state.dbCallId) return;
  const seq = state.sequenceCounter;
  state.sequenceCounter += 2;
  db.addTranscriptEntry(state.dbCallId, "caller", callerText, seq).catch(() => {});
  db.addTranscriptEntry(state.dbCallId, "ai", aiText, seq + 1).catch(() => {});
}

// ---------------------------------------------------------------------------
// Voice webhook
// ---------------------------------------------------------------------------

app.post("/twilio/voice", twilioValidation, async (req, res) => {
  res.type("text/xml");
  const callSid = req.body.CallSid;
  const requestId = createRequestId();
  const speechResult =
    typeof req.body.SpeechResult === "string" ? req.body.SpeechResult.trim() : "";

  // ---- 1. Get or create state ----
  const state = callState.getState(callSid);

  // ---- 2. Load config, knowledge & create call row on first hit ----
  if (!state.config) {
    let business = null;
    if (db.isEnabled()) {
      const twilioNumber = req.body.To || "";
      const callerNumber = req.body.From || "";
      business = await db.lookupBusinessByPhone(twilioNumber);
      if (business) {
        const dbId = await db.createCall(business.id, callSid, callerNumber, twilioNumber);
        if (dbId) {
          state.dbCallId = dbId;
          state.businessId = business.id;
          state.callerNumber = callerNumber;
        }
        // Load business knowledge Q&A for prompt injection
        state.knowledge = await db.fetchBusinessKnowledge(business.id);
        // Load integrations for dynamic tools (webhooks, etc.)
        state.integrations = await db.listIntegrationsForBusiness(business.id, { enabledOnly: true });
      } else {
        console.warn(
          `No business found for Twilio number ${twilioNumber} — skipping DB persistence`
        );
      }
    }
    state.config = db.loadConfig(business);
    if (!state.knowledge) state.knowledge = [];
    if (!state.integrations) state.integrations = [];
  }

  const config = state.config;

  // ---- 3. Hard time-limit check ----
  if (Date.now() - state.startedAt > CALL_MAX_DURATION_MS) {
    const msg =
      "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!";
    logTranscript(state, speechResult || "(time limit)", msg);
    return res.send(buildSayAndHangup(msg));
  }

  // ---- 4. If a previous turn already set step to ENDING, hang up ----
  if (state.step === STEPS.ENDING) {
    return res.send(buildSayAndHangup("Thank you for calling. Goodbye!"));
  }

  // ---- 5. No speech: greeting or silence handling ----
  if (speechResult === "") {
    if (state.step === STEPS.GREETING) {
      state.step = STEPS.IDENTIFY_INTENT;
      log("call_started", { callSid, requestId });

      // Build greeting with optional recording disclosure
      let greetingText = "";
      if (config.recordingDisclosureEnabled) {
        greetingText =
          (config.recordingDisclosureText ||
            "This call may be recorded for quality and training purposes.") + " ";
      }
      greetingText += config.greeting;

      return res.send(buildGatherAndRedirect(VOICE_URL, greetingText));
    }

    // Progressive silence: re-listen → prompt → goodbye
    const SILENCE_GATHER_TIMEOUT = 6;
    state.silenceCount++;

    if (state.silenceCount === 1) {
      return res.send(buildGatherAndRedirect(VOICE_URL, "", SILENCE_GATHER_TIMEOUT));
    }
    if (state.silenceCount === 2) {
      return res.send(
        buildSayGatherRedirect(VOICE_URL, "Are you still there?", SILENCE_GATHER_TIMEOUT, TYPING_SOUND_URL)
      );
    }
    // 3rd silence — hang up
    return res.send(buildSayAndHangup("It seems like you may have stepped away. Goodbye!"));
  }

  // ---- 6. Speech present — reset silence counter ----
  state.silenceCount = 0;

  // ---- 7. Escape-trigger check (before Gemini) ----
  if (isTransferRequest(speechResult)) {
    const transferNumber = config.transferPhoneNumber || TRANSFER_NUMBER;
    const canTransfer = !!transferNumber && resolveTransferAllowed(config);
    log("transfer_requested", { callSid, requestId, transferred: canTransfer, transferPolicy: config.transferPolicy });

    if (canTransfer) {
      const msg = "Transferring you now. Please hold.";
      logTranscript(state, speechResult, msg);
      state.step = STEPS.ENDING;
      return res.send(buildSayAndDial(msg, transferNumber));
    }
    // Transfer not possible — use escalation message or default
    const msg = config.escalationMessage ||
      "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.";
    logTranscript(state, speechResult, msg);
    return res.send(buildSayGatherRedirect(VOICE_URL, msg, undefined, TYPING_SOUND_URL));
  }

  // ---- 8. Idempotency check ----
  const speechHash = crypto.createHash("sha256").update(speechResult).digest("hex");
  const now = Date.now();
  if (
    state.lastProcessed &&
    state.lastProcessed.speechHash === speechHash &&
    now - state.lastProcessed.timestamp < IDEMPOTENCY_WINDOW_MS &&
    state.lastProcessed.cachedTwiml
  ) {
    return res.send(state.lastProcessed.cachedTwiml);
  }

  // ---- 9. Call Gemini (step + config aware) — measure latency ----
  const geminiStart = Date.now();

  geminiService
    .getReply(state.history, speechResult, state.step, state.intent, config, {
      knowledge: state.knowledge || [],
      transferAllowed: resolveTransferAllowed(config),
      integrations: state.integrations || [],
      businessId: state.businessId || null,
      callerPhone: state.callerNumber || null,
      callId: state.dbCallId || null,
      selectedAppointmentId: state.selectedAppointmentId || null,
    })
    .then(async ({ text: replyText, appointmentArgs, intentArgs, endCallArgs, customerRequestArgs, toolResults, selectedAppointmentId }) => {
      const turnLatencyMs = Date.now() - geminiStart;

      // -- Update conversation history --
      state.history.push({ role: "user", parts: [{ text: speechResult }] });
      state.history.push({ role: "model", parts: [{ text: replyText }] });

      // -- Log tool call results --
      if (toolResults && toolResults.length > 0) {
        for (const tr of toolResults) {
          log("tool_called", { callSid, requestId, tool: tr.name, success: tr.success });
        }
      }

      // -- Update selected appointment when lookup returned exactly one --
      if (selectedAppointmentId != null) {
        state.selectedAppointmentId = selectedAppointmentId;
      }
      // Clear when cancel succeeded so we don't reuse a cancelled id
      if (toolResults?.some((tr) => tr.name === "cancel_appointment_db" && tr.success)) {
        state.selectedAppointmentId = null;
      }

      // -- Step transitions based on function calls --
      if (intentArgs) {
        const prevStep = state.step;
        state.intent = intentArgs.intent;
        if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) {
          state.step = STEPS.GATHER_DETAILS;
        }
        log("intent_set", { callSid, requestId, intent: intentArgs.intent, prevStep, newStep: state.step });
      }

      if (appointmentArgs && state.businessId) {
        const notes =
          [appointmentArgs.service_type, appointmentArgs.notes]
            .filter(Boolean)
            .join(" — ") || null;
        const twilioNumber = req.body.To || "";
        state.step = STEPS.CONFIRM;
        db.createAppointment({
          businessId: state.businessId,
          callId: state.dbCallId || null,
          clientName: appointmentArgs.client_name || null,
          clientPhone: state.callerNumber || null,
          scheduledAt: appointmentArgs.scheduled_at,
          notes,
        })
          .then((dbId) => {
            if (dbId) {
              log("appointment_booked", {
                callSid,
                requestId,
                scheduled_at: appointmentArgs.scheduled_at,
              });
              notifications
                .notifyAppointmentBooked({
                  businessId: state.businessId,
                  appointment: {
                    scheduled_at: appointmentArgs.scheduled_at,
                    client_name: appointmentArgs.client_name || null,
                    client_phone: state.callerNumber || null,
                    notes,
                  },
                  call: { callerNumber: state.callerNumber, twilioNumber },
                })
                .catch(() => {});
            }
          })
          .catch((err) => {
            log("error", {
              callSid,
              requestId,
              message: "createAppointment failed",
              code: "db_appointment",
            });
            captureException(err, { callSid, requestId });
          });
      }

      if (endCallArgs) {
        state.step = STEPS.ENDING;
        log("step_transition", { callSid, requestId, newStep: STEPS.ENDING, reason: endCallArgs.reason });
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
        })
          .then((id) => {
            if (id) {
              notifications
                .notifyCustomerRequest({
                  businessId: state.businessId,
                  customerRequest: {
                    request_type: customerRequestArgs.request_type || "message",
                    caller_name: customerRequestArgs.caller_name || null,
                    callback_number: customerRequestArgs.callback_number || null,
                    message: customerRequestArgs.message || null,
                    preferred_time: customerRequestArgs.preferred_time || null,
                  },
                  call: { callerNumber: state.callerNumber },
                })
                .catch(() => {});
            }
          })
          .catch((err) => {
            log("error", {
              callSid,
              requestId,
              message: "createCustomerRequest failed",
              code: "db_customer_request",
            });
            captureException(err, { callSid, requestId });
          });
      }

      // -- Persist transcript --
      logTranscript(state, speechResult, replyText);

      // -- Structured log: turn completed --
      log("turn_completed", {
        callSid,
        requestId,
        step: state.step,
        intent: state.intent,
        turn_latency_ms: turnLatencyMs,
      });

      // -- Build TwiML response --
      if (state.step === STEPS.ENDING) {
        return res.send(buildSayAndHangup(replyText));
      }

      const twiml = buildSayGatherRedirect(VOICE_URL, replyText, undefined, TYPING_SOUND_URL);
      state.lastProcessed = { speechHash, timestamp: Date.now(), cachedTwiml: twiml };
      res.send(twiml);
    })
    .catch((err) => {
      const turnLatencyMs = Date.now() - geminiStart;
      const isTimeout = err?.message === "TURN_TIMEOUT";

      log("error", {
        callSid,
        requestId,
        message: isTimeout ? "Gemini turn timeout" : err?.message,
        code: isTimeout ? "gemini_timeout" : "gemini_error",
        turn_latency_ms: turnLatencyMs,
      });
      captureException(err, { callSid, requestId });

      if (isTimeout) {
        return res.send(
          buildSayGatherRedirect(
            VOICE_URL,
            "Sorry, I'm taking a bit longer. Please try again.",
            undefined,
            TYPING_SOUND_URL
          )
        );
      }
      res.send(
        buildSayGatherRedirect(
          VOICE_URL,
          "Sorry, I'm having a technical issue. Please try again in a moment.",
          undefined,
          TYPING_SOUND_URL
        )
      );
    });
});

// ---------------------------------------------------------------------------
// Status callback — update call record on terminal status
// ---------------------------------------------------------------------------

app.post("/twilio/status", twilioValidation, async (req, res) => {
  const callSid = req.body.CallSid;
  const status = (req.body.CallStatus || "").toLowerCase();
  if (["completed", "failed", "busy", "no-answer"].includes(status) && callSid) {
    const state = callState.getState(callSid);
    const dbCallId = state.dbCallId;
    const businessId = state.businessId;
    const duration = req.body.CallDuration != null ? Number(req.body.CallDuration) : null;
    const callContext = {
      callerNumber: req.body.From || null,
      twilioNumber: req.body.To || null,
    };

    db.completeCall(callSid, status, duration).catch((err) => {
      log("error", { callSid, message: "completeCall failed", code: "db_complete" });
      captureException(err, { callSid });
    });

    if (businessId && ["failed", "busy", "no-answer"].includes(status)) {
      notifications.notifyCallMissed({ businessId, call: callContext, status }).catch(() => {});
    }

    // Generate summary, sentiment, and outcome for completed calls (fire-and-forget)
    if (dbCallId && status === "completed") {
      (async () => {
        const transcript = await db.fetchCallTranscript(dbCallId);
        if (transcript.length > 0) {
          const { summary, sentiment, outcome } =
            await geminiService.generateSummaryAndSentiment(transcript);
          await db.updateCallSummary(callSid, summary, sentiment, outcome);
        }
      })().catch((err) => {
        log("error", { callSid, message: "Summary generation failed", code: "summary_error" });
      });
    }

    callState.remove(callSid);
  }
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// Integrations API: definitions (catalog for dashboard)
// ---------------------------------------------------------------------------

app.get("/api/integrations/definitions", (req, res) => {
  res.json(listIntegrationDefinitions());
});

// ---------------------------------------------------------------------------
// OAuth callback routes (reserved for future first-party providers)
// e.g. GET /api/integrations/athenahealth/callback
// ---------------------------------------------------------------------------

app.get("/api/integrations/:provider/callback", (req, res) => {
  res.status(501).send("OAuth callback not implemented for this provider yet.");
});

app.post("/api/integrations/:provider/callback", (req, res) => {
  res.status(501).send("OAuth callback not implemented for this provider yet.");
});

// ---------------------------------------------------------------------------
// Dashboard API: per-business notification settings (placeholder for future UI)
// ---------------------------------------------------------------------------

app.get("/api/businesses/:id/notifications", async (req, res) => {
  const businessId = req.params.id;
  if (!businessId) return res.status(400).json({ error: "Missing business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  res.json({
    notification_email: business.notification_email ?? null,
    notification_phone: business.notification_phone ?? null,
    notifications_enabled: business.notifications_enabled !== false,
  });
});

app.put("/api/businesses/:id/notifications", async (req, res) => {
  const businessId = req.params.id;
  if (!businessId) return res.status(400).json({ error: "Missing business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const body = req.body || {};
  const payload = {};
  if (body.notification_email !== undefined) payload.notification_email = body.notification_email;
  if (body.notification_phone !== undefined) payload.notification_phone = body.notification_phone;
  if (body.notifications_enabled !== undefined) payload.notifications_enabled = body.notifications_enabled;
  const ok = await db.updateBusinessNotificationSettings(businessId, payload);
  if (!ok) return res.status(500).json({ error: "Update failed" });
  const updated = await db.fetchBusinessById(businessId);
  res.json({
    notification_email: updated?.notification_email ?? null,
    notification_phone: updated?.notification_phone ?? null,
    notifications_enabled: updated?.notifications_enabled !== false,
  });
});

// ---------------------------------------------------------------------------
// Dashboard API: search and buy Twilio phone numbers
// ---------------------------------------------------------------------------

app.get("/api/businesses/:id/phone-numbers/available", async (req, res) => {
  const businessId = req.params.id;
  if (!businessId) return res.status(400).json({ error: "Missing business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const country = req.query.country || "US";
  const areaCode = req.query.areaCode || undefined;
  const type = req.query.type === "tollFree" ? "tollFree" : "local";
  try {
    const numbers = await twilioNumbers.searchAvailableNumbers({
      country,
      areaCode,
      type,
      limit: 20,
    });
    return res.json({ numbers });
  } catch (err) {
    console.error("searchAvailableNumbers error:", err.message);
    return res.status(502).json({
      error: err.message || "Failed to search available phone numbers",
    });
  }
});

app.post("/api/businesses/:id/phone-numbers/buy", async (req, res) => {
  const businessId = req.params.id;
  if (!businessId) return res.status(400).json({ error: "Missing business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const phoneNumber = req.body?.phone_number;
  if (!phoneNumber || typeof phoneNumber !== "string" || !phoneNumber.trim()) {
    return res.status(400).json({ error: "Missing or invalid phone_number in body" });
  }
  const trimmed = phoneNumber.trim();
  if (business.phone_number) {
    if (business.phone_number === trimmed) {
      return res.json({ phone_number: trimmed, sid: null });
    }
    return res.status(409).json({
      error: "Business already has a phone number",
    });
  }
  try {
    const result = await twilioNumbers.purchaseNumber({
      phoneNumber: trimmed,
      voiceUrl: VOICE_URL,
      statusCallback: STATUS_URL,
    });
    const ok = await db.updateBusinessPhoneNumber(businessId, result.phone_number);
    if (!ok) {
      return res.status(500).json({ error: "Failed to save phone number to business" });
    }
    return res.json({ phone_number: result.phone_number, sid: result.sid });
  } catch (err) {
    console.error("purchaseNumber error:", err.message);
    const message =
      err.code === 21608 || err.message?.includes("available")
        ? "This number is no longer available. Please search again."
        : err.message || "Failed to purchase phone number";
    return res.status(400).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Start (skip when running tests)
// ---------------------------------------------------------------------------

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Voice webhook: ${VOICE_URL}`);
    console.log(
      `Status callback: ${STATUS_URL}. Configure this URL in your Twilio number/app statusCallback.`
    );
    if (TRANSFER_NUMBER) {
      console.log(`Transfer number (env fallback): ${TRANSFER_NUMBER}`);
    } else {
      console.log(`TRANSFER_NUMBER not set — per-business transfer or disabled.`);
    }
    console.log(
      `Call time limit: ${CALL_MAX_DURATION_MS / 60000} minutes (CALL_MAX_DURATION_MINUTES)`
    );
  });
}
