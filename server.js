import "dotenv/config";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { captureException } from "./lib/sentry.js"; // init Sentry early (reads SENTRY_DSN)
import express from "express";
import * as twilio from "twilio";

import * as geminiService from "./services/gemini.js";
import * as db from "./services/supabase.js";
import { listIntegrationDefinitions } from "./config/integrationDefinitions.js";
import * as notifications from "./services/notifications.js";
import * as twilioNumbers from "./services/twilioNumbers.js";
import { WebSocketServer } from "ws";
import { handleMediaStreamConnection } from "./lib/mediaStream.js";
import { handleVoiceSessionConnection } from "./lib/voice/session.js";
import * as callState from "./lib/callState.js";
import { normalizePhoneNumber } from "./lib/phone.js";
import { getCacheStats } from "./services/geminiCache.js";
import { STEPS } from "./lib/callState.js";
import { log } from "./lib/logger.js";
import { getLatencyStats, getCallStats, clearStats } from "./lib/voice/metrics.js";
import { createHash, timingSafeEqual } from "node:crypto";
import * as voiceHealth from "./lib/voice/health.js";
import {
  buildDegradedVoicemailTwiml,
  buildUnroutedTransferTwiml,
  buildUnroutedVoicemailTwiml,
  escapeXml,
} from "./lib/twiml.js";
import { countryFromE164 } from "./lib/phone.js";
import { getProfile } from "./lib/voice/localeProfiles.js";
import {
  isValidUUID,
  isValidE164,
  isValidCountryCode,
  isValidEmail,
  sanitizeString,
} from "./lib/validate.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Identifies this process. Reported on /api/debug/latency so a measurement run
// can prove the server did not restart (i.e. redeploy) underneath it.
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Trust Railway's proxy so express-rate-limit can read the real client IP
// from X-Forwarded-For instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Env — required, fail fast
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, "");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VALIDATE_SIGNATURE = process.env.TWILIO_VALIDATE_SIGNATURE !== "false";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

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
if (!DEEPGRAM_API_KEY) {
  console.error(
    "Missing required env: DEEPGRAM_API_KEY. The Media Streams voice pipeline " +
      "requires Deepgram for real-time speech-to-text — there is no fallback mode."
  );
  process.exit(1);
}

const VOICE_URL = `${BASE_URL}/twilio/voice`;
const STATUS_URL = `${BASE_URL}/twilio/status`;

// ---------------------------------------------------------------------------
// Env — optional: transfer & time limit
// ---------------------------------------------------------------------------

const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || "";

/**
 * Where to send a caller whose dialed number matches no business.
 *
 * Deliberately NOT TRANSFER_NUMBER: that is the per-business forwarding
 * fallback, and sending a stranger's misrouted call to some other business's
 * back office is its own kind of wrong. Unset (the default) means take a
 * message instead.
 *
 * Read at call time, not module load, so it can be changed without a restart
 * and flipped per-case in tests.
 *
 * @returns {string} E.164 number, or "" when unset/invalid
 */
function unroutedTransferNumber() {
  return normalizePhoneNumber(process.env.UNROUTED_TRANSFER_NUMBER) || "";
}

const CALL_MAX_DURATION_MS =
  (parseInt(process.env.CALL_MAX_DURATION_MINUTES, 10) || 30) * 60 * 1000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.use(express.urlencoded({ extended: false }));

// Default JSON body parsing, at express's 100kb default — deliberately left
// tight. The one route that needs more (the probe caller-audio upload, a few
// hundred kb of mu-law) declares its own larger parser inline, so the raised
// limit applies to exactly that path and nothing else.
const defaultJsonParser = express.json();
app.use((req, res, next) => {
  if (req.path === "/api/debug/probe-script") return next();
  return defaultJsonParser(req, res, next);
});

// Match dashboard backend: prod domains + localhost. Override/extend with CORS_ORIGIN (comma-separated).
const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://vetratd.com",
  "https://www.vetratd.com",
  "https://ai-phone-dashboard-lemon.vercel.app",
];
const envCorsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];
const allowedCorsOrigins = [...new Set([...defaultCorsOrigins, ...envCorsOrigins])];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedCorsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --- Rate limiting (skip in test to avoid flakiness) ---
if (process.env.NODE_ENV !== "test") {
  app.use(
    "/twilio",
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
}

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
    log.error("twilio_signature_validation_disabled", { reason: "no_auth_token", severity: "warn" });
    return res.status(403).send("Forbidden");
  }
  const signature = req.headers["x-twilio-signature"];
  if (!signature) {
    log.error("twilio_signature_missing", { url: req.url, ip: req.ip });
    return res.status(403).send("Forbidden");
  }
  const url = BASE_URL + (req.originalUrl || req.url);
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (!valid) {
    log.error("twilio_signature_invalid", { url: req.url, ip: req.ip });
    return res.status(403).send("Forbidden");
  }
  next();
}

// ---------------------------------------------------------------------------
// Voice webhook
//
// The only remaining responsibility here is handing the call off to the
// Media Streams pipeline (lib/voice/session.js by default; lib/mediaStream.js
// only when PIPELINE_V2=false — see selectPipelineHandler below). The legacy TwiML
// <Gather> conversation loop has been removed — DEEPGRAM_API_KEY is
// required at boot (see above), so Media Streams is always available.
//
// Degraded mode: if lib/voice/health.js reports the pipeline's STT/TTS
// dependencies are down, skip Media Streams entirely and fall back to a
// voicemail-only TwiML response (see /twilio/voicemail below).
// ---------------------------------------------------------------------------

app.post("/twilio/voice", twilioValidation, async (req, res) => {
  res.type("text/xml");

  const callSid = req.body.CallSid;

  if (voiceHealth.isDegraded()) {
    log.error("degraded_mode_voicemail_fallback", {
      callSid,
      reason: voiceHealth.getDegradedReason(),
      severity: "warn",
    });
    return res.send(buildDegradedVoicemailTwiml(`${BASE_URL}/twilio/voicemail`));
  }

  const existingState = callState.getState(callSid);
  // Only connect the stream on the very first webhook hit (greeting step).
  if (existingState.step === STEPS.GREETING && !existingState.mediaStream) {
    const businessPhone = req.body.To || "";
    const callerPhone = req.body.From || "";

    // Resolve the tenant HERE rather than inside the media-stream socket. Two
    // reasons: an unroutable number must never reach the assistant at all (see
    // below), and the socket can reuse this row instead of paying a second
    // Supabase round trip on the latency-critical pickup path.
    let business = null;
    // A lookup that THREW is not the same as a lookup that found nothing.
    // "No such business" means the caller must not reach the assistant; a
    // Supabase blip must not turn a legitimate business's calls into voicemail.
    // Only a clean miss triggers the unrouted path — an error falls through to
    // the stream, where the socket retries the lookup.
    let lookupFailed = false;
    if (db.isEnabled() && businessPhone) {
      try {
        business = await db.lookupBusinessByPhone(businessPhone);
      } catch (err) {
        log.error("voice_business_lookup_failed", { callSid, message: err?.message, severity: "warn" });
        captureException(err, { callSid });
        lookupFailed = true;
        business = null;
      }
    }
    // Left null on failure so the socket re-queries rather than trusting a miss.
    existingState.business = business;

    if (db.isEnabled() && businessPhone && !business && !lookupFailed) {
      // The assistant cannot say who it is answering for, cannot persist a
      // message, and cannot book anything. Hand the caller to a human, or take
      // a message honestly — never impersonate a generic office.
      const unroutedTo = unroutedTransferNumber();
      log.error("no_business_found", {
        callSid,
        businessPhone,
        stage: "voice_webhook",
        action: unroutedTo ? "transfer" : "voicemail",
        severity: "warn",
      });
      // There is no business config here by definition — the dialled number
      // matched nothing — so the locale comes off the numbers themselves.
      // Without this a UK caller on a UK line heard a US ringback and an
      // American voice, because both defaulted to "us".
      const unroutedProfile = getProfile(
        countryFromE164(businessPhone) === "GB" || countryFromE164(callerPhone) === "GB" ? "en-GB" : "en-US"
      );
      if (unroutedTo) {
        return res.send(
          buildUnroutedTransferTwiml(unroutedTo, callerPhone, unroutedProfile.ringTone, unroutedProfile.twimlSayVoice)
        );
      }
      return res.send(
        buildUnroutedVoicemailTwiml(`${BASE_URL}/twilio/voicemail`, unroutedProfile.twimlSayVoice)
      );
    }

    const wsUrl = BASE_URL.replace(/^http/, "ws") + "/twilio/media-stream";
    log.info("media_stream_initiated", { callSid });
    // escapeXml on both: every other TwiML site in this codebase escapes its
    // interpolations, and an unescaped attribute value is an XML-injection hole
    // even when the only writer is Twilio.
    return res.send(
      `<Response><Connect><Stream url="${wsUrl}">` +
      `<Parameter name="businessPhone" value="${escapeXml(businessPhone)}" />` +
      `<Parameter name="callerPhone" value="${escapeXml(callerPhone)}" />` +
      `</Stream></Connect></Response>`
    );
  }
  // Unexpected re-hit after the stream is already connected — there is no
  // legacy TwiML fallback anymore. Nothing useful to do; hang up gracefully.
  log.error("twilio_voice_unexpected_rehit", { callSid, severity: "warn" });
  return res.send("<Response><Hangup/></Response>");
});

// ---------------------------------------------------------------------------
// Degraded-mode voicemail recording callback
//
// Twilio POSTs here (recordingStatusCallback) once the <Record> from
// buildDegradedVoicemailTwiml finishes. We can't rely on callState/DB call
// rows here — degraded mode skips that setup entirely — so the business is
// looked up fresh from the dialed (To) number.
// ---------------------------------------------------------------------------

app.post("/twilio/voicemail", twilioValidation, async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || null;
  const twilioNumber = req.body.To || "";
  const recordingUrl = req.body.RecordingUrl || "";

  log.info("degraded_voicemail_received", { callSid, callerNumber });

  try {
    const business = db.isEnabled() && twilioNumber
      ? await db.lookupBusinessByPhone(twilioNumber)
      : null;

    if (business) {
      const message = `Voicemail recording: ${recordingUrl}`;
      const id = await db.createCustomerRequest({
        businessId: business.id,
        requestType: "message",
        callbackNumber: callerNumber,
        message,
      });
      if (id) {
        notifications
          .notifyCustomerRequest({
            businessId: business.id,
            customerRequest: {
              request_type: "message",
              caller_name: null,
              callback_number: callerNumber,
              message,
              preferred_time: null,
            },
            call: { callerNumber },
          })
          .catch(() => {});
        const config = db.loadConfig(business);
        notifications
          .sendCallerSms(config, callerNumber, "message_received", {
            name_part: "",
            business: config.businessName,
            sla: notifications.MESSAGE_SLA_TEXT,
          })
          .catch((err) => log.error("sms_followup_failed", { callSid, kind: "message_received", reason: err?.message }));
      }
    } else {
      // No business row, so there is nowhere to file this. The recording URL
      // goes in the log line so a real caller's message is recoverable by hand
      // rather than lost outright — this is the unrouted-number path as well as
      // the degraded one. A proper ops mailbox for these does not exist yet.
      log.error("degraded_voicemail_no_business", {
        callSid,
        twilioNumber,
        callerNumber,
        recordingUrl,
        severity: "warn",
      });
    }
  } catch (err) {
    log.error("degraded_voicemail_failed", { callSid, message: err?.message });
    captureException(err, { callSid });
  }

  res.status(200).end();
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
    // Captured synchronously, before any await below and before
    // callState.remove(callSid) at the end of this handler — the spam
    // heuristic's async block (below) needs this in-memory signal, not a
    // fresh callState.getState() call that could read a since-removed state.
    const sawCallerFinal = !!state.sawCallerFinal;
    const duration = req.body.CallDuration != null ? Number(req.body.CallDuration) : null;
    const callContext = {
      callerNumber: req.body.From || null,
      twilioNumber: req.body.To || null,
    };

    log.info("call_ended_status_callback", {
      callSid,
      callStatus: status,
      durationSeconds: duration,
    });

    db.completeCall(callSid, status, duration).catch((err) => {
      log.error("db_complete_call_failed", { callSid, message: err?.message });
      captureException(err, { callSid });
    });

    if (businessId && ["failed", "busy", "no-answer"].includes(status)) {
      notifications.notifyCallMissed({ businessId, call: callContext, status }).catch(() => {});
    }

    // Missed-call caller text-back (Part 2). A call that never connected to
    // the real-time pipeline never gets state.businessId/state.config set
    // (lib/mediaStream.js and lib/voice/session.js both load those lazily
    // once the WebSocket connects) — so look the business up fresh by the
    // dialed number instead of depending on call state. "Missed" here is
    // defined as: status is failed/busy/no-answer AND CallDuration is 0 (or
    // absent) — Twilio reports a nonzero duration when the call leg was
    // actually answered/connected before the failure, which we treat as
    // "not a pure miss" and skip texting for.
    if (["failed", "busy", "no-answer"].includes(status) && (duration == null || duration === 0)) {
      (async () => {
        // Short-circuit before the DB round-trip when SMS sending isn't
        // configured at all (sendCallerSms would no-op anyway) — no reason
        // to look the business up by phone first.
        if (!notifications.HAS_SMS_CREDS) return;
        if (!db.isEnabled() || !callContext.twilioNumber || !callContext.callerNumber) return;
        const business = await db.lookupBusinessByPhone(callContext.twilioNumber);
        if (!business) return;
        const config = db.loadConfig(business);
        await notifications.sendCallerSms(config, callContext.callerNumber, "missed_call", {
          business: config.businessName,
        });
      })().catch((err) => {
        log.error("missed_call_sms_failed", { callSid, message: err?.message });
      });
    }

    // Generate summary, sentiment, and outcome for completed calls (fire-and-forget)
    if (dbCallId && status === "completed") {
      (async () => {
        const transcript = await db.fetchCallTranscript(dbCallId);
        const callerTurns = transcript.filter((t) => t.speaker === "caller");
        // Spam/robocall detection (Part 3): the AI's own greeting is logged
        // even when the caller never speaks at all, so "transcript.length
        // === 0" wouldn't catch silent/robo calls — check for zero CALLER
        // turns specifically, combined with a short duration (a caller who
        // stays silent 8+ minutes without ever speaking is unusual but not
        // necessarily spam, so don't tag it). Skips the Gemini summary call
        // entirely in the spam case (saves cost).
        //
        // Race guard: call_transcripts inserts are fire-and-forget during
        // the live call (db.addTranscriptEntry), so a legitimate short call
        // where the caller DID speak can have its status callback arrive
        // before that insert lands — callerTurns.length would read 0 from
        // the DB even though the caller genuinely spoke. sawCallerFinal is
        // set live, in-memory, the moment STT delivers a caller final (both
        // pipelines — see lib/callState.js), well before the call even
        // ends, so it can't lose this race the same way the DB read can.
        // Require BOTH signals before tagging spam.
        if (!sawCallerFinal && callerTurns.length === 0 && duration != null && duration < 8) {
          await db.updateCallSummary(callSid, "No caller speech (likely spam/robocall)", null, "spam");
        } else if (transcript.length > 0) {
          const { summary, sentiment, outcome } =
            await geminiService.generateSummaryAndSentiment(transcript);
          await db.updateCallSummary(callSid, summary, sentiment, outcome);
        }
      })().catch((err) => {
        log.error("summary_generation_failed", { callSid, message: err?.message });
      });
    }

    // Per-call turn-latency rollup (Part 2) — fire-and-forget; skip silently
    // if no turns were recorded for this call (e.g. degraded-mode voicemail
    // calls that never went through the real-time pipeline).
    if (status === "completed") {
      try {
        const stats = getCallStats(callSid);
        if (stats) {
          db.updateCallLatency(callSid, stats.avgMs, stats.p95Ms).catch((err) => {
            log.error("db_update_latency_failed", { callSid, message: err?.message });
          });
        }
      } catch (err) {
        log.error("latency_rollup_failed", { callSid, message: err?.message });
      }
    }

    callState.remove(callSid);
  }
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// GET /api/businesses/:id/callers/:phone was REMOVED.
//
// It returned a caller's prior-call count, their last call's summary, and the
// times and names on their upcoming appointments — to anyone who knew a
// business UUID and a phone number, with no authentication of any kind. A UUID
// is an identifier, not a secret, and this server has no auth scheme to apply:
// the only guard it has is debugAccessAllowed, which is a shared-token switch
// for the /api/debug endpoints, not a per-tenant check.
//
// Nothing called it (no dashboard code, no test, no documented consumer), so
// deletion is the strongest available lock and adds no new auth surface here.
// Caller-scoped data belongs behind the dashboard backend's Supabase JWT plus
// its ownership check — see AI-phone-dashboard/backend/src/routes/calls.js.
//
// NOT fixed here, and still open: /api/businesses/:id/notifications (GET+PUT)
// and /api/businesses/:id/phone-numbers/{available,buy} have the identical
// UUID-as-bearer-token hole, and `buy` spends money on the Twilio account.
// ---------------------------------------------------------------------------

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
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
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
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const body = req.body || {};
  const payload = {};
  if (body.notification_email !== undefined) {
    if (body.notification_email !== null && body.notification_email !== "" && !isValidEmail(body.notification_email)) {
      return res.status(400).json({ error: "Invalid notification email" });
    }
    payload.notification_email = body.notification_email;
  }
  if (body.notification_phone !== undefined) {
    if (body.notification_phone !== null && body.notification_phone !== "" && !isValidE164(body.notification_phone)) {
      return res.status(400).json({ error: "Invalid notification phone number" });
    }
    payload.notification_phone = body.notification_phone;
  }
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
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
  const business = await db.fetchBusinessById(businessId);
  if (!business) return res.status(404).json({ error: "Business not found" });
  const country = req.query.country || "US";
  if (!isValidCountryCode(country)) return res.status(400).json({ error: "Invalid country code" });
  const areaCode = req.query.areaCode || undefined;
  if (areaCode && !/^\d{1,5}$/.test(areaCode)) return res.status(400).json({ error: "Invalid area code" });
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
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
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
// Dev-only: per-turn voice pipeline latency stats (Phase 0 instrumentation)
// ---------------------------------------------------------------------------

/**
 * Is this request allowed to see debug data?
 *
 * Two independent conditions, both required. DEBUG_ENDPOINTS is an operational
 * switch, not a secret — during a measurement run these routes are live on a
 * public host, where the flag alone would serve call SIDs and infrastructure
 * timing to anyone who guesses the path. So a shared secret is required as
 * well, and it FAILS CLOSED: no DEBUG_TOKEN configured means no access, rather
 * than falling back to flag-only.
 *
 * Comparison is over SHA-256 digests, which makes it constant-time in the
 * value AND fixed-length — raw timingSafeEqual throws on a length mismatch,
 * and that throw would become a 500 that confirms the route exists.
 *
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function debugAccessAllowed(req) {
  if (process.env.DEBUG_ENDPOINTS !== "true") return false;
  const expected = process.env.DEBUG_TOKEN;
  if (!expected) return false;
  const supplied = req.get("x-debug-token");
  if (!supplied) return false;
  const a = createHash("sha256").update(String(supplied)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

app.get("/api/debug/latency", async (req, res) => {
  // 404, never 401/403: a rejected request must be indistinguishable from a
  // route that does not exist, so probing can't confirm the endpoint is there.
  if (!debugAccessAllowed(req)) return res.status(404).end();
  const { ttsHealth } = await import("./lib/voice/ttsHealth.js");
  // bootId lets a probe run prove the server did not restart underneath it. A
  // deploy mid-run clears the ring buffer and splits the calls across two
  // builds; without this the result is an empty report blamed on the wrong
  // thing (see docs/latency-and-tts-tests.md, probe E).
  // promptCache is registry-level truth, and it is not redundant with the
  // per-turn `cache` block: a cache that was never created and a cache that was
  // created but never applied to a request both read as a 0% hit rate there.
  // Only creates/errors/cooldowns tell those two apart.
  res.json({
    ...getLatencyStats(),
    elBreaker: ttsHealth.getState(),
    promptCache: getCacheStats(),
    bootId: BOOT_ID,
  });
});

// The ring buffer lives as long as the process, so without this a second
// measurement run would pool with the first and blur any before/after
// comparison. Called by scripts/latency-probe.js before each run.
app.post("/api/debug/latency/reset", async (req, res) => {
  if (!debugAccessAllowed(req)) return res.status(404).end();
  clearStats();
  // Probe results are per-run too — leaving them would pool a new run's
  // ground truth with the previous one's.
  const { clearProbeResults } = await import("./lib/probe/probeSocket.js");
  clearProbeResults();
  res.json({ cleared: true });
});

// Caller audio for the probe leg, uploaded before a run.
//
// A dedicated body parser: the global express.json() caps at 100kb and the
// script is a few hundred kb of mu-law. Scoped to this route so the limit
// increase cannot widen the attack surface of any other endpoint — and the
// route itself is behind the same fail-closed token check.
app.post("/api/debug/probe-script", express.json({ limit: "8mb" }), async (req, res) => {
  if (!debugAccessAllowed(req)) return res.status(404).end();
  try {
    const { setProbeScript } = await import("./lib/probe/probeSocket.js");
    const summary = setProbeScript(req.body?.lines);
    log.info("probe_script_installed", summary);
    res.json({ installed: true, ...summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Probe-side ground truth: what the far end of the phone network measured.
// Kept separate from /latency because it comes from a different clock, and
// conflating the two is exactly the mistake this run exists to avoid.
app.get("/api/debug/probe-results", async (req, res) => {
  if (!debugAccessAllowed(req)) return res.status(404).end();
  const { getProbeResults } = await import("./lib/probe/probeSocket.js");
  const runs = getProbeResults();
  res.json({ calls: runs.length, runs });
});

// ---------------------------------------------------------------------------
// Centralized error handler — never expose stack traces
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  captureException(err);
  log.error("unhandled_error", { message: err.message, code: "unhandled" });
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Start (skip when running tests)
// ---------------------------------------------------------------------------

export { app };

// ---------------------------------------------------------------------------
// Media Streams — WebSocket server for real-time audio
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

/**
 * Pick the call pipeline for a new Media Streams connection.
 *
 * v2 (lib/voice/session.js) is the DEFAULT. PIPELINE_V2 is an opt-OUT: only
 * the explicit string "false" falls back to the legacy lib/mediaStream.js,
 * which is retained this release purely as a rollback escape hatch. Legacy
 * lacks the LLM turn timeout (a hung Gemini stream holds the call to the
 * 30-minute cap), the take-message fallback, ElevenLabs/per-business voice
 * selection (the dashboard's voice picker writes columns legacy never reads),
 * multilingual STT, the toSpeakable normalizer, the utterance cache, and VAD
 * barge-in — so it must never be what a real caller gets by default.
 *
 * @returns {Function} the connection handler
 */
export function selectPipelineHandler() {
  return process.env.PIPELINE_V2 === "false"
    ? handleMediaStreamConnection
    : handleVoiceSessionConnection;
}

/** Websocket path for the latency probe's scripted-caller leg. */
const PROBE_WS_PATH = "/twilio/probe-stream";

/**
 * Is this upgrade allowed to become a probe leg?
 *
 * Same fail-closed rule as the debug HTTP routes, but the token arrives as a
 * query param because Twilio's <Stream url="..."> cannot set headers. That
 * makes the URL itself a credential — it is generated per run and the whole
 * feature is off unless DEBUG_ENDPOINTS is explicitly "true".
 *
 * @param {URL} url
 * @returns {boolean}
 */
function probeUpgradeAllowed(url) {
  if (process.env.DEBUG_ENDPOINTS !== "true") return false;
  const expected = process.env.DEBUG_TOKEN;
  if (!expected) return false;
  // The token rides in the PATH, not the query string: Twilio does not carry a
  // <Stream url="..."> query string through to the websocket handshake, so a
  // ?token= form arrives empty and the upgrade is refused with a 31920 that
  // looks exactly like a broken endpoint. Query form is still accepted for
  // hand-testing with a normal websocket client.
  const fromPath = url.pathname.startsWith(`${PROBE_WS_PATH}/`)
    ? decodeURIComponent(url.pathname.slice(PROBE_WS_PATH.length + 1))
    : null;
  const supplied = fromPath || url.searchParams.get("token");
  if (!supplied) return false;
  const a = createHash("sha256").update(String(supplied)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function attachWebSocket(httpServer) {
  httpServer.on("upgrade", async (req, socket, head) => {
    // Only accept upgrades on the media-stream path
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    if (pathname === "/twilio/media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        selectPipelineHandler()(ws, req);
      });
    } else if (
      (pathname === PROBE_WS_PATH || pathname.startsWith(`${PROBE_WS_PATH}/`)) &&
      probeUpgradeAllowed(url)
    ) {
      // Scripted caller side of a latency probe call. Imported lazily so the
      // probe never loads — and costs nothing — in normal operation.
      const { handleProbeConnection } = await import("./lib/probe/probeSocket.js");
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProbeConnection(ws);
      });
    } else {
      socket.destroy();
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  const httpServer = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Voice webhook: ${VOICE_URL}`);
    console.log(
      `Status callback: ${STATUS_URL}. Configure this URL in your Twilio number/app statusCallback.`
    );
    const wsUrl = BASE_URL.replace(/^http/, "ws") + "/twilio/media-stream";
    console.log(`Media Streams (WebSocket): ${wsUrl}`);
    if (TRANSFER_NUMBER) {
      console.log(`Transfer number (env fallback): ${TRANSFER_NUMBER}`);
    } else {
      console.log(`TRANSFER_NUMBER not set — per-business transfer or disabled.`);
    }
    console.log(
      `Call time limit: ${CALL_MAX_DURATION_MS / 60000} minutes (CALL_MAX_DURATION_MINUTES)`
    );
  });
  attachWebSocket(httpServer);
}
