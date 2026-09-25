// lib/outbound/doorRoutes.js
/**
 * The four doors every outbound call answers, statuses, AMD-verdicts and
 * plays voicemail through (spec §9.1, plan C15):
 *   POST /twilio/outbound-answer  -- Twilio hits this the instant the call is
 *     picked up. Connects the same media stream inbound uses, tagged
 *     direction=outbound, so lib/voice/live/index.js's onStart (Task 14)
 *     knows which context to resolve.
 *   POST /twilio/outbound-status  -- the lifecycle callback: dispatch's
 *     calls.create points statusCallback here, NOT at /twilio/status
 *     (server.js:806), because outbound must never run inbound's missed-call
 *     text-back or spam heuristic (server.js:851-905, Ruling P-2).
 *   POST /twilio/outbound-amd  -- the async AMD verdict (spec §9.4, Task 13).
 *     Decides via lib/outbound/amd.js's decideAmd, then redirects a machine-
 *     answered call by Twilio REST (a voicemail <Play> or a hangup) rather
 *     than through the media stream -- the cross-instance rule (spec §9,
 *     "Cross-instance rule"): the AMD callback can land on a different
 *     instance than the one holding the call's WebSocket.
 *   GET /media/outbound/:callSid/:kind.wav -- serves the pre-rendered
 *     voicemail clip to Twilio's <Play>, gated by lib/outbound/mediaUrl.js's
 *     signed URL (there is no Twilio signature on that fetch).
 *
 * All four resolve the tenant with `db.outboundAttemptByCallSid` (Task 3,
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
import { signMediaUrl, verifyMediaUrl } from "./mediaUrl.js";
import { mediaStreamTokenRequired } from "../mediaStreamToken.js";
import { getProfile } from "../voice/localeProfiles.js";
import { countryFromE164 } from "../phone.js";
import { decideAmd, isMachineEnd } from "./amd.js";
import { bumpCounter } from "../voice/metrics.js";
import { log as defaultLog } from "../logger.js";

const ANSWER_PATH = "/twilio/outbound-answer";
const STATUS_PATH = "/twilio/outbound-status";
const AMD_PATH = "/twilio/outbound-amd";
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
 *
 * Fix round 1, item 11 (controller ruling): the <Say> uses the SAME
 * voice/language selection inbound uses for its own <Say> lines --
 * `getProfile(...).twimlSayVoice`, chosen by country the same way server.js
 * picks its unrouted-call profile (buildUnroutedVoicemailTwiml's caller,
 * server.js:707-709): GB if either number on the call is a UK number, US
 * otherwise. `getProfile("en-US")` IS the plain default (`Polly.Joanna`,
 * `lib/twiml.js`'s DEFAULT_VOICE) when neither number resolves a country.
 */
function buildMissTwiml(businessName, sayVoice) {
  const say = businessName
    ? `Sorry, this is ${escapeXml(businessName)} calling. We'll try you again later. Goodbye.`
    : `Sorry, we'll try you again later. Goodbye.`;
  const voiceAttr = sayVoice || getProfile("en-US").twimlSayVoice;
  return `<Response><Say voice="${voiceAttr}">${say}</Say><Hangup/></Response>`;
}

/**
 * Country-based voice profile for the two numbers on this call (fix round 1,
 * item 11), the same OR-of-either-number rule server.js's own unrouted-call
 * path uses. Neither number's country is read from a business row -- both
 * are raw E.164 strings off the request, so this resolves identically
 * whether or not a business was found.
 */
function missCallProfile(fromNumber, toNumber) {
  return getProfile(
    countryFromE164(fromNumber) === "GB" || countryFromE164(toNumber) === "GB" ? "en-GB" : "en-US"
  );
}

/**
 * Resolve the business that owns OUR number (the request's From) and build
 * the miss-path TwiML -- shared by the true "CallSid did not resolve" miss
 * and the "resolved, but no token to mint" case (fix round 1, item 2), so
 * both speak with the SAME wording and the SAME voice selection.
 */
async function resolveMissTwiml({ db, log, callSid, fromNumber, toNumber }) {
  let business = null;
  try {
    business = fromNumber ? await db.lookupBusinessByPhone(fromNumber) : null;
  } catch (err) {
    log.error("outbound_answer_business_lookup_failed", { callSid, message: err?.message, severity: "warn" });
    business = null; // Ruling P-1: a throw reads exactly like a miss -- never silence.
  }
  const businessName = business?.name || null;
  const profile = missCallProfile(fromNumber, toNumber);
  return { twiml: buildMissTwiml(businessName, profile.twimlSayVoice), businessResolved: !!businessName };
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
 *   twilioClientFor: (callerId?: string) => import("twilio").Twilio,
 *   log?: typeof defaultLog,
 *   now?: () => number,
 *   env?: NodeJS.ProcessEnv,
 * }} deps
 */
export function registerOutboundDoorRoutes(app, deps) {
  const { validate, db, mintToken, postCall, twilioClientFor, log = defaultLog, now = () => Date.now(), env = process.env } = deps;

  app.post(ANSWER_PATH, validate, async (req, res) => {
    res.type("text/xml");
    const callSid = req.body?.CallSid || "";
    const fromNumber = req.body?.From || "";
    const toNumber = req.body?.To || "";

    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_answer_lookup_failed", { callSid, message: err?.message, severity: "warn" });
    }

    if (attempt) {
      const token = mintToken(callSid);
      // Fix round 1, item 2: a null token with a signature REQUIRED
      // deployment (e.g. only TWILIO_AUTH_TOKEN_ALT is set -- signingKey only
      // ever reads TWILIO_AUTH_TOKEN) means the Stream URL below would carry
      // no credential, the websocket upgrade 403s, and the call goes
      // completely silent -- the one outcome worse than a hang-up. Mirrors
      // inbound's own guard (server.js:575-578), but there is no cascade
      // front-end on the outbound side to fall back to, so this answers with
      // the same ID line the miss path uses instead of throwing.
      if (token === null && mediaStreamTokenRequired(env)) {
        log.error("outbound_answer_token_unavailable", {
          callSid,
          businessId: attempt.businessId,
          attemptId: attempt.attemptId,
          severity: "warn",
        });
        const { twiml } = await resolveMissTwiml({ db, log, callSid, fromNumber, toNumber });
        return res.send(twiml);
      }
      log.info("outbound_answered", { callSid, businessId: attempt.businessId, attemptId: attempt.attemptId });
      return res.send(buildAnswerTwiml(env, token));
    }

    const { twiml, businessResolved } = await resolveMissTwiml({ db, log, callSid, fromNumber, toNumber });
    log.info("outbound_context_missing", { callSid, businessResolved });
    return res.send(twiml);
  });

  app.post(STATUS_PATH, validate, async (req, res) => {
    const callSid = req.body?.CallSid || "";
    const status = (req.body?.CallStatus || "").toLowerCase();

    let attempt = null;
    let lookupFailed = false;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      log.error("outbound_status_lookup_failed", { callSid, status, message: err?.message, severity: "warn" });
      lookupFailed = true;
    }

    // Fix round 1, item 4: a THROW is not a clean miss. Treating it as one
    // (as this used to) skipped the stamp, completeCall AND tryClaim, and
    // left the attempt counting against dial_registry capacity (migration
    // 044) for up to an hour with no way to find out. 5xx so Twilio retries
    // the callback -- only a genuine miss (no error, no row) is "unknown SID".
    if (lookupFailed) {
      return res.status(500).end();
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
        const stamp = await db.stampAttemptStatus(attempt.attemptId, { twilioStatus: status, answered, terminal, result });
        // Ruling (controller, fix round 1, item 9): completeCall runs only on
        // the FIRST terminal stamp of an attempt that was actually ANSWERED.
        // /twilio/status (inbound) never runs for an outbound call, so the
        // door completes the `calls` row itself -- the SAME function inbound
        // uses (server.js:857) -- but only once and only when there is a
        // `calls` row to complete: Task 14 creates that row from the Live
        // session's onStart, which runs only on an answered call. Without
        // this gate, a duplicate terminal callback would move
        // `calls.ended_at` a second time, and busy/no-answer/failed/canceled
        // (never answered, never any `calls` row) would file a rowCount-0 PHI
        // write audit for a write that touched nothing. No SMS, no spam
        // heuristic, no owner notification, no summary either way -- post-call
        // (Task 20) owns those.
        if (terminal && stamp.firstTerminalStamp && stamp.answered) {
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

  app.post(AMD_PATH, validate, async (req, res) => {
    const callSid = req.body?.CallSid || "";
    const answeredBy = req.body?.AnsweredBy || null;
    const durationRaw = req.body?.MachineDetectionDuration;
    const amdDurationMs =
      durationRaw != null && durationRaw !== "" && Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : null;

    let attempt = null;
    try {
      attempt = await db.outboundAttemptByCallSid(callSid);
    } catch (err) {
      // Same ruling as /twilio/outbound-status (fix round 1, item 4): a
      // THROW is not a clean miss -- 5xx so Twilio retries, rather than
      // silently dropping an AMD verdict for an attempt that likely exists.
      log.error("outbound_amd_lookup_failed", { callSid, message: err?.message, severity: "warn" });
      return res.status(500).end();
    }

    // Ruling (session 2b): carried from the 2a ledger the same way the
    // status door's own miss case is (Ruling 2a-9) -- dispatch can cancel an
    // unroutable call, so an AMD callback for a CallSid that was never
    // stored is expected traffic, not an error.
    if (!attempt) {
      log.info("outbound_amd_unknown_sid", { callSid });
      return res.status(200).end();
    }

    const { businessId, attemptId } = attempt;

    // Record what Twilio observed -- and read the campaign context decideAmd
    // needs -- in ONE transaction, before anything is decided. `result: null`
    // is a no-op write (stampAttemptAmd's own COALESCE), so this landing
    // before a verdict exists is safe, and Task 20's silent-call accounting
    // (which reads answered_by) sees it even if the write below never runs.
    // A degrade here (no pool, no tenant, or a thrown error) falls back to
    // `ctx: null`, and decideAmd's own field-by-field defaults treat that the
    // same as "cannot confirm eligibility" -- never a voicemail play for a
    // campaign this couldn't verify authorised one.
    const ctx = await db.withTenantSafe(
      businessId,
      async () => {
        await db.stampAttemptAmd(attemptId, { answeredBy, amdDurationMs, result: null });
        return db.outboundAmdContext(attemptId);
      },
      { operation: "outboundAmdRecord", callSid }
    );

    log.info("outbound_amd", { callSid, attemptId, answered_by: answeredBy });

    const decision = decideAmd({
      answeredBy,
      attemptNo: ctx?.attemptNo,
      voicemailOn: ctx?.voicemailOn,
      complianceClass: ctx?.complianceClass,
    });

    // human/unknown ("none") and machine_start ("wait"): the fields above are
    // already recorded, and spec §9.4 says to change nothing else.
    if (decision.action === "none" || decision.action === "wait") {
      return res.status(200).end();
    }

    const client = twilioClientFor(); // account A today (C17 seam); callerId ignored until Task 22

    /** REST errors are caught and logged, never thrown -- Twilio retries a
     * non-2xx response, and a retry cannot fix a call that has already ended
     * (e.g. the person hung up mid-greeting), so the route still answers 200. */
    async function updateCall(body) {
      try {
        await client.calls(callSid).update(body);
      } catch (err) {
        bumpCounter("outbound_amd_update_failed");
        log.error("outbound_amd_update_failed", { callSid, attemptId, message: err?.message, severity: "warn" });
      }
    }

    let finalResult = decision.result;

    if (decision.action === "voicemail") {
      const audio = await db.withTenantSafe(businessId, () => db.fetchAttemptVoicemailAudio(attemptId), {
        operation: "outboundAmdVoicemailAudio",
        callSid,
      });

      if (audio) {
        // Spec §9.1's signed media URL, 10-minute TTL. Its `&` (between
        // `exp=` and `sig=`) is XML-escaped for the TwiML body -- the URL
        // itself is unchanged, only how it is written inside <Play>.
        const url = signMediaUrl({ base: baseUrl(env), callSid, kind: "voicemail", now: now(), env });
        await updateCall({ twiml: `<Response><Play>${escapeXml(url)}</Play><Hangup/></Response>` });
        finalResult = "voicemail_left";
        log.info("outbound_voicemail", { callSid, attemptId, result: "left" });
      } else {
        // No stored clip -- render failed, was refused (O-4), or post-call
        // already cleared it. Never play a URL that will 404: fall back to
        // ending the call exactly like the "not due for voicemail" branch.
        await updateCall({ status: "completed" });
        finalResult = "voicemail_skipped";
        log.info("outbound_voicemail", { callSid, attemptId, result: "skipped", reason: "no_audio" });
      }
    } else {
      // "hangup": a machine_end_* outside voicemail_on (voicemail_skipped),
      // or a fax (failed) -- either way, end the call by REST rather than
      // touching the media stream (spec §9.4).
      await updateCall({ status: "completed" });
      if (isMachineEnd(answeredBy)) {
        log.info("outbound_voicemail", { callSid, attemptId, result: "skipped" });
      }
    }

    await db.withTenantSafe(businessId, () => db.stampAttemptAmd(attemptId, { answeredBy, amdDurationMs, result: finalResult }), {
      operation: "outboundAmdResult",
      callSid,
    });

    return res.status(200).end();
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
        // Fix round 1, item 8: withTenant (unlike withTenantSafe) does not
        // derive an actor from `callSid` on its own -- omitting this left the
        // PHI audit row recording actorType "system", actorId null for what
        // is, in fact, one specific call fetching its own voicemail clip.
        { callSid, actor: { type: "voice", id: callSid } }
      );
    } catch (err) {
      log.error("outbound_media_read_failed", { callSid, message: err?.message, severity: "warn" });
    }
    if (!audio) return res.status(404).end();

    res.type("audio/wav");
    return res.send(mulawToWav(audio));
  });
}
