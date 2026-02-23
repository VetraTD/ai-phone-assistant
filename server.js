import "dotenv/config";
import express from "express";
import * as twilio from "twilio";
import crypto from "crypto";

import * as geminiService from "./services/gemini.js";
import { buildGatherAndRedirect, buildSayGatherRedirect, buildSayAndHangup } from "./lib/twiml.js";
import * as callState from "./lib/callState.js";

const app = express();
const PORT = 3000;

// --- Env: required, fail fast ---
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
    "BASE_URL is set to a placeholder (example.ngrok.io). Twilio will POST the user's speech to that URL, which does not reach this server. Set BASE_URL in .env to the exact HTTPS URL shown when you run 'ngrok http 3000', then restart."
  );
  process.exit(1);
}

const VOICE_URL = `${BASE_URL}/twilio/voice`;
const STATUS_URL = `${BASE_URL}/twilio/status`;
const IDEMPOTENCY_WINDOW_MS = 15_000;

app.use(express.urlencoded({ extended: false }));

// --- Root: confirm server is running (browser or health check) ---
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

// --- Voice webhook ---
app.post("/twilio/voice", twilioValidation, (req, res) => {
  res.type("text/xml");
  const callSid = req.body.CallSid;
  const speechResult = typeof req.body.SpeechResult === "string" ? req.body.SpeechResult.trim() : "";

  const state = callState.getState(callSid);

  // Branch A: no speech result (first leg or Gather timeout / silence)
  if (speechResult === "") {
    if (!state.hasGreeted) {
      state.hasGreeted = true;
      return res.send(buildGatherAndRedirect(VOICE_URL, "Hi, this is your AI receptionist. How can I help you today?"));
    }

    // Progressive silence handling: 10s re-listen, then "Are you still there?" (10s), then goodbye
    const SILENCE_GATHER_TIMEOUT = 10;
    state.silenceCount++;

    if (state.silenceCount === 1) {
      // First silence: re-listen for 10s with no message
      return res.send(buildGatherAndRedirect(VOICE_URL, "", SILENCE_GATHER_TIMEOUT));
    }
    if (state.silenceCount === 2) {
      return res.send(buildSayGatherRedirect(VOICE_URL, "Are you still there?", SILENCE_GATHER_TIMEOUT));
    }
    // 3rd silence — hang up gracefully
    return res.send(buildSayAndHangup("It seems like you may have stepped away. Goodbye!"));
  }

  // Branch B: speech result present — reset silence counter
  state.silenceCount = 0;

  // Idempotency check
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

  // Call Gemini (timeout and errors handled in service)
  geminiService
    .getReply(state.history, speechResult)
    .then((replyText) => {
      state.history.push({ role: "user", parts: [{ text: speechResult }] });
      state.history.push({ role: "model", parts: [{ text: replyText }] });
      const twiml = buildSayGatherRedirect(VOICE_URL, replyText);
      state.lastProcessed = { speechHash, timestamp: Date.now(), cachedTwiml: twiml };
      res.send(twiml);
    })
    .catch((err) => {
      if (err?.message === "TURN_TIMEOUT") {
        return res.send(buildSayGatherRedirect(VOICE_URL, "Sorry, I'm taking a bit longer. Please try again."));
      }
      console.error("Gemini error:", err);
      res.send(buildSayGatherRedirect(VOICE_URL, "Sorry, I'm having a technical issue. Please try again in a moment."));
    });
});

// --- Status callback: clear CallSid on terminal status ---
app.post("/twilio/status", twilioValidation, (req, res) => {
  const callSid = req.body.CallSid;
  const status = (req.body.CallStatus || "").toLowerCase();
  if (["completed", "failed", "busy", "no-answer"].includes(status) && callSid) {
    callState.remove(callSid);
  }
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Voice webhook: ${VOICE_URL}`);
  console.log(`Status callback: ${STATUS_URL}. Configure this URL in your Twilio number/app statusCallback.`);
});
