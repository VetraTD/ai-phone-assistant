/**
 * Read-only production check for outbound calling go-live (Y1, go-live
 * pre-deploy code group Y). Behind `db-inspect --outbound-preflight`, run
 * through the migrate job because Cloud SQL is private-IP only.
 *
 * Mirrors lib/db/recordingClaimAudit.js's shape and the reason for it: the
 * migrate job connects as `postgres`, which on Cloud SQL is rolbypassrls =
 * false, and every tenant table is FORCE ROW LEVEL SECURITY, so an unscoped
 * SELECT returns 0 rows. Section 1 (the tenant walk) therefore walks
 * `business_directory` (no RLS, routing only) and adopts each tenant with
 * `set_config('app.business_id', id, true)` inside its own transaction --
 * the same path app_lookup_business_by_phone gives the voice service.
 *
 * Section 2 (privileges) needs no tenant scope: `has_table_privilege` and
 * `to_regclass` read the catalog, which FORCE RLS does not touch.
 *
 * NUMBERS ONLY. Never prints integration config or any row content -- only
 * counts, presence and grant booleans.
 */

/**
 * @param {{directory_rows: number, tenants_read: number, unread: string[]}} report
 * @returns {boolean} true only when the directory was non-empty and every number in it was read
 */
export function tenantWalkIsComplete(report) {
  return report.directory_rows > 0 && report.tenants_read === report.directory_rows && report.unread.length === 0;
}

/**
 * Every routable tenant in `business_directory`, each read under its own
 * scope: `phone`, `calls` = count(*) FROM calls, `confirm_identity_integrations`
 * = count(*) FROM integrations WHERE name = 'confirm_identity' -- a legacy or
 * shadowing webhook by that name (services/tools.js:360-372: `confirm_identity`
 * is reserved as an engine tool but the reservation does not rename one
 * created before it shipped, and it is silently shadowed on outbound calls).
 *
 * @param {import("pg").Client | import("pg").PoolClient} client
 * @returns {Promise<{directory_rows: number, tenants_read: number, unread: string[], complete: boolean,
 *   totals: {calls: number, confirm_identity_integrations: number},
 *   tenants: Array<{phone_number: string, business_id: string, calls: number, confirm_identity_integrations: number}>}>}
 */
export async function outboundTenantWalk(client) {
  const dir = await client.query(`SELECT phone_number FROM business_directory ORDER BY phone_number`);
  const tenants = [];
  const unread = [];

  for (const { phone_number: phone } of dir.rows) {
    // READ ONLY, like recordingClaimAudit -- Postgres itself refuses any
    // write this preflight might grow.
    await client.query("BEGIN READ ONLY");
    try {
      // Clear any scope the connection carried in, so the lookup adopts THIS
      // tenant rather than respecting a stale one and returning nothing.
      await client.query(`SELECT set_config('app.business_id', '', true)`);
      const biz = await client.query(`SELECT id, phone_number FROM app_lookup_business_by_phone($1)`, [phone]);
      const b = biz.rows[0];
      if (!b) {
        await client.query("COMMIT");
        unread.push(phone);
        continue;
      }

      const calls = await client.query(`SELECT count(*)::int AS n FROM calls`);
      const confirmIdentity = await client.query(
        `SELECT count(*)::int AS n FROM integrations WHERE name = 'confirm_identity'`
      );
      await client.query("COMMIT");

      tenants.push({
        phone_number: b.phone_number,
        business_id: b.id,
        calls: calls.rows[0].n,
        confirm_identity_integrations: confirmIdentity.rows[0].n,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  const totals = tenants.reduce(
    (acc, t) => ({
      calls: acc.calls + t.calls,
      confirm_identity_integrations: acc.confirm_identity_integrations + t.confirm_identity_integrations,
    }),
    { calls: 0, confirm_identity_integrations: 0 }
  );

  const report = { directory_rows: dir.rows.length, tenants_read: tenants.length, unread, tenants, totals };
  return { ...report, complete: tenantWalkIsComplete(report) };
}

/**
 * The EXPECTED grants for every table created by migrations 042-045, from the
 * migrations themselves:
 *   - 042:173 `GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns,
 *     campaign_versions, contacts, consents, suppressions, outreach,
 *     call_attempts, webhook_endpoints, outbox TO vetra_app`.
 *   - 044:33-34 `REVOKE ALL ON call_attempt_directory, dial_registry,
 *     outreach_schedule FROM PUBLIC` and `FROM vetra_app` -- routing-only, no
 *     RLS, read by their SECURITY DEFINER functions alone.
 *   - 045:30-31 `REVOKE ALL ON postcall_pending FROM PUBLIC` and
 *     `FROM vetra_app` -- same shape, one more routing table.
 * (043 adds columns to existing tables and creates no new table.)
 */
export const EXPECTED_OUTBOUND_PRIVILEGES = Object.freeze({
  campaigns: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  campaign_versions: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  contacts: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  consents: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  suppressions: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  outreach: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  call_attempts: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  webhook_endpoints: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  outbox: Object.freeze({ select: true, insert: true, update: true, delete: true }),
  call_attempt_directory: Object.freeze({ select: false, insert: false, update: false, delete: false }),
  dial_registry: Object.freeze({ select: false, insert: false, update: false, delete: false }),
  outreach_schedule: Object.freeze({ select: false, insert: false, update: false, delete: false }),
  postcall_pending: Object.freeze({ select: false, insert: false, update: false, delete: false }),
});

/**
 * Catalog only -- no tenant scope needed. Before migrations 042-045 run,
 * every table is `absent`, and that is NOT an error: this preflight runs once
 * before those migrations apply and once after (spec Y1).
 *
 * @param {import("pg").Client | import("pg").PoolClient} client
 * @returns {Promise<{tables: Array<{table: string, present: boolean, select?: boolean,
 *   insert?: boolean, update?: boolean, delete?: boolean, verdict: "ok"|"MISMATCH"|"absent"}>,
 *   anyMismatch: boolean}>}
 */
export async function outboundPrivileges(client) {
  const tables = [];
  let anyMismatch = false;

  for (const [table, expected] of Object.entries(EXPECTED_OUTBOUND_PRIVILEGES)) {
    const presentRes = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table]);
    const present = presentRes.rows[0].present;

    if (!present) {
      tables.push({ table, present: false, verdict: "absent" });
      continue;
    }

    const privRes = await client.query(
      `SELECT has_table_privilege('vetra_app', $1, 'SELECT') AS select,
              has_table_privilege('vetra_app', $1, 'INSERT') AS insert,
              has_table_privilege('vetra_app', $1, 'UPDATE') AS update,
              has_table_privilege('vetra_app', $1, 'DELETE') AS delete`,
      [table]
    );
    const got = privRes.rows[0];
    const ok =
      got.select === expected.select &&
      got.insert === expected.insert &&
      got.update === expected.update &&
      got.delete === expected.delete;
    if (!ok) anyMismatch = true;

    tables.push({ table, present: true, select: got.select, insert: got.insert, update: got.update, delete: got.delete, verdict: ok ? "ok" : "MISMATCH" });
  }

  return { tables, anyMismatch };
}

/**
 * Both sections, run in order. Exit-code semantics belong to the caller
 * (scripts/db-inspect.js): reflects only tenant-walk completeness and, when
 * tables are present, any MISMATCH -- an all-`absent` privilege matrix
 * (before 042-045 run) is not itself a failure.
 *
 * @param {import("pg").Client | import("pg").PoolClient} client
 */
export async function outboundPreflight(client) {
  const tenantWalk = await outboundTenantWalk(client);
  const privileges = await outboundPrivileges(client);
  return { tenantWalk, privileges };
}
