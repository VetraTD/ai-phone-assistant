import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// §164.312(b) audit controls, against a real database as the UNPRIVILEGED role.
//
// This is the only place the property means anything. The whole point of the
// audit table is that the application can add to it and cannot alter it, and
// "cannot" is a statement about grants and policies, not about JavaScript. A
// mock would prove that the code intends to be append-only.
//
// Run as vetra_app for the same reason tests/db/rlsAppRole.test.js does: the
// local `vetra` user is a superuser with rolbypassrls, so every lock in
// migration 030 is inert for it, and Cloud SQL grants no superuser.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_A = "99999999-1111-4111-8111-111111111111";
const CALL_SID = "CAaudit0000000000000000000000001";

// The fixture is built so that a leak would be visible. Every PHI-typed value
// is a sentinel string that appears nowhere else, so "the audit row contains no
// PHI" can be asserted as a property of the whole serialized row rather than as
// a list of columns somebody remembered to check.
const SENTINEL_PHONE = "+15550001111";
const SENTINEL_NAME = "Zzsentinelcallername";
const SENTINEL_TRANSCRIPT = "zzsentineltranscriptbody";
const SENTINEL_SUMMARY = "zzsentinelsummarytext";

let admin;
let db;
let callId;

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
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await admin.query(`DELETE FROM phi_access_log WHERE business_id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});

  for (const [id, name, phone] of [
    [TENANT_A, "Audit Tenant A", "+15557770001"],
    [TENANT_B, "Audit Tenant B", "+15557770002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, $2, $3)`, [id, name, phone]);
  }
  // auth_uid is NOT NULL since migration 036 — the tenant lookup is keyed on it,
  // so a staff row without one is a person who cannot log in.
  await admin.query(`INSERT INTO users (id, business_id, email, auth_uid) VALUES ($1, $2, $3, $4)`, [
    STAFF_A,
    TENANT_A,
    "audit-staff@example.com",
    `authuid-${STAFF_A.slice(0, 8)}`,
  ]);

  const { rows } = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, summary)
     VALUES ($1, $2, $3, 'completed', $4) RETURNING id`,
    [TENANT_A, CALL_SID, SENTINEL_PHONE, SENTINEL_SUMMARY]
  );
  callId = rows[0].id;
  await admin.query(
    `INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1, 'caller', $2, 1)`,
    [callId, SENTINEL_TRANSCRIPT]
  );
  await admin.query(
    `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
    [TENANT_A, callId, SENTINEL_NAME, SENTINEL_PHONE]
  );
});

/** Every audit row for a tenant, read as the superuser so RLS cannot hide one. */
async function auditRows(businessId = TENANT_A) {
  const { rows } = await admin.query(
    `SELECT * FROM phi_access_log WHERE business_id = $1 ORDER BY id`,
    [businessId]
  );
  return rows;
}

describeDb("a PHI access leaves a trail", () => {
  it("records one row for a unit of work that read patient data", async () => {
    await db.withTenant(TENANT_A, () => db.fetchCallTranscript(callId), {
      actor: { type: "user", id: STAFF_A },
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBe(TENANT_A);
    expect(rows[0].actor_type).toBe("user");
    expect(rows[0].actor_id).toBe(STAFF_A);
    expect(rows[0].action).toBe("read");
    expect(rows[0].operations).toContain("fetchCallTranscript");
    expect(rows[0].resources).toContain("call_transcripts");
    expect(rows[0].row_count).toBe(1);
  });

  it("records ONE row for a unit of work, not one per statement", async () => {
    await db.withTenant(
      TENANT_A,
      async () => {
        await db.fetchCallTranscript(callId);
        await db.listAppointmentsByCaller(TENANT_A, { phone: SENTINEL_PHONE });
      },
      { actor: { type: "user", id: STAFF_A } }
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].operations).toEqual(
      expect.arrayContaining(["fetchCallTranscript", "listAppointmentsByCaller"])
    );
  });

  it("reports the strongest action in the unit of work, not the last one", async () => {
    await db.withTenant(
      TENANT_A,
      async () => {
        await db.fetchCallTranscript(callId);
        await db.updateCallSummary(CALL_SID, "s", "neutral", "resolved");
      },
      { actor: { type: "voice", id: CALL_SID } }
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("write");
  });

  it("writes nothing for a unit of work that only read configuration", async () => {
    await db.withTenant(TENANT_A, () => db.fetchBusinessById(TENANT_A), {
      actor: { type: "user", id: STAFF_A },
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it("records an erasure as an erasure", async () => {
    await db.withTenant(TENANT_A, () => db.eraseCallerData(TENANT_A, SENTINEL_PHONE), {
      actor: { type: "user", id: STAFF_A },
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("erase");
    expect(rows[0].operations).toContain("eraseCallerData");
  });
});

describeDb("the trail carries no PHI", () => {
  it("puts no phone number, name, transcript or summary in the row", async () => {
    await db.withTenant(
      TENANT_A,
      async () => {
        await db.exportCallerData(TENANT_A, SENTINEL_PHONE);
        await db.fetchCallTranscript(callId);
      },
      { actor: { type: "user", id: STAFF_A } }
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    for (const sentinel of [SENTINEL_PHONE, SENTINEL_NAME, SENTINEL_TRANSCRIPT, SENTINEL_SUMMARY]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("refuses a PHI-typed key outright rather than redacting it", async () => {
    // The audit table is the single worst place in this system to put PHI: it
    // is designed to be retained longest and read by the most people. So it
    // rejects rather than sanitises, and the caller finds out.
    await expect(
      db.withTenant(
        TENANT_A,
        async () => {
          db.recordPhiAccess({
            operation: "fetchCallTranscript",
            action: "read",
            resources: ["call_transcripts"],
            callerNumber: SENTINEL_PHONE,
          });
        },
        { actor: { type: "user", id: STAFF_A } }
      )
    ).rejects.toThrow(/callerNumber/);

    expect(await auditRows()).toHaveLength(0);
  });
});

describeDb("the application can add to the trail and cannot alter it", () => {
  beforeEach(async () => {
    if (!url) return;
    await db.withTenant(TENANT_A, () => db.fetchCallTranscript(callId), {
      actor: { type: "user", id: STAFF_A },
    });
  });

  it("cannot UPDATE an audit row", async () => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      await expect(
        app.query(`UPDATE phi_access_log SET operations = ARRAY['nothing'] WHERE business_id = $1`, [TENANT_A])
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end();
    }
    // And the row is untouched.
    expect((await auditRows())[0].operations).toContain("fetchCallTranscript");
  });

  it("cannot DELETE an audit row", async () => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      await expect(
        app.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT_A])
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end();
    }
    expect(await auditRows()).toHaveLength(1);
  });

  it("still cannot alter a row when the privilege is granted back", async () => {
    // The two locks, proved to be INDEPENDENT rather than asserted to be.
    //
    // Migration 030 revokes UPDATE/DELETE *and* omits the matching RLS
    // policies, and the claim is that either alone would hold. The two tests
    // above only exercise the privilege half — they pass on a "permission
    // denied" that would disappear the moment somebody ran a well-meaning
    // GRANT. This grants it back and shows the policy half still holds: not an
    // error, but zero rows affected and the record untouched.
    await admin.query(`GRANT UPDATE, DELETE ON phi_access_log TO vetra_app`);
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      const upd = await app.query(
        `UPDATE phi_access_log SET operations = ARRAY['tampered'] WHERE business_id = $1`,
        [TENANT_A]
      );
      expect(upd.rowCount).toBe(0);
      const del = await app.query(`DELETE FROM phi_access_log WHERE business_id = $1`, [TENANT_A]);
      expect(del.rowCount).toBe(0);
    } finally {
      await app.end();
      await admin.query(`REVOKE UPDATE, DELETE ON phi_access_log FROM vetra_app`);
    }

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].operations).toContain("fetchCallTranscript");
  });

  it("cannot TRUNCATE the table", async () => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await expect(app.query(`TRUNCATE phi_access_log`)).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end();
    }
    expect(await auditRows()).toHaveLength(1);
  });

  it("shows a tenant its own trail and not another tenant's", async () => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_B]);
      const other = await app.query(`SELECT * FROM phi_access_log`);
      expect(other.rows).toHaveLength(0);

      await app.query(`SELECT set_config('app.business_id', $1, false)`, [TENANT_A]);
      const own = await app.query(`SELECT * FROM phi_access_log`);
      expect(own.rows).toHaveLength(1);
    } finally {
      await app.end();
    }
  });
});

describeDb("what happens when the trail cannot be written", () => {
  it("leaves no committed row when the unit of work rolls back", async () => {
    // The stdout line is emitted regardless and cannot be rolled back, which is
    // the point of having two destinations: an ATTEMPT survives even when the
    // committed record does not.
    await expect(
      db.withTenant(
        TENANT_A,
        async () => {
          await db.fetchCallTranscript(callId);
          throw new Error("unit of work failed");
        },
        { actor: { type: "user", id: STAFF_A } }
      )
    ).rejects.toThrow("unit of work failed");

    expect(await auditRows()).toHaveLength(0);
  });

  it("writes no row for a PHI access that happened with no tenant scope", async () => {
    // No withTenant means no accumulator, so there is nowhere to record this
    // and nothing is invented. Whether it is ANNOUNCED depends on the
    // deployment mode, which is a compliance line rather than a database one —
    // tests/phiAuditUnaudited.test.js covers both directions of that gate.
    db.recordPhiAccess({
      operation: "fetchCallTranscript",
      action: "read",
      resources: ["call_transcripts"],
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
