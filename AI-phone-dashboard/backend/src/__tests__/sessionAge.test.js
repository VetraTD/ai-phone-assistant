import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { checkSessionAge, sessionMaxAgeMinutes, issuedAtSeconds, SESSION_MAX_AGE_CODE } = require("../middleware/sessionAge.js");

// §164.312(a)(2)(iii), this backend's copy.
//
// It is a deliberate duplicate of lib/auth/sessionAge.js in the repo root —
// this backend is CommonJS and that module is ESM — so it is tested to the same
// behaviour rather than assumed to have it. tests/sessionAge.test.js in the
// root additionally pins the two to agree on the constants, because a silently
// diverging copy is exactly the drift D1 exists to catch.

function tokenWith(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const nowSeconds = Math.floor(NOW_MS / 1000);
const env = { SESSION_MAX_AGE_MINUTES: "30" };

describe("dashboard session-age ceiling", () => {
  it("defaults to 30 minutes", () => {
    expect(sessionMaxAgeMinutes({})).toBe(30);
  });

  it("treats 0 as off and nonsense as the default", () => {
    expect(sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: "0" })).toBe(0);
    expect(sessionMaxAgeMinutes({ SESSION_MAX_AGE_MINUTES: "1.5.2" })).toBe(30);
  });

  it("reads iat, including through base64url characters", () => {
    expect(issuedAtSeconds(tokenWith({ iat: 42, sub: "a+b/c?=~~~" }))).toBe(42);
    expect(issuedAtSeconds("not-a-jwt")).toBeNull();
  });

  it("accepts a fresh token and rejects one past the ceiling", () => {
    expect(checkSessionAge(tokenWith({ iat: nowSeconds }), { now, env }).expired).toBe(false);
    expect(checkSessionAge(tokenWith({ iat: nowSeconds - 31 * 60 }), { now, env }).expired).toBe(true);
  });

  it("refuses a token whose age cannot be measured", () => {
    expect(checkSessionAge(tokenWith({ sub: "u1" }), { now, env }).expired).toBe(true);
  });

  it("tolerates clock skew", () => {
    expect(checkSessionAge(tokenWith({ iat: nowSeconds + 120 }), { now, env }).expired).toBe(false);
  });

  it("publishes the code the frontend keys its refresh-and-retry on", () => {
    expect(SESSION_MAX_AGE_CODE).toBe("session_max_age");
  });
});
