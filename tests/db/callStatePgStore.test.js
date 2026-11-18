import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createPgStore } from "../../lib/callStateStore.js";
import { crossProcessCallStateSuite } from "../helpers/callStateCrossProcessSuite.js";

// ---------------------------------------------------------------------------
// The Postgres half of A4 / Phase 3a.
//
// tests/callStateMultiProcess.test.js runs the cross-process contract against a
// file, because a file is the smallest thing that is genuinely cross-process
// and the root suite must not need a container. This file runs THE SAME
// CONTRACT, verbatim, against migration 038 — two OS processes, each with its
// own pg.Pool, one writing at a call boundary and one reading cold.
//
// That is the claim `CALL_STATE_STORE=pg` makes and it is the only way to check
// it. A store tested through one handle in one process cannot fail the way the
// live bug fails.
//
// Everything below the contract is Postgres-specific: the things a Map has no
// equivalent of, and the guards the migration asserts in its own comments.
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_ROLE = "vetra_app";

/** Every call SID this file uses, so cleanup is a list rather than a wildcard. */
const OWNED_SIDS = [
  "CA_cross_1",
  "CA_cross_summary",
  "CA_cross_missed",
  "CA_cross_spam",
  "CA_cross_silent",
  "CA_other",
  "CA_never_happened",
  "CA_cross_slice",
  "CA_sabotage",
  "CA_pg_pools",
  "CA_pg_merge",
  "CA_pg_ttl",
  "CA_pg_prune",
  "CA_pg_unknown",
  "CA_pg_role",
  "CA_pg_nulls",
];

/** @type {pg.Client} */
let admin;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM call_state WHERE call_sid = ANY($1)`, [OWNED_SIDS]).catch(() => {});
  await admin.end();
});

beforeEach(async () => {
  if (!admin) return;
  // Between tests, not just at the end: the contract includes "a call the
  // writer never saw comes back empty", which a leftover row from a previous
  // run would turn green for the wrong reason.
  await admin.query(`DELETE FROM call_state WHERE call_sid = ANY($1)`, [OWNED_SIDS]);
});

describeDb("call state, Postgres store", () => {
  // The shared contract, unchanged. Two child processes, two independent pools.
  crossProcessCallStateSuite({
    label: "postgres, two pools in two processes",
    kind: "pg",
    target: () => url,
    readRaw: async (callSid) => {
      const { rows } = await admin.query(
        `SELECT db_call_id, business_id, saw_caller_final FROM call_state WHERE call_sid = $1`,
        [callSid]
      );
      const row = rows[0] ?? {};
      // Column names back to field names, so the contract's assertion about
      // SHARED_FIELDS is asking the same question of both backends.
      const map = { db_call_id: "dbCallId", business_id: "businessId", saw_caller_final: "sawCallerFinal" };
      const keys = Object.entries(row)
        .filter(([, v]) => v !== null)
        .map(([k]) => map[k]);
      return { keys, text: JSON.stringify(row) };
    },
  });

  describe("two genuinely independent pools", () => {
    it("a store on one pool reads what a store on another pool wrote", async () => {
      const writerPool = new pg.Pool({ connectionString: url, max: 1 });
      const readerPool = new pg.Pool({ connectionString: url, max: 1 });
      const writer = createPgStore({ pool: writerPool, pruneIntervalMs: 0 });
      const reader = createPgStore({ pool: readerPool, pruneIntervalMs: 0 });
      try {
        await writer.merge("CA_pg_pools", { dbCallId: "d", businessId: "b", sawCallerFinal: true });
        expect(await reader.get("CA_pg_pools")).toEqual({ dbCallId: "d", businessId: "b", sawCallerFinal: true });
      } finally {
        writer.close();
        reader.close();
        await writerPool.end();
        await readerPool.end();
      }
    });
  });

  describe("the same three methods, same semantics as the Map", () => {
    /** @type {pg.Pool} */
    let pool;
    /** @type {ReturnType<typeof createPgStore>} */
    let store;

    beforeAll(() => {
      if (!url) return;
      pool = new pg.Pool({ connectionString: url, max: 2 });
      store = createPgStore({ pool, pruneIntervalMs: 0 });
    });

    afterAll(async () => {
      if (!pool) return;
      store.close();
      await pool.end();
    });

    it("merges rather than replaces", async () => {
      await store.merge("CA_pg_merge", { businessId: "b" });
      await store.merge("CA_pg_merge", { sawCallerFinal: true });
      expect(await store.get("CA_pg_merge")).toEqual({ businessId: "b", sawCallerFinal: true });
    });

    it("delete removes the record", async () => {
      await store.merge("CA_pg_merge", { businessId: "b" });
      await store.delete("CA_pg_merge");
      expect(await store.get("CA_pg_merge")).toBeNull();
    });

    it("a call it never saw is null, not an empty object", async () => {
      expect(await store.get("CA_never_happened")).toBeNull();
    });

    // The documented divergence, asserted rather than left as a comment. An
    // explicitly-null field comes back ABSENT here and `null` from the Map;
    // every consumer reads `shared.x ?? null`, so the two are the same value
    // downstream — but a future reader deserves to see which it is.
    it("an explicitly-null field reads as absent, and false is NOT stripped", async () => {
      await store.merge("CA_pg_nulls", { dbCallId: null, businessId: "b", sawCallerFinal: false });
      expect(await store.get("CA_pg_nulls")).toEqual({ businessId: "b", sawCallerFinal: false });
    });
  });

  describe("TTL", () => {
    it("expires on read, so an abandoned call is not held forever", async () => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      const live = createPgStore({ pool, pruneIntervalMs: 0 });
      const expired = createPgStore({ pool, ttlMs: -1, pruneIntervalMs: 0 });
      try {
        await live.merge("CA_pg_ttl", { businessId: "b" });
        // Same row, same pool, two TTLs. The row is only invisible to the one
        // whose window has closed — which is what proves the filter is doing
        // the work and not something else.
        expect(await live.get("CA_pg_ttl")).toEqual({ businessId: "b" });
        expect(await expired.get("CA_pg_ttl")).toBeNull();
      } finally {
        live.close();
        expired.close();
        await pool.end();
      }
    });

    it("prune actually deletes, and reports how many", async () => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      const store = createPgStore({ pool, ttlMs: -1, pruneIntervalMs: 0 });
      try {
        await store.merge("CA_pg_prune", { businessId: "b" });
        const removed = await store.prune();
        expect(removed).toBeGreaterThanOrEqual(1);
        const { rows } = await admin.query(`SELECT 1 FROM call_state WHERE call_sid = $1`, ["CA_pg_prune"]);
        expect(rows).toHaveLength(0);
      } finally {
        store.close();
        await pool.end();
      }
    });
  });

  describe("the guards migration 038 claims", () => {
    // The design constraint that makes Postgres sufficient instead of
    // Memorystore is that nothing is written per turn. That holds only while
    // the slice stays three scalars, and the way it stops holding is a fourth
    // field arriving quietly.
    it("refuses a patch containing a field outside SHARED_FIELDS", async () => {
      await expect(
        admin.query(`SELECT app_call_state_merge($1, $2::jsonb)`, [
          "CA_pg_unknown",
          JSON.stringify({ businessId: "b", history: [{ role: "user" }] }),
        ])
      ).rejects.toThrow(/unknown shared field\(s\): history/);
    });

    it("refuses a write with no call SID", async () => {
      await expect(admin.query(`SELECT app_call_state_merge($1, '{}'::jsonb)`, [""])).rejects.toThrow(
        /call_sid is required/
      );
    });

    // ------------------------------------------------------------------
    // The access model, checked rather than asserted in a comment.
    //
    // This test exists because migration 033 makes the identical claim about
    // `business_directory` in its own COMMENT ON TABLE — "deliberately NOT
    // granted to vetra_app" — and the claim is false: 029's ALTER DEFAULT
    // PRIVILEGES grants every later table to the application role
    // automatically, and 033 only revoked FROM PUBLIC. Nothing caught it
    // because nothing asked.
    // ------------------------------------------------------------------
    it(`${APP_ROLE} cannot read the table directly, so it cannot enumerate calls`, async () => {
      const { rows } = await admin.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = 'call_state' AND grantee = $1`,
        [APP_ROLE]
      );
      expect(rows, `${APP_ROLE} holds table privileges on call_state; the REVOKE in 038 did not take`).toEqual([]);

      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`SET ROLE ${APP_ROLE}`);
        await expect(client.query(`SELECT call_sid FROM call_state`)).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }
    });

    it(`${APP_ROLE} can still merge, get and delete through the definer functions`, async () => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`SET ROLE ${APP_ROLE}`);
        await client.query(`SELECT app_call_state_merge($1, $2::jsonb)`, [
          "CA_pg_role",
          JSON.stringify({ businessId: "b", sawCallerFinal: true }),
        ]);
        const { rows } = await client.query(`SELECT app_call_state_get($1, 3600) AS state`, ["CA_pg_role"]);
        expect(rows[0].state).toEqual({ businessId: "b", sawCallerFinal: true });
        await client.query(`SELECT app_call_state_delete($1)`, ["CA_pg_role"]);
        const after = await client.query(`SELECT app_call_state_get($1, 3600) AS state`, ["CA_pg_role"]);
        expect(after.rows[0].state).toBeNull();
      } finally {
        await client.end();
      }
    });

    // Not an oversight — the reason is in the migration header. A policy of the
    // form `business_id = app_current_business_id()` would return zero rows to
    // the status handler, which has no tenant yet; that being the entire point.
    it("has no row-level security, deliberately, and the reason is recorded on the table", async () => {
      const { rows } = await admin.query(
        `SELECT relrowsecurity, obj_description(oid, 'pg_class') AS comment
           FROM pg_class WHERE relname = 'call_state' AND relnamespace = 'public'::regnamespace`
      );
      expect(rows[0].relrowsecurity).toBe(false);
      expect(rows[0].comment).toMatch(/NO row-level security/);
    });
  });
});
