// tests/db/greetingClips.test.js
/**
 * Migrations 055 + 056 on real Postgres, as the unprivileged vetra_app role
 * under FORCE RLS: a greeting clip round-trips for its own tenant, is invisible
 * to another, and an unscoped write is refused rather than "succeeding".
 * businesses.pronunciations defaults to {} and loadConfig reads a written map.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const TENANT = "77777777-aaaa-4aaa-8aaa-777777777777";
const OTHER = "88888888-aaaa-4aaa-8aaa-888888888888";

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
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1)`, [[TENANT, OTHER]]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

beforeEach(async () => {
  if (!url) return;
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1)`, [[TENANT, OTHER]]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Clip Test'), ($2, 'Other Biz')`, [TENANT, OTHER]);
});

const CLIP = {
  businessId: TENANT,
  variant: "custom",
  languageCode: "en-GB",
  inputHash: "abc123",
  spokenText: "Thanks for calling Dij-aisle Media.",
  voiceName: "en-GB-Chirp3-HD-Kore",
  audio: Buffer.alloc(1600, 0xff),
};

describeDb("greeting_clips (migration 056)", () => {
  it("round-trips a clip for its own tenant, and an upsert replaces it", async () => {
    await db.withTenant(TENANT, () => db.upsertGreetingClip(CLIP));
    await db.withTenant(TENANT, () => db.upsertGreetingClip({ ...CLIP, inputHash: "def456" }));
    const row = await db.withTenant(TENANT, () => db.fetchGreetingClip(TENANT, "custom", "en-GB"));
    expect(row.input_hash).toBe("def456");
    expect(Buffer.from(row.audio).length).toBe(1600);
  });

  it("another tenant cannot read it", async () => {
    await db.withTenant(TENANT, () => db.upsertGreetingClip(CLIP));
    const row = await db.withTenant(OTHER, () => db.fetchGreetingClip(TENANT, "custom", "en-GB"));
    expect(row).toBeNull();
  });

  it("a write scoped to the wrong tenant is refused, not silently empty", async () => {
    await expect(db.withTenant(OTHER, () => db.upsertGreetingClip(CLIP))).rejects.toThrow();
  });

  it("rejects an unknown variant", async () => {
    await expect(db.withTenant(TENANT, () => db.upsertGreetingClip({ ...CLIP, variant: "noon" }))).rejects.toThrow();
  });
});

describeDb("businesses.pronunciations (migration 055)", () => {
  it("defaults to {} and loadConfig reads a written map", async () => {
    let row = (await admin.query(`SELECT * FROM businesses WHERE id = $1`, [TENANT])).rows[0];
    expect(row.pronunciations).toEqual({});
    await db.withTenant(TENANT, (c) =>
      c.query(`UPDATE businesses SET pronunciations = $2 WHERE id = $1`, [TENANT, JSON.stringify({ Digile: "Dij-aisle" })])
    );
    row = (await admin.query(`SELECT * FROM businesses WHERE id = $1`, [TENANT])).rows[0];
    expect(db.loadConfig(row, []).pronunciations).toEqual({ Digile: "Dij-aisle" });
  });
});
