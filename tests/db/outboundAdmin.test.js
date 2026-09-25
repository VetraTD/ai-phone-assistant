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
import { OPERATOR_TEST_WORDING } from "../../lib/outbound/gate.js";

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

// Checkpoint 2a, M8(a). In-flight outreach is pinned to an older campaign
// version and was consented/gated under that campaign's compliance_class,
// template_key and audience. Changing them on the campaign row would silently
// re-label every pinned outreach's legal basis, so an update refuses to.
describeDb("outbound-admin: upsertCampaign keeps compliance_class, template_key and audience immutable (M8a)", () => {
  const versionsOf = async (id) => (await admin.query(`SELECT version FROM campaign_versions WHERE campaign_id = $1 ORDER BY version`, [id])).rows.map((r) => r.version);
  const rowOf = async (id) => (await admin.query(`SELECT template_key, compliance_class, audience, current_version FROM campaigns WHERE id = $1`, [id])).rows[0];
  // Seeded directly: the validator refuses these values at save in Part 1, so
  // only a row written some other way can carry them -- which is exactly the
  // row an update must not quietly rewrite.
  const seedRaw = async (over) => {
    const r = await admin.query(
      `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, current_version)
       VALUES ($1, 'raw', $2, $3, $4, 1) RETURNING id`,
      [businessId, over.template_key ?? "speed_to_lead", over.compliance_class ?? "solicited", over.audience ?? "business"]);
    await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1, $2, 1, $3)`, [r.rows[0].id, businessId, goodConfig()]);
    return r.rows[0].id;
  };

  it("changing compliance_class on an existing campaign is refused with a clear error, and nothing is written", async () => {
    const created = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "immutable class" }, config: goodConfig(), confirm: true }));
    expect(created.ok).toBe(true);
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id: created.campaignId, name: "immutable class", compliance_class: "service" }, config: goodConfig(), confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/compliance_class/);
    expect(r.error).toMatch(/cannot change/);
    expect(await rowOf(created.campaignId)).toMatchObject({ compliance_class: "solicited", current_version: 1 });
    expect(await versionsOf(created.campaignId)).toEqual([1]);
  });

  it("a DRY RUN of that change is refused too (the operator learns before --confirm)", async () => {
    const created = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "immutable dry" }, config: goodConfig(), confirm: true }));
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id: created.campaignId, name: "immutable dry", compliance_class: "service" }, config: goodConfig(), confirm: false }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/compliance_class/);
    expect(r.error).toMatch(/cannot change/);
  });

  it("changing template_key on an existing campaign is refused", async () => {
    const id = await seedRaw({ template_key: "reminder" });
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id, name: "raw" }, config: goodConfig(), confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/template_key/);
    // The refusal itself, not the read-back mismatch that would also catch
    // an update that no longer writes template_key (a second line, not this one).
    expect(r.error).toMatch(/cannot change/);
    expect(await rowOf(id)).toMatchObject({ template_key: "reminder", current_version: 1 });
    expect(await versionsOf(id)).toEqual([1]);
  });

  it("changing audience on an existing campaign is refused", async () => {
    const id = await seedRaw({ audience: "patient" });
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id, name: "raw" }, config: goodConfig(), confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/audience/);
    expect(r.error).toMatch(/cannot change/);
    expect(await rowOf(id)).toMatchObject({ audience: "patient", current_version: 1 });
    expect(await versionsOf(id)).toEqual([1]);
  });

  it("an update that keeps all three still versions normally", async () => {
    const created = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "immutable ok" }, config: goodConfig(), confirm: true }));
    const r = await asProbe((c) => upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, id: created.campaignId, name: "immutable ok v2" }, config: goodConfig(), confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.version).toBe(2);
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

// Ruling 2a-11 (fix round 1). dispatch.js parks a paused campaign's `waiting`
// outreach with next_attempt_at = NULL -- app_outbound_due (migration 044)
// never lists a NULL as due, so without this fix resuming a campaign here
// (this script is Part 1's only way to set a campaign back to `active`) left
// every parked outreach stranded forever. Spec §8: "A paused campaign holds
// its outreach in waiting without closing it. Resuming re-enqueues them."
describeDb("outbound-admin: setCampaignStatus resumes parked outreach (Ruling 2a-11)", () => {
  let campaignId, outreachNullId, outreachFutureId;
  const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  beforeAll(async () => {
    const created = await asProbe((c) =>
      upsertCampaign(c, { businessPhone: BUSINESS_PHONE, meta: { ...META, name: "resume target" }, config: goodConfig(), confirm: true })
    );
    campaignId = created.campaignId;
    await admin.query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [campaignId]);

    const a = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1, '+15550199010', 'Null') RETURNING id`, [businessId]);
    const b = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1, '+15550199011', 'Future') RETURNING id`, [businessId]);

    // Parked: what the dispatcher leaves behind while a campaign is paused.
    const oa = await admin.query(
      `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, next_attempt_at, trigger, idempotency_key)
       VALUES ($1, $2, 1, $3, 'waiting', NULL, '{}', 'resume-null') RETURNING id`,
      [businessId, campaignId, a.rows[0].id]
    );
    outreachNullId = oa.rows[0].id;
    // Genuinely scheduled for later (e.g. outside_window, tomorrow) -- must
    // never be touched by a resume.
    const ob = await admin.query(
      `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, next_attempt_at, trigger, idempotency_key)
       VALUES ($1, $2, 1, $3, 'waiting', $4, '{}', 'resume-future') RETURNING id`,
      [businessId, campaignId, b.rows[0].id, FUTURE]
    );
    outreachFutureId = ob.rows[0].id;
  });

  it("a dry-run resume changes nothing but reports reArmed = 1", async () => {
    const r = await asProbe((c) => setCampaignStatus(c, { businessPhone: BUSINESS_PHONE, campaignId, status: "active", confirm: false }));
    expect(r).toMatchObject({ ok: true, dryRun: true, wouldWrite: { campaignId, status: "active", reArmed: 1 } });

    const nullRow = await admin.query(`SELECT next_attempt_at FROM outreach WHERE id = $1`, [outreachNullId]);
    expect(nullRow.rows[0].next_attempt_at).toBeNull();
    const campaign = await admin.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(campaign.rows[0].status).toBe("paused");
  });

  it("--confirm resume re-arms the NULL outreach, leaves the future one alone, and reports reArmed = 1", async () => {
    const r = await asProbe((c) => setCampaignStatus(c, { businessPhone: BUSINESS_PHONE, campaignId, status: "active", confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.reArmed).toBe(1);

    const nullRow = await admin.query(`SELECT next_attempt_at FROM outreach WHERE id = $1`, [outreachNullId]);
    expect(nullRow.rows[0].next_attempt_at).not.toBeNull();
    expect(new Date(nullRow.rows[0].next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const futureRow = await admin.query(`SELECT next_attempt_at FROM outreach WHERE id = $1`, [outreachFutureId]);
    expect(new Date(futureRow.rows[0].next_attempt_at).getTime()).toBe(new Date(FUTURE).getTime());

    const campaign = await admin.query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
    expect(campaign.rows[0].status).toBe("active");
  });

  it("pausing again re-arms nothing", async () => {
    const c2 = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1, '+15550199012', 'Null2') RETURNING id`, [businessId]);
    const o2 = await admin.query(
      `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, next_attempt_at, trigger, idempotency_key)
       VALUES ($1, $2, 1, $3, 'waiting', NULL, '{}', 'resume-null-2') RETURNING id`,
      [businessId, campaignId, c2.rows[0].id]
    );

    const r = await asProbe((c) => setCampaignStatus(c, { businessPhone: BUSINESS_PHONE, campaignId, status: "paused", confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.reArmed).toBe(0);

    const still = await admin.query(`SELECT next_attempt_at FROM outreach WHERE id = $1`, [o2.rows[0].id]);
    expect(still.rows[0].next_attempt_at).toBeNull();
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

  it("accepts --max at the dashboard's documented boundary of 10", async () => {
    const r = await asProbe((c) => setBusinessOutbound(c, { businessPhone: BUSINESS_PHONE, enabled: true, max: 10, confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await admin.query(`SELECT outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    expect(after.rows[0].outbound_max_concurrent).toBe(10);
  });

  it("refuses --max above 10, and writes nothing", async () => {
    const before = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    const r = await asProbe((c) => setBusinessOutbound(c, { businessPhone: BUSINESS_PHONE, enabled: true, max: 11, confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/10/);
    const after = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [businessId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
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

    const consent = await admin.query(`SELECT source, covers_automated, purpose, channels, wording_version FROM consents WHERE contact_id = $1`, [r.contactId]);
    expect(consent.rowCount).toBe(1);
    // wording_version is what the dial-time gate keys the allow-list rule on (F4).
    expect(consent.rows[0]).toMatchObject({ source: "manual", covers_automated: true, purpose: PURPOSE_BY_TEMPLATE.speed_to_lead, channels: ["call"], wording_version: OPERATOR_TEST_WORDING });

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

  // Checkpoint 2a, M8(b): the contact upsert set first_name = EXCLUDED.first_name,
  // so re-running a trigger without --first-name wiped the name Ava greets by.
  it("a re-run without --first-name keeps the contact's first_name (M8b)", async () => {
    const phone = "+447700900601";
    const first = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone, firstName: "Sam", consentManual: false, confirm: true }));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const again = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone, firstName: null, consentManual: false, confirm: true }));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const k = await admin.query(`SELECT first_name FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [businessId, phone]);
    expect(k.rows[0].first_name).toBe("Sam");
  });

  it("a re-run WITH a new --first-name still updates it", async () => {
    const phone = "+447700900601";
    const r = await asProbe((c) => triggerOutreach(c, { businessPhone: BUSINESS_PHONE, campaignId, phone, firstName: "Samantha", consentManual: false, confirm: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const k = await admin.query(`SELECT first_name FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [businessId, phone]);
    expect(k.rows[0].first_name).toBe("Samantha");
  });
});
