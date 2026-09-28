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
import { createDispatcher, failStaleAttempt } from "./dispatch.js";
import { createLiveRenderAudio } from "./liveRender.js";
import { outboundEnv } from "./config.js";
import { postCall as defaultPostCall } from "./postCall.js";
import { TERMINAL_STATUSES, RESULT_BY_STATUS } from "./doorRoutes.js";
import { contactTimezone } from "./schedule.js";
import { bumpCounter } from "../voice/metrics.js";
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
// Exported (fix round 1, Minor 2) so cloudbuild.yaml's `smoke` step can call
// the SAME lazy importer the service calls on its first enqueue, instead of
// a separate resolution of its own. `@google-cloud/tasks` is a dual package
// (`exports["."].require` -> the CJS build, `.import` -> the ESM build); a
// smoke check that resolved it a different way (e.g. `createRequire`, which
// takes the require condition) could pass while the import condition this
// line actually takes is broken. Exporting the function has no side effect
// by itself -- only CALLING it triggers the import, exactly as before.
export const importCloudTasks = () => import("@google-cloud/tasks");

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
 * Task 20's stale-`dialing` backstops (migration 045, `db.outboundStaleAttempts`).
 * Extracted to named constants (S3-2 controller ruling) -- same values, no
 * behaviour change, no schema change -- so the relationship they must hold
 * with D10's RENDER_BEFORE_DIAL_MAX_MS (lib/outbound/dispatch.js) is a single
 * assertion (tests/outboundDispatch.test.js) rather than two files agreeing
 * by coincidence: a real dial that is merely running late must never be
 * mistaken by the sweep for one that never happened. `dialed_at` defaults to
 * `now()` at attempt insert (044:62), so render-before-dial time already
 * counts toward `OUTBOUND_STALE_SIDLESS_MINUTES`'s own age.
 */
export const OUTBOUND_STALE_ATTEMPTS_LIMIT = 100;
export const OUTBOUND_STALE_SIDLESS_MINUTES = 10;
export const OUTBOUND_STALE_LOST_CALLBACK_MINUTES = 15;
export const OUTBOUND_STALE_POSTCALL_PENDING_SECONDS = 120;

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
 * Per-type bodies for the body-parser/raw-body errors that carry a
 * recognizable string `.type` -- verified against the installed
 * body-parser@2.3.0's lib/read.js and raw-body's index.js. NOT exhaustive
 * (fix round 1, Finding 1: that claim was wrong) -- raw-body/zlib wrap a
 * corrupt compressed stream (a `Content-Encoding` the bytes don't match) as
 * `createError(400, error)` with NO `.type` at all (read.js:125), so a
 * garbage gzip/deflate/br body never appears here. `refuseBadBody` below
 * answers THAT case too, with the generic fallback body, precisely because it
 * does not gate on `.type` being present or recognized -- only on the status.
 *
 * `entity.verify.failed` (403) can only occur when body-parser is given a
 * `verify` option; `jsonBody` below passes none, so this route never
 * produces one today -- handled anyway, since a future `verify` option
 * should not have to rediscover this switch.
 */
const BODY_PARSER_ERROR_RESPONSES = Object.freeze({
  "entity.parse.failed": { status: 400, body: { error: "malformed body" } },
  "entity.too.large": { status: 413, body: { error: "payload too large" } },
  "charset.unsupported": { status: 415, body: { error: "unsupported charset" } },
  "encoding.unsupported": { status: 415, body: { error: "unsupported encoding" } },
  "request.aborted": { status: 400, body: { error: "request aborted" } },
  "request.size.invalid": { status: 400, body: { error: "invalid content length" } },
  "entity.verify.failed": { status: 403, body: { error: "verification failed" } },
});

/** The fallback body for a 4xx error whose `.type` is missing or unrecognized. */
const GENERIC_4XX_BODY = { error: "bad request" };

/**
 * Route-local error handler (Checkpoint 2a, M5; widened by X1; corrected by
 * fix round 1, Finding 1): ANY error with an integer status in [400, 500) is
 * answered here, locally, instead of reaching server.js's central handler --
 * which answers 500 and reports it to Sentry (`captureException`) for what is
 * unauthenticated junk on an internal-only route (malformed JSON, a bad
 * charset, a corrupt compressed body, ...). A recognized `.type` gets its
 * mapped status+body (`entity.too.large`'s is byte-identical to the one this
 * handler answered before X1); anything else -- including no `.type` at all,
 * the corrupt-gzip shape -- gets the SAME status (never a hardcoded one) with
 * a generic body. A 5xx or status-less error still goes to `next(err)`
 * unchanged: this is a fail-closed check on `status`, not on `.type`.
 *
 * Only `jsonBody` (below) can ever hand an error to this function in the real
 * stack: Express 5 skips a route's own layers once an earlier one in the
 * SAME route has raised an error, and a handler's own error goes forward to
 * server.js's central handler, never back into an earlier route-scoped error
 * handler. So there is no live "non-body-parser error reaches here" case to
 * guard against; the status-range check alone is what protects `next(err)`
 * for a genuine 5xx.
 */
export function refuseBadBody(err, req, res, next) {
  const status = err?.status ?? err?.statusCode;
  if (!Number.isInteger(status) || status < 400 || status >= 500) return next(err);
  const known = typeof err?.type === "string" ? BODY_PARSER_ERROR_RESPONSES[err.type] : undefined;
  if (known) return res.status(known.status).json(known.body);
  return res.status(status).json(GENERIC_4XX_BODY);
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
  {
    log = defaultLog,
    importTasks = importCloudTasks,
    twilioClientFor = createTwilioClientFor(env),
    // Task 20: the sweep's `lost_callback`/`postcall_pending` branches need
    // the SAME shared instance doorRoutes.js and the Live session use, not a
    // second one. Defaults to the real, wired-up singleton -- services/
    // gemini.js (and so @google/genai) is already an eager dependency of
    // this service regardless of outbound config (server.js's own inbound
    // summary generation), so importing it here at module load adds nothing
    // that was not already loaded.
    postCall = defaultPostCall,
    // O-26/C17: server.js's shared `createTwilioAccountRouter(env)` instance
    // (lib/outbound/twilioAccounts.js) -- `{resolveAccountFor}`. NOT
    // imported by this module (that would be circular: twilioAccounts.js
    // itself reuses this file's `createCallerIdValidator`), so it is always
    // injected, never defaulted here. `null` (every existing direct caller,
    // including every test that predates C17) keeps the single-account
    // behaviour below exactly as it was.
    twilioAccounts = null,
  } = {}
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

  // O-26/C17: valid only if exactly one CONFIGURED account owns the number
  // (twilioAccounts.resolveAccountFor checks A then B, per twilioAccounts.js's
  // own doc) -- neither owning it, or B simply not being configured, both
  // read as "not found", the same fails-closed shape as before. Falls back to
  // the original single-account validator (account A only, `twilioClientFor`
  // ignoring its argument) when no router was injected -- every existing
  // direct caller of this function, including every test that predates C17.
  const callerIdValid = twilioAccounts
    ? async (phoneE164) => (await twilioAccounts.resolveAccountFor(phoneE164)) != null
    : createCallerIdValidator({ twilioClientFor });

  let dispatcher = null;
  const getDispatcher = () =>
    (dispatcher ??= createDispatcher({
      db,
      // O-26/C17: the FUNCTION, not an already-resolved account-A client --
      // dispatch.js resolves the account per outreach, from THAT outreach's
      // own campaign caller_id, which is not known until dispatch() runs.
      twilioClientFor,
      enqueue,
      env: cfg,
      now,
      callerIdValid,
      // §9.3 step 1 (Task 14): the backstop and voicemail clips, rendered by
      // a short Gemini Live session in the tenant's own voice and language
      // (resolved from the business and its number, never the contact's),
      // verified against the line, bounded by RENDER_TIMEOUT_MS.
      renderAudio: createLiveRenderAudio({ db, env, log }),
      log,
    }));
  const dispatch = (args) => getDispatcher()(args);

  return { verifier, dispatch, db, enqueue, now, log, audience, postCall, twilioClientFor };
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
  const { verifier, dispatch, db: dbDep, enqueue, now, log, postCall = defaultPostCall, twilioClientFor = createTwilioClientFor() } = deps;
  const jsonBody = express.json({ limit: JSON_LIMIT });

  /**
   * `sidless` (spec §6.3, migration 045): re-check it under the tenant --
   * still no CallSid, `result IS NULL` -- then fail it and apply the
   * schedule exactly as dispatch's own `failAndReschedule` would
   * (`failStaleAttempt`, lib/outbound/dispatch.js), reading the ATTEMPT's
   * own `attempt_no`, never the outreach's `attempts_made`.
   */
  async function resolveSidless({ business_id: businessId, attempt_id: attemptId }) {
    const ctx = await dbDep.withTenant(businessId, () => dbDep.outboundPostCallContext(attemptId));
    if (!ctx) {
      log.info("outbound_sweep_sidless_skipped", { attemptId, reason: "not_found" });
      return;
    }
    if (ctx.twilioCallSid || ctx.result) {
      // A SID or a result landed between the 045 read and this recheck --
      // no longer sidless, so leave it to the normal door/post-call path.
      log.info("outbound_sweep_sidless_skipped", { attemptId, reason: "already_resolved" });
      return;
    }
    const tz = contactTimezone({ timezone: ctx.contactTimezone, phone_e164: ctx.phoneE164 }, ctx.businessTimezone);
    const scheduleRow = { config: ctx.config, created_at: ctx.outreachCreatedAt };
    const { outreachClosed } = await failStaleAttempt({
      db: dbDep,
      enqueue,
      businessId,
      outreachId: ctx.outreachId,
      attemptId,
      r: scheduleRow,
      attemptNo: ctx.attemptNo,
      tz,
      now,
      log,
    });
    log.info("outbound_sweep_sidless_resolved", { attemptId, outreachId: ctx.outreachId, outreachClosed });
  }

  /**
   * `lost_callback` (spec §6.3, migration 045): one READ-ONLY REST call
   * (`calls(sid).fetch()`) against a real Twilio CallSid. If it reports a
   * terminal status, stamp the attempt exactly as `/twilio/outbound-status`
   * would (`stampAttemptStatus`, P-2's `completeCall` included -- the SAME
   * gate: only on the first terminal stamp of an attempt that was actually
   * answered), then claim post-call. Still in progress: leave it, log it.
   */
  async function resolveLostCallback({ business_id: businessId, attempt_id: attemptId }) {
    const ctx = await dbDep.withTenant(businessId, () => dbDep.outboundPostCallContext(attemptId));
    if (!ctx || !ctx.twilioCallSid) {
      log.info("outbound_sweep_lost_callback_skipped", { attemptId, reason: "no_sid" });
      return;
    }
    const callSid = ctx.twilioCallSid;
    let call;
    try {
      // O-26/C17: the attempt's own campaign caller_id, already loaded by
      // `outboundPostCallContext` above (`ctx.config.caller_id`) -- no new
      // read -- so this REST fetch uses the account that actually placed the
      // call, not always account A.
      const client = await twilioClientFor(ctx.config?.caller_id);
      call = await client.calls(callSid).fetch();
    } catch (err) {
      log.error("outbound_sweep_lost_callback_fetch_failed", { attemptId, callSid, error: err?.message });
      return;
    }
    const status = String(call?.status || "").toLowerCase();
    if (!TERMINAL_STATUSES.has(status)) {
      log.info("outbound_sweep_lost_callback_in_progress", { attemptId, callSid, status });
      return;
    }
    const result = RESULT_BY_STATUS[status] ?? null;
    const duration = call?.duration != null && call.duration !== "" ? Number(call.duration) : null;
    await dbDep.withTenantSafe(
      businessId,
      async () => {
        const stamp = await dbDep.stampAttemptStatus(attemptId, {
          twilioStatus: status,
          answered: status === "in-progress", // always false here (status is terminal); mirrors the door's own rule
          terminal: true,
          result,
        });
        if (stamp.firstTerminalStamp && stamp.answered) await dbDep.completeCall(callSid, status, duration);
      },
      { operation: "outboundSweepLostCallback", callSid }
    );
    await postCall.tryClaimByAttempt(attemptId, businessId);
    log.info("outbound_sweep_lost_callback_resolved", { attemptId, callSid, status });
  }

  /**
   * `postcall_pending` (spec §6.3, §11, migration 045): the session died
   * without finishing. `postCall.tryClaimByAttempt` runs `claimPostCall`'s
   * third disjunct (`status_completed_at` old enough) and, on success, logs
   * `outbound_postcall_without_session` itself.
   */
  async function resolvePostcallPending({ business_id: businessId, attempt_id: attemptId }) {
    const claimed = await postCall.tryClaimByAttempt(attemptId, businessId);
    log.info("outbound_sweep_postcall_pending", { attemptId, claimed });
  }

  const STALE_HANDLERS = Object.freeze({
    sidless: resolveSidless,
    lost_callback: resolveLostCallback,
    postcall_pending: resolvePostcallPending,
  });

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

  app.post(DISPATCH_PATH, jsonBody, refuseBadBody, async (req, res) => {
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

  app.post(SWEEP_PATH, jsonBody, refuseBadBody, async (req, res) => {
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
      // a19 (fix wave, checkpoint 2b): EACH ROW IN ITS OWN try/catch -- an
      // enqueue that throws (e.g. Cloud Tasks briefly unavailable) used to
      // abort the whole tick, before this loop even reached the stale-attempt
      // backstops below (which run AFTER this one, inside the same outer
      // try). One bad row must never cost every other due row, or every
      // sidless/lost_callback/postcall_pending repair, this tick.
      let reenqueued = 0;
      let dueFailed = 0;
      for (const row of due) {
        try {
          await enqueue({ businessId: row.business_id, outreachId: row.outreach_id, at, source: "sweep", now: t });
          reenqueued++;
        } catch (err) {
          dueFailed++;
          bumpCounter("outbound_sweep_row_failed");
          // id-only, no PHI: outreach_id/business_id are opaque ids.
          log.error("outbound_sweep_row_failed", { kind: "due", outreachId: row.outreach_id, error: err?.message });
        }
      }

      // Task 20, migration 045: the stale-attempt backstops. Guarded on the
      // function existing at all -- a `db` fake that only stubs
      // `outboundDue` (every test of the "due" behaviour above, predating
      // this task) simply has none of this run, rather than needing every
      // one of those tests updated for a feature they do not exercise.
      // EACH ROW IN ITS OWN try/catch, so one bad row can never abort the
      // tick for every other tenant's stale attempt.
      let staleHandled = 0;
      let staleFailed = 0;
      let stale = [];
      if (typeof dbDep.outboundStaleAttempts === "function") {
        stale = await dbDep.outboundStaleAttempts(
          OUTBOUND_STALE_ATTEMPTS_LIMIT,
          OUTBOUND_STALE_SIDLESS_MINUTES,
          OUTBOUND_STALE_LOST_CALLBACK_MINUTES,
          OUTBOUND_STALE_POSTCALL_PENDING_SECONDS
        );
        for (const row of stale) {
          const handler = STALE_HANDLERS[row.kind];
          if (!handler) {
            log.error("outbound_sweep_stale_attempt_unknown_kind", { attemptId: row.attempt_id, kind: row.kind, severity: "warn" });
            continue;
          }
          try {
            await handler(row);
            staleHandled++;
          } catch (err) {
            staleFailed++;
            // a19: the SAME counter the due-loop's own catch bumps above --
            // this handler already logged and continued (per-row try/catch
            // predates this task); it just never counted.
            bumpCounter("outbound_sweep_row_failed");
            log.error("outbound_sweep_stale_attempt_failed", { attemptId: row.attempt_id, kind: row.kind, error: err?.message });
          }
        }
      }

      log.info("outbound_sweep", { due: due.length, reenqueued, dueFailed, stale: stale.length, staleHandled, staleFailed });
      res.status(200).json({ reenqueued });
    } catch (err) {
      log.error("outbound_internal_sweep_failed", { error: err?.message });
      res.status(500).json({ error: "internal error" });
    }
  });
}
