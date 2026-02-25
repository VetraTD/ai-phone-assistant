import "dotenv/config";
import express from "express";
import * as twilio from "twilio";
import crypto from "crypto";

import * as geminiService from "./services/gemini.js";
import * as db from "./services/supabase.js";
import {
  buildGatherAndRedirect,
  buildSayGatherRedirect,
  buildSayAndHangup,
  buildSayAndDial,
} from "./lib/twiml.js";
import * as callState from "./lib/callState.js";
import { STEPS } from "./lib/callState.js";

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

// ---------------------------------------------------------------------------
// Escape-trigger detection (case-insensitive, word-boundary)
// ---------------------------------------------------------------------------

const TRANSFER_TRIGGERS =
  /\b(representative|human|operator|real person|speak to someone|talk to someone|stop|enough)\b/i;

function isTransferRequest(speech) {
  return TRANSFER_TRIGGERS.test(speech);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.urlencoded({ extended: false }));

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
  const speechResult =
    typeof req.body.SpeechResult === "string" ? req.body.SpeechResult.trim() : "";

  // ---- 1. Get or create state ----
  const state = callState.getState(callSid);

  // ---- 2. DB: create call row on first hit ----
  if (!state.dbCallId && db.isEnabled()) {
    const twilioNumber = req.body.To || "";
    const callerNumber = req.body.From || "";
    const business = await db.lookupBusinessByPhone(twilioNumber);
    if (business) {
      const dbId = await db.createCall(business.id, callSid, callerNumber, twilioNumber);
      if (dbId) {
        state.dbCallId = dbId;
        state.businessId = business.id;
        state.callerNumber = callerNumber;
      }
    } else {
      console.warn(
        `No business found for Twilio number ${twilioNumber} — skipping DB persistence`
      );
    }
  }

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
      return res.send(
        buildGatherAndRedirect(
          VOICE_URL,
          "Hi, this is your AI receptionist. How can I help you today?"
        )
      );
    }

    // Progressive silence: re-listen → prompt → goodbye
    const SILENCE_GATHER_TIMEOUT = 10;
    state.silenceCount++;

    if (state.silenceCount === 1) {
      return res.send(buildGatherAndRedirect(VOICE_URL, "", SILENCE_GATHER_TIMEOUT));
    }
    if (state.silenceCount === 2) {
      return res.send(
        buildSayGatherRedirect(VOICE_URL, "Are you still there?", SILENCE_GATHER_TIMEOUT)
      );
    }
    // 3rd silence — hang up
    return res.send(buildSayAndHangup("It seems like you may have stepped away. Goodbye!"));
  }

  // ---- 6. Speech present — reset silence counter ----
  state.silenceCount = 0;

  // ---- 7. Escape-trigger check (before Gemini) ----
  if (isTransferRequest(speechResult)) {
    if (TRANSFER_NUMBER) {
      const msg = "Transferring you now. Please hold.";
      logTranscript(state, speechResult, msg);
      state.step = STEPS.ENDING;
      return res.send(buildSayAndDial(msg, TRANSFER_NUMBER));
    }
    // No transfer number configured — acknowledge and keep helping
    const msg =
      "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.";
    logTranscript(state, speechResult, msg);
    return res.send(buildSayGatherRedirect(VOICE_URL, msg));
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

  // ---- 9. Call Gemini (step-aware) ----
  geminiService
    .getReply(state.history, speechResult, state.step, state.intent)
    .then(async ({ text: replyText, appointmentArgs, intentArgs, endCallArgs }) => {
      // -- Update conversation history --
      state.history.push({ role: "user", parts: [{ text: speechResult }] });
      state.history.push({ role: "model", parts: [{ text: replyText }] });

      // -- Step transitions based on function calls --
      if (intentArgs) {
        state.intent = intentArgs.intent;
        if (state.step === STEPS.IDENTIFY_INTENT || state.step === STEPS.CONFIRM) {
          state.step = STEPS.GATHER_DETAILS;
        }
      }

      if (appointmentArgs && state.businessId) {
        const notes =
          [appointmentArgs.service_type, appointmentArgs.notes]
            .filter(Boolean)
            .join(" — ") || null;
        db.createAppointment({
          businessId: state.businessId,
          callId: state.dbCallId || null,
          clientName: appointmentArgs.client_name || null,
          clientPhone: state.callerNumber || null,
          scheduledAt: appointmentArgs.scheduled_at,
          notes,
        }).catch((err) => console.error("createAppointment error:", err));
        state.step = STEPS.CONFIRM;
      }

      if (endCallArgs) {
        state.step = STEPS.ENDING;
      }

      // -- Persist transcript --
      logTranscript(state, speechResult, replyText);

      // -- Build TwiML response --
      if (state.step === STEPS.ENDING) {
        return res.send(buildSayAndHangup(replyText));
      }

      const twiml = buildSayGatherRedirect(VOICE_URL, replyText);
      state.lastProcessed = { speechHash, timestamp: Date.now(), cachedTwiml: twiml };
      res.send(twiml);
    })
    .catch((err) => {
      if (err?.message === "TURN_TIMEOUT") {
        return res.send(
          buildSayGatherRedirect(
            VOICE_URL,
            "Sorry, I'm taking a bit longer. Please try again."
          )
        );
      }
      console.error("Gemini error:", err);
      res.send(
        buildSayGatherRedirect(
          VOICE_URL,
          "Sorry, I'm having a technical issue. Please try again in a moment."
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
    const duration = req.body.CallDuration != null ? Number(req.body.CallDuration) : null;

    db.completeCall(callSid, status, duration).catch((err) =>
      console.error("completeCall error:", err)
    );

    // Generate summary and sentiment for completed calls (fire-and-forget)
    if (dbCallId && status === "completed") {
      (async () => {
        const transcript = await db.fetchCallTranscript(dbCallId);
        if (transcript.length > 0) {
          const { summary, sentiment } =
            await geminiService.generateSummaryAndSentiment(transcript);
          await db.updateCallSummary(callSid, summary, sentiment);
        }
      })().catch((err) => console.error("Summary generation error:", err));
    }

    callState.remove(callSid);
  }
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Voice webhook: ${VOICE_URL}`);
  console.log(
    `Status callback: ${STATUS_URL}. Configure this URL in your Twilio number/app statusCallback.`
  );
  if (TRANSFER_NUMBER) {
    console.log(`Transfer number: ${TRANSFER_NUMBER}`);
  } else {
    console.log(`TRANSFER_NUMBER not set — live-transfer disabled.`);
  }
  console.log(
    `Call time limit: ${CALL_MAX_DURATION_MS / 60000} minutes (CALL_MAX_DURATION_MINUTES)`
  );
});
