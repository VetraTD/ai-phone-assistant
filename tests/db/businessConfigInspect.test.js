/**
 * `db-inspect --business` config read-back, against a real PostgreSQL, as a role
 * that CANNOT bypass row-level security (same shape as recordingClaimAudit.test.js:
 * the probe role owns the SECURITY DEFINER lookup, as production's `postgres`
 * does, so a bypass cannot make this pass).
 *
 * The output is a Cloud Logging line, so phone numbers must leave the database
 * already reduced to their last four digits.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { inspectBusinessConfig } from "../../lib/db/businessConfigInspect.js";

const ADMIN_URL = process.env.DATABASE_URL;
const PROBE_ROLE = "bci_probe";
const PROBE_PASS = "probe_only";

const FULL = { id: "6c6c0000-0000-4000-8000-000000000001", phone: "+441372880001" };
const BARE = { id: "6c6c0000-0000-4000-8000-000000000002", phone: "+441372880002" };
const OURS = [FULL.phone, BARE.phone];
const OUR_IDS = [FULL.id, BARE.id];

let admin;
let probeUrl;

const d = ADMIN_URL ? describe : describe.skip;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO vetra`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO ${PROBE_ROLE}`);

  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1) OR id = ANY($2)`, [OURS, OUR_IDS]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, transfer_phone_number, main_phone, transfer_policy,
                             live_voice, locale, outbound_enabled, transfer_no_answer)
     VALUES ($1, 'Full Config Co', $2, '+441111222333', '+441372000111', 'never',
             'Kore', 'en-GB', true, 'own_voicemail')`,
    [FULL.id, FULL.phone]
  );
  await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, 'Bare Co', $2)`, [
    BARE.id,
    BARE.phone,
  ]);

  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PASS;
  probeUrl = u.toString();
}, 60000);

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE phone_number = ANY($1) OR id = ANY($2)`, [OURS, OUR_IDS]).catch(() => {});
  await admin.query(`ALTER FUNCTION app_lookup_business_by_phone(text) OWNER TO vetra`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.end();
});

async function inspect(phone) {
  const c = new pg.Client({ connectionString: probeUrl });
  await c.connect();
  try {
    return await inspectBusinessConfig(c, phone);
  } finally {
    await c.end();
  }
}

d("db-inspect --business config read-back", () => {
  it("is not a bypass: a direct select with no scope reads 0 rows as the probe role", async () => {
    const c = new pg.Client({ connectionString: probeUrl });
    await c.connect();
    try {
      const r = await c.query(`SELECT id FROM businesses WHERE phone_number = $1`, [FULL.phone]);
      expect(r.rows).toHaveLength(0);
    } finally {
      await c.end();
    }
  });

  it("returns the transfer/voice/locale/outbound config with numbers reduced to last 4", async () => {
    const rows = await inspect(FULL.phone);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.transfer_phone_last4).toBe("2333");
    expect(row.main_phone_last4).toBe("0111");
    expect(row.transfer_policy).toBe("never");
    expect(row.live_voice).toBe("Kore");
    expect(row.locale).toBe("en-GB");
    expect(row.outbound_enabled).toBe(true);
    expect(row.transfer_no_answer).toBe("own_voicemail");
  });

  it("keeps the pre-existing fields", async () => {
    const [row] = await inspect(FULL.phone);
    expect(row.id).toBe(FULL.id);
    expect(row.name).toBe("Full Config Co");
    expect(row.phone_number).toBe(FULL.phone);
    expect(row.timezone).toBe("America/Chicago");
    expect(row.has_general_info).toBe(false);
    expect(row.general_info_chars).toBe(0);
    expect(row.general_info_mentions_price).toBeNull();
    expect(row.notifications_enabled).toBe(true);
    expect(row.has_notification_email).toBe(false);
    expect(row.has_notification_phone).toBe(false);
  });

  it("never lets a whole number leave the database", async () => {
    const [row] = await inspect(FULL.phone);
    const s = JSON.stringify(row);
    expect(s).not.toContain("+441111222333");
    expect(s).not.toContain("1111222333");
    expect(s).not.toContain("+441372000111");
    expect(Object.keys(row)).not.toContain("transfer_phone_number");
    expect(Object.keys(row)).not.toContain("main_phone");
  });

  it("prints null last-4s when the numbers are unset", async () => {
    const [row] = await inspect(BARE.phone);
    expect(row.transfer_phone_last4).toBeNull();
    expect(row.main_phone_last4).toBeNull();
    expect(row.outbound_enabled).toBe(false);
    expect(row.transfer_no_answer).toBe("take_message");
    expect(row.transfer_screening).toBe(false);
    expect(row.transfer_whisper).toBeNull();
  });

  it("returns [] for an unknown number", async () => {
    expect(await inspect("+441372880099")).toEqual([]);
  });
});
