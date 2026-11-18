import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// The question B2 actually depends on: do the EXPORTED data-layer functions
// work, unmodified, inside withTenant, as the unprivileged role?
//
// tests/db/rlsAppRole.test.js proved the raw SQL does. This proves the API
// does — which is a different claim, because every one of those functions
// reaches the database through `q()`, twenty frames below whoever opened the
// scope. If AsyncLocalStorage does not carry the client all the way down, they
// silently fall back to the pool, run unscoped, and return nothing. That
// failure looks exactly like an empty database.
//
// It also pins the other half: the SAME functions, called OUTSIDE a scope,
// must still return nothing. If they worked either way the scoping would be
// decorative.

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const TENANT_A = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  for (const [id, name, phone] of [
    [TENANT_A, "Scoped A", "+15552220001"],
    [TENANT_B, "Scoped B", "+15552220002"],
  ]) {
    await admin.query(`INSERT INTO businesses (id, name, phone_number) VALUES ($1, $2, $3)`, [id, name, phone]);
    await admin.query(`INSERT INTO business_knowledge (business_id, question, answer) VALUES ($1, 'hours', $2)`, [
      id,
      `knowledge for ${name}`,
    ]);
    const call = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status)
       VALUES ($1, $2, '+15559990000', 'completed') RETURNING id`,
      [id, `CA-scoped-${id.slice(0, 8)}`]
    );
    await admin.query(
      `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at)
       VALUES ($1, $2, $3, '+15559990000', now() + interval '2 days')`,
      [id, call.rows[0].id, `Patient of ${name}`]
    );
  }
});

describeDb("exported functions work inside withTenant", () => {
  it("fetchBusinessKnowledge returns this tenant's rows", async () => {
    const rows = await db.withTenant(TENANT_A, () => db.fetchBusinessKnowledge(TENANT_A));
    expect(rows).toHaveLength(1);
    expect(rows[0].answer).toBe("knowledge for Scoped A");
  });

  it("fetchBusinessById works", async () => {
    const biz = await db.withTenant(TENANT_A, () => db.fetchBusinessById(TENANT_A));
    expect(biz?.name).toBe("Scoped A");
  });

  it("createCall writes, where unscoped it was rejected", async () => {
    const id = await db.withTenant(TENANT_A, () =>
      db.createCall(TENANT_A, "CA-scoped-write", "+15558887777", "+15552220001")
    );
    expect(id).toBeTruthy();
  });

  // The one that proves the context really does travel. fetchCallerContext
  // calls listAppointmentsByCaller two frames down; if the scope did not reach
  // that far it would return an empty appointment list and look like a caller
  // with no history.
  it("fetchCallerContext works through a nested call two frames down", async () => {
    const ctx = await db.withTenant(TENANT_A, () => db.fetchCallerContext(TENANT_A, "+15559990000"));
    expect(ctx.callCount).toBe(1);
    expect(ctx.upcomingAppointments).toHaveLength(1);
    expect(ctx.upcomingAppointments[0].client_name).toBe("Patient of Scoped A");
  });

  it("parallel reads inside one scope share it", async () => {
    // Promise.all inside the scope — the pickup path does exactly this, and
    // AsyncLocalStorage has to survive the branch.
    const [knowledge, biz] = await db.withTenant(TENANT_A, () =>
      Promise.all([db.fetchBusinessKnowledge(TENANT_A), db.fetchBusinessById(TENANT_A)])
    );
    expect(knowledge).toHaveLength(1);
    expect(biz.name).toBe("Scoped A");
  });

  it("sees nothing belonging to the other tenant", async () => {
    const rows = await db.withTenant(TENANT_A, () => db.fetchBusinessKnowledge(TENANT_B));
    expect(rows).toEqual([]);
  });
});

describeDb("outside a scope the same functions return nothing", () => {
  // Without this the tests above prove only that the functions work, not that
  // the scoping is doing anything.
  it("fetchBusinessKnowledge is empty", async () => {
    expect(await db.fetchBusinessKnowledge(TENANT_A)).toEqual([]);
  });

  it("fetchBusinessById is null", async () => {
    expect(await db.fetchBusinessById(TENANT_A)).toBeNull();
  });

  it("createCall is refused", async () => {
    expect(await db.createCall(TENANT_A, "CA-unscoped-write", "+1", "+2")).toBeNull();
  });
});

describeDb("nested and concurrent scopes", () => {
  it("two concurrent scopes do not bleed into each other", async () => {
    // The failure this guards against is the reason for AsyncLocalStorage
    // rather than a module-level variable: two calls in flight at once, each
    // needing its own tenant, on a shared pool.
    const [a, b] = await Promise.all([
      db.withTenant(TENANT_A, () => db.fetchBusinessKnowledge(TENANT_A)),
      db.withTenant(TENANT_B, () => db.fetchBusinessKnowledge(TENANT_B)),
    ]);
    expect(a[0].answer).toBe("knowledge for Scoped A");
    expect(b[0].answer).toBe("knowledge for Scoped B");
  });

  it("a scope closes when its body throws, and the next one is unaffected", async () => {
    await expect(
      db.withTenant(TENANT_A, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const rows = await db.withTenant(TENANT_B, () => db.fetchBusinessKnowledge(TENANT_B));
    expect(rows[0].answer).toBe("knowledge for Scoped B");
  });
});

describeDb("withTenantSafe", () => {
  // The voice path and /twilio/status must not fail because a write failed:
  // a call has to keep being answered, and a 500 from the status callback
  // makes Twilio retry it.
  it("returns the fallback instead of throwing", async () => {
    const out = await db.withTenantSafe(
      TENANT_A,
      async () => {
        throw new Error("boom");
      },
      { operation: "test", fallback: "fallback" }
    );
    expect(out).toBe("fallback");
  });

  it("returns the value when it works", async () => {
    const out = await db.withTenantSafe(TENANT_A, () => db.fetchBusinessKnowledge(TENANT_A), {
      operation: "test",
      fallback: [],
    });
    expect(out).toHaveLength(1);
  });

  // Deliberately NOT "skips the work". Skipping would change behaviour today —
  // summaries would stop generating for any call whose shared state lost its
  // businessId — to solve a problem that starts at B2. Running unscoped is a
  // no-op now and fails closed later, because unscoped queries match no rows
  // once the app stops being a superuser.
  it("runs unscoped when businessId is missing, rather than skipping the work", async () => {
    let ran = false;
    const out = await db.withTenantSafe(
      null,
      async () => {
        ran = true;
        return "ran";
      },
      { operation: "test", fallback: null }
    );
    expect(ran).toBe(true);
    expect(out).toBe("ran");
  });

  it("unscoped work still sees nothing, so it fails closed", async () => {
    const rows = await db.withTenantSafe(null, () => db.fetchBusinessKnowledge(TENANT_A), {
      operation: "test",
      fallback: null,
    });
    expect(rows).toEqual([]);
  });
});
