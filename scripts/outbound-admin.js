#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The operator path for outbound calling, while there is no dashboard for it
// (Part 1, Task 11).
// ---------------------------------------------------------------------------
//
// There is no write path to these tables from a workstation -- Cloud SQL is
// private-IP only -- so, like set-business-config.js and import-tenant.js
// before it, this runs through the migrate job and ships in the image.
//
// FOUR THINGS AN OPERATOR NEEDS BEFORE A DASHBOARD EXISTS:
//   1. create or update a campaign               (upsertCampaign)
//   2. move it between draft / active / paused   (setCampaignStatus)
//   3. switch outbound on for a business          (setBusinessOutbound)
//   4. place one test call to an allow-listed number (triggerOutreach)
//
// DRY RUN BY DEFAULT. Every write:
//   - resolves the tenant through app_lookup_business_by_phone(businessPhone),
//     the same lookup the voice service itself routes through, inside a
//     transaction -- so a scoped write either lands in the right tenant's rows
//     or is refused, never silently in nobody's;
//   - without --confirm, prints what it WOULD write as one JSON line and rolls
//     the transaction back -- nothing is committed;
//   - with --confirm, writes, reads the row back INSIDE the same transaction,
//     and only commits if the read-back matches what was asked for. A mismatch
//     rolls back and is reported as a failure, never left half-applied.
//
// caller_id GETS NO TWILIO OWNERSHIP CHECK HERE. The migrate job carries no
// Twilio credentials -- that check (gate.js's callerIdValid()) runs at dial
// time, in the dispatcher, which does have them.
//
// --config carries the campaign config JSON as base64, for the reason
// set-business-config.js:114-120 gives: the value travels as a Cloud Run job
// argument, and base64's alphabet has no comma and no newline to collide with
// the job's own delimiters.
//
// --consent-manual is refused unless the destination phone is on
// OUTBOUND_TEST_ALLOWLIST (lib/outbound/config.js's outboundEnv().allowlist),
// so a manual consent -- the one kind this script can create outright, with no
// form and no inbound call behind it -- can never be fabricated for a real
// lead. The check runs before any transaction opens.
//
// USAGE
//   node scripts/outbound-admin.js campaign --phone +1... --name "Speed to lead" \
//     --template-key speed_to_lead --compliance-class solicited --audience business \
//     --config <base64 JSON> [--campaign-id <uuid>] [--confirm]
//   node scripts/outbound-admin.js status --phone +1... --campaign-id <uuid> \
//     --status active|paused|draft [--confirm]
//   node scripts/outbound-admin.js outbound --phone +1... --enabled true|false --max 2 [--confirm]
//   node scripts/outbound-admin.js trigger --phone +1... --campaign-id <uuid> \
//     --contact-phone +1... [--timezone America/Chicago] [--first-name "Sam"] \
//     [--consent-manual] [--confirm]
//   --timezone (an IANA zone) is REQUIRED unless --contact-phone is +44: the
//   calling window runs on the contact's clock, and only +44 has a default.
//   node scripts/outbound-admin.js unsuppress --phone +1... --contact-phone +1... [--confirm]
//   --contact-phone must be on OUTBOUND_TEST_ALLOWLIST (outboundEnv().allowlist)
//   or this is refused before any transaction opens -- go-live pre-deploy Y3.
//   This is the only way this script can remove a do-not-call entry, and it
//   must never work for a real lead.
//
//   WEBHOOK_SECRET=<at least 16 chars> node scripts/outbound-admin.js webhook-set \
//     --phone +1... --url https://... [--events call.completed,outreach.closed] \
//     [--active true|false] [--endpoint-id <uuid>] [--confirm]
//   S3-8. --events omitted or empty subscribes to every event. --endpoint-id
//   updates an existing endpoint for this tenant instead of creating one.
//   The secret is encrypted (CONNECTIONS_WEBHOOK_KEY) before it is written
//   and is NEVER printed back, dry-run or confirmed.
//   D6 (W3 final review): the secret is taken from WEBHOOK_SECRET (an
//   environment variable) or, with --secret-stdin, piped on stdin -- NEVER
//   --secret on the command line, which this refuses outright (a job
//   execution's stored arguments and this process's own argv are both a
//   worse exposure than an env var or a pipe).
//   node scripts/outbound-admin.js webhook-test --phone +1... --endpoint-id <uuid> [--confirm]
//   Sends one real, signed test delivery (event call.completed) to a stored
//   endpoint through the SAME SSRF-guarded delivery path the delivery task
//   handler uses. Dry-run by default: no network call, no secret decrypted,
//   without --confirm.
//
//   node scripts/outbound-admin.js trigger-token-rotate --phone +1... --campaign-id <uuid> [--confirm]
//   S3-9. Generates 32 random bytes, stores ONLY their sha256 hash
//   (campaigns.trigger_token_hash), and prints the raw token ONCE, in the
//   confirmed result -- it is never written to the database, never logged
//   again, and cannot be recovered afterwards: losing it means rotating
//   again. Dry-run by default: no token is generated at all without
//   --confirm, so a dry run cannot accidentally print (or discard) a real
//   one. Overwrites any existing token for this campaign -- the old one
//   stops working the moment this commits.
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "./migrate.js";
import { validateCampaign } from "../lib/outbound/campaignSchema.js";
import { PURPOSE_BY_TEMPLATE } from "../lib/outbound/templates.js";
import { outboundEnv } from "../lib/outbound/config.js";
// The dial-time gate honours this consent only while the number is on the
// SERVICE's allow-list (Checkpoint 2a, F4); one constant, so the two agree.
import { OPERATOR_TEST_WORDING } from "../lib/outbound/gate.js";
// S3-8: the results channel. encryptSecret/decryptSecret never appear in any
// output this script prints (webhook-set never echoes the secret back;
// webhook-test decrypts only to sign a live test delivery).
import { encryptSecret, decryptSecret } from "../lib/connections/secretBox.js";
import { RESULTS_EVENTS, buildResultsPayload, attemptDelivery } from "../lib/connections/outbox.js";

const E164 = /^\+[1-9]\d{6,14}$/;
const CAMPAIGN_STATUSES = ["draft", "active", "paused"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The dashboard's documented bound on outbound_max_concurrent (fix round 1,
// Minor). Named so parseArgs and setBusinessOutbound cannot drift apart.
const MAX_OUTBOUND_CONCURRENT = 10;
// A campaign's legal basis. Set at creation, never changed by an update
// (Checkpoint 2a, M8a): make a new campaign instead.
const IMMUTABLE_CAMPAIGN_FIELDS = Object.freeze(["compliance_class", "template_key", "audience"]);

/**
 * Order-insensitive deep equality for the read-back check. A naive
 * JSON.stringify comparison of a jsonb column against the JS object that was
 * written is not safe: it would pass or fail on key ORDER, which is an
 * accident of how Postgres happens to store the value, not a real mismatch.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// upsertCampaign
// ---------------------------------------------------------------------------
/**
 * Create a campaign (version 1), or -- when `meta.id` names an existing
 * campaign for this tenant -- insert version `current_version + 1` and bump
 * `current_version` to match. `meta.id` is where an update names the campaign
 * to update: the exported signature carries only {businessPhone, meta,
 * config, confirm}, so there is nowhere else for it to live.
 */
export async function upsertCampaign(client, { businessPhone, meta, config, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const validated = validateCampaign(meta, config, { businessName: business.name });
    if (!validated.ok) {
      await client.query("ROLLBACK");
      return { ok: false, errors: validated.errors };
    }

    const m = meta || {};
    let existing = null;
    if (m.id) {
      const r = await client.query(
        "SELECT id, current_version, template_key, compliance_class, audience FROM campaigns WHERE id = $1 AND business_id = $2",
        [m.id, business.id]
      );
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false, error: `no campaign ${m.id} for business ${businessPhone}` };
      }
      existing = r.rows[0];

      // Checkpoint 2a, M8(a). In-flight outreach is pinned to an older
      // version and was gated and consented under THIS legal basis; rewriting
      // it on the campaign row would re-label every pinned outreach. Refused
      // before the dry-run return, so a dry run reports it too.
      const changed = IMMUTABLE_CAMPAIGN_FIELDS.filter((f) => existing[f] !== m[f]);
      if (changed.length) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          error: `campaign ${m.id}: ${changed.map((f) => `${f} ${existing[f]} -> ${m[f]}`).join(", ")} refused -- ` +
            `${IMMUTABLE_CAMPAIGN_FIELDS.join(", ")} cannot change on an existing campaign (its in-flight outreach ` +
            "is pinned to older versions under that legal basis); create a new campaign instead",
        };
      }
    }

    const version = existing ? existing.current_version + 1 : 1;
    const campaignId = existing ? existing.id : (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;

    const wouldWrite = {
      campaignId,
      version,
      name: m.name,
      template_key: m.template_key,
      compliance_class: m.compliance_class,
      audience: m.audience,
      config: validated.value,
    };

    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    if (existing) {
      // The immutable fields are not written at all on an update (M8a).
      await client.query(
        `UPDATE campaigns SET name = $2, current_version = $3, updated_at = now()
          WHERE id = $1`,
        [campaignId, m.name, version]
      );
    } else {
      await client.query(
        `INSERT INTO campaigns (id, business_id, name, template_key, compliance_class, audience, current_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [campaignId, business.id, m.name, m.template_key, m.compliance_class, m.audience, version]
      );
    }

    await client.query(
      `INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1, $2, $3, $4::jsonb)`,
      [campaignId, business.id, version, JSON.stringify(validated.value)]
    );

    const check = await client.query(
      `SELECT c.name, c.template_key, c.compliance_class, c.audience, c.current_version, v.config
         FROM campaigns c JOIN campaign_versions v ON v.campaign_id = c.id AND v.version = c.current_version
        WHERE c.id = $1`,
      [campaignId]
    );
    const row = check.rows[0];
    const mismatches = [];
    if (!row) {
      mismatches.push("row missing entirely");
    } else {
      if (row.name !== m.name) mismatches.push("name");
      if (row.template_key !== m.template_key) mismatches.push("template_key");
      if (row.compliance_class !== m.compliance_class) mismatches.push("compliance_class");
      if (row.audience !== m.audience) mismatches.push("audience");
      if (row.current_version !== version) mismatches.push("current_version");
      if (!deepEqual(row.config, validated.value)) mismatches.push("config");
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: `read-back mismatch: ${mismatches.join(", ")}` };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, campaignId, version };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// setCampaignStatus
// ---------------------------------------------------------------------------
export async function setCampaignStatus(client, { businessPhone, campaignId, status, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!campaignId) {
    return { ok: false, error: "campaignId is required" };
  }
  if (!CAMPAIGN_STATUSES.includes(status)) {
    return { ok: false, error: `status must be one of ${CAMPAIGN_STATUSES.join(", ")}` };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const campRes = await client.query(
      "SELECT id FROM campaigns WHERE id = $1 AND business_id = $2",
      [campaignId, business.id]
    );
    if (campRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no campaign ${campaignId} for business ${businessPhone}` };
    }

    // Ruling 2a-11. dispatch.js parks a paused campaign's `waiting` outreach
    // with next_attempt_at = NULL (a `later` verdict with `at === null`), and
    // app_outbound_due (migration 044) never lists a NULL as due -- so a
    // paused campaign's outreach sits forever unless something re-arms it.
    // This script is Part 1's only way to move a campaign back to `active`,
    // so resuming here is the one place that has to do it (spec §8: "A
    // paused campaign holds its outreach in waiting without closing it.
    // Resuming re-enqueues them."). Scoped to `state = 'waiting' AND
    // next_attempt_at IS NULL` only -- an outreach with a real future
    // next_attempt_at (e.g. outside_window, tomorrow 09:00) is genuinely
    // scheduled and must not be touched. Setting next_attempt_at = now()
    // (not enqueuing anything) is enough: the 5-minute sweep picks it up.
    const reArmMatch = { text: `SELECT count(*)::int AS n FROM outreach
        WHERE business_id = $1 AND campaign_id = $2 AND state = 'waiting' AND next_attempt_at IS NULL`,
      values: [business.id, campaignId] };
    let reArmed = 0;
    if (status === "active") {
      const countRes = await client.query(reArmMatch.text, reArmMatch.values);
      reArmed = countRes.rows[0].n;
    }

    const wouldWrite = { campaignId, status, reArmed };
    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    await client.query("UPDATE campaigns SET status = $2, updated_at = now() WHERE id = $1", [campaignId, status]);

    let reArmedCount = 0;
    if (status === "active") {
      const armRes = await client.query(
        `UPDATE outreach SET next_attempt_at = now(), updated_at = now()
           WHERE business_id = $1 AND campaign_id = $2 AND state = 'waiting' AND next_attempt_at IS NULL
         RETURNING id`,
        [business.id, campaignId]
      );
      reArmedCount = armRes.rowCount;
    }

    const check = await client.query("SELECT status FROM campaigns WHERE id = $1", [campaignId]);
    const mismatches = [];
    if (check.rowCount !== 1 || check.rows[0].status !== status) mismatches.push("status");
    if (status === "active") {
      const stillParked = await client.query(reArmMatch.text, reArmMatch.values);
      if (stillParked.rows[0].n !== 0) mismatches.push("outreach still parked after resume");
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: `read-back mismatch: ${mismatches.join(", ")}` };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, campaignId, status, reArmed: reArmedCount };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// setBusinessOutbound
// ---------------------------------------------------------------------------
export async function setBusinessOutbound(client, { businessPhone, enabled, max, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (!Number.isInteger(max) || max < 1 || max > MAX_OUTBOUND_CONCURRENT) {
    return { ok: false, error: `max must be a whole number from 1 to ${MAX_OUTBOUND_CONCURRENT} (the dashboard's documented bound)` };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const wouldWrite = { businessId: business.id, outbound_enabled: enabled, outbound_max_concurrent: max };
    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    await client.query(
      "UPDATE businesses SET outbound_enabled = $2, outbound_max_concurrent = $3 WHERE id = $1",
      [business.id, enabled, max]
    );
    const check = await client.query(
      "SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1",
      [business.id]
    );
    const row = check.rows[0];
    if (!row || row.outbound_enabled !== enabled || row.outbound_max_concurrent !== max) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: `read-back mismatch: wanted enabled=${enabled} max=${max}, got ${row ? `enabled=${row.outbound_enabled} max=${row.outbound_max_concurrent}` : "(no row)"}`,
      };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, outbound_enabled: enabled, outbound_max_concurrent: max };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// triggerOutreach
// ---------------------------------------------------------------------------
/**
 * Checkpoint 2a, M8(c). The calling window is evaluated on the CONTACT's
 * clock, and with contacts.timezone NULL, contactTimezone()
 * (lib/outbound/schedule.js) assumes Europe/London for +44 and the
 * BUSINESS's zone for anything else -- for a UK business calling a US number,
 * the wrong clock by 5-8 hours. So outside +44 the operator must name the
 * zone, and any zone given is checked by Intl, the engine the scheduler runs
 * it through.
 * @param {string} phone - E.164, already validated
 * @param {string|null} timezone - already trimmed; null when absent
 * @returns {string|null} the refusal, or null
 */
function timezoneError(phone, timezone) {
  if (timezone === null) {
    return phone.startsWith("+44")
      ? null
      : `--timezone <IANA zone> is required for ${phone}: only +44 numbers have a default (Europe/London); any other number would be called on the business's clock`;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return null;
  } catch {
    return `--timezone ${JSON.stringify(timezone)} is not a time zone (use an IANA name, e.g. America/Chicago)`;
  }
}

/**
 * Upsert the contact, optionally record a manual consent, and create the
 * outreach `waiting` with `next_attempt_at = now()` -- REQUIRED, because
 * app_outbound_due (migration 044) and the dispatcher both treat a NULL
 * next_attempt_at as "not due" / parked, and the sweep would never list it.
 *
 * This does NOT enqueue a Cloud Task. The 5-minute sweep (Task 12) picks up
 * anything `waiting` and due, so the script needs no Cloud Tasks rights.
 *
 * Idempotent per calendar day (UTC): idempotency_key is
 * `admin:<campaignId>:<phone>:<yyyy-mm-dd>`, and the outreach insert is
 * `ON CONFLICT (business_id, idempotency_key) DO NOTHING`. The manual consent
 * is written only the first time -- if the outreach already existed, an
 * operator re-running the same trigger is not spammed with duplicate
 * "operator test" consent rows.
 */
export async function triggerOutreach(client, { businessPhone, campaignId, phone, timezone, firstName, consentManual, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!campaignId) {
    return { ok: false, error: "campaignId is required" };
  }
  if (!E164.test(phone || "")) {
    return { ok: false, error: "phone must be an E.164 number" };
  }
  if (timezone !== undefined && timezone !== null && typeof timezone !== "string") {
    return { ok: false, error: "--timezone must be a string (an IANA zone)" };
  }
  const tz = typeof timezone === "string" && timezone.trim() !== "" ? timezone.trim() : null;
  const tzError = timezoneError(phone, tz);
  if (tzError) return { ok: false, error: tzError };

  // ALLOW-LIST GUARD. Refused before any transaction opens and before the
  // campaign or contact are even looked up: a manual consent can never be
  // fabricated for a real lead, and a refusal here leaves nothing to unwind.
  if (consentManual) {
    const { allowlist } = outboundEnv();
    if (!allowlist.has(phone)) {
      return { ok: false, error: `--consent-manual refused: ${phone} is not on OUTBOUND_TEST_ALLOWLIST` };
    }
  }

  const today = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd
  const idempotencyKey = `admin:${campaignId}:${phone}:${today}`;

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const campRes = await client.query(
      "SELECT id, template_key, current_version FROM campaigns WHERE id = $1 AND business_id = $2",
      [campaignId, business.id]
    );
    if (campRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no campaign ${campaignId} for business ${businessPhone}` };
    }
    const campaign = campRes.rows[0];
    const purpose = PURPOSE_BY_TEMPLATE[campaign.template_key] || null;
    if (consentManual && !purpose) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no consent purpose configured for template_key ${campaign.template_key}` };
    }

    const wouldWrite = {
      businessId: business.id,
      campaignId: campaign.id,
      campaignVersion: campaign.current_version,
      contact: { phone_e164: phone, first_name: firstName || null, timezone: tz },
      consent: consentManual
        ? { source: "manual", covers_automated: true, purpose, channels: ["call"], wording_version: OPERATOR_TEST_WORDING }
        : null,
      outreach: { state: "waiting", next_attempt_at: "now()", trigger: { source: "outbound-admin" }, idempotency_key: idempotencyKey },
    };

    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    // COALESCE (Checkpoint 2a, M8b/M8c): a re-run without --first-name or
    // --timezone keeps the stored value rather than wiping it.
    const contactRes = await client.query(
      `INSERT INTO contacts (business_id, phone_e164, first_name, timezone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, phone_e164) DO UPDATE SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
                                                           timezone = COALESCE(EXCLUDED.timezone, contacts.timezone), updated_at = now()
       RETURNING id`,
      [business.id, phone, firstName || null, tz]
    );
    const contactId = contactRes.rows[0].id;

    const outreachIns = await client.query(
      `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, next_attempt_at, trigger, idempotency_key)
       VALUES ($1, $2, $3, $4, 'waiting', now(), $5::jsonb, $6)
       ON CONFLICT (business_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [business.id, campaign.id, campaign.current_version, contactId, JSON.stringify({ source: "outbound-admin" }), idempotencyKey]
    );
    const created = outreachIns.rowCount === 1;

    if (created && consentManual) {
      await client.query(
        `INSERT INTO consents (business_id, contact_id, purpose, channels, covers_automated, source, captured_at, wording_version, wording_text)
         VALUES ($1, $2, $3, '{call}', true, 'manual', now(), $5, $4)`,
        [business.id, contactId, purpose, "Operator test on the owner's own handset", OPERATOR_TEST_WORDING]
      );
    }

    const check = await client.query(
      `SELECT id, campaign_id, campaign_version, contact_id, state, next_attempt_at
         FROM outreach WHERE business_id = $1 AND idempotency_key = $2`,
      [business.id, idempotencyKey]
    );
    const row = check.rows[0];
    const mismatches = [];
    if (!row) mismatches.push("row missing entirely");
    else {
      if (row.campaign_id !== campaign.id) mismatches.push("campaign_id");
      if (row.contact_id !== contactId) mismatches.push("contact_id");
      if (row.state !== "waiting") mismatches.push("state");
      if (!row.next_attempt_at) mismatches.push("next_attempt_at");
    }
    // The contact fields this run asked for (absent ones were kept, M8b/c).
    const contactCheck = (await client.query("SELECT first_name, timezone FROM contacts WHERE id = $1", [contactId])).rows[0];
    if (!contactCheck) mismatches.push("contact missing");
    else {
      if (firstName && contactCheck.first_name !== firstName) mismatches.push("first_name");
      if (tz && contactCheck.timezone !== tz) mismatches.push("timezone");
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: `read-back mismatch: ${mismatches.join(", ")}` };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, contactId, outreachId: row.id, created, idempotencyKey };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// unsuppress
// ---------------------------------------------------------------------------
/**
 * Go-live pre-deploy code, group Y (Y3). The only way this script can remove
 * a do-not-call entry, so it is allow-listed, not merely dry-run-by-default
 * like the writes above: refused BEFORE any transaction opens, before the
 * tenant is even looked up, exactly as triggerOutreach's --consent-manual
 * guard is (~:430-438) -- a suppression can never be fabricated away for a
 * real lead.
 *
 * Tenant-scoped by construction: `suppressions` is FORCE ROW LEVEL SECURITY
 * (migration 042) and app_lookup_business_by_phone adopts the tenant for the
 * transaction, so the DELETE below can only ever touch --phone's own rows --
 * another tenant's suppression of the same number is a different business_id
 * and is invisible to this scope.
 *
 * Dry run by default: counts what it would delete and rolls back. --confirm
 * deletes, reads the count back INSIDE the same transaction, and commits only
 * if zero rows remain for this tenant and number -- a mismatch rolls back and
 * is reported as a failure, never left half-applied (the read-back pattern
 * every write above uses).
 */
export async function unsuppress(client, { businessPhone, contactPhone, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!E164.test(contactPhone || "")) {
    return { ok: false, error: "contactPhone must be an E.164 number (--contact-phone)" };
  }

  const { allowlist } = outboundEnv();
  if (!allowlist.has(contactPhone)) {
    return { ok: false, error: `unsuppress refused: ${contactPhone} is not on OUTBOUND_TEST_ALLOWLIST` };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const before = await client.query(
      "SELECT count(*)::int AS n FROM suppressions WHERE business_id = $1 AND phone_e164 = $2",
      [business.id, contactPhone]
    );
    const wouldRemove = before.rows[0].n;

    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite: { businessId: business.id, phone: contactPhone, wouldRemove } };
    }

    await client.query("DELETE FROM suppressions WHERE business_id = $1 AND phone_e164 = $2", [business.id, contactPhone]);

    const after = await client.query(
      "SELECT count(*)::int AS n FROM suppressions WHERE business_id = $1 AND phone_e164 = $2",
      [business.id, contactPhone]
    );
    if (after.rows[0].n !== 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: `read-back mismatch: ${after.rows[0].n} suppressions row(s) remain for ${contactPhone}` };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, removed: wouldRemove };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// webhookSet (S3-8): create or update one results-channel endpoint
// (webhook_endpoints). The secret is encrypted here (encryptSecret,
// lib/connections/secretBox.js) and NEVER appears in the dry-run preview or
// the confirmed write's return value -- only `wouldWrite`/the final result
// carry url/events/active, matching the brief's "never print the secret
// after set".
// ---------------------------------------------------------------------------
export async function webhookSet(client, { businessPhone, endpointId, url, secret, events, active, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (endpointId && !UUID_RE.test(endpointId)) {
    return { ok: false, error: "endpointId must be a uuid (--endpoint-id)" };
  }
  if (!url || typeof url !== "string" || !url.startsWith("https://")) {
    return { ok: false, error: "url must be an https:// URL (--url)" };
  }
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    return { ok: false, error: "secret must be at least 16 characters (--secret)" };
  }
  const evts = Array.isArray(events) ? events : [];
  const badEvents = evts.filter((e) => !RESULTS_EVENTS.includes(e));
  if (badEvents.length) {
    return { ok: false, error: `unknown event type(s): ${badEvents.join(", ")} -- allowed: ${RESULTS_EVENTS.join(", ")} (empty = every event)` };
  }

  // Encrypted BEFORE any transaction opens -- a misconfigured/missing
  // CONNECTIONS_WEBHOOK_KEY (fail-closed, lib/connections/secretBox.js) is
  // refused up front, never as a half-open write.
  let ciphertext;
  try {
    ciphertext = encryptSecret(secret);
  } catch (e) {
    return { ok: false, error: `cannot encrypt secret: ${e.message}` };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    if (endpointId) {
      const r = await client.query("SELECT id FROM webhook_endpoints WHERE id = $1 AND business_id = $2", [endpointId, business.id]);
      if (r.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false, error: `no webhook endpoint ${endpointId} for business ${businessPhone}` };
      }
    }

    const wouldWrite = { businessId: business.id, endpointId: endpointId || "(new)", url, events: evts, active };
    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    let id = endpointId;
    if (endpointId) {
      await client.query(`UPDATE webhook_endpoints SET url = $2, secret_ciphertext = $3, events = $4, active = $5 WHERE id = $1`, [
        endpointId,
        url,
        ciphertext,
        evts,
        active,
      ]);
    } else {
      const ins = await client.query(
        `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [business.id, url, ciphertext, evts, active]
      );
      id = ins.rows[0].id;
    }

    const check = await client.query("SELECT id, url, events, active FROM webhook_endpoints WHERE id = $1", [id]);
    const row = check.rows[0];
    const mismatches = [];
    if (!row) {
      mismatches.push("row missing entirely");
    } else {
      if (row.url !== url) mismatches.push("url");
      if (row.active !== active) mismatches.push("active");
      if (JSON.stringify([...row.events].sort()) !== JSON.stringify([...evts].sort())) mismatches.push("events");
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: `read-back mismatch: ${mismatches.join(", ")}` };
    }

    await client.query("COMMIT");
    return { ok: true, businessId: business.id, endpointId: id, url, events: evts, active };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// webhookTest (S3-8): a real signed delivery to a stored endpoint, using the
// SAME attemptDelivery (lib/connections/outbox.js) -- and so the SAME
// SSRF-guarded fetch (lib/net/ssrfGuard.js) -- the delivery task handler
// uses. Dry-run by default: without --confirm, no network call is made and
// no secret is ever decrypted.
// ---------------------------------------------------------------------------
export async function webhookTest(client, { businessPhone, endpointId, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!endpointId || !UUID_RE.test(endpointId)) {
    return { ok: false, error: "endpointId must be a uuid (--endpoint-id)" };
  }

  // BEGIN/ROLLBACK, even though this reads: app_lookup_business_by_phone's
  // own set_config('app.business_id', ..., true) is TRANSACTION-LOCAL (its
  // third argument). Without an explicit transaction, a plain pg.Client
  // auto-commits each statement in its own implicit transaction, so the
  // scope it sets would vanish before the very next query -- and the
  // webhook_endpoints read below, FORCE ROW LEVEL SECURITY, would then
  // silently see zero rows (found in this task's own DB test: it read back
  // as "no webhook endpoint ... for business ...", the exact 0-rows-reads-as-
  // refusal shape services/db.js's requireTenantScope doc warns about).
  await client.query("BEGIN");
  let business, endpoint;
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    business = bizRes.rows[0];

    const epRes = await client.query("SELECT id, url, secret_ciphertext, active FROM webhook_endpoints WHERE id = $1 AND business_id = $2", [
      endpointId,
      business.id,
    ]);
    if (epRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no webhook endpoint ${endpointId} for business ${businessPhone}` };
    }
    endpoint = epRes.rows[0];
    await client.query("ROLLBACK"); // read-only -- nothing to commit
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }

  const payload = buildResultsPayload({
    event: "call.completed",
    deliveryId: randomUUID(),
    occurredAt: new Date().toISOString(),
    campaign: { id: null, name: "webhook-test", version: null },
    outreach: { id: null, attempt: 0, state: "closed", close_reason: null },
    call: { result: "connected", answered_by: "human", duration_seconds: 0 },
    outcome: "other",
    contact: { id: null, phone: "+10000000000", first_name: "Test", external_ids: {} },
    summary: "This is a test delivery from scripts/outbound-admin.js webhook-test -- not a real call.",
  });

  if (!confirm) {
    return { ok: true, dryRun: true, wouldSend: { endpointId: endpoint.id, url: endpoint.url, event: payload.event, deliveryId: payload.delivery_id } };
  }
  if (!endpoint.active) {
    return { ok: false, error: `endpoint ${endpointId} is not active` };
  }

  let secret;
  try {
    secret = decryptSecret(endpoint.secret_ciphertext);
  } catch (e) {
    return { ok: false, error: `cannot decrypt endpoint secret: ${e.message}` };
  }

  const result = await attemptDelivery({
    url: endpoint.url,
    secret,
    eventType: payload.event,
    deliveryId: payload.delivery_id,
    payload,
  });
  return { ok: result.ok, endpointId: endpoint.id, url: endpoint.url, deliveryId: payload.delivery_id, status: result.status, lastError: result.lastError };
}

// ---------------------------------------------------------------------------
// rotateTriggerToken (S3-9): mint a new leads-in link token for one campaign.
// ---------------------------------------------------------------------------
export async function rotateTriggerToken(client, { businessPhone, campaignId, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!campaignId) {
    return { ok: false, error: "campaignId is required" };
  }

  await client.query("BEGIN");
  try {
    const bizRes = await client.query("SELECT * FROM app_lookup_business_by_phone($1)", [businessPhone]);
    if (bizRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no business has phone_number ${businessPhone}` };
    }
    const business = bizRes.rows[0];

    const campRes = await client.query("SELECT id FROM campaigns WHERE id = $1 AND business_id = $2", [campaignId, business.id]);
    if (campRes.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, error: `no campaign ${campaignId} for business ${businessPhone}` };
    }

    if (!confirm) {
      await client.query("ROLLBACK");
      // No token is generated on a dry run -- there is nothing to print, and
      // nothing that could be mistaken for a real, usable one.
      return { ok: true, dryRun: true, wouldWrite: { campaignId, action: "generate a new trigger token, overwriting any existing one" } };
    }

    // 32 random bytes, hex-encoded (the URL path segment). Only its sha256
    // hash is ever written -- the raw token exists nowhere but this one
    // process's memory and this one response.
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await client.query(`UPDATE campaigns SET trigger_token_hash = $2, updated_at = now() WHERE id = $1`, [campaignId, tokenHash]);

    const check = await client.query(`SELECT trigger_token_hash FROM campaigns WHERE id = $1`, [campaignId]);
    if (check.rows[0]?.trigger_token_hash !== tokenHash) {
      await client.query("ROLLBACK");
      return { ok: false, error: "read-back mismatch: trigger_token_hash" };
    }

    await client.query("COMMIT");
    // PRINTED ONCE: this return value, echoed by main()'s single
    // console.log(JSON.stringify(result)) below -- never stored, never
    // logged a second time.
    return { ok: true, businessId: business.id, campaignId, token };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function argOf(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : null;
}
function has(args, name) {
  return args.includes(`--${name}`);
}

// D6 (final review, security): the ONLY way `webhook-set` accepts a secret
// besides WEBHOOK_SECRET -- reads fd 0 synchronously (this CLI is a
// one-shot, non-interactive migrate-job invocation, never a TTY someone is
// expected to type into) and trims exactly the trailing newline a shell
// pipe (`echo`/`printf`) leaves. Returns null on anything unusable (no
// stdin, empty after trimming) rather than throwing -- parseArgs' own
// "is required" check is what reports that, with one consistent message.
function readSecretFromStdin() {
  try {
    const data = readFileSync(0, "utf8").trim();
    return data || null;
  } catch {
    return null;
  }
}

function decodeConfigB64(b64, push) {
  if (!b64) {
    push("config", "is required (--config <base64 JSON>)");
    return null;
  }
  let json;
  try {
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    push("config", "is not valid base64");
    return null;
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    push("config", `decoded but is not JSON: ${e.message}`);
    return null;
  }
}

/**
 * Parses argv (already sliced past `node script.js`) into one of the four
 * write shapes below, or `{ok:false, errors:[{path,message}]}` -- the same
 * shape validateCampaign uses, so the CLI can print either kind of refusal
 * the same way.
 */
export function parseArgs(argv) {
  const all = Array.isArray(argv) ? argv : [];
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  const command = all[0];
  const args = all.slice(1);
  const confirm = has(args, "confirm");
  const phone = argOf(args, "phone");

  if (!E164.test(phone || "")) push("phone", "must be an E.164 business phone number (--phone)");

  if (command === "campaign") {
    const campaignId = argOf(args, "campaign-id");
    const name = argOf(args, "name");
    const templateKey = argOf(args, "template-key");
    const complianceClass = argOf(args, "compliance-class");
    const audience = argOf(args, "audience");
    const config = decodeConfigB64(argOf(args, "config"), push);
    if (!name) push("name", "is required (--name)");
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        command,
        confirm,
        businessPhone: phone,
        meta: { id: campaignId || undefined, name, template_key: templateKey, compliance_class: complianceClass, audience },
        config,
      },
    };
  }

  if (command === "status") {
    const campaignId = argOf(args, "campaign-id");
    const status = argOf(args, "status");
    if (!campaignId) push("campaign-id", "is required (--campaign-id)");
    if (!CAMPAIGN_STATUSES.includes(status)) push("status", `must be one of ${CAMPAIGN_STATUSES.join(", ")} (--status)`);
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, campaignId, status } };
  }

  if (command === "outbound") {
    const enabledRaw = argOf(args, "enabled");
    const maxRaw = argOf(args, "max");
    if (enabledRaw !== "true" && enabledRaw !== "false") push("enabled", "must be true or false (--enabled)");
    const max = maxRaw !== null ? Number(maxRaw) : NaN;
    if (!Number.isInteger(max) || max < 1 || max > MAX_OUTBOUND_CONCURRENT) {
      push("max", `must be a whole number from 1 to ${MAX_OUTBOUND_CONCURRENT} (--max)`);
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, enabled: enabledRaw === "true", max } };
  }

  if (command === "trigger") {
    const campaignId = argOf(args, "campaign-id");
    const contactPhone = argOf(args, "contact-phone");
    const firstName = argOf(args, "first-name") || null;
    // Validated (and required outside +44) by triggerOutreach -- one place.
    const timezone = argOf(args, "timezone") || null;
    const consentManual = has(args, "consent-manual");
    if (!campaignId) push("campaign-id", "is required (--campaign-id)");
    if (!E164.test(contactPhone || "")) push("contact-phone", "must be an E.164 number (--contact-phone)");
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: { command, confirm, businessPhone: phone, campaignId, phone: contactPhone, timezone, firstName, consentManual },
    };
  }

  if (command === "unsuppress") {
    const contactPhone = argOf(args, "contact-phone");
    if (!E164.test(contactPhone || "")) push("contact-phone", "must be an E.164 number (--contact-phone)");
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, contactPhone } };
  }

  if (command === "webhook-set") {
    const endpointId = argOf(args, "endpoint-id");
    const url = argOf(args, "url");
    const eventsRaw = argOf(args, "events");
    const events = eventsRaw
      ? eventsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const activeRaw = argOf(args, "active");
    const active = activeRaw === null ? true : activeRaw === "true";
    if (activeRaw !== null && activeRaw !== "true" && activeRaw !== "false") push("active", "must be true or false (--active)");
    if (!url) push("url", "is required (--url), an https:// endpoint");
    // D6 (final review, security): the signing secret must never be a Cloud
    // Run job ARGUMENT -- a job execution's args are readable afterward
    // (`gcloud run jobs executions describe`) and are visible to anyone who
    // can list this process while it runs, unlike an environment variable
    // or a piped stream. Refused outright, with a reason, rather than
    // silently accepted and quietly exposed.
    if (has(args, "secret")) {
      push(
        "secret",
        "must not be passed on the command line -- it is retained in the job execution's stored arguments; " +
          "set WEBHOOK_SECRET in the environment, or pipe it on stdin with --secret-stdin"
      );
    }
    let secret = process.env.WEBHOOK_SECRET || null;
    if (!secret && has(args, "secret-stdin")) secret = readSecretFromStdin();
    if (!secret) push("secret", "is required -- set WEBHOOK_SECRET in the environment, or pipe it on stdin with --secret-stdin");
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, endpointId: endpointId || undefined, url, secret, events, active } };
  }

  if (command === "webhook-test") {
    const endpointId = argOf(args, "endpoint-id");
    if (!endpointId) push("endpoint-id", "is required (--endpoint-id)");
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, endpointId } };
  }

  if (command === "trigger-token-rotate") {
    const campaignId = argOf(args, "campaign-id");
    if (!campaignId) push("campaign-id", "is required (--campaign-id)");
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: { command, confirm, businessPhone: phone, campaignId } };
  }

  push(
    "command",
    `must be one of campaign, status, outbound, trigger, unsuppress, webhook-set, webhook-test, trigger-token-rotate (got ${JSON.stringify(command ?? null)})`
  );
  return { ok: false, errors };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error(`Refusing: ${e.path}: ${e.message}`);
    process.exit(1);
  }
  const { client, close } = await connect();
  try {
    const v = parsed.value;
    let result;
    if (v.command === "campaign") result = await upsertCampaign(client, v);
    else if (v.command === "status") result = await setCampaignStatus(client, v);
    else if (v.command === "outbound") result = await setBusinessOutbound(client, v);
    else if (v.command === "unsuppress") result = await unsuppress(client, v);
    else if (v.command === "webhook-set") result = await webhookSet(client, v);
    else if (v.command === "webhook-test") result = await webhookTest(client, v);
    else if (v.command === "trigger-token-rotate") result = await rotateTriggerToken(client, v);
    else result = await triggerOutreach(client, v);

    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
  } finally {
    await close?.();
  }
}

// Guarded exactly as import-tenant.js is: importing this module (the build's
// smoke-verifiers step does, to prove the COPY and the .dockerignore negation
// both landed) resolves the tree without opening a connection.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`outbound-admin failed: ${e.message}`);
    process.exit(1);
  });
}
