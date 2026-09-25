// lib/outbound/doorRoutes.js
/**
 * The three doors every outbound call answers, statuses and plays voicemail
 * through (spec §9.1, plan C15):
 *   POST /twilio/outbound-answer  -- Twilio hits this the instant the call is
 *     picked up. Connects the same media stream inbound uses, tagged
 *     direction=outbound, so lib/voice/live/index.js's onStart (Task 14)
 *     knows which context to resolve.
 *   POST /twilio/outbound-status  -- the lifecycle callback: dispatch's
 *     calls.create points statusCallback here, NOT at /twilio/status
 *     (server.js:806), because outbound must never run inbound's missed-call
 *     text-back or spam heuristic (server.js:851-905, Ruling P-2).
 *   GET /media/outbound/:callSid/:kind.wav -- serves the pre-rendered
 *     voicemail clip to Twilio's <Play>, gated by lib/outbound/mediaUrl.js's
 *     signed URL (there is no Twilio signature on that fetch).
 *
 * All three resolve the tenant with `db.outboundAttemptByCallSid` (Task 3,
 * migration 044) rather than trusting anything the request itself carries --
 * the CallSid is the one thing Twilio's own infrastructure attaches, and
 * everything else here is derived from it, never accepted from the caller.
 *
 * ---------------------------------------------------------------------------
 * Dependency injection, not server.js internals
 * ---------------------------------------------------------------------------
 *
 * `validate` is server.js's `twilioValidationAnyAccount`, passed in rather
 * than imported, matching lib/outbound/internalRoutes.js's own rule: this
 * module must be testable with a fake db and a fake validator, and must not
 * import server.js (a real circular import, and a much bigger surface than
 * this file needs).
 *
 * `postCall` is Task 20's placeholder today: server.js passes an object whose
 * `tryClaim` resolves false. This file only ever calls `postCall.tryClaim`,
 * never anything else on it, so swapping in the real implementation later is
 * a one-line change at the call site in server.js.
 */
import { escapeXml } from "../twiml.js";
import { mulawToWav } from "../audio/wav.js";
import { verifyMediaUrl } from "./mediaUrl.js";
import { log as defaultLog } from "../logger.js";

const ANSWER_PATH = "/twilio/outbound-answer";
const STATUS_PATH = "/twilio/outbound-status";
const MEDIA_PATH = "/media/outbound/:callSid/:kind.wav";

/** Twilio CallStatus values that end the attempt (spec §9.1/§9.4). */
const TERMINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

/**
 * `result` values the door itself sets. `completed`'s eventual result
 * (connected / voicemail_left / voicemail_skipped / spam, etc) is decided by
 * the AMD route (Task 13) and post-call (Task 20), never here.
 */
const RESULT_BY_STATUS = Object.freeze({
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
});

/** BASE_URL, trailing slash stripped, the same normalisation config.js uses. */
function baseUrl(env) {
  return (env.BASE_URL || "").replace(/\/$/, "");
}

/**
 * Build the outbound answer TwiML. Mirrors server.js's buildStreamTwiml (the
 * same host/scheme derivation from BASE_URL, http -> ws), but with a single
 * `direction=outbound` Parameter instead of businessPhone/callerPhone -- the
 * outbound session resolves its own context by CallSid (spec §9.2), it does
 * not need either number handed to it on the stream.
 */
function buildAnswerTwiml(env, token) {
  const wsUrl = `${baseUrl(env).replace(/^http/, "ws")}/twilio/live-stream${token ? `/${encodeURIComponent(token)}` : ""}`;
  return (
    `<Response><Connect><Stream url="${wsUrl}">` +
    `<Parameter name="direction" value="outbound"/>` +
    `</Stream></Connect></Response>`
  );
}

/**
 * Owner ruling (session 2b, overriding the plan's bare <Hangup/>): the person
 * picked up, so they must hear who called, even when we cannot place the
 * call. {business} is the name of the business that owns OUR number (the
 * request's From), resolved fresh -- this path runs precisely when the
 * CallSid did NOT resolve, so there is no attempt row to read a name from.
 *
 * Ruling P-1: a lookup miss or a throw gets the same generic line, never
 * silence.
 */
function buildMissTwiml(businessName) {
  const say = businessName
    ? `Sorry, this is ${escapeXml(businessName)} calling. We'll try you again later. Goodbye.`
    : `Sorry, we'll try you again later. Goodbye.`;
  return `<Response><Say>${say}</Say><Hangup/></Response>`;
}

/**
 * Mount the outbound door routes on `app`.
 *
 * @param {import("express").Express} app
 * @param {{
 *   validate: import("express").RequestHandler,
 *   db: typeof import("../../services/db.js"),
 *   mintToken: (callSid: string) => string|null,
 *   postCall: { tryClaim: (callSid: string) => Promise<boolean> },
 *   log?: typeof defaultLog,
 *   now?: () => number,
 *   env?: NodeJS.ProcessEnv,
 * }} deps
 */
export function registerOutboundDoorRoutes(app, deps) {
  const { validate, db, mintToken, postCall, log = defaultLog, now = () => Date.now(), env = process.env } = deps;

  app.post(ANSWER_PATH, validate, async (req, res) => {
    res.type("text/xml");
    const callSid = req.body?.CallSid || "";
    const fromNumber = req.body?.From || "";

    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_answer_lookup_failed", { callSid, message: err?.message, severity: "warn" });
    }

    if (attempt) {
      const token = mintToken(callSid);
      log.info("outbound_answered", { callSid, businessId: attempt.businessId, attemptId: attempt.attemptId });
      return res.send(buildAnswerTwiml(env, token));
    }

    let business = null;
    try {
      business = fromNumber ? await db.lookupBusinessByPhone(fromNumber) : null;
    } catch (err) {
      log.error("outbound_answer_business_lookup_failed", { callSid, message: err?.message, severity: "warn" });
      business = null; // Ruling P-1: a throw reads exactly like a miss -- never silence.
    }
    const businessResolved = !!business?.name;
    log.info("outbound_context_missing", { callSid, businessResolved });
    return res.send(buildMissTwiml(businessResolved ? business.name : null));
  });

  app.post(STATUS_PATH, validate, async (req, res) => {
    const callSid = req.body?.CallSid || "";
    const status = (req.body?.CallStatus || "").toLowerCase();

    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_status_lookup_failed", { callSid, status, message: err?.message, severity: "warn" });
    }

    // Carried from the 2a ledger (Ruling 2a-9): dispatch cancels an
    // unroutable call, so a status callback for a CallSid that was never
    // stored is expected traffic, not an error. 200, never a retry.
    if (!attempt) {
      log.info("outbound_status_unknown_sid", { callSid, status });
      return res.status(200).end();
    }

    const answered = status === "in-progress";
    const terminal = TERMINAL_STATUSES.has(status);
    const result = RESULT_BY_STATUS[status] ?? null;
    const duration = req.body?.CallDuration != null ? Number(req.body.CallDuration) : null;

    await db.withTenantSafe(
      attempt.businessId,
      async () => {
        await db.stampAttemptStatus(attempt.attemptId, { twilioStatus: status, answered, terminal, result });
        if (terminal) {
          // Ruling P-2: /twilio/status (inbound) never runs for an outbound
          // call, so the door completes the `calls` row itself, if one
          // exists -- the SAME function inbound uses (server.js:857), which
          // is a no-op UPDATE (0 rows) when no `calls` row was ever created
          // (e.g. no-answer/busy/failed before the Live session's onStart
          // ran). No SMS, no spam heuristic, no owner notification, no
          // summary -- post-call (Task 20) owns those.
          await db.completeCall(callSid, status, duration);
        }
      },
      { operation: "outboundStatusUpdate", callSid }
    );

    if (terminal) {
      try {
        await postCall.tryClaim(callSid);
      } catch (err) {
        log.error("outbound_post_call_claim_failed", { callSid, message: err?.message, severity: "warn" });
      }
    }

    res.status(200).end();
  });

  app.get(MEDIA_PATH, async (req, res) => {
    const { callSid, kind } = req.params;
    const { exp, sig } = req.query;

    // Spec §9.1: kind is "voicemail" today. Anything else 404s, the same
    // answer as a real miss -- the set of valid kinds is not a secret worth
    // a distinguishable refusal for.
    if (kind !== "voicemail") return res.status(404).end();

    const verdict = verifyMediaUrl({ callSid, kind, exp, sig, now: now(), env });
    if (!verdict.ok) {
      log.info("outbound_media_refused", { callSid, kind, reason: verdict.reason });
      return res.status(403).end();
    }

    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_media_lookup_failed", { callSid, message: err?.message, severity: "warn" });
    }
    if (!attempt) return res.status(404).end();

    let audio = null;
    try {
      audio = await db.withTenant(
        attempt.businessId,
        () => db.fetchAttemptVoicemailAudio(attempt.attemptId),
        { callSid }
      );
    } catch (err) {
      log.error("outbound_media_read_failed", { callSid, message: err?.message, severity: "warn" });
    }
    if (!audio) return res.status(404).end();

    res.type("audio/wav");
    return res.send(mulawToWav(audio));
  });
}
