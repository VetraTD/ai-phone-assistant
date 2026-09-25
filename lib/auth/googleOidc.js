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
  const allowed = new Set(allowedEmails || []);
  const client = getPublicKey ? null : jwksRsa({ jwksUri: JWKS_URI, cache: true, cacheMaxAge: 3_600_000, rateLimit: true, jwksRequestsPerMinute: 10 });
  const keyFor = getPublicKey || (async (kid) => (await client.getSigningKey(kid)).getPublicKey());

  return {
    async verify(authHeader) {
      const m = /^Bearer\s+(.+)$/.exec(authHeader || "");
      if (!m) return { ok: false, reason: "missing" };
      const decoded = jwt.decode(m[1], { complete: true });
      if (!decoded || decoded.header?.alg !== "RS256") return { ok: false, reason: "alg" };
      try {
        const key = await keyFor(decoded.header.kid);
        const claims = jwt.verify(m[1], key, { algorithms: ["RS256"], audience, issuer: ISSUERS, clockTimestamp: Math.floor(now() / 1000) });
        if (claims.email_verified !== true || !allowed.has(claims.email)) return { ok: false, reason: "email" };
        return { ok: true, email: claims.email };
      } catch (err) {
        return { ok: false, reason: err?.name || "invalid" };
      }
    },
  };
}
