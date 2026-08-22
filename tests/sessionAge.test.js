import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { checkSessionAge, issuedAtSeconds, sessionMaxAgeMinutes, SESSION_MAX_AGE_CODE } from "../lib/auth/sessionAge.js";

// §164.312(a)(2)(iii), the server-side half. See lib/auth/sessionAge.js for what
// this bounds and — just as important — what it does not.

/** A JWT-shaped string with the given payload. Signature is never checked here. */
function tokenWith(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const nowSeconds = Math.floor(NOW_MS / 1000);

describe("reading the issued-at claim", () => {
  it("reads iat from a well-formed token", () => {
    expect(issuedAtSeconds(tokenWith({ iat: 12345 }))).toBe(12345);
  });

  it("handles base64url padding characters", () => {
    // A payload containing characters that force - and _ in base64url. A naive
    // atob would decode this to mojibake and lose the claim silently.
    const t = tokenWith({ iat: 999, email: "a+b/c?=@example.com", sub: "~~~???" });
    expect(issuedAtSeconds(t)).toBe(999);
  });

  it("returns null for anything that is not a JWT", () => {
    for (const junk of ["", null, undefined, "abc", "a.b", "a.b.c.d", "a.!!!.c"]) {
      expect(issuedAtSeconds(junk)).toBeNull();
    }
  });
});

describe("the ceiling", () => {
  it("defaults to 30 minutes", () => {
    expect(sessionMaxAgeMinutes({})).toBe(30);
  });

  it("is configurable", () => {
    expect(sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: "15" })).toBe(15);
  });

  it("treats 0 as off", () => {
    expect(sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: "0" })).toBe(0);
  });

  it("falls back to the default rather than disabling itself on nonsense", () => {
    // A typo must not silently turn a security control off. "off" has to be
    // spelled 0.
    for (const bad of ["abc", "-5", "1.5.2", " "]) {
      expect(sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: bad })).toBe(30);
    }
  });
});

describe("checkSessionAge", () => {
  const env = { SESSION_MAX_AGE_MINUTES: "30" };

  it("accepts a freshly issued token", () => {
    const res = checkSessionAge(tokenWith({ iat: nowSeconds }), { now, env });
    expect(res.expired).toBe(false);
    expect(res.ageSeconds).toBe(0);
  });

  it("accepts a token just inside the ceiling", () => {
    const res = checkSessionAge(tokenWith({ iat: nowSeconds - 30 * 60 }), { now, env });
    expect(res.expired).toBe(false);
  });

  it("rejects a token past the ceiling", () => {
    const res = checkSessionAge(tokenWith({ iat: nowSeconds - 31 * 60 }), { now, env });
    expect(res.expired).toBe(true);
    expect(res.ageSeconds).toBe(31 * 60);
  });

  it("refuses a token whose age cannot be measured", () => {
    // No iat. Defaulting an unmeasurable token to "fine" would let anyone who
    // can influence claim contents opt out of the control by omission.
    const res = checkSessionAge(tokenWith({ sub: "u1" }), { now, env });
    expect(res.expired).toBe(true);
  });

  it("does not refuse an unmeasurable token when the ceiling is off", () => {
    const res = checkSessionAge(tokenWith({ sub: "u1" }), { now, env: { SESSION_MAX_AGE_MINUTES: "0" } });
    expect(res.expired).toBe(false);
  });

  it("tolerates clock skew rather than rejecting every request", () => {
    // An auth backend running slightly fast issues a token with an iat in the
    // future. That is skew, not an old token, and treating it as expired would
    // break every login against a clock nobody controls.
    const res = checkSessionAge(tokenWith({ iat: nowSeconds + 120 }), { now, env });
    expect(res.expired).toBe(false);
  });

  it("is off when the ceiling is 0, however old the token", () => {
    const res = checkSessionAge(tokenWith({ iat: nowSeconds - 10 * 24 * 3600 }), {
      now,
      env: { SESSION_MAX_AGE_MINUTES: "0" },
    });
    expect(res.expired).toBe(false);
  });

  it("publishes a stable code for the client to key its retry on", () => {
    // The frontend refreshes and retries exactly on this code. If it drifts, the
    // dashboard stops recovering and starts logging people out mid-sentence.
    expect(SESSION_MAX_AGE_CODE).toBe("session_max_age");
  });
});

describe("the dashboard's copy of this does the same thing", () => {
  // The dashboard backend is CommonJS and cannot import this ESM module, so it
  // carries a deliberate duplicate. A duplicate nobody compares is how two
  // servers end up disagreeing about a security control — the same class of
  // silent drift as the CORS_ORIGIN / CORS_ORIGINS split A9 found, and the
  // reason D1 exists.
  const require = createRequire(import.meta.url);
  const dash = require("../AI-phone-dashboard/backend/src/middleware/sessionAge.js");

  it("agrees on the code the client keys its retry on", () => {
    expect(dash.SESSION_MAX_AGE_CODE).toBe(SESSION_MAX_AGE_CODE);
  });

  it("agrees on the default ceiling", () => {
    expect(dash.sessionMaxAgeMinutes({})).toBe(sessionMaxAgeMinutes({}));
  });

  it("agrees on every interesting age decision", () => {
    const cases = [
      { iat: nowSeconds },
      { iat: nowSeconds - 30 * 60 },
      { iat: nowSeconds - 31 * 60 },
      { iat: nowSeconds + 120 },
      { sub: "no-iat" },
    ];
    for (const payload of cases) {
      const token = tokenWith(payload);
      for (const env of [{ SESSION_MAX_AGE_MINUTES: "30" }, { SESSION_MAX_AGE_MINUTES: "0" }, {}]) {
        expect(dash.checkSessionAge(token, { now, env }).expired, JSON.stringify({ payload, env })).toBe(
          checkSessionAge(token, { now, env }).expired
        );
      }
    }
  });

  it("agrees on how it parses a nonsense value", () => {
    for (const bad of ["abc", "-5", "1.5.2", " "]) {
      expect(dash.sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: bad })).toBe(
        sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: bad })
      );
    }
  });
});
