/**
 * The read behind `scripts/fallback-urls.js`: one row per routable business.
 *
 * A module rather than inline script code so it can be tested as a role that
 * does NOT bypass row-level security (tests/db/fallbackUrlRows.test.js).
 *
 * THE TRAP THIS SHAPE AVOIDS. app_lookup_business_by_phone is SECURITY DEFINER
 * and ADOPTS THE FIRST TENANT IT SEES for the whole transaction
 * (set_config('app.business_id', ..., true) when unset). Production's migrate
 * role has no BYPASSRLS and `businesses` is FORCE RLS, so a lookup of several
 * tenants inside ONE transaction (a LATERAL join, a loop in BEGIN..COMMIT, one
 * Client in a transaction) returns the first tenant only -- and still passes
 * locally, where the role is a superuser. So: list the phones from the platform
 * table business_directory (no RLS), then run ONE autocommit query per phone.
 * Pass a pool or an idle client, never a client inside BEGIN.
 */

/**
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: object[] }> }} queryable
 * @returns {Promise<object[]>} per business: phone_number, name, transfer_phone_number,
 *   transfer_no_answer, allow_pricier_numbers, and `business` (the whole row,
 *   for loadConfig). Business configuration only; no caller data.
 */
export async function listFallbackRows(queryable) {
  const phones = await queryable.query("SELECT phone_number FROM business_directory ORDER BY phone_number");
  const out = [];
  for (const { phone_number: phone } of phones.rows) {
    // Autocommit: one statement, one tenant adoption.
    const r = await queryable.query("SELECT * FROM app_lookup_business_by_phone($1)", [phone]);
    const b = r.rows[0];
    if (!b) continue;
    out.push({
      phone_number: phone,
      name: b.name,
      transfer_phone_number: b.transfer_phone_number ?? null,
      transfer_no_answer: b.transfer_no_answer ?? null,
      allow_pricier_numbers: b.allow_pricier_numbers === true,
      business: b,
    });
  }
  return out;
}
