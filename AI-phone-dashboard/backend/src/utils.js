const pool = require("./db");

/**
 * Get the business_id for the authenticated user (or null if unlinked).
 *
 * THROUGH app_lookup_user_by_auth_uid (migration 036), not a plain SELECT on
 * `users`. This is a BOOTSTRAP read — it is how the tenant becomes known, so it
 * cannot itself be scoped to a tenant — and `users` is RLS-protected, so a
 * direct select returns nothing as the application role. Every route then 403'd
 * with "No business linked to this user", which reads as an authorisation bug
 * and is a scoping one.
 *
 * KEYED ON THE ACCOUNT ID. It was keyed on EMAIL between migrations 029 and
 * 036, and that was a hole: signup is open, so an address is something a
 * stranger can CHOOSE. An address with a `users` row but no identity-provider
 * account could be claimed by anyone signing up with it, and they would inherit
 * that clinic's tenant with a perfectly valid token. An account id cannot be
 * chosen.
 *
 * The voice server's requireBusinessAccess resolves an identity the same way
 * through fetchUserByAuthUid, so both servers ask one question one way rather
 * than drifting — the class of thing D1 exists to catch.
 *
 * Accepts the auth user object rather than a bare id, so the caller cannot pass
 * the wrong one of the two fields silently.
 *
 * @param {{ id?: string, email?: string }|string|null} authUser
 * @returns {Promise<string|null>}
 */
async function getBusinessIdForUser(authUser) {
  const authUid = typeof authUser === "string" ? null : authUser?.id;
  if (!authUid) return null;
  const r = await pool.query(`select business_id from app_lookup_user_by_auth_uid($1)`, [authUid]);
  return r.rows[0]?.business_id || null;
}

function sanitizeString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (maxLength && trimmed.length > maxLength) {
    return trimmed.slice(0, maxLength);
  }
  return trimmed;
}

function isValidEmail(email) {
  const v = sanitizeString(email, 254);
  if (!v) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function rejectUnexpectedKeys(obj, allowedKeys) {
  if (!obj || typeof obj !== "object") return;
  const extra = Object.keys(obj).filter((k) => !allowedKeys.includes(k));
  if (extra.length) {
    const err = new Error("Unexpected fields in request body");
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Build parameterized SET clauses + params for a dynamic UPDATE from a
 * whitelist of field validators. Only keys present in BOTH `fieldValidators`
 * and `body` are included — anything else in `body` is reported back as
 * `unknownKeys` so callers can log/ignore it instead of 500ing. Column names
 * in the returned SET clauses come only from `fieldValidators`'s own key set
 * (never from request input), and every value is parameterized — this is
 * the injection-safety boundary for all dynamic-update routes.
 *
 * @param {Record<string, (value: any) => { value?: any, error?: string }>} fieldValidators
 * @param {object} body - raw request body
 * @returns {{ setClauses: string[], params: any[], unknownKeys: string[] } | { error: string }}
 */
function buildUpdateFromWhitelist(fieldValidators, body) {
  const knownKeys = Object.keys(fieldValidators);
  const providedBody = body && typeof body === "object" ? body : {};
  const unknownKeys = Object.keys(providedBody).filter((k) => !knownKeys.includes(k));

  const setClauses = [];
  const params = [];
  for (const key of knownKeys) {
    if (!(key in providedBody)) continue;
    const { value, error } = fieldValidators[key](providedBody[key]);
    if (error) {
      return { error: `${key}: ${error}` };
    }
    params.push(value);
    setClauses.push(`${key} = $${params.length}`);
  }
  return { setClauses, params, unknownKeys };
}

module.exports = {
  getBusinessIdForUser,
  sanitizeString,
  isValidEmail,
  rejectUnexpectedKeys,
  buildUpdateFromWhitelist,
};
