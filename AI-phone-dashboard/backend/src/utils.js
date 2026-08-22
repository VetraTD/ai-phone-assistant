const pool = require("./db");

/**
 * Get the business_id for the authenticated user (or null if unlinked).
 *
 * THROUGH app_lookup_user_by_email (migration 029), not a plain SELECT on
 * `users`. This is a BOOTSTRAP read — it is how the tenant becomes known, so it
 * cannot itself be scoped to a tenant — and `users` is RLS-protected, so the
 * direct select it used to do returns nothing as the application role. Every
 * route then 403'd with "No business linked to this user", which reads as an
 * authorisation bug and is a scoping one.
 *
 * KEYED ON EMAIL, where the old version keyed on the Supabase auth uid. Two
 * reasons, and the first is decisive: there is no bootstrap function for the id
 * and adding one would be a second answer to a question that already has one.
 * The second is that the voice server's requireBusinessAccess resolves an
 * identity through fetchUserByEmail, so both servers now ask the same question
 * the same way instead of drifting — the class of thing D1 exists to catch.
 *
 * `users.email` is UNIQUE, and onboarding writes it from the same auth identity
 * the token carries, so the two agree by construction.
 *
 * Accepts the auth user object rather than an id, so the caller cannot pass the
 * wrong one of the two fields silently.
 *
 * @param {{ id?: string, email?: string }|string|null} authUser
 * @returns {Promise<string|null>}
 */
async function getBusinessIdForUser(authUser) {
  const email = typeof authUser === "string" ? null : authUser?.email;
  if (!email) return null;
  const r = await pool.query(`select business_id from app_lookup_user_by_email($1)`, [email]);
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
