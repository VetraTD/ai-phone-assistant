import { describe, it, expect, vi } from "vitest";
import { createAccessTokenVerifier, bearerFromHeader } from "../lib/auth/accessToken.js";

// ---------------------------------------------------------------------------
// The glue between token verification and the automatic-logoff ceiling.
//
// tests/routeAuth.test.js mocks verifyAccessToken wholesale — correctly, it is
// about routes — which left this ordering untested. It is the same property the
// dashboard backend's authMiddleware test pins, tested here separately because
// the two are separate implementations and "the other copy has a test" is how
// duplicated code drifts.
// ---------------------------------------------------------------------------

const IDENTITY = { email: "staff@clinic.test", uid: "kK3nQm2rSTUvWxYz0123456789ab" };

/** A token whose `iat` is `ageSeconds` old. Never signature-checked here. */
function tokenAged(ageSeconds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return `${b64({ alg: "RS256", typ: "JWT", kid: "k" })}.${b64({ iat, sub: "x" })}.sig`;
}

describe("verifyAccessToken glue", () => {
  it("ACCEPTS a fresh, verified token and returns the identity", async () => {
    const verify = createAccessTokenVerifier({ verifyIdToken: async () => IDENTITY });
    expect(await verify(tokenAged(60))).toEqual({ email: IDENTITY.email, uid: IDENTITY.uid });
  });

  it("returns null when the token does not verify", async () => {
    const verify = createAccessTokenVerifier({ verifyIdToken: async () => null });
    expect(await verify(tokenAged(60))).toBeNull();
  });

  it("reports expiredByAge — a DIFFERENT answer from 'not authenticated'", async () => {
    // requireBusinessAccess turns this into a 401 carrying a code the dashboard
    // refreshes and retries on. Collapsing it into null would log a working
    // clinic out mid-sentence.
    const verify = createAccessTokenVerifier({ verifyIdToken: async () => IDENTITY });
    expect(await verify(tokenAged(60 * 60 * 24))).toEqual({ expiredByAge: true });
  });

  it("ages the token AFTER verifying it, never before", async () => {
    // The ordering is the safety property: checkSessionAge reads `iat` off an
    // unverified token. Aging first would make a security decision on
    // attacker-controlled claims, and an old FORGED token would come back as
    // "session expired" — telling the attacker the forgery was otherwise fine.
    const verifyIdToken = vi.fn(async () => null);
    const verify = createAccessTokenVerifier({ verifyIdToken });
    expect(await verify(tokenAged(60 * 60 * 24))).toBeNull();
    expect(verifyIdToken).toHaveBeenCalledOnce();
  });

  it("returns null rather than throwing when the verifier throws", async () => {
    const verify = createAccessTokenVerifier({
      verifyIdToken: async () => {
        throw new Error("boom");
      },
    });
    expect(await verify(tokenAged(60))).toBeNull();
  });

  it("returns null for an empty token without calling the verifier", async () => {
    const verifyIdToken = vi.fn(async () => IDENTITY);
    const verify = createAccessTokenVerifier({ verifyIdToken });
    expect(await verify("")).toBeNull();
    expect(await verify(undefined)).toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

describe("bearerFromHeader", () => {
  it("extracts exactly the token", () => {
    expect(bearerFromHeader("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerFromHeader("bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerFromHeader("  Bearer abc.def.ghi  ")).toBe("abc.def.ghi");
  });

  it("refuses anything that is not exactly `Bearer <token>`", () => {
    for (const h of ["Bearer", "Bearer  ", "Basic abc", "abc", "Bearer a b", "", "  ", undefined, null, 42]) {
      expect(bearerFromHeader(h), String(h)).toBeNull();
    }
  });
});
