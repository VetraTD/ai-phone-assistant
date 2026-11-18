import { describe, it, expect, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createAuthenticate } = require("../middleware/authMiddleware.js");
const { SESSION_MAX_AGE_CODE } = require("../middleware/sessionAge.js");

// ---------------------------------------------------------------------------
// The real authenticate middleware.
//
// It had NO test at all, and the reason is instructive rather than careless:
// harness.js injects a fake authMiddleware into require.cache before loading
// server.js, so every route test runs against a stub. All 99 of them would pass
// with this middleware returning 200 for everybody. The suite was green about
// routes and silent about the door.
//
// The verifier is injected. What is exercised here is everything AROUND it —
// header parsing, the 503-vs-401 distinction, the session-age ordering, and the
// shape handed to the routes downstream. The verifier itself is forged at every
// claim in the root's tests/idToken.test.js, which runs the same battery
// against this backend's copy too.
// ---------------------------------------------------------------------------

const IDENTITY = { email: "owner@example.com", uid: "kK3nQm2rSTUvWxYz0123456789ab" };

/** A token whose `iat` is `ageSeconds` old. Never verified here — only aged. */
function tokenAged(ageSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return `${b64({ alg: "RS256", typ: "JWT", kid: "k" })}.${b64({ iat, sub: "x" })}.sig`;
}

function res() {
  const r = { statusCode: null, body: null };
  r.status = (code) => {
    r.statusCode = code;
    return r;
  };
  r.json = (payload) => {
    r.body = payload;
    return r;
  };
  return r;
}

async function run(middleware, authorization, token) {
  const req = { headers: authorization ? { authorization } : {} };
  const response = res();
  const next = vi.fn();
  await middleware(req, response, next);
  return { req, response, next, token };
}

describe("authenticate", () => {
  const accepting = createAuthenticate({ verify: async () => IDENTITY });
  const rejecting = createAuthenticate({ verify: async () => null });

  it("ACCEPTS a valid token and calls next()", async () => {
    // The only assertion that separates "correctly refuses bad input" from
    // "refuses everything". Every rejection below is meaningless without it.
    const { req, next, response } = await run(accepting, `Bearer ${tokenAged(60)}`);
    expect(next).toHaveBeenCalledOnce();
    expect(response.statusCode).toBeNull();
    expect(req.authUser).toEqual({ id: IDENTITY.uid, email: IDENTITY.email });
  });

  it("puts the identity where every route downstream reads it", async () => {
    // getBusinessIdForUser reads `.email`; the PHI audit trail records `.id`.
    // A middleware that authenticated correctly and populated the wrong field
    // would 403 every request from a valid session.
    const { req } = await run(accepting, `Bearer ${tokenAged(60)}`);
    expect(typeof req.authUser.email).toBe("string");
    expect(typeof req.authUser.id).toBe("string");
  });

  it("401s with no authorization header", async () => {
    const { response, next } = await run(accepting, undefined);
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("REFUSES A MALFORMED HEADER WITHOUT CALLING THE VERIFIER", async () => {
    // The status code alone proves nothing here, and finding that out cost a
    // sabotage: restoring the old `authHeader.split(" ")[1]` left all eleven
    // tests green. `Basic abc` became the token "abc", `Bearer` became
    // undefined, both reached the verifier, and both then came back 401 — from
    // the SESSION-AGE branch, because a non-JWT has no `iat`. Right answer,
    // wrong mechanism, and the next change to the age ceiling would have
    // silently turned these into 200s.
    //
    // So assert what only a real parser can do: never hand the verifier
    // anything, and reject with the parser's own error rather than the
    // ceiling's code.
    for (const header of ["Bearer", "Bearer  ", "Basic abc", "abc", "Bearer a b", "  "]) {
      const verify = vi.fn(async () => IDENTITY);
      const middleware = createAuthenticate({ verify });
      const { response, next } = await run(middleware, header);

      const where = `header ${JSON.stringify(header)}`;
      expect(verify, where).not.toHaveBeenCalled();
      expect(response.statusCode, where).toBe(401);
      expect(response.body.code, where).toBeUndefined();
      expect(next, where).not.toHaveBeenCalled();
    }
  });

  it("passes the verifier the token and NOTHING else", async () => {
    // `Bearer <token>` must yield exactly `<token>`. A parser that handed over
    // the whole header, or the scheme, would still 401 — via the age branch
    // again — while corrupting what a working token means.
    const token = tokenAged(60);
    const verify = vi.fn(async () => IDENTITY);
    await run(createAuthenticate({ verify }), `Bearer ${token}`);
    expect(verify).toHaveBeenCalledWith(token);
  });

  it("accepts `bearer` in any case, which is what the RFC says", async () => {
    const { next } = await run(accepting, `bearer ${tokenAged(60)}`);
    expect(next).toHaveBeenCalledOnce();
  });

  it("401s when the verifier refuses", async () => {
    const { response, next } = await run(rejecting, `Bearer ${tokenAged(60)}`);
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("503s — not 401 — when the server has no auth configured", async () => {
    // A misconfigured server is not a rejected credential. 401 here would send a
    // whole clinic hunting for passwords that are fine.
    const unconfigured = createAuthenticate({ verify: null });
    const { response, next } = await run(unconfigured, `Bearer ${tokenAged(60)}`);
    expect(response.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("503s before reading the header at all", async () => {
    // Ordering: an unconfigured server must answer the same way whether or not
    // a token was sent, or the response distinguishes valid tokens from invalid
    // ones on a server that cannot check either.
    const unconfigured = createAuthenticate({ verify: null });
    expect((await run(unconfigured, undefined)).response.statusCode).toBe(503);
  });

  it("sends the session-age code the dashboard retries on, not a bare 401", async () => {
    // frontend/src/authRetry.js refreshes once and retries on exactly this
    // code. Without it the ceiling is indistinguishable from a real sign-out
    // and logs a working clinic out mid-sentence.
    const { response, next } = await run(accepting, `Bearer ${tokenAged(60 * 60 * 24)}`);
    expect(response.statusCode).toBe(401);
    expect(response.body.code).toBe(SESSION_MAX_AGE_CODE);
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT send that code for an ordinary rejection", async () => {
    // If every 401 carried it, the dashboard would refresh-and-retry against a
    // genuinely dead session forever.
    const { response } = await run(rejecting, `Bearer ${tokenAged(60)}`);
    expect(response.body.code).toBeUndefined();
  });

  it("checks the age AFTER verification, never before", async () => {
    // The ordering is the safety property: checkSessionAge reads `iat` off an
    // unverified token. A middleware that aged first would be making a security
    // decision on attacker-controlled claims — and an old FORGED token would
    // come back as "session expired", telling the attacker their forgery was
    // otherwise fine.
    const calls = [];
    const ordered = createAuthenticate({
      verify: async () => {
        calls.push("verify");
        return null;
      },
    });
    const { response } = await run(ordered, `Bearer ${tokenAged(60 * 60 * 24)}`);
    expect(calls).toEqual(["verify"]);
    expect(response.body.code).toBeUndefined();
    expect(response.body.error).toBe("Invalid token");
  });
});
