// tests/db/outboundRls.test.js
/**
 * Every outbound table refuses a cross-tenant read AND write as vetra_app.
 * Pattern: tests/db/crossTenantIsolation.test.js (SET ROLE vetra_app, scope by
 * set_config). Runs as vetra_app, never as the `vetra` superuser -- a superuser
 * sails past every policy and would make this file green whatever the SQL says.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const A = "0b0b0000-0000-4000-8000-00000000000a";
const B = "0b0b0000-0000-4000-8000-00000000000b";
const TABLES = [
  "campaigns", "campaign_versions", "contacts", "consents", "suppressions",
  "outreach", "call_attempts", "webhook_endpoints", "outbox",
];
let admin;

async function seedTenant(id, tag) {
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, `RLS ${tag}`]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version)
     VALUES ($1, 'c', 'speed_to_lead', 'solicited', 'business', 'draft', 1) RETURNING id`, [id]);
  const cid = camp.rows[0].id;
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,'{}')`, [cid, id]);
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1, $2, 'Sam') RETURNING id`,
    [id, tag === "A" ? "+447700900001" : "+447700900002"]);
  const contactId = con.rows[0].id;
  await admin.query(
    `INSERT INTO consents (business_id, contact_id, purpose, channels, covers_automated, source, wording_version, wording_text, captured_at, expires_at)
     VALUES ($1,$2,'enquiry_followup','{call}',true,'form','v1','text',now(),now()+interval '30 days')`, [id, contactId]);
  await admin.query(`INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'manual','dashboard')`,
    [id, tag === "A" ? "+447700900091" : "+447700900092"]);
  const o = await admin.query(
    `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, attempts_made, trigger, idempotency_key)
     VALUES ($1,$2,1,$3,'waiting',0,'{}',$4) RETURNING id`, [id, cid, contactId, `k-${tag}`]);
  await admin.query(
    `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number)
     VALUES ($1,$2,1,'+441372656055','+447700900001')`, [id, o.rows[0].id]);
  await admin.query(
    `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active)
     VALUES ($1,'https://example.com/h','\\x00','{call.completed}',true)`, [id]);
  await admin.query(
    `INSERT INTO outbox (business_id, kind, target_id, event_type, payload, idempotency_key, status, attempts, next_attempt_at)
     VALUES ($1,'webhook',gen_random_uuid(),'call.completed','{}',$2,'pending',0,now())`, [id, `ob-${tag}`]);
}

// One client per call: SET LOCAL ROLE and the scope must not leak between
// assertions, and ROLLBACK keeps every probe side-effect free.
async function asApp(businessId, sql, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE vetra_app");
    if (businessId) await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const r = await client.query(sql, params);
    await client.query("ROLLBACK");
    return r;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [A, B]);
  await seedTenant(A, "A");
  await seedTenant(B, "B");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [A, B]);
  await admin.end();
});

d("outbound tables: RLS is on and FORCED", () => {
  it.each(TABLES)("%s has ENABLE and FORCE row level security", async (t) => {
    const r = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [t]);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

d("outbound tables: tenant A cannot see or touch tenant B", () => {
  it.each(TABLES)("%s: a scoped read returns only the scoped tenant's rows", async (t) => {
    const r = await asApp(A, `SELECT DISTINCT business_id::text AS b FROM ${t} WHERE business_id IN ($1,$2)`, [A, B]);
    expect(r.rows.map((x) => x.b)).toEqual([A]);
  });

  it.each(TABLES)("%s: an unscoped read returns nothing", async (t) => {
    const r = await asApp(null, `SELECT count(*)::int AS n FROM ${t} WHERE business_id IN ($1,$2)`, [A, B]);
    expect(r.rows[0].n).toBe(0);
  });

  it.each(TABLES)("%s: a cross-tenant UPDATE matches zero rows", async (t) => {
    const r = await asApp(A, `UPDATE ${t} SET business_id = business_id WHERE business_id = $1`, [B]);
    expect(r.rowCount).toBe(0);
  });

  it("a cross-tenant INSERT is refused by WITH CHECK", async () => {
    await expect(
      asApp(A, `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,'+447700900099','manual','api')`, [B])
    ).rejects.toThrow(/row-level security/);
  });
});

d("outbound tables: the constraints the engine relies on", () => {
  it("call_attempts (outreach_id, attempt_no) is unique -- the double-dial lock", async () => {
    const o = await admin.query(`SELECT id FROM outreach WHERE business_id = $1`, [A]);
    await expect(
      admin.query(`INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number)
                   VALUES ($1,$2,1,'+441372656055','+447700900001')`, [A, o.rows[0].id])
    ).rejects.toThrow(/duplicate key/);
  });

  it("outreach (business_id, idempotency_key) is unique -- a trigger replayed twice is one outreach", async () => {
    const r = await admin.query(`SELECT campaign_id, contact_id FROM outreach WHERE business_id = $1`, [A]);
    await expect(
      admin.query(`INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, attempts_made, trigger, idempotency_key)
                   VALUES ($1,$2,1,$3,'waiting',0,'{}','k-A')`, [A, r.rows[0].campaign_id, r.rows[0].contact_id])
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses an unknown compliance class at the database, not only in code", async () => {
    await expect(
      admin.query(`INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version)
                   VALUES ($1,'x','custom','cold_calling','business','draft',1)`, [A])
    ).rejects.toThrow(/check constraint/);
  });

  it("contacts (business_id, phone_e164) is unique", async () => {
    await expect(
      admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900001')`, [A])
    ).rejects.toThrow(/duplicate key/);
  });
});
