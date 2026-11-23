// ---------------------------------------------------------------------------
// Password-reset codes from Identity Platform, without Identity Platform's email.
//
// Identity Platform's own reset email (notification method DEFAULT) is sent from
// noreply@<project>.firebaseapp.com, and its stored template is garbled. With
// `returnOobLink: true` and service-account credentials, the admin API mints the
// one-shot code and returns the link INSTEAD of emailing it, so the dashboard
// can send its own email from notifications@vetratd.com. scripts/onboard-tenant.js
// uses the same call to hand a new customer their first link.
//
// Only the code leaves this module. The link Identity Platform builds points at
// its hosted handler; the dashboard's own /reset-password page takes the code.
//
// WHAT NEVER LEAVES THIS MODULE IN AN ERROR: the address, the token, or Google's
// error text (which can quote the address). Failures are closed reasons.
// ---------------------------------------------------------------------------

const IDP_TIMEOUT_MS = 8_000;
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_EARLY_REFRESH_MS = 60_000;

function closed(reason) {
  return new Error(reason);
}

/**
 * The 400 refusals that are about ONE address. Anything else Identity Platform
 * answers 400 for (OPERATION_NOT_ALLOWED, CONFIGURATION_NOT_FOUND, a body it no
 * longer accepts) refuses every address, and must be flagged, not passed off as
 * "no account": that would turn reset off silently, forever (LVX85).
 */
const PER_ADDRESS_REFUSALS = new Set(["EMAIL_NOT_FOUND", "USER_DISABLED", "RESET_PASSWORD_EXCEED_LIMIT"]);

/** The leading error code of a 400, e.g. "EMAIL_NOT_FOUND : ..." -> "EMAIL_NOT_FOUND". Never the rest. */
async function refusalCode(response) {
  try {
    const body = await response.json();
    const match = /^[A-Z][A-Z_]{2,59}/.exec(String(body?.error?.message || ""));
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * The Cloud Run service account's access token, from the metadata server,
 * cached until shortly before it expires. Throws when there is no metadata
 * server (local dev), which the minter reports as idp_token_failed.
 *
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {() => Promise<string>}
 */
function metadataTokenSource({ fetchImpl = (...a) => fetch(...a) } = {}) {
  let cached = null;
  return async function getAccessToken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
    });
    if (!response.ok) throw closed("metadata_token_failed");
    const body = await response.json();
    if (typeof body?.access_token !== "string" || !body.access_token) throw closed("metadata_token_failed");
    const lifetimeMs = Number(body.expires_in) * 1000;
    cached = {
      token: body.access_token,
      expiresAt: Date.now() + (Number.isFinite(lifetimeMs) ? lifetimeMs : 0) - TOKEN_EARLY_REFRESH_MS,
    };
    return cached.token;
  };
}

/**
 * @param {{ projectId: string, getAccessToken: () => Promise<string>, fetchImpl?: typeof fetch }} opts
 * @returns {{ mint: (email: string) => Promise<{ code: string } | { skip: true }> }}
 */
function createResetCodeMinter({ projectId, getAccessToken, fetchImpl = (...a) => fetch(...a) }) {
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:sendOobCode`;

  /**
   * { code } when the address has an account. { skip: true, reason } when no
   * email will go: reason is the per-address refusal (EMAIL_NOT_FOUND, ...), or
   * "unexpected" (with the 400's code as `refusal`) or "no_link", which the caller must log
   * as errors. Callers answer every skip exactly like a send. Throws a closed
   * reason only for failures that are the same for every address (no token,
   * permission, outage, unreachable), which are safe to surface.
   */
  async function mint(email) {
    let token;
    try {
      token = await getAccessToken();
    } catch {
      throw closed("idp_token_failed");
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // The service account lives in another project. This bills the call
          // to the project that owns the users, as onboard-tenant.js does.
          "x-goog-user-project": projectId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email, returnOobLink: true }),
        signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
      });
    } catch {
      throw closed("idp_unreachable");
    }

    if (response.status === 400) {
      const code = await refusalCode(response);
      return PER_ADDRESS_REFUSALS.has(code) ? { skip: true, reason: code } : { skip: true, reason: "unexpected", refusal: code };
    }
    if (!response.ok) throw closed("idp_refused");

    // Only a real account reaches here, so a missing link is a flagged skip,
    // not a throw: a 503 on this path alone would tell real accounts apart.
    let code = null;
    try {
      const body = await response.json();
      code = new URL(body?.oobLink).searchParams.get("oobCode");
    } catch {
      code = null;
    }
    if (!code) return { skip: true, reason: "no_link", refusal: null };
    return { code };
  }

  return { mint };
}

module.exports = { createResetCodeMinter, metadataTokenSource };
