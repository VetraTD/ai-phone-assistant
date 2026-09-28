// tests/db/connectionsOutbox.test.js
/**
 * S3-8: the services/db.js functions over webhook_endpoints/outbox, as
 * vetra_app under RLS (real Postgres, not the fake-db unit tests in
 * tests/connectionsOutbox.test.js). Row-level security ITSELF (every table
 * refuses a cross-tenant read/write) is already covered generically by
 * tests/db/outboundRls.test.js's TABLES loop, which includes both tables --
 * this file is about the FUNCTIONS: idempotency (including across tenants,
 * named risk 6), the delivered/dead guard (named risk 7), event-filter
 * matching, and per-tenant due-row scoping.
 *
 * Pattern: tests/db/outboundPostCallWrites.test.js (vetra_app LOGIN toggle,
 * DATABASE_URL swapped to the vetra_app connection string before importing
 * services/db.js, an `admin` superuser client for setup/verification).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BIZ_A = "0e0e0000-0000-4000-8000-00000000000a";
const BIZ_B = "0e0e0000-0000-4000-8000-00000000000b";
let admin, db;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [BIZ_A, BIZ_B]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Outbox Co A'), ($2,'Outbox Co B')`, [BIZ_A, BIZ_B]);

  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [BIZ_A, BIZ_B]).catch(() => {});
  await admin.end();
});

/** A fresh webhook_endpoints row for `biz`, via the admin (superuser) client. */
async function mkEndpoint(biz, { url: epUrl = "https://example.com/hook", events = [], active = true } = {}) {
  const res = await admin.query(
    `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1,$2,'\\x00',$3,$4) RETURNING id`,
    [biz, epUrl, events, active]
  );
  return res.rows[0].id;
}

async function readOutboxRow(id) {
  const res = await admin.query(`SELECT * FROM outbox WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

let seq = 0;
const uid = () => `2e2e0000-0000-4000-8000-${String((seq++).toString(16)).padStart(12, "0")}`;

d("insertOutboxRow: idempotency", () => {
  it("a second insert with the SAME idempotency key, same tenant, is a no-op -- exactly one row", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id1 = uid();
    const key = `idem-${Date.now()}-a`;
    const first = await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id: id1, kind: "webhook", targetId: epId, eventType: "call.completed", payload: { n: 1 }, idempotencyKey: key })
    );
    expect(first).toEqual({ inserted: true, id: id1 });

    const id2 = uid(); // a DIFFERENT generated id -- the conflict must still win on (business_id, idempotency_key)
    const second = await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id: id2, kind: "webhook", targetId: epId, eventType: "call.completed", payload: { n: 2 }, idempotencyKey: key })
    );
    expect(second).toEqual({ inserted: false, id: id2 });

    const rows = await admin.query(`SELECT id, payload FROM outbox WHERE business_id = $1 AND idempotency_key = $2`, [BIZ_A, key]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(id1); // the FIRST row -- the second insert never landed, never overwrote
    expect(rows.rows[0].payload).toEqual({ n: 1 });
  });

  // Named risk 6: idempotency key collisions ACROSS tenants. The unique
  // constraint is (business_id, idempotency_key) -- the SAME key string used
  // by two different tenants must produce TWO real rows, not a false
  // "already exists" collision that would silently drop tenant B's event.
  it("the SAME idempotency key string, two DIFFERENT tenants, produces two real rows -- no cross-tenant collision", async () => {
    const epA = await mkEndpoint(BIZ_A);
    const epB = await mkEndpoint(BIZ_B);
    const sharedKey = `shared-key-${Date.now()}`;
    const idA = uid();
    const idB = uid();

    const resA = await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id: idA, kind: "webhook", targetId: epA, eventType: "call.completed", payload: { tenant: "A" }, idempotencyKey: sharedKey })
    );
    const resB = await db.withTenant(BIZ_B, () =>
      db.insertOutboxRow({ id: idB, kind: "webhook", targetId: epB, eventType: "call.completed", payload: { tenant: "B" }, idempotencyKey: sharedKey })
    );

    expect(resA).toEqual({ inserted: true, id: idA });
    expect(resB).toEqual({ inserted: true, id: idB });

    const rowA = await readOutboxRow(idA);
    const rowB = await readOutboxRow(idB);
    expect(rowA.business_id).toBe(BIZ_A);
    expect(rowB.business_id).toBe(BIZ_B);
    expect(rowA.payload).toEqual({ tenant: "A" });
    expect(rowB.payload).toEqual({ tenant: "B" });
  });
});

d("getOutboxRow / getWebhookEndpoint: tenant scoping (no cross-tenant read)", () => {
  it("a row created under tenant A is invisible when read under tenant B's scope", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = uid();
    await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id, kind: "webhook", targetId: epId, eventType: "call.completed", payload: {}, idempotencyKey: `scope-${id}` })
    );
    const seenByOwner = await db.withTenant(BIZ_A, () => db.getOutboxRow(id));
    const seenByOther = await db.withTenant(BIZ_B, () => db.getOutboxRow(id));
    expect(seenByOwner).not.toBeNull();
    expect(seenByOther).toBeNull(); // RLS: 0 rows, not tenant A's row
  });

  it("getWebhookEndpoint: same rule for an endpoint", async () => {
    const epId = await mkEndpoint(BIZ_A, { url: "https://example.com/only-a" });
    const seenByOwner = await db.withTenant(BIZ_A, () => db.getWebhookEndpoint(epId));
    const seenByOther = await db.withTenant(BIZ_B, () => db.getWebhookEndpoint(epId));
    expect(seenByOwner?.url).toBe("https://example.com/only-a");
    expect(seenByOther).toBeNull();
  });
});

d("listActiveWebhookEndpoints: event-filter matching", () => {
  it("an endpoint with events:[] (the default) matches every event type", async () => {
    await mkEndpoint(BIZ_A, { url: "https://example.com/all-events", events: [] });
    const forCompleted = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("call.completed"));
    const forClosed = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("outreach.closed"));
    expect(forCompleted.some((e) => e.url === "https://example.com/all-events")).toBe(true);
    expect(forClosed.some((e) => e.url === "https://example.com/all-events")).toBe(true);
  });

  it("an endpoint scoped to one event type does not match another", async () => {
    await mkEndpoint(BIZ_A, { url: "https://example.com/only-completed", events: ["call.completed"] });
    const forCompleted = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("call.completed"));
    const forClosed = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("outreach.closed"));
    expect(forCompleted.some((e) => e.url === "https://example.com/only-completed")).toBe(true);
    expect(forClosed.some((e) => e.url === "https://example.com/only-completed")).toBe(false);
  });

  it("an INACTIVE endpoint is never returned, whatever its events list", async () => {
    await mkEndpoint(BIZ_A, { url: "https://example.com/inactive", events: [], active: false });
    const forCompleted = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("call.completed"));
    expect(forCompleted.some((e) => e.url === "https://example.com/inactive")).toBe(false);
  });

  it("secret_ciphertext comes back as a Buffer, never a decrypted string", async () => {
    await mkEndpoint(BIZ_A, { url: "https://example.com/buffer-check", events: [] });
    const rows = await db.withTenant(BIZ_A, () => db.listActiveWebhookEndpoints("call.completed"));
    const row = rows.find((e) => e.url === "https://example.com/buffer-check");
    expect(Buffer.isBuffer(row.secret_ciphertext)).toBe(true);
  });
});

d("markOutboxDelivered / markOutboxRetry / markOutboxDead: the pending-only guard (named risk 7)", () => {
  async function mkRow(biz, epId) {
    const id = uid();
    await db.withTenant(biz, () =>
      db.insertOutboxRow({ id, kind: "webhook", targetId: epId, eventType: "call.completed", payload: {}, idempotencyKey: `guard-${id}` })
    );
    return id;
  }

  it("markOutboxDelivered moves pending -> delivered and sets delivered_at", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    const ok = await db.withTenant(BIZ_A, () => db.markOutboxDelivered(id));
    expect(ok).toBe(true);
    const row = await readOutboxRow(id);
    expect(row.status).toBe("delivered");
    expect(row.delivered_at).not.toBeNull();
  });

  it("markOutboxDelivered on an ALREADY-delivered row is a no-op (returns false, does not re-stamp)", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    await db.withTenant(BIZ_A, () => db.markOutboxDelivered(id));
    const firstDeliveredAt = (await readOutboxRow(id)).delivered_at;
    await new Promise((r) => setTimeout(r, 5));
    const second = await db.withTenant(BIZ_A, () => db.markOutboxDelivered(id));
    expect(second).toBe(false);
    const row = await readOutboxRow(id);
    expect(row.delivered_at.getTime()).toBe(firstDeliveredAt.getTime());
  });

  it("markOutboxDead moves pending -> dead", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    const ok = await db.withTenant(BIZ_A, () => db.markOutboxDead(id, { attempts: 6, lastError: "500" }));
    expect(ok).toBe(true);
    const row = await readOutboxRow(id);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(6);
    expect(row.last_error).toBe("500");
  });

  it("named risk 7: a row already DEAD can never be resurrected to delivered", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    await db.withTenant(BIZ_A, () => db.markOutboxDead(id, { attempts: 6, lastError: "ECONNREFUSED" }));
    const resurrected = await db.withTenant(BIZ_A, () => db.markOutboxDelivered(id));
    expect(resurrected).toBe(false);
    const row = await readOutboxRow(id);
    expect(row.status).toBe("dead"); // unchanged
  });

  it("named risk 7: a row already DEAD can never retry again (markOutboxRetry is also a no-op)", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    await db.withTenant(BIZ_A, () => db.markOutboxDead(id, { attempts: 6, lastError: "ECONNREFUSED" }));
    // expectedAttempts: 6, matching what markOutboxDead just wrote -- this
    // proves the STATUS guard specifically refuses it (status='dead'), not
    // merely a mismatched expectedAttempts.
    const retried = await db.withTenant(BIZ_A, () => db.markOutboxRetry(id, { attempts: 7, nextAttemptAt: new Date(Date.now() + 60_000), lastError: "500", expectedAttempts: 6 }));
    expect(retried).toBe(false);
    const row = await readOutboxRow(id);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(6); // unchanged -- the retry write never landed
  });

  it("markOutboxRetry sets attempts/next_attempt_at/last_error and leaves status pending", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    const nextAt = new Date(Date.now() + 300_000);
    // expectedAttempts: 0 -- mkRow's fresh insert leaves attempts at its
    // column default (S3-8 fix round 1: markOutboxRetry's compare-and-set,
    // I2).
    const ok = await db.withTenant(BIZ_A, () => db.markOutboxRetry(id, { attempts: 2, nextAttemptAt: nextAt, lastError: "503", expectedAttempts: 0 }));
    expect(ok).toBe(true);
    const row = await readOutboxRow(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("503");
    expect(Math.abs(row.next_attempt_at.getTime() - nextAt.getTime())).toBeLessThan(1000);
  });

  // S3-8 fix round 1, I2: the compare-and-set itself, on real Postgres --
  // not just the route-level fake-db simulation in
  // tests/outboundInternalRoutes.test.js.
  it("I2: a STALE expectedAttempts is refused, even though status is still pending (the actual race the fix closes)", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = await mkRow(BIZ_A, epId);
    // The "real" write: attempts 0 -> 1.
    const first = await db.withTenant(BIZ_A, () => db.markOutboxRetry(id, { attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000), lastError: "500", expectedAttempts: 0 }));
    expect(first).toBe(true);

    // A "duplicate" delivery that started from the SAME original snapshot
    // (attempts=0) tries to write attempts 0 -> 1 again -- its
    // expectedAttempts:0 no longer matches the row's real attempts (1).
    const stale = await db.withTenant(BIZ_A, () => db.markOutboxRetry(id, { attempts: 1, nextAttemptAt: new Date(Date.now() + 120_000), lastError: "503", expectedAttempts: 0 }));
    expect(stale).toBe(false);

    const row = await readOutboxRow(id);
    expect(row.attempts).toBe(1); // the FIRST write's value, never double-applied
    expect(row.last_error).toBe("500"); // the stale write's last_error never landed
  });
});

d("dueOutboxRows: per-tenant, status=pending, next_attempt_at due -- no cross-tenant leakage", () => {
  it("only returns THIS tenant's due rows, even when another tenant also has one", async () => {
    const epA = await mkEndpoint(BIZ_A);
    const epB = await mkEndpoint(BIZ_B);
    const idA = uid();
    const idB = uid();
    await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id: idA, kind: "webhook", targetId: epA, eventType: "call.completed", payload: {}, idempotencyKey: `due-a-${idA}`, nextAttemptAt: new Date(Date.now() - 1000) })
    );
    await db.withTenant(BIZ_B, () =>
      db.insertOutboxRow({ id: idB, kind: "webhook", targetId: epB, eventType: "call.completed", payload: {}, idempotencyKey: `due-b-${idB}`, nextAttemptAt: new Date(Date.now() - 1000) })
    );

    const dueForA = await db.withTenant(BIZ_A, () => db.dueOutboxRows(100));
    const dueForB = await db.withTenant(BIZ_B, () => db.dueOutboxRows(100));

    expect(dueForA.some((r) => r.id === idA)).toBe(true);
    expect(dueForA.some((r) => r.id === idB)).toBe(false); // tenant A never sees tenant B's due row
    expect(dueForB.some((r) => r.id === idB)).toBe(true);
    expect(dueForB.some((r) => r.id === idA)).toBe(false);
  });

  it("a row not yet due (next_attempt_at in the future) is excluded", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = uid();
    await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id, kind: "webhook", targetId: epId, eventType: "call.completed", payload: {}, idempotencyKey: `future-${id}`, nextAttemptAt: new Date(Date.now() + 3_600_000) })
    );
    const due = await db.withTenant(BIZ_A, () => db.dueOutboxRows(100));
    expect(due.some((r) => r.id === id)).toBe(false);
  });

  it("a DELIVERED or DEAD row is excluded even if its next_attempt_at is in the past", async () => {
    const epId = await mkEndpoint(BIZ_A);
    const id = uid();
    await db.withTenant(BIZ_A, () =>
      db.insertOutboxRow({ id, kind: "webhook", targetId: epId, eventType: "call.completed", payload: {}, idempotencyKey: `delivered-${id}`, nextAttemptAt: new Date(Date.now() - 1000) })
    );
    await db.withTenant(BIZ_A, () => db.markOutboxDelivered(id));
    const due = await db.withTenant(BIZ_A, () => db.dueOutboxRows(100));
    expect(due.some((r) => r.id === id)).toBe(false);
  });
});

d("outboundBookingInfo / outboundResultsLabels", () => {
  it("outboundBookingInfo returns null for a null callId without a tenant scope", async () => {
    expect(await db.outboundBookingInfo(null)).toBeNull();
  });

  it("outboundResultsLabels reads the campaign name and contact first_name/external_ids by id", async () => {
    const camp = await admin.query(
      `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
       VALUES ($1,'Speed to lead','speed_to_lead','solicited','business','active',1) RETURNING id`,
      [BIZ_A]
    );
    const con = await admin.query(
      `INSERT INTO contacts (business_id, phone_e164, first_name, external_ids) VALUES ($1,'+447700900321','Sam','{"crm_id":"42"}') RETURNING id`,
      [BIZ_A]
    );
    const labels = await db.withTenant(BIZ_A, () =>
      db.outboundResultsLabels({ campaignId: camp.rows[0].id, contactId: con.rows[0].id })
    );
    expect(labels).toEqual({ campaignName: "Speed to lead", contactFirstName: "Sam", contactExternalIds: { crm_id: "42" } });
  });
});
