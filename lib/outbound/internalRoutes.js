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
import { createGoogleOidcVerifier } from "../auth/googleOidc.js";
import { createDispatchEnqueuer } from "./tasks.js";
import { createDispatcher } from "./dispatch.js";
import { outboundEnv } from "./config.js";
import { log as defaultLog } from "../logger.js";
import * as db from "../../services/db.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const JSON_LIMIT = "4kb";

/**
 * `@google-cloud/tasks` drags in gRPC. Imported at the top of this file, it
 * cost EVERY boot of the voice service (+52 ms, +17 MB measured at the
 * Checkpoint 2a review) -- server.js imports this module whether or not
 * outbound is configured, and today it never is. Loaded on the first enqueue
 * instead: the lib/voice/sttGoogle.js pattern (Checkpoint 2a, M9).
 */
const importCloudTasks = () => import("@google-cloud/tasks");

const DISPATCH_PATH = "/internal/outbound/dispatch";
const SWEEP_PATH = "/internal/outbound/sweep";

/**
 * The exact paths these two routes mount at. server.js's global
 * `express.json()` excludes them through isOutboundInternalPath (below), which
 * reads this SAME list rather than a second, hand-copied one -- body-parser
 * skips re-parsing a request whose body
 * stream is already drained, so if the global (100kb) parser ever ran first
 * on one of these paths, the route-scoped `express.json({limit:"4kb"})`
 * below would become dead code and a body up to 100kb would sail through
 * (found live, fix round 1: a 6,116-byte body returned 200/401 through the
 * real server.js stack instead of being refused for size).
 */
export const OUTBOUND_INTERNAL_PATHS = Object.freeze([DISPATCH_PATH, SWEEP_PATH]);

/**
 * Would Express route `path` to one of these two routes? Express 5 matches
 * them case-insensitively with ONE optional trailing slash (measured: `//`,
 * `%64ispatch` and `.json` do not route), so this lower-cases, strips one
 * trailing slash, and compares against OUTBOUND_INTERNAL_PATHS. server.js
 * skips its global parser by this predicate: its old exact-string comparison
 * let `/internal/outbound/dispatch/` and `/INTERNAL/...` take the 100kb
 * parser, and the 4kb limit never ran (Checkpoint 2a, M5).
 * @param {unknown} path - req.path
 * @returns {boolean}
 */
export function isOutboundInternalPath(path) {
  if (typeof path !== "string") return false;
  let p = path.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return OUTBOUND_INTERNAL_PATHS.includes(p);
}

/**
 * Route-local error handler (Checkpoint 2a, M5): a body over JSON_LIMIT is
 * answered here, 413 with a generic body, instead of reaching server.js's
 * central handler -- which answers 500 and reports it to Sentry. Any other
 * error goes on unchanged.
 */
function refuseOversizedBody(err, req, res, next) {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "payload too large" });
  return next(err);
}

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
 *
 * No in-flight de-dup: two concurrent lookups for the same never-yet-cached
 * number both hit Twilio. This is deliberately not fixed here -- the
 * dispatcher's global capacity advisory lock (lib/outbound/dispatch.js)
 * already serialises every caller of this function to one at a time, so a
 * second concurrent call is not a real scenario in the only place this runs.
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
 * Lazily construct the account-A Twilio REST client (C17 seam, 2a ledger):
 * one client, built on first use and shared by every caller. Extracted
 * (Task 13, session 2b) from what used to be a closure private to
 * `buildOutboundDeps`, because the outbound door routes
 * (`lib/outbound/doorRoutes.js`) are mounted UNCONDITIONALLY in server.js --
 * independent of whether `buildOutboundDeps` ever resolves its Cloud
 * Tasks/OIDC configuration -- and the AMD door needs the SAME client to
 * redirect a call by REST (spec §9.4). Both callers must share the same
 * lazy-construction rule: importing server.js must never require Twilio
 * credentials, because the Twilio SDK's constructor throws outright when the
 * SID does not start with "AC".
 *
 * `_callerId` is accepted and ignored today (the service holds only account
 * A's REST credentials); Task 22 (owner decision C17) is what makes this
 * function actually select between accounts.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {(callerId?: string) => import("twilio").Twilio}
 */
export function createTwilioClientFor(env = process.env) {
  let client = null;
  return function twilioClientFor(_callerId) {
    return (client ??= twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN));
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
 * Logs `outbound_allowlist_entries_dropped {count}` once, before that check,
 * when OUTBOUND_TEST_ALLOWLIST carries entries that are not E.164 (Checkpoint
 * 2a, M7): a malformed entry is a misconfiguration whether or not the routes
 * mount. The count only -- the values are meant to be phone numbers.
 *
 * The Cloud Tasks client and the Twilio client are constructed LAZILY, on
 * first actual use, not here: importing this module (and server.js, and the
 * test suite) must not require Cloud Tasks or Twilio credentials, and the
 * Twilio SDK's constructor throws outright when the SID does not start with
 * "AC". The Cloud Tasks SDK is not even IMPORTED until the first enqueue
 * (M9); `importTasks` is that import, injectable so a test can fail it.
 *
 * `twilioClientFor` (fix round 1, MINOR 3): server.js builds ONE
 * `createTwilioClientFor()` instance and passes it here AND into
 * `registerOutboundDoorRoutes`, so the dispatcher and the AMD door share the
 * same lazy client rather than each holding an independent one against the
 * same account. Defaults to a fresh `createTwilioClientFor(env)` when
 * omitted (every existing direct caller of `buildOutboundDeps`, including
 * every test), so the behaviour -- lazy, one client per factory instance --
 * stays exactly what it was before this option existed.
 */
export function buildOutboundDeps(
  env = process.env,
  { log = defaultLog, importTasks = importCloudTasks, twilioClientFor = createTwilioClientFor(env) } = {}
) {
  const cfg = outboundEnv(env);
  if (cfg.allowlistDropped > 0) log.error("outbound_allowlist_entries_dropped", { count: cfg.allowlistDropped });
  if (!cfg.baseUrl || !cfg.tasksQueue || !cfg.tasksSa) return null;

  const audience = cfg.baseUrl;
  const now = () => new Date();

  const verifier = createGoogleOidcVerifier({ audience, allowedEmails: [cfg.tasksSa] });

  // The SDK is imported and its client built on the first enqueue (M9). One
  // promise, so concurrent first enqueues share one client; a failed load is
  // NOT cached -- the next enqueue tries again rather than failing forever.
  let enqueuerPromise = null;
  const getEnqueuer = () =>
    (enqueuerPromise ??= importTasks()
      .then(({ CloudTasksClient }) =>
        createDispatchEnqueuer({
          client: new CloudTasksClient(),
          queuePath: cfg.tasksQueue,
          serviceUrl: cfg.baseUrl,
          serviceAccountEmail: cfg.tasksSa,
        }))
      .catch((err) => {
        enqueuerPromise = null;
        throw err;
      }));
  const enqueue = async (args) => (await getEnqueuer()).enqueue(args);

  // C17 seam: the service holds only account A's REST credentials today, so
  // every caller ID resolves to the same client regardless of the argument.
  // Task 22 (owner decision C17) adds a second account's credentials and
  // selects between them here, once a campaign can dial from a number that
  // is not on account A. `twilioClientFor` is the parameter above (fix round
  // 1, MINOR 3) -- server.js's own shared instance in production, a fresh
  // one by default in every test that calls this directly.
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

  app.post(DISPATCH_PATH, jsonBody, refuseOversizedBody, async (req, res) => {
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

  app.post(SWEEP_PATH, jsonBody, refuseOversizedBody, async (req, res) => {
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
