import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { allCapabilityToolNames, getPack } from "../capabilities/index.js";
import { validateCapabilityConfig } from "../lib/capabilities/configSchema.js";
import { normalizePhoneNumber } from "../lib/phone.js";
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
    // The volume matters too, and it is what makes an ungated version wrong
    // rather than merely noisy. Some PHI writes happen per TURN — a transcript
    // entry is one — and services/db.js's own rule is "wrap a unit of work,
    // never a call", so those writes are outside withTenant BY DESIGN. An
    // ungated line would therefore fire on every turn of every call, forever,
    // reporting intended behaviour as a fault. An alarm that is always on is
    // one nobody reads.
    //
    // KNOWN GAP, recorded rather than papered over: in `hipaa` mode those
    // per-turn writes still need a home. The fix is B2's — wrap each one in its
    // own short unit of work, which is three extra statements on a path already
    // measured at 2,611 ms p50 — not a change to this line.
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
      languagesSpoken: ["en"],
      customInstructions: null,
      voiceProvider: "elevenlabs",
      voiceId: null,
      smsFollowupEnabled: false,
      smsTemplates: {},
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
    languagesSpoken: Array.isArray(business.languages_spoken) ? business.languages_spoken : ["en"],
    customInstructions: business.custom_instructions || null,
    voiceProvider: business.voice_provider || "elevenlabs",
    voiceId: business.voice_id || null,
    smsFollowupEnabled: !!business.sms_followup_enabled,
    smsTemplates: (business.sms_templates && typeof business.sms_templates === "object") ? business.sms_templates : {},
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
export async function fetchUserByEmail(email) {
  if (!pool || !email) return null;
  // Through app_lookup_user_by_email (migration 029), not a plain SELECT.
  //
  // This is a BOOTSTRAP read: it is how the tenant becomes known, so it cannot
  // be scoped to a tenant. Under row-level security a direct select returns
  // nothing and nobody can authenticate. The SECURITY DEFINER function is the
  // narrow, named exception — one row, pinned search_path — instead of a policy
  // that would make "forgot to scope" mean "may see everything".
  const res = await q(`SELECT * FROM app_lookup_user_by_email($1)`, [email]);
  if (res.error) {
    log.error("db_error", { operation: "fetchUserByEmail", error: res.error.message });
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

/**
 * Insert a new call row.
 * @param {string} businessId
 * @param {string} callSid - Twilio Call SID
 * @param {string} callerNumber - From number
 * @param {string} twilioNumber - To number
 * @returns {Promise<string|null>} The new call's UUID or null on failure
 */
export async function createCall(businessId, callSid, callerNumber, twilioNumber) {
  if (!pool) return null;
  const res = await q(
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
  const res = await q(`UPDATE calls SET status = 'transferred' WHERE twilio_call_sid = $1`, [callSid]);
  if (res.error) {
    log.error("db_error", { callSid, operation: "markCallTransferred", error: res.error.message });
    captureException(new Error(res.error.message), { table: "calls", op: "update_transferred" });
    return;
  }
  noteAccess("markCallTransferred", { rowCount: res.rowCount || 0 });
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
    return [];
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
 * Fetch caller context for personalization — recent call history and upcoming appointments.
 * Used to inject "returning caller" context into the AI prompt and to power
 * the dashboard caller profile view.
 * @param {string} businessId
 * @param {string} callerNumber - Caller's phone number (E.164)
 * @returns {Promise<{ callCount: number, lastCallSummary: string|null, upcomingAppointments: Array }>}
 */
export async function fetchCallerContext(businessId, callerNumber) {
  const empty = { callCount: 0, lastCallSummary: null, upcomingAppointments: [] };
  if (!pool || !businessId || !callerNumber) return empty;

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
    listAppointmentsByCaller(businessId, { clientPhone: callerNumber, upcomingOnly: true }),
  ]);

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
  return { callCount: calls.length, lastCallSummary, upcomingAppointments };
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
 * set_call_intent and end_call are engine-owned (they drive the step machine
 * itself, not any capability) so they are named explicitly.
 */
export const BUILTIN_TOOL_NAMES = ["set_call_intent", "end_call", ...allCapabilityToolNames()];

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
 * Every PHI-bearing row this system holds about one caller, for one tenant.
 *
 * Tenant-scoped unconditionally. A phone number is not a secret and neither is
 * a business UUID, so an unscoped export would be a cross-tenant read dressed
 * up as a compliance feature.
 *
 * @param {string} businessId
 * @param {string} phone
 * @returns {Promise<{calls: Array, transcripts: Array, appointments: Array, customerRequests: Array}|null>}
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
            duration_seconds, summary, sentiment, outcome
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

  noteAccess("exportCallerData", {
    resourceIds: calls.rows.map((c) => c.id),
    rowCount:
      calls.rows.length + transcripts.rows.length + appointments.rows.length + requests.rows.length,
  });

  return {
    calls: calls.rows,
    transcripts: transcripts.rows,
    appointments: appointments.rows,
    customerRequests: requests.rows,
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
 *
 * ONE TRANSACTION. A partial erasure is the worst outcome available: it reports
 * success, satisfies nobody, and leaves the controller believing a request was
 * honoured.
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
 * @returns {Promise<{transcripts: number, calls: number, appointments: number, customerRequests: number}|null>}
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

    const c = callIds.length
      ? await client.query(`UPDATE calls SET caller_number = NULL, summary = NULL WHERE id = ANY($1)`, [callIds])
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

    if (!scoped) await client.query("COMMIT");

    const counts = {
      transcripts: t.rowCount,
      calls: c.rowCount,
      appointments: a.rowCount,
      customerRequests: r.rowCount,
    };
    // The audit trail an erasure needs, carrying no phone number — the thing
    // being erased must not be written to a log in the act of erasing it.
    log.info("dsr_erasure_completed", { businessId, ...counts });
    noteAccess("eraseCallerData", {
      resourceIds: callIds,
      rowCount: t.rowCount + c.rowCount + a.rowCount + r.rowCount,
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
