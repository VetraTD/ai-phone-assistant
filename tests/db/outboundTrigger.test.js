// tests/db/outboundTrigger.test.js
/**
 * S3-9 against real Postgres, as vetra_app (NOBYPASSRLS):
 *
 *   - app_campaign_by_trigger_hash (migration 049) is owned by a role that
 *     cannot bypass RLS -- otherwise nothing here proves anything (the same
 *     idiom tests/db/outboundCallContext.test.js and
 *     tests/db/phoneDirectoryBootstrap.test.js use).
 *   - db.campaignByTriggerHash resolves a hash to {businessId, campaignId,
 *     triggerTokenHash}; an unknown hash gives null.
 *   - db.campaignForTrigger reads compliance_class and details_fields
 *     defensively.
 *   - The full route (lib/outbound/triggerRoute.js), through the real
 *     server-side pieces (real db, real express app, supertest): a bad
 *     token 401s, a solicited campaign with no consent 422s, a valid POST
 *     202s with the outreach row landed (contact upserted, consent
 *     recorded, details filtered to the campaign's details_fields), and a
 *     replay of the same request returns the SAME outreach_id.
 *   - scripts/outbound-admin.js's rotateTriggerToken: dry run writes
 *     nothing, --confirm stores only the sha256 hash and returns the raw
 *     token once, and that raw token then authenticates a real POST.
 *   - THE S3-6/S3-9 WIRE (Ruling S3-9-wire, both ends real): a trigger POST
 *     lands outreach.details -> the real call-context loader
 *     (resolveOutboundContext) carries it onto ctx.details -> the real
 *     outbound prompt builder (outboundCallBlock) renders a `DETAILS:` line
 *     from it, and the rendered opener text does NOT contain it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import express from "express";
import request from "supertest";
import { randomBytes, createHash } from "node:crypto";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "trigdir_owner";
const FN = "app_campaign_by_trigger_hash(text)";

const BIZ = "0f0f1500-0000-4000-8000-000000000001";
const BIZ_PHONE = "+441372600015";
const CONTACT_PHONE = "+447700900515";

const detailsFields = [{ key: "topic_detail", label: "Regarding" }];

function campaignConfig(overrides = {}) {
  return {
    persona_name: "Ava",
    caller_id: BIZ_PHONE,
    opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
    topic: "your enquiry",
    objective: "Qualify.",
    goal: "book",
    capabilities: ["qualification", "appointments"],
    details_fields: detailsFields,
    retries: { schedule: ["+0m"], voicemail_on: [1] },
    ...overrides,
  };
}

function mintToken() {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

let admin, db, rotateTriggerToken, registerTriggerRoute, resolveOutboundContext, outboundCallBlock;
let solicitedCampaignId, serviceCampaignId;
let solicitedToken, serviceToken;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();

  await admin.query(`ALTER FUNCTION ${FN} OWNER TO vetra`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, timezone, live_voice, allowed_tasks)
     VALUES ($1, 'Trigger Route Co', $2, 'Europe/London', 'Aoede', '["general_question","book_appointment"]'::jsonb)`,
    [BIZ, BIZ_PHONE]
  );

  solicitedToken = mintToken();
  serviceToken = mintToken();

  const solicited = await admin.query(
    `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version, trigger_token_hash)
     VALUES ($1, 'Solicited leads-in', 'speed_to_lead', 'solicited', 'business', 'active', 1, $2) RETURNING id`,
    [BIZ, solicitedToken.hash]
  );
  solicitedCampaignId = solicited.rows[0].id;
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`, [
    solicitedCampaignId,
    BIZ,
    JSON.stringify(campaignConfig()),
  ]);

  const service = await admin.query(
    `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version, trigger_token_hash)
     VALUES ($1, 'Service leads-in', 'reminder', 'service', 'business', 'active', 1, $2) RETURNING id`,
    [BIZ, serviceToken.hash]
  );
  serviceCampaignId = service.rows[0].id;
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`, [
    serviceCampaignId,
    BIZ,
    JSON.stringify(campaignConfig()),
  ]);

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  ({ registerTriggerRoute } = await import("../../lib/outbound/triggerRoute.js"));
  ({ resolveOutboundContext } = await import("../../lib/outbound/callContext.js"));
  ({ outboundCallBlock } = await import("../../lib/outbound/prompt.js"));
  ({ rotateTriggerToken } = await import("../../scripts/outbound-admin.js"));
}, 30000);

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER FUNCTION ${FN} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.end();
});

function buildApp() {
  const app = express();
  registerTriggerRoute(app, { db, log: { info: () => {}, error: () => {} } });
  return app;
}

d("app_campaign_by_trigger_hash, as vetra_app", () => {
  it("the function owner does NOT bypass RLS -- otherwise nothing here proves anything", async () => {
    const r = await admin.query(
      `SELECT r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'app_campaign_by_trigger_hash'`
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("db.campaignByTriggerHash resolves a known hash to its campaign and tenant", async () => {
    const hit = await db.campaignByTriggerHash(solicitedToken.hash);
    expect(hit).toEqual({ businessId: BIZ, campaignId: solicitedCampaignId, triggerTokenHash: solicitedToken.hash });
  });

  it("an unknown hash gives null", async () => {
    expect(await db.campaignByTriggerHash("0".repeat(64))).toBeNull();
  });

  it("db.campaignForTrigger reads compliance_class, status, current_version and details_fields, tenant-scoped", async () => {
    const camp = await db.withTenant(BIZ, () => db.campaignForTrigger(solicitedCampaignId));
    expect(camp).toEqual({
      complianceClass: "solicited",
      status: "active",
      currentVersion: 1,
      detailsFields: detailsFields,
    });
  });

  it("a config with no details_fields array gives [], not a throw (defensive default)", async () => {
    const camp = await admin.query(
      `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version)
       VALUES ($1, 'No details fields', 'speed_to_lead', 'service', 'business', 'active', 1) RETURNING id`,
      [BIZ]
    );
    const cid = camp.rows[0].id;
    await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`, [
      cid,
      BIZ,
      JSON.stringify({ persona_name: "Ava", caller_id: BIZ_PHONE, goal: "pass_message" }),
    ]);
    const read = await db.withTenant(BIZ, () => db.campaignForTrigger(cid));
    expect(read.detailsFields).toEqual([]);
  });
});

d("POST /v1/triggers/:triggerToken, through the real route + real db", () => {
  it("a bad token 401s", async () => {
    const res = await request(buildApp()).post(`/v1/triggers/not-a-real-token`).send({ phone: CONTACT_PHONE });
    expect(res.status).toBe(401);
  });

  it("a solicited campaign with no consent block 422s with field:consent, and writes nothing", async () => {
    const res = await request(buildApp())
      .post(`/v1/triggers/${solicitedToken.token}`)
      .send({ phone: CONTACT_PHONE, first_name: "Priya" });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("consent");
    const rows = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1`, [BIZ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("202 on a valid solicited POST: contact upserted, consent recorded, details filtered, ignored_fields listed", async () => {
    const res = await request(buildApp())
      .post(`/v1/triggers/${solicitedToken.token}`)
      .send({
        phone: CONTACT_PHONE,
        first_name: "Priya",
        consent: {
          purpose: "enquiry_followup",
          channels: ["call", "sms"],
          covers_automated: true,
          wording_version: "v1",
          captured_at: "2026-09-27T10:00:00Z",
          source_ref: "form-123",
        },
        data: { topic_detail: "Roof leak", not_configured: "should be ignored" },
      });
    expect(res.status).toBe(202);
    expect(res.body.outreach_id).toBeTruthy();
    expect(res.body.ignored_fields).toEqual(["not_configured"]);

    const row = (await admin.query(`SELECT * FROM outreach WHERE id = $1`, [res.body.outreach_id])).rows[0];
    expect(row.business_id).toBe(BIZ);
    expect(row.campaign_id).toBe(solicitedCampaignId);
    expect(row.state).toBe("waiting");
    expect(row.details).toEqual({ topic_detail: "Roof leak" });
    expect(row.trigger).toEqual({ source: "webhook", data: { topic_detail: "Roof leak", not_configured: "should be ignored" } });

    const contact = (await admin.query(`SELECT * FROM contacts WHERE business_id = $1 AND phone_e164 = $2`, [BIZ, CONTACT_PHONE])).rows[0];
    expect(contact.first_name).toBe("Priya");

    const consent = (await admin.query(`SELECT * FROM consents WHERE contact_id = $1`, [contact.id])).rows[0];
    expect(consent.source).toBe("api");
    expect(consent.purpose).toBe("enquiry_followup");
    expect(consent.source_ref).toBe("form-123");

    // A replay of the identical request returns the SAME outreach_id and
    // writes no second consent row.
    const replay = await request(buildApp())
      .post(`/v1/triggers/${solicitedToken.token}`)
      .send({
        phone: CONTACT_PHONE,
        first_name: "Priya",
        consent: {
          purpose: "enquiry_followup",
          channels: ["call", "sms"],
          covers_automated: true,
          captured_at: "2026-09-27T10:00:00Z",
          source_ref: "form-123",
        },
        data: { topic_detail: "Roof leak", not_configured: "should be ignored" },
      });
    expect(replay.status).toBe(202);
    expect(replay.body.outreach_id).toBe(res.body.outreach_id);
    const consentCount = await admin.query(`SELECT count(*)::int AS n FROM consents WHERE contact_id = $1`, [contact.id]);
    expect(consentCount.rows[0].n).toBe(1);
    const outreachCount = await admin.query(`SELECT count(*)::int AS n FROM outreach WHERE business_id = $1 AND contact_id = $2`, [BIZ, contact.id]);
    expect(outreachCount.rows[0].n).toBe(1);
  });

  // fix round 1, I1: withTenant's actor id flows straight into the durable
  // PHI audit row (services/db.js's flushAudit). A real write, read back
  // from phi_access_log itself -- not a mock's recorded call args.
  it("fix round 1, I1: the PHI audit row for the write unit of work carries a descriptive actor id, not null", async () => {
    const phone = "+447700900520";
    const res = await request(buildApp())
      .post(`/v1/triggers/${solicitedToken.token}`)
      .send({
        phone,
        consent: { purpose: "enquiry_followup", captured_at: "2026-09-27T10:00:00Z" },
      });
    expect(res.status).toBe(202);

    const rows = (
      await admin.query(
        `SELECT actor_type, actor_id, operations FROM phi_access_log
          WHERE business_id = $1 AND $2 = ANY(operations) ORDER BY occurred_at DESC LIMIT 1`,
        [BIZ, "createOutreachFromTrigger"]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe("system");
    expect(rows[0].actor_id).toBe("outbound-trigger");
    expect(rows[0].actor_id).not.toBeNull();
  });

  it("a service campaign accepts no consent block at all", async () => {
    const res = await request(buildApp())
      .post(`/v1/triggers/${serviceToken.token}`)
      .send({ phone: "+447700900516", first_name: "Sam" });
    expect(res.status).toBe(202);
  });
});

d("scripts/outbound-admin.js rotateTriggerToken", () => {
  it("dry run writes nothing and prints no token", async () => {
    const before = (await admin.query(`SELECT trigger_token_hash FROM campaigns WHERE id = $1`, [solicitedCampaignId])).rows[0];
    const res = await rotateTriggerToken(admin, { businessPhone: BIZ_PHONE, campaignId: solicitedCampaignId, confirm: false });
    expect(res).toMatchObject({ ok: true, dryRun: true });
    expect(res.token).toBeUndefined();
    const after = (await admin.query(`SELECT trigger_token_hash FROM campaigns WHERE id = $1`, [solicitedCampaignId])).rows[0];
    expect(after.trigger_token_hash).toBe(before.trigger_token_hash);
  });

  it("--confirm stores only the sha256 hash, prints the raw token once, and that token then authenticates a real POST", async () => {
    const res = await rotateTriggerToken(admin, { businessPhone: BIZ_PHONE, campaignId: solicitedCampaignId, confirm: true });
    expect(res.ok).toBe(true);
    expect(typeof res.token).toBe("string");
    expect(res.token).toHaveLength(64); // 32 random bytes, hex

    const stored = (await admin.query(`SELECT trigger_token_hash FROM campaigns WHERE id = $1`, [solicitedCampaignId])).rows[0];
    expect(stored.trigger_token_hash).toBe(createHash("sha256").update(res.token).digest("hex"));
    expect(stored.trigger_token_hash).not.toBe(res.token); // never the raw token

    // The OLD token (used earlier in this file) no longer works.
    const stale = await request(buildApp()).post(`/v1/triggers/${solicitedToken.token}`).send({ phone: "+447700900517" });
    expect(stale.status).toBe(401);

    // The NEW token does.
    const fresh = await request(buildApp())
      .post(`/v1/triggers/${res.token}`)
      .send({
        phone: "+447700900518",
        consent: { purpose: "enquiry_followup", captured_at: "2026-09-27T10:00:00Z" },
      });
    expect(fresh.status).toBe(202);
  });
});

d("S3-6/S3-9 wire: trigger -> outreach.details -> resolveOutboundContext -> outboundCallBlock's DETAILS: line", () => {
  it("both ends real: the DETAILS: line is rendered from the stored details, and the opener text carries none of it", async () => {
    // Rotate again so this block uses a known-good token independent of the
    // previous describe's mutation.
    const rotated = await rotateTriggerToken(admin, { businessPhone: BIZ_PHONE, campaignId: solicitedCampaignId, confirm: true });

    const phone = "+447700900519";
    const post = await request(buildApp())
      .post(`/v1/triggers/${rotated.token}`)
      .send({
        phone,
        first_name: "Jordan",
        consent: { purpose: "enquiry_followup", captured_at: "2026-09-27T10:00:00Z" },
        data: { topic_detail: "Boiler service" },
      });
    expect(post.status).toBe(202);

    const SID = "CAtriggerwire0001";
    const attempt = await admin.query(
      `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, twilio_call_sid, dialed_at)
       VALUES ($1, $2, 1, $3, $4, $5, now()) RETURNING id`,
      [BIZ, post.body.outreach_id, BIZ_PHONE, phone, SID]
    );
    expect(attempt.rows[0].id).toBeTruthy();

    const ctx = await resolveOutboundContext(SID, { db });
    expect(ctx.details).toEqual({ topic_detail: "Boiler service" });

    const block = outboundCallBlock({ ...ctx, disclosure: { enabled: false, text: null } }, "Trigger Route Co");
    // I8 (this wave): values are now quoted, under a header naming them as data.
    expect(block).toContain('DETAILS: Regarding: "Boiler service"');

    // Never in the opener: renderOpenerText (lib/outbound/campaignSchema.js's
    // renderCampaignLine) has no `details` parameter at all -- structurally
    // impossible, verified here on the real rendered string.
    expect(ctx.openerText).not.toContain("DETAILS:");
    expect(ctx.openerText).not.toContain("Boiler service");
  });
});
