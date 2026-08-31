/**
 * Import ONE tenant's CONFIGURATION into a Cloud SQL database.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Lane U needed the `Digile Media` tenant — live on Railway/Supabase, routing
 * +441372656055 — to exist on the UK GCP stack so the same number answers the
 * same way. That is a one-tenant rehearsal of D3, and the same script is what
 * D3 needs when the US clinic moves, which is why this is committed rather than
 * done by hand.
 *
 * There is no hand to do it by, besides. Staging and production Cloud SQL are
 * private-IP only, so the only routes to them are Cloud SQL Studio in a browser
 * and a script inside the image run through the migrate job. That is the second
 * standing rule this repository has paid for: anything you would do by hand
 * against this database has to be a committed script.
 *
 * CONFIGURATION ONLY. NEVER PHI.
 * ------------------------------
 * This writes `businesses` and `business_capabilities`. It does not read or
 * write `calls`, `call_transcripts`, `appointments`, `customer_requests`,
 * `sms_consents` or `phi_access_log`, and it refuses to if asked — see
 * REFUSED_TABLES. Moving call history is a personal-data migration that belongs
 * in an Art. 30 record and a deliberate decision, not in a config import.
 *
 * WHY IT DOES NOT USE app_create_business_for_user
 * ------------------------------------------------
 * That function is the sanctioned ONBOARDING path and it creates a business AND
 * a `users` row keyed on an Identity Platform `auth_uid`. An import has no such
 * account. Passing a synthetic one would look like it worked and would STRAND
 * the real person later: their genuine signup mints a different `auth_uid`, the
 * migration-036 lookup misses, and `create-business` then refuses with 23505
 * because the email is already taken. There is no "join an existing business"
 * flow anywhere in this codebase to recover with.
 *
 * So this creates the BUSINESS ONLY, using the same mechanism the function uses
 * internally: generate the id, become that tenant for the transaction, then
 * insert with the id explicitly. `businesses`' WITH CHECK is
 * `id = app_current_business_id()`, so the scope has to be the row being
 * created — letting the DEFAULT generate an id is exactly what made migration
 * 031 unsatisfiable.
 *
 * CONSEQUENCE, recorded rather than papered over: the imported tenant has no
 * dashboard user. Attaching one later needs a flow that does not exist yet.
 *
 * IDEMPOTENT. Re-running with the same payload updates the existing row rather
 * than creating a second tenant on the same number — `businesses_phone_number_unique`
 * would refuse the duplicate anyway, but failing on a unique index is a worse
 * way to find out than not attempting it.
 *
 * USAGE — the payload arrives BASE64, and that is not decoration:
 *
 *   B64=$(base64 -w0 tenant.json)
 *   gcloud run jobs execute vetra-migrate-uk-prod \
 *     --region=europe-west2 --project=vetra-uk-prod-c3a3bd \
 *     --args=scripts/import-tenant.js \
 *     --update-env-vars=IMPORT_TENANT_B64=$B64
 *
 * `gcloud ... --args` splits on commas and then on whatever custom delimiter
 * you pick if that character appears in the payload; four attempts at carrying
 * a JSON payload that way failed on the transport rather than the logic.
 * `--update-env-vars` splits on commas too, and JSON is mostly commas. Base64's
 * alphabet is A-Za-z0-9+/= — no comma — so it survives. It is also
 * EXECUTION-SCOPED, verified, so it leaves no drift on the job definition.
 */

import { pathToFileURL } from "node:url";
import { connect } from "./migrate.js";

// Columns this import is allowed to set on `businesses`. Anything else in the
// payload is IGNORED WITH A WARNING rather than rejected: a source database one
// migration behind (or ahead) should not fail the import, and silently dropping
// it is how you discover months later that hours never came across.
const BUSINESS_FIELDS = [
  "name",
  "phone_number",
  "timezone",
  "locale",
  "greeting",
  "business_hours",
  "transfer_phone_number",
  "transfer_policy",
  "after_hours_policy",
  "allowed_tasks",
  "main_phone",
  "general_info",
  "custom_instructions",
  "languages_spoken",
  "recording_disclosure_enabled",
  "recording_disclosure_text",
  "notification_email",
  "notification_phone",
  "notifications_enabled",
  "voice_provider",
  "voice_id",
  // NO voice_style. Migration 002 added it and 012 dropped it, but this list
  // kept naming it — so every INSERT named a column the table does not have and
  // the whole tenant import failed, which is exactly how Phase 5's Gate 3 died
  // on its first run. tests/importTenantFields.test.js now checks this list
  // against the migration history so the next dropped column cannot repeat it.
  "sms_followup_enabled",
  "sms_templates",
];

// Named so the refusal is specific rather than a general "looks like PHI".
const REFUSED_TABLES = [
  "calls",
  "call_transcripts",
  "appointments",
  "customer_requests",
  "sms_consents",
  "phi_access_log",
];

const JSONB_FIELDS = new Set([
  "business_hours",
  "allowed_tasks",
  "languages_spoken",
  "sms_templates",
]);

export function parsePayload(b64) {
  if (!b64 || !String(b64).trim()) {
    throw new Error(
      "IMPORT_TENANT_B64 is not set. Pass base64 of the tenant JSON — see this file's header."
    );
  }
  let json;
  try {
    json = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  } catch {
    throw new Error("IMPORT_TENANT_B64 is not valid base64.");
  }
  let payload;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    throw new Error(`IMPORT_TENANT_B64 decoded but is not JSON: ${e.message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be a JSON object.");
  }

  // The refusal, before a connection is opened. A script that will not move PHI
  // should say so before it touches the database, not after.
  for (const t of REFUSED_TABLES) {
    if (t in payload) {
      throw new Error(
        `Payload contains "${t}". This script imports CONFIGURATION ONLY and will not move patient data. ` +
          `Moving call history is a personal-data migration and needs its own decision.`
      );
    }
  }

  const business = payload.business;
  if (!business || typeof business !== "object") {
    throw new Error('Payload needs a "business" object.');
  }
  for (const req of ["name", "timezone"]) {
    if (!business[req] || !String(business[req]).trim()) {
      throw new Error(`business.${req} is required.`);
    }
  }

  // `businesses.timezone` HAS NO DATABASE CONSTRAINT — measured, not assumed:
  // `pg_constraint` carries CHECKs for `locale` and `compliance_tier` and
  // nothing for this. The dashboard API validates against ALLOWED_TIMEZONES,
  // and this script is a direct-to-database path that never passes through it,
  // so "Not/AZone" inserts happily and fails much later as wrong opening hours
  // and mis-phrased dates on a live call.
  //
  // Found by a rollback test that assumed the database would refuse it. The
  // test was wrong and the schema was the finding.
  //
  // Intl is the check because it consults the real IANA database rather than a
  // list that goes stale — a hand-maintained array is how `Europe/Kyiv` gets
  // rejected two years after it was added.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(business.timezone) });
  } catch {
    throw new Error(
      `business.timezone "${business.timezone}" is not a recognised IANA time zone. ` +
        `The column has no CHECK constraint, so the database would have accepted it.`
    );
  }

  const known = {};
  const ignored = [];
  for (const [k, v] of Object.entries(business)) {
    if (BUSINESS_FIELDS.includes(k)) known[k] = v;
    else ignored.push(k);
  }

  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  return { business: known, ignored, capabilities };
}

function encode(field, value) {
  if (value === null || value === undefined) return null;
  return JSONB_FIELDS.has(field) ? JSON.stringify(value) : value;
}

export async function importTenant(client, { business, ignored, capabilities }) {
  if (ignored.length) {
    console.log(`ignoring ${ignored.length} unknown field(s): ${ignored.join(", ")}`);
  }

  const phone = business.phone_number ? String(business.phone_number).trim() : null;

  await client.query("BEGIN");
  try {
    // Does this number already route somewhere? `business_directory` carries
    // phone -> business_id, has NO row-level security, and is maintained by a
    // trigger on `businesses`. Asking it avoids the chicken-and-egg of needing
    // a tenant scope in order to discover the tenant.
    let existingId = null;
    if (phone) {
      const r = await client.query(
        "SELECT business_id FROM business_directory WHERE phone_number = $1",
        [phone]
      );
      existingId = r.rows[0]?.business_id ?? null;
    }

    const id = existingId ?? (await client.query("SELECT gen_random_uuid() AS id")).rows[0].id;

    // Become the tenant for this transaction. `true` scopes it to the
    // transaction, so a failure leaves no scope behind on a pooled connection.
    await client.query("SELECT set_config('app.business_id', $1, true)", [String(id)]);

    const fields = Object.keys(business);
    if (existingId) {
      const sets = fields.map((f, i) => `${f} = $${i + 2}`);
      await client.query(
        `UPDATE businesses SET ${sets.join(", ")} WHERE id = $1`,
        [id, ...fields.map((f) => encode(f, business[f]))]
      );
      console.log(`updated existing tenant ${id} (matched on ${phone})`);
    } else {
      const cols = ["id", ...fields];
      const ph = cols.map((_, i) => `$${i + 1}`);
      await client.query(
        `INSERT INTO businesses (${cols.join(", ")}) VALUES (${ph.join(", ")})`,
        [id, ...fields.map((f) => encode(f, business[f]))]
      );
      console.log(`created tenant ${id}`);
    }

    for (const cap of capabilities) {
      const capId = cap.capability_id ?? cap.capability ?? cap.id;
      if (!capId) continue;
      await client.query(
        `INSERT INTO business_capabilities (business_id, capability_id, enabled, config)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, capability_id)
         DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
        [id, capId, cap.enabled !== false, JSON.stringify(cap.config ?? {})]
      );
      console.log(`  capability ${capId}: enabled=${cap.enabled !== false}`);
    }

    // Read it back INSIDE the transaction and through row-level security, so
    // what is reported is what the application will actually be able to see —
    // not what the writer believes it wrote. An unscoped read under FORCE RLS
    // returns zero rows and reports success.
    const check = await client.query(
      "SELECT id, name, phone_number, timezone FROM businesses WHERE id = $1",
      [id]
    );
    if (check.rowCount !== 1) {
      throw new Error("read-back returned no row — refusing to commit");
    }
    const dir = await client.query(
      "SELECT business_id FROM business_directory WHERE phone_number = $1",
      [phone]
    );

    await client.query("COMMIT");

    const row = check.rows[0];
    console.log("");
    console.log(`EVIDENCE  id=${row.id}  name=${row.name}  phone=${row.phone_number}  tz=${row.timezone}`);
    console.log(
      `EVIDENCE  business_directory routes ${phone} -> ${dir.rows[0]?.business_id ?? "(NOTHING — the number will not route)"}`
    );
    return row;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main() {
  const parsed = parsePayload(process.env.IMPORT_TENANT_B64);
  const { client, close } = await connect();
  try {
    await importTenant(client, parsed);
  } finally {
    await close?.();
  }
}

// Guarded so importing this module — which the image's `smoke-verifiers` build
// step does, to prove the COPY and the .dockerignore negation both landed —
// resolves the tree without opening a connection.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`import-tenant failed: ${e.message}`);
    process.exit(1);
  });
}
