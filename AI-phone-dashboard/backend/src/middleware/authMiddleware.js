const { createIdTokenVerifier } = require("./idToken");
const { checkSessionAge, SESSION_MAX_AGE_CODE } = require("./sessionAge");

// ---------------------------------------------------------------------------
// Who is calling?
//
// B3 replaced Supabase Auth with Identity Platform. `supabase.auth.getUser`
// was a NETWORK call to an auth backend on every request; this is local RS256
// verification against Google's published signing keys, cached. See
// lib/auth/accessToken.js for what that trade buys and costs.
//
// PROJECT ID IS ITS OWN VARIABLE, not GOOGLE_CLOUD_PROJECT: Identity Platform
// lives in `vetra-shared` and this backend does not.
// ---------------------------------------------------------------------------

const PROJECT_ID = (process.env.IDENTITY_PLATFORM_PROJECT_ID || "").trim();

/**
 * A FACTORY, not just a middleware, and the reason is a gap this closed rather
 * than a preference.
 *
 * src/__tests__/harness.js injects a FAKE authMiddleware into require.cache
 * before loading server.js — correctly, because route tests are about routes.
 * The consequence is that nothing in that suite ever runs the real one: all 99
 * tests would pass with this file returning 200 for everybody.
 *
 * The seam makes it testable with an injected verifier, so
 * src/__tests__/authMiddleware.test.js exercises the real code path — including
 * the assertion that matters most, that a VALID token is ACCEPTED. Three tests
 * proving a webhook refused bad input passed for months while it refused good
 * input too.
 *
 * @param {{ verify: ((token: string) => Promise<{ email: string, uid: string }|null>) | null }} deps
 */
function createAuthenticate({ verify }) {
  let warned = false;

  return async function authenticate(req, res, next) {
    if (!verify) {
      if (!warned) {
        warned = true;
        console.error(
          "[boot] FATAL auth_not_configured: IDENTITY_PLATFORM_PROJECT_ID is not set. " +
            "No token can be verified, so every route below this middleware returns 503. " +
            "This is the project that ISSUES the tokens (vetra-shared), not the one this runs in."
        );
      }
      // 503, not 401. A misconfigured server is not a rejected credential, and
      // returning 401 would send a whole clinic hunting for their passwords.
      return res.status(503).json({ error: "Authentication is not configured" });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No authorization header" });

    // Exactly `Bearer <token>`. The previous `authHeader.split(" ")[1]` accepted
    // any scheme and produced `undefined` for a bare token, which the auth
    // backend then rejected — the right outcome by the wrong route.
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match) return res.status(401).json({ error: "Invalid token" });

    const token = match[1];
    const identity = await verify(token);
    if (!identity) return res.status(401).json({ error: "Invalid token" });

    // §164.312(a)(2)(iii) automatic logoff.
    //
    // AFTER verification, never before. checkSessionAge reads the `iat` claim
    // WITHOUT checking the signature, which is only safe once the token has
    // already been verified — the ordering here is the safety property, not a
    // stylistic choice.
    //
    // A distinct `code` rather than a bare 401, because the dashboard refreshes
    // once and retries on exactly this (frontend src/authRetry.js). Without that
    // distinction the ceiling would be indistinguishable from a real sign-out
    // and would log a working clinic out mid-sentence, since Identity Platform
    // refreshes its token near expiry rather than when somebody acts.
    const age = checkSessionAge(token);
    if (age.expired) {
      return res.status(401).json({
        error: "Session expired",
        code: SESSION_MAX_AGE_CODE,
      });
    }

    // Shape preserved for every route downstream: `req.authUser.email` is what
    // getBusinessIdForUser reads, and `.id` is what the PHI audit trail records.
    // `id` is now the Identity Platform account id rather than the Supabase one
    // — neither has ever been the `users.id`, and nothing joins on it.
    req.authUser = { id: identity.uid, email: identity.email };
    return next();
  };
}

// Built once at module load. Null when unconfigured, and announced on the first
// request rather than silently failing forever — a dashboard where nobody can
// log in and nothing says why is the failure this project keeps meeting.
module.exports = createAuthenticate({
  verify: PROJECT_ID ? createIdTokenVerifier({ projectId: PROJECT_ID }) : null,
});
module.exports.createAuthenticate = createAuthenticate;
