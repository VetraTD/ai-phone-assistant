const jwt = require("jsonwebtoken");
const jwks = require("jwks-rsa");

// ---------------------------------------------------------------------------
// Identity Platform ID token verification — the CommonJS half.
//
// A deliberate copy of lib/auth/idToken.js in the voice server, for the same
// reason src/middleware/sessionAge.js copies lib/auth/sessionAge.js and
// src/db/index.js reimplements withTenant: this backend is CommonJS, ships as
// its own image with its own node_modules, and that module is ESM. A relative
// import across the package boundary would work on this workstation and break
// in the container.
//
// The REASONING lives there in full — what each check prevents, and why every
// one of them is a real bypass if omitted. It is not half-explained in two
// places. What lives here is the same logic and a test file that forges the
// same attacks against it, so the two cannot drift silently:
//
//   tests/idToken.test.js                    (voice server)
//   src/__tests__/idToken.test.js            (this file)
//
// The short version, because someone will edit this without reading the other:
//
//   alg header pre-check   or an attacker signs HS256 with the PUBLIC key.
//                          `algorithms: ["RS256"]` below is a SECOND barrier
//                          and is measurably redundant — deleting it alone
//                          leaves the shared test suite green, because the
//                          pre-check rejects first. Kept, not relied on.
//   issuer + audience      or a token from any free Firebase project works,
//                          because securetoken is one signer for all of them
//   sub / auth_time / iat  identity, and the session-age ceiling's assumption
//   email                  the tenant is resolved BY email (migration 034)
// ---------------------------------------------------------------------------

const JWKS_URI =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const CLOCK_TOLERANCE_SECONDS = 60;

function createIdTokenVerifier({ projectId, getPublicKey, now = Date.now }) {
  if (!projectId) {
    throw new Error("createIdTokenVerifier requires a projectId");
  }

  const issuer = `https://securetoken.google.com/${projectId}`;

  let lookup = getPublicKey;
  if (!lookup) {
    const client = new jwks.JwksClient({
      jwksUri: JWKS_URI,
      cache: true,
      cacheMaxEntries: 8,
      cacheMaxAge: 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 5000,
    });
    lookup = async (kid) => (await client.getSigningKey(kid)).getPublicKey();
  }

  return async function verifyIdToken(token) {
    if (typeof token !== "string" || !token) return null;

    // Decoded WITHOUT verifying, purely to read `kid`. Nothing is trusted from
    // here — every claim used below comes out of jwt.verify's return value.
    const unverified = jwt.decode(token, { complete: true });
    const kid = unverified && unverified.header && unverified.header.kid;
    if (!kid || unverified.header.alg !== "RS256") return null;

    let key;
    try {
      key = await lookup(kid);
    } catch {
      return null;
    }
    if (!key) return null;

    let claims;
    try {
      claims = jwt.verify(token, key, {
        algorithms: ["RS256"],
        issuer,
        audience: projectId,
        clockTimestamp: Math.floor(now() / 1000),
      });
    } catch {
      return null;
    }

    const nowSeconds = now() / 1000;
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) return null;
    // jsonwebtoken does NOT check `iat` unless maxAge is set. sessionAge.js
    // computes the automatic-logoff ceiling from it and treats a negative age
    // as clock skew, so a token issued ahead of the clock would never age out.
    if (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) return null;
    if (!Number.isFinite(claims.auth_time) || claims.auth_time > nowSeconds + CLOCK_TOLERANCE_SECONDS) return null;
    if (typeof claims.email !== "string" || !claims.email) return null;

    return {
      email: claims.email,
      uid: claims.sub,
      authTimeSeconds: claims.auth_time,
    };
  };
}

module.exports = { createIdTokenVerifier, JWKS_URI, CLOCK_TOLERANCE_SECONDS };
