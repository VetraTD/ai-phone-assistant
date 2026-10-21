// tests/db/fixedLineClips.test.js
/**
 * Migration 057 on real Postgres, as the unprivileged vetra_app role: the
 * fixed-line clips round-trip through the two definer functions, the table
 * itself is not reachable directly, and bad keys/hashes are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const H1 = "a".repeat(32);
const H2 = "b".repeat(32);

let admin;
let db;
let app;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM fixed_line_clips WHERE hash = ANY($1)`, [[H1, H2]]);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM fixed_line_clips WHERE hash = ANY($1)`, [[H1, H2]]).catch(() => {});
  await app?.end();
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
  process.env.DATABASE_URL = url;
});

describeDb("fixed_line_clips (migration 057)", () => {
  it("round-trips through the definer functions as vetra_app, and an upsert replaces", async () => {
    await db.upsertFixedLineClip({ hash: H1, lineKey: "technical", voiceName: "en-GB-Chirp3-HD-Kore", audio: Buffer.alloc(800, 0x7f) });
    await db.upsertFixedLineClip({ hash: H1, lineKey: "technical", voiceName: "en-GB-Chirp3-HD-Kore", audio: Buffer.alloc(900, 0x7f) });
    const rows = await db.fetchFixedLineClips([H1, H2]);
    expect(rows.map((r) => r.hash)).toEqual([H1]);
    expect(Buffer.from(rows[0].audio).length).toBe(900);
  });

  it("vetra_app cannot read or write the table directly", async () => {
    await expect(app.query(`SELECT * FROM fixed_line_clips`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM fixed_line_clips`)).rejects.toThrow(/permission denied/);
  });

  it("refuses a malformed hash, an unknown line and empty audio", async () => {
    await expect(db.upsertFixedLineClip({ hash: "short", lineKey: "technical", voiceName: "v", audio: Buffer.alloc(8) })).rejects.toThrow();
    await expect(db.upsertFixedLineClip({ hash: H2, lineKey: "hello", voiceName: "v", audio: Buffer.alloc(8) })).rejects.toThrow();
    await expect(db.upsertFixedLineClip({ hash: H2, lineKey: "technical", voiceName: "v", audio: Buffer.alloc(0) })).rejects.toThrow();
  });
});
