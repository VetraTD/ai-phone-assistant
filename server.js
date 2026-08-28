import "dotenv/config";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { captureException } from "./lib/sentry.js"; // init Sentry early (reads SENTRY_DSN)
import express from "express";
import { verifyTwilioSignature } from "./lib/twilioSignature.js";
import { fileDegradedVoicemail } from "./lib/degradedVoicemail.js";

import * as geminiService from "./services/gemini.js";
import * as db from "./services/db.js";
import { listIntegrationDefinitions } from "./config/integrationDefinitions.js";
import * as notifications from "./services/notifications.js";
import * as twilioNumbers from "./services/twilioNumbers.js";
import * as twilioRecordings from "./services/twilioRecordings.js";
import { WebSocketServer } from "ws";
import { handleVoiceSessionConnection } from "./lib/voice/session.js";
import * as callState from "./lib/callState.js";
import { normalizePhoneNumber } from "./lib/phone.js";
import { getCacheStats } from "./services/geminiCache.js";
import { STEPS } from "./lib/callState.js";
import { log } from "./lib/logger.js";
import { assertBootConfig } from "./lib/bootChecks.js";
import {
  mintMediaStreamToken,
  verifyMediaStreamToken,
  tokenFromPath,
  mediaStreamTokenRequired,
  mediaStreamTokenAvailable,
} from "./lib/mediaStreamToken.js";
import { sttProviderFor } from "./lib/voice/sttStream.js";
import { assertSttEncryption } from "./lib/voice/sttGoogle.js";
import { callerAllowlist, callerAllowed, buildRefusedTwiml } from "./lib/callerAllowlist.js";
import { requireBusinessAccess } from "./middleware/requireBusinessAccess.js";
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

// Required only when Vertex is NOT the backend, and this used to be
// unconditional — which was wrong in a way that mattered.
//
// A8 established that the API-key path is the Gemini Developer API (AI Studio),
// which the Google Cloud BAA does not cover, and lib/compliance.js REFUSES it in
// `hipaa` mode at client construction. So an unconditional requirement meant a
// HIPAA deployment could not start without carrying a credential it is
// forbidden to use — the boot check and the compliance guard demanding opposite
// things, with the operator in between.
//
// services/gemini.js already refuses to fall back from Vertex to the API key,
// so nothing here is a fallback: if VERTEX_ENABLED is set, that path is the one
// that runs and this key is not merely unnecessary but unwanted.
const VERTEX_ENABLED = process.env.VERTEX_ENABLED === "true" || process.env.VERTEX_ENABLED === "1";
if (!GEMINI_API_KEY && !VERTEX_ENABLED) {
  console.error(
    "Missing required env: GEMINI_API_KEY. Set it, or set VERTEX_ENABLED=true with " +
      "GOOGLE_CLOUD_PROJECT and VERTEX_LOCATION to use Vertex — which is the BAA-covered path."
  );
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
// DEEPGRAM_API_KEY is deliberately NOT required here any more.
//
// It used to be, unconditionally, with the comment "there is no fallback mode"
// — and that made a covered deployment impossible to start. lib/bootChecks.js
// `checkCoveredVendors` refuses to boot when a Deepgram credential is present
// in a `hipaa` process, because no BAA covers it, so this preflight and that
// check demanded opposite things and no configuration satisfied both. The US
// production stack could not answer a call in either direction.
//
// There IS now a second provider. The requirement moved to
// `checkSttConfig`, which asks the mode-shaped question — does this deployment
// have an STT it is ALLOWED to use — and is still fatal when the answer is no.

// Resolved once. An allowlist re-parsed per call is an allowlist that can
// change under a running process, which makes "who was allowed in" unanswerable
// after the fact.
const CALLER_ALLOWLIST = callerAllowlist();
if (CALLER_ALLOWLIST.active) {
  console.log(
    `[boot] CALLER_ALLOWLIST active: ${CALLER_ALLOWLIST.numbers.size} number(s) may call. ` +
      "Everyone else is refused. This is expected on staging and NOT expected in production."
  );
  if (CALLER_ALLOWLIST.malformed.length) {
    // Fatal, and it is the announce-loudly principle at its sharpest: a
    // malformed entry never matches, so the operator sees a configured
    // allowlist that admits nobody — including the tester it was written for.
    console.error(
      `[boot] FATAL CALLER_ALLOWLIST has ${CALLER_ALLOWLIST.malformed.length} entr(ies) that are not E.164 ` +
        "(+ and 1-15 digits). Twilio delivers `From` in E.164, so these can never match."
    );
    process.exit(1);
  }
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

// CORS allow-list.
//
// Both this server and the dashboard backend already allow-listed rather than
// reflecting the Origin header, so the shape was right. A9 fixes what was
// wrong inside it.
//
// 1. THE VERCEL PREVIEW DOMAIN IS GONE. `ai-phone-dashboard-lemon.vercel.app`
//    was allow-listed permanently, and D7 cancels the Vercel account. A
//    released Vercel subdomain can be claimed by anyone, so leaving it here
//    would hand a stranger a cross-origin foothold against an authenticated
//    dashboard session, at a moment nobody would connect to a hosting change.
//    It stays reachable through CORS_ORIGINS for as long as it is genuinely in
//    use, which is the difference between a deliberate entry and a permanent
//    one.
//
// 2. LOCALHOST IS DEV-ONLY. A production deployment allow-listing
//    http://localhost:5173 is not catastrophic, but it is an origin the
//    production server has no reason to trust, and it costs nothing to drop.
//
// 3. ONE ENVIRONMENT VARIABLE NAME. This server read CORS_ORIGIN and the
//    dashboard read CORS_ORIGINS — same concept, two spellings, and setting
//    the wrong one fails silently by allowing nothing extra. Both now read
//    CORS_ORIGINS, with the old singular still honoured so an existing
//    deployment does not break, and announced at boot when it is what is
//    actually in use. Exactly the class of drift D1 exists to reconcile.
const isProduction = process.env.NODE_ENV === "production";

const devCorsOrigins = ["http://localhost:5173", "http://localhost:4173"];
const prodCorsOrigins = ["https://vetratd.com", "https://www.vetratd.com"];

const envCorsOrigins = (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (!process.env.CORS_ORIGINS && process.env.CORS_ORIGIN) {
  log.error("cors_origin_deprecated", {
    reason: "CORS_ORIGIN is the old name; the dashboard backend reads CORS_ORIGINS. Set CORS_ORIGINS.",
    severity: "warn",
  });
}

const allowedCorsOrigins = [
  ...new Set([...(isProduction ? [] : devCorsOrigins), ...prodCorsOrigins, ...envCorsOrigins]),
];

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
// Top-level await is available in ESM, and this file is "type": "module".
// Wrapped so a rejection during startup exits non-zero with a reason rather
// than surfacing as an unhandled rejection warning on a process that keeps
// running without a database.
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
// Which build is this?
//
// Added after a staging deploy sat two rounds of fixes behind for twenty
// minutes without anyone being able to tell. Railway redeploys the CURRENT
// commit whenever an environment variable changes, so the dashboard read
// "deployed 19 minutes ago" while serving week-old code — and a test call was
// spent against it before the mismatch was spotted.
//
// The commit is not a secret (the repo is public, and a deploy's SHA leaks
// through behaviour anyway), and it turns "is my fix live?" into one curl
// instead of an inference from feature fingerprints. Falls back gracefully off
// Railway, where the variable simply does not exist.
const BUILD_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
const BUILD_BRANCH = process.env.RAILWAY_GIT_BRANCH || null;

app.get("/", (req, res) => {
  res.type("text/plain");
  const build = BUILD_SHA
    ? `\nBuild: ${BUILD_SHA.slice(0, 7)}${BUILD_BRANCH ? ` (${BUILD_BRANCH})` : ""}`
    : `\nBuild: unknown`;
  res.send(
    `AI phone assistant is running.\nVoice webhook: ${VOICE_URL}\nStatus callback: ${STATUS_URL}${build}`
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

  // The verification lives in lib/twilioSignature.js, and moving it there was
  // the fix for a bug that rejected EVERY request for the life of this
  // deployment.
  //
  // This file did `import * as twilio from "twilio"`. The package is CommonJS,
  // so Node's ESM interop puts only `default` on the namespace — making
  // `twilio.validateRequest` undefined. Calling it threw a TypeError, and the
  // try/catch that was added to turn a malformed signature into a clean 403
  // swallowed that TypeError into `valid = false`. Genuine Twilio requests got
  // the same 403 as forged ones.
  //
  // It survived because the middleware could not be imported by a test — it
  // lived in the file that boots the server — so it was "tested" by scanning
  // this source for the presence of a try/catch. Those scans passed. Three
  // negative tests passed. Nothing ever asserted that a GOOD signature is
  // ACCEPTED, and that is the only assertion that could tell "correctly
  // refuses bad input" apart from "refuses everything".
  const valid = verifyTwilioSignature({
    authToken: TWILIO_AUTH_TOKEN,
    signature,
    url,
    params: req.body,
  });

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
// <Gather> conversation loop has been removed — an STT provider the
// deployment is allowed to use is required at boot (checkSttConfig), so Media
// Streams is always available.
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

  // The staging caller allowlist, checked BEFORE anything looks up a business
  // or touches the database. A refused caller should leave no trace beyond the
  // refusal itself — the whole point is that this environment never holds data
  // about someone who did not mean to reach it.
  //
  // Inert in production, where CALLER_ALLOWLIST is unset.
  if (!callerAllowed(req.body.From, CALLER_ALLOWLIST)) {
    log.error("caller_not_on_allowlist", {
      callSid,
      severity: "warn",
      // The number itself is a PHI-typed field and does not go in a log line;
      // the allowlist size is what makes this actionable.
      allowlistSize: CALLER_ALLOWLIST.numbers.size,
      reason: "CALLER_ALLOWLIST is active and this caller is not on it. Expected on staging.",
    });
    return res.send(buildRefusedTwiml());
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

    // P10: the socket now carries a per-call credential.
    //
    // In the PATH, not a query string — Twilio does not carry a
    // `<Stream url="...">` query string through to the websocket handshake, and
    // a `?token=` form arrives empty (see probeUpgradeAllowed, which was bitten
    // by exactly this). The token is minted here because this is the one place
    // that has already proved the request came from Twilio: `twilioValidation`
    // ran on this route.
    const streamToken = mintMediaStreamToken(callSid);
    const wsUrl =
      BASE_URL.replace(/^http/, "ws") +
      "/twilio/media-stream" +
      (streamToken ? `/${encodeURIComponent(streamToken)}` : "");
    log.info("media_stream_initiated", { callSid, authenticated: streamToken !== null });
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
// Twilio POSTs here (recordingStatusCallback) once the Record verb from
// buildDegradedVoicemailTwiml finishes. We can't rely on callState/DB call
// rows here — degraded mode skips that setup entirely — so the business is
// looked up fresh from the dialed (To) number.
// ---------------------------------------------------------------------------

app.post("/twilio/voicemail", twilioValidation, async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || null;
  const twilioNumber = req.body.To || "";
  const recordingUrl = req.body.RecordingUrl || "";

  log.info("degraded_voicemail_received", { callSid });

  try {
    const business = db.isEnabled() && twilioNumber
      ? await db.lookupBusinessByPhone(twilioNumber)
      : null;

    if (business) {
      // Extracted to lib/degradedVoicemail.js (ledger O32). It was inline, and
      // that is how it stayed the LAST unscoped PHI write in the system after
      // every other one had been wrapped: `createCustomerRequest` ran with no
      // tenant scope, which on Cloud SQL means the INSERT is refused outright
      // and in `hipaa` mode means a PHI write with nowhere to record itself.
      // Behind a plain function it can be run by a test as the unprivileged
      // role, under the row-level security that is the point.
      await fileDegradedVoicemail({
        deps: { db, notifications, log, captureException },
        business,
        callerNumber,
        recordingUrl,
        callSid,
      });
    } else {
      // No business row, so there is nowhere to file this. The recording URL
      // goes in the log line so a real caller's message is recoverable by hand
      // rather than lost outright — this is the unrouted-number path as well as
      // the degraded one. A proper ops mailbox for these does not exist yet.
      //
      // A1.7 removed `callerNumber` and kept `recordingUrl`, which is an
      // uncomfortable pair to defend and is defensible: the recording is the
      // message, and dropping the pointer to it loses a real person's request
      // outright. The number is recoverable from Twilio using callSid. This
      // stays a known exception rather than a quiet one — the log is still the
      // only place an unrouted voicemail exists, and that is the actual defect.
      log.error("degraded_voicemail_no_business", {
        callSid,
        twilioNumber,
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
    // Read from the SHARED store, not local memory.
    //
    // This handler is an ordinary HTTP POST. On Cloud Run the load balancer
    // sends it to whichever instance is free, which is usually not the one
    // that held the WebSocket — so `callState.getState()` here would create a
    // fresh, empty state and the whole block below would silently do nothing:
    // no summary, no missed-call notification, and every short call tagged as
    // spam because sawCallerFinal read false on a caller who spoke.
    //
    // Awaited once, here, before anything else touches it. The values are then
    // held in locals for the same reason they were before: the async blocks
    // below outlive callState.remove() at the end of this handler.
    const shared = await callState.readShared(callSid);
    const dbCallId = shared.dbCallId ?? null;
    const businessId = shared.businessId ?? null;
    const sawCallerFinal = !!shared.sawCallerFinal;
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

    // Scoped, because completeCall is keyed by the Twilio call SID and carries
    // no business id — so under row-level security it matches nothing unless
    // somebody sets the tenant. `businessId` comes from the shared store above,
    // which is the whole reason A4 put it there.
    //
    // Safe rather than strict: this handler returning 500 makes Twilio RETRY
    // the callback, which turns one failed write into several.
    db.withTenantSafe(businessId, () => db.completeCall(callSid, status, duration), {
      operation: "completeCall",
      callSid,
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
      db.withTenantSafe(businessId, async () => {
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
      }, { operation: "generateSummary", callSid });
    }

    // Per-call turn-latency rollup (Part 2) — fire-and-forget; skip silently
    // if no turns were recorded for this call (e.g. degraded-mode voicemail
    // calls that never went through the real-time pipeline).
    if (status === "completed") {
      try {
        const stats = getCallStats(callSid);
        if (stats) {
          // Also SID-keyed, so also scoped. getCallStats reads an in-process
          // ring buffer, so on a cold instance it returns nothing and this
          // skips — the same per-process limitation A4 noted and did not fix.
          db.withTenantSafe(businessId, () => db.updateCallLatency(callSid, stats.avgMs, stats.p95Ms), {
            operation: "updateCallLatency",
            callSid,
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
// The three routes that shared this UUID-as-bearer-token hole are now closed
// (A1.5). /api/businesses/:id/notifications (GET+PUT) had zero callers and was
// deleted for the same reason this one was. /api/businesses/:id/phone-numbers/
// {available,buy} are live — Onboarding.jsx calls both — so they are guarded by
// requireBusinessAccess instead, which is the per-tenant check this file
// previously lacked. The dashboard was already sending a Supabase bearer token
// on every one of those requests; this server simply never read it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data-subject requests (UK GDPR Art. 15 access, Art. 17 erasure)
//
// Behind requireBusinessAccess, which is the whole reason these can live on
// this server at all. The caller route that used to sit here was DELETED by
// A1.5 because it served a caller's call history and upcoming appointments to
// anyone who knew a business UUID and a phone number — a UUID is an
// identifier, not a secret, and at the time this server had no per-tenant
// check to apply. A1.5 added one. These routes are strictly more sensitive
// than the one that was removed, so they get it unconditionally.
//
// Staff-operated rather than self-service: a data subject asks the clinic, the
// clinic runs it. Verifying that a caller on the phone is who they say they
// are is a problem this system cannot solve, and Art. 12(6) expects a
// controller to confirm identity before disclosing. Getting that wrong turns a
// compliance feature into a disclosure channel.
// ---------------------------------------------------------------------------

/** Shared parsing for both routes: a valid tenant and a plausible phone. */
function dsrParams(req, res) {
  const businessId = req.params.id;
  if (!businessId || !isValidUUID(businessId)) {
    res.status(400).json({ error: "Invalid business id" });
    return null;
  }
  const phone = req.params.phone;
  // Loose on purpose. The stored spellings are inconsistent — E.164 from
  // Twilio, hand-typed rows from the dashboard — and the matching is done on
  // the last ten digits, so demanding E.164 here would reject the very inputs
  // a member of staff is most likely to paste out of a ticket.
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 7) {
    res.status(400).json({ error: "Invalid phone number" });
    return null;
  }
  return { businessId, phone };
}

// GET — Art. 15. Everything held about one caller, for one tenant.
app.get("/api/businesses/:id/callers/:phone/export", requireBusinessAccess, async (req, res) => {
  const parsed = dsrParams(req, res);
  if (!parsed) return;
  if (!db.isEnabled()) return res.status(503).json({ error: "Database is not configured" });

  // Scoped: one HTTP handler is a unit of work, and requireBusinessAccess has
  // already proven this caller owns this tenant. Under row-level security the
  // export reads nothing without it.
  const data = await db.withTenant(
    parsed.businessId,
    () => db.exportCallerData(parsed.businessId, parsed.phone),
    // The actor, so §164.312(b)'s row names a unique staff member rather than
    // "system". A subject-access request is the single largest disclosure this
    // system performs on purpose; "somebody exported everything about a patient
    // and we do not know who" is not an acceptable audit answer.
    { actor: { type: "user", id: req.user?.id } }
  ).catch(() => null);
  if (!data) return res.status(500).json({ error: "Export failed" });

  // Logged as an event because an access request is itself a processing
  // activity worth recording under Art. 30 — with no phone number in it, since
  // this log is not the place to publish the thing being asked about.
  log.info("dsr_export_served", {
    businessId: parsed.businessId,
    calls: data.calls.length,
    transcripts: data.transcripts.length,
    appointments: data.appointments.length,
    customerRequests: data.customerRequests.length,
  });

  res.json({
    subject: { phone: parsed.phone },
    generatedAt: new Date().toISOString(),
    ...data,
  });
});

// DELETE — Art. 17. See services/db.js eraseCallerData for what is erased,
// what is kept, and the HIPAA retention tension flagged for counsel.
app.delete("/api/businesses/:id/callers/:phone", requireBusinessAccess, async (req, res) => {
  const parsed = dsrParams(req, res);
  if (!parsed) return;
  if (!db.isEnabled()) return res.status(503).json({ error: "Database is not configured" });

  const actor = { actor: { type: "user", id: req.user?.id } };

  // -------------------------------------------------------------------------
  // O28 — the erasure has to reach Twilio, and the ORDER is the design.
  //
  // The degraded voicemail path files `Voicemail recording: <url>` into a
  // customer_requests message and the audio itself lives at Twilio. Erasing our
  // rows first would NULL that message — destroying the only pointer to audio
  // that still exists. For exactly these rows the pointer is all there is: the
  // degraded path creates no `calls` row at all, so there is no call SID to
  // recover the recording from afterwards.
  //
  // So: read the pointers, delete at the vendor, then erase our rows. A failure
  // at any earlier step leaves everything needed to try again.
  //
  // Three separate units of work, not one. A Twilio call must not happen inside
  // an open transaction — services/db.js's rule is "wrap a unit of work, never
  // a call", and a network round trip to a third party is the clearest case of
  // something that does not belong inside one.
  // -------------------------------------------------------------------------
  const messages = await db
    .withTenant(parsed.businessId, () => db.listCallerRecordingMessages(parsed.businessId, parsed.phone), actor)
    .catch(() => null);
  if (messages === null) return res.status(500).json({ status: "failed", error: "Erasure failed" });

  const recordingSids = messages.flatMap((m) => twilioRecordings.recordingSidsInText(m));
  const vendor = await twilioRecordings.deleteRecordings(recordingSids);

  // The database erasure runs REGARDLESS of what Twilio did. Twilio being
  // unreachable must not leave the data subject's rows in place as well — that
  // would turn one vendor's outage into a total refusal of a statutory right.
  //
  // Scoped, and NOT `withTenantSafe`: an erasure that partly failed must not
  // report success. withTenant rolls back and rethrows; the catch below turns
  // that into a 500, which is the honest answer.
  const counts = await db
    .withTenant(parsed.businessId, () => db.eraseCallerData(parsed.businessId, parsed.phone), actor)
    .catch(() => null);
  if (!counts) return res.status(500).json({ status: "failed", error: "Erasure failed" });

  if (!vendor.ok) {
    // NOT 200, and NOT 207 Multi-Status either.
    //
    // 207 is the semantically neat answer and it is the wrong one: it is 2xx,
    // and every default client-side `res.ok` check reads 2xx as success — which
    // is the precise misread this exists to prevent. The failure mode that
    // matters is a member of staff ticking "erasure complete" off a green
    // response.
    //
    // A non-2xx makes "not done" the default reading. The body still reports
    // what WAS erased, so nobody re-runs blindly — and re-running is safe
    // anyway: already-nulled rows are a no-op and an already-deleted recording
    // is a 404, which deleteRecordings counts as success.
    //
    // No operator override is offered. "Proceed anyway and accept the audio
    // stays at Twilio" is a decision with a legal shape, and it belongs to the
    // owner and O18 counsel rather than to a query parameter.
    log.error("dsr_erasure_blocked_by_vendor", {
      businessId: parsed.businessId,
      vendor: "twilio",
      outstanding: vendor.failed.length,
      reason: vendor.reason,
      severity: "warn",
    });
    return res.status(502).json({
      status: "partial",
      erased: counts,
      outstanding: {
        vendor: "twilio",
        recordings: vendor.failed.length,
        reason: vendor.reason,
      },
    });
  }

  log.info("dsr_erasure_served", {
    businessId: parsed.businessId,
    recordingsDeleted: vendor.deleted.length,
    recordingsAlreadyGone: vendor.alreadyGone.length,
  });

  // `erased` keeps its exact shape. The new `status` is additive so an existing
  // consumer reading `body.erased` is unaffected.
  res.json({ status: "complete", erased: counts });
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
// Dashboard API: search and buy Twilio phone numbers
// ---------------------------------------------------------------------------

app.get("/api/businesses/:id/phone-numbers/available", requireBusinessAccess, async (req, res) => {
  const businessId = req.params.id;
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
  // Scoped. requireBusinessAccess has already proven this caller owns this
  // tenant; under row-level security the read returns nothing without it.
  const business = await db.withTenantSafe(businessId, () => db.fetchBusinessById(businessId), {
    operation: "fetchBusinessById",
  });
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

app.post("/api/businesses/:id/phone-numbers/buy", requireBusinessAccess, async (req, res) => {
  const businessId = req.params.id;
  if (!businessId || !isValidUUID(businessId)) return res.status(400).json({ error: "Invalid business id" });
  // Scoped. requireBusinessAccess has already proven this caller owns this
  // tenant; under row-level security the read returns nothing without it.
  const business = await db.withTenantSafe(businessId, () => db.fetchBusinessById(businessId), {
    operation: "fetchBusinessById",
  });
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
    const ok = await db.withTenantSafe(
      businessId,
      () => db.updateBusinessPhoneNumber(businessId, result.phone_number),
      { operation: "updateBusinessPhoneNumber", fallback: false }
    );
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
 * The call pipeline for a new Media Streams connection.
 *
 * There is one. A10 deleted lib/mediaStream.js and the PIPELINE_V2 opt-out
 * that reached it.
 *
 * The escape hatch was retained for exactly one release, and by the end of it
 * the two pipelines were not comparable. v2 has the LLM turn timeout (without
 * which a hung Gemini stream holds a call to the 30-minute cap), the
 * deterministic take-message fallback, per-business voice selection, ElevenLabs
 * streaming, multilingual STT, the toSpeakable normalizer, the utterance cache,
 * and VAD barge-in. Setting PIPELINE_V2=false during an incident would not have
 * been a rollback, it would have been a second, worse incident — and one nobody
 * had exercised, since every measurement in the ledger (A0's baseline, the
 * probe, the eval suite) runs through v2.
 *
 * A rollback path that is never tested is not a rollback path. The real one is
 * the ledger's, and it is better: repoint the Twilio webhooks.
 *
 * @returns {Function} the connection handler
 */
export function selectPipelineHandler() {
  return handleVoiceSessionConnection;
}

/** Websocket path for the latency probe's scripted-caller leg. */
const PROBE_WS_PATH = "/twilio/probe-stream";

/** Websocket path Twilio Media Streams connects to. The token follows it. */
const MEDIA_WS_PATH = "/twilio/media-stream";

/**
 * May this upgrade become a call, and which call is it allowed to be?
 *
 * Exported for the test that matters most: the one asserting a GOOD token is
 * ACCEPTED. This file already carries the scar — `verifyTwilioSignature` was
 * broken for the life of a deployment and rejected EVERY request, and three
 * negative tests plus a source scan all passed, because nothing ever asserted
 * the positive case. "Correctly refuses bad input" and "refuses everything"
 * are indistinguishable without it.
 *
 * @param {string} pathname
 * @returns {{ ok: boolean, callSid: string|null, reason: string|null }}
 */
export function mediaStreamUpgradeVerdict(pathname, env = process.env) {
  if (!mediaStreamTokenRequired(env)) {
    // Dev, and the same switch that turns off signature validation. Announced
    // at boot rather than only here, so it cannot be the quiet default.
    return { ok: true, callSid: null, reason: "enforcement_disabled" };
  }
  return verifyMediaStreamToken(tokenFromPath(pathname, MEDIA_WS_PATH), { env });
}

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
    if (pathname === MEDIA_WS_PATH || pathname.startsWith(`${MEDIA_WS_PATH}/`)) {
      // P10. This path used to accept ANY upgrade — no signature, no token —
      // while /twilio/probe-stream below it required one. Each accepted socket
      // costs a Deepgram stream, Gemini turns and ElevenLabs synthesis, and ten
      // of them exhaust the measured 10-concurrent ElevenLabs cap that real
      // callers share, so the hole was a bill and an outage as well as a data
      // question.
      const verdict = mediaStreamUpgradeVerdict(pathname);
      if (!verdict.ok) {
        log.error("media_stream_upgrade_refused", { reason: verdict.reason, ip: req.socket?.remoteAddress });
        // 403 before the handshake completes. Nothing is allocated: no
        // Deepgram connection, no tenant lookup, no spend.
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // The other half of the control. Without this, ONE valid token would
        // authorise a session for any other call the caller cared to name in
        // the `start` frame. null when enforcement is off.
        ws.authorizedCallSid = verdict.callSid;
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
  // Before the port opens, not after. A configuration problem that surfaces on
  // the first real call surfaces during a real call — the point of this is that
  // it is impossible to be running and quietly broken at the same time.
  //
  // It throws rather than exiting, so the failure travels the same path as any
  // other startup error and a supervisor sees a non-zero exit with a reason.
  assertBootConfig();

  // Cloud SQL's pool is built asynchronously (the connector fetches ephemeral
  // client certificates), so it cannot be created at module load the way a
  // DATABASE_URL pool is. Awaited HERE, before the port opens, for the same
  // reason assertBootConfig runs here: a deployment that is listening and has
  // no database is a deployment that answers a call and knows nothing about the
  // business it is answering for.
  //
  // A no-op unless CLOUD_SQL_INSTANCE is set.
  await db.initCloudSqlPool();

  // AFTER the pool, because the Postgres store shares it rather than opening a
  // second one — `instances x DB_POOL_MAX` under the instance's
  // `max_connections` is the capacity constraint that binds this system, and
  // call state must not move that number.
  //
  // Before the port opens, like everything else here: CALL_STATE_STORE=pg
  // without a database throws, and it has to throw at boot. A process that
  // starts with the wrong store answers calls flawlessly and loses the summary,
  // the missed-call notification and the spam decision on every call whose
  // status callback lands on another instance — with nothing in the logs.
  callState.initCallStateStore({ pool: db.getPool() });

  // The covered lane's encryption control, verified against the live API
  // before the port opens rather than trusted from configuration.
  //
  // Google exposes NO field for the Speech-to-Text data-logging tier — the
  // string does not appear anywhere in the v1 or v2 protos — while the
  // "Logged" SKU is real and cheaper ($0.012/min against $0.016). So the tier
  // cannot be asserted in code, and the encryption of the audio at rest can:
  // with a customer-managed key the recording is under a key this org holds
  // and can destroy. Runs only where it applies, and only where a failure
  // means something — a `standard` deployment does not use Google STT at all.
  if (sttProviderFor() === "google") {
    const { kmsKeyName } = await assertSttEncryption();
    console.log(`[boot] Speech-to-Text CMEK verified: ${kmsKeyName}`);
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Voice webhook: ${VOICE_URL}`);
    console.log(
      `Status callback: ${STATUS_URL}. Configure this URL in your Twilio number/app statusCallback.`
    );
    const wsUrl = BASE_URL.replace(/^http/, "ws") + "/twilio/media-stream";
    console.log(`Media Streams (WebSocket): ${wsUrl}/<per-call token>`);
    // Announced at boot, because a subsystem that is off must say so — the
    // difference between "protected" and "open to anyone who knows the URL" is
    // otherwise invisible until somebody finds it.
    if (!mediaStreamTokenRequired()) {
      console.error(
        "[boot] WARNING media-stream upgrades are NOT authenticated " +
          "(TWILIO_VALIDATE_SIGNATURE=false). Anyone who knows this URL can open a call, spend " +
          "vendor credit and consume the concurrency cap. Expected in dev, never in production."
      );
    } else if (!mediaStreamTokenAvailable()) {
      // Fail-closed, so this is a total outage rather than a silent hole — and
      // it must be legible as such, since "no calls connect" otherwise reads as
      // a Twilio or networking fault.
      console.error(
        "[boot] FATAL-ish media-stream tokens are REQUIRED but no signing key exists " +
          "(set TWILIO_AUTH_TOKEN, or MEDIA_STREAM_SECRET). Every upgrade will be refused with 403."
      );
    } else {
      console.log("[boot] media-stream upgrades require a per-call token.");
    }
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
