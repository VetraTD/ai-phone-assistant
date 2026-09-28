// tests/db/outboundSuppression.test.js
/**
 * S3-3 (spec §12.2): services/db.js's insertSuppression -- the general
 * suppression writer behind capabilities/optOut.js and capabilities/
 * outcome.js's wrong_number branch -- and insertDetectorSuppression as its
 * thin wrapper (identical behaviour to before this task). Real Postgres, as
 * vetra_app under RLS: a tenantless write matches 0 rows and "succeeds"
 * (memory unscoped-writes-now-fail-closed), so this is the test that proves
 * the tenant scope actually holds, not merely that the JS logic is sound.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ_A = "0d0d0000-0000-4000-8000-0000000000a1";
const BIZ_B = "0d0d0000-0000-4000-8000-0000000000a2";
let admin, db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BIZ_A, BIZ_B]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Suppression Co A'), ($2,'Suppression Co B')`, [BIZ_A, BIZ_B]);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BIZ_A, BIZ_B]).catch(() => {});
  await admin.end();
});

async function suppressionRow(biz, phone) {
  const { rows } = await admin.query(
    `SELECT reason, created_by, source_call_id FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`,
    [biz, phone]
  );
  return rows[0] || null;
}

d("insertSuppression: the general writer, tenant-scoped, ON CONFLICT DO NOTHING", () => {
  it("inserts a tool-written wrong_number suppression, and the row actually landed under RLS", async () => {
    const phone = "+447700900401";
    const inserted = await db.withTenant(BIZ_A, () =>
      db.insertSuppression({ phone, reason: "wrong_number", sourceCallId: null, createdBy: "tool" })
    );
    expect(inserted).toBe(true);
    expect(await suppressionRow(BIZ_A, phone)).toEqual({ reason: "wrong_number", created_by: "tool", source_call_id: null });
  });

  it("inserts a tool-written opted_out suppression (the opt_out tool's own write)", async () => {
    const phone = "+447700900402";
    const inserted = await db.withTenant(BIZ_A, () =>
      db.insertSuppression({ phone, reason: "opted_out", sourceCallId: null, createdBy: "tool" })
    );
    expect(inserted).toBe(true);
    expect(await suppressionRow(BIZ_A, phone)).toEqual({ reason: "opted_out", created_by: "tool", source_call_id: null });
  });

  it("a second insert for the SAME phone (any reason) is a safe no-op -- never a duplicate, never a throw", async () => {
    const phone = "+447700900403";
    const first = await db.withTenant(BIZ_A, () => db.insertSuppression({ phone, reason: "opted_out", sourceCallId: null, createdBy: "tool" }));
    expect(first).toBe(true);
    const second = await db.withTenant(BIZ_A, () => db.insertSuppression({ phone, reason: "wrong_number", sourceCallId: null, createdBy: "tool" }));
    expect(second).toBe(false);
    const rows = (await admin.query(`SELECT id, reason FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [BIZ_A, phone])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("opted_out"); // the FIRST writer's reason stands
  });

  it("REQUIRES tenant scope: calling it outside withTenant throws rather than writing unscoped", async () => {
    await expect(db.insertSuppression({ phone: "+447700900404", reason: "opted_out", sourceCallId: null, createdBy: "tool" })).rejects.toThrow(
      /must run inside withTenant/
    );
  });

  it("a write under BIZ_A's tenant scope never lands under BIZ_B (RLS, not JS logic, enforces this)", async () => {
    const phone = "+447700900405";
    await db.withTenant(BIZ_A, () => db.insertSuppression({ phone, reason: "opted_out", sourceCallId: null, createdBy: "tool" }));
    expect(await suppressionRow(BIZ_A, phone)).toBeTruthy();
    expect(await suppressionRow(BIZ_B, phone)).toBeNull();
  });

  it("rejects an out-of-enum reason (the suppressions CHECK constraint)", async () => {
    await expect(
      db.withTenant(BIZ_A, () => db.insertSuppression({ phone: "+447700900406", reason: "not_a_real_reason", sourceCallId: null, createdBy: "tool" }))
    ).rejects.toThrow();
  });

  it("rejects an out-of-enum created_by (the suppressions CHECK constraint)", async () => {
    await expect(
      db.withTenant(BIZ_A, () => db.insertSuppression({ phone: "+447700900407", reason: "opted_out", sourceCallId: null, createdBy: "nobody" }))
    ).rejects.toThrow();
  });
});

d("insertDetectorSuppression: unchanged wrapper behaviour (regression, this task)", () => {
  it("still writes reason=opted_out, created_by=detector -- identical to before S3-3", async () => {
    const phone = "+447700900408";
    const inserted = await db.withTenant(BIZ_A, () => db.insertDetectorSuppression({ phone, sourceCallId: null }));
    expect(inserted).toBe(true);
    expect(await suppressionRow(BIZ_A, phone)).toEqual({ reason: "opted_out", created_by: "detector", source_call_id: null });
  });

  it("a tool-written suppression (insertSuppression) blocks a LATER detector write for the same phone -- the tool got there first", async () => {
    const phone = "+447700900409";
    await db.withTenant(BIZ_A, () => db.insertSuppression({ phone, reason: "wrong_number", sourceCallId: null, createdBy: "tool" }));
    const detectorInserted = await db.withTenant(BIZ_A, () => db.insertDetectorSuppression({ phone, sourceCallId: null }));
    expect(detectorInserted).toBe(false);
    expect((await suppressionRow(BIZ_A, phone)).created_by).toBe("tool"); // unchanged
  });
});
