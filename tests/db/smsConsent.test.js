import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// The SMS consent store (migration 037, ledger O25) as the UNPRIVILEGED
// application role, under FORCE row-level security — the only conditions that
// resemble Cloud SQL.
//
// WHY THIS FILE EXISTS RATHER THAN A MOCK. The gate in
// services/notifications.js refuses to send when the consent lookup returns
// nothing. Under FORCE RLS an UNSCOPED read returns ZERO ROWS rather than an
// error, so "nobody consented" and "we forgot to open a scope" are the same
// value, and only a real database can tell them apart. The local `vetra`
// superuser has rolbypassrls and would prove neither.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CALLER = "+15551230001";
const SCRIPT = "Can I send you a text confirmation?";

let admin;
let db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Tenant A', '+15559990001')`, [TENANT_A]);
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Tenant B', '+15559990002')`, [TENANT_B]);
});

function consent(businessId, granted, phone = CALLER) {
  return db.withTenant(businessId, () =>
    db.recordSmsConsent({
      businessId,
      phoneNumber: phone,
      granted,
      script: SCRIPT,
      scriptVersion: "test.1",
    })
  );
}

describeDb("sms_consents — the write and the read, scoped", () => {
  // The positive case first, and it is not a formality. Every refusal below is
  // also what a store that never worked at all would produce.
  it("records a grant and reads it back", async () => {
    const id = await consent(TENANT_A, true);
    expect(id).toBeTruthy();

    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row?.granted).toBe(true);
    expect(row.script).toBe(SCRIPT);
    expect(row.script_version).toBe("test.1");
  });

  it("records a refusal, and it reads back as a refusal rather than as nothing", async () => {
    await consent(TENANT_A, false);
    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row).not.toBeNull();
    expect(row.granted).toBe(false);
  });

  it("returns null for a number that has never been asked", async () => {
    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, "+15557770000"));
    expect(row).toBeNull();
  });

  // Revocation is an INSERT. There is no UPDATE path and there must not be one:
  // an editable consent row is not evidence.
  it("a later refusal supersedes an earlier grant", async () => {
    await consent(TENANT_A, true);
    await consent(TENANT_A, false);
    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row.granted).toBe(false);
  });

  it("and a later grant supersedes an earlier refusal — the state moves both ways", async () => {
    await consent(TENANT_A, false);
    await consent(TENANT_A, true);
    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row.granted).toBe(true);
  });

  it("normalises the number on both sides, so a differently-formatted read still finds it", async () => {
    await consent(TENANT_A, true, "+1 (555) 123-0001");
    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row?.granted).toBe(true);
  });
});

describeDb("sms_consents — tenant isolation", () => {
  it("one tenant's grant is invisible to another, so it cannot authorise their text", async () => {
    await consent(TENANT_A, true);
    const row = await db.withTenant(TENANT_B, () => db.latestSmsConsent(TENANT_B, CALLER));
    expect(row).toBeNull();
  });

  it("a scoped connection cannot forge a grant for another tenant", async () => {
    const id = await db.withTenant(TENANT_A, () =>
      db.recordSmsConsent({
        businessId: TENANT_B,
        phoneNumber: CALLER,
        granted: true,
        script: SCRIPT,
        scriptVersion: "test.1",
      })
    );
    expect(id).toBeNull();

    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM sms_consents WHERE business_id = $1`, [
      TENANT_B,
    ]);
    expect(rows[0].n).toBe(0);
  });

  // THE TRAP THIS WHOLE FILE EXISTS FOR. An unscoped read is not an error; it
  // is zero rows, indistinguishable from an honest "never asked". The gate
  // therefore cannot branch on the reason, and must treat every falsy answer as
  // "do not send". Proven here rather than asserted in a comment.
  it("an UNSCOPED read returns zero rows rather than failing", async () => {
    await consent(TENANT_A, true);

    const appClient = new pg.Client({ connectionString: APP_URL });
    await appClient.connect();
    try {
      const res = await appClient.query(`SELECT * FROM sms_consents WHERE business_id = $1`, [TENANT_A]);
      expect(res.rows).toHaveLength(0);
    } finally {
      await appClient.end();
    }
  });
});

describeDb("sms_consents — append-only, plus erase", () => {
  it("the application role cannot UPDATE a recorded answer", async () => {
    await consent(TENANT_A, false);

    const appClient = new pg.Client({ connectionString: APP_URL });
    await appClient.connect();
    try {
      await appClient.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      await expect(appClient.query(`UPDATE sms_consents SET granted = true WHERE business_id = $1`, [TENANT_A]))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.end();
    }
  });

  // The counterpart: DELETE is granted, because Art. 17 has to be able to reach
  // this table. A grant with no delete path would leave a phone number behind
  // after an erasure.
  it("but CAN delete, which is what makes erasure possible", async () => {
    await consent(TENANT_A, true);

    const appClient = new pg.Client({ connectionString: APP_URL });
    await appClient.connect();
    try {
      await appClient.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      const res = await appClient.query(`DELETE FROM sms_consents WHERE business_id = $1`, [TENANT_A]);
      expect(res.rowCount).toBe(1);
    } finally {
      await appClient.end();
    }
  });

  it("eraseCallerData removes the caller's consent rows", async () => {
    await consent(TENANT_A, true);
    const counts = await db.withTenant(TENANT_A, () => db.eraseCallerData(TENANT_A, CALLER));
    expect(counts.smsConsents).toBe(1);

    const row = await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));
    expect(row).toBeNull();
  });

  it("exportCallerData includes them, because the answer is the caller's too", async () => {
    await consent(TENANT_A, true);
    const out = await db.withTenant(TENANT_A, () => db.exportCallerData(TENANT_A, CALLER));
    expect(out.smsConsents).toHaveLength(1);
    expect(out.smsConsents[0].granted).toBe(true);
  });
});

describeDb("sms_consents — the audit trail sees it", () => {
  // O29 writes one phi_access_log row per unit of work. The consent read is the
  // last access before the most exposed disclosure this product makes, so it
  // being absent from the trail would be the gap worth catching.
  it("a consent read is recorded as a PHI access", async () => {
    await consent(TENANT_A, true);
    await admin.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT_A]);

    await db.withTenant(TENANT_A, () => db.latestSmsConsent(TENANT_A, CALLER));

    const { rows } = await admin.query(
      `SELECT action, operations, resources FROM phi_access_log WHERE business_id = $1`,
      [TENANT_A]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("read");
    expect(rows[0].operations).toContain("latestSmsConsent");
    expect(rows[0].resources).toContain("sms_consents");
  });

  it("a consent write is recorded as a PHI access", async () => {
    await admin.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT_A]);
    await consent(TENANT_A, true);

    const { rows } = await admin.query(
      `SELECT action, operations FROM phi_access_log WHERE business_id = $1`,
      [TENANT_A]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("write");
    expect(rows[0].operations).toContain("recordSmsConsent");
  });
});
