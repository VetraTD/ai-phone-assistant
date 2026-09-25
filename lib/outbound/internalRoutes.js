// lib/outbound/internalRoutes.js
/**
 * The two doors Cloud Tasks and Cloud Scheduler knock on (spec §5, §10.2):
 *   POST /internal/outbound/dispatch  -- one outreach, enqueued by tasks.js.
 *   POST /internal/outbound/sweep     -- the safety net, every 5 minutes (C14).
 * Both are OIDC-guarded (lib/auth/googleOidc.js) and mounted ONLY when
 * `buildOutboundDeps(env)` resolves every piece of configuration it needs --
 * before Task 22 that is never, so these routes do not exist in production yet.
 *
 * Status codes matter here because Cloud Tasks reads them as a retry signal:
 *   - dispatch is 200 for EVERY dispatch outcome, including "did nothing"
 *     (a retried or duplicate task finding its outreach already handled is a
 *     success, not a failure to retry), and 500 only on an unexpected throw.
 *   - sweep is 200 with the count it re-enqueued, 500 on an unexpected throw.
 *   - a body with a non-uuid id is 400 (Cloud Tasks does not retry a 4xx).
 *   - the verifier's refusal reason is logged but never echoed in the body --
 *     the caller of these two routes is never a legitimate stranger, so a
 *     detailed 401/403 body would only help someone probing for a live seam.
 */
import express from "express";
import twilio from "twilio";
import { CloudTasksClient } from "@google-cloud/tasks";
import { createGoogleOidcVerifier } from "../auth/googleOidc.js";
import { createDispatchEnqueuer } from "./tasks.js";
import { createDispatcher } from "./dispatch.js";
import { outboundEnv } from "./config.js";
import { log as defaultLog } from "../logger.js";
import * as db from "../../services/db.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const JSON_LIMIT = "4kb";

/** A 5-minute bucket start (ms), as a Date. Never NaN: `t` is always a real Date. */
function bucketStart(t) {
  return new Date(Math.floor(t.getTime() / 300_000) * 300_000);
}

/**
 * Wrap a Twilio caller-ID lookup with a timeout and a success-only cache.
 * This runs inside dispatch's transaction while that transaction holds the
 * global capacity advisory lock (dispatch.js), and Postgres's own
 * statement_timeout there is 6s while the Twilio SDK's default is 30s -- so a
 * slow or hung Twilio request must not be allowed to outlive the lock.
 *
 * On timeout or any lookup error this THROWS, on purpose: dispatch.js runs it
 * inside `withTenant`, so the throw rolls that transaction back and the route
 * returns 500, and Cloud Tasks retries. Returning `false` here would instead
 * read as "this caller ID is invalid" and close the outreach forever
 * (`caller_id_invalid`) over what may be a transient Twilio blip.
 *
 * Only a SUCCESSFUL (found) answer is cached, for `cacheTtlMs` (default 1h)
 * per number. A "not found" answer is not cached: a caller ID that is not yet
 * registered on the account can become valid at any time (the owner adding
 * it), and caching "invalid" would silently extend that wait by up to an
 * hour on every subsequent dispatch.
 */
export function createCallerIdValidator({ twilioClientFor, timeoutMs = 3000, cacheTtlMs = 3_600_000, now = () => Date.now() }) {
  const cache = new Map(); // phone -> {at}
  return async function callerIdValid(phoneE164) {
    const cached = cache.get(phoneE164);
    if (cached && now() - cached.at < cacheTtlMs) return true;

    const client = twilioClientFor(phoneE164);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("outbound_caller_id_lookup_timeout")), timeoutMs);
    });
    try {
      const numbers = await Promise.race([client.incomingPhoneNumbers.list({ phoneNumber: phoneE164, limit: 1 }), timeout]);
      const ok = Array.isArray(numbers) && numbers.length > 0;
      if (ok) cache.set(phoneE164, { at: now() });
      return ok;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Every audience and URL in this task comes from `outboundEnv(env).baseUrl`
 * (already stripped of a trailing slash): the verifier, the enqueuer's
 * `serviceUrl`, and the dispatcher's `env.baseUrl` for the Twilio callback
 * URLs. A trailing slash on any ONE of them would make every task 403.
 *
 * Returns `null` when the queue or the service account is unset (the posture
 * before Task 22) -- callers must not mount the routes in that case.
 *
 * The Cloud Tasks client and the Twilio client are constructed LAZILY, on
 * first actual use, not here: importing this module (and server.js, and the
 * test suite) must not require Cloud Tasks or Twilio credentials, and the
 * Twilio SDK's constructor throws outright when the SID does not start with
 * "AC".
 */
export function buildOutboundDeps(env = process.env) {
  const cfg = outboundEnv(env);
  if (!cfg.baseUrl || !cfg.tasksQueue || !cfg.tasksSa) return null;

  const audience = cfg.baseUrl;
  const log = defaultLog;
  const now = () => new Date();

  const verifier = createGoogleOidcVerifier({ audience, allowedEmails: [cfg.tasksSa] });

  let tasksClient = null;
  const getTasksClient = () => (tasksClient ??= new CloudTasksClient());

  let enqueuer = null;
  const getEnqueuer = () =>
    (enqueuer ??= createDispatchEnqueuer({
      client: getTasksClient(),
      queuePath: cfg.tasksQueue,
      serviceUrl: cfg.baseUrl,
      serviceAccountEmail: cfg.tasksSa,
    }));
  const enqueue = (args) => getEnqueuer().enqueue(args);

  // C17 seam: the service holds only account A's REST credentials today, so
  // every caller ID resolves to the same client regardless of the argument.
  // Task 22 (owner decision C17) adds a second account's credentials and
  // selects between them here, once a campaign can dial from a number that
  // is not on account A.
  let twilioClientA = null;
  const twilioClientFor = (_callerId) => (twilioClientA ??= twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN));

  const callerIdValid = createCallerIdValidator({ twilioClientFor });

  let dispatcher = null;
  const getDispatcher = () =>
    (dispatcher ??= createDispatcher({
      db,
      twilio: twilioClientFor(),
      enqueue,
      env: cfg,
      now,
      callerIdValid,
      renderAudio: async () => null, // Task 14 wires Gemini Live rendering
      log,
    }));
  const dispatch = (args) => getDispatcher()(args);

  return { verifier, dispatch, db, enqueue, now, log, audience };
}

/**
 * Mount the two internal routes on `app`. Does nothing (no throw) when `deps`
 * is falsy -- the caller (server.js) is expected to pass `null` when
 * `buildOutboundDeps` could not resolve its configuration, and the routes
 * must then simply not exist (a 404, not a 401/403 that would confirm they
 * are merely locked).
 */
export function registerOutboundInternalRoutes(app, deps) {
  if (!deps) return;
  const { verifier, dispatch, db: dbDep, enqueue, now, log } = deps;
  const jsonBody = express.json({ limit: JSON_LIMIT });

  /** @returns {Promise<boolean>} true if authenticated; otherwise a response was already sent. */
  async function authenticate(req, res) {
    const result = await verifier.verify(req.headers.authorization);
    if (!result.ok) {
      // Logged for operators; NEVER echoed in the body (carried from Task 8).
      log.info("outbound_internal_auth_refused", { reason: result.reason, path: req.path });
      res.status(result.reason === "missing" ? 401 : 403).json({ error: "unauthorized" });
      return false;
    }
    return true;
  }

  app.post("/internal/outbound/dispatch", jsonBody, async (req, res) => {
    if (!(await authenticate(req, res))) return;

    const businessId = req.body?.business_id;
    const outreachId = req.body?.outreach_id;
    if (typeof businessId !== "string" || typeof outreachId !== "string" || !UUID_RE.test(businessId) || !UUID_RE.test(outreachId)) {
      return res.status(400).json({ error: "invalid body" });
    }

    try {
      // 200 for every dispatch outcome -- "did nothing" (skipped, later,
      // closed, a lost insert race) is success for a retried or duplicated
      // task. Only an unexpected throw is a reason for Cloud Tasks to retry.
      const result = await dispatch({ businessId, outreachId });
      res.status(200).json(result ?? {});
    } catch (err) {
      log.error("outbound_internal_dispatch_failed", { businessId, outreachId, error: err?.message });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/internal/outbound/sweep", jsonBody, async (req, res) => {
    if (!(await authenticate(req, res))) return;

    try {
      const t = now();
      const at = bucketStart(t);
      const due = await dbDep.outboundDue(100, 120);
      // Counts EVERY due row the sweep attempted to enqueue, whether Cloud
      // Tasks reports created:true (a new task) or created:false (this
      // 5-minute bucket's task already exists, which is also success -- the
      // alarm is already set). "Reenqueued" describes the sweep's own
      // action, not whether Cloud Tasks happened to already have the task.
      let reenqueued = 0;
      for (const row of due) {
        await enqueue({ businessId: row.business_id, outreachId: row.outreach_id, at, source: "sweep", now: t });
        reenqueued++;
      }
      log.info("outbound_sweep", { due: due.length, reenqueued });
      res.status(200).json({ reenqueued });
    } catch (err) {
      log.error("outbound_internal_sweep_failed", { error: err?.message });
      res.status(500).json({ error: "internal error" });
    }
  });
}
