// tests/outboundInternalRoutes.test.js
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  registerOutboundInternalRoutes,
  buildOutboundDeps,
  createCallerIdValidator,
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
