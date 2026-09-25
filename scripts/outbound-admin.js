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
//     --contact-phone +1... [--first-name "Sam"] [--consent-manual] [--confirm]
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { connect } from "./migrate.js";
import { validateCampaign } from "../lib/outbound/campaignSchema.js";
import { PURPOSE_BY_TEMPLATE } from "../lib/outbound/templates.js";
import { outboundEnv } from "../lib/outbound/config.js";
// The dial-time gate honours this consent only while the number is on the
// SERVICE's allow-list (Checkpoint 2a, F4); one constant, so the two agree.
import { OPERATOR_TEST_WORDING } from "../lib/outbound/gate.js";

const E164 = /^\+[1-9]\d{6,14}$/;
const CAMPAIGN_STATUSES = ["draft", "active", "paused"];
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
export async function triggerOutreach(client, { businessPhone, campaignId, phone, firstName, consentManual, confirm }) {
  if (!E164.test(businessPhone || "")) {
    return { ok: false, error: "businessPhone must be an E.164 number" };
  }
  if (!campaignId) {
    return { ok: false, error: "campaignId is required" };
  }
  if (!E164.test(phone || "")) {
    return { ok: false, error: "phone must be an E.164 number" };
  }

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
      contact: { phone_e164: phone, first_name: firstName || null },
      consent: consentManual
        ? { source: "manual", covers_automated: true, purpose, channels: ["call"], wording_version: OPERATOR_TEST_WORDING }
        : null,
      outreach: { state: "waiting", next_attempt_at: "now()", trigger: { source: "outbound-admin" }, idempotency_key: idempotencyKey },
    };

    if (!confirm) {
      await client.query("ROLLBACK");
      return { ok: true, dryRun: true, wouldWrite };
    }

    // COALESCE (Checkpoint 2a, M8b): a re-run without --first-name keeps the
    // stored name rather than wiping the one Ava greets the contact by.
    const contactRes = await client.query(
      `INSERT INTO contacts (business_id, phone_e164, first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id, phone_e164) DO UPDATE SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name), updated_at = now()
       RETURNING id`,
      [business.id, phone, firstName || null]
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
// CLI argument parsing
// ---------------------------------------------------------------------------
function argOf(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith("--") ? args[i + 1] : null;
}
function has(args, name) {
  return args.includes(`--${name}`);
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
    const consentManual = has(args, "consent-manual");
    if (!campaignId) push("campaign-id", "is required (--campaign-id)");
    if (!E164.test(contactPhone || "")) push("contact-phone", "must be an E.164 number (--contact-phone)");
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: { command, confirm, businessPhone: phone, campaignId, phone: contactPhone, firstName, consentManual },
    };
  }

  push("command", `must be one of campaign, status, outbound, trigger (got ${JSON.stringify(command ?? null)})`);
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
