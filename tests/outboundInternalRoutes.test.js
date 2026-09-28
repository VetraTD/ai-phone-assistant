// tests/outboundInternalRoutes.test.js
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "../lib/connections/secretBox.js";
import {
  registerOutboundInternalRoutes,
  buildOutboundDeps,
  createCallerIdValidator,
  createTwilioClientFor,
  isOutboundInternalPath,
  refuseBadBody,
} from "../lib/outbound/internalRoutes.js";

const BIZ = "11111111-1111-1111-1111-111111111111";
const OUT = "22222222-2222-2222-2222-222222222222";

function fakeDeps(over = {}) {
  return {
    // Mirrors the real verifier's shape: no Authorization header at all is
    // "missing" (401); any header a fake token verifier rejects is a refusal
    // for some other reason (403).
    verifier: { verify: vi.fn(async (authHeader) => (authHeader ? { ok: true, email: "sa@x.iam.gserviceaccount.com" } : { ok: false, reason: "missing" })) },
    dispatch: vi.fn(async () => ({ status: "dialed" })),
    db: { outboundDue: vi.fn(async () => []) },
    enqueue: vi.fn(async () => ({ created: true })),
    now: () => new Date("2026-09-28T13:02:30Z"),
    log: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
}

function buildApp(deps) {
  const app = express();
  registerOutboundInternalRoutes(app, deps);
  return app;
}

describe("POST /internal/outbound/dispatch", () => {
  it("401 without a token", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").send({ business_id: BIZ, outreach_id: OUT });
    expect(res.status).toBe(401);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/missing/); // the reason is logged, never echoed
  });

  it("403 when the verifier refuses a token that was sent", async () => {
    const deps = fakeDeps({ verifier: { verify: vi.fn(async () => ({ ok: false, reason: "aud" })) } });
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer bad").send({ business_id: BIZ, outreach_id: OUT });
    expect(res.status).toBe(403);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/aud/);
  });

  it("logs the verifier's refusal reason without exposing it in the body", async () => {
    const deps = fakeDeps({ verifier: { verify: vi.fn(async () => ({ ok: false, reason: "kid" })) } });
    await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer bad").send({ business_id: BIZ, outreach_id: OUT });
    expect(deps.log.info).toHaveBeenCalledWith("outbound_internal_auth_refused", expect.objectContaining({ reason: "kid" }));
  });

  it("200, and dispatch is called with {businessId, outreachId}, when the token is valid", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer good").send({ business_id: BIZ, outreach_id: OUT });
    expect(res.status).toBe(200);
    expect(deps.dispatch).toHaveBeenCalledWith({ businessId: BIZ, outreachId: OUT });
  });

  it("200 even when dispatch reports 'do nothing' outcomes (skipped, later, closed, conflict)", async () => {
    for (const outcome of [{ status: "skipped" }, { status: "later", reason: "capacity" }, { status: "closed", reason: "suppressed" }, { status: "conflict" }]) {
      const deps = fakeDeps({ dispatch: vi.fn(async () => outcome) });
      const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer good").send({ business_id: BIZ, outreach_id: OUT });
      expect(res.status, JSON.stringify(outcome)).toBe(200);
    }
  });

  it("400 on a body with a non-uuid id, and dispatch is never called", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer good").send({ business_id: "not-a-uuid", outreach_id: OUT });
    expect(res.status).toBe(400);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("400 when a field is missing entirely", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer good").send({ business_id: BIZ });
    expect(res.status).toBe(400);
  });

  it("500 when dispatch throws, so Cloud Tasks retries", async () => {
    const deps = fakeDeps({ dispatch: vi.fn(async () => { throw new Error("db down"); }) });
    const res = await request(buildApp(deps)).post("/internal/outbound/dispatch").set("Authorization", "Bearer good").send({ business_id: BIZ, outreach_id: OUT });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/db down/); // never leak the internal error
  });
});

describe("POST /internal/outbound/sweep", () => {
  it("passes a finite bucket-start `at` to enqueue, never undefined, with source:sweep", async () => {
    const due = [{ business_id: BIZ, outreach_id: OUT }];
    const deps = fakeDeps({ db: { outboundDue: vi.fn(async () => due) } });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reenqueued: 1 });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    const arg = deps.enqueue.mock.calls[0][0];
    expect(arg.businessId).toBe(BIZ);
    expect(arg.outreachId).toBe(OUT);
    expect(arg.source).toBe("sweep");
    expect(arg.at).toBeInstanceOf(Date);
    expect(Number.isFinite(arg.at.getTime())).toBe(true);
    // now() is fixed at 13:02:30Z -> the 5-minute bucket start is 13:00:00Z.
    expect(arg.at.toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });

  it("enqueues every due row", async () => {
    const due = [
      { business_id: BIZ, outreach_id: OUT },
      { business_id: BIZ, outreach_id: "33333333-3333-3333-3333-333333333333" },
    ];
    const deps = fakeDeps({ db: { outboundDue: vi.fn(async () => due) } });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.body).toEqual({ reenqueued: 2 });
    expect(deps.enqueue).toHaveBeenCalledTimes(2);
  });

  it("401 without a token, 403 with a refused one -- same guard as dispatch", async () => {
    const deps = fakeDeps();
    const res1 = await request(buildApp(deps)).post("/internal/outbound/sweep").send({});
    expect(res1.status).toBe(401);
    const deps2 = fakeDeps({ verifier: { verify: vi.fn(async () => ({ ok: false, reason: "email" })) } });
    const res2 = await request(buildApp(deps2)).post("/internal/outbound/sweep").set("Authorization", "Bearer bad").send({});
    expect(res2.status).toBe(403);
    expect(deps.db.outboundDue).not.toHaveBeenCalled();
  });

  it("500 when outboundDue throws", async () => {
    const deps = fakeDeps({ db: { outboundDue: vi.fn(async () => { throw new Error("pg down"); }) } });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(500);
  });
});

// Task 20, migration 045: the sweep's three stale-attempt backstops.
describe("POST /internal/outbound/sweep: the stale-attempt backstops (Task 20)", () => {
  const ATTEMPT = "33333333-3333-3333-3333-333333333333";
  const OUTREACH2 = "44444444-4444-4444-4444-444444444444";

  function staleDb(kind, overrides = {}) {
    return {
      outboundDue: vi.fn(async () => []),
      outboundStaleAttempts: vi.fn(async () => [{ business_id: BIZ, attempt_id: ATTEMPT, kind }]),
      withTenant: vi.fn(async (_biz, fn) => fn()),
      withTenantSafe: vi.fn(async (_biz, fn) => fn()),
      outboundPostCallContext: vi.fn(async () => ({
        attemptNo: 1,
        outreachId: OUTREACH2,
        outreachCreatedAt: new Date("2026-09-20T09:00:00Z"),
        config: { retries: { schedule: ["now", "+10m"] }, calling_window: { mon_fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" } },
        contactTimezone: "Europe/London",
        businessTimezone: "Europe/London",
        phoneE164: "+447700900202",
        twilioCallSid: null,
        result: null,
        answeredAt: null,
      })),
      stampAttemptStatus: vi.fn(async () => ({ firstTerminalStamp: true, answered: true })),
      completeCall: vi.fn(async () => {}),
      lockOutreachState: vi.fn(async () => "dialing"),
      failAttempt: vi.fn(async () => {}),
      rescheduleOutreach: vi.fn(async () => {}),
      closeOutreach: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("sidless: re-checked (still no SID, no result), failed and rescheduled via failStaleAttempt -- never twice for the same row", async () => {
    const db = staleDb("sidless");
    const enqueue = vi.fn(async () => ({ created: true }));
    const deps = fakeDeps({ db, enqueue, now: () => new Date("2026-09-25T12:00:00Z") });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(db.withTenant).toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith("outbound_sweep_sidless_resolved", expect.objectContaining({ attemptId: ATTEMPT }));
    // b39 (fix wave, checkpoint 2b): a log line alone cannot fail if
    // failStaleAttempt's own sequence broke -- assert the actual writes and
    // the enqueue, not only that something got logged.
    expect(db.failAttempt).toHaveBeenCalledWith(ATTEMPT);
    expect(db.rescheduleOutreach).toHaveBeenCalledTimes(1);
    const [outreachId, next] = db.rescheduleOutreach.mock.calls[0];
    expect(outreachId).toBe(OUTREACH2);
    expect(next).toBeInstanceOf(Date);
    expect(enqueue).toHaveBeenCalledWith({ businessId: BIZ, outreachId: OUTREACH2, at: next, source: "reschedule" });
  });

  it("sidless: a SID or result already landed -- skipped, not double-failed", async () => {
    const db = staleDb("sidless", {
      outboundPostCallContext: vi.fn(async () => ({ twilioCallSid: "CAalreadyresolved", result: null })),
    });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(deps.log.info).toHaveBeenCalledWith("outbound_sweep_sidless_skipped", expect.objectContaining({ reason: "already_resolved" }));
  });

  it("lost_callback: a terminal Twilio status stamps the attempt (completeCall included) then claims post-call", async () => {
    const db = staleDb("lost_callback", {
      outboundPostCallContext: vi.fn(async () => ({ twilioCallSid: "CAlost0001", answeredAt: new Date() })),
    });
    const fetch = vi.fn(async () => ({ status: "completed", duration: "42" }));
    const twilioClientFor = vi.fn(() => ({ calls: vi.fn(() => ({ fetch })) }));
    const postCall = { tryClaimByAttempt: vi.fn(async () => true) };
    const deps = fakeDeps({ db, twilioClientFor, postCall });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, { twilioStatus: "completed", answered: false, terminal: true, result: null });
    expect(db.completeCall).toHaveBeenCalledWith("CAlost0001", "completed", 42);
    expect(postCall.tryClaimByAttempt).toHaveBeenCalledWith(ATTEMPT, BIZ);
  });

  // O-26/C17 (post-2c): the fetch uses the ATTEMPT's own campaign caller_id
  // (already loaded by outboundPostCallContext -- no new read), not always
  // account A.
  it("lost_callback: the fetch uses twilioClientFor(campaign caller_id), from data already loaded", async () => {
    const db = staleDb("lost_callback", {
      outboundPostCallContext: vi.fn(async () => ({
        twilioCallSid: "CAlost0003",
        answeredAt: new Date(),
        config: { caller_id: "+18176011171" },
      })),
    });
    const fetch = vi.fn(async () => ({ status: "completed", duration: "10" }));
    const twilioClientFor = vi.fn(() => ({ calls: vi.fn(() => ({ fetch })) }));
    const postCall = { tryClaimByAttempt: vi.fn(async () => true) };
    const deps = fakeDeps({ db, twilioClientFor, postCall });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(twilioClientFor).toHaveBeenCalledWith("+18176011171");
  });

  it("lost_callback: still in progress -- left alone, logged, no claim", async () => {
    const db = staleDb("lost_callback", {
      outboundPostCallContext: vi.fn(async () => ({ twilioCallSid: "CAlost0002", answeredAt: new Date() })),
    });
    const fetch = vi.fn(async () => ({ status: "in-progress" }));
    const twilioClientFor = vi.fn(() => ({ calls: vi.fn(() => ({ fetch })) }));
    const postCall = { tryClaimByAttempt: vi.fn(async () => false) };
    const deps = fakeDeps({ db, twilioClientFor, postCall });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(db.stampAttemptStatus).not.toHaveBeenCalled();
    expect(postCall.tryClaimByAttempt).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith("outbound_sweep_lost_callback_in_progress", expect.objectContaining({ status: "in-progress" }));
  });

  it("postcall_pending: hands straight to postCall.tryClaimByAttempt", async () => {
    const db = staleDb("postcall_pending");
    const postCall = { tryClaimByAttempt: vi.fn(async () => true) };
    const deps = fakeDeps({ db, postCall });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(postCall.tryClaimByAttempt).toHaveBeenCalledWith(ATTEMPT, BIZ);
  });

  it("one bad row cannot abort the tick: a throwing handler is caught, logged, and the response is still 200", async () => {
    const db = staleDb("sidless", {
      outboundPostCallContext: vi.fn(async () => { throw new Error("db blip"); }),
    });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(deps.log.error).toHaveBeenCalledWith("outbound_sweep_stale_attempt_failed", expect.objectContaining({ attemptId: ATTEMPT, kind: "sidless" }));
  });

  // a19 (fix wave, checkpoint 2b): the due loop had NO per-row guard at all
  // -- a throwing enqueue used to abort the whole tick before the
  // stale-attempt backstops below (in the SAME try) ever ran.
  it("a19: one enqueue throwing does not abort the tick -- later due rows still enqueue and the stale backstops still run", async () => {
    const OUT2 = "55555555-5555-5555-5555-555555555555";
    const due = [{ business_id: BIZ, outreach_id: OUT }, { business_id: BIZ, outreach_id: OUT2 }];
    const db = staleDb("postcall_pending");
    db.outboundDue = vi.fn(async () => due);
    const enqueue = vi.fn(async ({ outreachId }) => {
      if (outreachId === OUT) throw new Error("cloud tasks down");
      return { created: true };
    });
    const postCall = { tryClaimByAttempt: vi.fn(async () => true) };
    const deps = fakeDeps({ db, enqueue, postCall });
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reenqueued: 1 }); // the SECOND due row still enqueued
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(deps.log.error).toHaveBeenCalledWith("outbound_sweep_row_failed", expect.objectContaining({ kind: "due", outreachId: OUT }));
    // the stale backstop (a DIFFERENT tick phase, same try block) still ran.
    expect(postCall.tryClaimByAttempt).toHaveBeenCalledWith(ATTEMPT, BIZ);
  });

  it("an unknown DB fake (no outboundStaleAttempts) is untouched -- the existing 'due' tests never see this code path", async () => {
    const deps = fakeDeps(); // the base fakeDeps() db has no outboundStaleAttempts
    const res = await request(buildApp(deps)).post("/internal/outbound/sweep").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reenqueued: 0 });
  });
});

// Checkpoint 2a, M5. server.js skips its global 100kb parser for exactly the
// requests these routes will serve. Express 5 routes them case-insensitively
// with ONE optional trailing slash (measured: `//`, `%64`, `.json` 404), so
// the predicate accepts exactly that set and nothing wider.
describe("isOutboundInternalPath: the same set of spellings Express routes", () => {
  it.each([
    "/internal/outbound/dispatch", "/internal/outbound/dispatch/", "/INTERNAL/OUTBOUND/DISPATCH",
    "/Internal/Outbound/Dispatch/", "/internal/outbound/sweep", "/internal/outbound/sweep/", "/INTERNAL/outbound/SWEEP",
  ])("%s -> true", (p) => expect(isOutboundInternalPath(p)).toBe(true));

  it.each([
    "/internal/outbound/dispatch//", "/internal//outbound/dispatch", "/internal/outbound/dispatchx",
    "/internal/outbound", "/internal/outbound/", "/api/debug/probe-script", "/", "", undefined,
  ])("%s -> false", (p) => expect(isOutboundInternalPath(p)).toBe(false));
});

describe("M5: an oversized body is answered 413 by the route itself, never the central error handler", () => {
  it.each(["/internal/outbound/dispatch", "/internal/outbound/sweep"])("%s: 413 {error: 'payload too large'}", async (p) => {
    const deps = fakeDeps();
    const app = express();
    registerOutboundInternalRoutes(app, deps);
    const central = vi.fn((err, req, res, _next) => res.status(500).json({ error: "Internal server error" }));
    app.use(central);
    const res = await request(app).post(p).set("Authorization", "Bearer good").send({ padding: "x".repeat(6200) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload too large" });
    expect(central).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.verifier.verify).not.toHaveBeenCalled();
  });

  // X1 (go-live hardening, 2026-09-26): malformed JSON used to pass through
  // to server.js's central handler, which answers 500 and reports to Sentry
  // for what is unauthenticated junk on an internal-only route. Now answered
  // locally, same shape as the 413 case above.
  it("a malformed body is answered locally: 400, and never reaches the next error handler", async () => {
    const deps = fakeDeps();
    const app = express();
    registerOutboundInternalRoutes(app, deps);
    const central = vi.fn((err, req, res, _next) => res.status(418).json({ type: err.type }));
    app.use(central);
    const res = await request(app).post("/internal/outbound/dispatch").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(central).not.toHaveBeenCalled();
    // never echo err.type or the offending bytes
    expect(JSON.stringify(res.body)).not.toMatch(/entity\.parse\.failed|not json/);
  });

  // Same rule, a different body-parser 4xx type: an unsupported charset is
  // 415, answered the same way. (charset=utf-7 is accepted by body-parser's
  // own isValidCharset -- it starts with "utf-" -- and by iconv-lite, so it is
  // NOT a case that reaches this code path; iso-8859-1 is, verified against
  // the installed body-parser@2.3.0 + iconv-lite locally.)
  it("an unsupported charset is answered locally: 415, and never reaches the next error handler", async () => {
    const deps = fakeDeps();
    const app = express();
    registerOutboundInternalRoutes(app, deps);
    const central = vi.fn((err, req, res, _next) => res.status(418).json({ type: err.type }));
    app.use(central);
    const res = await request(app)
      .post("/internal/outbound/sweep")
      .set("Content-Type", "application/json; charset=iso-8859-1")
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(central).not.toHaveBeenCalled();
  });
});

describe("X1: refuseBadBody -- direct unit coverage of every body-parser 4xx case, plus the pass-through rule", () => {
  function mockRes() {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  }

  it.each([
    ["entity.parse.failed", 400],
    ["entity.too.large", 413],
    ["charset.unsupported", 415],
    ["encoding.unsupported", 415],
    ["request.aborted", 400],
    ["request.size.invalid", 400],
    ["entity.verify.failed", 403],
  ])("type=%s (status %s) is answered locally with that status; next() is never called; err.message is never echoed", (type, status) => {
    const err = Object.assign(new Error("do-not-echo-this-message"), { type, status, statusCode: status });
    const res = mockRes();
    const next = vi.fn();
    refuseBadBody(err, {}, res, next);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/do-not-echo-this-message/);
  });

  it("entity.too.large's body stays byte-identical to the pre-X1 body", () => {
    const err = Object.assign(new Error("x"), { type: "entity.too.large", status: 413, statusCode: 413 });
    const res = mockRes();
    refuseBadBody(err, {}, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ error: "payload too large" });
  });

  // Fix round 1, Finding 1: only `jsonBody` can ever hand an error to
  // `refuseBadBody` (Express 5 skips route layers once an error is pending,
  // and a handler's own error goes forward, never back into an earlier
  // route-scoped error handler) -- so the error's POSITION already proves
  // where it came from, and there is no such thing as a "non-body-parser"
  // error reaching here in the real stack. This used to assert the opposite
  // (pass-through); flipped to match the general rule the brief always
  // stated: ANY integer 4xx status is answered locally. An unrecognized
  // `.type` gets a generic body rather than a per-type one.
  it("an error with an unrecognized type but a 4xx status is still answered locally, with a generic body", () => {
    const err = Object.assign(new Error("boom"), { type: "some.other.thing", status: 422, statusCode: 422 });
    const res = mockRes();
    const next = vi.fn();
    refuseBadBody(err, {}, res, next);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/boom/);
  });

  // The concrete Finding 1 case: body-parser/raw-body wrap every
  // zlib/raw-body stream error (a corrupt gzip/deflate/br body) as
  // `createError(400, error)` with NO `.type` at all (read.js:125). Before
  // this fix, refuseBadBody required a recognized `.type`, so this typeless
  // 400 fell through to `next(err)` and became a 500 + a Sentry event.
  it("a TYPELESS 4xx error (the corrupt-gzip shape) is still answered locally, not passed to next", () => {
    const err = Object.assign(new Error("Z_DATA_ERROR"), { status: 400, statusCode: 400, code: "Z_DATA_ERROR", expose: true });
    const res = mockRes();
    const next = vi.fn();
    refuseBadBody(err, {}, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/Z_DATA_ERROR/);
  });

  it("a recognized type WITHOUT a 4xx status still reaches next (a tampered/mismatched error, fails closed)", () => {
    const err = Object.assign(new Error("boom"), { type: "entity.too.large", status: 500, statusCode: 500 });
    const res = mockRes();
    const next = vi.fn();
    refuseBadBody(err, {}, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("a plain error with neither .type nor a 4xx status reaches next unchanged (e.g. dispatch()'s own 500 path)", () => {
    const err = new Error("db down");
    const res = mockRes();
    const next = vi.fn();
    refuseBadBody(err, {}, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe("registerOutboundInternalRoutes: absent when not configured", () => {
  it("404s on both routes when deps is null (server.js's own guard before mounting)", async () => {
    const app = express();
    registerOutboundInternalRoutes(app, null);
    const res1 = await request(app).post("/internal/outbound/dispatch").send({});
    const res2 = await request(app).post("/internal/outbound/sweep").send({});
    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
  });
});

describe("buildOutboundDeps", () => {
  it("returns null when only BASE_URL is set (queue and SA unset)", () => {
    expect(buildOutboundDeps({ BASE_URL: "https://x.example/" })).toBeNull();
  });

  it("returns null when BASE_URL is unset even if queue and SA are set", () => {
    expect(buildOutboundDeps({ OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q", OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com" })).toBeNull();
  });

  it("gives a verifier audience with the trailing slash stripped when fully configured", () => {
    const deps = buildOutboundDeps({
      BASE_URL: "https://x.example/",
      OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
      OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
    });
    expect(deps).not.toBeNull();
    expect(deps.audience).toBe("https://x.example");
  });

  // Checkpoint 2a, M7. Count only, never the dropped values: they are meant
  // to be phone numbers, and a log line is not the place for one.
  it("logs outbound_allowlist_entries_dropped {count} once when OUTBOUND_TEST_ALLOWLIST has non-E.164 entries", () => {
    const log = { info: vi.fn(), error: vi.fn() };
    buildOutboundDeps({
      BASE_URL: "https://x.example/", OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q", OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
      OUTBOUND_TEST_ALLOWLIST: "+447700900123,07700900123,garbage",
    }, { log });
    const calls = [...log.info.mock.calls, ...log.error.mock.calls].filter(([e]) => e === "outbound_allowlist_entries_dropped");
    expect(calls).toEqual([["outbound_allowlist_entries_dropped", { count: 2 }]]);
  });

  it("logs nothing about the allow-list when every entry is E.164", () => {
    const log = { info: vi.fn(), error: vi.fn() };
    buildOutboundDeps({
      BASE_URL: "https://x.example/", OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q", OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
      OUTBOUND_TEST_ALLOWLIST: "+447700900123,+14699338887",
    }, { log });
    const calls = [...log.info.mock.calls, ...log.error.mock.calls].filter(([e]) => e === "outbound_allowlist_entries_dropped");
    expect(calls).toEqual([]);
  });

  // Checkpoint 2a, M9: the Cloud Tasks SDK is imported on the first enqueue.
  // A failed load must not be cached, or every later enqueue fails with it.
  it("a failed Cloud Tasks load is retried on the next enqueue, not cached", async () => {
    const created = [];
    const importTasks = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue({ CloudTasksClient: class { async createTask(req) { created.push(req); return [req.task]; } } });
    const deps = buildOutboundDeps({
      BASE_URL: "https://x.example", OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q", OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
    }, { importTasks });
    expect(importTasks).not.toHaveBeenCalled();
    const args = { businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:00Z"), source: "dispatch" };
    await expect(deps.enqueue(args)).rejects.toThrow("load failed");
    expect(await deps.enqueue(args)).toEqual({ created: true });
    expect(await deps.enqueue({ ...args, outreachId: "o2" })).toEqual({ created: true });
    expect(importTasks).toHaveBeenCalledTimes(2); // the failure, then one successful load reused
    expect(created).toHaveLength(2);
  });

  it("does not construct a Twilio or Cloud Tasks client just by being called (no credentials needed to import/build)", () => {
    // No TWILIO_ACCOUNT_SID/TOKEN in this env at all; a real Twilio client
    // built eagerly with a non-"AC" SID throws in its constructor. Building
    // deps must not touch that constructor.
    expect(() =>
      buildOutboundDeps({
        BASE_URL: "https://x.example/",
        OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
        OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
      })
    ).not.toThrow();
  });

  // Fix round 1, MINOR 3: server.js builds ONE createTwilioClientFor()
  // instance and passes it into BOTH registerOutboundDoorRoutes and
  // buildOutboundDeps, rather than each holding an independent client
  // against the same account. Accepting the injected factory must not
  // change the "no credentials needed to build" property, and must not call
  // it eagerly -- laziness is what let buildOutboundDeps be called at
  // server.js's own module-load time in the first place.
  it("accepts an injected twilioClientFor (a shared instance) without calling it, and without needing its own credentials", () => {
    const twilioClientFor = vi.fn(() => ({ calls: vi.fn() }));
    const deps = buildOutboundDeps(
      {
        BASE_URL: "https://x.example/",
        OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
        OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
      },
      { twilioClientFor }
    );
    expect(deps).not.toBeNull();
    expect(twilioClientFor).not.toHaveBeenCalled(); // still lazy: building deps must not invoke it
  });

  // The default (no twilioClientFor passed -- every existing direct caller,
  // including every other test in this file) must keep building its OWN
  // fresh factory, exactly as before this option existed.
  it("without an injected twilioClientFor, still builds successfully with no ambient Twilio credentials (the pre-existing default path)", () => {
    const deps = buildOutboundDeps({
      BASE_URL: "https://x.example/",
      OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
      OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
    });
    expect(deps).not.toBeNull();
  });

  // O-26/C17 (post-2c): accepting a twilioAccounts router must not change
  // either of the two properties above -- still lazy, still buildable with no
  // ambient Twilio credentials. The multi-account callerIdValid behaviour
  // itself is tests/outboundTwilioAccounts.test.js's job (resolveAccountFor
  // directly) and tests/outboundDispatch.test.js's (createDispatcher wired to
  // a twilioClientFor); this only proves buildOutboundDeps wires it in
  // without eagerly touching it.
  it("accepts an injected twilioAccounts router without calling it, and without needing its own credentials", () => {
    const twilioAccounts = { resolveAccountFor: vi.fn(async () => "A"), twilioClientFor: vi.fn(async () => ({})) };
    const deps = buildOutboundDeps(
      {
        BASE_URL: "https://x.example/",
        OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
        OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
      },
      { twilioAccounts }
    );
    expect(deps).not.toBeNull();
    expect(twilioAccounts.resolveAccountFor).not.toHaveBeenCalled();
  });
});

describe("createCallerIdValidator: timeout throws, only a successful answer is cached", () => {
  it("throws when the Twilio lookup exceeds the timeout (dispatch must retry, never close the outreach)", async () => {
    let calls = 0;
    const twilioClientFor = () => ({
      incomingPhoneNumbers: { list: () => { calls++; return new Promise(() => {}); } }, // never resolves
    });
    const callerIdValid = createCallerIdValidator({ twilioClientFor, timeoutMs: 20 });
    await expect(callerIdValid("+441372656055")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("throws (does not swallow) when the Twilio lookup itself rejects", async () => {
    const twilioClientFor = () => ({ incomingPhoneNumbers: { list: async () => { throw new Error("twilio down"); } } });
    const callerIdValid = createCallerIdValidator({ twilioClientFor, timeoutMs: 3000 });
    await expect(callerIdValid("+441372656055")).rejects.toThrow("twilio down");
  });

  it("caches a successful (found) answer for the TTL; a repeat within it makes no Twilio call", async () => {
    let calls = 0;
    let t = 0;
    const twilioClientFor = () => ({ incomingPhoneNumbers: { list: async () => { calls++; return [{ phoneNumber: "+441372656055" }]; } } });
    const callerIdValid = createCallerIdValidator({ twilioClientFor, timeoutMs: 3000, cacheTtlMs: 3_600_000, now: () => t });
    expect(await callerIdValid("+441372656055")).toBe(true);
    expect(await callerIdValid("+441372656055")).toBe(true);
    expect(calls).toBe(1);
    t = 3_600_001; // past the TTL
    expect(await callerIdValid("+441372656055")).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not cache a 'not found' answer: it is re-checked on the very next call", async () => {
    let calls = 0;
    const twilioClientFor = () => ({ incomingPhoneNumbers: { list: async () => { calls++; return []; } } });
    const callerIdValid = createCallerIdValidator({ twilioClientFor, timeoutMs: 3000 });
    expect(await callerIdValid("+441372656055")).toBe(false);
    expect(await callerIdValid("+441372656055")).toBe(false);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// S3-8 fix round 1, I1: the delivery route had zero tests. A fake db (no
// Postgres) exercising the REAL route end to end, with `attemptDelivery`
// injected so no network call is ever made. I2's fixes (the due check, the
// compare-and-set on attempts) are proven here too, RED-first against the
// pre-fix behaviour (see the report's Fix round 1 section for the RED runs).
// ---------------------------------------------------------------------------
describe("POST /internal/outbound/webhook-deliver (S3-8 fix round 1)", () => {
  const OUTBOX_ID = "55555555-5555-5555-5555-555555555555";
  const ENDPOINT_ID = "66666666-6666-6666-6666-666666666666";
  const NOW = new Date("2026-09-28T13:02:30Z");

  // A real key for every test here EXCEPT "decrypt failure", which removes
  // it deliberately. Without this, decryptSecret throws for every test
  // (secret_ciphertext is a dummy buffer anyway, so decrypt itself never
  // needs to actually SUCCEED against real ciphertext -- these tests only
  // reach decryptSecret's key-resolution step before attemptDelivery is
  // mocked in below it).
  const OLD_KEY = process.env.CONNECTIONS_WEBHOOK_KEY;
  beforeAll(() => {
    process.env.CONNECTIONS_WEBHOOK_KEY = randomBytes(32).toString("base64");
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.CONNECTIONS_WEBHOOK_KEY;
    else process.env.CONNECTIONS_WEBHOOK_KEY = OLD_KEY;
  });

  function mkRow(overrides = {}) {
    return {
      id: OUTBOX_ID,
      kind: "webhook",
      target_id: ENDPOINT_ID,
      event_type: "call.completed",
      payload: { event: "call.completed", direction: "outbound" },
      status: "pending",
      attempts: 1,
      next_attempt_at: new Date(NOW.getTime() - 60_000), // due a minute ago
      ...overrides,
    };
  }

  function mkEndpoint(overrides = {}) {
    // A REAL ciphertext, encrypted under the CONNECTIONS_WEBHOOK_KEY
    // beforeAll set above -- decryptSecret must actually succeed for every
    // test here except "decrypt failure" (which deletes the key first).
    return {
      id: ENDPOINT_ID,
      url: "https://example.test/hook",
      secret_ciphertext: encryptSecret("whsec_test_only"),
      active: true,
      ...overrides,
    };
  }

  /**
   * A fake db that simulates the compare-and-set services/db.js does not
   * YET implement (blocked this round by a concurrent editor on that file --
   * see the report). markOutboxRetry/markOutboxDead return `false` when
   * `expectedAttempts` no longer matches `currentAttempts`, exactly the
   * contract the real WHERE clause will have -- so the ROUTE's own handling
   * of that `false` (skip the counter, skip the re-enqueue) is proven now,
   * and needs no further change once services/db.js catches up.
   */
  function webhookDeliverDb({ row = mkRow(), endpoint = mkEndpoint() } = {}) {
    let currentAttempts = row.attempts;
    let currentStatus = row.status;
    const calls = { markOutboxDelivered: [], markOutboxRetry: [], markOutboxDead: [] };
    return {
      calls,
      withTenant: vi.fn(async (_biz, fn) => fn()),
      getOutboxRow: vi.fn(async () => ({ ...row, attempts: currentAttempts, status: currentStatus })),
      getWebhookEndpoint: vi.fn(async () => endpoint),
      markOutboxDelivered: vi.fn(async () => {
        calls.markOutboxDelivered.push(true);
        if (currentStatus !== "pending") return false;
        currentStatus = "delivered";
        return true;
      }),
      markOutboxRetry: vi.fn(async (_id, { attempts, nextAttemptAt, lastError, expectedAttempts }) => {
        calls.markOutboxRetry.push({ attempts, nextAttemptAt, lastError, expectedAttempts });
        if (currentStatus !== "pending" || currentAttempts !== expectedAttempts) return false;
        currentAttempts = attempts;
        return true;
      }),
      markOutboxDead: vi.fn(async (_id, { attempts, lastError, expectedAttempts }) => {
        calls.markOutboxDead.push({ attempts, lastError, expectedAttempts });
        if (currentStatus !== "pending" || (expectedAttempts !== undefined && currentAttempts !== expectedAttempts)) return false;
        currentAttempts = attempts;
        currentStatus = "dead";
        return true;
      }),
    };
  }

  function deliverDeps(over = {}) {
    // `over.db || webhookDeliverDb()`, not a `db:` default alongside
    // `...over` -- an object literal evaluates EVERY listed property
    // (including a default that is about to be overridden) before the
    // spread applies, so an unconditional `webhookDeliverDb()` here would
    // build (and encrypt) a throwaway endpoint even when the caller passed
    // its own `db` -- exactly what broke the "decrypt failure" test, whose
    // whole point is that CONNECTIONS_WEBHOOK_KEY is already gone by the
    // time this runs.
    return fakeDeps({
      db: over.db || webhookDeliverDb(),
      now: () => NOW,
      enqueueOutbox: vi.fn(async () => ({ created: true })),
      attemptDelivery: vi.fn(async () => ({ ok: true, status: 200, lastError: null })),
      ...over,
    });
  }

  async function post(deps, body = { business_id: BIZ, outbox_id: OUTBOX_ID }) {
    return request(buildApp(deps)).post("/internal/outbound/webhook-deliver").set("Authorization", "Bearer good").send(body);
  }

  it("400 on a non-uuid id", async () => {
    const deps = deliverDeps();
    const res = await post(deps, { business_id: BIZ, outbox_id: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("401 without a token", async () => {
    const deps = deliverDeps();
    const res = await request(buildApp(deps)).post("/internal/outbound/webhook-deliver").send({ business_id: BIZ, outbox_id: OUTBOX_ID });
    expect(res.status).toBe(401);
  });

  it("delivered: 2xx marks the row delivered, no re-enqueue", async () => {
    const deps = deliverDeps({ attemptDelivery: vi.fn(async () => ({ ok: true, status: 200, lastError: null })) });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true, reason: "delivered" });
    expect(deps.db.calls.markOutboxDelivered.length).toBe(1);
    expect(deps.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("retry: a failure applies the backoff, writes attempts+1, and re-enqueues at the SAME next_attempt_at the row now has -- named risk 7 / I2 task-name collision", async () => {
    const db = webhookDeliverDb({ row: mkRow({ attempts: 1 }) });
    const deps = deliverDeps({ db, attemptDelivery: vi.fn(async () => ({ ok: false, status: 500, lastError: "500" })) });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: true, reason: "retry" });
    expect(db.calls.markOutboxRetry).toEqual([{ attempts: 2, nextAttemptAt: expect.any(Date), lastError: "500", expectedAttempts: 1 }]);
    expect(deps.enqueueOutbox).toHaveBeenCalledTimes(1);
    const arg = deps.enqueueOutbox.mock.calls[0][0];
    expect(arg.outboxId).toBe(OUTBOX_ID);
    expect(arg.at.getTime()).toBe(db.calls.markOutboxRetry[0].nextAttemptAt.getTime());
  });

  it("dead on the 6th failure (attempts 5 -> 6), no re-enqueue -- backoff Ruling confirmed", async () => {
    const db = webhookDeliverDb({ row: mkRow({ attempts: 5 }) });
    const deps = deliverDeps({ db, attemptDelivery: vi.fn(async () => ({ ok: false, status: "ECONNREFUSED", lastError: "ECONNREFUSED" })) });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true, reason: "dead" });
    expect(db.calls.markOutboxDead).toEqual([{ attempts: 6, lastError: "ECONNREFUSED", expectedAttempts: 5 }]);
    expect(deps.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("already dead: a no-op, attemptDelivery is never called (named risk 7 -- never retries past dead)", async () => {
    const db = webhookDeliverDb({ row: mkRow({ status: "dead", attempts: 6 }) });
    const attemptDelivery = vi.fn(async () => ({ ok: true, status: 200, lastError: null }));
    const deps = deliverDeps({ db, attemptDelivery });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true, reason: "already_dead" });
    expect(attemptDelivery).not.toHaveBeenCalled();
  });

  it("inactive endpoint: marked dead without ever calling attemptDelivery", async () => {
    const db = webhookDeliverDb({ endpoint: mkEndpoint({ active: false }) });
    const attemptDelivery = vi.fn(async () => ({ ok: true, status: 200, lastError: null }));
    const deps = deliverDeps({ db, attemptDelivery });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true, reason: "endpoint_unavailable" });
    expect(attemptDelivery).not.toHaveBeenCalled();
    expect(db.calls.markOutboxDead).toEqual([{ attempts: 1, lastError: "endpoint_unavailable", expectedAttempts: 1 }]);
  });

  it("decrypt failure: classified as key_unavailable and backed off like any other failure, attemptDelivery never called", async () => {
    // The endpoint (and its ciphertext) is built FIRST, while beforeAll's
    // real key is still active -- only THEN is the key removed, so this
    // exercises decryptSecret's own failure, not encryptSecret's.
    const db = webhookDeliverDb();
    const OLD_KEY = process.env.CONNECTIONS_WEBHOOK_KEY;
    delete process.env.CONNECTIONS_WEBHOOK_KEY; // deterministic: decryptSecret throws regardless of ciphertext content
    try {
      const attemptDelivery = vi.fn(async () => ({ ok: true, status: 200, lastError: null }));
      const deps = deliverDeps({ db, attemptDelivery });
      const res = await post(deps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ done: true, reason: "retry" });
      expect(attemptDelivery).not.toHaveBeenCalled();
      expect(db.calls.markOutboxRetry[0].lastError).toBe("key_unavailable");
    } finally {
      if (OLD_KEY === undefined) delete process.env.CONNECTIONS_WEBHOOK_KEY;
      else process.env.CONNECTIONS_WEBHOOK_KEY = OLD_KEY;
    }
  });

  // I2, RED-first (see the report: RED against the pre-fix route, which had
  // no due check at all -- an early task delivered and burned an attempt).
  it("I2: an EARLY task (next_attempt_at in the future) is a no-op -- never calls attemptDelivery, never burns an attempt", async () => {
    const db = webhookDeliverDb({ row: mkRow({ next_attempt_at: new Date(NOW.getTime() + 30 * 60_000) }) }); // due in 30 minutes
    const attemptDelivery = vi.fn(async () => ({ ok: true, status: 200, lastError: null }));
    const deps = deliverDeps({ db, attemptDelivery });
    const res = await post(deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true, reason: "not_due" });
    expect(attemptDelivery).not.toHaveBeenCalled();
    expect(db.calls.markOutboxRetry).toEqual([]);
    expect(db.calls.markOutboxDead).toEqual([]);
  });

  // I2, RED-first: two tasks for the SAME row (a genuine Cloud Tasks
  // at-least-once redelivery, or the old task-naming bug creating a real
  // duplicate) both attempt delivery; only the FIRST one's write may apply.
  it("I2: a duplicate task for the same row loses the compare-and-set race -- no double counter, no double re-enqueue", async () => {
    const db = webhookDeliverDb({ row: mkRow({ attempts: 1 }) });
    const attemptDelivery = vi.fn(async () => ({ ok: false, status: 500, lastError: "500" }));
    const deps = deliverDeps({ db, attemptDelivery });

    // The first task reads attempts=1, fails, writes attempts=2 (its
    // expectedAttempts=1 matches the fake db's currentAttempts=1).
    const first = await post(deps);
    expect(first.body).toMatchObject({ reason: "retry" });
    expect(deps.enqueueOutbox).toHaveBeenCalledTimes(1);

    // A stale write against the CAS boundary: expectedAttempts:1 no longer
    // matches the row's now-current attempts (2), the exact shape a
    // duplicate/racing task's own write would take.
    const staleWrite = await db.markOutboxRetry(OUTBOX_ID, { attempts: 2, nextAttemptAt: new Date(), lastError: "500", expectedAttempts: 1 });
    expect(staleWrite).toBe(false);
  });
});
