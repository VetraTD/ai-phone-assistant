/**
 * One description of "what this database IS", asked of Postgres rather than of
 * the files that were supposed to build it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED
 * ---------------------------------------------------------------------------
 *
 * Two things need it and they must not disagree:
 *
 *   tests/db/schemaParity.test.js  a scratch database built from schema.sql vs
 *                                  the migrated one, so a migration that was
 *                                  never folded back into schema.sql cannot
 *                                  produce a fresh install silently a version
 *                                  behind — the D3 restore path.
 *
 *   scripts/c7-restore-parity.js   a RESTORED instance vs the instance its
 *                                  backup came from, which is C7's evidence
 *                                  for §164.308(a)(7).
 *
 * Both ask the same question — are these two databases the same thing — and a
 * second copy of the answer would drift from the first. This repository has
 * paid for that class twice already: a GEMINI_API_KEY check duplicated above
 * getClient, and a permission asserted in a comment that the role beneath it
 * did not grant.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY INCLUDES
 * ---------------------------------------------------------------------------
 *
 * `pg_get_functiondef` and `pg_get_triggerdef` render objects as Postgres
 * itself understands them, so whitespace and comments cannot cause a false
 * difference and a CHANGED BODY cannot hide behind one. That matters more here
 * than anywhere: migrations 032, 033 and 034 each replace a bootstrap function
 * whose old body returns zero rows under FORCE row-level security, and a
 * text-level check reading the migration files sees a function that exists and
 * calls it a match.
 *
 * RLS flags and policies are part of the fingerprint on purpose. A restore that
 * brings back every row and loses `relforcerowsecurity` has produced an
 * UNPROTECTED copy of the data, and row counts alone would call that a success.
 *
 * Everything here is catalogue data, so none of it is filtered by row-level
 * security — which is the property that lets this run as `postgres` on Cloud
 * SQL, where that role is a cloudsqlsuperuser with `rolbypassrls = false` and
 * cannot read the TABLES at all.
 */

/** Objects that exist because of HOW a database was built, not what it is. */
export const IGNORED_TABLES = new Set(["schema_migrations"]);

/**
 * @param {import("pg").Client} client
 * @param {Set<string>} [ignore]
 * @returns {Promise<{tables: Array, columns: string[], functions: Map, triggers: Map, policies: Map, grants: string[]}>}
 */
export async function schemaFingerprint(client, ignore = IGNORED_TABLES) {
  const tables = await client.query(`
    SELECT c.relname AS name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY 1`);

  const columns = await client.query(`
    SELECT table_name || '.' || column_name || ' ' || data_type ||
           CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END AS sig
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY 1`);

  const functions = await client.query(`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY 1, 2`);

  const triggers = await client.query(`
    SELECT c.relname || '.' || t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1`);

  const policies = await client.query(`
    SELECT tablename || '.' || policyname AS name,
           coalesce(qual, '') || ' | ' || coalesce(with_check, '') AS def
      FROM pg_policies WHERE schemaname = 'public'
     ORDER BY 1`);

  const grants = await client.query(`
    SELECT table_name || ' ' || privilege_type AS sig
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = 'vetra_app'
     ORDER BY 1`);

  const keep = (n) => !ignore.has(n.split(/[. ]/)[0]);

  return {
    tables: tables.rows.filter((r) => keep(r.name)),
    columns: columns.rows.map((r) => r.sig).filter(keep),
    functions: new Map(functions.rows.map((r) => [r.name, r.def])),
    triggers: new Map(triggers.rows.filter((r) => keep(r.name)).map((r) => [r.name, r.def])),
    policies: new Map(policies.rows.filter((r) => keep(r.name)).map((r) => [r.name, r.def])),
    grants: grants.rows.map((r) => r.sig).filter(keep),
  };
}
