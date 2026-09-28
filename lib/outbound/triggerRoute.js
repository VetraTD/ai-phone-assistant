// lib/outbound/triggerRoute.js
/**
 * The leads-in link (S3-9, spec §12.1, amended by §19 amendments to §7/§12.1):
 *
 *   POST /v1/triggers/:triggerToken
 *
 * A form or workflow tool (Part 2: GoHighLevel) posts a new lead directly at
 * this URL -- no dashboard session, no OIDC, just a per-campaign bearer token
 * baked into the URL. The route validates the phone number and the consent
 * block, upserts the contact, records the consent, and creates the outreach
 * `waiting` -- idempotently, so a form's own retry or a workflow tool's
 * at-least-once delivery cannot double-book a call.
 *
 * ---------------------------------------------------------------------------
 * Enqueueing (fix round 1, I2, controller ruling)
 * ---------------------------------------------------------------------------
 * Spec §12.1 ("creates the outreach (idempotent), enqueues, and returns
 * 202") and §12.1's own worked example ("creation... enqueues a task") both
 * say this route enqueues, and §19 does not amend either line. On the FIRST
 * creation of an outreach (never on an idempotent replay -- the existing
 * dispatch enqueuer's own task-name dedupe on outreach id + due time is a
 * second, redundant guard, not the only one), the trigger route enqueues one
 * dispatch task via the SAME `lib/outbound/tasks.js` enqueuer
 * `buildOutboundDeps` already builds for the internal routes -- server.js
 * wires it in with `setEnqueue` once `buildOutboundDeps` resolves (the
 * `outboundPostCall.setEnqueue` pattern, `server.js`'s own fix round 1 item
 * 7), because this module is registered at boot, before that resolution.
 * FAIL-SOFT: an enqueue throw (or `enqueue` simply not being configured, the
 * local-dev/no-Cloud-Tasks posture) is caught, counted
 * (`outbound_trigger_enqueue_failed`) and logged -- never allowed to turn a
 * successful database write into a 500, and never dialled synchronously.
 * The 5-minute sweep (`/internal/outbound/sweep`, migration 045) remains the
 * backstop either way, the same "no Cloud Tasks rights needed" posture
 * `scripts/outbound-admin.js`'s own `triggerOutreach` documents for ITS
 * write path.
 *
 * ---------------------------------------------------------------------------
 * The token
 * ---------------------------------------------------------------------------
 * 32 random bytes, hex-encoded by `scripts/outbound-admin.js
 * trigger-token-rotate` and printed ONCE -- only its sha256 hash
 * (`campaigns.trigger_token_hash`) is ever stored. The route hashes the
 * presented token the same way and resolves it through
 * `app_campaign_by_trigger_hash` (migration 049), a no-RLS directory read the
 * same shape as migration 044's `app_outbound_attempt_by_call_sid`: the
 * tenant is not known until the hash resolves. `compareTokenHash` below is a
 * defence-in-depth re-check of that resolution in application code, in
 * constant time -- never `===`, and never a second DB round trip on the raw
 * token (named risk 1).
 *
 * ---------------------------------------------------------------------------
 * Why this route needs its own body parser (Ruling S3-9a)
 * ---------------------------------------------------------------------------
 * server.js's global `express.json()`/`express.urlencoded()` run ahead of
 * every route except a documented exclusion list (the SAME list
 * `isOutboundInternalPath` already carves out for the two internal Cloud
 * Tasks routes, for the identical reason: body-parser skips re-parsing a
 * request whose body stream is already drained, so an un-excluded global
 * parser ahead of this route's own `express.json({limit:"16kb"})` would make
 * that 16 KB limit dead code). `isTriggerRoutePath` is that exclusion,
 * matched the same case-insensitive, one-trailing-slash way.
 *
 * ---------------------------------------------------------------------------
 * The rate limit does not skip in test (Ruling)
 * ---------------------------------------------------------------------------
 * server.js's own `/twilio` and `/api` limiters are wrapped in
 * `if (process.env.NODE_ENV !== "test")` -- fine for routes a signed Twilio
 * request or an authenticated dashboard session guards, where a flood is a
 * capacity problem, not a security one. This route has NEITHER guard ahead of
 * it: a public, unauthenticated URL is exactly where a real rate limit has to
 * run under test too, or the 429 test proves nothing. Keyed by the TOKEN's
 * hash (never IP): a shared office connection posting several campaigns'
 * distinct tokens must not share one bucket, and an attacker rotating source
 * IPs against one token must not escape it either.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
// Imported as the namespace object, not a named `timingSafeEqual` binding,
// so the sabotage test can `vi.spyOn(crypto, "timingSafeEqual")` and
// actually intercept the call this file makes -- a named import snapshots
// its own reference at link time and a spy on the namespace object would
// never be seen by it.
import * as crypto from "node:crypto";
import { normalizePhoneNumber } from "../phone.js";
import { refuseBadBody } from "./internalRoutes.js";
import { bumpCounter } from "../voice/metrics.js";
import { log as defaultLog } from "../logger.js";

/** Express 5 route pattern. Exported so a test can name it directly. */
export const TRIGGER_PATH = "/v1/triggers/:triggerToken";

const JSON_LIMIT = "16kb";
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 30/min per token (the brief's own number). */
export const RATE_LIMIT_MAX = 30;

const TRIGGER_PATH_RE = /^\/v1\/triggers\/[^/]+$/;

// The lib/outbound/{dispatch,postCall,liveRender}.js convention (fix round
// 1, I1): a descriptive system actor id, not `null` -- this flows straight
// into the durable PHI audit row (services/db.js's withTenant/flushAudit)
// and the id is the ONLY thing that tells an auditor which of several
// system-actor code paths wrote a given row.
const ACTOR = { actor: { type: "system", id: "outbound-trigger" } };

/**
 * Would Express route `path` to this route? Same normalisation
 * `isOutboundInternalPath` (lib/outbound/internalRoutes.js) uses: lower-case,
 * strip one trailing slash, so the exclusion this drives in server.js cannot
 * be dodged by a spelling Express itself still routes.
 * @param {unknown} path - req.path
 * @returns {boolean}
 */
export function isTriggerRoutePath(path) {
  if (typeof path !== "string") return false;
  let p = path.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return TRIGGER_PATH_RE.test(p);
}

/** sha256(token), hex. The ONLY form of the token that ever reaches SQL or storage. */
export function hashTriggerToken(token) {
  return createHash("sha256").update(String(token ?? "")).digest("hex");
}

/**
 * Constant-time equality for two token hashes (named risk 1: never `===`,
 * never a raw-token DB equality). Hashes BOTH sides to a fixed-length sha256
 * digest before comparing -- so the function never throws regardless of what
 * it is given (an empty string, a hash of the wrong length, a raw token
 * passed by mistake) and never branches on either input's length the way a
 * naive `a.length !== b.length` guard would (mediaUrl.js's own
 * verifyMediaUrl needs that guard only because it skips this step). Equality
 * is preserved under the transform: sha256 is a function, so `a === b` iff
 * `sha256(a) === sha256(b)` (collisions aside), and `timingSafeEqual` never
 * runs on attacker-length-controlled buffers.
 *
 * Exported specifically so the sabotage test (swap this for `===`) can
 * target the function in isolation with a spy on `crypto.timingSafeEqual`,
 * rather than a wall-clock timing measurement -- timing itself is not
 * something a unit test can safely assert on.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function compareTokenHash(a, b) {
  const digestA = createHash("sha256").update(String(a ?? "")).digest();
  const digestB = createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Defaults `idempotency_key` to a hash of phone + source_ref (spec §12.1). */
function defaultIdempotencyKey(phone, sourceRef) {
  return `trig:${hashTriggerToken(`${phone}|${sourceRef || ""}`)}`;
}

/** A validated consent block, or a refusal reason. Pure -- no I/O. */
function validateConsentBlock(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "consent must be an object" };
  }
  const purpose = typeof raw.purpose === "string" ? raw.purpose.trim() : "";
  if (!purpose) return { ok: false, error: "consent.purpose is required" };
  const capturedAt = typeof raw.captured_at === "string" ? new Date(raw.captured_at) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) {
    return { ok: false, error: "consent.captured_at must be a valid ISO date" };
  }
  const channels = Array.isArray(raw.channels) ? raw.channels.filter((c) => typeof c === "string") : [];
  return {
    ok: true,
    block: {
      purpose,
      channels,
      coversAutomated: raw.covers_automated === true,
      wordingVersion: typeof raw.wording_version === "string" ? raw.wording_version : null,
      wordingText: typeof raw.wording_text === "string" ? raw.wording_text : null,
      sourceRef: typeof raw.source_ref === "string" ? raw.source_ref : null,
      capturedAt,
    },
  };
}

/** A timezone string Intl actually recognises, or null when absent/invalid. */
function validTimezone(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: true, value: null };
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: raw.trim() });
    return { ok: true, value: raw.trim() };
  } catch {
    return { ok: false };
  }
}

function trimmedOrNull(raw) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Mount the leads-in link.
 *
 * @param {import("express").Express} app
 * @param {{
 *   db: typeof import("../../services/db.js"),
 *   log?: typeof defaultLog,
 *   enqueue?: ((args: {businessId: string, outreachId: string, at: Date, source?: string}) => Promise<unknown>) | null,
 * }} deps
 * @returns {{ setEnqueue: (fn: ((args: object) => Promise<unknown>) | null) => void }} -- server.js
 *   calls `setEnqueue` once `buildOutboundDeps` resolves the real,
 *   Cloud-Tasks-backed enqueuer, the same `outboundPostCall.setEnqueue`
 *   pattern: this module is registered at boot, before that resolution.
 */
export function registerTriggerRoute(app, deps) {
  const { db, log = defaultLog } = deps;
  // Mutable, not frozen at construction -- see the JSDoc above and
  // outboundPostCall's own setEnqueue for why (fix round 1, item 7's
  // reasoning, reused here).
  let enqueueFn = deps.enqueue ?? null;
  const jsonBody = express.json({ limit: JSON_LIMIT });

  const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // Never IP -- see the file header. `req.params` is populated by the time
    // express-rate-limit's keyGenerator runs (it is mounted as route
    // middleware, after Express has already matched :triggerToken).
    keyGenerator: (req) => hashTriggerToken(req.params?.triggerToken || ""),
    handler: (req, res) => {
      bumpCounter("outbound_trigger_rejected");
      log.error("outbound_trigger_rejected", { reason: "rate_limited", status: 429 });
      res.status(429).json({ error: "rate limited" });
    },
  });

  /**
   * Every refusal this route issues goes through here: bumps the ONE
   * registered counter, logs the specific reason (never silent -- named
   * risk 4), and answers with the body the brief pins. `field` is omitted
   * for the 401 (there is no single bad field -- the token itself is wrong).
   */
  function reject(res, status, reason, body) {
    bumpCounter("outbound_trigger_rejected");
    log.error("outbound_trigger_rejected", { reason, status });
    return res.status(status).json(body);
  }

  app.post(TRIGGER_PATH, limiter, jsonBody, refuseBadBody, async (req, res) => {
    try {
      const rawToken = req.params.triggerToken || "";
      const presentedHash = hashTriggerToken(rawToken);

      let hit = null;
      try {
        hit = await db.campaignByTriggerHash(presentedHash);
      } catch (err) {
        log.error("outbound_trigger_lookup_failed", { message: err?.message, severity: "error" });
      }
      if (!hit || !compareTokenHash(presentedHash, hit.triggerTokenHash)) {
        return reject(res, 401, "bad_token", { error: "unauthorized" });
      }

      const campaign = await db.withTenant(hit.businessId, () => db.campaignForTrigger(hit.campaignId), ACTOR);
      if (!campaign) {
        // The directory hash matched, but the campaigns row is gone -- the
        // sync trigger (migration 049) removes the directory row on DELETE,
        // so this should be unreachable; fail closed rather than trust a
        // stale hash hit (plan-verbatim-code-fails-open).
        return reject(res, 401, "campaign_gone", { error: "unauthorized" });
      }

      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

      const phone = normalizePhoneNumber(body.phone);
      if (!phone) {
        return reject(res, 422, "phone", { error: "phone must be an E.164 number", field: "phone" });
      }

      const tzResult = validTimezone(body.timezone);
      if (!tzResult.ok) {
        return reject(res, 422, "timezone", { error: "timezone is not a recognised IANA zone", field: "timezone" });
      }

      let consentBlock = null;
      if (body.consent !== undefined && body.consent !== null) {
        const v = validateConsentBlock(body.consent);
        if (!v.ok) {
          return reject(res, 422, "consent_invalid", { error: v.error, field: "consent" });
        }
        consentBlock = v.block;
      } else if (campaign.complianceClass !== "service") {
        // Rule: a request with no consent block is accepted only for
        // 'service'-class campaigns (spec §12.1).
        return reject(res, 422, "consent_missing", { error: "consent is required for this campaign", field: "consent" });
      }

      if (body.data !== undefined && (typeof body.data !== "object" || body.data === null || Array.isArray(body.data))) {
        return reject(res, 422, "data", { error: "data must be an object", field: "data" });
      }
      const data = body.data && typeof body.data === "object" ? body.data : {};

      // Only the keys the campaign's OWN details_fields names are copied into
      // outreach.details (named risk 5); everything else is reported back as
      // ignored, never silently stored anyway.
      const allowedKeys = new Set(campaign.detailsFields.map((f) => f.key));
      const details = {};
      const ignoredFields = [];
      for (const [key, value] of Object.entries(data)) {
        if (allowedKeys.has(key)) details[key] = value;
        else ignoredFields.push(key);
      }

      const idempotencyKey = trimmedOrNull(body.idempotency_key) || defaultIdempotencyKey(phone, consentBlock?.sourceRef);

      const outreach = await db.withTenant(
        hit.businessId,
        async () => {
          const contactId = await db.upsertContactForTrigger({
            phone,
            firstName: trimmedOrNull(body.first_name),
            lastName: trimmedOrNull(body.last_name),
            email: trimmedOrNull(body.email),
            timezone: tzResult.value,
          });
          const result = await db.createOutreachFromTrigger({
            campaignId: hit.campaignId,
            campaignVersion: campaign.currentVersion,
            contactId,
            // spec §12.1's data model: "source plus the raw normalised
            // payload" -- the WHOLE posted `data`, not the details_fields
            // subset (that is a separate, narrower field: outreach.details).
            trigger: { source: "webhook", data },
            idempotencyKey,
            details,
          });
          // Only on the FIRST creation of this idempotency key (the same
          // rule scripts/outbound-admin.js's triggerOutreach follows for its
          // own manual consent) -- a form's retry re-posting the identical
          // body must not write a second consent row for what is the same
          // consent event.
          if (result.created && consentBlock) {
            await db.recordTriggerConsent({
              contactId,
              purpose: consentBlock.purpose,
              channels: consentBlock.channels,
              coversAutomated: consentBlock.coversAutomated,
              sourceRef: consentBlock.sourceRef,
              wordingVersion: consentBlock.wordingVersion,
              wordingText: consentBlock.wordingText,
              capturedAt: consentBlock.capturedAt,
            });
          }
          return result;
        },
        ACTOR
      );

      // fix round 1, I2 (controller ruling): enqueue the dispatch task ONLY
      // on the first creation of this outreach -- a replay's `created:false`
      // means one is already either queued or (more likely, since the sweep
      // still runs every 5 minutes regardless) already dialled, and
      // re-enqueueing it here would depend entirely on the dispatch
      // enqueuer's OWN task-name dedupe (outreach id + due time) to not
      // double-book, rather than this route simply not asking twice.
      // FAIL-SOFT, always: outside the db.withTenant transaction (a Cloud
      // Tasks network call must never hold a DB transaction open) -- either
      // way the outreach row already exists and is real; the 202 below is
      // never held hostage by this call, and the request never dials
      // synchronously. Two distinct outcomes, matching
      // outboundPostCall's own enqueue handling (postCall.js:541-555):
      // `enqueueFn` unset (Cloud Tasks not configured -- local dev, or
      // before Task 22) is a routine, expected posture, logged at `info` and
      // NOT counted as a failure (every local run would otherwise bump this
      // on every create); an actual throw IS counted -- that is the one the
      // brief's "an enqueue failure still gives 202 and the counter goes up"
      // names.
      if (outreach.created) {
        if (!enqueueFn) {
          log.info("outbound_trigger_enqueue_unavailable", { outreachId: outreach.id });
        } else {
          try {
            await enqueueFn({ businessId: hit.businessId, outreachId: outreach.id, at: new Date() });
          } catch (err) {
            bumpCounter("outbound_trigger_enqueue_failed");
            log.error("outbound_trigger_enqueue_failed", {
              outreachId: outreach.id,
              message: err?.message,
              severity: "warn",
            });
          }
        }
      }

      return res.status(202).json({ outreach_id: outreach.id, ignored_fields: ignoredFields });
    } catch (err) {
      log.error("outbound_trigger_failed", { message: err?.message, severity: "error" });
      return res.status(500).json({ error: "internal error" });
    }
  });

  return {
    /** server.js calls this once buildOutboundDeps resolves. `null`/omitted disables enqueueing (the 5-minute sweep remains the backstop). */
    setEnqueue(fn) {
      enqueueFn = fn ?? null;
    },
  };
}
