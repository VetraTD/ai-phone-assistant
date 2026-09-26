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
  it("refuses a ~6KB dispatch body before auth ever runs: 413, generic body", async () => {
    const res = await request(app)
      .post("/internal/outbound/dispatch")
      .send(padded({ business_id: "11111111-1111-1111-1111-111111111111", outreach_id: "22222222-2222-2222-2222-222222222222" }));
    // No Authorization header was sent. If the body's size were not being
    // policed at all here, it would parse fine under the global 100kb limit
    // and reach the route's own auth check, which would then refuse it for
    // being unauthenticated (401) -- a DIFFERENT reason than the one this
    // test exists to prove. The scoped 4kb parser must reject it first, and
    // (Checkpoint 2a, M5) the route answers 413 itself instead of letting the
    // error reach the central 500 handler and Sentry.
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload too large" });
  });

  it("refuses a ~6KB sweep body the same way", async () => {
    const res = await request(app).post("/internal/outbound/sweep").send(padded({}));
    expect(res.status).toBe(413);
  });

  // Checkpoint 2a, M5. Express routes these paths case-insensitively and with
  // one optional trailing slash, but the global parser's exclusion compared
  // exact strings: `/internal/outbound/dispatch/` got the 100kb parser, the
  // route's 4kb one then saw a drained stream, and an 8 KB body went through.
  it.each([
    "/internal/outbound/dispatch/",
    "/INTERNAL/OUTBOUND/DISPATCH",
    "/Internal/Outbound/Dispatch/",
    "/internal/outbound/sweep/",
    "/INTERNAL/OUTBOUND/SWEEP",
  ])("refuses a ~6KB body on %s (a spelling Express still routes) with 413", async (p) => {
    const res = await request(app).post(p).send(padded({}));
    expect(res.status).toBe(413);
  });

  // X1 (go-live hardening, 2026-09-26): through the REAL stack, a malformed
  // body used to reach server.js's central handler -- 500, and a captureException
  // (Sentry) event -- for what is unauthenticated junk on an internal-only
  // route. Now answered locally, 400, same as the 413 case above.
  it.each(["/internal/outbound/dispatch", "/internal/outbound/sweep"])(
    "refuses malformed JSON on %s with 400, not the central handler (spied via the logger)",
    async (p) => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const res = await request(app).post(p).set("Content-Type", "application/json").send("{not json");
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toMatch(/entity\.parse\.failed|not json/);
        const lines = writeSpy.mock.calls
          .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
          .filter(Boolean);
        // server.js's central handler logs exactly this event before its 500.
        expect(lines.some((l) => l.event === "unhandled_error")).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
    }
  );

  it.each([
    "/internal/outbound/dispatch/",
    "/INTERNAL/OUTBOUND/DISPATCH",
    "/Internal/Outbound/Dispatch/",
    "/internal/outbound/sweep/",
    "/INTERNAL/OUTBOUND/SWEEP",
  ])("refuses malformed JSON on %s (a spelling Express still routes) with 400", async (p) => {
    const res = await request(app).post(p).set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
  });

  // charset=utf-7 is accepted by body-parser's own isValidCharset (it starts
  // with "utf-") and by iconv-lite -- verified locally against the installed
  // body-parser@2.3.0, it is NOT a charset.unsupported case. iso-8859-1 is.
  it.each(["/internal/outbound/dispatch", "/internal/outbound/sweep"])(
    "refuses an unsupported charset on %s with 415, not the central handler",
    async (p) => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const res = await request(app).post(p).set("Content-Type", "application/json; charset=iso-8859-1").send('{"a":1}');
        expect(res.status).toBe(415);
        const lines = writeSpy.mock.calls
          .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
          .filter(Boolean);
        expect(lines.some((l) => l.event === "unhandled_error")).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
    }
  );

  // Fix round 1, Finding 1: body-parser/raw-body wrap a corrupt compressed
  // stream (a claimed Content-Encoding that the bytes don't match) as a
  // typeless 400 (read.js:125 -- `createError(400, error)`, no `.type`
  // property at all). Before this fix, refuseBadBody required a recognized
  // `.type`, so this fell through to the central handler: 500 + Sentry.
  // Verified locally what the error shape actually is: `{ status: 400,
  // statusCode: 400, code: "Z_DATA_ERROR", type: undefined }`.
  it.each(["/internal/outbound/dispatch", "/internal/outbound/sweep"])(
    "refuses a corrupt gzip body on %s with a 4xx, not the central handler (typeless body-parser error, Finding 1)",
    async (p) => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const res = await request(app)
          .post(p)
          .set("Content-Type", "application/json")
          .set("Content-Encoding", "gzip")
          .send(Buffer.from("garbage-not-gzip-bytes"));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(JSON.stringify(res.body)).not.toMatch(/Z_DATA_ERROR|incorrect header check/);
        const lines = writeSpy.mock.calls
          .map(([chunk]) => { try { return JSON.parse(String(chunk)); } catch { return null; } })
          .filter(Boolean);
        expect(lines.some((l) => l.event === "unhandled_error")).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
    }
  );

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
