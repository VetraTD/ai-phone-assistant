// tests/outboundUrlencodedExclusion.test.js
/**
 * S3-11 (controller ruling, named risk 4): server.js installs one global
 * `express.urlencoded()` ahead of every route except a documented exclusion
 * list. Before this task the two outbound internal routes were NOT on that
 * list, only the JSON parser's list was (tests/outboundInternalRoutesBodyLimit.test.js).
 * A form-encoded POST (Content-Type: application/x-www-form-urlencoded) to
 * either route would be parsed by that global, UNexcluded urlencoded parser
 * -- body-parser then skips re-parsing a request whose stream is already
 * drained, so the route's own `express.json({limit:"4kb"})` (which does not
 * match this Content-Type anyway) never gets a say either. The route only
 * accepts JSON: a form-encoded body reaching it should be untouched by BOTH
 * parsers, not silently absorbed by the wrong one.
 *
 * Named risk 4: "the urlencoded exclusion tested on a bare express app" --
 * tests/outboundInternalRoutes.test.js builds its OWN bare `express()` app,
 * which has no global parser to shadow the route's own, so it cannot see
 * this bug. This file imports the REAL server.js `app` (the
 * tests/outboundDoorServerMount.test.js / tests/outboundInternalRoutesBodyLimit.test.js
 * idiom), with BASE_URL/OUTBOUND_TASKS_QUEUE/OUTBOUND_TASKS_SA set so the
 * routes actually mount.
 *
 * THE DISCRIMINATOR: a small, well-formed, deliberately UNSUPPORTED charset
 * (utf-16 -- body-parser's urlencoded reader accepts only utf-8/iso-8859-1,
 * verified against the installed body-parser's lib/types/urlencoded.js). A
 * body simply present or absent cannot tell "parsed" from "not parsed" apart
 * (an unauthenticated request 401s either way -- authenticate() runs before
 * the route ever reads req.body), and an OVERSIZED body cannot safely stand
 * in for that either: on the fixed path NEITHER parser reads the stream, so
 * a large unconsumed body left sitting in the socket while the server
 * answers 401 almost immediately produces an ECONNRESET race, not a clean
 * HTTP response (found empirically writing this test). A charset error is
 * different in kind: if the (buggy, unexcluded) global urlencoded parser
 * reads this path at all, it throws IN MIDDLEWARE -- before the route, and
 * before its own OIDC check -- and server.js's ONE central error handler
 * (the `app.use((err, req, res, next) => ...)` at the bottom of server.js)
 * always answers any unhandled error 500, regardless of the error's own
 * `.status`. Reaching the route's own 401 instead of that 500 is proof the
 * global parser never touched this request at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

const ENV_KEYS = ["BASE_URL", "OUTBOUND_TASKS_QUEUE", "OUTBOUND_TASKS_SA"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let app;

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

const UNSUPPORTED_CHARSET_TYPE = "application/x-www-form-urlencoded; charset=utf-16";
const SMALL_BODY = "business_id=abc";

describe("the urlencoded parser exclusion, through the real server", () => {
  it("a form-encoded POST to /internal/outbound/dispatch is not parsed (an unsupported charset the global parser would reject never reaches it) and is still OIDC-refused: 401, not 500", async () => {
    const res = await request(app).post("/internal/outbound/dispatch").set("Content-Type", UNSUPPORTED_CHARSET_TYPE).send(SMALL_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("the same unsupported-charset form body on /internal/outbound/sweep is refused by OIDC too, not by a charset error", async () => {
    const res = await request(app).post("/internal/outbound/sweep").set("Content-Type", UNSUPPORTED_CHARSET_TYPE).send(SMALL_BODY);
    expect(res.status).toBe(401);
  });

  it("an ordinary, well-formed form-encoded body is also left unparsed: req.body never reaches the route's own field check, so it 401s on auth (not 400 'invalid body')", async () => {
    const res = await request(app)
      .post("/internal/outbound/dispatch")
      .type("form")
      .send("business_id=11111111-1111-1111-1111-111111111111&outreach_id=22222222-2222-2222-2222-222222222222");
    // Unauthenticated either way, so this alone does not distinguish parsed
    // from unparsed -- it confirms the ordinary case never regresses to
    // something worse than 401 (e.g. a 500 from an edge case the charset
    // tests above do not exercise).
    expect(res.status).toBe(401);
  });

  it("the global urlencoded parser still applies to an ordinary path (the exclusion is scoped, not a blanket removal): the SAME unsupported charset 500s there", async () => {
    // No inbound route both skips auth/DB and echoes urlencoded fields back,
    // so a nonexistent path is the cleanest witness. server.js's central
    // handler answers EVERY unhandled error 500 (not the body-parser's own
    // 415), which is the exact contrast with the two 401s above -- the only
    // difference between this request and the dispatch one is the path.
    const res = await request(app).post("/__no_such_route__").set("Content-Type", UNSUPPORTED_CHARSET_TYPE).send(SMALL_BODY);
    expect(res.status).toBe(500);
  });
});
