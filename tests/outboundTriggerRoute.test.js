// tests/outboundTriggerRoute.test.js
/**
 * S3-9: the leads-in link, POST /v1/triggers/:triggerToken
 * (lib/outbound/triggerRoute.js). Fake db here, business logic only;
 * tests/db/outboundTrigger.test.js runs the real route against real
 * Postgres (the directory definer, the full write path, and the S3-6/S3-9
 * details wire).
 *
 * The 413 (16 KB body) and 429 (31st request/min) cases are proven through
 * the REAL server.js app (tests/outboundInternalRoutesBodyLimit.test.js's
 * own idiom): server.js installs a global express.json()/express.urlencoded()
 * ahead of every route except a documented exclusion list, and body-parser
 * skips re-parsing an already-drained stream -- so a bare express() app (no
 * global parser to shadow the route's own) cannot see either bug. Same for
 * the rate limiter: it has to run through the actual mounted middleware
 * chain, not a hand-built one.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import crypto, { timingSafeEqual } from "node:crypto";

// The sabotage-detection test below needs to prove the REAL
// crypto.timingSafeEqual is what lib/outbound/triggerRoute.js's
// compareTokenHash actually calls -- not a same-answer `===` that a naive
// behavioural test cannot tell apart (both give the identical boolean for
// every real input; that IS the property a constant-time comparator is
// supposed to have). A plain `vi.spyOn(crypto, "timingSafeEqual")` does not
// see calls made through triggerRoute.js's own `import * as crypto from
// "node:crypto"` -- Node's builtin ESM modules do not share a single
// mutable object across independently-resolved imports the way a spy needs.
// Mocking the module (delegating to the real implementation via
// importOriginal, wrapped in one vi.fn) is what actually intercepts it: the
// mock replaces what EVERY importer of "node:crypto" in this file's module
// graph gets, triggerRoute.js included.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import {
  registerTriggerRoute,
  isTriggerRoutePath,
  hashTriggerToken,
  compareTokenHash,
  TRIGGER_PATH,
  RATE_LIMIT_MAX,
} from "../lib/outbound/triggerRoute.js";
// Imported statically, at the top, BEFORE this file's later
// vi.resetModules() call (in the "through the real server" section's
// beforeAll): a dynamic `await import(...)` done AFTER that reset would
// resolve to a DIFFERENT module instance than the one triggerRoute.js's own
// static `import { bumpCounter }` closed over, and the counter assertion
// below would silently watch the wrong object.
import { getLatencyStats } from "../lib/voice/metrics.js";

const RAW_TOKEN = "a".repeat(64);
const GOOD_HASH = hashTriggerToken(RAW_TOKEN);
const BIZ = "biz-trigger-1";
const CAMPAIGN_ID = "camp-trigger-1";
const PHONE = "+447700900600";

function baseCampaignRow(overrides = {}) {
  return {
    complianceClass: "solicited",
    status: "active",
    currentVersion: 1,
    detailsFields: [{ key: "topic_detail", label: "Regarding" }],
    ...overrides,
  };
}

function fakeDb({ campaignRow = baseCampaignRow(), contactId = "contact-1" } = {}) {
  const outreachByKey = new Map();
  let n = 0;
  const createOutreachFromTrigger = vi.fn(async ({ idempotencyKey }) => {
    if (outreachByKey.has(idempotencyKey)) {
      return { id: outreachByKey.get(idempotencyKey), created: false };
    }
    const id = `out-${++n}`;
    outreachByKey.set(idempotencyKey, id);
    return { id, created: true };
  });
  return {
    campaignByTriggerHash: vi.fn(async (hash) => (hash === GOOD_HASH ? { businessId: BIZ, campaignId: CAMPAIGN_ID, triggerTokenHash: GOOD_HASH } : null)),
    withTenant: vi.fn(async (_biz, fn) => fn()),
    campaignForTrigger: vi.fn(async () => campaignRow),
    upsertContactForTrigger: vi.fn(async () => contactId),
    recordTriggerConsent: vi.fn(async () => "consent-1"),
    createOutreachFromTrigger,
  };
}

function buildApp(db, { enqueue, log = { info: () => {}, error: () => {} } } = {}) {
  const app = express();
  registerTriggerRoute(app, { db, log, enqueue });
  return app;
}

const validConsent = () => ({
  purpose: "enquiry_followup",
  channels: ["call", "sms"],
  covers_automated: true,
  captured_at: "2026-09-27T10:00:00.000Z",
  source_ref: "form-123",
});

describe("POST /v1/triggers/:triggerToken -- fake db, business logic", () => {
  it("a bad token 401s, and no db write is attempted", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db)).post(`/v1/triggers/${"b".repeat(64)}`).send({ phone: PHONE, consent: validConsent() });
    expect(res.status).toBe(401);
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it("a hash that resolves but whose stored hash disagrees (defence in depth) also 401s", async () => {
    const db = fakeDb();
    db.campaignByTriggerHash.mockResolvedValueOnce({ businessId: BIZ, campaignId: CAMPAIGN_ID, triggerTokenHash: "not-the-same-hash" });
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: validConsent() });
    expect(res.status).toBe(401);
  });

  it("no consent for a solicited campaign: 422, field consent, no write attempted", async () => {
    const db = fakeDb({ campaignRow: baseCampaignRow({ complianceClass: "solicited" }) });
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("consent");
    expect(db.createOutreachFromTrigger).not.toHaveBeenCalled();
  });

  it("no consent for a marketing_consented campaign: also required", async () => {
    const db = fakeDb({ campaignRow: baseCampaignRow({ complianceClass: "marketing_consented" }) });
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("consent");
  });

  it("a service campaign accepts a request with no consent block at all", async () => {
    const db = fakeDb({ campaignRow: baseCampaignRow({ complianceClass: "service" }) });
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE });
    expect(res.status).toBe(202);
  });

  it("a malformed consent block (no purpose) 422s even on a service campaign", async () => {
    const db = fakeDb({ campaignRow: baseCampaignRow({ complianceClass: "service" }) });
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: { captured_at: "2026-09-27T10:00:00Z" } });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("consent");
  });

  it("a missing/invalid phone 422s with field:phone, before consent is even checked", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: "not-a-number" });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("phone");
  });

  it("an unrecognised timezone 422s with field:timezone", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db))
      .post(`/v1/triggers/${RAW_TOKEN}`)
      .send({ phone: PHONE, consent: validConsent(), timezone: "Not/AZone" });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("timezone");
  });

  it("data that is not an object 422s with field:data", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db))
      .post(`/v1/triggers/${RAW_TOKEN}`)
      .send({ phone: PHONE, consent: validConsent(), data: "not-an-object" });
    expect(res.status).toBe(422);
    expect(res.body.field).toBe("data");
  });

  it("202: details copied (only the campaign's details_fields keys), ignored_fields lists the rest", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db))
      .post(`/v1/triggers/${RAW_TOKEN}`)
      .send({ phone: PHONE, consent: validConsent(), data: { topic_detail: "Roof leak", stray: "nope" } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ outreach_id: "out-1", ignored_fields: ["stray"] });
    expect(db.createOutreachFromTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ details: { topic_detail: "Roof leak" }, campaignId: CAMPAIGN_ID, campaignVersion: 1 })
    );
    // Consent is recorded only because this is the FIRST creation.
    expect(db.recordTriggerConsent).toHaveBeenCalledTimes(1);
  });

  it("a replay (same idempotency_key) returns the SAME outreach_id and does not record consent again", async () => {
    const db = fakeDb();
    const body = { phone: PHONE, consent: validConsent(), idempotency_key: "form-999", data: {} };
    const first = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send(body);
    const second = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.outreach_id).toBe(first.body.outreach_id);
    expect(db.recordTriggerConsent).toHaveBeenCalledTimes(1);
  });

  it("with no details_fields on the campaign, every data key is ignored (defensive default, named risk 5's mirror)", async () => {
    const db = fakeDb({ campaignRow: baseCampaignRow({ detailsFields: [] }) });
    const res = await request(buildApp(db))
      .post(`/v1/triggers/${RAW_TOKEN}`)
      .send({ phone: PHONE, consent: validConsent(), data: { topic_detail: "x" } });
    expect(res.status).toBe(202);
    expect(res.body.ignored_fields).toEqual(["topic_detail"]);
    expect(db.createOutreachFromTrigger).toHaveBeenCalledWith(expect.objectContaining({ details: {} }));
  });

  it("an unexpected throw from the database layer answers 500, not a raw stack trace", async () => {
    const db = fakeDb();
    db.campaignForTrigger.mockRejectedValueOnce(new Error("db down"));
    const res = await request(buildApp(db)).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: validConsent() });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// fix round 1, I2 (controller ruling): spec §12.1 says this route enqueues.
// Take the enqueuer stub's shape from lib/outbound/tasks.js's real
// createDispatchEnqueuer().enqueue return value: {created: boolean}.
// ---------------------------------------------------------------------------
describe("enqueue on create (fix round 1, I2)", () => {
  it("a create enqueues exactly once, with the outreach id and business id", async () => {
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const res = await request(buildApp(db, { enqueue })).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: validConsent() });
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.businessId).toBe(BIZ);
    expect(call.outreachId).toBe(res.body.outreach_id);
    expect(call.at).toBeInstanceOf(Date);
  });

  it("an idempotent replay (same idempotency_key) enqueues no second task", async () => {
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const app = buildApp(db, { enqueue });
    const body = { phone: PHONE, consent: validConsent(), idempotency_key: "replay-key", data: {} };
    const first = await request(app).post(`/v1/triggers/${RAW_TOKEN}`).send(body);
    const second = await request(app).post(`/v1/triggers/${RAW_TOKEN}`).send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.outreach_id).toBe(first.body.outreach_id);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("an enqueue throw still gives 202 (the outreach exists; the sweep is the backstop), and bumps the registered counter", async () => {
    const db = fakeDb();
    const enqueue = vi.fn(async () => {
      throw new Error("cloud tasks unavailable");
    });
    // "registered" means it is in lib/voice/metrics.js's COUNTER_NAMES and
    // getLatencyStats().turnTaking actually reports it moving -- bumpCounter
    // silently drops any name not in that list, so the before/after delta
    // also proves the registration itself, not just that bumpCounter was
    // called with some string.
    const before = getLatencyStats().turnTaking.outbound_trigger_enqueue_failed || 0;

    const res = await request(buildApp(db, { enqueue })).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: validConsent() });

    expect(res.status).toBe(202);
    expect(res.body.outreach_id).toBeTruthy();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(getLatencyStats().turnTaking.outbound_trigger_enqueue_failed).toBe(before + 1);
  });

  it("with no enqueue configured at all (the local-dev/pre-Task-22 posture), still 202s and does not throw", async () => {
    const db = fakeDb();
    const res = await request(buildApp(db, { enqueue: undefined })).post(`/v1/triggers/${RAW_TOKEN}`).send({ phone: PHONE, consent: validConsent() });
    expect(res.status).toBe(202);
  });

  it.each([
    ["a bad token (401)", () => ({ token: "b".repeat(64), body: { phone: PHONE, consent: validConsent() } })],
    ["a rejected body (422, missing consent)", () => ({ token: RAW_TOKEN, body: { phone: PHONE } })],
  ])("%s enqueues nothing", async (_label, build) => {
    const { token, body } = build();
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const res = await request(buildApp(db, { enqueue })).post(`/v1/triggers/${token}`).send(body);
    expect(res.status).not.toBe(202);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a 429 (rate limited) also enqueues nothing", async () => {
    const db = fakeDb();
    const enqueue = vi.fn(async () => ({ created: true }));
    const app = buildApp(db, { enqueue });
    const token = "h".repeat(64);
    // Every one of these 401s (no campaign has this hash) -- exhausting the
    // bucket without ever reaching the create path.
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      await request(app).post(`/v1/triggers/${token}`).send({ phone: PHONE });
    }
    const res = await request(app).post(`/v1/triggers/${token}`).send({ phone: PHONE });
    expect(res.status).toBe(429);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("isTriggerRoutePath", () => {
  it.each(["/v1/triggers/abc", "/v1/triggers/abc/", "/V1/TRIGGERS/ABC", "/v1/Triggers/AbC123"])("matches %s", (p) => {
    expect(isTriggerRoutePath(p)).toBe(true);
  });
  it.each(["/v1/triggers", "/v1/triggers/", "/v1/triggers/abc/def", "/v1/other", "", null, undefined, 42])("does not match %j", (p) => {
    expect(isTriggerRoutePath(p)).toBe(false);
  });
});

describe("hashTriggerToken", () => {
  it("is a deterministic sha256 hex digest", () => {
    expect(hashTriggerToken("x")).toBe(crypto.createHash("sha256").update("x").digest("hex"));
    expect(hashTriggerToken("x")).toBe(hashTriggerToken("x"));
    expect(hashTriggerToken("x")).not.toBe(hashTriggerToken("y"));
  });
});

describe("compareTokenHash -- the constant-time comparator (sabotage target)", () => {
  it("true for equal strings, false for different ones, and never throws on mismatched lengths", () => {
    expect(compareTokenHash("abc", "abc")).toBe(true);
    expect(compareTokenHash("abc", "abd")).toBe(false);
    expect(() => compareTokenHash("short", "a-much-longer-string-entirely")).not.toThrow();
    expect(compareTokenHash("short", "a-much-longer-string-entirely")).toBe(false);
    expect(compareTokenHash("", "")).toBe(true);
  });

  // Timing-free: this does NOT measure wall-clock time (unsafe to assert on
  // -- flaky by construction). It proves the REAL primitive is used by
  // observing the mocked-but-delegating crypto.timingSafeEqual (see the
  // vi.mock("node:crypto", ...) at the top of this file, which every
  // importer in this file's module graph -- including
  // lib/outbound/triggerRoute.js -- gets) actually gets called, with two
  // fixed-length Buffers. The sabotage (swap for `===`) removes this call
  // entirely, so the mock goes unused and this assertion fails.
  it("actually calls crypto.timingSafeEqual (not string ===)", () => {
    timingSafeEqual.mockClear();
    compareTokenHash("abc", "abc");
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqual.mock.calls[0];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(a).toHaveLength(32); // sha256 digest, fixed length regardless of input
    expect(b).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// Through the REAL server.js app: the 16 KB body limit and the 30/min rate
// limit, both of which depend on the actual middleware stack (Ruling S3-9,
// named risks 2/"the limiter skipped in test").
// ---------------------------------------------------------------------------
const ENV_KEYS = ["BASE_URL", "GEMINI_API_KEY"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let app;

beforeAll(async () => {
  process.env.BASE_URL = "https://trigger-route-mount.example.test";
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";
  vi.resetModules();
  ({ app } = await import("../server.js"));
}, 40000);

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

describe("the trigger route's body limit, through the real server", () => {
  it("a body just over 16 KB gets 413, not the route's own 401/422", async () => {
    const big = { phone: PHONE, padding: "x".repeat(17 * 1024) };
    const res = await request(app).post(`/v1/triggers/${"c".repeat(64)}`).send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload too large" });
  });

  it("a well-formed, small body is NOT swallowed by the global 100kb parser (reaches the route's own 401 for a bad token)", async () => {
    const res = await request(app).post(`/v1/triggers/${"d".repeat(64)}`).send({ phone: PHONE });
    expect(res.status).toBe(401);
  });

  it("a form-encoded (urlencoded) body is left unparsed too -- the route still 401s on the bad token, not a 500", async () => {
    const res = await request(app).post(`/v1/triggers/${"e".repeat(64)}`).type("form").send("phone=%2B447700900600");
    expect(res.status).toBe(401);
  });
});

describe("the trigger route's rate limit, through the real server (must NOT skip under NODE_ENV=test)", () => {
  it(`gives 429 on the ${RATE_LIMIT_MAX + 1}th request within a minute, for one token`, async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const token = "f".repeat(64);
    let last;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      last = await request(app).post(`/v1/triggers/${token}`).send({ phone: PHONE });
      // Every one of the first RATE_LIMIT_MAX requests is refused for the
      // token (401, no campaign has this hash) -- never itself rate limited.
      expect(last.status).toBe(401);
    }
    const res = await request(app).post(`/v1/triggers/${token}`).send({ phone: PHONE });
    expect(res.status).toBe(429);
  });

  it("a DIFFERENT token has its own, unused bucket", async () => {
    const res = await request(app).post(`/v1/triggers/${"g".repeat(64)}`).send({ phone: PHONE });
    expect(res.status).toBe(401); // not 429 -- proves the limiter is keyed by token, not shared/global
  });
});
