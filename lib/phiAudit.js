import { isPhiField } from "./phiFields.js";

// ---------------------------------------------------------------------------
// §164.312(b) audit controls — the pure half.
//
// The classification, the validation and the merge rule live here; the
// AsyncLocalStorage wiring and the INSERT live in services/db.js next to
// withTenant, which is the only thing that knows when a unit of work starts and
// ends.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS A PHI ACCESS
// ---------------------------------------------------------------------------
// The line, stated once so it can be argued with instead of guessed at:
//
//   A PHI access reads, writes, or destroys data ABOUT THE CALLER OR THEIR CARE.
//
// That is narrower than "touched a table that contains PHI" and wider than
// "returned a name". Two consequences worth naming, because both look wrong
// until the rule is applied:
//
//   updateCallLatency writes p50/p95 numbers onto a `calls` row and is NOT an
//   access. It is telemetry about the SYSTEM, not about the interaction. Auditing
//   it would add one row per completed call to a trail whose value is that a
//   human can read it.
//
//   countScheduledOverlapping and listScheduledBetween query the `appointments`
//   table and are NOT accesses. They ask "is this slot free", return a count and
//   a list of start times, and never select a name or a phone number. A query
//   that never fetches an identity cannot disclose one — the same argument A1.3
//   used to make the Brevo digest a count(*).
//
// Getting this line wrong in the permissive direction produces an audit trail
// nobody reads, which is the same as not having one.
// ---------------------------------------------------------------------------

/**
 * Data-layer functions that access PHI, with what they touch and how.
 *
 * Keyed by the exported function name so tests/phiAuditCoverage.test.js can
 * check the map against the module's real exports in both directions.
 *
 * @type {Record<string, { action: "read"|"write"|"export"|"erase", resources: string[] }>}
 */
export const PHI_ACCESS = Object.freeze({
  // Calls — the record that an interaction happened, and what was said in it.
  createCall: { action: "write", resources: ["calls"] },
  completeCall: { action: "write", resources: ["calls"] },
  markCallTransferred: { action: "write", resources: ["calls"] },
  updateCallSummary: { action: "write", resources: ["calls"] },
  addTranscriptEntry: { action: "write", resources: ["call_transcripts"] },
  fetchCallTranscript: { action: "read", resources: ["call_transcripts"] },

  // Appointments — a named person, at a time, with notes.
  createAppointment: { action: "write", resources: ["appointments"] },
  createAppointmentIfAvailable: { action: "write", resources: ["appointments"] },
  listAppointmentsByCaller: { action: "read", resources: ["appointments"] },
  getAppointmentById: { action: "read", resources: ["appointments"] },
  updateAppointmentStatus: { action: "write", resources: ["appointments"] },
  updateAppointment: { action: "write", resources: ["appointments"] },

  // Messages and callbacks the caller left.
  createCustomerRequest: { action: "write", resources: ["customer_requests"] },

  // Consent to be texted (migration 037). A row is a caller's phone number and
  // a decision they made about their own care communications, which is squarely
  // "data ABOUT THE CALLER" under the rule above — and the read is the gate that
  // decides whether their name and appointment time leave the system over an
  // unsecured channel, so it is the last access before the most exposed
  // disclosure this product makes. Auditing it is the point.
  recordSmsConsent: { action: "write", resources: ["sms_consents"] },
  latestSmsConsent: { action: "read", resources: ["sms_consents"] },

  // Reads message bodies to find what Twilio still holds. A read of the
  // caller's own words, even though only a URL is wanted out of it — the audit
  // record describes what was fetched, not what was used.
  listCallerRecordingMessages: { action: "read", resources: ["customer_requests"] },

  // The prompt's view of who is calling: prior summaries and upcoming
  // appointments. This is the largest routine disclosure in the voice path.
  fetchCallerContext: { action: "read", resources: ["calls", "appointments"] },

  // The two data-subject rights. Both are whole-subject operations, which is
  // why they rank above an ordinary read and an ordinary write.
  exportCallerData: {
    action: "export",
    resources: ["calls", "call_transcripts", "appointments", "customer_requests", "sms_consents"],
  },
  eraseCallerData: {
    action: "erase",
    resources: ["calls", "call_transcripts", "appointments", "customer_requests", "sms_consents"],
  },
});

/**
 * Exported data functions that are NOT PHI accesses, and why.
 *
 * Listed rather than inferred. "It looked like config" is the judgement this
 * set exists to stop anyone making silently.
 *
 *   fetchBusinessById, fetchBusinessCapabilities, fetchBusinessKnowledge,
 *   lookupBusinessByPhone, updateBusinessPhoneNumber
 *       the tenant's own configuration. The covered entity is the log's
 *       subject, not a patient.
 *   fetchUserByAuthUid
 *       a workforce identity, and the bootstrap that makes scoping possible at
 *       all. Auditing the lookup that establishes the tenant would emit a row
 *       before there is a tenant to attribute it to.
 *   listIntegrationsForBusiness, getIntegrationByName,
 *   createOrUpdateIntegration, deleteIntegration
 *       per-tenant integration configuration and credentials. Sensitive, and
 *       not patient data.
 *   updateCallLatency
 *       system telemetry — see the rule above.
 *   countScheduledOverlapping, listScheduledBetween
 *       availability, with no subject — see the rule above.
 */
export const NON_PHI_EXPORTS = Object.freeze(
  new Set([
    "fetchBusinessById",
    "fetchBusinessCapabilities",
    "fetchBusinessKnowledge",
    "lookupBusinessByPhone",
    "updateBusinessPhoneNumber",
    "fetchUserByAuthUid",
    "listIntegrationsForBusiness",
    "getIntegrationByName",
    "createOrUpdateIntegration",
    "deleteIntegration",
    "updateCallLatency",
    "countScheduledOverlapping",
    "listScheduledBetween",
    // Infrastructure, not data access. Builds the connection pool against Cloud
    // SQL at startup and reads nothing — auditing it would put one row in the
    // trail per process start, describing a connection rather than an access.
    //
    // The distinction this list encodes: a PHI access reads, writes or destroys
    // data ABOUT THE CALLER OR THEIR CARE. Opening a socket is not that, however
    // much patient data eventually crosses it.
    "initCloudSqlPool",
    // Same category, and the same caveat stated once more because this one
    // HANDS OUT the pool rather than building it. It returns a handle and reads
    // nothing; a row in the trail would describe a function call, not an access.
    //
    // What it does mean is that its one caller — the Postgres call-state store
    // — is outside `withTenant` and therefore unscoped. That is safe for exactly
    // one reason: `call_state` holds no caller data and carries no policy,
    // because it is read before the tenant is known (database/038_call_state.sql).
    // Any second caller that touches a tenant table through this pool would be
    // bypassing row-level security, and belongs in withTenant instead.
    "getPool",
  ])
);

/**
 * Ordered by how much an auditor wants to know about it, not by how destructive
 * it is. A unit of work reports its strongest action: a handler that reads a
 * transcript and then erases a caller is an erasure, and describing it as a read
 * because the read happened last would be a lie of ordering.
 */
const ACTION_RANK = { read: 0, write: 1, export: 2, erase: 3 };

/** @param {string} a @param {string|null} b @returns {string} */
export function strongerAction(a, b) {
  if (!b) return a;
  return (ACTION_RANK[a] ?? -1) > (ACTION_RANK[b] ?? -1) ? a : b;
}

/**
 * How many row ids one audit record keeps.
 *
 * row_count stays authoritative, so a truncated list reads as "200 rows, here
 * are the first 100" rather than as "100 rows". The cap exists because an export
 * of a long-standing caller would otherwise write a multi-kilobyte array into
 * the one table that must stay cheap to write on the voice path.
 */
export const RESOURCE_ID_CAP = 100;

/** The only fields an access record may carry. */
const ALLOWED_KEYS = new Set(["operation", "action", "resources", "resourceIds", "rowCount"]);

/**
 * Reject anything that is not a well-formed, PHI-free access record.
 *
 * THROWS rather than sanitising. lib/logger.js redacts PHI-typed keys because a
 * log line is worth emitting with a hole in it; an audit row is not. This table
 * is the single worst place in the system to leak PHI into — it is designed to
 * be retained longest and read by the most people — so a caller that tries gets
 * an exception, not a quiet `[redacted:phi]` and a row that looks fine.
 *
 * The unknown-key check is a whitelist rather than a PHI denylist, so a field
 * nobody has thought of yet is refused too. The explicit PHI check runs first
 * only to produce the more useful error message.
 *
 * @param {Record<string, unknown>} record
 */
export function validateAccessRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("recordPhiAccess: an access record is required");
  }
  for (const key of Object.keys(record)) {
    if (isPhiField(key)) {
      throw new Error(
        `recordPhiAccess: refusing PHI-typed field "${key}". The audit trail records identifiers, never protected health information.`
      );
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `recordPhiAccess: unexpected field "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}.`
      );
    }
  }
  if (typeof record.operation !== "string" || !record.operation) {
    throw new Error("recordPhiAccess: operation is required");
  }
  if (!(record.action in ACTION_RANK)) {
    throw new Error(`recordPhiAccess: unknown action "${record.action}"`);
  }
  if (!Array.isArray(record.resources) || record.resources.length === 0) {
    throw new Error("recordPhiAccess: resources must be a non-empty array");
  }
}

/**
 * Fold one access into the unit of work's running record.
 *
 * ONE ROW PER UNIT OF WORK, not one per statement. A statement has no subject
 * and a call pickup runs a dozen of them; a unit of work is the thing an auditor
 * can read as a sentence. The row is built by accumulation so the cost stays a
 * single INSERT on a connection that is already checked out.
 *
 * @param {{ operations: Set<string>, resources: Set<string>, resourceIds: string[], rowCount: number, action: string|null }} acc
 * @param {{ operation: string, action: string, resources: string[], resourceIds?: string[], rowCount?: number }} record
 */
export function mergeAccess(acc, record) {
  acc.operations.add(record.operation);
  for (const r of record.resources) acc.resources.add(r);
  acc.action = strongerAction(record.action, acc.action);
  acc.rowCount += Number.isFinite(record.rowCount) ? record.rowCount : 0;

  for (const id of record.resourceIds || []) {
    if (acc.resourceIds.length >= RESOURCE_ID_CAP) break;
    // uuid[] is a typed column, so a non-uuid would fail the INSERT and take the
    // whole unit of work down with it. Filtering here keeps a malformed id from
    // turning an audit record into an outage.
    if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) acc.resourceIds.push(id);
  }
}
