// tests/db/outboundHeldForReview.test.js
/**
 * Stage 4, S4-2 (migration 051). 'held_for_review' joins outreach.close_reason:
 * a lead whose mid-clip words could not be verified is CLOSED for review
 * instead of being re-dialled. Real Postgres, as vetra_app under RLS, through
 * the real applyOutreachResult -- the writer post-call uses.
 *
 * Two things are pinned, because schemaParity does not compare constraints:
 *   - the new value is accepted AND still rejects an unknown one (the CHECK was
 *     re-created, not dropped);
 *   - EVERY value the constraint carried before 051 is still accepted, so the
 *     drop/add cannot silently strip one from a writer that uses it.
 * Run it on the migrated database AND on one rebuilt from schema.sql alone
 * (`npm run db:reset`): the second run is what proves the fold carries it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ = "0d0d0000-0000-4000-8000-000000000051";
let admin, db, campaignId, contactId;

const PRE_051_REASONS = [
  "terminal_outcome", "attempts_exhausted", "give_up_window", "consent_missing",
  "consent_expired", "consent_not_automated", "suppressed", "called_back",
  "campaign_deleted", "global_disabled", "business_disabled", "caller_id_invalid",
  "missing_goal", "erased", "no_legal_floor",
];

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Held Co')`, [BIZ]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [BIZ]
  );
  campaignId = camp.rows[0].id;
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900351') RETURNING id`, [BIZ]);
  contactId = con.rows[0].id;
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.end();
});

let seq = 0;
async function mkOutreach() {
  seq += 1;
  const r = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,attempts_made,trigger,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing',1,'{}',$4) RETURNING id`,
    [BIZ, campaignId, contactId, `held-${seq}`]
  );
  return r.rows[0].id;
}

d("outreach.close_reason: held_for_review (migration 051)", () => {
  it("post-call's real writer closes an outreach with close_reason held_for_review, outcome held_for_review, no next_attempt_at", async () => {
    const out = await mkOutreach();
    const applied = await db.withTenant(BIZ, () =>
      db.applyOutreachResult(out, 1, { terminal: true, closeReason: "held_for_review", outcome: "held_for_review", nextAttemptAt: null })
    );
    expect(applied).toBe(true);
    const row = (await admin.query(`SELECT state, close_reason, outcome, closed_at, next_attempt_at FROM outreach WHERE id = $1`, [out])).rows[0];
    expect(row).toMatchObject({ state: "closed", close_reason: "held_for_review", outcome: "held_for_review", next_attempt_at: null });
    expect(row.closed_at).not.toBeNull();
  });

  it("still rejects a close_reason that is not on the list (the CHECK was re-created, not dropped)", async () => {
    const out = await mkOutreach();
    await expect(
      db.withTenant(BIZ, () => db.applyOutreachResult(out, 1, { terminal: true, closeReason: "held_for_reveiw", outcome: "x", nextAttemptAt: null }))
    ).rejects.toThrow(/outreach_close_reason_check/);
  });

  it("every close_reason the constraint carried before 051 is still accepted", async () => {
    for (const reason of PRE_051_REASONS) {
      const out = await mkOutreach();
      const applied = await db.withTenant(BIZ, () =>
        db.applyOutreachResult(out, 1, { terminal: true, closeReason: reason, outcome: "x", nextAttemptAt: null })
      );
      expect(applied, reason).toBe(true);
    }
  });
});
