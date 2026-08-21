// §164.312(a)(2)(iii) automatic logoff — the server-side half, for this
// backend.
//
// A deliberate copy of lib/auth/sessionAge.js in the voice server, for the same
// reason src/db/index.js reimplements withTenant: this backend is CommonJS and
// that module is ESM. Kept byte-for-byte equivalent in behaviour, and the
// reasoning — what this bounds, what it does NOT bound, and why a ceiling below
// the token lifetime is only usable because the frontend refreshes and retries
// — lives there in full rather than being half-explained in two places.

const SESSION_MAX_AGE_CODE = "session_max_age";
const DEFAULT_SESSION_MAX_AGE_MINUTES = 30;

function sessionMaxAgeMinutes(env = process.env) {
  const raw = env.SESSION_MAX_AGE_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_SESSION_MAX_AGE_MINUTES;
  // Strict: parseInt("1.5.2") is 1, and a typo must not become a one-minute
  // ceiling. "Off" has to be spelled 0.
  if (!/^\d+$/.test(String(raw).trim())) {
    console.warn(
      `SESSION_MAX_AGE_MINUTES is not a whole number of minutes; using ${DEFAULT_SESSION_MAX_AGE_MINUTES}`
    );
    return DEFAULT_SESSION_MAX_AGE_MINUTES;
  }
  return Number.parseInt(raw, 10);
}

/** The `iat` claim, in seconds, or null. Decodes WITHOUT verifying — see below. */
function issuedAtSeconds(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const iat = JSON.parse(json)?.iat;
    return Number.isFinite(iat) ? iat : null;
  } catch {
    return null;
  }
}

/**
 * Is this token older than the ceiling?
 *
 * MUST be called only after the auth backend has verified the signature —
 * reading a claim off an unverified token to make a security decision is the
 * classic JWT mistake, and the ordering in authMiddleware is what makes this
 * safe.
 *
 * A token with no `iat` is refused while the ceiling is on: a token whose age
 * cannot be measured has no bound, and treating it as fine would let anyone who
 * can influence claim contents opt out by omission.
 */
function checkSessionAge(token, { now = Date.now, env = process.env } = {}) {
  const maxAgeMinutes = sessionMaxAgeMinutes(env);
  if (maxAgeMinutes === 0) return { expired: false, ageSeconds: null, maxAgeMinutes };

  const iat = issuedAtSeconds(token);
  if (iat === null) return { expired: true, ageSeconds: null, maxAgeMinutes };

  const ageSeconds = Math.floor(now() / 1000) - iat;
  // A negative age is clock skew, not an old token.
  return { expired: ageSeconds > maxAgeMinutes * 60, ageSeconds, maxAgeMinutes };
}

module.exports = {
  SESSION_MAX_AGE_CODE,
  DEFAULT_SESSION_MAX_AGE_MINUTES,
  sessionMaxAgeMinutes,
  issuedAtSeconds,
  checkSessionAge,
};
