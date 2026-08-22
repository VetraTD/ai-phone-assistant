import { createClient } from "@supabase/supabase-js";
import { log } from "../logger.js";
import { checkSessionAge, SESSION_MAX_AGE_CODE } from "./sessionAge.js";

// ---------------------------------------------------------------------------
// Verifying the caller's access token.
//
// The dashboard has always sent one — AI-phone-dashboard/frontend/numberAPI.js
// attaches `Authorization: Bearer <supabase access_token>` to every request via
// an axios interceptor. server.js simply never read it. That is the whole of
// the bug this module closes.
//
// Deliberately a seam of its own rather than inline in the middleware: B3
// replaces Supabase Auth with Identity Platform, and when it does, only this
// file changes. The middleware above it asks one question — "who is calling?" —
// and does not care who answers.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// A dedicated client with session persistence off. The shared one in
// services/db.js is the data-layer client; borrowing it here would couple
// this seam to a module A3 is about to rewrite.
const authClient =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

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
 * Resolve an access token to the email it was issued for.
 *
 * Returns null on every failure path — expired, forged, revoked, or simply
 * unverifiable because the auth backend is unreachable. The caller turns null
 * into a 401. Failing closed is the point: an outage must not become an
 * authentication bypass.
 *
 * @param {string} token
 * @returns {Promise<{ email: string }|null>}
 */
export async function verifyAccessToken(token) {
  if (!authClient || !token) return null;
  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user?.email) return null;

    // §164.312(a)(2)(iii). AFTER getUser, never before: this reads a claim off
    // the token without checking its signature, which is only safe once the
    // auth backend has already verified it. The ordering is the safety
    // property. See lib/auth/sessionAge.js for what the ceiling does and does
    // not bound.
    const age = checkSessionAge(token);
    if (age.expired) {
      log.error("session_max_age_exceeded", {
        ageSeconds: age.ageSeconds,
        maxAgeMinutes: age.maxAgeMinutes,
        severity: "warn",
      });
      return { expiredByAge: true };
    }

    return { email: data.user.email };
  } catch (err) {
    // Network or client failure. Logged as a warning rather than swallowed,
    // because a sustained run of these is an outage worth seeing — but it still
    // resolves to "not authenticated".
    log.error("access_token_verify_failed", {
      reason: err?.message,
      severity: "warn",
    });
    return null;
  }
}
export { SESSION_MAX_AGE_CODE };
