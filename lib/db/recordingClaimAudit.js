/**
 * Which tenants make a recording claim to callers (spec D4, LVX88).
 *
 * Read-only. Used by `scripts/db-inspect.js --recording-claims`, run through
 * the migrate job because Cloud SQL is private-IP only.
 *
 * WHY IT WALKS THE DIRECTORY. `businesses` is FORCE ROW LEVEL SECURITY and the
 * migrate job's `postgres` is not a bypassing role, so `SELECT ... FROM
 * businesses` with no tenant scope reads ZERO rows -- and an audit that reads
 * zero rows reports a clean database. `business_directory` has no RLS (routing
 * only, readable by its owner), and app_lookup_business_by_phone adopts each
 * tenant for its transaction, so every tenant is read through the same
 * policy-satisfying path the voice service uses.
 *
 * SCOPE: every ROUTABLE tenant, i.e. every tenant with a directory row. A
 * tenant with no phone number (or one whose number another tenant holds) has
 * no directory row and cannot receive a call, so it is outside this audit.
 * `complete` is false for an empty directory or for any directory number that
 * resolved to no tenant, and `unread` names those numbers, so a partial read
 * can never pass for a clean one.
 *
 * WHAT IT SCANS: every piece of tenant text that reaches a caller or the
 * prompt -- the greeting, general_info, custom_instructions, the disclosure
 * text, the caller SMS templates, enabled capability config (notes live
 * there), and enabled knowledge base entries.
 *
 * WHAT IT RETURNS: field names and flags. Never the text.
 */

import { claimsRecording } from "../voice/disclosure.js";

/**
 * Every string inside a JSON value, recursively. The patterns need the real
 * text: JSON.stringify would turn a newline inside a note into the two
 * characters "\n", which a claim split across lines would then slip through.
 * @param {unknown} value
 * @param {string[]} [out]
 * @returns {string[]}
 */
function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

const jsonClaims = (value) => stringsIn(value).some((s) => claimsRecording(s));

/**
 * @param {{directory_rows: number, tenants_read: number, unread: string[]}} report
 * @returns {boolean} true only when the directory was non-empty and every number in it was read
 */
export function auditIsComplete(report) {
  return report.directory_rows > 0 && report.tenants_read === report.directory_rows && report.unread.length === 0;
}

/**
 * @param {import("pg").Client | import("pg").PoolClient} client
 * @returns {Promise<{directory_rows: number, tenants_read: number, unread: string[], complete: boolean,
 *   tenants: Array<{phone_number: string, business_id: string, claims: string[], disclosure_enabled: boolean}>}>}
 */
export async function auditRecordingClaims(client) {
  const dir = await client.query(`SELECT phone_number FROM business_directory ORDER BY phone_number`);
  const tenants = [];
  const unread = [];

  for (const { phone_number: phone } of dir.rows) {
    // READ ONLY, so Postgres itself refuses any write this audit might grow.
    // set_config and the SECURITY DEFINER read are both allowed inside it.
    await client.query("BEGIN READ ONLY");
    try {
      // Clear any scope the connection carried in, so the lookup adopts THIS
      // tenant instead of respecting another one and returning nothing.
      await client.query(`SELECT set_config('app.business_id', '', true)`);
      const biz = await client.query(
        `SELECT id, phone_number, greeting, general_info, custom_instructions,
                recording_disclosure_enabled, recording_disclosure_text, sms_templates
           FROM app_lookup_business_by_phone($1)`,
        [phone]
      );
      const b = biz.rows[0];
      if (!b) {
        await client.query("COMMIT");
        unread.push(phone);
        continue;
      }

      const caps = await client.query(
        `SELECT capability_id, config FROM business_capabilities
          WHERE business_id = $1 AND enabled ORDER BY capability_id`,
        [b.id]
      );
      const kb = await client.query(
        `SELECT question, answer FROM business_knowledge
          WHERE business_id = $1 AND enabled IS NOT FALSE`,
        [b.id]
      );
      await client.query("COMMIT");

      const claims = [];
      for (const field of ["greeting", "general_info", "custom_instructions", "recording_disclosure_text"]) {
        if (claimsRecording(b[field])) claims.push(field);
      }
      if (jsonClaims(b.sms_templates)) claims.push("sms_templates");
      for (const c of caps.rows) {
        if (jsonClaims(c.config)) claims.push(`capability:${c.capability_id}`);
      }
      const kbHits = kb.rows.filter((k) => claimsRecording(k.question) || claimsRecording(k.answer)).length;
      if (kbHits) claims.push(`knowledge:${kbHits}`);

      tenants.push({
        phone_number: b.phone_number,
        business_id: b.id,
        claims,
        disclosure_enabled: Boolean(b.recording_disclosure_enabled),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  const report = { directory_rows: dir.rows.length, tenants_read: tenants.length, unread, tenants };
  return { ...report, complete: auditIsComplete(report) };
}
