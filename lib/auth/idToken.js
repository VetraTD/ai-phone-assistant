import jwt from "jsonwebtoken";
import jwks from "jwks-rsa";

// ---------------------------------------------------------------------------
// Verifying an Identity Platform ID token.
//
// This replaces a call to `supabase.auth.getUser(token)`, and the shape of the
// change is worth stating: that was a NETWORK call to an auth backend, which
// answered "is this token good?" on every request. This is local RS256
// signature verification against Google's published signing keys, cached. It is
// faster and it fails differently — an outage at Google does not stop us
// verifying a token we already hold the key for, and a token REVOKED at Google
// stays verifiable here until it expires (one hour). Both directions are
// deliberate, and the second is why lib/auth/sessionAge.js's ceiling exists.
//
// THE VERIFICATION IS NOT "jwt.verify AND HOPE". Every one of these is a real
// bypass if omitted, and every one has a test that forges exactly it:
//
//   alg pre-check           The header must SAY RS256 before anything else
//   + algorithms: ["RS256"] happens, and `jsonwebtoken` is then pinned to
//                           RS256 as well. The attack both stop: `jsonwebtoken`
//                           otherwise honours whatever the token's own header
//                           asks for, including HS256 — where the "secret" is
//                           the PUBLIC key anyone can fetch, so the attacker
//                           signs their own token.
//
//                           MEASURED: the pre-check is the barrier that fires.
//                           Deleting `algorithms` alone leaves every test in
//                           tests/idToken.test.js green, because nothing with a
//                           non-RS256 header ever reaches jwt.verify. The pin is
//                           kept as the second barrier for the day somebody
//                           widens the pre-check to allow ES256, and it is
//                           written down as redundant rather than left to look
//                           load-bearing.
//   issuer                  A token from ANOTHER Google project verifies
//                           against the SAME signing keys — securetoken is one
//                           shared signer for every project on earth. Without
//                           an issuer check, anybody with a free Firebase
//                           project can mint tokens we accept.
//   audience                The other half of that. Both, not either.
//   sub                     The Identity Platform account id. A token without
//                           one identifies nobody.
//   auth_time               Google's documented check. A token whose issuance
//                           cannot be placed in time cannot be aged.
//   email                   Not Google's check, ours: the tenant is resolved
//                           BY EMAIL (migration 034), so a token without one
//                           would authenticate and then resolve to nothing —
//                           a 403 that reads as an authorisation bug.
//
// The key lookup is INJECTABLE so the tests can verify all of the above against
// a key pair they generate, offline, in-process. A verifier that can only be
// tested by talking to Google is a verifier that does not get tested.
// ---------------------------------------------------------------------------

/** Google's shared signer for every Identity Platform / Firebase project. */
const JWKS_URI =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/**
 * How far ahead of our clock a token may claim to have been issued.
 *
 * Google's clocks and Cloud Run's are both NTP-synced, so a legitimate token is
 * never meaningfully ahead. A minute absorbs ordinary drift without leaving a
 * window worth using.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * `import * as jwt from "jsonwebtoken"` would put ONLY `{ decode, default }` on
 * the namespace under real Node — `verify` would be undefined and every token
 * would fail, or worse, be swallowed by a catch. Measured, not assumed. The
 * default import above is the correct form; this asserts it stayed correct,
 * because the failure is silent and the package is CommonJS.
 *
 * @see lib/twilioSignature.js — the same defect, found by a real phone call.
 */
if (typeof jwt.verify !== "function") {
  throw new Error(
    "jsonwebtoken did not export verify — check the import form, not the package"
  );
}

/**
 * Build a verifier.
 *
 * @param {object} opts
 * @param {string} opts.projectId  Identity Platform project. Both `aud` and the tail of `iss`.
 * @param {(kid: string) => Promise<string>} [opts.getPublicKey]  Injected in tests.
 * @param {() => number} [opts.now]  Injected in tests. Milliseconds.
 */
export function createIdTokenVerifier({ projectId, getPublicKey, now = Date.now }) {
  if (!projectId) {
    // Not a silent no-op. A deployment with no project id cannot verify
    // anything, and the honest outcome is a process that says so at boot rather
    // than one that 401s every request and looks like everyone's password
    // broke. See the "silent failure is a defect class" contract.
    throw new Error("createIdTokenVerifier requires a projectId");
  }

  const issuer = `https://securetoken.google.com/${projectId}`;

  let lookup = getPublicKey;
  if (!lookup) {
    const client = new jwks.JwksClient({
      jwksUri: JWKS_URI,
      cache: true,
      cacheMaxEntries: 8,
      // Google rotates these daily. An hour is short enough to pick up a
      // rotation and long enough that a burst of requests is one fetch.
      cacheMaxAge: 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 5000,
    });
    lookup = async (kid) => (await client.getSigningKey(kid)).getPublicKey();
  }

  /**
   * @param {string} token
   * @returns {Promise<{ email: string, uid: string, authTimeSeconds: number }|null>}
   *   null on EVERY failure. The caller turns null into a 401. Failing closed is
   *   the point: an outage must not become an authentication bypass.
   */
  return async function verifyIdToken(token) {
    if (typeof token !== "string" || !token) return null;

    // Decoded WITHOUT verifying, purely to read `kid` so the right key can be
    // fetched. Nothing is trusted from here — the claims used below all come
    // out of jwt.verify's return value, after the signature has been checked.
    const unverified = jwt.decode(token, { complete: true });
    const kid = unverified?.header?.kid;
    if (!kid || unverified.header.alg !== "RS256") return null;

    let key;
    try {
      key = await lookup(kid);
    } catch {
      // An unknown `kid` is an ordinary forged token, and a network failure is
      // an outage. Both mean "not authenticated" and neither may be an error
      // the caller has to remember to handle.
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

    // `jsonwebtoken` does NOT check `iat` at all unless `maxAge` is set — it
    // validates `exp` and `nbf` and ignores issuance entirely. Found by a test
    // that expected otherwise.
    //
    // This is not a forgery defence; `iat` is signed. It matters because
    // lib/auth/sessionAge.js computes the §164.312(a)(2)(iii) automatic-logoff
    // ceiling FROM `iat`, and treats a negative age as clock skew rather than
    // as an old token — correctly, but that tolerance is only safe while `iat`
    // cannot be in the future. A token issued ahead of the clock would never
    // age out. Refuse it here so the ceiling's assumption stays true.
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

export { JWKS_URI };
