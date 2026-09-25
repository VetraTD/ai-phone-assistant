// tests/outboundInternalRoutesBodyLimit.test.js
/**
 * Review finding (Task 10, fix round 1): the outbound internal routes' own
 * `express.json({limit:"4kb"})` was dead code against the REAL server.
 * server.js installs one global `express.json()` (100kb) ahead of every
 * route except a documented exclusion list; body-parser skips re-parsing a
 * request whose body stream is already drained, so the global (100kb)
 * parser wins and the route-scoped 4kb limit never runs. A bare `express()`
 * app (as in tests/outboundInternalRoutes.test.js) cannot see this bug,
 * because it has no global parser to shadow the scoped one.
 *
 * This file imports the REAL server.js (with BASE_URL, OUTBOUND_TASKS_QUEUE
 * and OUTBOUND_TASKS_SA set so the routes actually mount) and proves the
 * 4kb limit is enforced through that real stack, plus that the exclusion is
 * scoped -- ordinary paths still get the global parser's 100kb.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

const ENV_KEYS = ["BASE_URL", "OUTBOUND_TASKS_QUEUE", "OUTBOUND_TASKS_SA"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let app;

// Cold-importing server.js pulls the whole app graph; see the note in
// tests/phone-numbers-api.test.js. vi.resetModules() first, so this file's
// env is what buildOutboundDeps() actually reads (another test file may have
// already cached a server.js module instance with different/absent env).
beforeAll(async () => {
  process.env.BASE_URL = "https://svc.example";
  process.env.OUTBOUND_TASKS_QUEUE = "projects/p/locations/l/queues/q";
  process.env.OUTBOUND_TASKS_SA = "sa@x.iam.gserviceaccount.com";
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

// Comfortably over the 4kb route limit, comfortably under the global 100kb
// default -- the only zone that distinguishes "the scoped limit ran" from
// "the global parser swallowed it and forwarded to the handler".
const padded = (obj) => ({ ...obj, padding: "x".repeat(6200) });

describe("the outbound internal routes' 4kb body limit, through the real server", () => {
  it("refuses a ~6KB dispatch body before auth ever runs (never 200, never the unauthenticated 401)", async () => {
    const res = await request(app)
      .post("/internal/outbound/dispatch")
      .send(padded({ business_id: "11111111-1111-1111-1111-111111111111", outreach_id: "22222222-2222-2222-2222-222222222222" }));
    // No Authorization header was sent. If the body's size were not being
    // policed at all here, it would parse fine under the global 100kb limit
    // and reach the route's own auth check, which would then refuse it for
    // being unauthenticated (401) -- a DIFFERENT reason than the one this
    // test exists to prove. The scoped 4kb parser must reject it first.
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(401);
  });

  it("refuses a ~6KB sweep body the same way", async () => {
    const res = await request(app).post("/internal/outbound/sweep").send(padded({}));
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(401);
  });

  it("the global parser still accepts a 6KB body on an ordinary path (the exclusion is scoped, not a blanket shrink)", async () => {
    // No inbound route both skips auth/DB and echoes the body back, so a
    // nonexistent path is the cleanest witness available: if the global
    // parser were somehow shrunk everywhere, a 6KB body would 413 before
    // Express's router even gets to decide "no such route". Parsing fine and
    // falling through to an ordinary 404 proves the 100kb default still
    // applies to everything outside the two excluded paths.
    const res = await request(app).post("/__no_such_route__").send(padded({}));
    expect(res.status).toBe(404);
  });
});
