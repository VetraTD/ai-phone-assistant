// tests/db/outboundLinks.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const BIZ = "0c0c0000-0000-4000-8000-000000000001";
let admin;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Links')`, [BIZ]);
});
afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`SELECT app_call_state_delete('CAlinks0001')`);
  await admin.end();
});

d("migration 043", () => {
  it("an ordinary inbound insert still works and reads direction 'inbound' (existing rows keep their meaning)", async () => {
    const r = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, twilio_number) VALUES ($1,'CAlinks-in','+447700900001','+441372656055') RETURNING direction, answers, outcome_code`, [BIZ]);
    expect(r.rows[0]).toEqual({ direction: "inbound", answers: null, outcome_code: null });
  });

  it("refuses a direction that is neither inbound nor outbound", async () => {
    await expect(
      admin.query(`INSERT INTO calls (business_id, twilio_call_sid, direction) VALUES ($1,'CAlinks-bad','sideways')`, [BIZ])
    ).rejects.toThrow(/check constraint/);
  });

  it("businesses default to outbound switched OFF, with a concurrency of 2", async () => {
    const r = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [BIZ]);
    expect(r.rows[0]).toEqual({ outbound_enabled: false, outbound_max_concurrent: 2 });
  });

  it("call_state accepts direction and attemptId, and still refuses any other key", async () => {
    await admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"direction":"outbound","attemptId":"att-1"}'::jsonb)`);
    const got = await admin.query(`SELECT app_call_state_get('CAlinks0001', 3600) AS s`);
    expect(got.rows[0].s).toEqual({ direction: "outbound", attemptId: "att-1" });
    await expect(
      admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"history":[]}'::jsonb)`)
    ).rejects.toThrow(/refusing unknown shared field/);
  });

  it("a merge that omits direction leaves it alone (absent is not null)", async () => {
    await admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"sawCallerFinal":true}'::jsonb)`);
    const got = await admin.query(`SELECT app_call_state_get('CAlinks0001', 3600) AS s`);
    expect(got.rows[0].s.direction).toBe("outbound");
  });

  // Ruling 2a: schemaParity does not compare foreign keys, so the fold
  // (inline columns on `calls` without REFERENCES, plus four ALTER TABLE ...
  // ADD CONSTRAINT statements after the 042 section) is only proven honest by
  // running this test on a database built from schema.sql alone (`db:reset`).
  // A fold that drops one of the four ALTERs, or places one before its target
  // table exists, must fail here even though `schemaParity` stays green.
  it("the four FK constraints from migration 043 exist on calls, named for the fold to reproduce", async () => {
    const { rows } = await admin.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'calls'::regclass AND contype = 'f' AND conname = ANY($1::text[])`,
      [["calls_campaign_id_fkey", "calls_outreach_id_fkey", "calls_attempt_id_fkey", "calls_contact_id_fkey"]]
    );
    expect(rows.map((r) => r.conname).sort()).toEqual(
      ["calls_attempt_id_fkey", "calls_campaign_id_fkey", "calls_contact_id_fkey", "calls_outreach_id_fkey"]
    );
  });
});
