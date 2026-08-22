import { createIdTokenVerifier } from "./idToken.js";
import { log } from "../logger.js";
import { checkSessionAge, SESSION_MAX_AGE_CODE } from "./sessionAge.js";

// ---------------------------------------------------------------------------
// Verifying the caller's access token.
//
// The dashboard has always sent one — AI-phone-dashboard/frontend/numberAPI.js
// attaches `Authorization: Bearer <token>` to every request via an axios
// interceptor. server.js simply never read it, and that is the bug this module
// originally closed.
//
// B3 swapped the backend underneath it, which is what the seam was for: the
// middleware above asks one question — "who is calling?" — and does not care
// who answers. Supabase Auth is gone; this is Identity Platform.
//
// WHAT CHANGED IN KIND, not just in vendor. `supabase.auth.getUser(token)` was
// a NETWORK CALL on every request, asking the auth backend whether a token was
// still good. This is local RS256 verification against Google's published keys,
// cached. Consequences, both deliberate:
//
//   - Google being unreachable no longer fails authentication for tokens whose
//     signing key is already cached. Better availability.
//   - A token REVOKED at Google stays verifiable here until it expires, which
//     for Identity Platform is one hour. Sign-out is client-side; it discards
//     the refresh token so no NEW access token can be minted, and the one in
//     hand runs out. That is the standard bearer-token trade and it is why
//     SESSION_MAX_AGE_MINUTES below is a shorter ceiling than the token's own
//     lifetime.
//
// PROJECT ID IS ITS OWN VARIABLE, not GOOGLE_CLOUD_PROJECT. Identity Platform
// lives in `vetra-shared` and serves every stack; the voice server runs in
// `vetra-us-staging` or `vetra-us-prod`. Reusing the runtime's project would
// make the issuer and audience checks compare against the wrong project, and
// the symptom would be every login failing after a deploy that changed nothing
// about auth.
// ---------------------------------------------------------------------------

const PROJECT_ID = (process.env.IDENTITY_PLATFORM_PROJECT_ID || "").trim();

/**
 * Built once, lazily, so importing this module cannot throw and so a process
 * that never serves an authenticated route pays nothing. `null` when
 * unconfigured — announced at boot by lib/bootChecks.js rather than discovered
 * as a wall of 401s.
 */
let verifier = null;
if (PROJECT_ID) {
  verifier = createIdTokenVerifier({ projectId: PROJECT_ID });
}

/**
 * The glue, as a FACTORY so it can be tested.
 *
 * tests/routeAuth.test.js mocks `verifyAccessToken` wholesale — correctly,
 * because it is about routes — which leaves the ordering below untested: that
 * the age ceiling is applied AFTER verification and never before. That ordering
 * is the safety property, and "it is obvious from reading it" is what the
 * source-scan lesson says not to settle for.
 *
 * @param {{ verifyIdToken: (token: string) => Promise<{ email: string, uid: string }|null> }} deps
 */
export function createAccessTokenVerifier({ verifyIdToken }) {
  return async function verify(token) {
    if (!token) return null;
    try {
      const identity = await verifyIdToken(token);
      if (!identity) return null;

      // §164.312(a)(2)(iii). AFTER verification, never before: this reads a
      // claim off the token to make a security decision, which is only safe
      // once the signature has been checked. See lib/auth/sessionAge.js for
      // what the ceiling does and does not bound.
      const age = checkSessionAge(token);
      if (age.expired) {
        log.error("session_max_age_exceeded", {
          ageSeconds: age.ageSeconds,
          maxAgeMinutes: age.maxAgeMinutes,
          severity: "warn",
        });
        return { expiredByAge: true };
      }

      return { email: identity.email, uid: identity.uid };
    } catch (err) {
      // Should be unreachable — the verifier returns null rather than throwing.
      // Kept because "should be unreachable" is not a guarantee, and the
      // alternative to catching here is a 500 on a route that means 401.
      log.error("access_token_verify_failed", {
        reason: err?.message,
        severity: "warn",
      });
      return null;
    }
  };
}

const configured = verifier ? createAccessTokenVerifier({ verifyIdToken: verifier }) : null;

/**
 * Read a bearer token out of an Authorization header.
 *
 * Returns null for anything that is not exactly `Bearer <token>` — a malformed
 * header is an unauthenticated request, never a partially-trusted one.
 *
 * @param {string|undefined} header
 * @returns {string|null}
 */
export function bearerFromHeader(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolve an access token to the identity it was issued for.
 *
 * Returns null on every failure path — expired, forged, revoked-and-expired, or
 * simply unverifiable because the signing key could not be fetched. The caller
 * turns null into a 401. Failing closed is the point: an outage must not become
 * an authentication bypass.
 *
 * @param {string} token
 * @returns {Promise<{ email: string, uid: string }|{ expiredByAge: true }|null>}
 */
export async function verifyAccessToken(token) {
  if (!configured) return null;
  return configured(token);
}

export { SESSION_MAX_AGE_CODE };
