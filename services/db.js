import pg from "pg";
import { captureException } from "../lib/sentry.js";
import { log } from "../lib/logger.js";
import { allCapabilityToolNames, getPack } from "../capabilities/index.js";
import { validateCapabilityConfig } from "../lib/capabilities/configSchema.js";
import { normalizePhoneNumber } from "../lib/phone.js";

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
  log.error("database_not_configured", { reason: "missing_database_url", severity: "warn" });
}

/** @returns {boolean} Whether the database is configured */
export function isEnabled() {
  return pool !== null;
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
  try {
    const res = await pool.query(text, params);
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
  const res = await q(`SELECT id, business_id, email, role FROM users WHERE email = $1 LIMIT 1`, [email]);
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
  const res = await q(`${BUSINESS_WITH_CAPABILITIES} WHERE b.phone_number = $1 LIMIT 1`, [value]);

  if (res.error) {
    // An un-migrated database has no business_capabilities table, and the
    // subquery makes the whole statement fail rather than returning the
    // business without it. Falling back to the plain select keeps calls
    // answerable during a partial deploy — the dual-read then uses
    // allowed_tasks. This branch is the reason the capability fetch is a
    // subquery in a string and not a JOIN somebody could "simplify".
    log.error("db_error", { operation: "lookupBusinessByPhone", error: res.error.message });
    const plain = await q(`SELECT * FROM businesses WHERE phone_number = $1 LIMIT 1`, [value]);
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
  return one(res).id;
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
  }
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
  }
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
  }
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
  return one(res).id;
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
    return list.filter((r) => {
      const p = (r.client_phone || "").replace(/\D/g, "").trim();
      return p && p.slice(-10) === phone.slice(-10);
    });
  }
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
  return one(res);
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
  return one(res) != null;
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
  return one(res) != null;
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
  return one(res).id;
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

/**
 * Close the pool. Tests and short-lived scripts need this or the process hangs
 * on an open connection; the server never calls it.
 */
export async function close() {
  if (pool) await pool.end();
}
