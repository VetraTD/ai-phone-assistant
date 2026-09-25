/**
 * Verify a Google-signed OIDC ID token (Cloud Tasks / Cloud Scheduler
 * calling /internal/outbound/*). Correction C4: lib/auth/idToken.js is the
 * Identity Platform verifier and is hard-wired to securetoken issuers and
 * auth_time; this is its sibling on the same libraries, same RS256-only rule.
 * Default imports, as tests/idToken.test.js enforces for those packages.
 */
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

export function createGoogleOidcVerifier({ audience, allowedEmails, getPublicKey, now = () => Date.now() }) {
  if (!audience) throw new Error("googleOidc: audience is required");
  // M2: lib/outbound/tasks.js builds the OIDC token's own audience as
  // `serviceUrl.replace(/\/$/, "")`; normalise the configured audience the
  // same way, once, so a trailing slash on either side of the config can
  // never turn a legitimate token into a wrong-audience 403.
  const expectedAudience = String(audience).replace(/\/$/, "");
  const allowed = new Set(allowedEmails || []);
  const client = getPublicKey ? null : jwksRsa({ jwksUri: JWKS_URI, cache: true, cacheMaxAge: 3_600_000, rateLimit: true, jwksRequestsPerMinute: 10 });
  const keyFor = getPublicKey || (async (kid) => (await client.getSigningKey(kid)).getPublicKey());

  return {
    async verify(authHeader) {
      const m = /^Bearer\s+(.+)$/.exec(authHeader || "");
      if (!m) return { ok: false, reason: "missing" };
      const decoded = jwt.decode(m[1], { complete: true });
      if (!decoded || decoded.header?.alg !== "RS256") return { ok: false, reason: "alg" };
      // M1: mirror lib/auth/idToken.js:132 -- a token with no kid names no key
      // to verify against, so it must be refused here rather than falling
      // through to a keyFor call that a permissive lookup could satisfy anyway.
      if (typeof decoded.header.kid !== "string" || !decoded.header.kid) return { ok: false, reason: "kid" };
      try {
        const key = await keyFor(decoded.header.kid);
        const claims = jwt.verify(m[1], key, {
          algorithms: ["RS256"],
          audience: expectedAudience,
          issuer: ISSUERS,
          // M3: absorb ordinary clock drift between Google's signer and this
          // process, matching lib/auth/idToken.js's documented 60s tolerance.
          clockTolerance: 60,
          clockTimestamp: Math.floor(now() / 1000),
        });
        // IMPORTANT (live-verified finding): jwt.verify's `audience` option
        // passes when the token's `aud` is an ARRAY that merely CONTAINS the
        // expected value -- `aud: [expectedAudience, "https://evil.example"]`
        // verifies clean. The spec requires aud to EQUAL the service URL, so
        // a non-string (multi-valued) aud is refused outright here, not
        // merely checked for membership.
        if (typeof claims.aud !== "string" || claims.aud !== expectedAudience) return { ok: false, reason: "aud" };
        if (claims.email_verified !== true || !allowed.has(claims.email)) return { ok: false, reason: "email" };
        return { ok: true, email: claims.email };
      } catch (err) {
        return { ok: false, reason: err?.name || "invalid" };
      }
    },
  };
}
