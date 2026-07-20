const pool = require("./db");

/** Get the business_id for the authenticated user (or null if unlinked). */
async function getBusinessIdForUser(userId) {
  const r = await pool.query(`select business_id from users where id = $1`, [userId]);
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
