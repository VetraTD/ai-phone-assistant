// ---------------------------------------------------------------------------
// §164.312(a)(2)(iii) automatic logoff — the server-side half.
//
// WHAT THIS BOUNDS, STATED PLAINLY, because the honest version is narrower than
// the label suggests and a control described wrongly is worse than one
// described modestly.
//
// It bounds how long ONE access token keeps working, measured from the `iat`
// claim. That is the window in which a token leaked through a log line, a
// screenshot, a proxy, or an open devtools panel is useful to whoever picked it
// up. Supabase's own one-hour expiry already caps that at an hour; this brings
// it down to the configured ceiling.
//
// It does NOT bound the refresh chain. A refresh token yields fresh access
// tokens with fresh `iat` values indefinitely, and nothing visible from a
// server request can age that — bounding it needs either a session store
// (a write per request) or a shortened token lifetime at the auth backend.
// Identity Platform makes the second practical, which is why the complete
// answer belongs to B3 and is recorded as an open item rather than implied by
// this file.
//
// What makes a ceiling BELOW the token lifetime usable rather than an
// interruption is the client half: the dashboard refreshes once and retries
// when it sees this rejection (frontend src/authRetry.js), so an active person
// notices nothing and an idle browser — which sends no requests — simply ages
// out. Without that, this would log a working clinic out mid-sentence, because
// Supabase refreshes on a timer near expiry rather than when somebody acts.
// ---------------------------------------------------------------------------

/** The code sent to the client, which it uses to decide to refresh and retry. */
export const SESSION_MAX_AGE_CODE = "session_max_age";

/**
 * Ceiling in minutes. 0 or unset disables the check.
 *
 * 30 is the default: comfortably below Supabase's 60-minute token lifetime, so
 * it actually bites, and far enough above any single page interaction that the
 * refresh-and-retry path is rare rather than constant.
 */
export const DEFAULT_SESSION_MAX_AGE_MINUTES = 30;

export function sessionMaxAgeMinutes(env = process.env) {
  const raw = env.SESSION_MAX_AGE_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_SESSION_MAX_AGE_MINUTES;

  // STRICT, not Number.parseInt. parseInt("1.5.2") is 1, which would turn a
  // typo into a one-minute ceiling — a control silently becoming far stricter
  // than intended, which reads to an operator as "the dashboard is broken" and
  // is as bad as one silently turning off. Same class as A1.6 refusing
  // DEPLOYMENT_MODE=hippa rather than running it as `standard`.
  //
  // "Off" has to be spelled 0.
  if (!/^\d+$/.test(String(raw).trim())) {
    announceBadValue(raw);
    return DEFAULT_SESSION_MAX_AGE_MINUTES;
  }
  return Number.parseInt(raw, 10);
}

/** Say so once. A misconfigured security control that says nothing is the defect. */
let announced = false;
function announceBadValue(raw) {
  if (announced) return;
  announced = true;
  // Lazily required so this module stays importable by anything, including the
  // dashboard's own copy of the check.
  import("../logger.js")
    .then(({ log }) =>
      log.error("session_max_age_invalid", {
        value: String(raw).slice(0, 32),
        using: DEFAULT_SESSION_MAX_AGE_MINUTES,
        severity: "warn",
      })
    )
    .catch(() => {});
}

/**
 * The `iat` claim of a JWT, in seconds, or null.
 *
 * DECODES WITHOUT VERIFYING, and that is safe only because of where it is
 * called: after the auth backend has already verified the signature. Reading a
 * claim off an unverified token to make a security decision would be the
 * classic JWT mistake, so the ordering is the safety property and both call
 * sites do it in that order deliberately.
 *
 * @param {string} token
 * @returns {number|null}
 */
export function issuedAtSeconds(token) {
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
 * A token with NO `iat` is REFUSED when the ceiling is on. The control exists to
 * bound a token's useful life; a token whose age cannot be measured has no
 * bound, and defaulting an unmeasurable token to "fine" would let anyone who
 * can influence claim contents opt out of the control by omission. Every JWT
 * either server accepts — Supabase's today, Identity Platform's after B3 —
 * carries `iat`, so this is a refusal in theory and not in practice.
 *
 * @param {string} token
 * @param {{ now?: () => number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ expired: boolean, ageSeconds: number|null, maxAgeMinutes: number }}
 */
export function checkSessionAge(token, { now = Date.now, env = process.env } = {}) {
  const maxAgeMinutes = sessionMaxAgeMinutes(env);
  if (maxAgeMinutes === 0) return { expired: false, ageSeconds: null, maxAgeMinutes };

  const iat = issuedAtSeconds(token);
  if (iat === null) return { expired: true, ageSeconds: null, maxAgeMinutes };

  const ageSeconds = Math.floor(now() / 1000) - iat;
  // A negative age is clock skew between the auth backend and this process, not
  // an old token. Treating it as expired would make a slightly fast auth server
  // reject every request.
  return { expired: ageSeconds > maxAgeMinutes * 60, ageSeconds, maxAgeMinutes };
}
