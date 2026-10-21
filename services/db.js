import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import pg from "pg";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { allCapabilityToolNames, getPack } from "../capabilities/index.js";
import { validateCapabilityConfig } from "../lib/capabilities/configSchema.js";
import { normalizePhoneNumber } from "../lib/phone.js";
import { isRealCallerNumber } from "../lib/inboundGuards.js";
import { PHI_ACCESS, NON_PHI_EXPORTS, mergeAccess, validateAccessRecord } from "../lib/phiAudit.js";
import { IS_HIPAA_MODE } from "../lib/deploymentMode.js";
import { cloudSqlConfig, cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";

// Re-exported so tests/phiAuditCoverage.test.js can check the classification
// against this module's real exports without importing two files to do it.
export { PHI_ACCESS, NON_PHI_EXPORTS };

// ---------------------------------------------------------------------------
// The data layer, on plain PostgreSQL.
//
// This is services/supabase.js rewritten against `pg`. Every exported
// signature and every return shape is unchanged, deliberately: the callers did
// not ask for a new data layer, they are having one moved out from under them,
// and the way to keep that honest is for the module boundary to be the only
// thing that knows.
//
// The two places a PostgREST-to-SQL translation actually bites, both handled
// below where they occur:
//
//   1. `.single()` THROWS on no row; `.maybeSingle()` returns null. Raw pg does
//      neither — it returns `rows: []`. Every lookup here reads `rows[0] ?? null`
//      so a miss stays a miss rather than becoming an exception, and the two
//      functions that DO throw (createAppointment, createAppointmentIfAvailable)
//      keep throwing, with `err.code` intact so the tool layer can still tell a
//      23505 unique violation from a generic write failure.
//
//   2. `.select("*, business_capabilities(*)")` is a PostgREST EMBED, and it is
//      on the latency-critical pickup path. It becomes a correlated subquery
//      returning a JSON array, so the shape the caller sees is identical — and
//      its fallback for an un-migrated database is preserved explicitly, since
//      a JOIN that assumes the table exists would lose it silently.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Every query gets a deadline, enforced by the SERVER.
 *
 * The Supabase client carried a 6s fetch timeout, and the comment explaining it
 * is worth keeping because the reasoning survives the rewrite: the JS-side race
 * in services/tools.js releases the CALLER, but it cannot cancel anything. Only
 * a real cancellation stops a reschedule landing in the database minutes after
 * the caller was told it had failed.
 *
 * `statement_timeout` is strictly better than the fetch timeout it replaces. An
 * aborted fetch abandons the response; Postgres cancels the statement. Sized
 * below TOOL_TIMEOUT_MS so the database gives up first and the tool layer
 * reports a real error rather than its own generic timeout.
 */
const STATEMENT_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.DB_TIMEOUT_MS ?? process.env.SUPABASE_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 1_000 && v <= 30_000 ? v : 6_000;
})();

/** @type {pg.Pool | null} */
let pool = null;

if (DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    // A voice call holds no connection between turns, so the pool is sized for
    // concurrent CALLS, not concurrent users. Cloud SQL's own limit is the
    // ceiling that matters and B2 sets it; this keeps one process from taking
    // more than its share of it.
    max: Number.parseInt(process.env.DB_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Applied per connection, so it covers every query without each call site
    // remembering. `options` reaches the server at startup.
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });

  // An idle client erroring (a server restart, a failover) emits on the pool.
  // Unhandled, it is an uncaught exception that takes the process down —
  // during a call.
  pool.on("error", (err) => {
    log.error("db_pool_error", { message: err?.message, severity: "warn" });
  });
} else {
  // Not a warning when Cloud SQL is the backend. `initCloudSqlPool()` builds
  // the pool at startup instead, so a Cloud Run deployment that is configured
  // perfectly would otherwise announce "database not configured" at every boot
  // — and an alarm that fires when nothing is wrong is one people learn to
  // scroll past, which costs the real one.
  if (!process.env.CLOUD_SQL_INSTANCE) {
    log.error("database_not_configured", { reason: "missing_database_url", severity: "warn" });
  }
}

/** @returns {boolean} Whether the database is configured */
export function isEnabled() {
  return pool !== null;
}

/**
 * The pool itself, for the one caller that needs to run its own SQL.
 *
 * Exported reluctantly and narrowly. `lib/callStateStore.js`'s Postgres store
 * must not open a SECOND pool: `instances x DB_POOL_MAX` under the instance's
 * `max_connections` is the binding capacity constraint on this system, and a
 * store with its own pool would double the left-hand side of it for three
 * scalars written at call boundaries. Sharing this one means shared call state
 * costs zero additional connections.
 *
 * Not a general escape hatch. Anything that reads tenant data goes through
 * `withTenant`, which is what sets `app.business_id` and makes row-level
 * security apply — a raw pool connection is UNSCOPED, and `call_state` is
 * usable this way only because it deliberately has no policy on it (it is read
 * before the tenant is known; see database/038_call_state.sql).
 *
 * @returns {import("pg").Pool | null}
 */
export function getPool() {
  return pool;
}

/**
 * Bring up the pool against Cloud SQL, if that is how this deployment connects.
 *
 * DATABASE_URL builds a pool synchronously at module load, which is why the
 * rest of this file can assume `pool` exists. The Cloud SQL connector cannot:
 * it fetches ephemeral client certificates from the Admin API, so obtaining
 * connection options is asynchronous.
 *
 * Rather than make every caller await something, this is an explicit startup
 * step. server.js calls it BEFORE the port opens, so by the time a request can
 * arrive the pool is in exactly the state the rest of the module expects.
 *
 * A no-op when CLOUD_SQL_INSTANCE is unset, so local development, the tests and
 * anything still on a connection string are untouched.
 *
 * @returns {Promise<boolean>} whether a Cloud SQL pool was created.
 */
export async function initCloudSqlPool() {
  const cfg = cloudSqlConfig();
  if (!cfg) return false;

  if (pool) {
    // Both configured. Refused rather than resolved, because either answer is
    // a guess about which database the operator meant, and getting it wrong
    // means writing patient data somewhere nobody is looking.
    throw new Error(
      "Both DATABASE_URL and CLOUD_SQL_INSTANCE are set. Refusing to choose between two databases."
    );
  }

  // The runtime never uses password auth — that is the migration job's path,
  // and it is the only thing holding a credential that can alter the schema.
  // A password reaching a serving process means the wrong secret was mounted.
  if (cfg.authType === "PASSWORD") {
    throw new Error(
      "CLOUD_SQL_PASSWORD is set in a serving process. The runtime authenticates as its own IAM " +
        "identity; the superuser password belongs only to the migration job."
    );
  }

  const { poolConfig } = await cloudSqlPoolConfig(cfg, {
    max: Number.parseInt(process.env.DB_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });

  pool = new pg.Pool(poolConfig);
  pool.on("error", (err) => {
    log.error("db_pool_error", { message: err.message });
  });

  log.info("db_backend", { backend: "cloudsql", instance: cfg.instance, database: cfg.database, auth: "IAM" });
  return true;
}

/**
 * Run one statement.
 *
 * Returns `{ rows, rowCount }` on success and `{ error }` on failure, rather
 * than throwing — which mirrors what the Supabase client did and is what lets
 * every function below keep its exact error handling. Callers that need to
 * throw (createAppointment) do so themselves, from the returned error.
 *
 * @param {string} text
 * @param {Array<unknown>} [params]
 * @returns {Promise<{ rows?: Array<object>, rowCount?: number, error?: Error }>}
 */
async function q(text, params = []) {
  // A tenant-scoped client if one is in scope, otherwise the pool.
  //
  // This is what lets withTenant() work without changing a single one of the
  // 33 exported signatures. The alternative was threading a client argument
  // through every function and every caller, which A3 deliberately avoided —
  // and which would still leave `fetchCallerContext` broken, since it calls
  // `listAppointmentsByCaller` two frames down and would have to thread it
  // there too.
  const runner = tenantContext.getStore()?.client ?? pool;
  try {
    const res = await runner.query(text, params);
    return { rows: res.rows, rowCount: res.rowCount };
  } catch (error) {
    return { error };
  }
}

/** First row or null — the `.maybeSingle()` shape, without the throw. */
function one(res) {
  return res.rows?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// PHI-access audit trail (§164.312(b)) — the wiring
//
// The classification and the rules live in lib/phiAudit.js. What lives here is
// the part that has to: the accumulator rides in the SAME AsyncLocalStorage
// store withTenant already uses, because the unit of work is the only scope
// that knows when to start a record and when to write it.
// ---------------------------------------------------------------------------

/**
 * Record that this unit of work touched PHI.
 *
 * Public because the boundary that knows the actor is not always inside this
 * module, and because the validation is worth being able to call directly. The
 * data-layer functions below go through `noteAccess`, which fills in the action
 * and the resource list from the classification so the two cannot drift.
 *
 * @param {{ operation: string, action: string, resources: string[], resourceIds?: string[], rowCount?: number }} record
 */
export function recordPhiAccess(record) {
  validateAccessRecord(record);

  const audit = tenantContext.getStore()?.audit;
  if (!audit) {
    // A PHI access with nowhere to record it.
    //
    // ANNOUNCED IN `hipaa` MODE ONLY, and that is a deliberate line rather than
    // a volume control. §164.312(b) is a HIPAA Security Rule requirement; it
    // binds the covered lane. In `standard` mode — the UK/GDPR stack and every
    // non-covered deployment — an unscoped access is not a compliance defect,
    // and the ratchet this codebase already runs (A1.6, A6) only tightens.
    //
    // ------------------------------------------------------------------
    // O32 IS CLOSED, AND THIS COMMENT USED TO SAY THE OPPOSITE.
    // ------------------------------------------------------------------
    // It said per-turn writes were outside withTenant BY DESIGN, that an
    // ungated line would fire on every turn of every call, and that the fix
    // was still owed. All three stopped being true and the comment did not,
    // which made it the most confidently wrong text in this file: it described
    // an accepted gap that had already been closed, for a different reason,
    // by somebody fixing something else.
    //
    // What closed it: the live-call scoping fix wrapped every per-turn write in
    // lib/voice/session.js (`scopedWrite`) in its own SHORT unit of work,
    // because under FORCE row-level security an unscoped write is REFUSED
    // rather than merely unaudited. The audit row came along for free — one row
    // per unit of work, on a connection that is already checked out. The cost
    // O32 priced at "three extra statements on a path measured at 2,611 ms p50"
    // is not on that path either: every one of those writes is fire-and-forget,
    // so none of it is inside the turn loop.
    //
    // The last genuinely unscoped PHI write was the degraded voicemail file,
    // and it is now lib/degradedVoicemail.js, scoped and covered by a test that
    // runs as the unprivileged role. So this branch is no longer expected to
    // fire at all — reaching it means somebody added a PHI write with no unit
    // of work around it, which is exactly what it should announce.
    if (IS_HIPAA_MODE) {
      log.error("phi_access_unaudited", {
        operation: record.operation,
        action: record.action,
        resources: record.resources,
        severity: "warn",
      });
    }
    return;
  }
  mergeAccess(audit, record);
}

/**
 * The data layer's own shorthand: look the operation up in the classification
 * and record it.
 *
 * Deliberately NOT taking the action and resources as arguments. A call site
 * that repeated them would be a second copy of the classification, free to
 * disagree with the first, and the disagreement would be invisible.
 *
 * @param {string} operation - the exported function's own name
 * @param {{ resourceIds?: Array<string|null|undefined>, rowCount?: number }} [detail]
 */
function noteAccess(operation, detail = {}) {
  const entry = PHI_ACCESS[operation];
  // Unclassified is a programming error, and tests/phiAuditCoverage.test.js
  // fails the build on it. At runtime it must not take a call down, so it
  // announces itself and returns.
  if (!entry) {
    log.error("phi_access_unclassified", { operation, severity: "warn" });
    return;
  }
  recordPhiAccess({
    operation,
    action: entry.action,
    resources: entry.resources,
    resourceIds: (detail.resourceIds || []).filter(Boolean),
    rowCount: detail.rowCount ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Per-business config
// ---------------------------------------------------------------------------

const DEFAULT_GREETING = "Hi, how can I help you today?";

/**
 * Task model: CORE tasks are always available on every call, regardless of
 * per-business configuration — general Q&A, message-taking, callback
 * requests, and transferring to a human are baseline receptionist behavior,
 * not opt-in features. MODULE tasks are the opt-in capabilities a business
 * can turn on (e.g. appointment booking).
 */
export const CORE_TASKS = ["general_question", "take_message", "callback_request", "transfer_human"];
export const MODULE_TASKS = [
  "book_appointment",
  "check_appointment",
  "cancel_reschedule",
  "quote_request",
];

/** Default modules for a business with no allowed_tasks configured. */
const DEFAULT_MODULE_TASKS = ["book_appointment"];

/** Legacy bundle: "appointments" expands to the three appointment modules. */
const APPOINTMENTS_EXPAND = ["book_appointment", "check_appointment", "cancel_reschedule"];

/**
 * Normalize a business's raw `allowed_tasks` DB value into the full
 * effective task list: CORE tasks (always present) + whichever MODULE tasks
 * the business opted into. Legacy `"appointments"` expands to the three
 * appointment modules; legacy core entries (general_question, take_message,
 * callback_request) present in old DB rows are dropped silently — they're
 * no longer module-gated.
 * @param {Array<string>|null|undefined} raw - business.allowed_tasks from the DB
 * @returns {Array<string>}
 */
export function normalizeAllowedTasks(raw) {
  // UNSET (null/undefined) means "never configured" -> sensible default.
  // An EMPTY ARRAY means "explicitly no modules", which used to be
  // indistinguishable from unset: both fell through to ["book_appointment"],
  // so there was no way to express a business that does not do appointments at
  // all. Every non-appointment business was literally unrepresentable.
  if (raw === null || raw === undefined) {
    return [...CORE_TASKS, ...DEFAULT_MODULE_TASKS];
  }
  if (!Array.isArray(raw)) {
    return [...CORE_TASKS, ...DEFAULT_MODULE_TASKS];
  }
  if (raw.length === 0) {
    return [...CORE_TASKS];
  }
  const expanded = raw.includes("appointments")
    ? [...raw.filter((t) => t !== "appointments"), ...APPOINTMENTS_EXPAND]
    : raw;
  const modules = expanded.filter((t) => typeof t === "string" && MODULE_TASKS.includes(t));
  return [...CORE_TASKS, ...new Set(modules)];
}

/** Valid after-hours policy values. */
const AFTER_HOURS_POLICIES = ["take_message", "offer_callback", "book_later", "transfer_if_possible"];

/** Valid transfer policy values. */
const TRANSFER_POLICIES = ["always", "business_hours_only", "never"];
const TRANSFER_NO_ANSWER = ["take_message", "own_voicemail"];

/**
 * Build a normalised config object from a business row.
 * If `business` is null (no business found / DB disabled), returns safe defaults.
 *
 * @param {object|null} business - Row from the businesses table (via select("*"))
 * @returns {object} Normalised config with all fields defaulted
 */
/**
 * Which module tasks each capability owns. Used to switch a capability off
 * wholesale when its business_capabilities row says enabled = false.
 */
const CAPABILITY_MODULE_TASKS = {
  appointments: ["book_appointment", "check_appointment", "cancel_reschedule"],
  quotes: ["quote_request"],
};

/**
 * Fetch a business's capability rows.
 *
 * Returns [] when the table is missing or the business has none, which is what
 * makes the dual-read safe: no rows means fall back to allowed_tasks, so new
 * code against an un-migrated database still works rather than silently
 * disabling every capability mid-call.
 *
 * @param {string} businessId
 * @returns {Promise<Array<object>>}
 */
export async function fetchBusinessCapabilities(businessId) {
  if (!pool || !businessId) return [];
  const res = await q(`SELECT * FROM business_capabilities WHERE business_id = $1`, [businessId]);
  if (res.error) {
    log.error("db_error", { operation: "fetchBusinessCapabilities", error: res.error.message });
    return [];
  }
  return res.rows || [];
}

/**
 * Build the per-capability config map, and apply any explicit disables.
 *
 * @param {Array<object>} rows - business_capabilities rows
 * @param {string[]} allowedTasks - module tasks from the legacy column
 * @param {string} businessId
 * @returns {{capabilities: object, allowedTasks: string[]}}
 */
function applyCapabilityRows(rows, allowedTasks, businessId) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { capabilities: {}, allowedTasks };
  }

  const capabilities = {};
  let tasks = [...allowedTasks];

  for (const row of rows) {
    const pack = getPack(row.capability_id);
    if (!pack) {
      // A row for a capability this build does not have. Expected during a
      // rollback; ignore it rather than failing the call.
      log.error("capability_row_unknown", {
        businessId,
        capability: row.capability_id,
        severity: "warn",
      });
      continue;
    }

    const owned = CAPABILITY_MODULE_TASKS[row.capability_id] || [];

    if (row.enabled === false) {
      // The explicit "off" that allowed_tasks could never express.
      tasks = tasks.filter((t) => !owned.includes(t));
      continue;
    }

    // Enabling has to ADD the capability's module tasks, or switching one on in
    // the dashboard would store enabled=true and still register no tools —
    // a setting that appears to work and does nothing.
    //
    // Only when the business has none of them already. A business that opted
    // into booking but not cancelling has expressed a real preference at a
    // finer grain than a single capability row can, and enabling must not
    // silently widen it.
    if (owned.length > 0 && !owned.some((t) => tasks.includes(t))) {
      tasks = [...tasks, ...owned];
    }

    capabilities[row.capability_id] = {
      enabled: true,
      ...(row.adapter ? { adapter: row.adapter } : {}),
      ...(row.adapter_config && typeof row.adapter_config === "object"
        ? { adapterConfig: row.adapter_config }
        : {}),
      ...validateCapabilityConfig(row.config, pack, businessId),
    };
  }

  return { capabilities, allowedTasks: tasks };
}

/**
 * @param {object|null} business - row from the businesses table
 * @param {Array<object>} [capabilityRows] - rows from business_capabilities.
 *   Optional: a caller without them gets today's behavior (no requirements
 *   configured), which is what keeps the dual-read honest.
 */
export function loadConfig(business, capabilityRows = null) {
  if (!business) {
    return {
      // Null on the unrouted path, and callers must treat it that way. The
      // caller-facing SMS gate (services/notifications.js) reads it to find the
      // tenant's consent records; no tenant means no consent record can be
      // found, which fails the gate closed. That is the correct answer for a
      // call this system could not route to a business at all.
      businessId: null,
      businessName: "our office",
      greeting: DEFAULT_GREETING,
      _hasCustomGreeting: false,
      timezone: process.env.TIMEZONE || "America/Chicago",
      businessHours: null,
      transferPhoneNumber: null,
      allowedTasks: normalizeAllowedTasks(null),
      capabilities: {},
      mainPhone: null,
      generalInfo: null,
      recordingDisclosureEnabled: false,
      recordingDisclosureText: null,
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      transferNoAnswer: "take_message",
      allowPricierNumbers: false,
      languagesSpoken: ["en"],
      customInstructions: null,
      voiceProvider: "elevenlabs",
      voiceId: null,
      liveVoice: null,
      smsFollowupEnabled: false,
      smsTemplates: {},
      pronunciations: {},
    };
  }

  const afterHoursPolicy = AFTER_HOURS_POLICIES.includes(business.after_hours_policy)
    ? business.after_hours_policy
    : "take_message";
  const transferPolicy = TRANSFER_POLICIES.includes(business.transfer_policy)
    ? business.transfer_policy
    : "always";

  const baseTasks = normalizeAllowedTasks(business.allowed_tasks);
  // Rows arrive embedded on the business row (see lookupBusinessByPhone); an
  // explicit argument overrides, which is what the tests and the dashboard use.
  const rows = capabilityRows ?? business.business_capabilities ?? [];
  const { capabilities, allowedTasks } = applyCapabilityRows(rows, baseTasks, business.id);

  return {
    // Carried on the config because the caller-facing SMS gate needs a tenant
    // and `sendCallerSms` is handed a config, not a business row. Everything
    // else on this object is settings; this one is identity, and it is here so
    // that four call sites do not each have to thread a second argument.
    businessId: business.id,
    businessName: business.name || "our office",
    greeting: business.greeting || DEFAULT_GREETING,
    _hasCustomGreeting: !!business.greeting,
    timezone: business.timezone || process.env.TIMEZONE || "America/Chicago",
    // Explicit locale override (database/025_business_locale.sql). null means
    // "derive" — see lib/voice/voiceLocale.js. An operator setting this beats
    // every heuristic, which is the point: the heuristics exist only because
    // there usually is not one.
    locale: business.locale || null,
    businessHours: business.business_hours || null,
    transferPhoneNumber: business.transfer_phone_number || null,
    allowedTasks,
    capabilities,
    mainPhone: business.main_phone || null,
    generalInfo: business.general_info || null,
    recordingDisclosureEnabled: !!business.recording_disclosure_enabled,
    recordingDisclosureText: business.recording_disclosure_text || null,
    afterHoursPolicy,
    transferPolicy,
    transferNoAnswer: TRANSFER_NO_ANSWER.includes(business.transfer_no_answer)
      ? business.transfer_no_answer
      : "take_message",
    // Strict: only a real boolean true switches pricier numbers on (migration 053).
    allowPricierNumbers: business.allow_pricier_numbers === true,
    languagesSpoken: Array.isArray(business.languages_spoken) ? business.languages_spoken : ["en"],
    customInstructions: business.custom_instructions || null,
    voiceProvider: business.voice_provider || "elevenlabs",
    voiceId: business.voice_id || null,
    // The speech-to-speech front-end's prebuilt voice (migration 041). NOT the
    // same thing as voiceId above, which is an ElevenLabs id for the cascade —
    // one column serving both would mean a value that is valid for one path and
    // meaningless on the other, read back wrong by whoever comes next.
    //
    // `|| null` rather than a default, so an estate that has not run 041 yet
    // reads undefined -> null and takes the per-language default, exactly as it
    // did before the column existed. A tenant row is configuration, and this one
    // has to be safe to be absent.
    liveVoice: business.live_voice || null,
    smsFollowupEnabled: !!business.sms_followup_enabled,
    smsTemplates: (business.sms_templates && typeof business.sms_templates === "object") ? business.sms_templates : {},
    // Written -> spoken names for the model (migration 055,
    // lib/voice/pronunciation.js). Validated again where it is read.
    pronunciations:
      business.pronunciations && typeof business.pronunciations === "object" && !Array.isArray(business.pronunciations)
        ? business.pronunciations
        : {},
  };
}

/**
 * Look up a staff user by the email their access token was issued for.
 *
 * `users.email` is UNIQUE, so this is the join between an authenticated
 * identity and the tenant it may act on. Returns null when no staff row exists
 * — an account that authenticated but was never attached to a business.
 *
 * @param {string} email
 * @returns {Promise<{ id: string, business_id: string, email: string, role: string }|null>}
 */
export async function fetchUserByAuthUid(authUid) {
  if (!pool || !authUid) return null;
  // Through app_lookup_user_by_auth_uid (migration 036), not a plain SELECT.
  //
  // This is a BOOTSTRAP read: it is how the tenant becomes known, so it cannot
  // be scoped to a tenant. Under row-level security a direct select returns
  // nothing and nobody can authenticate. The SECURITY DEFINER function is the
  // narrow, named exception — one row, pinned search_path — instead of a policy
  // that would make "forgot to scope" mean "may see everything".
  //
  // KEYED ON THE ACCOUNT ID, not the email address, since migration 036. Signup
  // is open, so an address is something a stranger can CHOOSE: an email that has
  // a `users` row but no identity-provider account could be claimed by anyone,
  // who would then inherit that clinic's tenant. An account id cannot be chosen.
  const res = await q(`SELECT * FROM app_lookup_user_by_auth_uid($1)`, [authUid]);
  if (res.error) {
    log.error("db_error", { operation: "fetchUserByAuthUid", error: res.error.message });
    return null;
  }
  return one(res);
}

export async function fetchBusinessById(businessId) {
  if (!pool || !businessId) return null;
  const res = await q(`SELECT * FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
  if (res.error) {
    log.error("db_error", { operation: "fetchBusinessById", error: res.error.message });
    return null;
  }
  return one(res);
}

/**
 * The PostgREST embed `.select("*, business_capabilities(*)")`, as SQL.
 *
 * A correlated subquery rather than a LEFT JOIN with GROUP BY: `businesses` has
 * thirty-odd columns and grouping by all of them to collapse the join is both
 * slower and a maintenance trap, since a new column added by a migration would
 * have to be added to the GROUP BY as well or the query breaks.
 *
 * `'[]'::json` for the empty case, not NULL, because loadConfig does
 * `business.business_capabilities ?? []` and an embed never yielded NULL.
 */
const BUSINESS_WITH_CAPABILITIES = `
  SELECT b.*,
         COALESCE(
           (SELECT json_agg(bc.*) FROM business_capabilities bc WHERE bc.business_id = b.id),
           '[]'::json
         ) AS business_capabilities
    FROM businesses b`;

/**
 * One exact-equality lookup on businesses.phone_number.
 * @param {string} value - the number to match, verbatim
 * @returns {Promise<object|null>} The business row or null
 */
async function selectBusinessByExactPhone(value) {
  // Capability rows come back in the SAME round trip. They are needed before
  // the first turn, because they decide which tools exist and which
  // requirements are enforced — fetching them in the background alongside
  // knowledge and integrations would leave a caller who speaks immediately
  // running turn one with no requirements applied, which for an identity check
  // is not an acceptable race. One round trip on the pickup path, which is
  // latency-critical.
  // The capability embed, restricted to the one business the bootstrap function
  // returns. app_lookup_business_by_phone (migration 029) is SECURITY DEFINER
  // for the same reason as the user lookup: resolving the dialled number to a
  // tenant is what makes scoping possible, so it cannot itself be scoped.
  // Both halves go through bootstrap functions, and both are needed: a plain
  // subquery over business_capabilities returns NOTHING here, because that
  // table is RLS-protected and no tenant is set yet. Still ONE round trip —
  // b.* keeps its native column types, so nothing downstream sees a date
  // arrive as a string.
  const res = await q(
    `SELECT b.*, app_business_capabilities(b.id) AS business_capabilities
       FROM app_lookup_business_by_phone($1) b`,
    [value]
  );

  if (res.error) {
    // An un-migrated database has no business_capabilities table, and the
    // subquery makes the whole statement fail rather than returning the
    // business without it. Falling back to the plain select keeps calls
    // answerable during a partial deploy — the dual-read then uses
    // allowed_tasks. This branch is the reason the capability fetch is a
    // subquery in a string and not a JOIN somebody could "simplify".
    log.error("db_error", { operation: "lookupBusinessByPhone", error: res.error.message });
    const plain = await q(`SELECT * FROM app_lookup_business_by_phone($1)`, [value]);
    if (plain.error) {
      log.error("db_error", { operation: "lookupBusinessByPhone_fallback", error: plain.error.message });
      return null;
    }
    return one(plain);
  }
  return one(res);
}

/**
 * Recover a business whose stored phone_number is damaged (whitespace or
 * formatting characters) and therefore cannot match the clean E.164 value
 * Twilio sends.
 *
 * This is the case that took every business except one offline: rows entered by
 * hand in the Supabase table editor were stored as "\n+442079460958". Migration
 * 024 cleans them and installs a trigger so it cannot recur — this is the
 * safety net for a database where that has not run, or where the trigger has
 * been dropped.
 *
 * The LIKE pattern only narrows the candidate set; the match is then confirmed
 * in JS with normalizePhoneNumber, so a number that merely contains the same
 * digits in order can never be returned as a false positive.
 *
 * @param {string} normalized - E.164 number Twilio dialed
 * @returns {Promise<object|null>}
 */
async function recoverBusinessByDamagedPhone(normalized) {
  const pattern = `%${normalized.replace(/^\+/, "").split("").join("%")}%`;
  // The recovery path cannot use the bootstrap function (that one matches
  // exactly), so it reads `businesses` directly and is therefore subject to RLS
  // like anything else. That is the correct trade: a damaged-row recovery is a
  // safety net for an un-migrated database, and a safety net that can read
  // across tenants is not one worth having.
  const res = await q(`${BUSINESS_WITH_CAPABILITIES} WHERE b.phone_number LIKE $1 LIMIT 5`, [pattern]);

  if (res.error) {
    log.error("db_error", { operation: "lookupBusinessByPhone_recover", error: res.error.message });
    return null;
  }

  const matches = (res.rows || []).filter((b) => normalizePhoneNumber(b.phone_number) === normalized);
  if (matches.length !== 1) {
    if (matches.length > 1) {
      log.error("business_phone_ambiguous", {
        operation: "lookupBusinessByPhone",
        businessPhone: normalized,
        count: matches.length,
        severity: "warn",
      });
    }
    return null;
  }
  return matches[0];
}

/**
 * Look up a business by its Twilio phone number.
 * @param {string} twilioNumber - The "To" number from Twilio
 * @returns {Promise<object|null>} The business row or null
 */
export async function lookupBusinessByPhone(twilioNumber) {
  if (!pool) return null;

  const normalized = normalizePhoneNumber(twilioNumber);
  const primary = normalized ?? (typeof twilioNumber === "string" ? twilioNumber : null);
  if (!primary) return null;

  const row = await selectBusinessByExactPhone(primary);
  if (row) return row;

  // A miss is already a broken call (the caller would hear the "our office"
  // default), so the extra round trip below costs nothing that was working.
  if (!normalized) return null;

  const recovered = await recoverBusinessByDamagedPhone(normalized);
  if (recovered) {
    log.error("business_phone_unnormalized", {
      operation: "lookupBusinessByPhone",
      businessId: recovered.id,
      businessPhone: normalized,
      stored: JSON.stringify(recovered.phone_number),
      severity: "warn",
    });
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Inbound launch guards (migration 054). All four run on the POOL, never on a
// tenant-scoped client, by design: pending_dials / blocked_callers are
// platform tables with no grant to vetra_app, and the functions that read
// `calls` set (and restore) their own tenant scope. Each THROWS on a database
// error so the caller decides fail-open vs fail-closed, and returns null when
// no database is configured. Phone numbers are never logged here.
// ---------------------------------------------------------------------------

/**
 * Record a transfer dial that may still be ringing (loop guard).
 * @returns {Promise<number|string|null>} the new row id, null when no database
 */
export async function recordPendingDial({ businessId, callSid, callerNumber, dialledNumber, timeoutSec }) {
  if (!pool) return null;
  const res = await pool.query(`SELECT app_record_pending_dial($1,$2,$3,$4,$5) AS id`, [
    businessId,
    callSid,
    callerNumber ?? null,
    dialledNumber,
    timeoutSec ?? null,
  ]);
  const id = res.rows[0].id;
  noteAccess("recordPendingDial", { rowCount: 1 });
  return id;
}

/**
 * End the open pending dials of a parent call.
 * @returns {Promise<number|null>} how many rows were ended, null when no database
 */
export async function endPendingDial(callSid) {
  if (!pool) return null;
  const res = await pool.query(`SELECT app_end_pending_dial($1) AS n`, [callSid ?? null]);
  return res.rows[0].n;
}

/**
 * Everything the inbound webhook asks about a caller, in one round trip.
 * `countCalls` false skips the cross-tenant walk (callsToday comes back 0).
 * @returns {Promise<{blocked: boolean, bounced: boolean, callsToday: number}|null>}
 */
export async function inboundGuardFacts({ businessId, from, countCalls }) {
  if (!pool) return null;
  const res = await pool.query(
    `SELECT app_caller_blocked($2,$1) AS blocked,
            app_dial_bounced($1,$2) AS bounced,
            app_calls_from_today($3) AS calls_today`,
    [businessId, from ?? null, countCalls ? (from ?? null) : null]
  );
  const row = res.rows[0];
  noteAccess("inboundGuardFacts", { rowCount: res.rows.length });
  return { blocked: row.blocked === true, bounced: row.bounced === true, callsToday: Number(row.calls_today) || 0 };
}

/**
 * AI seconds a caller has used at a business today (UTC), counted twice in one
 * round trip: `after` includes the named call, `before` excludes it.
 * @returns {Promise<{after: number, before: number}|null>}
 */
export async function aiSecondsToday({ businessId, callerNumber, callSid }) {
  if (!pool) return null;
  const res = await pool.query(
    `SELECT app_ai_seconds_today($1,$2) AS after, app_ai_seconds_today($1,$2,$3) AS before`,
    [businessId, callerNumber ?? null, callSid ?? null]
  );
  const row = res.rows[0];
  noteAccess("aiSecondsToday", { rowCount: res.rows.length });
  return { after: Number(row.after) || 0, before: Number(row.before) || 0 };
}

/**
 * Insert a new call row.
 * @param {string} businessId
 * @param {string} callSid - Twilio Call SID
 * @param {string} callerNumber - From number
 * @param {string} twilioNumber - To number
 * @param {{direction?: string, campaignId?: string, campaignVersion?: number, outreachId?: string, attemptId?: string, contactId?: string}} [link]
 *   Outbound only (spec §6.2, Task 14): the call's direction and its links to
 *   the campaign, outreach, attempt and contact. On outbound `callerNumber` is
 *   the contact ("the other party") and `twilioNumber` our caller_id, so the
 *   column meanings do not change. Omitted by every inbound caller, and then
 *   the statement and its parameters are exactly the four-argument ones.
 * @returns {Promise<string|null>} The new call's UUID or null on failure
 */
export async function createCall(businessId, callSid, callerNumber, twilioNumber, link) {
  if (!pool) return null;
  const res = link
    ? await q(
        `INSERT INTO calls (business_id, twilio_call_sid, caller_number, twilio_number, direction, campaign_id, campaign_version, outreach_id, attempt_id, contact_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'inbound'), $6, $7, $8, $9, $10) RETURNING id`,
        [
          businessId,
          callSid,
          callerNumber,
          twilioNumber,
          link.direction ?? null,
          link.campaignId ?? null,
          link.campaignVersion ?? null,
          link.outreachId ?? null,
          link.attemptId ?? null,
          link.contactId ?? null,
        ]
      )
    : await q(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, twilio_number)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, callSid, callerNumber, twilioNumber]
  );
  if (res.error) {
    log.error("db_error", { callSid, operation: "createCall", error: res.error.message });
    captureException(new Error(res.error.message), { table: "calls", op: "insert" });
    return null;
  }
  const created = one(res).id;
  noteAccess("createCall", { resourceIds: [created], rowCount: 1 });
  return created;
}

/**
 * Insert a transcript entry.
 * @param {string} callId - DB call UUID
 * @param {string} speaker - 'caller' or 'ai'
 * @param {string} message - The transcript text
 * @param {number} sequence - Turn order number
 */
export async function addTranscriptEntry(callId, speaker, message, sequence) {
  if (!pool) return;
  const res = await q(
    `INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1, $2, $3, $4)`,
    [callId, speaker, message, sequence]
  );
  if (res.error) {
    // callId (the DB call UUID) — NOT callSid: this function never receives a
    // Twilio Call SID, and referencing one here threw a ReferenceError that
    // replaced the real DB error before every call site's .catch() swallowed it.
    log.error("db_error", { callId, operation: "addTranscriptEntry", error: res.error.message });
    return;
  }
  noteAccess("addTranscriptEntry", { resourceIds: [callId], rowCount: 1 });
}

/**
 * Mark a call as completed (or other terminal status).
 * @param {string} callSid - Twilio Call SID
 * @param {string} status - Terminal status string
 * @param {number|null} durationSeconds - Call duration from Twilio
 */
export async function completeCall(callSid, status, durationSeconds) {
  if (!pool) return;

  // ended_at/duration_seconds are written unconditionally — a transferred
  // call still ends and has a real duration, regardless of what happens to
  // the `status` column below.
  const timing =
    durationSeconds != null
      ? await q(`UPDATE calls SET ended_at = now(), duration_seconds = $2 WHERE twilio_call_sid = $1`, [
          callSid,
          Number(durationSeconds),
        ])
      : await q(`UPDATE calls SET ended_at = now() WHERE twilio_call_sid = $1`, [callSid]);
  if (timing.error) {
    log.error("db_error", { callSid, operation: "completeCall_timing", error: timing.error.message });
    captureException(new Error(timing.error.message), { table: "calls", op: "update_complete_timing" });
  }

  // `status`: a single atomic UPDATE ... WHERE status <> 'transferred' —
  // NOT a separate SELECT-then-UPDATE (an older implementation). That
  // read-then-write had a race window: a markCallTransferred() landing
  // between the SELECT and the UPDATE would get silently clobbered back to
  // `status` here — the exact bug this guard exists to prevent. A single
  // WHERE-guarded statement can't have that gap: Postgres serializes
  // concurrent UPDATEs to the same row, so whichever of this and
  // markCallTransferred() commits second always sees the other's already-
  // committed value, not a stale snapshot read earlier. Also saves a
  // round-trip on every terminal status callback.
  //
  // `IS DISTINCT FROM`, not `<>`. PostgREST's .neq() excluded NULLs for you;
  // bare SQL `status <> 'transferred'` is NULL — and so not true — when status
  // is NULL, which would silently skip the update.
  //
  // As it happens `calls.status` is NOT NULL, so the two are equivalent today
  // and this is belt and braces. It is kept because it costs nothing and stops
  // being equivalent the moment somebody drops that constraint, which is
  // exactly the sort of change that would not think to look here.
  const st = await q(
    `UPDATE calls SET status = $2 WHERE twilio_call_sid = $1 AND status IS DISTINCT FROM 'transferred'`,
    [callSid, status]
  );
  if (st.error) {
    log.error("db_error", { callSid, operation: "completeCall_status", error: st.error.message });
    captureException(new Error(st.error.message), { table: "calls", op: "update_complete_status" });
  }
  // Both statements are keyed by call SID rather than by row id, so there is no
  // uuid to record. `rowCount` still carries whether anything was actually
  // written, which is the part an auditor reads.
  //
  // Only when something actually happened. This function deliberately does NOT
  // return early on error — the two statements fail independently — so without
  // this guard a completeCall in which both statements failed would still file
  // an audit record saying the call record was written. An audit trail that
  // reports work that did not happen is worse than one that misses work that
  // did: the first is believed.
  if (!timing.error || !st.error) {
    noteAccess("completeCall", { rowCount: (timing.rowCount || 0) + (st.rowCount || 0) });
  }
}

/**
 * Mark a call as transferred to a human. Kept distinct from completeCall so
 * a later Twilio "completed" status callback doesn't overwrite this — see
 * the transferred-status guard in completeCall above.
 * @param {string} callSid - Twilio Call SID
 */
export async function markCallTransferred(callSid) {
  if (!pool) return;
  const res = await q(`UPDATE calls SET status = 'transferred', transferred_at = COALESCE(transferred_at, now()) WHERE twilio_call_sid = $1`, [callSid]);
  if (res.error) {
    log.error("db_error", { callSid, operation: "markCallTransferred", error: res.error.message });
    captureException(new Error(res.error.message), { table: "calls", op: "update_transferred" });
    return;
  }
  noteAccess("markCallTransferred", { rowCount: res.rowCount || 0 });
}

/**
 * OUTBOUND CALLING, Task 19 (spec §9.7, Ruling P-6). `calls.outcome_code` has
 * no dedicated setter yet -- this is the first write to it. Same shape as
 * markCallTransferred: keyed by CallSid, scoped by the caller (the
 * transfer-result door runs it inside `withTenantSafe`), and the caller
 * asserts the row landed via `rowCount`, because a tenantless write under
 * FORCE RLS matches zero rows and reports success.
 *
 * Post-call (Task 20) honours a door-set outcome_code ahead of the effects/
 * summary ones (precedence: tool > door > effects > summary); Task 25 gives
 * the underlying note ("transfer_unanswered") a real column.
 *
 * @param {string} callSid - Twilio Call SID
 * @param {string} outcomeCode
 */
export async function setCallOutcomeCode(callSid, outcomeCode) {
  if (!pool) return;
  const res = await q(`UPDATE calls SET outcome_code = $2 WHERE twilio_call_sid = $1`, [callSid, outcomeCode]);
  // Fix round 1, I6: THROW rather than log-and-return, matching every other
  // outbound writer keyed by a single row (stampAttemptStatus, stampAttemptAmd,
  // setAttemptCallSid, ...). A silent return here reported success back to the
  // door route for a write that never landed -- rowCount 0 (a CallSid this
  // service never created a `calls` row for) or a DB error both look identical
  // to "it worked" to a caller that never checks. The door route already runs
  // this inside withTenantSafe, which logs the throw and degrades safely.
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`setCallOutcomeCode: expected 1 row, got ${res.rowCount}`);
  noteAccess("setCallOutcomeCode", { rowCount: res.rowCount });
}

/**
 * S3-3 (spec §12.2, §11's "answers.callback_requested_at" seam --
 * outboundPostCallContext's own doc names it). `calls.answers` has no
 * dedicated writer either -- this is the first one. `schedule_callback`
 * (capabilities/callback.js) is the only caller today, merging
 * `{_callback_requested_at}` in (renamed, review minor: the plain key could
 * collide with a campaign question of the same name); a shallow JSONB merge
 * (`||`) rather than a full overwrite so a later write never has to know
 * what an earlier one already stored. Same shape as setCallOutcomeCode
 * immediately above: keyed
 * by CallSid, THROWS rather than logs-and-returns on a DB error or a missing
 * row -- a tenantless write under FORCE RLS matches zero rows and reports
 * success, which here would silently drop the callback time a caller was
 * just told back.
 * @param {string} callSid - Twilio Call SID
 * @param {object} patch - merged shallowly into the existing `answers` (or `{}`)
 */
export async function mergeCallAnswers(callSid, patch) {
  if (!pool) return;
  const res = await q(
    `UPDATE calls SET answers = COALESCE(answers, '{}'::jsonb) || $2::jsonb WHERE twilio_call_sid = $1`,
    [callSid, JSON.stringify(patch || {})]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`mergeCallAnswers: expected 1 row, got ${res.rowCount}`);
  noteAccess("mergeCallAnswers", { rowCount: res.rowCount });
}

/**
 * Fetch all transcript entries for a call, ordered by sequence.
 * @param {string} callId - DB call UUID
 * @returns {Promise<Array<{speaker: string, message: string, sequence: number}>>}
 */
export async function fetchCallTranscript(callId) {
  if (!pool) return [];
  const res = await q(
    `SELECT speaker, message, sequence FROM call_transcripts WHERE call_id = $1 ORDER BY sequence ASC`,
    [callId]
  );
  if (res.error) {
    log.error("db_error", { operation: "fetchCallTranscript", error: res.error.message });
    return [];
  }
  noteAccess("fetchCallTranscript", { resourceIds: [callId], rowCount: res.rows?.length || 0 });
  return res.rows || [];
}

/**
 * Update a business's Twilio phone number (for buy-number API).
 * @param {string} businessId
 * @param {string} phoneNumber - E.164 phone number
 * @returns {Promise<boolean>} true if update succeeded
 */
export async function updateBusinessPhoneNumber(businessId, phoneNumber) {
  if (!pool || !businessId) return false;
  // Normalize on write as well as in the DB trigger (migration 024): the
  // trigger is the backstop for hand-edits, this keeps the value the
  // application believes it stored identical to the value it will later match
  // against Twilio's `To`.
  const normalized = normalizePhoneNumber(phoneNumber);
  if (phoneNumber && !normalized) {
    log.error("business_phone_rejected", {
      operation: "updateBusinessPhoneNumber",
      businessId,
      reason: "not_e164",
      severity: "warn",
    });
    return false;
  }
  const res = await q(`UPDATE businesses SET phone_number = $2 WHERE id = $1`, [businessId, normalized]);
  if (res.error) {
    log.error("db_error", { operation: "updateBusinessPhoneNumber", error: res.error.message });
    return false;
  }
  return true;
}

/**
 * Update a call's summary, sentiment, and outcome after generation.
 * @param {string} callSid - Twilio Call SID
 * @param {string|null} summary
 * @param {string|null} sentiment
 * @param {string|null} outcome - One of CALL_OUTCOMES (e.g. general_inquiry, appointment, unknown)
 */
export async function updateCallSummary(callSid, summary, sentiment, outcome) {
  if (!pool) return;
  const res = await q(
    `UPDATE calls SET summary = $2, sentiment = $3, outcome = $4 WHERE twilio_call_sid = $1`,
    [callSid, summary, sentiment, outcome ?? null]
  );
  if (res.error) {
    log.error("db_error", { callSid, operation: "updateCallSummary", error: res.error.message });
    return;
  }
  noteAccess("updateCallSummary", { rowCount: res.rowCount || 0 });
}

/**
 * Write the per-call turn-latency rollup (computed from the in-process
 * metrics ring buffer — see lib/voice/metrics.js's getCallStats()).
 * @param {string} callSid
 * @param {number} avgMs
 * @param {number} p95Ms
 */
export async function updateCallLatency(callSid, avgMs, p95Ms) {
  if (!pool) return;
  const res = await q(
    `UPDATE calls SET avg_turn_latency_ms = $2, p95_turn_latency_ms = $3 WHERE twilio_call_sid = $1`,
    [callSid, avgMs, p95Ms]
  );
  if (res.error) {
    log.error("db_error", { callSid, operation: "updateCallLatency", error: res.error.message });
  }
}

/**
 * Create an appointment.
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} [params.callId]
 * @param {string} [params.serviceId]
 * @param {string} [params.clientName]
 * @param {string} [params.clientPhone]
 * @param {string} params.scheduledAt - ISO 8601 datetime
 * @param {string} [params.notes]
 * @returns {Promise<string|null>} The new appointment UUID or null
 */
export async function createAppointment({ businessId, callId, serviceId, clientName, clientPhone, scheduledAt, notes }) {
  if (!pool) return null;
  const res = await q(
    `INSERT INTO appointments (business_id, call_id, service_id, client_name, client_phone, scheduled_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [businessId, callId || null, serviceId || null, clientName || null, clientPhone || null, scheduledAt, notes || null]
  );
  if (res.error) {
    log.error("db_error", { operation: "createAppointment", error: res.error.message, code: res.error.code });
    captureException(new Error(res.error.message), { table: "appointments", op: "insert" });
    // Surface the failure (with the Postgres code) so the tool layer can
    // distinguish "slot already taken" (23505 unique violation) from a
    // generic write error. A silent null made both look identical.
    const e = new Error(res.error.message);
    e.code = res.error.code;
    throw e;
  }
  const appointmentId = one(res).id;
  noteAccess("createAppointment", { resourceIds: [appointmentId], rowCount: 1 });
  return appointmentId;
}

/**
 * Count SCHEDULED appointments overlapping the window a booking of `startISO`
 * would occupy. All slots share the business's configured length L, so two
 * bookings overlap iff their starts are less than L apart — i.e. existing
 * `scheduled_at ∈ (start - L, start + L)`. Used to decide whether a slot still
 * has capacity.
 *
 * Fails OPEN (returns 0) on a DB error: a read failure must not falsely block a
 * legitimate booking. The atomic RPC (createAppointmentIfAvailable) is the real
 * race-safe guarantee; this is for the pre-collection check and the caller tool.
 *
 * @param {string} businessId
 * @param {string} startISO - ISO 8601 instant
 * @param {number} lengthMinutes
 * @returns {Promise<number>}
 */
export async function countScheduledOverlapping(businessId, startISO, lengthMinutes) {
  if (!pool || !businessId) return 0;
  const startMs = Date.parse(startISO);
  if (!Number.isFinite(startMs)) return 0;
  const L = (Number.isFinite(lengthMinutes) ? lengthMinutes : 30) * 60_000;
  const lo = new Date(startMs - L + 1).toISOString();
  const hi = new Date(startMs + L - 1).toISOString();
  const res = await q(
    `SELECT count(*)::int AS n FROM appointments
      WHERE business_id = $1 AND status = 'scheduled'
        AND scheduled_at >= $2 AND scheduled_at <= $3`,
    [businessId, lo, hi]
  );
  if (res.error) {
    log.error("db_error", { operation: "countScheduledOverlapping", error: res.error.message });
    return 0;
  }
  return one(res)?.n || 0;
}

/**
 * The start times of SCHEDULED appointments in [startISO, endISO) for a business
 * — used to enumerate a day and offer free alternatives without a query per
 * candidate slot.
 * @returns {Promise<Array<{scheduled_at: string}>>}
 */
export async function listScheduledBetween(businessId, startISO, endISO) {
  if (!pool || !businessId) return [];
  const res = await q(
    `SELECT scheduled_at FROM appointments
      WHERE business_id = $1 AND status = 'scheduled'
        AND scheduled_at >= $2 AND scheduled_at < $3
      ORDER BY scheduled_at ASC`,
    [businessId, startISO, endISO]
  );
  if (res.error) {
    log.error("db_error", { operation: "listScheduledBetween", error: res.error.message });
    return [];
  }
  return res.rows || [];
}

/**
 * Atomically book only if the slot still has capacity. Delegates to the
 * `create_appointment_if_available` plpgsql function (migration 022), which
 * takes a per-(business, slot) advisory lock, re-counts overlaps under the lock,
 * and inserts only when `count < capacity`. This is what makes the check
 * race-safe: the app-level check can go stale between reading and writing; the
 * RPC cannot.
 *
 * @returns {Promise<{id: string}|{full: true}|null>} id on success, {full:true}
 *   when the slot filled, null on a hard error (caller falls back to a message).
 */
export async function createAppointmentIfAvailable(params) {
  if (!pool) return null;
  const { businessId, callId, clientName, clientPhone, scheduledAt, notes, lengthMinutes, capacity } = params;
  const res = await q(
    `SELECT create_appointment_if_available($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [
      businessId,
      scheduledAt,
      Number.isFinite(lengthMinutes) ? lengthMinutes : 30,
      Number.isFinite(capacity) ? capacity : 1,
      callId || null,
      clientName || null,
      clientPhone || null,
      notes || null,
    ]
  );
  if (res.error) {
    log.error("db_error", { operation: "createAppointmentIfAvailable", error: res.error.message, code: res.error.code });
    captureException(new Error(res.error.message), { table: "appointments", op: "rpc_book" });
    const e = new Error(res.error.message);
    e.code = res.error.code;
    throw e;
  }
  // The function returns the new uuid, or NULL when the slot is full.
  const id = one(res)?.id ?? null;
  // Recorded either way. A booking attempt that lost the race still submitted
  // the caller's name and number to the database, which is a write of their
  // data whether or not a row survived it.
  noteAccess("createAppointmentIfAvailable", { resourceIds: id ? [id] : [], rowCount: id ? 1 : 0 });
  return id ? { id } : { full: true };
}

/**
 * List scheduled appointments for a caller by business, optional phone and name.
 * @param {string} businessId
 * @param {object} [opts]
 * @param {string} [opts.clientPhone] - Caller phone (matched after normalizing to digits)
 * @param {string} [opts.clientName] - Caller name (case-insensitive partial match)
 * @param {boolean} [opts.upcomingOnly] - Drop rows already in the past. Opt-in
 *   so the tool path's behavior does not move: "your appointments" legitimately
 *   includes one earlier today, whereas the prompt's CALLER CONTEXT block
 *   answers the narrower question "what is still coming up".
 * @returns {Promise<Array<{id: string, client_name: string|null, client_phone: string|null, scheduled_at: string, status: string, notes: string|null}>>}
 */
export async function listAppointmentsByCaller(businessId, opts = {}) {
  if (!pool || !businessId) return [];
  const phone = typeof opts.clientPhone === "string" ? opts.clientPhone.replace(/\D/g, "").trim() : "";
  const name = typeof opts.clientName === "string" ? opts.clientName.trim() : "";

  const params = [businessId];
  let nameClause = "";
  if (name) {
    // ILIKE with the same `%` escaping the PostgREST version applied. The
    // ESCAPE clause is explicit because the default escape character in a
    // Postgres LIKE pattern is the backslash, and leaving it implicit is how a
    // name containing one starts matching things it should not.
    params.push(`%${name.replace(/%/g, "\\%")}%`);
    nameClause = ` AND client_name ILIKE $${params.length} ESCAPE '\\'`;
  }

  const res = await q(
    `SELECT id, client_name, client_phone, scheduled_at, status, notes
       FROM appointments
      WHERE business_id = $1 AND status = 'scheduled'${nameClause}
      ORDER BY scheduled_at ASC`,
    params
  );
  if (res.error) {
    log.error("db_error", { operation: "listAppointmentsByCaller", error: res.error.message });
    // opts.nullOnError (Round A1 Part 6): fetchCallerContext must tell a
    // failed lookup ("unknown") from an empty one ("none").
    return opts.nullOnError ? null : [];
  }
  let list = res.rows || [];
  if (opts.upcomingOnly) {
    const now = Date.now();
    list = list.filter((r) => {
      const t = Date.parse(r.scheduled_at);
      return Number.isFinite(t) && t >= now;
    });
  }
  if (phone) {
    list = list.filter((r) => {
      const p = (r.client_phone || "").replace(/\D/g, "").trim();
      return p && p.slice(-10) === phone.slice(-10);
    });
  }
  // After the filters, not before: the audit record says what was DISCLOSED to
  // the caller of this function, not what the query happened to fetch on the
  // way there.
  noteAccess("listAppointmentsByCaller", { resourceIds: list.map((r) => r.id), rowCount: list.length });
  return list;
}

/**
 * Every appointment this CALL wrote.
 *
 * `appointments.call_id` has been populated on every booking since the column
 * existed and had no reader until LVX29 needed one. It is the difference
 * between "what did this call write" being an exact question and being a
 * heuristic over business_id, phone and created_at.
 *
 * Status is deliberately NOT filtered. The post-call read confirms from the
 * row, and a booking this call made and then cancelled is a row whose status
 * is the answer, not a row to hide.
 *
 * RETURNS `null` ON FAILURE, and `[]` only for a read that genuinely found
 * nothing. This DIVERGES from listAppointmentsByCaller, which returns `[]` for
 * both, and the divergence is the whole point: the caller is LVX29, where "the
 * database has no row for what the assistant said" is a report that the
 * assistant fabricated a booking. Collapsing an outage into that answer would
 * accuse the model of lying every time the database hiccups, and suppress a
 * confirmation the caller should have had. The two must not look alike here.
 *
 * @param {string} callId - calls.id, i.e. state.dbCallId
 * @param {string} businessId - REQUIRED. Same rule as getAppointmentById: a
 *   call UUID is not a secret, so an unscoped lookup would read across tenants.
 * @returns {Promise<Array<{id: string, client_name: string|null, client_phone: string|null, scheduled_at: string, status: string, notes: string|null}>|null>}
 */
export async function listAppointmentsByCallId(callId, businessId) {
  if (!pool || !callId) return null;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "listAppointmentsByCallId" });
    return null;
  }
  const res = await q(
    `SELECT id, client_name, client_phone, scheduled_at, status, notes
       FROM appointments
      WHERE call_id = $1 AND business_id = $2
      ORDER BY scheduled_at ASC`,
    [callId, businessId]
  );
  if (res.error) {
    log.error("db_error", { operation: "listAppointmentsByCallId", error: res.error.message });
    return null;
  }
  const list = res.rows || [];
  noteAccess("listAppointmentsByCallId", { resourceIds: list.map((r) => r.id), rowCount: list.length });
  return list;
}

/**
 * Fetch a single appointment by id (for the caller-identity guard before
 * cancel/reschedule — verifies the appointment actually belongs to the
 * caller before mutating it).
 * @param {string} appointmentId
 * @param {string} businessId - REQUIRED. The tenant filter is unconditional:
 *   an appointment UUID is not a secret, so a lookup without a business scope
 *   would read across every tenant in the table. Missing => no query at all.
 * @returns {Promise<{id: string, client_name: string|null, client_phone: string|null, scheduled_at: string, status: string, notes: string|null}|null>}
 */
export async function getAppointmentById(appointmentId, businessId) {
  if (!pool || !appointmentId) return null;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "getAppointmentById", appointmentId });
    return null;
  }
  const res = await q(
    `SELECT id, client_name, client_phone, scheduled_at, status, notes
       FROM appointments WHERE id = $1 AND business_id = $2`,
    [appointmentId, businessId]
  );
  if (res.error) {
    log.error("db_error", { operation: "getAppointmentById", error: res.error.message });
    return null;
  }
  const found = one(res);
  noteAccess("getAppointmentById", { resourceIds: [appointmentId], rowCount: found ? 1 : 0 });
  return found;
}

/**
 * Update an appointment's status (e.g. cancel).
 * @param {string} appointmentId
 * @param {string} status - e.g. 'cancelled'
 * @param {string} businessId - REQUIRED; the tenant filter is unconditional
 *   (see getAppointmentById). Missing => no query at all.
 * @returns {Promise<boolean>}
 */
export async function updateAppointmentStatus(appointmentId, status, businessId) {
  if (!pool || !appointmentId) return false;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "updateAppointmentStatus", appointmentId });
    return false;
  }
  const res = await q(
    `UPDATE appointments SET status = $3 WHERE id = $1 AND business_id = $2 RETURNING id`,
    [appointmentId, businessId, status]
  );
  if (res.error) {
    log.error("db_error", { operation: "updateAppointmentStatus", error: res.error.message });
    return false;
  }
  const updated = one(res) != null;
  noteAccess("updateAppointmentStatus", { resourceIds: [appointmentId], rowCount: updated ? 1 : 0 });
  return updated;
}

/**
 * Update an appointment (e.g. reschedule).
 *
 * `updates` is a caller-supplied object of column => value. Column names are
 * checked against an allowlist rather than interpolated, because a column name
 * cannot be a bound parameter and everything else here is. The allowlist is
 * every column a reschedule or an edit legitimately touches; anything else is
 * dropped and logged rather than silently ignored, so a typo in a call site
 * surfaces instead of quietly doing nothing.
 *
 * @param {string} appointmentId
 * @param {object} updates - e.g. { scheduled_at: "2026-04-15T10:00:00" }
 * @param {string} businessId - REQUIRED; the tenant filter is unconditional
 *   (see getAppointmentById). Missing => no query at all.
 * @returns {Promise<boolean>}
 */
const APPOINTMENT_UPDATABLE = new Set([
  "scheduled_at",
  "status",
  "notes",
  "client_name",
  "client_phone",
  "service_id",
]);

export async function updateAppointment(appointmentId, updates, businessId) {
  if (!pool || !appointmentId || !updates || typeof updates !== "object") return false;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "updateAppointment", appointmentId });
    return false;
  }

  const cols = [];
  const params = [appointmentId, businessId];
  for (const [col, val] of Object.entries(updates)) {
    if (!APPOINTMENT_UPDATABLE.has(col)) {
      log.error("db_update_column_refused", { operation: "updateAppointment", column: col, severity: "warn" });
      continue;
    }
    params.push(val);
    cols.push(`${col} = $${params.length}`);
  }
  // An update with nothing to set was a no-op that returned true under
  // PostgREST. Keeping that: the caller asked for nothing and got it.
  if (cols.length === 0) return false;

  const res = await q(
    `UPDATE appointments SET ${cols.join(", ")} WHERE id = $1 AND business_id = $2 RETURNING id`,
    params
  );
  if (res.error) {
    log.error("db_error", { operation: "updateAppointment", error: res.error.message });
    return false;
  }
  const changed = one(res) != null;
  noteAccess("updateAppointment", { resourceIds: [appointmentId], rowCount: changed ? 1 : 0 });
  return changed;
}

/**
 * Create a customer request (message or callback) from the record_customer_request tool.
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} [params.callId]
 * @param {string} params.requestType - e.g. "message" or "callback"
 * @param {string} [params.callerName]
 * @param {string} [params.callbackNumber]
 * @param {string} [params.message]
 * @param {string} [params.preferredTime]
 * @param {string} [params.notes]
 * @returns {Promise<string|null>} The new customer_requests row id or null
 */
export async function createCustomerRequest({
  businessId,
  callId,
  requestType,
  callerName,
  callbackNumber,
  message,
  preferredTime,
  notes,
}) {
  if (!pool) return null;
  const res = await q(
    `INSERT INTO customer_requests
       (business_id, call_id, request_type, caller_name, callback_number, message, preferred_time, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      businessId,
      callId || null,
      requestType || "message",
      callerName || null,
      callbackNumber || null,
      message || null,
      preferredTime || null,
      notes || null,
    ]
  );
  if (res.error) {
    log.error("db_error", { operation: "createCustomerRequest", error: res.error.message });
    captureException(new Error(res.error.message), { table: "customer_requests", op: "insert" });
    return null;
  }
  const requestId = one(res).id;
  noteAccess("createCustomerRequest", { resourceIds: [requestId], rowCount: 1 });
  return requestId;
}

/**
 * The customer requests one call has already filed, of one type, newest first.
 *
 * Round A1 S3 (I3): what a same-call correction is matched against
 * (lib/capabilities/customerRequests.js). Same rule as
 * listAppointmentsByCallId: a call UUID is not a secret, so the business is
 * required and in the WHERE as well as in the RLS scope.
 *
 * @param {string} callId - calls.id
 * @param {string} businessId - REQUIRED
 * @param {string} requestType
 * @returns {Promise<Array<{id: string, caller_name: string|null, callback_number: string|null, message: string|null, preferred_time: string|null}>|null>}
 */
export async function listCallCustomerRequests(callId, businessId, requestType) {
  if (!pool || !callId) return null;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "listCallCustomerRequests" });
    return null;
  }
  const res = await q(
    `SELECT id, caller_name, callback_number, message, preferred_time
       FROM customer_requests
      WHERE call_id = $1 AND business_id = $2 AND request_type = $3
      ORDER BY created_at DESC, id DESC`,
    [callId, businessId, requestType || "message"]
  );
  if (res.error) {
    log.error("db_error", { operation: "listCallCustomerRequests", error: res.error.message });
    return null;
  }
  const list = res.rows || [];
  noteAccess("listCallCustomerRequests", { resourceIds: list.map((r) => r.id), rowCount: list.length });
  return list;
}

/**
 * Apply a same-call correction to the customer request it corrects.
 *
 * A field the correction leaves out keeps its value: a re-record that names
 * only the fixed number must not blank the message. Returns null when no row
 * changed -- under FORCE RLS an unscoped UPDATE matches nothing and reports no
 * error, so the row count is the only evidence it landed.
 *
 * @param {{ id: string, businessId: string, callerName?: string|null, callbackNumber?: string|null, message?: string|null, preferredTime?: string|null }} params
 * @returns {Promise<string|null>} the row id, or null
 */
export async function updateCustomerRequest({ id, businessId, callerName, callbackNumber, message, preferredTime }) {
  if (!pool || !id) return null;
  if (!businessId) {
    log.error("db_unscoped_query_refused", { operation: "updateCustomerRequest" });
    return null;
  }
  const res = await q(
    `UPDATE customer_requests
        SET caller_name = COALESCE($3, caller_name),
            callback_number = COALESCE($4, callback_number),
            message = COALESCE($5, message),
            preferred_time = COALESCE($6, preferred_time)
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [id, businessId, callerName || null, callbackNumber || null, message || null, preferredTime || null]
  );
  if (res.error) {
    log.error("db_error", { operation: "updateCustomerRequest", error: res.error.message });
    captureException(new Error(res.error.message), { table: "customer_requests", op: "update" });
    return null;
  }
  const row = one(res);
  if (!row) return null;
  noteAccess("updateCustomerRequest", { resourceIds: [row.id], rowCount: 1 });
  return row.id;
}

// ---------------------------------------------------------------------------
// Caller-facing SMS consent (migration 037, ledger O25)
// ---------------------------------------------------------------------------
// The store behind the gate in services/notifications.js. Two functions, and
// the asymmetry between them is the design:
//
//   recordSmsConsent   appends an answer. A refusal is an answer too, and a
//                      later one supersedes an earlier one, so revocation needs
//                      no second function and no UPDATE.
//   latestSmsConsent   reads the current state. Exactly one row, ordered by
//                      time, exact match on the number.
//
// Both are tenant-scoped like everything else here, which means both must run
// inside a withTenant scope on Cloud SQL — an unscoped read under FORCE row
// level security returns ZERO ROWS rather than an error, and zero rows here
// reads as "this caller never consented". That failure is silent, indistinguishable
// from an honest refusal, and fails in the safe direction, which is the only
// reason it is survivable.
// ---------------------------------------------------------------------------

/**
 * Record a caller's answer to the SMS consent question.
 *
 * @param {object} params
 * @param {string} params.businessId
 * @param {string|null} [params.callId] - the call the answer was given on
 * @param {string} params.phoneNumber - E.164; normalised here, not by the caller
 * @param {boolean} params.granted - false records a refusal or a revocation
 * @param {string} params.script - the disclosure the receptionist was required to give
 * @param {string} params.scriptVersion
 * @returns {Promise<string|null>} the new row id, or null if it could not be written
 */
export async function recordSmsConsent({
  businessId,
  callId = null,
  phoneNumber,
  granted,
  script,
  scriptVersion,
}) {
  if (!pool || !businessId || !phoneNumber) return null;
  // Normalised on the way in AND on the way out (latestSmsConsent), so the gate
  // compares like with like. The alternative — a suffix match, as
  // exportCallerData uses — is deliberately loose, and loose on a consent gate
  // means texting somebody who never agreed.
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;

  const res = await q(
    `INSERT INTO sms_consents
       (business_id, call_id, phone_number, granted, script, script_version, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'voice') RETURNING id`,
    [businessId, callId || null, normalized, !!granted, script, scriptVersion]
  );
  if (res.error) {
    log.error("db_error", { operation: "recordSmsConsent", error: res.error.message });
    captureException(new Error(res.error.message), { table: "sms_consents", op: "insert" });
    return null;
  }
  const consentId = one(res).id;
  noteAccess("recordSmsConsent", { resourceIds: [consentId], rowCount: 1 });
  return consentId;
}

/**
 * The current SMS-consent state for one number, for one tenant.
 *
 * Returns null when nothing has ever been recorded — which the gate must treat
 * exactly as it treats a refusal. "No answer" and "no" are different facts and
 * the same decision.
 *
 * @param {string} businessId
 * @param {string} phoneNumber
 * @returns {Promise<{ id: string, granted: boolean, script: string, script_version: string, created_at: string }|null>}
 */
export async function latestSmsConsent(businessId, phoneNumber) {
  if (!pool || !businessId || !phoneNumber) return null;
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;

  const res = await q(
    `SELECT id, granted, script, script_version, created_at
       FROM sms_consents
      WHERE business_id = $1 AND phone_number = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [businessId, normalized]
  );
  if (res.error) {
    log.error("db_error", { operation: "latestSmsConsent", error: res.error.message });
    // NOT a null-because-nothing-found. The caller cannot tell these apart from
    // the return value alone, which is why the gate treats every falsy answer
    // as "do not send" rather than branching on the reason.
    return null;
  }
  const row = one(res);
  noteAccess("latestSmsConsent", { resourceIds: row ? [row.id] : [], rowCount: row ? 1 : 0 });
  return row;
}

/**
 * Fetch caller context for personalization — recent call history and upcoming appointments.
 * Used to inject "returning caller" context into the AI prompt and to power
 * the dashboard caller profile view.
 * @param {string} businessId
 * @param {string} callerNumber - Caller's phone number (E.164)
 * @returns {Promise<{ callCount: number, lastCallSummary: string|null, upcomingAppointments: Array }>}
 */
export async function fetchCallerContext(businessId, callerNumber) {
  // snapshotMissing (Round A1 Part 6 re-review): nothing was looked up -- a
  // withheld number or no database -- so the caller's bookings are unknown,
  // not none (capabilities/appointments.js bookingsFitting).
  const empty = { callCount: 0, lastCallSummary: null, upcomingAppointments: [], snapshotMissing: true };
  // A withheld number arrives as a shared placeholder (lib/inboundGuards.js),
  // not empty: looked up, every withheld caller would read as one returning
  // caller, with another caller's last-call summary (opus re-review, Part 6).
  if (!pool || !businessId || !callerNumber || !isRealCallerNumber(callerNumber)) return empty;

  // Run both queries in parallel
  const [callsResult, apptRows] = await Promise.all([
    q(
      `SELECT id, started_at, summary FROM calls
        WHERE business_id = $1 AND caller_number = $2 AND status = 'completed'
        ORDER BY started_at DESC LIMIT 5`,
      [businessId, callerNumber]
    ),
    // The SAME function the get_caller_appointments_from_db tool calls, so the
    // prompt's "Upcoming appointments" line and the tool can no longer disagree
    // about whether this caller has one at all.
    //
    // This used to be an exact string equality on client_phone while the tool
    // matched the last ten digits. Any row not stored in the caller's exact
    // E.164 spelling was therefore invisible to the prompt and findable by the
    // tool, and migration 026 cannot close that gap on its own: it normalizes
    // punctuation and whitespace but deliberately will not guess a country
    // code, so a national number stays national.
    listAppointmentsByCaller(businessId, { clientPhone: callerNumber, upcomingOnly: true, nullOnError: true }),
  ]);
  // A failed lookup is unknown, not "no bookings" (Round A1 Part 6 re-review):
  // q() never throws, it returns {error}, and the list used to come back [].
  const lookupFailed = Boolean(callsResult.error) || apptRows === null;

  const calls = callsResult.rows || [];
  const lastCallSummary = calls[0]?.summary || null;

  // Explicit projection, not the raw row. listAppointmentsByCaller selects
  // client_phone, and this result reaches BOTH the prompt builder and an HTTP
  // response — neither has any use for it.
  const upcomingAppointments = (apptRows || []).slice(0, 5).map((a) => ({
    id: a.id,
    client_name: a.client_name,
    scheduled_at: a.scheduled_at,
    notes: a.notes,
  }));

  // The nested listAppointmentsByCaller records its own access, so the unit of
  // work's row names both operations. That is the intent: one row per unit of
  // work, and the operations array is what shows how the disclosure was built.
  noteAccess("fetchCallerContext", {
    resourceIds: calls.map((c) => c.id),
    rowCount: calls.length + upcomingAppointments.length,
  });
  // Round A1 part 4, G2: every upcoming booking counted, not only the five
  // listed -- "You have 7 upcoming appointments" must be the real number. The
  // OVERFLOW is stored, not the total: consumers add it to the live list, which
  // a booking or cancellation this call changes (review M6).
  const upcomingOverflow = Math.max(0, (apptRows || []).length - upcomingAppointments.length);
  // Round A1 Part 6: the rows past the five, never rendered. A move question
  // naming only a DAY counts when that person has one booking that day
  // (capabilities/appointments.js bookingsFitting), and a sixth booking on
  // that day must be seen. No notes: nothing here reads them.
  const upcomingBeyond = (apptRows || []).slice(5).map((a) => ({
    id: a.id,
    client_name: a.client_name,
    scheduled_at: a.scheduled_at,
  }));
  return {
    callCount: calls.length,
    lastCallSummary,
    upcomingAppointments,
    upcomingOverflow,
    upcomingBeyond,
    ...(lookupFailed ? { snapshotMissing: true } : {}),
  };
}

/**
 * Fetch enabled business_knowledge entries for a business, ordered by priority DESC.
 * @param {string} businessId
 * @param {number} [limit=15] - Max entries to return
 * @returns {Promise<Array<{question: string, answer: string, category: string|null}>>}
 */
export async function fetchBusinessKnowledge(businessId, limit = 15) {
  if (!pool) return [];
  const res = await q(
    `SELECT question, answer, category FROM business_knowledge
      WHERE business_id = $1 AND enabled = true
      ORDER BY priority DESC LIMIT $2`,
    [businessId, limit]
  );
  if (res.error) {
    log.error("db_error", { operation: "fetchBusinessKnowledge", error: res.error.message });
    return [];
  }
  return res.rows || [];
}

// ---------------------------------------------------------------------------
// Integrations (per-business: webhooks, athenahealth, mcp)
// ---------------------------------------------------------------------------

/**
 * Tool names an integration may not claim.
 *
 * Derived from the capability registry rather than hand-listed. The hand-listed
 * version reserved four names while capability packs declared twelve, so a
 * business could create a webhook called request_transfer, cancel_appointment_db
 * or get_caller_appointments and have it silently shadowed: the declaration
 * reached Gemini twice and services/tools.js dispatched the builtin, so the
 * operator's webhook never ran and never errored.
 *
 * Deriving it means the reservation list can no longer drift behind the packs —
 * a new capability's tools are protected the moment the pack is registered.
 *
 * set_call_intent, end_call, confirm_identity and wait_on_hold are engine-owned
 * (they drive the step machine itself, the outbound party's verification state,
 * or the outbound hold state -- not any capability) so they are named explicitly.
 */
export const BUILTIN_TOOL_NAMES = [
  "set_call_intent",
  "end_call",
  "confirm_identity",
  "wait_on_hold",
  ...allCapabilityToolNames(),
];

/**
 * List all integrations for a business.
 * @param {string} businessId
 * @param {{ enabledOnly?: boolean }} [opts]
 * @returns {Promise<Array<{ id: string, business_id: string, provider: string, name: string, enabled: boolean, config: object, created_at: string, updated_at: string }>>}
 */
export async function listIntegrationsForBusiness(businessId, opts = {}) {
  if (!pool || !businessId) return [];
  const res = await q(
    `SELECT * FROM integrations
      WHERE business_id = $1${opts.enabledOnly ? " AND enabled = true" : ""}
      ORDER BY created_at ASC`,
    [businessId]
  );
  if (res.error) {
    log.error("db_error", { operation: "listIntegrationsForBusiness", error: res.error.message });
    return [];
  }
  return res.rows || [];
}

/**
 * Get a single integration by business and tool name.
 * @param {string} businessId
 * @param {string} name - Tool name
 * @returns {Promise<{ id: string, business_id: string, provider: string, name: string, enabled: boolean, config: object } | null>}
 */
export async function getIntegrationByName(businessId, name) {
  if (!pool || !businessId || !name) return null;
  const res = await q(`SELECT * FROM integrations WHERE business_id = $1 AND name = $2`, [businessId, name]);
  if (res.error) {
    log.error("db_error", { operation: "getIntegrationByName", error: res.error.message });
    return null;
  }
  return one(res);
}

/**
 * Create or update an integration (upsert by business_id + name).
 * @param {object} params
 * @param {string} params.businessId
 * @param {string} params.provider - webhook | athenahealth | mcp
 * @param {string} params.name - Tool name (must not be a built-in tool name)
 * @param {object} params.config
 * @param {boolean} [params.enabled=true]
 * @returns {Promise<{ id: string } | null>}
 */
export async function createOrUpdateIntegration({
  businessId,
  provider,
  name,
  config,
  enabled = true,
}) {
  if (!pool || !businessId || !provider || !name) return null;
  if (BUILTIN_TOOL_NAMES.includes(name)) {
    log.error("integration_invalid_name", { name, reason: "built_in_tool" });
    return null;
  }
  // ON CONFLICT deliberately does NOT touch baa_recorded_at or baa_reference
  // (migration 027). Editing a webhook's URL must not silently carry its old
  // BAA record forward onto a new endpoint — but it must not wipe the record
  // for an unrelated config tweak either, so the columns are simply left alone
  // and managed by whatever records the agreement.
  const res = await q(
    `INSERT INTO integrations (business_id, provider, name, config, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (business_id, name) DO UPDATE
       SET provider = EXCLUDED.provider,
           config = EXCLUDED.config,
           enabled = EXCLUDED.enabled,
           updated_at = now()
     RETURNING id`,
    [businessId, provider, name, config || {}, !!enabled]
  );
  if (res.error) {
    log.error("db_error", { operation: "createOrUpdateIntegration", error: res.error.message });
    return null;
  }
  return one(res);
}

/**
 * Delete or soft-disable an integration.
 * @param {string} businessId
 * @param {string} integrationId
 * @param {{ softDisable?: boolean }} [opts] - If true, set enabled=false instead of delete
 * @returns {Promise<boolean>}
 */
export async function deleteIntegration(businessId, integrationId, opts = {}) {
  if (!pool || !businessId || !integrationId) return false;
  if (opts.softDisable) {
    const res = await q(
      `UPDATE integrations SET enabled = false, updated_at = now() WHERE id = $1 AND business_id = $2`,
      [integrationId, businessId]
    );
    if (res.error) {
      log.error("db_error", { operation: "deleteIntegration_softDisable", error: res.error.message });
      return false;
    }
    return true;
  }
  const res = await q(`DELETE FROM integrations WHERE id = $1 AND business_id = $2`, [integrationId, businessId]);
  if (res.error) {
    log.error("db_error", { operation: "deleteIntegration", error: res.error.message });
    return false;
  }
  return true;
}


// ---------------------------------------------------------------------------
// Data-subject requests (UK GDPR Art. 15 access, Art. 17 erasure)
// ---------------------------------------------------------------------------
//
// Caller-level, because a caller is the data subject. Every one of these
// matches a phone number the SAME way listAppointmentsByCaller does — the last
// ten digits, compared after stripping non-digits.
//
// That is not a stylistic choice. The system stores the same person's number in
// several spellings: E.164 from Twilio, whatever a member of staff typed into
// the dashboard, whatever migration 026 could normalise without guessing a
// country code. An export that matched exactly would return a subset and call
// it complete, and an erasure that matched exactly would leave rows behind and
// report success. Both are worse than not offering the feature at all.
//
// The rule lives in one place so export and erasure cannot drift apart. If they
// drift, erasure silently misses exactly the rows export promised were there.

/** Last ten digits of `col`, ignoring punctuation — the match rule, once. */
function phoneMatch(col, param) {
  const digits = (expr) => `regexp_replace(coalesce(${expr}, ''), '[^0-9]', '', 'g')`;
  return `right(${digits(col)}, 10) = right(${digits("$" + param)}, 10)`;
}

/**
 * S3-11 (spec §13.5 amendment): HMAC-SHA256(SUPPRESSION_HASH_KEY, the
 * canonical E.164 phone), hex. The ONE place this is computed, because
 * eraseCallerData (write, below) and isSuppressed (read, gate check 4) must
 * derive the identical digest for the identical number or a suppression that
 * survives erasure silently stops protecting anyone (named risk 2).
 *
 * THROWS on a missing or too-short key, deliberately (Ruling S3-11b, memory
 * plan-verbatim-code-fails-open): a do-not-call check that cannot compute a
 * trustworthy hash must never read as "not suppressed", and an erasure that
 * cannot compute one must never silently drop the phone without it. Callers
 * are: isSuppressed (the gate fails the whole dispatch closed -- Cloud Tasks
 * retries, never dials) and eraseCallerData (the whole erasure transaction
 * rolls back before any write, via the same throw-and-rollback path every
 * other failure in that function already takes).
 *
 * 32 is a floor, not a real strength check -- it rejects an obviously-unset
 * placeholder ("x", "test") while accepting any real secret. Generate the
 * real value with `openssl rand -base64 32` (44 chars); see .env.example.
 *
 * @param {string} canonicalE164
 * @returns {string} 64 hex characters
 */
function suppressionHash(canonicalE164) {
  const key = process.env.SUPPRESSION_HASH_KEY || "";
  if (key.length < 32) {
    throw new Error(
      "suppressionHash: SUPPRESSION_HASH_KEY is missing or too short (need >= 32 characters) -- " +
        "refusing rather than silently skipping the do-not-call hash check"
    );
  }
  return createHmac("sha256", key).update(canonicalE164).digest("hex");
}

/**
 * Every PHI-bearing row this system holds about one caller, for one tenant.
 *
 * Tenant-scoped unconditionally. A phone number is not a secret and neither is
 * a business UUID, so an unscoped export would be a cross-tenant read dressed
 * up as a compliance feature.
 *
 * @param {string} businessId
 * @param {string} phone
 * @returns {Promise<{calls: Array, transcripts: Array, appointments: Array, customerRequests: Array, smsConsents: Array, contacts: Array, consents: Array, outreach: Array, callAttempts: Array, suppressions: Array, outbox: Array}|null>}
 */
/**
 * The recording URLs this tenant holds for one caller.
 *
 * Exists because an Art. 17 erasure has to reach Twilio, and this column is the
 * only index of what Twilio holds. server.js's degraded voicemail path files
 * `Voicemail recording: <url>` into `customer_requests.message`, and that
 * message is also what A5's erasure NULLs — so the pointer has to be read
 * BEFORE the rows are cleared, or there is nothing left to delete with.
 *
 * Narrow on purpose rather than reusing exportCallerData: an erasure should not
 * have to pull every transcript a caller ever produced in order to find two
 * URLs.
 *
 * @param {string} businessId
 * @param {string} phone
 * @returns {Promise<string[]|null>} message bodies that may contain a URL, or null on error
 */
export async function listCallerRecordingMessages(businessId, phone) {
  if (!pool || !businessId || !phone) return null;
  const res = await q(
    `SELECT id, message FROM customer_requests
      WHERE business_id = $1 AND ${phoneMatch("callback_number", 2)}
        AND message IS NOT NULL`,
    [businessId, phone]
  );
  if (res.error) {
    log.error("db_error", { operation: "listCallerRecordingMessages", error: res.error.message });
    return null;
  }
  noteAccess("listCallerRecordingMessages", {
    resourceIds: res.rows.map((r) => r.id),
    rowCount: res.rows.length,
  });
  return res.rows.map((r) => r.message);
}

export async function exportCallerData(businessId, phone) {
  if (!pool || !businessId || !phone) return null;

  const calls = await q(
    `SELECT id, twilio_call_sid, caller_number, twilio_number, status, started_at, ended_at,
            duration_seconds, summary, sentiment, outcome,
            direction, campaign_id, campaign_version, outreach_id, attempt_id, contact_id,
            answered_by, outcome_code, answers, transferred_at
       FROM calls
      WHERE business_id = $1 AND ${phoneMatch("caller_number", 2)}
      ORDER BY started_at ASC`,
    [businessId, phone]
  );
  if (calls.error) {
    log.error("db_error", { operation: "exportCallerData.calls", error: calls.error.message });
    return null;
  }

  // Transcripts hang off calls, so they are reached through the ids just found
  // rather than by matching a phone number they do not carry. This is the
  // join-away table the RLS negative tests single out, for the same reason: it
  // is where a hand-written filter gets forgotten.
  const callIds = calls.rows.map((c) => c.id);
  const transcripts = callIds.length
    ? await q(
        `SELECT call_id, speaker, message, sequence, created_at
           FROM call_transcripts WHERE call_id = ANY($1) ORDER BY call_id, sequence`,
        [callIds]
      )
    : { rows: [] };
  if (transcripts.error) {
    log.error("db_error", { operation: "exportCallerData.transcripts", error: transcripts.error.message });
    return null;
  }

  const appointments = await q(
    `SELECT id, client_name, client_phone, scheduled_at, status, notes, created_at
       FROM appointments
      WHERE business_id = $1 AND ${phoneMatch("client_phone", 2)}
      ORDER BY scheduled_at ASC`,
    [businessId, phone]
  );
  if (appointments.error) {
    log.error("db_error", { operation: "exportCallerData.appointments", error: appointments.error.message });
    return null;
  }

  const requests = await q(
    `SELECT id, request_type, caller_name, callback_number, message, preferred_time, notes, created_at
       FROM customer_requests
      WHERE business_id = $1 AND ${phoneMatch("callback_number", 2)}
      ORDER BY created_at ASC`,
    [businessId, phone]
  );
  if (requests.error) {
    log.error("db_error", { operation: "exportCallerData.requests", error: requests.error.message });
    return null;
  }

  // Migration 037. A consent record is a phone number plus a decision the data
  // subject made, so it is theirs to receive. The suffix match is right here for
  // the same reason it is wrong in the gate: an export answers "everything you
  // hold about me", and missing a row because it was stored in a different
  // format would be the failure.
  const consents = await q(
    `SELECT id, call_id, phone_number, granted, script, script_version, source, created_at
       FROM sms_consents
      WHERE business_id = $1 AND ${phoneMatch("phone_number", 2)}
      ORDER BY created_at ASC`,
    [businessId, phone]
  );
  if (consents.error) {
    log.error("db_error", { operation: "exportCallerData.smsConsents", error: consents.error.message });
    return null;
  }

  // ---- Outbound calling tables (S4-3). Mirrors eraseCallerData's coverage:
  // whatever erasure touches, the data subject can receive first. Each query
  // is tenant-scoped by business_id (and by RLS under withTenant), and uses
  // the same phoneMatch rule as the erasure.
  const contacts = await q(
    `SELECT id, phone_e164, first_name, last_name, email, timezone, external_ids, attributes,
            created_at, updated_at
       FROM contacts
      WHERE business_id = $1 AND ${phoneMatch("phone_e164", 2)}
      ORDER BY created_at ASC`,
    [businessId, phone]
  );
  if (contacts.error) {
    log.error("db_error", { operation: "exportCallerData.contacts", error: contacts.error.message });
    return null;
  }
  const contactIds = contacts.rows.map((c) => c.id);

  const outboundConsents = contactIds.length
    ? await q(
        `SELECT id, contact_id, purpose, channels, covers_automated, source, source_ref,
                wording_version, wording_text, captured_at, expires_at, revoked_at
           FROM consents WHERE business_id = $1 AND contact_id = ANY($2) ORDER BY captured_at ASC`,
        [businessId, contactIds]
      )
    : { rows: [] };
  if (outboundConsents.error) {
    log.error("db_error", { operation: "exportCallerData.consents", error: outboundConsents.error.message });
    return null;
  }

  const outreach = contactIds.length
    ? await q(
        `SELECT id, campaign_id, campaign_version, contact_id, state, attempts_made,
                next_attempt_at, last_attempt_at, hold_until, outcome, close_reason,
                trigger, details, created_at, updated_at, closed_at
           FROM outreach WHERE business_id = $1 AND contact_id = ANY($2) ORDER BY created_at ASC`,
        [businessId, contactIds]
      )
    : { rows: [] };
  if (outreach.error) {
    log.error("db_error", { operation: "exportCallerData.outreach", error: outreach.error.message });
    return null;
  }

  // Metadata only. opener_audio / voicemail_audio / transfer_miss_audio are
  // synthesized speech blobs (the agent's own script), never the subject's
  // voice, and are not exported.
  const callAttempts = await q(
    `SELECT id, outreach_id, attempt_no, twilio_call_sid, from_number, to_number, dialed_at,
            answered_at, ended_at, twilio_status, answered_by, amd_duration_ms, first_audio_ms,
            silent, result, call_id, status_completed_at, session_finished_at,
            post_call_started_at, created_at
       FROM call_attempts
      WHERE business_id = $1 AND ${phoneMatch("to_number", 2)}
      ORDER BY created_at ASC`,
    [businessId, phone]
  );
  if (callAttempts.error) {
    log.error("db_error", { operation: "exportCallerData.callAttempts", error: callAttempts.error.message });
    return null;
  }

  // A suppression outlives erasure as an HMAC hash (spec 13.5), so an erased
  // subject's row is found by hash. The key is only required when a hashed row
  // exists to be found -- the same narrowness as eraseCallerData -- and then a
  // missing key / un-normalizable phone THROWS: an export that silently omits
  // the do-not-call record is incomplete while reporting success.
  const hashed = await q(
    `SELECT 1 FROM suppressions WHERE business_id = $1 AND phone_hash IS NOT NULL LIMIT 1`,
    [businessId]
  );
  if (hashed.error) {
    log.error("db_error", { operation: "exportCallerData.suppressionsProbe", error: hashed.error.message });
    return null;
  }
  let phoneHash = null;
  if (hashed.rows.length) {
    const canonicalPhone = normalizePhoneNumber(phone);
    if (!canonicalPhone) {
      throw new Error(
        "exportCallerData: cannot match erased suppressions — the phone does not normalize to E.164"
      );
    }
    phoneHash = suppressionHash(canonicalPhone); // throws if the key is missing/short
  }
  const suppressions = await q(
    `SELECT id, phone_e164, phone_hash, reason, source_call_id, created_by, created_at
       FROM suppressions
      WHERE business_id = $1
        AND ((phone_e164 IS NOT NULL AND ${phoneMatch("phone_e164", 2)}) OR ($3::text IS NOT NULL AND phone_hash = $3))
      ORDER BY created_at ASC`,
    [businessId, phone, phoneHash]
  );
  if (suppressions.error) {
    log.error("db_error", { operation: "exportCallerData.suppressions", error: suppressions.error.message });
    return null;
  }

  // Results-channel deliveries: a frozen copy of the contact's details lives in
  // outbox.payload, keyed only by payload.contact.id (no relational column).
  const outbox = contactIds.length
    ? await q(
        `SELECT id, kind, event_type, payload, status, attempts, next_attempt_at, last_error,
                created_at, delivered_at
           FROM outbox
          WHERE business_id = $1 AND payload->'contact'->>'id' = ANY($2)
          ORDER BY created_at ASC`,
        [businessId, contactIds]
      )
    : { rows: [] };
  if (outbox.error) {
    log.error("db_error", { operation: "exportCallerData.outbox", error: outbox.error.message });
    return null;
  }

  noteAccess("exportCallerData", {
    resourceIds: [...calls.rows.map((c) => c.id), ...contactIds, ...suppressions.rows.map((r) => r.id)],
    rowCount:
      calls.rows.length +
      transcripts.rows.length +
      appointments.rows.length +
      requests.rows.length +
      consents.rows.length +
      contacts.rows.length +
      outboundConsents.rows.length +
      outreach.rows.length +
      callAttempts.rows.length +
      suppressions.rows.length +
      outbox.rows.length,
  });

  return {
    calls: calls.rows,
    transcripts: transcripts.rows,
    appointments: appointments.rows,
    customerRequests: requests.rows,
    smsConsents: consents.rows,
    contacts: contacts.rows,
    consents: outboundConsents.rows,
    outreach: outreach.rows,
    callAttempts: callAttempts.rows,
    suppressions: suppressions.rows,
    outbox: outbox.rows,
  };
}

/**
 * Erase a caller's personal data, keeping the non-identifying skeleton.
 *
 * WHAT THIS DOES, AND WHY IT IS NOT `DELETE FROM calls`:
 *
 *   call_transcripts  DELETED outright. A transcript is nothing but the data
 *                     subject's own words; there is no non-personal residue
 *                     worth keeping.
 *   calls             KEPT, with caller_number and summary nulled. The row is
 *                     also a business record — how many calls happened, how
 *                     long they ran, what they cost. Deleting it erases the
 *                     controller's own accounting along with the personal
 *                     data, which Art. 17 does not ask for.
 *   appointments      KEPT, with client_name, client_phone and notes nulled.
 *                     Same reasoning: the slot was occupied, and that fact
 *                     belongs to the clinic.
 *   customer_requests KEPT, with every free-text and identifying field nulled.
 *   sms_consents      DELETED outright (migration 037). The row is a phone
 *                     number and a decision about that phone number; null out
 *                     the number and nothing meaningful is left, so there is no
 *                     non-personal residue to keep. Deleting it also fails the
 *                     SMS gate closed for that number afterwards, which is the
 *                     right end state for somebody who asked to be forgotten.
 *                     THE COST, recorded rather than hidden: it destroys the
 *                     evidence that the caller consented to texts already sent.
 *                     Flagged to counsel in the ledger (O18) — an erasure right
 *                     and a records-of-consent obligation genuinely point in
 *                     opposite directions here, and that is not a developer's
 *                     call to make.
 *
 * P5 (S3-11, spec §13.5): outbound calling's own tables, on the SAME
 * businessId+phone this function already erases.
 *
 *   consents          DELETED outright, for every contact this phone matches.
 *                     A consent row IS the decision plus the number it was
 *                     given about; nulling it out leaves nothing.
 *   contacts          KEPT, first_name and attributes nulled. `phone_e164`
 *                     itself is left alone — it is the row's own key
 *                     (UNIQUE(business_id, phone_e164)) and is not in this
 *                     task's scope; only first_name and attributes were
 *                     named (the first name is what the pre-rendered opener
 *                     clips speak).
 *   outreach          KEPT, every row not already `closed` is closed with
 *                     `close_reason = 'erased'`. Same reasoning as `calls`
 *                     above: the campaign contact attempt happened and is the
 *                     controller's own record, not personal data by itself.
 *   call_attempts     KEPT, `opener_audio`/`voicemail_audio`/
 *                     `transfer_miss_audio` nulled (parked from S3-4: the
 *                     rendered clip speaks the contact's own first name).
 *   outbox            (S3-8 fix round 1, I4, controller ruling) `payload`
 *                     carries a FROZEN COPY of the contact's phone, first
 *                     name and answers (lib/outbound/postCall.js's
 *                     buildResultsPayload) — not reached by the contacts
 *                     row above. A `pending`/`dead` row is DELETED outright
 *                     (also removes its outbox_schedule routing row, via
 *                     migration 050's trigger) — the delivery either never
 *                     happened or gave up, so there is nothing to keep and
 *                     the row must never be delivered after this point. A
 *                     `delivered` row is KEPT (the delivery is the
 *                     controller's own record that it happened, same
 *                     reasoning as `calls`/`outreach`), with its
 *                     `payload.contact`/`answers`/`summary` redacted to a
 *                     non-personal stub.
 *   suppressions      KEPT UNCONDITIONALLY, unlike every table above — a
 *                     do-not-call decision must outlive the person who is the
 *                     reason for it, or an erasure would silently readmit
 *                     them to the dialler. `phone_e164` is replaced with
 *                     `phone_hash` (HMAC-SHA256(SUPPRESSION_HASH_KEY, the
 *                     canonical E.164 phone) — see suppressionHash, above),
 *                     which `isSuppressed` also matches, so the do-not-call
 *                     check still refuses this number after erasure. Ruling
 *                     S3-11b: SUPPRESSION_HASH_KEY missing/short, OR the
 *                     phone not normalizing to a canonical E.164 form, throws
 *                     — but ONLY when a matching suppression row actually
 *                     exists to hash; an ordinary erasure with no outbound
 *                     history never needs the key at all (Ruling, this task's
 *                     report: this is narrower than "every erasure needs the
 *                     key", to avoid breaking DSAR erasure everywhere the key
 *                     has not yet been provisioned).
 *
 * ONE TRANSACTION, covering P5 too. A partial erasure is the worst outcome
 * available: it reports success, satisfies nobody, and leaves the controller
 * believing a request was honoured.
 *
 * ---------------------------------------------------------------------------
 * FLAGGED FOR COUNSEL (ledger O18), deliberately NOT decided in code:
 *
 * UK GDPR gives a right to erasure. HIPAA gives no such right, and a covered
 * entity has RETENTION obligations that can point the other way — Texas HB 300
 * is in scope for the first clinic. This function does not refuse in `hipaa`
 * mode, because refusing would be a legal judgement made by a developer, and
 * the two lanes are separate stacks precisely so that policy can differ per
 * lane. What it does instead is log every erasure with counts, so whatever
 * counsel decides has an audit trail to be applied to.
 * ---------------------------------------------------------------------------
 *
 * @param {string} businessId
 * @param {string} phone
 * @returns {Promise<{transcripts: number, calls: number, appointments: number, customerRequests: number, smsConsents: number, consents: number, contacts: number, outreach: number, callAttempts: number, outbox: number, outboxRedacted: number, suppressions: number}|null>}
 */
export async function eraseCallerData(businessId, phone) {
  if (!pool || !businessId || !phone) return null;

  // THE CONNECTION IS THE WHOLE CORRECTNESS ARGUMENT, and this used to get it
  // wrong in the silent direction.
  //
  // It called pool.connect() unconditionally, taking a FRESH connection while
  // the route had already wrapped it in withTenant. `SET LOCAL app.business_id`
  // lives on a connection, so the scope was set on one connection and the
  // erasure ran on another. As the unprivileged role every statement matches
  // zero rows — and this function returns a counts object, which is truthy, so
  // the DELETE route answered 200 {erased: {all zeros}}. An Art. 17 erasure
  // that erases nothing and reports success is worse than one that fails.
  //
  // Invisible because tests/db/dsr.test.js connects as the local superuser, for
  // whom RLS is inert. Cloud SQL grants no superuser, so B2 would have shipped
  // it. tests/db/rlsAppRole.test.js now pins it as the unprivileged role.
  const scoped = tenantContext.getStore()?.client;

  let client = scoped;
  if (!client) {
    try {
      client = await pool.connect();
    } catch (err) {
      log.error("db_error", { operation: "eraseCallerData.connect", error: err?.message });
      return null;
    }
  }

  try {
    // ONE TRANSACTION either way. Inside withTenant there already is one, and
    // issuing BEGIN inside it is a no-op warning while COMMIT would end the
    // CALLER's transaction early — committing half a unit of work and leaving
    // the rest unprotected. So the transaction is owned by whoever opened the
    // connection, and atomicity holds in both shapes.
    if (!scoped) await client.query("BEGIN");

    const { rows: callRows } = await client.query(
      `SELECT id FROM calls WHERE business_id = $1 AND ${phoneMatch("caller_number", 2)}`,
      [businessId, phone]
    );
    const callIds = callRows.map((r) => r.id);

    const t = callIds.length
      ? await client.query(`DELETE FROM call_transcripts WHERE call_id = ANY($1)`, [callIds])
      : { rowCount: 0 };

    // I3 (review, controller ruling): `answers` (S3-3/S3-10's qualification
    // pack -- the caller's own words, `_outcome_note` free text,
    // `callback_requested_at`) is a PII sink the pre-fix erasure never
    // touched at all.
    const c = callIds.length
      ? await client.query(`UPDATE calls SET caller_number = NULL, summary = NULL, answers = NULL WHERE id = ANY($1)`, [callIds])
      : { rowCount: 0 };

    const a = await client.query(
      `UPDATE appointments SET client_name = NULL, client_phone = NULL, notes = NULL
        WHERE business_id = $1 AND ${phoneMatch("client_phone", 2)}`,
      [businessId, phone]
    );

    const r = await client.query(
      `UPDATE customer_requests
          SET caller_name = NULL, callback_number = NULL, message = NULL,
              preferred_time = NULL, notes = NULL
        WHERE business_id = $1 AND ${phoneMatch("callback_number", 2)}`,
      [businessId, phone]
    );

    const sc = await client.query(
      `DELETE FROM sms_consents
        WHERE business_id = $1 AND ${phoneMatch("phone_number", 2)}`,
      [businessId, phone]
    );

    // P5 (S3-11, spec §13.5). Same phoneMatch rule as every table above, on
    // the outbound contact this phone corresponds to.
    const { rows: contactRows } = await client.query(
      `SELECT id FROM contacts WHERE business_id = $1 AND ${phoneMatch("phone_e164", 2)}`,
      [businessId, phone]
    );
    const contactIds = contactRows.map((row) => row.id);

    const co = contactIds.length
      ? await client.query(`DELETE FROM consents WHERE contact_id = ANY($1)`, [contactIds])
      : { rowCount: 0 };

    // I3 (review, controller ruling): last_name/email/external_ids/timezone
    // join first_name/attributes -- the ledger named last_name/email;
    // external_ids are CRM ids (S3-9's trigger upsert), and a contact's
    // timezone (resolved from a form's browser-detected value, S3-9) is
    // itself PII about where the person was when they filled in the form.
    // phone_e164 is deliberately NOT in this list -- see the file header
    // (OWNER decision, not changed here).
    const ct = contactIds.length
      ? await client.query(
          `UPDATE contacts
              SET first_name = NULL, last_name = NULL, email = NULL, timezone = NULL,
                  external_ids = '{}'::jsonb, attributes = '{}'::jsonb
            WHERE id = ANY($1)`,
          [contactIds]
        )
      : { rowCount: 0 };

    // I3 (review, controller ruling): widened on two axes from the pre-fix
    // version.
    //   1. `details` (S3-9's per-person facts from the lead form) and
    //      `trigger` (S3-9's `{source, data}` -- `data` is the WHOLE posted
    //      lead-form payload) are cleared on EVERY one of the contact's
    //      outreach rows, not just the ones this erasure is now closing.
    //      Plan P5 said "closes open outreach with erased and clears
    //      details" -- the code only ever did the first half, and never
    //      touched an ALREADY-closed row's details/trigger at all (S3-9
    //      shipped after S3-11, and nobody went back). `trigger` is reduced
    //      to `{source}`, not wiped to `{}` -- `source` (e.g. "webhook") is
    //      not personal, and losing it would make an already-thin audit
    //      trail (spec §13.5) thinner for no privacy gain.
    //   2. The state/close_reason/closed_at flip is now conditional (CASE),
    //      because the UPDATE itself no longer filters on `state <> 'closed'`
    //      -- an ALREADY-closed row must still get its details/trigger
    //      cleared, but must NOT have its own close_reason overwritten (the
    //      "leave an existing close_reason alone" rule the pre-fix WHERE
    //      clause enforced structurally; here it moves into the CASE).
    const oc = contactIds.length
      ? await client.query(
          `UPDATE outreach
              SET details = '{}'::jsonb,
                  trigger = jsonb_build_object('source', trigger->>'source'),
                  state = CASE WHEN state <> 'closed' THEN 'closed' ELSE state END,
                  close_reason = CASE WHEN state <> 'closed' THEN 'erased' ELSE close_reason END,
                  closed_at = CASE WHEN state <> 'closed' THEN now() ELSE closed_at END,
                  updated_at = now()
            WHERE business_id = $1 AND contact_id = ANY($2)`,
          [businessId, contactIds]
        )
      : { rowCount: 0 };

    const ca = await client.query(
      `UPDATE call_attempts SET opener_audio = NULL, voicemail_audio = NULL, transfer_miss_audio = NULL
        WHERE business_id = $1 AND ${phoneMatch("to_number", 2)}`,
      [businessId, phone]
    );

    // I4 (S3-8 fix round 1, controller ruling): `outbox.payload` carries a
    // COPY of the contact's phone, first name and answers, frozen at
    // post-call time (lib/outbound/postCall.js's buildResultsPayload) --
    // nulling contacts.first_name above does not touch it, and the review
    // found it was outside eraseCallerData's resources entirely. Matched by
    // contactIds (already resolved above, the same set outreach/contacts
    // use), via payload->'contact'->>'id' -- there is no relational
    // contact_id column on outbox, only the id embedded in its own JSON.
    //   pending/dead  DELETED outright (also removes the outbox_schedule
    //                 routing row, via the migration 050 trigger) -- Ruling:
    //                 "a pending row is never delivered" after erasure, and
    //                 a dead row has no further use once its subject is gone.
    //   delivered     KEPT (the delivery already happened and is the
    //                 controller's own record that it did, same reasoning as
    //                 `calls`/`outreach` above), payload's contact/answers/
    //                 summary redacted to a non-personal stub. `contact.id`
    //                 itself is kept -- it is an opaque reference to the
    //                 (still-existing, name-nulled) contacts row, not
    //                 personal data by itself, same rule contacts.id being
    //                 left alone already follows.
    const ob = contactIds.length
      ? await client.query(
          `DELETE FROM outbox WHERE business_id = $1 AND status IN ('pending','dead') AND payload->'contact'->>'id' = ANY($2)`,
          [businessId, contactIds]
        )
      : { rowCount: 0 };

    const obRedacted = contactIds.length
      ? await client.query(
          `UPDATE outbox
              SET payload = payload || jsonb_build_object(
                    'contact', jsonb_build_object(
                      'id', payload->'contact'->>'id',
                      'phone', NULL,
                      'first_name', NULL,
                      'external_ids', '{}'::jsonb
                    ),
                    'answers', '{}'::jsonb,
                    'summary', NULL
                  )
            WHERE business_id = $1 AND status = 'delivered' AND payload->'contact'->>'id' = ANY($2)`,
          [businessId, contactIds]
        )
      : { rowCount: 0 };

    // Spec §13.5: a suppression outlives erasure. KEEP the row, hash the
    // phone instead of nulling it away entirely — but only touch the key
    // (and require it) when there is actually a row to hash; see the
    // function doc above for why this is narrower than "every erasure needs
    // SUPPRESSION_HASH_KEY".
    const { rows: suppressionRows } = await client.query(
      `SELECT id FROM suppressions
        WHERE business_id = $1 AND phone_e164 IS NOT NULL AND ${phoneMatch("phone_e164", 2)}`,
      [businessId, phone]
    );
    let sup = { rowCount: 0 };
    if (suppressionRows.length) {
      // The canonical E.164 form, not the raw (possibly punctuated,
      // possibly national-format) input — isSuppressed hashes
      // contacts.phone_e164, which is always canonical, so hashing anything
      // else here would write a suppression that can never match again
      // (named risk 2). normalizePhoneNumber never guesses a country code,
      // so an ambiguous phone throws rather than writing an unusable hash.
      const canonicalPhone = normalizePhoneNumber(phone);
      if (!canonicalPhone) {
        throw new Error(
          "eraseCallerData: cannot compute a trustworthy suppression hash — the phone does not " +
            "normalize to E.164, and hashing a non-canonical form would silently stop protecting it"
        );
      }
      const hash = suppressionHash(canonicalPhone); // throws before any write if the key is missing/short
      sup = await client.query(
        `UPDATE suppressions SET phone_hash = $2, phone_e164 = NULL WHERE id = ANY($1)`,
        [suppressionRows.map((row) => row.id), hash]
      );
    }

    if (!scoped) await client.query("COMMIT");

    const counts = {
      transcripts: t.rowCount,
      calls: c.rowCount,
      appointments: a.rowCount,
      customerRequests: r.rowCount,
      smsConsents: sc.rowCount,
      consents: co.rowCount,
      contacts: ct.rowCount,
      outreach: oc.rowCount,
      callAttempts: ca.rowCount,
      outbox: ob.rowCount,
      outboxRedacted: obRedacted.rowCount,
      suppressions: sup.rowCount,
    };
    // The audit trail an erasure needs, carrying no phone number — the thing
    // being erased must not be written to a log in the act of erasing it.
    log.info("dsr_erasure_completed", { businessId, ...counts });
    noteAccess("eraseCallerData", {
      resourceIds: [...callIds, ...contactIds, ...suppressionRows.map((row) => row.id)],
      rowCount:
        t.rowCount + c.rowCount + a.rowCount + r.rowCount + sc.rowCount +
        co.rowCount + ct.rowCount + oc.rowCount + ca.rowCount + ob.rowCount + obRedacted.rowCount + sup.rowCount,
    });
    return counts;
  } catch (err) {
    log.error("db_error", { operation: "eraseCallerData", error: err?.message });
    captureException(new Error(err?.message), { table: "calls", op: "dsr_erase" });
    if (scoped) {
      // Inside withTenant: RETHROW rather than swallow. withTenant rolls back
      // and rethrows, and the route turns that into a 500 — which is the honest
      // answer. Returning null here would leave the caller's transaction open
      // and mid-erasure, and the route would report "Erasure failed" while the
      // partial work sat waiting to be committed by something else.
      throw err;
    }
    await client.query("ROLLBACK").catch(() => {});
    return null;
  } finally {
    // Only release what this function checked out. Releasing withTenant's
    // connection here would hand it back to the pool while withTenant is still
    // using it — a second borrower would join a stranger's open transaction.
    if (!scoped) client.release();
  }
}


// ---------------------------------------------------------------------------
// Tenant scoping (migration 029)
// ---------------------------------------------------------------------------
//
// Row-level security decides what a query can see from
// `current_setting('app.business_id')`. Something has to set it, and WHERE that
// happens is the design decision.
//
// NOT per function. Roughly eight of the exported functions are keyed by a
// Twilio call SID or an appointment id and never receive a business id —
// completeCall, markCallTransferred, updateCallSummary, addTranscriptEntry and
// the rest. Threading a tenant into all of them would change signatures A3
// deliberately kept byte-identical, and would still leave every future function
// one forgotten argument away from returning nothing.
//
// Per REQUEST, at the boundary where the tenant is already known and there are
// only a handful of places:
//
//   - the voice session, once the dialled number resolves to a business
//   - /twilio/status, which A4 gave the businessId through the shared store
//   - each authenticated dashboard request, from requireBusinessAccess
//
// `SET LOCAL` inside a transaction is what makes this safe on a POOLED
// connection. A session-level `set_config` would outlive the checkout and leak
// one tenant's scope into whatever request borrowed the connection next —
// which is a cross-tenant read produced by connection reuse, the hardest kind
// to reproduce and the easiest to ship.
//
// STILL TO DO, and it is B2's: the call sites. Nothing calls withTenant yet.
// Until they do, the application connects as a superuser and RLS is inert for
// it — see the migration header. Cloud SQL does NOT grant superuser, so at B2
// this stops being optional and starts being the thing that makes the app work
// at all.

/**
 * The scoped connection for the current async context.
 *
 * AsyncLocalStorage rather than an argument, because the thing that needs to
 * see it is `q()` — twenty-odd frames below whoever called withTenant, through
 * functions whose signatures A3 kept byte-identical on purpose.
 */
const tenantContext = new AsyncLocalStorage();

/**
 * Run `fn` with the database scoped to one tenant.
 *
 * Everything `fn` does — directly, or through any exported function it calls,
 * at any depth — runs on ONE connection inside ONE transaction with
 * `app.business_id` set. Row-level security (migration 029) does the rest.
 *
 * ---------------------------------------------------------------------------
 * WRAP A UNIT OF WORK. NEVER A CALL.
 * ---------------------------------------------------------------------------
 *
 * This holds a pooled connection and an open transaction for as long as `fn`
 * runs. A unit of work is a pickup, a turn's tool call, one HTTP handler —
 * milliseconds. A phone call is MINUTES, and wrapping one would pin a
 * connection and an idle transaction for its whole duration: at five
 * concurrent calls against a pool of ten that is half the pool asleep, plus
 * the vacuum problems an hours-old open transaction causes.
 *
 * If you find yourself wanting to wrap something long, wrap the individual
 * database units inside it instead.
 *
 * `SET LOCAL` (set_config with `true`) rather than a session-level setting, so
 * the scope is discarded by COMMIT or ROLLBACK — including when `fn` throws,
 * which is the case a manual reset would miss. A scope that outlived the
 * checkout would leak one tenant onto whatever request borrowed that
 * connection next: a cross-tenant read produced by connection reuse, which is
 * the hardest kind to reproduce and the easiest to ship.
 *
 * ---------------------------------------------------------------------------
 * IT IS ALSO THE AUDIT BOUNDARY (§164.312(b)).
 * ---------------------------------------------------------------------------
 *
 * The unit of work is the right grain for an audit record, and this is the only
 * place that knows where one begins and ends. `actor` says who is doing it —
 * pass it, because an audit trail that cannot name a unique actor satisfies
 * neither §164.312(b) nor §164.312(a)(2)(i). Omitting it is not an error, it
 * just records `system`, which is the honest answer for a background job.
 *
 * @template T
 * @param {string} businessId
 * @param {() => Promise<T>} fn
 * @param {{ actor?: { type?: "user"|"voice"|"system", id?: string|null }, requestId?: string|null, callSid?: string|null }} [opts]
 * @returns {Promise<T>}
 */
export async function withTenant(businessId, fn, opts = {}) {
  if (!pool) throw new Error("withTenant: no database configured");
  if (!businessId) throw new Error("withTenant: businessId is required");

  const audit = {
    operations: new Set(),
    resources: new Set(),
    resourceIds: [],
    rowCount: 0,
    action: null,
  };
  const actorType = opts.actor?.type ?? "system";
  const actorId = opts.actor?.id ?? null;
  let committed = false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const result = await tenantContext.run({ client, businessId, audit }, () => fn(client));

    // Inside the transaction, before COMMIT, on the connection that is already
    // scoped — so the row satisfies its own RLS policy and costs no extra
    // checkout. If this INSERT fails the whole unit of work rolls back, which
    // is the correct posture: an access that cannot be audited is one that
    // should not have happened. The voice paths run through withTenantSafe and
    // degrade rather than crash.
    await flushAudit(client, businessId, actorType, actorId, audit, opts);

    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    // The DURABLE copy, and the reason there are two destinations.
    //
    // Emitted in `finally`, so it survives a rollback that takes the table row
    // with it: an ATTEMPTED access is recorded even when no committed record of
    // it exists. On Cloud Run this goes to stdout, which the vetra-logging
    // project's sink (B0w) collects under different IAM — so a compromised
    // runtime can stop writing to the trail and cannot erase what it already
    // wrote.
    if (audit.action) {
      log.info("phi_access", {
        businessId,
        actorType,
        actorId,
        action: audit.action,
        operations: [...audit.operations],
        resources: [...audit.resources],
        rowCount: audit.rowCount,
        requestId: opts.requestId ?? null,
        callSid: opts.callSid ?? null,
        committed,
      });
    }
  }
}

/**
 * Write the unit of work's audit record, if it touched PHI at all.
 *
 * `audit.action` is null when nothing classified ran — a unit of work that only
 * read configuration writes no row, which is the difference between an audit
 * trail and a query log.
 */
async function flushAudit(client, businessId, actorType, actorId, audit, opts) {
  if (!audit.action) return;
  await client.query(
    `INSERT INTO phi_access_log
       (business_id, actor_type, actor_id, action, operations, resources, resource_ids, row_count, request_id, call_sid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      businessId,
      actorType,
      actorId,
      audit.action,
      [...audit.operations],
      [...audit.resources],
      audit.resourceIds,
      audit.rowCount,
      opts.requestId ?? null,
      opts.callSid ?? null,
    ]
  );
}

/**
 * Run `fn` scoped to a tenant, but never fail the caller because of it.
 *
 * For the paths where the database is not the point: a voice call must keep
 * answering when a write fails, and `/twilio/status` returning 500 makes Twilio
 * retry the callback. `withTenant` throws on a rollback; this logs and returns
 * `fallback`, matching what the individual data-layer functions already do.
 *
 * @template T
 * @param {string} businessId
 * @param {() => Promise<T>} fn
 * @param {{ operation: string, callSid?: string, fallback?: T, actor?: { type?: string, id?: string|null } }} opts
 */
export async function withTenantSafe(businessId, fn, { operation, callSid = null, fallback = null, actor = null } = {}) {
  // A call SID IS the actor on the voice path: it is the unique identifier of
  // the interaction the receptionist is acting within, and it resolves to a
  // person only through the database — the judgement lib/phiFields.js already
  // records for callSid. Defaulting it here means the four voice boundaries do
  // not each have to remember.
  const effectiveActor = actor ?? (callSid ? { type: "voice", id: callSid } : { type: "system", id: null });
  // NO DATABASE: run it anyway. `fallback` is for a scope that FAILED, not for
  // a scope that was never possible — and the two are not the same thing.
  //
  // Caught by tests/toolTimeout.test.js, which was right to fail. This wraps
  // the whole tool-call boundary, and plenty of tools never touch the database
  // at all: a webhook integration, set_call_intent, end_call. Returning a
  // failure here would have broken every one of them on any deployment without
  // DATABASE_URL set.
  if (!pool) {
    try {
      return await fn();
    } catch (err) {
      log.error("db_error", { operation, callSid, error: err?.message });
      return fallback;
    }
  }

  // NO TENANT: run it anyway, unscoped, and say so.
  //
  // The alternative — skip the work — would change behaviour today to solve a
  // problem that does not start until B2. Right now the application connects
  // as a superuser and RLS is inert for it, so a missing tenant costs nothing;
  // skipping would silently stop generating call summaries for any call whose
  // shared state lost its businessId.
  //
  // Once B2 moves this to Cloud SQL, where there is no superuser, the same code
  // FAILS CLOSED on its own: unscoped queries match no rows, the work produces
  // nothing, and the individual functions log their own errors. So this
  // degrades correctly rather than needing a second change later.
  //
  // The log line is the point. Unscoped work that nobody can see is how a
  // tenant boundary quietly stops being one.
  if (!businessId) {
    log.error("db_unscoped_fallback", { operation, callSid, severity: "warn" });
    try {
      return await fn();
    } catch (err) {
      log.error("db_error", { operation, callSid, error: err?.message });
      return fallback;
    }
  }

  try {
    return await withTenant(businessId, fn, { actor: effectiveActor, callSid });
  } catch (err) {
    log.error("db_error", { operation, callSid, error: err?.message });
    return fallback;
  }
}

/**
 * The tenant the current connection is scoped to, or null.
 *
 * Exists for tests and for a diagnostic: "which tenant does this connection
 * think it is" has no answer from the application side otherwise, and that is
 * a bad property for the mechanism the isolation rests on.
 *
 * @param {import("pg").PoolClient} [client]
 * @returns {Promise<string|null>}
 */
export async function currentTenant(client) {
  const runner = client ?? pool;
  if (!runner) return null;
  const res = await runner.query("SELECT app_current_business_id() AS id");
  return res.rows[0]?.id ?? null;
}

/**
 * Close the pool. Tests and short-lived scripts need this or the process hangs
 * on an open connection; the server never calls it.
 */
export async function close() {
  if (pool) await pool.end();
}

// --- outbound (spec §10) ---------------------------------------------------
//
// The dispatcher's data layer (lib/outbound/dispatch.js). Everything below is
// APPEND-ONLY: no inbound function above changes shape or behaviour.
//
// Three rules, the same for every function:
//   1. Throw on `res.error`. The dispatcher runs inside withTenant, which
//      rolls the whole unit of work back.
//   2. Assert rowCount on every UPDATE and DELETE. The service runs as
//      vetra_app NOBYPASSRLS, so a tenantless write matches zero rows and
//      reports success; here it throws instead.
//   3. A PHI function records itself with noteAccess (lib/phiAudit.js).
//
// And one for the tenant-scoped ones: they refuse to run outside withTenant.
// Under FORCE RLS an unscoped read returns NOTHING, and for isSuppressed and
// countDialsSince "nothing" is the permissive answer ("not on the do-not-call
// list", "zero dials today"). lockCapacity outside a transaction takes an
// xact lock that is released the instant its own statement ends. Each of those
// would fail OPEN silently; requireTenantScope makes the wiring bug loud.
// activeDialCounts and outboundDue read the no-RLS directories through
// definer functions (migration 044), so they are correct with or without one.

/** Throw unless a withTenant unit of work is in scope. */
function requireTenantScope(operation) {
  if (!tenantContext.getStore()?.client) {
    throw new Error(`${operation}: must run inside withTenant (an unscoped read under FORCE RLS returns nothing, which here would read as permission)`);
  }
}

/** A count column as a finite number, or a TypeError (the gate refuses strings). */
function finiteCount(value, operation) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    throw new TypeError(`${operation}: expected a numeric count, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Claim one outreach for dispatch: the row lock half of the double-dial guard
 * (G6). The outreach row is locked with SKIP LOCKED, so a second dispatcher
 * running at the same moment gets NO row and skips, instead of queuing behind
 * the first and dialing after it. Joins the PINNED campaign version's config,
 * not the campaign's current one.
 *
 * @param {string} outreachId
 * @returns {Promise<object|null>} null when the row is locked elsewhere or not visible
 */
export async function claimOutreachForDispatch(outreachId) {
  requireTenantScope("claimOutreachForDispatch");
  const res = await q(
    `SELECT o.id, o.business_id, o.state, o.attempts_made, o.created_at, o.hold_until, o.next_attempt_at,
            o.campaign_id, o.campaign_version, c.status AS campaign_status, c.compliance_class, c.template_key,
            v.config, k.id AS contact_id, k.phone_e164, k.first_name, k.timezone AS contact_timezone,
            b.outbound_enabled, b.allow_pricier_numbers, b.outbound_max_concurrent, b.timezone AS business_timezone, b.name AS business_name,
            -- S3-6 (spec §19, S3-D4): the business's own number, for
            -- dispatch.js's caller_id default when the campaign sets none.
            b.phone_number AS business_phone_number
       FROM outreach o
       JOIN campaigns c ON c.id = o.campaign_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
       JOIN contacts k ON k.id = o.contact_id
       JOIN businesses b ON b.id = o.business_id
      WHERE o.id = $1
        FOR UPDATE OF o SKIP LOCKED`,
    [outreachId]
  );
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("claimOutreachForDispatch", { resourceIds: [outreachId, row?.contact_id], rowCount: res.rowCount || 0 });
  return row;
}

/**
 * Is this number on the tenant's do-not-call list (gate check 4)?
 *
 * S3-11 (spec §13.5 amendment): also matches `phone_hash` -- an erasure keeps
 * the suppression row but nulls `phone_e164` (suppressionHash, above), so a
 * data subject who opted out and later asked to be forgotten must still be
 * refused here by hash alone. Computing that hash THROWS when
 * SUPPRESSION_HASH_KEY is missing or too short (Ruling S3-11b): this function
 * is gate check 4, and a do-not-call check that cannot rule out a hash match
 * must never read as "not suppressed" -- it throws instead, the caller
 * (dispatch.js) never reaches a dial, and Cloud Tasks retries.
 *
 * S3-11 fix round 1 (review Important finding, `services/db.js:2608`): `phone`
 * MUST normalize to canonical E.164 before hashing, the same way
 * eraseCallerData's write side already requires (below) -- every hash ever
 * WRITTEN is guaranteed canonical because that path throws on a
 * normalization failure, and hashing anything else here would silently read
 * as "not suppressed" for a number that IS on the do-not-call list (fail
 * OPEN, named risk 2's own failure mode, on the axis the global constraints
 * single out: `??` hiding a missing wire the same way an unguarded `?.`
 * would). Not reachable via either production caller today (dispatch.js and
 * postCall.js both pass contacts.phone_e164, and scripts/outbound-admin.js's
 * write path already regex-validates E.164 before insert) -- fixed anyway,
 * because "not reachable today" is not the same guarantee as "cannot ever
 * reach it", and this is gate check 4 on the do-not-call list.
 * @param {string} phone - E.164
 * @returns {Promise<boolean>}
 */
export async function isSuppressed(phone) {
  requireTenantScope("isSuppressed");
  const canonicalPhone = normalizePhoneNumber(phone);
  if (!canonicalPhone) {
    throw new Error(
      "isSuppressed: cannot compute a trustworthy suppression hash — the phone does not " +
        "normalize to E.164, and hashing a non-canonical form could silently read as not suppressed"
    );
  }
  const hash = suppressionHash(canonicalPhone);
  // E5 (review): the canonical phone, not the raw argument -- suppressions
  // rows are always written canonical (insertSuppression's callers already
  // normalize), so a raw, differently-punctuated spelling of the SAME
  // number would silently miss the `phone_e164 = $1` arm and fall back to
  // matching by hash alone (fail OPEN if the hash arm ever mismatches too).
  const res = await q(`SELECT id FROM suppressions WHERE phone_e164 = $1 OR phone_hash = $2`, [canonicalPhone, hash]);
  if (res.error) throw res.error;
  const rows = res.rows || [];
  noteAccess("isSuppressed", { resourceIds: rows.map((r) => r.id), rowCount: rows.length });
  return rows.length > 0;
}

/**
 * The contact's consent evidence (gate check 5), newest first. Revoked and
 * expired rows are returned too: consentSatisfies decides what counts.
 * `source` and `wording_version` are what the gate's operator-test rule reads
 * (Checkpoint 2a, F4): without them every consent would look like a real one.
 * @param {string} contactId
 * @returns {Promise<Array<{id: string, purpose: string, channels: string[], covers_automated: boolean, source: string, wording_version: string|null, captured_at: Date, expires_at: Date|null, revoked_at: Date|null}>>}
 */
export async function listConsents(contactId) {
  requireTenantScope("listConsents");
  const res = await q(
    `SELECT id, purpose, channels, covers_automated, source, wording_version, captured_at, expires_at, revoked_at
       FROM consents
      WHERE contact_id = $1
      ORDER BY captured_at DESC`,
    [contactId]
  );
  if (res.error) throw res.error;
  const rows = res.rows || [];
  noteAccess("listConsents", { resourceIds: [contactId, ...rows.map((r) => r.id)], rowCount: rows.length });
  return rows;
}

/**
 * Does the tenant hold a past or future appointment for this number (spec
 * §13.1, the `service` class)? appointments.client_phone is normalised on
 * write by the 026 trigger with normalize_phone_value(), so the lookup
 * normalises the argument with the SAME function rather than a second copy of
 * the rule that could drift from it.
 * @param {string} phone
 * @returns {Promise<boolean>}
 */
export async function hasServiceRelationship(phone) {
  requireTenantScope("hasServiceRelationship");
  const res = await q(
    `SELECT id FROM appointments WHERE client_phone = normalize_phone_value($1) LIMIT 1`,
    [phone]
  );
  if (res.error) throw res.error;
  const rows = res.rows || [];
  noteAccess("hasServiceRelationship", { resourceIds: rows.map((r) => r.id), rowCount: rows.length });
  return rows.length > 0;
}

/**
 * Dial attempts to this number since `since` (gate check 9, the per-contact
 * daily cap). TENANT-SCOPED by row-level security: spec §10.3 row 9 says
 * "across all campaigns", and campaigns are themselves per tenant, so this
 * counts every campaign of THIS business. Another tenant's dials to the same
 * person are invisible here by design.
 * @param {string} phone - E.164, as stored in call_attempts.to_number
 * @param {Date} since
 * @returns {Promise<number>}
 */
export async function countDialsSince(phone, since) {
  requireTenantScope("countDialsSince");
  const res = await q(
    `SELECT count(*)::int AS n FROM call_attempts WHERE to_number = $1 AND dialed_at >= $2`,
    [phone, since]
  );
  if (res.error) throw res.error;
  const n = finiteCount(one(res)?.n, "countDialsSince");
  noteAccess("countDialsSince", { rowCount: n });
  return n;
}

/**
 * Live outbound dials, globally and for this business (gate check 10). Reads
 * dial_registry through the app_active_dial_counts(p_business) definer
 * (migration 044), which returns exactly two counts and never another
 * tenant's id. A missing row or a non-numeric count throws (finiteCount): the
 * gate must never read "no row" as "zero live calls".
 * @param {string} businessId
 * @returns {Promise<{globalOutbound: number, businessOutbound: number}>}
 */
export async function activeDialCounts(businessId) {
  const res = await q(`SELECT global_active, business_active FROM app_active_dial_counts($1)`, [businessId]);
  if (res.error) throw res.error;
  const row = one(res);
  return {
    globalOutbound: finiteCount(row?.global_active, "activeDialCounts"),
    businessOutbound: finiteCount(row?.business_active, "activeDialCounts"),
  };
}

/**
 * Attempt N+1: the unique-key half of the double-dial guard (G6). If two
 * dispatchers ever both pass the row lock, UNIQUE (outreach_id, attempt_no)
 * lets exactly one insert land; the other gets `{conflict: true}` and does
 * nothing.
 * @param {{outreachId: string, attemptNo: number, fromNumber: string, toNumber: string}} a
 * @returns {Promise<{id: string}|{conflict: true}>}
 */
export async function insertCallAttempt({ outreachId, attemptNo, fromNumber, toNumber }) {
  requireTenantScope("insertCallAttempt");
  const res = await q(
    `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, dialed_at)
     SELECT o.business_id, o.id, $2, $3, $4, now() FROM outreach o WHERE o.id = $1
     ON CONFLICT (outreach_id, attempt_no) DO NOTHING
     RETURNING id`,
    [outreachId, attemptNo, fromNumber, toNumber]
  );
  if (res.error) throw res.error;
  noteAccess("insertCallAttempt", { resourceIds: [outreachId, res.rows?.[0]?.id], rowCount: res.rowCount || 0 });
  return res.rowCount === 1 ? { id: res.rows[0].id } : { conflict: true };
}

/**
 * waiting -> dialing, and count the attempt. Guarded on state so a row that
 * moved on cannot be counted twice.
 * @param {string} outreachId
 */
export async function markOutreachDialing(outreachId) {
  requireTenantScope("markOutreachDialing");
  const res = await q(
    `UPDATE outreach SET state = 'dialing', attempts_made = attempts_made + 1, last_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'waiting'`,
    [outreachId]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`markOutreachDialing: expected 1 row, got ${res.rowCount}`); // a tenantless write matches zero rows and must not pass as success
  noteAccess("markOutreachDialing", { resourceIds: [outreachId], rowCount: res.rowCount });
}

/**
 * Back to `waiting` with a new next_attempt_at. `at = null` PARKS the
 * outreach (a paused campaign): app_outbound_due skips a NULL next_attempt_at,
 * so the sweep stops re-queuing it. `undefined` is refused rather than stored
 * as NULL, because it would park an outreach nobody meant to park. A closed
 * outreach is never reopened.
 * @param {string} outreachId
 * @param {Date|null} at
 */
export async function rescheduleOutreach(outreachId, at) {
  requireTenantScope("rescheduleOutreach");
  if (at !== null && !(at instanceof Date && !Number.isNaN(at.getTime()))) {
    throw new TypeError(`rescheduleOutreach: at must be a valid Date or null, got ${String(at)}`);
  }
  const res = await q(
    `UPDATE outreach SET state = 'waiting', next_attempt_at = $2, updated_at = now()
      WHERE id = $1 AND state <> 'closed'`,
    [outreachId, at]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`rescheduleOutreach: expected 1 row, got ${res.rowCount}`);
  noteAccess("rescheduleOutreach", { resourceIds: [outreachId], rowCount: res.rowCount });
}

/**
 * Close an outreach for good. Only an open one: a closed row keeps the
 * reason it was closed for.
 * @param {string} outreachId
 * @param {string} closeReason - one of outreach.close_reason's CHECK values
 * @param {string|null} [outcome]
 */
export async function closeOutreach(outreachId, closeReason, outcome = null) {
  requireTenantScope("closeOutreach");
  const res = await q(
    `UPDATE outreach SET state = 'closed', close_reason = $2, outcome = $3, closed_at = now(), updated_at = now()
      WHERE id = $1 AND state <> 'closed'`,
    [outreachId, closeReason, outcome]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`closeOutreach: expected 1 row, got ${res.rowCount}`);
  noteAccess("closeOutreach", { resourceIds: [outreachId], rowCount: res.rowCount });
}

/** How long after our last dial an inbound call from that number still counts as a callback (spec §6.3). */
const CALLBACK_WINDOW_DAYS = 14;

/**
 * S4-1 (spec §12.3, §6.3, amendment C2): is this inbound caller a lead we
 * called and who is now ringing back? An ORDINARY tenant-scoped query (RLS is
 * the tenant boundary), not a definer function.
 *
 * The most recent outreach in state 'waiting' (a dialing / in_call row is a
 * call in flight, a closed one is finished) whose last_attempt_at is within
 * the last 14 days, for a contact with this phone, and the number is NOT on
 * the do-not-call list. The suppression check is `isSuppressed`, so a number
 * kept only by hash after erasure still refuses; that hashing THROWS when
 * SUPPRESSION_HASH_KEY is missing, and the throw propagates -- the start
 * helper turns any throw into "not recognised" (the prompt stays as it was).
 * A suppressed or erased number reads as null, never as a hit.
 *
 * Returns the pinned campaign version's topic and questions (never the
 * campaign's current version) and `answeredKeys`: the non-`_` keys present in
 * `calls.answers` of every call linked to this outreach.
 *
 * @param {string} phoneE164
 * @returns {Promise<null | {outreachId: string, campaignId: string, contactId: string,
 *   campaignVersion: number, lastAttemptAt: Date, topic: string|null,
 *   questions: object[], answeredKeys: string[]}>}
 */
export async function openOutreachForPhone(phoneE164, { isCancelled = () => false } = {}) {
  requireTenantScope("openOutreachForPhone");
  const canonical = normalizePhoneNumber(phoneE164);
  if (!canonical) return null; // "anonymous", "", a withheld number: nobody to recognise
  // A SQL error here must not abort the call-start transaction it shares with
  // createCall and the other context fetches: see withSavepoint.
  return withSavepoint("cb_lookup", () => lookupOutreach(canonical, isCancelled));
}

/**
 * Run `fn` inside a SAVEPOINT on the tenant transaction's client. q() returns
 * errors instead of throwing, and Postgres aborts the whole transaction on any
 * statement error, so without this a failing statement in an OPTIONAL lookup
 * would take createCall and every other fetch in the same withTenant down with
 * it. On any throw the savepoint is rolled back (the transaction is usable
 * again) and the error is rethrown to the caller, which treats it as "no".
 * Callers must run it with nothing else in flight on the client.
 */
async function withSavepoint(name, fn) {
  requireTenantScope(`withSavepoint(${name})`);
  const sp = await q(`SAVEPOINT ${name}`);
  if (sp.error) throw sp.error;
  try {
    const out = await fn();
    const rel = await q(`RELEASE SAVEPOINT ${name}`);
    if (rel.error) throw rel.error;
    return out;
  } catch (err) {
    await q(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

async function lookupOutreach(canonical, isCancelled) {
  const res = await q(
    `SELECT o.id, o.campaign_id, o.campaign_version, o.contact_id, o.last_attempt_at, v.config
       FROM outreach o
       JOIN contacts k ON k.id = o.contact_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
      WHERE k.phone_e164 = $1
        AND o.state = 'waiting'
        AND o.last_attempt_at IS NOT NULL
        AND o.last_attempt_at >= now() - ($2::int * interval '1 day')
      ORDER BY o.last_attempt_at DESC
      LIMIT 1`,
    [canonical, CALLBACK_WINDOW_DAYS]
  );
  if (res.error) throw res.error;
  const row = one(res);
  if (!row) return null;
  if (isCancelled()) return null; // the caller stopped waiting: issue nothing further
  if (await isSuppressed(canonical)) return null;
  if (isCancelled()) return null;
  const calls = await q(`SELECT answers FROM calls WHERE outreach_id = $1`, [row.id]);
  if (calls.error) throw calls.error;
  const answered = new Set();
  for (const c of calls.rows || []) {
    const a = c.answers;
    if (a && typeof a === "object" && !Array.isArray(a)) {
      for (const key of Object.keys(a)) if (!key.startsWith("_")) answered.add(key);
    }
  }
  const config = row.config && typeof row.config === "object" ? row.config : {};
  noteAccess("openOutreachForPhone", { resourceIds: [row.id, row.contact_id], rowCount: 1 });
  return {
    outreachId: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    campaignVersion: row.campaign_version,
    lastAttemptAt: row.last_attempt_at,
    topic: typeof config.topic === "string" && config.topic.trim() ? config.topic.trim() : null,
    // FINAL FIX WAVE N1: the campaign's questions are asked on a callback only
    // when its pinned config ever turned the qualification capability on --
    // questions and capabilities are validated independently, and a campaign
    // that never asks on its own calls must not start asking on a return call.
    // [] here means no tail sentence and no record_answer declaration, both of
    // which key on there being a question left to ask.
    questions:
      Array.isArray(config.questions) && Array.isArray(config.capabilities) && config.capabilities.includes("qualification")
        ? config.questions
        : [],
    answeredKeys: [...answered],
  };
}

/**
 * S4-1: the lead rang back. Closes the outreach `called_back` so no retry
 * dials them mid-callback -- but ONLY while it is still 'waiting': if the
 * dispatcher moved it to dialing / in_call between the lookup and now, it is
 * left alone (closing it would kill an in-flight attempt's outreach). Returns
 * whether it closed. Inside a savepoint like the lookup.
 * @param {string} outreachId
 * @returns {Promise<boolean>}
 */
export async function closeOutreachCalledBack(outreachId) {
  requireTenantScope("closeOutreachCalledBack");
  const closed = await withSavepoint("cb_close", async () => {
    const res = await q(
      `UPDATE outreach SET state = 'closed', close_reason = 'called_back', outcome = NULL, closed_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'waiting'`,
      [outreachId]
    );
    if (res.error) throw res.error;
    return res.rowCount === 1;
  });
  noteAccess("closeOutreachCalledBack", { resourceIds: [outreachId], rowCount: closed ? 1 : 0 });
  return closed;
}

/**
 * S4-1: link the inbound calls row (already written by the plain 4-argument
 * createCall) to the outreach the caller is ringing back about. Throws unless
 * exactly one row changed, so "recognised" never means "recognised but the row
 * is unlinked". Only an unlinked inbound row is touched.
 * @param {string} callSid
 * @param {string} outreachId
 * @param {string} contactId
 */
export async function linkCallToOutreach(callSid, outreachId, contactId) {
  requireTenantScope("linkCallToOutreach");
  await withSavepoint("cb_link", async () => {
    const res = await q(
      `UPDATE calls SET outreach_id = $2, contact_id = $3
        WHERE twilio_call_sid = $1 AND direction = 'inbound' AND outreach_id IS NULL`,
      [callSid, outreachId, contactId]
    );
    if (res.error) throw res.error;
    if (res.rowCount !== 1) throw new Error(`linkCallToOutreach: expected 1 row, got ${res.rowCount}`);
  });
  noteAccess("linkCallToOutreach", { resourceIds: [outreachId, contactId], rowCount: 1 });
}

/**
 * Store the CallSid Twilio returned. Never overwrites a DIFFERENT one: the
 * directory trigger (044) routes callbacks by this value. Idempotent for the
 * same one, because the dispatcher retries this write (a write that committed
 * but whose reply was lost must not fail its own retry).
 * @param {string} attemptId
 * @param {string} sid
 */
export async function setAttemptCallSid(attemptId, sid) {
  requireTenantScope("setAttemptCallSid");
  const res = await q(
    `UPDATE call_attempts SET twilio_call_sid = $2
      WHERE id = $1 AND (twilio_call_sid IS NULL OR twilio_call_sid = $2)`,
    [attemptId, sid]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`setAttemptCallSid: expected 1 row, got ${res.rowCount}`);
  noteAccess("setAttemptCallSid", { resourceIds: [attemptId], rowCount: res.rowCount });
}

/**
 * calls.create threw: the attempt happened and failed.
 *
 * S3-11: returns the row's own `dialed_at` via RETURNING (no schema/function
 * change -- app_outbound_stale_attempts returns business_id/attempt_id/kind
 * only, Ruling S3-11a) so failStaleAttempt (lib/outbound/dispatch.js) can
 * compute how long a stuck dial had been ringing without a second read.
 * @param {string} attemptId
 * @param {string} [twilioStatus]
 * @returns {Promise<{dialedAt: Date|null}>}
 */
export async function failAttempt(attemptId, twilioStatus = "failed") {
  requireTenantScope("failAttempt");
  // result + ended_at, not just twilio_status: the dial_registry trigger fires
  // on ended_at/result, and a row left open there blocks capacity for an hour.
  const res = await q(
    `UPDATE call_attempts SET twilio_status = $2, result = 'failed', ended_at = now() WHERE id = $1
      RETURNING dialed_at`,
    [attemptId, twilioStatus]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`failAttempt: expected 1 row, got ${res.rowCount}`);
  noteAccess("failAttempt", { resourceIds: [attemptId], rowCount: res.rowCount });
  return { dialedAt: res.rows[0].dialed_at ?? null };
}

/**
 * The pre-rendered backstop line, voicemail and transfer-miss clip (§9.3,
 * S3-4/D6), rendered while it rings. Refused once post-call has started:
 * post-call clears these columns (spec §11 step 1), and a render that
 * finished after a quick no-answer must not write the clips back for good.
 *
 * WRITES ONLY WHAT IT IS GIVEN (Task 14 fix round 1, I4): a null or absent
 * clip leaves its column as it is. Dispatch stores the opener the moment its
 * render finishes, the voicemail (or transfer_miss) when that one does, and
 * a later write never nulls out an earlier one. Clearing is post-call's job
 * (spec §11), with its own statement.
 * @param {string} attemptId
 * @param {{opener?: Buffer|null, voicemail?: Buffer|null, transfer_miss?: Buffer|null}} audio
 */
export async function storeAttemptAudio(attemptId, { opener = null, voicemail = null, transfer_miss = null } = {}) {
  requireTenantScope("storeAttemptAudio");
  const res = await q(
    `UPDATE call_attempts SET opener_audio = COALESCE($2::bytea, opener_audio), voicemail_audio = COALESCE($3::bytea, voicemail_audio),
            transfer_miss_audio = COALESCE($4::bytea, transfer_miss_audio)
      WHERE id = $1 AND post_call_started_at IS NULL`,
    [attemptId, opener, voicemail, transfer_miss]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`storeAttemptAudio: expected 1 row, got ${res.rowCount} (missing, unscoped, or post-call already started)`);
  noteAccess("storeAttemptAudio", { resourceIds: [attemptId], rowCount: res.rowCount });
}

/**
 * Outreach due for dispatch, across all tenants (the sweep). Reads the
 * outreach_schedule directory through app_outbound_due (migration 044): ids
 * only, so this needs no tenant scope.
 * @param {number} limit
 * @param {number} graceSeconds
 * @returns {Promise<Array<{business_id: string, outreach_id: string}>>}
 */
export async function outboundDue(limit, graceSeconds) {
  const res = await q(`SELECT business_id, outreach_id FROM app_outbound_due($1::int, $2::int)`, [limit, graceSeconds]);
  if (res.error) throw res.error;
  return res.rows || [];
}

/**
 * The capacity lock. One global transaction-scoped advisory lock, so two
 * dispatches of DIFFERENT outreach cannot both read "one line free" and both
 * dial. Released by the unit of work's COMMIT or ROLLBACK, which is why it
 * refuses to run outside one.
 */
export async function lockCapacity() {
  requireTenantScope("lockCapacity");
  const res = await q(`SELECT pg_advisory_xact_lock(hashtext('outbound_capacity'))`);
  if (res.error) throw res.error;
}

/**
 * Lock an outreach row and read its state, for the dispatcher's post-create
 * failure path. With the row locked first, nothing can close it between this
 * read and the path's own writes, so "closed" here is a fact to act on: record
 * the attempt, leave the outreach closed.
 * @param {string} outreachId
 * @returns {Promise<string|null>} the state, or null when the row is not visible
 */
export async function lockOutreachState(outreachId) {
  requireTenantScope("lockOutreachState");
  const res = await q(`SELECT state FROM outreach WHERE id = $1 FOR UPDATE`, [outreachId]);
  if (res.error) throw res.error;
  noteAccess("lockOutreachState", { resourceIds: [outreachId], rowCount: res.rowCount || 0 });
  return one(res)?.state ?? null;
}

/**
 * Give an attempt back (C16): Twilio refused with its concurrency error, so no
 * call was placed, and the attempt must count neither against the schedule
 * nor against the daily cap. Only an attempt that never got a CallSid.
 * @param {string} attemptId
 * @param {string} outreachId
 */
export async function undoAttempt(attemptId, outreachId) {
  requireTenantScope("undoAttempt");
  const del = await q(`DELETE FROM call_attempts WHERE id = $1 AND twilio_call_sid IS NULL`, [attemptId]);
  if (del.error) throw del.error;
  const upd = await q(`UPDATE outreach SET attempts_made = attempts_made - 1, updated_at = now() WHERE id = $1 AND attempts_made > 0`, [outreachId]);
  if (upd.error) throw upd.error;
  if (del.rowCount !== 1 || upd.rowCount !== 1) {
    throw new Error(`undoAttempt: expected 1 row each, got delete ${del.rowCount} / update ${upd.rowCount}`);
  }
  noteAccess("undoAttempt", { resourceIds: [attemptId, outreachId], rowCount: 2 });
}

/**
 * Resolve a Twilio CallSid to its outbound tenant and attempt (spec §9.1,
 * §9.2; plan correction C15). The three outbound door routes -- answer,
 * status and the signed media route -- all need this BEFORE the tenant is
 * known, which is exactly what `app_outbound_attempt_by_call_sid` (migration
 * 044) is for: a SECURITY DEFINER function over the no-RLS
 * call_attempt_directory that adopts `app.business_id` for the REST OF THIS
 * TRANSACTION, but only when no scope is already declared (the 033 rule --
 * never repoint a caller that already knows its tenant).
 *
 * Runs on its own client and its own short transaction, because businessId is
 * not known yet: `withTenant` cannot be used (it requires one up front). The
 * definer's own final SELECT already runs under the freshly adopted scope, so
 * this is one round trip, not two.
 *
 * NON_PHI_EXPORTS (lib/phiAudit.js): the return shape is ids and an int only
 * -- never a phone number, a name, or anything else that identifies who was
 * called. Task 14 reuses this to resolve the Live session's outbound context,
 * which is why the shape stays general rather than trimmed to only what the
 * door itself reads.
 *
 * @param {string} callSid
 * @returns {Promise<{businessId:string, attemptId:string, outreachId:string, campaignId:string, campaignVersion:number}|null>} null on a miss (including an unusable/empty callSid)
 */
export async function outboundAttemptByCallSid(callSid) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `SELECT business_id, attempt_id, outreach_id, campaign_id, campaign_version
         FROM app_outbound_attempt_by_call_sid($1)`,
      [callSid]
    );
    await client.query("COMMIT");
    const row = res.rows?.[0];
    if (!row) return null;
    return {
      businessId: row.business_id,
      attemptId: row.attempt_id,
      outreachId: row.outreach_id,
      campaignId: row.campaign_id,
      campaignVersion: row.campaign_version,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stamp one Twilio status callback onto a call_attempts row (spec §9.1,
 * §9.4). Runs inside `withTenant` -- the caller resolves businessId first via
 * `outboundAttemptByCallSid`.
 *
 * Idempotent by construction, because Twilio retries callbacks and a status
 * can arrive after dispatch already failed the attempt or after AMD already
 * set a result (Task 13):
 *   - `result` is written only when it is still NULL (COALESCE), so a later
 *     callback can never clobber an earlier, more specific verdict.
 *   - `answered_at`, `ended_at` and `status_completed_at` are each written
 *     only the first time (COALESCE again), so a duplicate terminal callback
 *     moves none of them a second time.
 *   - `twilio_status` is overwritten on every call EXCEPT one: once a
 *     terminal stamp has landed (`status_completed_at` is already set), a
 *     NON-terminal status arriving after it (an out-of-order "ringing" or
 *     "in-progress" retry, reordered in flight) is frozen out rather than
 *     overwriting "completed" back to "ringing". A terminal status is always
 *     written through, including a duplicate of the SAME terminal status --
 *     `twilio_status` is allowed to re-confirm itself even though the
 *     timestamps/result next to it do not move again (fix round 1, item 5).
 *
 * Returns whether THIS call was the first terminal stamp, and whether the
 * attempt had already been answered before it (i.e. `answered_at` was set
 * prior to this call, since a terminal status never sets `answered_at`
 * itself). The caller (doorRoutes.js) uses both to decide whether to run
 * `completeCall` at all (fix round 1, item 9): only once, per attempt, and
 * only for an attempt that was actually answered -- an attempt that never
 * connected has no `calls` row for `completeCall` to touch, and re-running it
 * on a duplicate terminal callback would move `calls.ended_at` a second time
 * for nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO STATEMENTS, NOT ONE CTE (fix round 2, Critical)
 * ---------------------------------------------------------------------------
 *
 * The first version of this function used `WITH before AS (SELECT ... WHERE
 * id = $1) UPDATE call_attempts a SET ... FROM before WHERE a.id = $1`, on
 * the theory that a single statement's CTE and target-table row see a
 * consistent snapshot. They do not, under concurrency: `before` is
 * materialized ONCE, when the statement starts -- before the UPDATE half
 * even tries to acquire the row lock. Under READ COMMITTED, when a second,
 * genuinely concurrent call blocks behind an uncommitted first one,
 * Postgres's EvalPlanQual recheck (once the lock frees up) re-fetches bare
 * `a.<column>` references against the now-current row, but does NOT
 * re-evaluate a CTE that was already computed. So the second call's `before`
 * stays wrong -- it never learns the first call already landed.
 *
 * Reproduced on two real connections (tests/db/outboundDoorAttempt.test.js,
 * "race-safety" block): two concurrent terminal stamps both came back
 * firstTerminalStamp:true, and status_completed_at moved to the SECOND
 * one's time; a stray "ringing" blocked behind an uncommitted "completed"
 * still landed once unblocked, moving twilio_status backwards.
 *
 * The fix is two statements in the SAME transaction (the caller always runs
 * this inside `withTenant`/`withTenantSafe`'s one open transaction):
 *   1. `SELECT ... FOR UPDATE` -- blocks until any concurrent stamp on this
 *      row has committed or rolled back, THEN returns the row as it now
 *      truly is, and holds the lock.
 *   2. A plain `UPDATE ... WHERE id = $1` with bare column references,
 *      using ordinary parameters (not a second read) for the "was already
 *      terminal" freeze condition -- safe because nothing else can touch
 *      this row between the two statements: we are the one holding the lock.
 *
 * @param {string} attemptId
 * @param {{twilioStatus: string, answered?: boolean, terminal?: boolean, result?: string|null}} stamp
 * @returns {Promise<{firstTerminalStamp: boolean, answered: boolean}>}
 */
export async function stampAttemptStatus(attemptId, { twilioStatus, answered = false, terminal = false, result = null }) {
  requireTenantScope("stampAttemptStatus");

  // Statement 1: lock the row and read its TRUE current state. Blocks here,
  // not in statement 2, if another stamp on the same attempt is mid-flight.
  const locked = await q(
    `SELECT status_completed_at, answered_at FROM call_attempts WHERE id = $1 FOR UPDATE`,
    [attemptId]
  );
  if (locked.error) throw locked.error;
  const priorRow = one(locked);
  if (!priorRow) {
    throw new Error(`stampAttemptStatus: attempt ${attemptId} not found (or not visible under this scope)`);
  }
  const wasTerminalAlready = priorRow.status_completed_at !== null;
  const wasAnswered = priorRow.answered_at !== null;
  const firstTerminalStamp = terminal && !wasTerminalAlready;

  // Statement 2: an ordinary UPDATE, on the row we already hold the lock on.
  // Bare column references (COALESCE(answered_at, now()), etc.) are safe
  // here for the same reason they were never the problem: nothing else can
  // be racing this specific row between statement 1 and this one.
  const res = await q(
    `UPDATE call_attempts
        SET twilio_status = CASE WHEN $6 AND NOT $4 THEN twilio_status ELSE $2 END,
            answered_at = CASE WHEN $3 THEN COALESCE(answered_at, now()) ELSE answered_at END,
            ended_at = CASE WHEN $4 THEN COALESCE(ended_at, now()) ELSE ended_at END,
            status_completed_at = CASE WHEN $4 THEN COALESCE(status_completed_at, now()) ELSE status_completed_at END,
            result = CASE WHEN $5::text IS NOT NULL THEN COALESCE(result, $5::text) ELSE result END
      WHERE id = $1`,
    [attemptId, twilioStatus, answered, terminal, result, wasTerminalAlready]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`stampAttemptStatus: expected 1 row, got ${res.rowCount}`);
  noteAccess("stampAttemptStatus", { resourceIds: [attemptId], rowCount: res.rowCount });
  return { firstTerminalStamp, answered: wasAnswered };
}

/**
 * The pre-rendered voicemail clip, for the signed media door
 * (`GET /media/outbound/:callSid/:kind.wav`). Runs inside `withTenant` -- the
 * caller resolves businessId first via `outboundAttemptByCallSid`, which is
 * also what stops this route serving another tenant's audio: RLS only
 * exposes the row when the scope matches, and the scope came from resolving
 * THIS request's own CallSid, not from anything the caller supplied.
 * @param {string} attemptId
 * @returns {Promise<Buffer|null>} raw mu-law bytes, or null when there is none
 */
export async function fetchAttemptVoicemailAudio(attemptId) {
  requireTenantScope("fetchAttemptVoicemailAudio");
  const res = await q(`SELECT voicemail_audio FROM call_attempts WHERE id = $1`, [attemptId]);
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("fetchAttemptVoicemailAudio", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  return row?.voicemail_audio ?? null;
}

/**
 * S3-4 (D6, migration 046): the pre-rendered "sorry, no one's free" clip, for
 * the SAME signed media door as the voicemail (`GET /media/outbound/:callSid/
 * :kind.wav`, kind=transfer_miss) -- played by the outbound-transfer-result
 * route when a transfer goes unanswered, so the caller hears Ava's own Live
 * voice instead of Twilio's <Say>. Same scoping rule as
 * fetchAttemptVoicemailAudio: runs inside `withTenant`, resolved by the
 * caller's own by-CallSid lookup first.
 * @param {string} attemptId
 * @returns {Promise<Buffer|null>} raw mu-law bytes, or null when there is none
 */
export async function fetchAttemptTransferMissAudio(attemptId) {
  requireTenantScope("fetchAttemptTransferMissAudio");
  const res = await q(`SELECT transfer_miss_audio FROM call_attempts WHERE id = $1`, [attemptId]);
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("fetchAttemptTransferMissAudio", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  return row?.transfer_miss_audio ?? null;
}

/**
 * The recorded greeting (migration 056, lib/voice/greetingClip.js). One clip per
 * business, variant and language. Runs inside `withTenant`: greeting_clips is
 * FORCE RLS, so an unscoped read sees nothing and an unscoped write is refused.
 * @returns {Promise<{input_hash: string, spoken_text: string, voice_name: string, audio: Buffer}|null>}
 */
export async function fetchGreetingClip(businessId, variant, languageCode) {
  requireTenantScope("fetchGreetingClip");
  const res = await q(
    `SELECT input_hash, spoken_text, voice_name, audio FROM greeting_clips
      WHERE business_id = $1 AND variant = $2 AND language_code = $3`,
    [businessId, variant, languageCode]
  );
  if (res.error) throw res.error;
  return one(res);
}

/**
 * Insert or replace one greeting clip. Throws unless exactly one row was
 * written: a write that matched nothing (wrong tenant scope) must not read as
 * a stored clip.
 */
export async function upsertGreetingClip({ businessId, variant, languageCode, inputHash, spokenText, voiceName, audio }) {
  requireTenantScope("upsertGreetingClip");
  const res = await q(
    `INSERT INTO greeting_clips (business_id, variant, language_code, input_hash, spoken_text, voice_name, audio)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, variant, language_code) DO UPDATE
       SET input_hash = EXCLUDED.input_hash, spoken_text = EXCLUDED.spoken_text,
           voice_name = EXCLUDED.voice_name, audio = EXCLUDED.audio, created_at = now()`,
    [businessId, variant, languageCode, inputHash, spokenText, voiceName, audio]
  );
  if (res.error) throw res.error;
  if ((res.rowCount || 0) !== 1) throw new Error(`upsertGreetingClip: wrote ${res.rowCount || 0} rows, expected 1`);
}

/**
 * Stamp one async AMD verdict onto a call_attempts row (spec §9.4, Task 13).
 * Runs inside `withTenant`/`withTenantSafe` -- the caller resolves
 * businessId first via `outboundAttemptByCallSid`, the same as
 * `stampAttemptStatus`.
 *
 * `answered_by` and `amd_duration_ms` are written on EVERY call. `result` is
 * written only when it is still NULL (COALESCE) -- a status callback can
 * race ahead of AMD and set a terminal result (busy/no-answer/failed/
 * canceled) first, and that must not be clobbered by AMD's own verdict
 * arriving after it. `result: null` is therefore a safe no-op for that one
 * column: doorRoutes.js calls this once to record what Twilio observed
 * BEFORE it has decided anything (result omitted/null), then again with the
 * decided result once it has one.
 * @param {string} attemptId
 * @param {{answeredBy: string|null, amdDurationMs?: number|null, result?: string|null}} stamp
 */
export async function stampAttemptAmd(attemptId, { answeredBy, amdDurationMs = null, result = null }) {
  requireTenantScope("stampAttemptAmd");
  const res = await q(
    `UPDATE call_attempts
        SET answered_by = $2,
            amd_duration_ms = $3,
            result = CASE WHEN $4::text IS NOT NULL THEN COALESCE(result, $4::text) ELSE result END
      WHERE id = $1`,
    [attemptId, answeredBy, amdDurationMs, result]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`stampAttemptAmd: expected 1 row, got ${res.rowCount}`);
  noteAccess("stampAttemptAmd", { resourceIds: [attemptId], rowCount: res.rowCount });
}

/**
 * I6 (fix wave, checkpoint 2b, = b37): stamp `answered_at` the moment the
 * Live session resolves the outbound context -- the stream only starts
 * after pickup (spec §9.2), the SAME semantics as Twilio's own "in-progress"
 * callback (`stampAttemptStatus`'s `answered` flag), machine answers
 * included. A lost or late "in-progress" callback otherwise leaves
 * `answered_at` NULL: `claimPostCall`'s own `answered_at IS NULL` disjunct
 * then claims the attempt as soon as its terminal status lands, before the
 * session finishes, so `runPostCall` takes the unanswered branch -- neither
 * the opt-out nor the claimed-human detector ever reads the transcript, and
 * a person who just said "stop calling me" (or just booked) gets dialled
 * again.
 *
 * COALESCE-only, the same rule `stampAttemptStatus` follows for this exact
 * column: never moves a timestamp that already exists, so calling this after
 * the door's own stamp already landed (or calling it twice, e.g. a retried
 * onStart) is a safe no-op.
 * @param {string} attemptId
 */
export async function stampAttemptAnswered(attemptId) {
  requireTenantScope("stampAttemptAnswered");
  const res = await q(`UPDATE call_attempts SET answered_at = COALESCE(answered_at, now()) WHERE id = $1`, [attemptId]);
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`stampAttemptAnswered: expected 1 row, got ${res.rowCount}`);
  noteAccess("stampAttemptAnswered", { resourceIds: [attemptId], rowCount: res.rowCount });
}

/**
 * The campaign context `decideAmd` (lib/outbound/amd.js) needs, but
 * `outboundAttemptByCallSid` deliberately does not carry -- that function's
 * shape stays general because Task 14 reuses it for the Live session's own
 * context resolution (plan C15/P-0), so it is not trimmed to only what one
 * caller needs. Runs inside `withTenant`/`withTenantSafe`, the same caller
 * pattern as the rest of this block.
 * @param {string} attemptId
 * @returns {Promise<{attemptNo: number, complianceClass: string, voicemailOn: number[], callerId: string|null}|null>}
 */
/**
 * Real Hold call 2026-10-01 (defect B). Has this call had a real exchange --
 * the AI's turn heard AND the person answering it? The live session measures
 * that on AUDIO (lib/outbound/liveFirstLine.js onExchange) and marks
 * calls.answers._exchanged (lib/voice/live/index.js markExchanged). Not from
 * transcript rows (final review of the hold fixes, #4/#5): they land only at
 * a turn's close and only with the caller's TEXT (transcript lag reached 9.4 s
 * p50), and clip mode seeds an AI row before any caller row, so a voicemail
 * greeting read as an exchange there. Clip mode never writes the marker.
 *
 * The AMD door (lib/outbound/doorRoutes.js) reads this from the DATABASE
 * because its callback can land on another instance than the call's session.
 * THROWS on failure, unlike fetchCallTranscript (which returns [] on error):
 * "the read failed" must not look like "no exchange", which would hang up.
 *
 * @param {string} callSid
 * @returns {Promise<boolean>}
 */
export async function outboundCallHadExchange(callSid) {
  requireTenantScope("outboundCallHadExchange");
  const res = await q(
    `SELECT EXISTS (
       SELECT 1 FROM calls c WHERE c.twilio_call_sid = $1 AND c.answers -> '_exchanged' = 'true'::jsonb
     ) AS exchanged`,
    [callSid]
  );
  if (res.error) throw res.error;
  noteAccess("outboundCallHadExchange", { rowCount: res.rowCount || 0 });
  return one(res)?.exchanged === true;
}

export async function outboundAmdContext(attemptId) {
  requireTenantScope("outboundAmdContext");
  const res = await q(
    `SELECT a.attempt_no, c.compliance_class, v.config
       FROM call_attempts a
       JOIN outreach o ON o.id = a.outreach_id
       JOIN campaigns c ON c.id = o.campaign_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
      WHERE a.id = $1`,
    [attemptId]
  );
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("outboundAmdContext", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  if (!row) return null;
  return {
    attemptNo: row.attempt_no,
    complianceClass: row.compliance_class,
    voicemailOn: Array.isArray(row.config?.retries?.voicemail_on) ? row.config.retries.voicemail_on : [],
    // O-26/C17: the campaign's own caller_id, already loaded via `v.config`
    // above -- the smallest read (no new query) that lets the AMD door's
    // REST update (lib/outbound/doorRoutes.js) resolve the OWNING Twilio
    // account instead of always assuming account A.
    callerId: row.config?.caller_id ?? null,
  };
}

/**
 * Everything the Live session needs about THIS attempt (spec §9.2, Task 14):
 * the attempt (number, dialled number, the pre-rendered backstop clip), its
 * outreach (links, trigger), the campaign (class, audience, template), the
 * PINNED campaign version's config, and the contact (first name, timezone).
 *
 * Runs inside `withTenant` -- lib/outbound/callContext.js resolves the tenant
 * first with `outboundAttemptByCallSid` (the definer that works before the
 * tenant is known) and scopes to what it found, so RLS shows only this call's
 * rows. PHI: the contact's number and first name and the trigger payload.
 *
 * @param {string} attemptId
 * @returns {Promise<null | {attemptNo: number, openerAudio: Buffer|null, toNumber: string, outreachId: string,
 *   campaignId: string, campaignVersion: number, contactId: string, trigger: object, details: object, templateKey: string,
 *   complianceClass: string, audience: string, config: object, firstName: string|null, contactTimezone: string|null}>}
 */
export async function outboundCallContext(attemptId) {
  requireTenantScope("outboundCallContext");
  const res = await q(
    `SELECT a.attempt_no, a.opener_audio, a.to_number,
            o.id AS outreach_id, o.campaign_id, o.campaign_version, o.contact_id, o.trigger, o.details,
            c.template_key, c.compliance_class, c.audience,
            v.config,
            k.first_name, k.last_name, k.timezone AS contact_timezone
       FROM call_attempts a
       JOIN outreach o ON o.id = a.outreach_id
       JOIN campaigns c ON c.id = o.campaign_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
       JOIN contacts k ON k.id = o.contact_id
      WHERE a.id = $1`,
    [attemptId]
  );
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("outboundCallContext", { resourceIds: [attemptId, row?.contact_id].filter(Boolean), rowCount: res.rowCount || 0 });
  if (!row) return null;
  return {
    attemptNo: row.attempt_no,
    openerAudio: row.opener_audio ?? null,
    toNumber: row.to_number,
    outreachId: row.outreach_id,
    campaignId: row.campaign_id,
    campaignVersion: row.campaign_version,
    contactId: row.contact_id,
    trigger: row.trigger ?? {},
    // S3-9: the per-person facts (S3-6) the leads-in trigger stored,
    // already filtered to the campaign's details_fields at write time
    // (lib/outbound/triggerRoute.js) -- carried through unfiltered here, the
    // same "read what was written" rule contact/trigger fields above follow.
    details: row.details ?? {},
    templateKey: row.template_key,
    complianceClass: row.compliance_class,
    audience: row.audience,
    config: row.config,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    contactTimezone: row.contact_timezone ?? null,
  };
}

/**
 * The backstop clip, re-read ONCE by a Live session that found none at stream
 * start (Task 14 fix round 1, I4): on a voicemail attempt the render can still
 * be finishing when the person answers. Runs inside `withTenant` -- the session
 * scopes to the tenant its by-CallSid resolution found, the same as
 * outboundCallContext. PHI for the same reason as fetchAttemptVoicemailAudio:
 * audio that addresses the contact by name.
 * @param {string} attemptId
 * @returns {Promise<Buffer|null>} raw mu-law bytes, or null when there is none
 */
export async function fetchAttemptOpenerAudio(attemptId) {
  requireTenantScope("fetchAttemptOpenerAudio");
  const res = await q(`SELECT opener_audio FROM call_attempts WHERE id = $1`, [attemptId]);
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("fetchAttemptOpenerAudio", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  return row?.opener_audio ?? null;
}

// --- outbound post-call (Task 20, spec §11, §13.2-13.4) --------------------

/**
 * The plan's single atomic UPDATE, verbatim (spec §11): whichever of the two
 * inputs -- the terminal status callback (`status_completed_at`) and the
 * session's `finish` (`session_finished_at`) -- arrives SECOND claims the
 * run. The third disjunct is the sweep's `postcall_pending` backstop (spec
 * §6.3, migration 045): a session that died without finishing is claimable
 * once its terminal status is more than 2 minutes old, whether or not it was
 * ever answered.
 *
 * Returns the CLAIMED VALUE, not a bare boolean (fix round 1, Owner O-15):
 * truthy/falsy for "did this call claim it", and useful for logging --
 * `releasePostCallClaim` below does NOT need it (see its own doc for why an
 * exact-value comparison there is fragile against a real Postgres
 * timestamptz's precision).
 * @param {string} attemptId
 * @returns {Promise<Date|null>} the value written, or null if not claimed
 */
export async function claimPostCall(attemptId) {
  requireTenantScope("claimPostCall");
  const res = await q(
    `UPDATE call_attempts SET post_call_started_at = now()
      WHERE id = $1 AND post_call_started_at IS NULL
        AND status_completed_at IS NOT NULL
        AND (session_finished_at IS NOT NULL OR answered_at IS NULL OR status_completed_at < now() - interval '2 minutes')
      RETURNING post_call_started_at`,
    [attemptId]
  );
  if (res.error) throw res.error;
  noteAccess("claimPostCall", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  return res.rows[0]?.post_call_started_at ?? null;
}

/**
 * Release a post-call claim after a failed run (fix round 1, Owner O-15): a
 * throw between the claim committing and the run finishing must not strand
 * the attempt forever (invisible to the sweep, and a retried claim would
 * find `post_call_started_at` already set and refuse). The 045 trigger
 * re-lists the row in `postcall_pending` the moment this commits, so the
 * next sweep tick (or a retried caller) claims it again.
 *
 * Ruling: the plan's own sketch compares to the EXACT value the caller
 * claimed (`WHERE post_call_started_at = $2`); measured against real
 * Postgres this is fragile, not merely stylistic -- `claimPostCall`'s
 * `RETURNING` value round-trips through node-postgres's JS `Date` (millisecond
 * precision) while the column itself is a microsecond-precision
 * `timestamptz`, so the round-tripped value can silently fail to equal the
 * one actually stored, and the release would then match zero rows (found
 * empirically: tests/db/outboundPostCallClaim.test.js's own release test
 * failed against real Postgres with the exact-value form). `WHERE
 * post_call_started_at IS NOT NULL` is EQUALLY SAFE by construction, not a
 * loosening: `claimPostCall`'s own guard (`... IS NULL ...`) is the only way
 * this column ever becomes non-null, so nothing else can be holding a
 * "different" claim to protect against between our claim and our release --
 * the column can only be still-ours or already-released, never
 * someone-else's.
 * @param {string} attemptId
 * @returns {Promise<boolean>} true iff a claim was actually released
 */
export async function releasePostCallClaim(attemptId) {
  requireTenantScope("releasePostCallClaim");
  const res = await q(`UPDATE call_attempts SET post_call_started_at = NULL WHERE id = $1 AND post_call_started_at IS NOT NULL`, [
    attemptId,
  ]);
  if (res.error) throw res.error;
  noteAccess("releasePostCallClaim", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
  return res.rowCount === 1;
}

/**
 * The Live controller's own half of post-call's two inputs (spec §11, Task
 * 20): stamps `session_finished_at` once, and persists what only the
 * controller can know -- `first_audio_ms` (`firstAudio().from_answer_ms`)
 * and the SESSION's own silent verdict (`isSessionSilent`, the two limbs
 * only). Post-call may run on another instance and cannot recompute
 * `from_speech_ms`/`from_answer_ms` after the fact, which is why this is
 * captured here rather than derived later. It carries no machine exclusion
 * and no "no stream" case -- lib/outbound/detectors.js's
 * `resolveSilentVerdict` applies those, once, in post-call, because the AMD
 * verdict can land after the session finishes.
 * @param {string} attemptId
 * @param {{firstAudioMs: number|null, silent: boolean}} o
 */
export async function finishAttemptSession(attemptId, { firstAudioMs = null, silent = false } = {}) {
  requireTenantScope("finishAttemptSession");
  // b38 (fix wave, checkpoint 2b): guarded on `post_call_started_at IS NULL`.
  // Once post-call has claimed the attempt (`claimPostCall`) it may already
  // have written the FINAL silent verdict (lib/outbound/postCall.js's
  // `setAttemptSilent`, spec §13.4, `resolveSilentVerdict`'s machine/fax
  // correction included). A LATE finish -- the session's own `finish()`
  // landing after that claim, the loser of "whichever input arrives second
  // claims the run" (spec §11) -- must never overwrite that verdict with its
  // own, earlier and possibly stale one. A skip here is a normal outcome,
  // not a fault: post-call already has whatever this call would have
  // written, so `rowCount` may legitimately be 0.
  const res = await q(
    `UPDATE call_attempts SET session_finished_at = now(), first_audio_ms = $2, silent = $3
      WHERE id = $1 AND post_call_started_at IS NULL`,
    [attemptId, firstAudioMs, silent]
  );
  if (res.error) throw res.error;
  noteAccess("finishAttemptSession", { resourceIds: [attemptId], rowCount: res.rowCount || 0 });
}

/**
 * Everything `runPostCall` (lib/outbound/postCall.js) needs about one
 * attempt, in one read: the attempt's own fields (including the two
 * measured timings and the `calls` row it produced, if a session ever
 * created one -- LEFT JOINed on `calls.attempt_id`, Task 14's link column,
 * so a session that never started, or the sweep's `postcall_pending`
 * backstop, still resolves cleanly with `call_id: null`), its outreach
 * (state, `attempts_made`, `created_at`, for the schedule and the no-double-
 * reschedule guard), the PINNED campaign version's config (retry schedule,
 * calling window) and the contact/business timezone (`nextScheduled`,
 * `contactTimezone`). Runs inside `withTenant`.
 * @param {string} attemptId
 * @returns {Promise<null | {
 *   attemptNo: number, dialedAt: Date|null, answeredAt: Date|null, endedAt: Date|null,
 *   answeredBy: string|null, result: string|null, silent: boolean,
 *   sessionFinishedAt: Date|null, statusCompletedAt: Date|null, twilioCallSid: string|null,
 *   outreachId: string, outreachState: string, attemptsMade: number, outreachCreatedAt: Date,
 *   campaignId: string, campaignVersion: number, contactId: string,
 *   complianceClass: string, templateKey: string, config: object,
 *   phoneE164: string, contactTimezone: string|null, businessTimezone: string,
 *   callId: string|null, callSid: string|null, outcomeCode: string|null, answers: object|null,
 * }>}
 */
export async function outboundPostCallContext(attemptId) {
  requireTenantScope("outboundPostCallContext");
  const res = await q(
    `SELECT a.attempt_no, a.dialed_at, a.answered_at, a.ended_at, a.answered_by, a.result, a.silent,
            a.session_finished_at, a.status_completed_at, a.twilio_call_sid,
            o.id AS outreach_id, o.state AS outreach_state, o.attempts_made, o.created_at AS outreach_created_at,
            o.campaign_id, o.campaign_version, o.contact_id,
            c.compliance_class, c.template_key,
            v.config,
            k.phone_e164, k.timezone AS contact_timezone,
            b.timezone AS business_timezone,
            cl.id AS call_id, cl.twilio_call_sid AS call_sid, cl.outcome_code, cl.answers
       FROM call_attempts a
       JOIN outreach o ON o.id = a.outreach_id
       JOIN campaigns c ON c.id = o.campaign_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
       JOIN contacts k ON k.id = o.contact_id
       JOIN businesses b ON b.id = o.business_id
       LEFT JOIN calls cl ON cl.attempt_id = a.id
      WHERE a.id = $1`,
    [attemptId]
  );
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("outboundPostCallContext", { resourceIds: [attemptId, row?.contact_id].filter(Boolean), rowCount: res.rowCount || 0 });
  if (!row) return null;
  return {
    attemptNo: row.attempt_no,
    dialedAt: row.dialed_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    answeredBy: row.answered_by,
    result: row.result,
    silent: row.silent,
    sessionFinishedAt: row.session_finished_at,
    statusCompletedAt: row.status_completed_at,
    twilioCallSid: row.twilio_call_sid,
    outreachId: row.outreach_id,
    outreachState: row.outreach_state,
    attemptsMade: row.attempts_made,
    outreachCreatedAt: row.outreach_created_at,
    campaignId: row.campaign_id,
    campaignVersion: row.campaign_version,
    contactId: row.contact_id,
    complianceClass: row.compliance_class,
    templateKey: row.template_key,
    config: row.config,
    phoneE164: row.phone_e164,
    contactTimezone: row.contact_timezone,
    businessTimezone: row.business_timezone,
    callId: row.call_id,
    callSid: row.call_sid,
    outcomeCode: row.outcome_code,
    // Forward-compatible seam: `schedule_callback` (stage 3) is what would
    // populate this, and the transfer-unanswered door path (Task 19) never
    // does -- so a callback_requested outcome with no answers.callback_
    // requested_at is the mechanical "next schedule entry" case (spec §11).
    answers: row.answers ?? null,
  };
}

/**
 * Post-call step 1 (spec §11): set `result` (only if still unset -- an
 * unanswered attempt already has one from the door/AMD routes, and COALESCE
 * never clobbers a more specific verdict), `ended_at` (same rule), and clear
 * the three audio columns (S3-4: transfer_miss_audio joins opener_audio/
 * voicemail_audio here) unconditionally -- an answered call's clips are no
 * longer needed, and an unanswered one may already have had them cleared.
 *
 * W3 (final review D2): returns the `ended_at` this UPDATE actually
 * committed (via RETURNING) -- the caller's own pre-read `ctx.endedAt` (TXN
 * 1, before this statement runs) is stale exactly when this COALESCE is the
 * thing that first sets it, and postCall.js's step 7 duration_seconds must
 * be computed from the REAL value, not a null read before it existed.
 * @param {string} attemptId
 * @param {string} resultIfUnset - 'connected' for an answered attempt whose result is still null
 * @returns {Promise<Date|null>}
 */
export async function finalizeAttemptResult(attemptId, resultIfUnset) {
  requireTenantScope("finalizeAttemptResult");
  const res = await q(
    `UPDATE call_attempts
        SET result = COALESCE(result, $2), ended_at = COALESCE(ended_at, now()),
            opener_audio = NULL, voicemail_audio = NULL, transfer_miss_audio = NULL
      WHERE id = $1
      RETURNING ended_at`,
    [attemptId, resultIfUnset]
  );
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`finalizeAttemptResult: expected 1 row, got ${res.rowCount}`);
  noteAccess("finalizeAttemptResult", { resourceIds: [attemptId], rowCount: res.rowCount });
  return res.rows[0]?.ended_at ?? null;
}

/**
 * The FINAL silent verdict (spec §13.4), written once by post-call after
 * `resolveSilentVerdict` has applied the machine exclusion and the "no
 * stream" case -- overwrites whatever `finishAttemptSession` (or the
 * column's own default, `false`, for an attempt no session ever touched)
 * left there.
 * @param {string} attemptId
 * @param {boolean} silent
 */
export async function setAttemptSilent(attemptId, silent) {
  requireTenantScope("setAttemptSilent");
  const res = await q(`UPDATE call_attempts SET silent = $2 WHERE id = $1`, [attemptId, silent]);
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`setAttemptSilent: expected 1 row, got ${res.rowCount}`);
  noteAccess("setAttemptSilent", { resourceIds: [attemptId], rowCount: res.rowCount });
}

/**
 * The silent-call block (spec §13.4): `outreach.hold_until = answered_at +
 * 72h`. Gate step 6 (`hold_until` has passed) reads this on the NEXT dispatch
 * attempt for the same outreach.
 * @param {string} outreachId
 * @param {Date} holdUntil
 */
export async function setOutreachHold(outreachId, holdUntil) {
  requireTenantScope("setOutreachHold");
  const res = await q(`UPDATE outreach SET hold_until = $2, updated_at = now() WHERE id = $1`, [outreachId, holdUntil]);
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`setOutreachHold: expected 1 row, got ${res.rowCount}`);
  noteAccess("setOutreachHold", { resourceIds: [outreachId], rowCount: res.rowCount });
}

/**
 * Post-call step 5, the state machine (spec §8, §11) -- ONE atomic UPDATE
 * that is ALSO the no-double-reschedule guard (carried from the 2a ledger):
 * dispatch's own `failAndReschedule` can already have rescheduled or closed
 * this outreach for a LATER attempt (a dial failure, then a status callback
 * for the SAME attempt arriving after it), and a later status callback or
 * the sweep must not apply the schedule a second time. The WHERE clause is
 * the guard: it only fires when the outreach is still `dialing`/`in_call`
 * AND `attemptNo` is still its latest (`attempts_made = attemptNo`) --
 * exactly the condition under which THIS attempt's own outcome is the one
 * that should decide what happens next. No separate read-then-decide: the
 * guard and the write are the same statement, so nothing can race between
 * them.
 * @param {string} outreachId
 * @param {number} attemptNo - the ATTEMPT's own attempt_no, never outreach.attempts_made
 * @param {{terminal: boolean, closeReason?: string|null, outcome?: string|null, nextAttemptAt?: Date|null}} o
 * @returns {Promise<boolean>} true iff the guard passed and the write applied
 */
export async function applyOutreachResult(outreachId, attemptNo, { terminal, closeReason = null, outcome = null, nextAttemptAt = null }) {
  requireTenantScope("applyOutreachResult");
  const res = await q(
    `UPDATE outreach
        SET state = CASE WHEN $3 THEN 'closed' ELSE 'waiting' END,
            close_reason = CASE WHEN $3 THEN $4 ELSE close_reason END,
            outcome = CASE WHEN $3 THEN $5 ELSE outcome END,
            closed_at = CASE WHEN $3 THEN now() ELSE closed_at END,
            next_attempt_at = CASE WHEN $3 THEN next_attempt_at ELSE $6 END,
            updated_at = now()
      WHERE id = $1 AND attempts_made = $2 AND state IN ('dialing','in_call')
      RETURNING id`,
    [outreachId, attemptNo, terminal, closeReason, outcome, nextAttemptAt]
  );
  if (res.error) throw res.error;
  noteAccess("applyOutreachResult", { resourceIds: [outreachId], rowCount: res.rowCount || 0 });
  return res.rowCount === 1;
}

/**
 * Effects (spec §11 step 2, P-6 tier 3): did THIS call produce a booking, or
 * did it already carry a tool-inserted opt-out suppression (the `opt_out`
 * pack's own immediate write, spec §12.2 -- stage 3, not shipped, so this
 * branch is a forward-compatible seam more than a live path today)? Both are
 * cheap, `call_id`-scoped reads; `null` (no `calls` row at all -- the
 * no-session sweep path) short-circuits to `{booked: false, optedOut:
 * false}` without a round trip.
 * @param {string|null} callId
 * @returns {Promise<{booked: boolean, optedOut: boolean}>}
 */
export async function outboundCallEffects(callId) {
  if (!callId) return { booked: false, optedOut: false };
  requireTenantScope("outboundCallEffects");
  const [booking, optOut] = await Promise.all([
    q(`SELECT id FROM appointments WHERE call_id = $1 LIMIT 1`, [callId]),
    q(`SELECT id FROM suppressions WHERE source_call_id = $1 AND created_by = 'tool' LIMIT 1`, [callId]),
  ]);
  if (booking.error) throw booking.error;
  if (optOut.error) throw optOut.error;
  noteAccess("outboundCallEffects", { resourceIds: [callId], rowCount: (booking.rowCount || 0) + (optOut.rowCount || 0) });
  return { booked: (booking.rowCount || 0) > 0, optedOut: (optOut.rowCount || 0) > 0 };
}

/**
 * The shared INSERT every suppression writer runs (spec §12.2/§13.3):
 * tenant-scoped (the caller has already run requireTenantScope), `ON
 * CONFLICT DO NOTHING` on the (business_id, phone_e164) unique -- a row
 * already suppressing this number, from ANY writer (a tool, a detector,
 * the dashboard, the API), is success, not a race to report.
 *
 * Not exported, and deliberately not a third public entry point:
 * insertSuppression and insertDetectorSuppression below are the two callers,
 * and tests/phiAuditCoverage.test.js requires each EXPORTED, classified
 * function to record its own access by name -- so each of them calls
 * noteAccess itself rather than delegating that half to this helper too.
 * @param {{phone: string, reason: string, sourceCallId: string|null, createdBy: string}} o
 */
async function writeSuppressionRow({ phone, reason, sourceCallId, createdBy }) {
  // I3 minor (review): a phone already erased/hashed (suppressions row has
  // phone_e164 = NULL, phone_hash set) is invisible to `ON CONFLICT
  // (business_id, phone_e164)` below -- a cleartext phone never conflicts
  // with a NULL one, so a second suppression write for the SAME number would
  // re-create it in the clear, undoing the point of hashing it away.
  // Ruling: the smallest safe fix is a best-effort PRE-CHECK by hash, not a
  // hard requirement on SUPPRESSION_HASH_KEY for every suppression write
  // (unlike eraseCallerData/isSuppressed, this function runs on the
  // ordinary opt-out/wrong-number path on every outbound call, and forcing
  // the key here would widen the I10 blast radius to a path that never
  // needed it before). If the phone will not normalize, or the key is
  // missing/short, this cannot rule out a hash-only match and falls through
  // to the plain insert -- the function's pre-fix behaviour for every case
  // it has always handled.
  try {
    const canonical = normalizePhoneNumber(phone);
    if (canonical) {
      const hash = suppressionHash(canonical);
      const existing = await q(`SELECT id FROM suppressions WHERE business_id = app_current_business_id() AND phone_hash = $1`, [hash]);
      if (existing.error) throw existing.error;
      if ((existing.rows || []).length > 0) {
        // Already suppressed, by hash -- success, no cleartext row written.
        return { rowCount: 0, rows: [] };
      }
    }
  } catch {
    // Missing/short key, or a non-normalizing phone: fall through.
  }
  const res = await q(
    `INSERT INTO suppressions (business_id, phone_e164, reason, source_call_id, created_by)
     SELECT app_current_business_id(), $1, $2, $3, $4
     ON CONFLICT (business_id, phone_e164) DO NOTHING
     RETURNING id`,
    [phone, reason, sourceCallId, createdBy]
  );
  if (res.error) throw res.error;
  return res;
}

/**
 * S3-3 (spec §12.2): the general suppression writer -- a TOOL recording a
 * do-not-call reason immediately, inside its own tenant scope
 * (services/tools.js's executeToolCallGuarded already holds one open for the
 * whole call). Used by capabilities/optOut.js (reason `opted_out`, created_by
 * `tool`) and capabilities/outcome.js's wrong_number branch (reason
 * `wrong_number`, created_by `tool`) -- the wrong-number suppression writer,
 * a must-hold.
 * @param {{phone: string, reason: "opted_out"|"wrong_number"|"complaint"|"manual"|"tps", sourceCallId?: string|null, createdBy: "tool"|"detector"|"dashboard"|"api"}} o
 * @returns {Promise<boolean>} true iff THIS call inserted the row
 */
export async function insertSuppression({ phone, reason, sourceCallId = null, createdBy }) {
  requireTenantScope("insertSuppression");
  const res = await writeSuppressionRow({ phone, reason, sourceCallId, createdBy });
  noteAccess("insertSuppression", { resourceIds: [res.rows?.[0]?.id].filter(Boolean), rowCount: res.rowCount || 0 });
  return res.rowCount === 1;
}

/**
 * The opt-out detector's own write (spec §13.3 step 2): a suppression the
 * DETECTOR found, not the tool. A thin wrapper over the SAME insert
 * insertSuppression uses, with the detector's fixed reason/created_by --
 * `ON CONFLICT DO NOTHING` -- a business-scoped unique (business_id,
 * phone_e164) may already hold one (the tool got there first, or an earlier
 * call's detector did), and that is success, not a race to report.
 * @param {{phone: string, sourceCallId: string|null}} o
 * @returns {Promise<boolean>} true iff THIS call inserted the row
 */
export async function insertDetectorSuppression({ phone, sourceCallId = null }) {
  requireTenantScope("insertDetectorSuppression");
  const res = await writeSuppressionRow({ phone, reason: "opted_out", sourceCallId, createdBy: "detector" });
  noteAccess("insertDetectorSuppression", { resourceIds: [res.rows?.[0]?.id].filter(Boolean), rowCount: res.rowCount || 0 });
  return res.rowCount === 1;
}

/**
 * Every kind of stale outbound attempt, across every tenant (the sweep,
 * spec §6.3, migration 045): ids and a `kind` word only, through
 * `app_outbound_stale_attempts`. No tenant scope needed -- same reasoning as
 * `outboundDue`.
 * @param {number} limit
 * @param {number} sidlessMinutes
 * @param {number} lostMinutes
 * @param {number} postcallSeconds
 * @returns {Promise<Array<{business_id: string, attempt_id: string, kind: "sidless"|"lost_callback"|"postcall_pending"}>>}
 */
export async function outboundStaleAttempts(limit, sidlessMinutes, lostMinutes, postcallSeconds) {
  const res = await q(`SELECT business_id, attempt_id, kind FROM app_outbound_stale_attempts($1::int, $2::int, $3::int, $4::int)`, [
    limit,
    sidlessMinutes,
    lostMinutes,
    postcallSeconds,
  ]);
  if (res.error) throw res.error;
  return res.rows || [];
}

// ---------------------------------------------------------------------------
// S3-8: the shared results channel (spec §12.5, amended §19 S3-D3) -- over
// migration 042's `webhook_endpoints` and `outbox`. Both are RLS-forced
// (database/schema.sql ~1496-1535, already granted SELECT/INSERT/UPDATE/
// DELETE to vetra_app), so every function here is a plain tenant-scoped
// query -- no new migration, no definer function, exactly the S3-8 brief's
// "no inbound wiring / no schema change" posture.
//
// `webhook_endpoints`/`listActiveWebhookEndpoints`/`getWebhookEndpoint` hold
// no caller data at all -- a URL, a ciphertext blob and an events list, the
// tenant's own configuration -- so they are classified NON_PHI_EXPORTS
// below, the same rule `listIntegrationsForBusiness` already gets.
// `markOutboxDelivered`/`markOutboxRetry`/`markOutboxDead` touch only
// delivery bookkeeping columns (status/attempts/next_attempt_at/last_error),
// never the row's `payload` -- the same "telemetry about the system, not the
// interaction" rule `updateCallLatency` gets. `insertOutboxRow` and
// `getOutboxRow` DO touch `payload` (it carries the contact's phone, name
// and answers), so both are PHI_ACCESS.
// ---------------------------------------------------------------------------

/**
 * Endpoints subscribed to `eventType`: active, and either no explicit event
 * filter at all (an empty `events` array is read as "every event" -- Ruling
 * S3-8, so creating an endpoint with `--events` omitted is a sane default
 * rather than a silent no-op) or one that names `eventType`.
 *
 * D7 (final review, least privilege): never selects `secret_ciphertext`.
 * postCall.js's step 7 (this function's only caller) uses only `ep.id` (to
 * stamp the outbox row's `target_id`) -- it never decrypts anything at
 * insert time, so there is no reason for the plaintext-adjacent ciphertext
 * to pass through this process's memory at all. `getWebhookEndpoint`
 * (below) is the one function that legitimately returns it, at actual
 * delivery time.
 * @param {string} eventType
 * @returns {Promise<Array<{id: string, url: string}>>}
 */
export async function listActiveWebhookEndpoints(eventType) {
  requireTenantScope("listActiveWebhookEndpoints");
  const res = await q(
    `SELECT id, url
       FROM webhook_endpoints
      WHERE active = true AND (events = '{}' OR $1 = ANY(events))`,
    [eventType]
  );
  if (res.error) throw res.error;
  return res.rows || [];
}

/**
 * One endpoint, tenant-scoped -- the delivery task handler's own lookup by
 * id (it only ever holds an id, from the outbox row's `target_id`).
 * @param {string} id
 * @returns {Promise<{id: string, url: string, secret_ciphertext: Buffer, active: boolean} | null>}
 */
export async function getWebhookEndpoint(id) {
  requireTenantScope("getWebhookEndpoint");
  const res = await q(`SELECT id, url, secret_ciphertext, active FROM webhook_endpoints WHERE id = $1`, [id]);
  if (res.error) throw res.error;
  return one(res);
}

/**
 * Insert one outbox row. `id` is generated by the CALLER (postCall.js), not
 * left to the column default, because the id is also the payload's own
 * `delivery_id` (spec §12.5) and the `X-Vetra-Delivery` header -- both are
 * fixed at the moment the row is built, before it is known whether this
 * insert will land or be swallowed by the idempotency conflict below.
 *
 * `ON CONFLICT (business_id, idempotency_key) DO NOTHING`: a retried
 * post-call claim (the exactly-once wrapper's own retry path, or the
 * sweep's `postcall_pending` backstop) building the SAME event for the SAME
 * endpoint a second time is a no-op, never a duplicate delivery.
 * @param {{id: string, kind: "webhook"|"crm", targetId: string, eventType: string, payload: object, idempotencyKey: string, nextAttemptAt?: Date}} o
 * @returns {Promise<{inserted: boolean, id: string}>}
 */
export async function insertOutboxRow({ id, kind, targetId, eventType, payload, idempotencyKey, nextAttemptAt = null }) {
  requireTenantScope("insertOutboxRow");
  const res = await q(
    `INSERT INTO outbox (id, business_id, kind, target_id, event_type, payload, idempotency_key, status, attempts, next_attempt_at)
     SELECT $1, app_current_business_id(), $2, $3, $4, $5::jsonb, $6, 'pending', 0, COALESCE($7, now())
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [id, kind, targetId, eventType, JSON.stringify(payload), idempotencyKey, nextAttemptAt]
  );
  if (res.error) throw res.error;
  const inserted = res.rowCount === 1;
  noteAccess("insertOutboxRow", { resourceIds: [id], rowCount: res.rowCount || 0 });
  return { inserted, id };
}

/**
 * One outbox row, tenant-scoped -- the delivery task handler's read before
 * attempting a delivery. Includes `payload` (why this is PHI_ACCESS, unlike
 * the three status-only writers below).
 * @param {string} id
 * @returns {Promise<{id: string, kind: string, target_id: string, event_type: string,
 *   payload: object, status: string, attempts: number, next_attempt_at: Date|null} | null>}
 */
export async function getOutboxRow(id) {
  requireTenantScope("getOutboxRow");
  const res = await q(
    `SELECT id, kind, target_id, event_type, payload, status, attempts, next_attempt_at FROM outbox WHERE id = $1`,
    [id]
  );
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("getOutboxRow", { resourceIds: [id], rowCount: res.rowCount || 0 });
  return row;
}

/**
 * Outbox rows due for delivery, ACROSS ALL TENANTS (S3-8 fix round 1, I3(a)
 * -- the sweep's cross-tenant webhook backstop, migration 050, the
 * app_outbound_due pattern applied to `outbox`). Reads the outbox_schedule
 * directory through app_outbound_webhook_due: ids and a business id only, so
 * this needs no tenant scope -- same reasoning as outboundDue.
 * @param {number} limit
 * @param {number} graceSeconds
 * @returns {Promise<Array<{business_id: string, outbox_id: string}>>}
 */
export async function outboundWebhookDue(limit, graceSeconds) {
  const res = await q(`SELECT business_id, outbox_id FROM app_outbound_webhook_due($1::int, $2::int)`, [limit, graceSeconds]);
  if (res.error) throw res.error;
  return res.rows || [];
}

/**
 * Mark ONE outbox row delivered. Guarded on `status = 'pending'`: a row
 * already `dead` (or somehow already `delivered`, a retried/duplicated
 * delivery task) can never be moved BACK to delivered by a late success --
 * named risk 7 ("retries past dead" / "marks delivered on failure").
 * @param {string} id
 * @returns {Promise<boolean>} true iff this call made the write
 */
export async function markOutboxDelivered(id) {
  requireTenantScope("markOutboxDelivered");
  const res = await q(`UPDATE outbox SET status = 'delivered', delivered_at = now() WHERE id = $1 AND status = 'pending'`, [id]);
  if (res.error) throw res.error;
  return res.rowCount === 1;
}

/**
 * Record one failed delivery attempt that WILL retry: `attempts`,
 * `next_attempt_at` (the backoff schedule's next slot) and `last_error` (a
 * status code or error class only -- never a vendor message). Guarded on
 * `status = 'pending'` for the same reason markOutboxDelivered is, AND
 * (fix round 1, I2) on `attempts = $expectedAttempts` -- a compare-and-set.
 * Two concurrent deliveries of the SAME row (an early task racing the real
 * one, or a genuine Cloud Tasks at-least-once redelivery) both read the same
 * `attempts` and both compute `attempts + 1`; without this guard the SECOND
 * write still matches `status = 'pending'` (this function never changes
 * status) and clobbers the first with a STALE value instead of losing the
 * race cleanly. The caller (lib/outbound/internalRoutes.js) reads the
 * boolean and skips its counter/re-enqueue when this returns false.
 * @param {string} id
 * @param {{attempts: number, nextAttemptAt: Date, lastError: string, expectedAttempts: number}} o
 * @returns {Promise<boolean>}
 */
export async function markOutboxRetry(id, { attempts, nextAttemptAt, lastError, expectedAttempts }) {
  requireTenantScope("markOutboxRetry");
  const res = await q(
    `UPDATE outbox SET attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $1 AND status = 'pending' AND attempts = $5`,
    [id, attempts, nextAttemptAt, lastError, expectedAttempts]
  );
  if (res.error) throw res.error;
  return res.rowCount === 1;
}

/**
 * Mark ONE outbox row dead: the backoff schedule is exhausted (S3-8's
 * BACKOFF_SCHEDULE_MS, lib/connections/outbox.js). Terminal -- nothing ever
 * moves a row OUT of `dead` (named risk 7: "retries past dead"). Same
 * compare-and-set as markOutboxRetry (fix round 1, I2) when the caller
 * supplies `expectedAttempts` -- the endpoint-unavailable/inactive path
 * always does; older callers that omit it fall back to the pre-existing
 * `status = 'pending'`-only guard (`expectedAttempts` undefined makes the
 * SQL's `attempts = $5` compare against NULL, which SQL never matches, so
 * this is written as an explicit optional clause rather than relying on
 * that).
 * @param {string} id
 * @param {{attempts: number, lastError: string, expectedAttempts?: number}} o
 * @returns {Promise<boolean>}
 */
export async function markOutboxDead(id, { attempts, lastError, expectedAttempts }) {
  requireTenantScope("markOutboxDead");
  const res =
    expectedAttempts === undefined
      ? await q(`UPDATE outbox SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1 AND status = 'pending'`, [
          id,
          attempts,
          lastError,
        ])
      : await q(
          `UPDATE outbox SET status = 'dead', attempts = $2, last_error = $3 WHERE id = $1 AND status = 'pending' AND attempts = $4`,
          [id, attempts, lastError, expectedAttempts]
        );
  if (res.error) throw res.error;
  return res.rowCount === 1;
}

/**
 * The booking this call produced, if any (spec §12.5's `booking` field):
 * the appointment id and its scheduled start, by call id. `length_min` is
 * not sourced here -- the schema carries no service-duration column
 * (Parked, this task's report) -- callers set it null.
 * @param {string|null} callId
 * @returns {Promise<{id: string, scheduled_at: Date} | null>}
 */
export async function outboundBookingInfo(callId) {
  if (!callId) return null;
  requireTenantScope("outboundBookingInfo");
  const res = await q(`SELECT id, scheduled_at FROM appointments WHERE call_id = $1 ORDER BY created_at DESC LIMIT 1`, [callId]);
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("outboundBookingInfo", { resourceIds: [callId, row?.id].filter(Boolean), rowCount: res.rowCount || 0 });
  return row;
}

/**
 * The two labels the results payload needs that `outboundPostCallContext`
 * does not carry (Ruling S3-8: a second, tiny lookup by id rather than
 * widening that shared, heavily-depended-on query): the campaign's own
 * `name`, and the contact's `first_name`/`external_ids` -- spec §12.5's
 * `campaign.name` and `contact.first_name`/`contact.external_ids`. Both ids
 * are already on `ctx` (campaignId, contactId), so this is one more short
 * read, not a join added to the post-call context.
 * @param {{campaignId: string, contactId: string}} o
 * @returns {Promise<{campaignName: string|null, contactFirstName: string|null, contactExternalIds: object}>}
 */
export async function outboundResultsLabels({ campaignId, contactId }) {
  requireTenantScope("outboundResultsLabels");
  const res = await q(
    `SELECT (SELECT name FROM campaigns WHERE id = $1) AS campaign_name,
            (SELECT first_name FROM contacts WHERE id = $2) AS contact_first_name,
            (SELECT external_ids FROM contacts WHERE id = $2) AS contact_external_ids`,
    [campaignId, contactId]
  );
  if (res.error) throw res.error;
  const row = one(res) || {};
  noteAccess("outboundResultsLabels", { resourceIds: [campaignId, contactId].filter(Boolean), rowCount: res.rowCount || 0 });
  return {
    campaignName: row.campaign_name ?? null,
    contactFirstName: row.contact_first_name ?? null,
    contactExternalIds: row.contact_external_ids ?? {},
  };
}

// ---------------------------------------------------------------------------
// S3-9 (spec §12.1): the leads-in link, POST /v1/triggers/:triggerToken
// (lib/outbound/triggerRoute.js). Migration 049.
// ---------------------------------------------------------------------------

/**
 * Resolve a leads-in trigger token's SHA-256 hash to its campaign and tenant,
 * through `app_campaign_by_trigger_hash` (migration 049) -- the SAME
 * no-RLS-directory-plus-SECURITY-DEFINER pattern `outboundAttemptByCallSid`
 * uses above, for the identical reason: the tenant is not known yet. Own
 * transaction, own client -- `withTenant` cannot be used before a businessId
 * exists.
 *
 * Returns the directory's own `trigger_token_hash` alongside the ids, so the
 * caller can re-verify the match with a constant-time comparator
 * (lib/outbound/triggerRoute.js's `compareTokenHash`) rather than trusting
 * the SQL equality alone.
 *
 * NON_PHI_EXPORTS (lib/phiAudit.js): ids and a hash only, never a phone
 * number or a name -- the same reasoning `outboundAttemptByCallSid` is
 * exempt under.
 * @param {string} hash - sha256(rawToken), hex
 * @returns {Promise<{businessId:string, campaignId:string, triggerTokenHash:string}|null>} null on a miss (including an unusable/empty hash)
 */
export async function campaignByTriggerHash(hash) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `SELECT business_id, campaign_id, trigger_token_hash FROM app_campaign_by_trigger_hash($1)`,
      [hash]
    );
    await client.query("COMMIT");
    const row = res.rows?.[0];
    if (!row) return null;
    return { businessId: row.business_id, campaignId: row.campaign_id, triggerTokenHash: row.trigger_token_hash };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The campaign facts the trigger route needs: its compliance class (consent
 * is required unless it is `service`), and the CURRENT version's
 * `details_fields` (S3-6). Read defensively -- a config with no
 * `details_fields` array (an older campaign version saved before S3-6, or a
 * malformed one) gives `[]`, so every key the trigger body's `data` carries
 * becomes an ignored field rather than a thrown error (Ruling S3-9, named
 * risk 5's mirror: absent config must never read as "copy everything"
 * either). Runs inside `withTenant` -- the caller resolves the tenant first
 * via `campaignByTriggerHash`.
 * @param {string} campaignId
 * @returns {Promise<{complianceClass:string, status:string, currentVersion:number, detailsFields:Array<{key:string,label:string}>}|null>}
 */
export async function campaignForTrigger(campaignId) {
  requireTenantScope("campaignForTrigger");
  const res = await q(
    `SELECT c.compliance_class, c.status, c.current_version, v.config, b.allow_pricier_numbers
       FROM campaigns c
       JOIN campaign_versions v ON v.campaign_id = c.id AND v.version = c.current_version
       JOIN businesses b ON b.id = c.business_id
      WHERE c.id = $1`,
    [campaignId]
  );
  if (res.error) throw res.error;
  const row = one(res);
  if (!row) return null;
  const fields = Array.isArray(row.config?.details_fields) ? row.config.details_fields : [];
  return {
    complianceClass: row.compliance_class,
    status: row.status,
    currentVersion: row.current_version,
    allowPricierNumbers: row.allow_pricier_numbers === true,
    detailsFields: fields.filter((f) => f && typeof f.key === "string" && typeof f.label === "string"),
  };
}

/**
 * Upsert the contact a leads-in trigger names -- the SAME COALESCE-on-absent-
 * field shape `scripts/outbound-admin.js`'s `triggerOutreach` uses, so a
 * re-post that omits a field (e.g. no email on a later submission) keeps
 * what is already on file rather than wiping it. Runs inside `withTenant`.
 * @param {{phone:string, firstName:string|null, lastName:string|null, email:string|null, timezone:string|null}} o
 * @returns {Promise<string>} contactId
 */
export async function upsertContactForTrigger({ phone, firstName, lastName, email, timezone }) {
  requireTenantScope("upsertContactForTrigger");
  const res = await q(
    `INSERT INTO contacts (business_id, phone_e164, first_name, last_name, email, timezone)
     SELECT app_current_business_id(), $1, $2, $3, $4, $5
     ON CONFLICT (business_id, phone_e164) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
       last_name  = COALESCE(EXCLUDED.last_name, contacts.last_name),
       email      = COALESCE(EXCLUDED.email, contacts.email),
       timezone   = COALESCE(EXCLUDED.timezone, contacts.timezone),
       updated_at = now()
     RETURNING id`,
    [phone, firstName, lastName, email, timezone]
  );
  if (res.error) throw res.error;
  const row = one(res);
  if (!row) throw new Error("upsertContactForTrigger: expected 1 row");
  noteAccess("upsertContactForTrigger", { resourceIds: [row.id], rowCount: res.rowCount || 0 });
  return row.id;
}

/**
 * Record the consent block a leads-in trigger posts. `source` is always
 * `'api'` here -- this is a form/webhook submission, never
 * `scripts/outbound-admin.js`'s own operator `'manual'` entry or an inbound
 * call. Runs inside `withTenant`.
 * @param {{contactId:string, purpose:string, channels:string[], coversAutomated:boolean, sourceRef:string|null, wordingVersion:string|null, wordingText:string|null, capturedAt:Date}} o
 * @returns {Promise<string>} consentId
 */
export async function recordTriggerConsent({
  contactId,
  purpose,
  channels,
  coversAutomated,
  sourceRef,
  wordingVersion,
  wordingText,
  capturedAt,
}) {
  requireTenantScope("recordTriggerConsent");
  const res = await q(
    `INSERT INTO consents (business_id, contact_id, purpose, channels, covers_automated, source, source_ref, wording_version, wording_text, captured_at)
     SELECT app_current_business_id(), $1, $2, $3, $4, 'api', $5, $6, $7, $8
     RETURNING id`,
    [contactId, purpose, channels, coversAutomated, sourceRef, wordingVersion, wordingText, capturedAt]
  );
  if (res.error) throw res.error;
  const row = one(res);
  if (!row) throw new Error("recordTriggerConsent: expected 1 row");
  noteAccess("recordTriggerConsent", { resourceIds: [contactId, row.id], rowCount: res.rowCount || 0 });
  return row.id;
}

/**
 * Create the outreach a leads-in trigger requests, IDEMPOTENTLY: `ON
 * CONFLICT (business_id, idempotency_key) DO NOTHING`, then a plain SELECT
 * for the id either way -- a replay of the SAME idempotency_key returns the
 * SAME outreach_id rather than a second row (or an error).
 * `next_attempt_at = now()`: `app_outbound_due` (migration 044) and the
 * dispatcher both treat a NULL as "not due". C13 (review): this function
 * itself still does not enqueue anything (it is a plain DB write, no I/O
 * beyond SQL) -- but the CALLER (lib/outbound/triggerRoute.js, fix round 1
 * I2, controller ruling) now DOES enqueue a dispatch task right after a
 * first creation, superseding Ruling S3-9b's "no enqueue at all, the
 * 5-minute sweep is the only trigger" -- the sweep remains the fail-soft
 * backstop for that enqueue, not the sole path. `details` carries only the
 * keys the caller already filtered against the campaign's `details_fields`
 * -- this function does not re-filter. Runs inside `withTenant`.
 * @param {{campaignId:string, campaignVersion:number, contactId:string, trigger:object, idempotencyKey:string, details:object}} o
 * @returns {Promise<{id:string, created:boolean}>}
 */
export async function createOutreachFromTrigger({ campaignId, campaignVersion, contactId, trigger, idempotencyKey, details }) {
  requireTenantScope("createOutreachFromTrigger");
  const ins = await q(
    `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, next_attempt_at, trigger, idempotency_key, details)
     SELECT app_current_business_id(), $1, $2, $3, 'waiting', now(), $4::jsonb, $5, $6::jsonb
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [campaignId, campaignVersion, contactId, JSON.stringify(trigger || {}), idempotencyKey, JSON.stringify(details || {})]
  );
  if (ins.error) throw ins.error;
  if (ins.rowCount === 1) {
    noteAccess("createOutreachFromTrigger", { resourceIds: [ins.rows[0].id], rowCount: 1 });
    return { id: ins.rows[0].id, created: true };
  }
  const sel = await q(`SELECT id FROM outreach WHERE business_id = app_current_business_id() AND idempotency_key = $1`, [idempotencyKey]);
  if (sel.error) throw sel.error;
  const row = one(sel);
  if (!row) throw new Error("createOutreachFromTrigger: idempotency conflict but no row found");
  noteAccess("createOutreachFromTrigger", { resourceIds: [row.id], rowCount: sel.rowCount || 0 });
  return { id: row.id, created: false };
}
