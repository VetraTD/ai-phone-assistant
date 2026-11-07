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
  setCallOutcomeCode: { action: "write", resources: ["calls"] },
  updateCallSummary: { action: "write", resources: ["calls"] },
  addTranscriptEntry: { action: "write", resources: ["call_transcripts"] },
  fetchCallTranscript: { action: "read", resources: ["call_transcripts"] },

  // Appointments — a named person, at a time, with notes.
  createAppointment: { action: "write", resources: ["appointments"] },
  createAppointmentIfAvailable: { action: "write", resources: ["appointments"] },
  listAppointmentsByCaller: { action: "read", resources: ["appointments"] },
  listAppointmentsByCallId: { action: "read", resources: ["appointments"] },
  getAppointmentById: { action: "read", resources: ["appointments"] },
  updateAppointmentStatus: { action: "write", resources: ["appointments"] },
  updateAppointment: { action: "write", resources: ["appointments"] },

  // Messages and callbacks the caller left.
  createCustomerRequest: { action: "write", resources: ["customer_requests"] },
  listCallCustomerRequests: { action: "read", resources: ["customer_requests"] },
  updateCustomerRequest: { action: "write", resources: ["customer_requests"] },
  // Owner notices (migrations 059, 060): the call-end hook claims a pending
  // request under a lease to tell the owner about it, hands it back when the
  // send fails, and completes it once the owner was told.
  claimOwnerNotices: { action: "read", resources: ["customer_requests"] },
  releaseOwnerNotices: { action: "write", resources: ["customer_requests"] },
  completeOwnerNotices: { action: "write", resources: ["customer_requests"] },

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

  // Outbound calling (spec §10). The subject is the CONTACT being called: their
  // number, their name, their consent, whether and when we dialled them. The
  // dispatcher's reads decide whether a person is rung, and its writes are the
  // record that they were, so all of it is data about that person under the
  // rule above.
  claimOutreachForDispatch: { action: "read", resources: ["outreach", "contacts"] },
  isSuppressed: { action: "read", resources: ["suppressions"] },
  listConsents: { action: "read", resources: ["consents"] },
  hasServiceRelationship: { action: "read", resources: ["appointments"] },
  countDialsSince: { action: "read", resources: ["call_attempts"] },
  // Inbound launch guards (S4, migration 054). They run on the pool before the
  // tenant scope exists or on the answer path, so they are NOT wrapped in
  // withTenant; in hipaa mode recordPhiAccess announces an unscoped access.
  recordPendingDial: { action: "write", resources: ["pending_dials"] },
  inboundGuardFacts: { action: "read", resources: ["blocked_callers", "pending_dials", "calls"] },
  aiSecondsToday: { action: "read", resources: ["calls"] },
  insertCallAttempt: { action: "write", resources: ["call_attempts"] },
  markOutreachDialing: { action: "write", resources: ["outreach"] },
  rescheduleOutreach: { action: "write", resources: ["outreach"] },
  closeOutreach: { action: "write", resources: ["outreach"] },
  // S4-1 (spec §12.3): callback recognition. The subject is the contact who rang back.
  openOutreachForPhone: { action: "read", resources: ["outreach", "contacts", "calls"] },
  closeOutreachCalledBack: { action: "write", resources: ["outreach"] },
  linkCallToOutreach: { action: "write", resources: ["calls"] },
  setAttemptCallSid: { action: "write", resources: ["call_attempts"] },
  failAttempt: { action: "write", resources: ["call_attempts"] },
  storeAttemptAudio: { action: "write", resources: ["call_attempts"] },
  undoAttempt: { action: "write", resources: ["call_attempts", "outreach"] },
  lockOutreachState: { action: "read", resources: ["outreach"] },

  // The outbound door (Task 12, spec §9.1). stampAttemptStatus writes the
  // Twilio lifecycle onto the contact's own attempt row.
  // fetchAttemptVoicemailAudio reads back the clip Ava would say to (or
  // about) that contact -- audio about the interaction, same rule as
  // fetchCallTranscript above. outboundAttemptByCallSid is NOT here: it
  // returns ids and an int only, see NON_PHI_EXPORTS below.
  stampAttemptStatus: { action: "write", resources: ["call_attempts"] },
  fetchAttemptVoicemailAudio: { action: "read", resources: ["call_attempts"] },
  // S3-4 (D6, migration 046): the transfer-miss clip, read back by the same
  // signed media door as the voicemail. The line itself carries no name or
  // number, but the read is scoped to one contact's own attempt row, the
  // same rule fetchAttemptVoicemailAudio and fetchAttemptOpenerAudio apply.
  fetchAttemptTransferMissAudio: { action: "read", resources: ["call_attempts"] },

  // I6 (fix wave, checkpoint 2b, = b37): the Live session's own answered_at
  // stamp, written the moment it resolves the outbound context -- the SAME
  // column stampAttemptStatus above writes from Twilio's own "in-progress"
  // callback, just a second writer for when that callback is lost or late.
  stampAttemptAnswered: { action: "write", resources: ["call_attempts"] },

  // The async AMD route (Task 13, spec §9.4). stampAttemptAmd writes the
  // answering-machine verdict onto the contact's own attempt row, same rule
  // as stampAttemptStatus above. outboundAmdContext reads the campaign's
  // voicemail eligibility and compliance class for THIS attempt -- scoped by
  // attemptId to one specific contact's dial, the same reasoning
  // countDialsSince above uses even though it too returns no name or number.
  stampAttemptAmd: { action: "write", resources: ["call_attempts"] },
  outboundAmdContext: { action: "read", resources: ["call_attempts", "campaigns", "campaign_versions"] },
  // Real Hold call 2026-10-01: the AMD door's "has this call had a real
  // exchange" read -- a boolean from calls.answers._exchanged.
  outboundCallHadExchange: { action: "read", resources: ["calls"] },

  // The Live session's outbound context (Task 14, spec §9.2): the contact's
  // dialled number, first name and timezone, the trigger payload and the
  // pre-rendered clip that addresses them by name -- data about that person.
  outboundCallContext: {
    action: "read",
    resources: ["call_attempts", "outreach", "campaigns", "campaign_versions", "contacts"],
  },
  // Task 14 fix round 1 (I4): the backstop clip re-read at fire time -- audio
  // that addresses the contact by name, same rule as fetchAttemptVoicemailAudio.
  fetchAttemptOpenerAudio: { action: "read", resources: ["call_attempts"] },

  // Post-call (Task 20, spec §11, §13.2-13.4). Every write here is on the
  // contact's own attempt or outreach row, same rule as stampAttemptStatus
  // above; outboundPostCallContext reads that row plus the campaign config
  // and the contact's phone/timezone -- the same shape outboundCallContext
  // already covers, for the same reason. outboundCallEffects and
  // insertDetectorSuppression are about the contact too: whether THIS call
  // booked them or already opted them out, and the suppression the opt-out
  // detector writes when the tool did not get there first.
  claimPostCall: { action: "write", resources: ["call_attempts"] },
  releasePostCallClaim: { action: "write", resources: ["call_attempts"] },
  finishAttemptSession: { action: "write", resources: ["call_attempts"] },
  outboundPostCallContext: {
    action: "read",
    resources: ["call_attempts", "outreach", "campaigns", "campaign_versions", "contacts", "calls"],
  },
  finalizeAttemptResult: { action: "write", resources: ["call_attempts"] },
  setAttemptSilent: { action: "write", resources: ["call_attempts"] },
  setOutreachHold: { action: "write", resources: ["outreach"] },
  applyOutreachResult: { action: "write", resources: ["outreach"] },
  outboundCallEffects: { action: "read", resources: ["appointments", "suppressions"] },
  insertDetectorSuppression: { action: "write", resources: ["suppressions"] },
  // S3-3 (spec §12.2). insertSuppression is the general writer behind it
  // (capabilities/optOut.js, capabilities/outcome.js's wrong_number branch):
  // a do-not-call reason for a specific contact's number, same rule as
  // insertDetectorSuppression above. mergeCallAnswers is schedule_callback's
  // own write -- the day and time Ava told a contact she would call them
  // back, which is data about that contact just as much as outcome_code is.
  insertSuppression: { action: "write", resources: ["suppressions"] },
  mergeCallAnswers: { action: "write", resources: ["calls"] },

  // The two data-subject rights. Both are whole-subject operations, which is
  // why they rank above an ordinary read and an ordinary write.
  exportCallerData: {
    action: "export",
    resources: ["calls", "call_transcripts", "appointments", "customer_requests", "sms_consents"],
  },
  eraseCallerData: {
    action: "erase",
    // S3-11 (spec §13.5, P5): also erases outbound calling's own tables for
    // the same phone -- consents, contacts, outreach and call_attempts audio
    // -- and keeps-but-hashes the matching suppressions row(s). S3-8 fix
    // round 1 (I4, controller ruling): `outbox` joins the list -- a
    // pending/dead row is deleted, a delivered row's payload is redacted
    // (see services/db.js's own doc on eraseCallerData for the table-by-
    // table rule this was missing before).
    resources: [
      "calls", "call_transcripts", "appointments", "customer_requests", "sms_consents",
      "consents", "contacts", "outreach", "call_attempts", "outbox", "suppressions",
    ],
  },

  // S3-8 (spec §12.5, amended §19 S3-D3): the shared results channel.
  // insertOutboxRow and getOutboxRow both touch a row's `payload` column,
  // which carries the contact's phone, first name and answers -- data about
  // the interaction, same rule as calls.answers above. outboundBookingInfo
  // reads the appointment this call produced, by call id -- same rule as
  // outboundCallEffects. outboundResultsLabels reads a campaign's name and a
  // contact's first_name/external_ids, by id -- the contact half is data
  // about that person, same rule as outboundCallContext's first_name read.
  //
  // markOutboxDelivered/markOutboxRetry/markOutboxDead and
  // listActiveWebhookEndpoints/getWebhookEndpoint are NOT here -- see
  // NON_PHI_EXPORTS below for why.
  insertOutboxRow: { action: "write", resources: ["outbox"] },
  getOutboxRow: { action: "read", resources: ["outbox"] },
  outboundBookingInfo: { action: "read", resources: ["appointments"] },
  outboundResultsLabels: { action: "read", resources: ["campaigns", "contacts"] },

  // S3-9 (spec §12.1): the leads-in link, POST /v1/triggers/:triggerToken.
  // upsertContactForTrigger and recordTriggerConsent write data ABOUT the
  // person the trigger names -- same rule as every other contact/consent
  // write above. createOutreachFromTrigger's `details` column is the
  // per-person facts (S3-6) that end up spoken on the call, same rule as
  // outboundCallContext's trigger/first_name read.
  upsertContactForTrigger: { action: "write", resources: ["contacts"] },
  recordTriggerConsent: { action: "write", resources: ["consents"] },
  createOutreachFromTrigger: { action: "write", resources: ["outreach"] },
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
 *   activeDialCounts, outboundDue, lockCapacity
 *       outbound capacity and scheduling: counts, ids or a lock only.
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
    // Outbound (spec §10): counts, ids or a lock only. activeDialCounts and
    // outboundDue read the migration-044 directories, which hold ids,
    // timestamps and a state word and never a number or a name; lockCapacity
    // takes an advisory lock and reads nothing.
    "activeDialCounts",
    "outboundDue",
    "lockCapacity",
    // Inbound launch guards (S4, migration 054): endPendingDial is keyed on the
    // parent call SID and returns a count -- no number and no subject. The other
    // three guard wrappers are in PHI_ACCESS above.
    "endPendingDial",
    // The outbound door (Task 12, spec §9.1, plan C15). Resolves a Twilio
    // CallSid to {businessId, attemptId, outreachId, campaignId,
    // campaignVersion} through app_outbound_attempt_by_call_sid (migration
    // 044) -- ids and an int, never a phone number or a name. It runs BEFORE
    // the tenant is known, which is the same reason activeDialCounts and
    // outboundDue above are exempt: a routing lookup with no subject cannot
    // disclose one.
    "outboundAttemptByCallSid",
    // The sweep's stale-attempt backstop (Task 20, migration 045): ids and a
    // `kind` word only, same reasoning as outboundDue above.
    "outboundStaleAttempts",
    // S3-8: webhook_endpoints holds no caller data -- a URL, a ciphertext
    // blob and an events list, the tenant's own configuration, same rule
    // listIntegrationsForBusiness gets above.
    "listActiveWebhookEndpoints",
    "getWebhookEndpoint",
    // S3-8: outbox delivery bookkeeping only (status/attempts/
    // next_attempt_at/last_error/delivered_at) -- never the row's `payload`.
    // Telemetry about the DELIVERY MECHANISM, not the interaction, same rule
    // updateCallLatency gets above.
    "markOutboxDelivered",
    "markOutboxRetry",
    "markOutboxDead",
    // S3-8 fix round 1 (I3(a)): the sweep's cross-tenant outbox backstop,
    // through migration 050's app_outbound_webhook_due -- ids only, same
    // reasoning as outboundDue. (D12, W3 final review: the earlier
    // per-tenant `dueOutboxRows` this superseded was dead code -- deleted,
    // along with its own entry here.)
    "outboundWebhookDue",
    // S3-9 (spec §12.1). campaignByTriggerHash resolves a trigger token's
    // hash to {businessId, campaignId, triggerTokenHash} through
    // app_campaign_by_trigger_hash (migration 049) -- ids and a hash only,
    // never a phone number or a name, and it runs BEFORE the tenant is
    // known, same reasoning as outboundAttemptByCallSid above.
    // campaignForTrigger reads the campaign's own compliance class and
    // details_fields configuration -- the tenant's own configuration, same
    // rule as fetchBusinessById.
    "campaignByTriggerHash",
    "campaignForTrigger",
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
