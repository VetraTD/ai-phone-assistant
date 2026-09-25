/**
 * `scripts/outbound-admin.js` against a real PostgreSQL, as a role that
 * CANNOT bypass row-level security.
 *
 * WHY THIS ROLE, exactly as tests/db/importTenant.test.js explains: local
 * `vetra` is a superuser with `rolbypassrls = true`, so it sails past every
 * policy on `campaigns` / `campaign_versions` / `contacts` / `consents` /
 * `outreach` (all FORCE ROW LEVEL SECURITY, migration 042). A test run as
 * `vetra` would pass whether outbound-admin.js's set_config dance is right or
 * completely absent. Every test here therefore runs as `outbound_admin_probe`,
 * created NOSUPERUSER NOBYPASSRLS, and one test ASSERTS THAT PROPERTY rather
 * than trusting it.
 *
 * `app_lookup_business_by_phone` is REVOKEd from PUBLIC and granted only to
 * `vetra_app` (schema.sql:802-804), so the probe role also needs an explicit
 * EXECUTE grant on it -- import_probe never needed this because import-tenant.js
 * reads `business_directory` directly rather than calling the function.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  parseArgs,
  upsertCampaign,
  setCampaignStatus,
  setBusinessOutbound,
  triggerOutreach,
} from "../../scripts/outbound-admin.js";
import { TEMPLATES, PURPOSE_BY_TEMPLATE } from "../../lib/outbound/templates.js";

const ADMIN_URL = process.env.DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

const PROBE_ROLE = "outbound_admin_probe";
const PROBE_PASS = "probe_only";

const BUSINESS_PHONE = "+15550199001";
const ALLOWED_PHONE = "+15550199002";
const NOT_ALLOWED_PHONE = "+15550199003";
const BUSINESS_NAME = "Digile Media"; // same fixture name outboundCampaignSchema.test.js uses; the shipped speed_to_lead template's rendered lengths were designed against it.

const META = { name: "Speed to lead", template_key: "speed_to_lead", compliance_class: "solicited", audience: "business" };
const goodConfig = () => ({ ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" });

let admin;
let probeUrl;
let businessId;

async function asProbe(fn) {
  const c = new pg.Client({ connectionString: probeUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // Revoke before drop, and no silent catch on the drop itself -- a leftover
  // role from a previous failed run must fail loudly in CREATE ROLE, not hide
  // behind a swallowed DROP ROLE error (the importTenant.test.js lesson).
  await admin.query(`REVOKE ALL ON FUNCTION app_lookup_business_by_phone(text) FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT EXECUTE ON FUNCTION app_lookup_business_by_phone(text) TO ${PROBE_ROLE}`);

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probeUrl = u.toString();

  await admin.query(`DELETE FROM businesses WHERE phone_number LIKE '+1555019900%'`);
  const b = await admin.query(
    `INSERT INTO businesses (name, phone_number, timezone) VALUES ($1, $2, 'Europe/London') RETURNING id`,
    [BUSINESS_NAME, BUSINESS_PHONE]
  );
  businessId = b.rows[0].id;
}, 60000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE phone_number LIKE '+1555019900%'`).catch(() => {});
  await admin.query(`REVOKE ALL ON FUNCTION app_lookup_business_by_phone(text) FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

describeDb("outbound-admin: the probe role is honest", () => {
  it("cannot bypass row-level security, which is what makes every other test here mean something", async () => {
    const r = await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("campaigns/contacts/consents/outreach really are FORCE row-level security, so the writes below are a real test", async () => {
    for (const t of ["campaigns", "campaign_versions", "contacts", "consents", "outreach"]) {
      const r = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [t]);
      expect(r.rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });
});

describeDb("outbound-admin: parseArgs", () => {
  it("refuses an unknown command", () => {
    const r = parseArgs(["frobnicate", "--phone", "+15550100000"]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("command");
  });

  it("parses a campaign upsert, decoding --config from base64", () => {
    const cfg = goodConfig();
    const b64 = Buffer.from(JSON.stringify(cfg)).toString("base64");
    const r = parseArgs([
      "campaign", "--phone", BUSINESS_PHONE, "--name", META.name,
      "--template-key", META.template_key, "--compliance-class", META.compliance_class,
      "--audience", META.audience, "--config", b64,
    ]);
    expect(r.ok).toBe(true);
    expect(r.value.confirm).toBe(false);
    expect(r.value.meta).toMatchObject({ name: META.name, template_key: META.template_key });
    expect(r.value.config).toEqual(cfg);
  });

  it("rejects a non-E.164 --phone", () => {
    const r = parseArgs(["outbound", "--phone", "0117", "--enabled", "true", "--max", "2"]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("phone");
  });

  it("parses trigger, including --consent-manual as a flag", () => {
    const r = parseArgs([
      "trigger", "--phone", BUSINESS_PHONE, "--campaign-id", "11111111-1111-4111-8111-111111111111",
      "--contact-phone", ALLOWED_PHONE, "--first-name", "Sam", "--consent-manual", "--confirm",
    ]);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ businessPhone: BUSINESS_PHONE, phone: ALLOWED_PHONE, firstName: "Sam", consentManual: true, confirm: true });
  });
});

describeDb("outbound-admin: upsertCampaign", () => {
  it("a dry run writes nothing", async () => {
    const before = await admin.query(`SELECT count(*)::int AS n FROM campaigns WHERE business_id = $1`, [businessId]);
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: META, config: goodConfig(), confirm: false }));
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(r.wouldWrite.version).toBe(1);
    const after = await admin.query(`SELECT count(*)::int AS n FROM campaigns WHERE business_id = $1`, [businessId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("--confirm creates the campaign plus version 1, and it reads back", async () => {
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: META, config: goodConfig(), confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.version).toBe(1);

    // Read back as admin -- the row actually landed, scoped to this tenant.
    const c = await admin.query(`SELECT name, template_key, compliance_class, audience, current_version, business_id FROM campaigns WHERE id = $1`, [r.campaignId]);
    expect(c.rowCount).toBe(1);
    expect(c.rows[0]).toMatchObject({ name: META.name, template_key: "speed_to_lead", compliance_class: "solicited", audience: "business", current_version: 1, business_id: businessId });

    const v = await admin.query(`SELECT version, config FROM campaign_versions WHERE campaign_id = $1`, [r.campaignId]);
    expect(v.rowCount).toBe(1);
    expect(v.rows[0].version).toBe(1);
    expect(v.rows[0].config.caller_id).toBe("+441372656055");
  });

  it("updating an existing campaign id inserts version 2 and bumps current_version", async () => {
    const created = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "v1 name" }, config: goodConfig(), confirm: true }));
    expect(created.ok).toBe(true);

    const updated = await asProbe((c) =>
      upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id: created.campaignId, name: "v2 name" }, config: { ...goodConfig(), topic: "a new topic" }, confirm: true })
    );
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(updated.campaignId).toBe(created.campaignId);
    expect(updated.version).toBe(2);

    const c = await admin.query(`SELECT name, current_version FROM campaigns WHERE id = $1`, [created.campaignId]);
    expect(c.rows[0]).toEqual({ name: "v2 name", current_version: 2 });
    const versions = await admin.query(`SELECT version FROM campaign_versions WHERE campaign_id = $1 ORDER BY version`, [created.campaignId]);
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it("an invalid config is refused with the validator's error paths, and nothing is written", async () => {
    const before = await admin.query(`SELECT count(*)::int AS n FROM campaigns WHERE business_id = $1`, [businessId]);
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "bad" }, config: { ...goodConfig(), caller_id: "not-e164" }, confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("caller_id");
    const after = await admin.query(`SELECT count(*)::int AS n FROM campaigns WHERE business_id = $1 AND name = 'bad'`, [businessId]);
    expect(after.rows[0].n).toBe(0);
    const total = await admin.query(`SELECT count(*)::int AS n FROM campaigns WHERE business_id = $1`, [businessId]);
    expect(total.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuses a business phone that resolves to nothing", async () => {
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: "+19995550000", meta: META, config: goodConfig(), confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no business has phone_number/);
  });
});

describeDb("outbound-admin: setCampaignStatus", () => {
  let campaignId;
  beforeAll(async () => {
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "status target" }, config: goodConfig(), confirm: true }));
    campaignId = r.campaignId;
  });

  it("a dry run writes nothing", async () => {
    const before = await admin.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    const r = await asProbe((c) => setCampaignStatus(c, { businessPhone: BUSINESS_PHONE, campaignId, status: "active", confirm: false }));
    expect(r).toMatchObject({ ok: true, dryRun: true, wouldWrite: { campaignId, status: "active" } });
    const after = await admin.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(after.rows[0].status).toBe(before.rows[0].status);
  });

  it("--confirm moves the campaign to active and reads back", async () => {
    const r = await asProbe((c) => setCampaignStatus(c, { businessPhone: BUSINESS_PHONE, campaignId, status: "active", confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await admin.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(after.rows[0].status).toBe("active");
  });
});

describeDb("outbound-admin: setBusinessOutbound", () => {
  it("a dry run writes nothing", async () => {
    const before = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    const r = await asProbe((c) => setBusinessOutbound(c, { businessPhone: BUSINESS_PHONE, enabled: true, max: 3, confirm: false }));
    expect(r).toMatchObject({ ok: true, dryRun: true });
    const after = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("--confirm switches outbound on and sets max concurrent, and reads back", async () => {
    const r = await asProbe((c) => setBusinessOutbound(c, { businessPhone: BUSINESS_PHONE, enabled: true, max: 3, confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    expect(after.rows[0]).toEqual({ outbound_enabled: true, outbound_max_concurrent: 3 });
  });
});

describeDb("outbound-admin: triggerOutreach", () => {
  let campaignId;
  const OLD_ALLOWLIST = process.env.OUTBOUND_TEST_ALLOWLIST;

  beforeAll(async () => {
    process.env.OUTBOUND_TEST_ALLOWLIST = ALLOWED_PHONE;
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "trigger target" }, config: goodConfig(), confirm: true }));
    campaignId = r.campaignId;
  });

  afterAll(() => {
    if (OLD_ALLOWLIST === undefined) delete process.env.OUTBOUND_TEST_ALLOWLIST;
    else process.env.OUTBOUND_TEST_ALLOWLIST = OLD_ALLOWLIST;
  });

  it("a dry run writes nothing", async () => {
    const beforeContacts = await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE business_id = $1`, [businessId]);
    const beforeOutreach = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1`, [businessId]);
    const r = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone: ALLOWED_PHONE, firstName: "Sam", consentManual: false, confirm: false }));
    expect(r).toMatchObject({ ok: true, dryRun: true });
    const afterContacts = await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE business_id = $1`, [businessId]);
    const afterOutreach = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1`, [businessId]);
    expect(afterContacts.rows[0].n).toBe(beforeContacts.rows[0].n);
    expect(afterOutreach.rows[0].n).toBe(beforeOutreach.rows[0].n);
  });

  it("--consent-manual for a number NOT on the allow-list is refused, and nothing is written", async () => {
    const beforeContacts = await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [businessId, NOT_ALLOWED_PHONE]);
    const r = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone: NOT_ALLOWED_PHONE, firstName: "Nope", consentManual: true, confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OUTBOUND_TEST_ALLOWLIST/);
    const afterContacts = await admin.query(`SELECT count(*)::int AS n FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [businessId, NOT_ALLOWED_PHONE]);
    expect(afterContacts.rows[0].n).toBe(beforeContacts.rows[0].n);
    const outreach = await admin.query(`SELECT count(*)::int AS n FROM outreach o JOIN contacts k ON k.id = o.contact_id WHERE k.phone_e164 = $1`, [NOT_ALLOWED_PHONE]);
    expect(outreach.rows[0].n).toBe(0);
  });

  it("--confirm with --consent-manual for an allow-listed number creates contact, consent and outreach, and they read back", async () => {
    const r = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone: ALLOWED_PHONE, firstName: "Sam", consentManual: true, confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.created).toBe(true);

    const contact = await admin.query(`SELECT id, first_name FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [businessId, ALLOWED_PHONE]);
    expect(contact.rowCount).toBe(1);
    expect(contact.rows[0].id).toBe(r.contactId);
    expect(contact.rows[0].first_name).toBe("Sam");

    const consent = await admin.query(`SELECT source, covers_automated, purpose, channels FROM consents WHERE contact_id = $1`, [r.contactId]);
    expect(consent.rowCount).toBe(1);
    expect(consent.rows[0]).toMatchObject({ source: "manual", covers_automated: true, purpose: PURPOSE_BY_TEMPLATE.speed_to_lead, channels: ["call"] });

    const outreach = await admin.query(`SELECT id, state, next_attempt_at, idempotency_key FROM outreach WHERE id = $1`, [r.outreachId]);
    expect(outreach.rowCount).toBe(1);
    expect(outreach.rows[0].state).toBe("waiting");
    expect(outreach.rows[0].next_attempt_at).not.toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    expect(outreach.rows[0].idempotency_key).toBe(`admin:${campaignId}:${ALLOWED_PHONE}:${today}`);
  });

  it("is idempotent: triggering the same phone and campaign again the same day gives exactly one outreach row", async () => {
    const first = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1 AND campaign_id = $2`, [businessId, campaignId]);

    const r = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone: ALLOWED_PHONE, firstName: "Sam", consentManual: true, confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.created).toBe(false); // conflicted -- the row from the previous test already exists

    const after = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1 AND campaign_id = $2`, [businessId, campaignId]);
    expect(after.rows[0].n).toBe(first.rows[0].n);

    // No duplicate manual-consent spam on the retrigger either.
    const consents = await admin.query(`SELECT count(*)::int AS n FROM consents WHERE contact_id = $1`, [r.contactId]);
    expect(consents.rows[0].n).toBe(1);
  });
});
