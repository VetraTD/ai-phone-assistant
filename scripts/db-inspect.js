#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Read-only database facts, for questions that cannot be answered from a
// workstation.
//
//   gcloud run jobs execute vetra-migrate-us-staging --args=scripts/db-inspect.js
//
// The Cloud SQL instances are private-IP only, so there is no psql from here.
// Every question about what the REAL database allows — as opposed to what the
// local dev container allows — has to be asked from inside the VPC.
//
// It exists because a whole class of defect in this codebase comes from the
// local database being MORE permissive than Cloud SQL: local `vetra` is a
// superuser with BYPASSRLS and owns every function, so SECURITY DEFINER sails
// past row-level security that would stop it in production. Two bootstrap
// functions were broken that way and nothing caught it.
//
// STRICTLY READ-ONLY. No DDL, no writes. It answers questions; changing things
// is a migration's job.
// ---------------------------------------------------------------------------

import pg from "pg";
import { cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";

const cfg = {
  instance: process.env.CLOUD_SQL_INSTANCE,
  database: process.env.CLOUD_SQL_DATABASE,
  user: process.env.CLOUD_SQL_IAM_USER,
  password: process.env.CLOUD_SQL_PASSWORD,
  authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
};

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);

const show = (label, rows) => {
  console.log(`\n--- ${label}`);
  for (const r of rows) console.log("   " + JSON.stringify(r));
  if (!rows.length) console.log("   (none)");
};

try {
  show("connected as", (await pool.query("SELECT current_user, current_database()")).rows);

  // THE QUESTION THIS WAS BUILT FOR. Postgres requires you to HAVE bypassrls
  // (or be superuser) in order to CREATE a role that has it. If the connecting
  // role has neither, a "give the bootstrap functions a BYPASSRLS owner" fix is
  // simply unavailable on Cloud SQL and the design has to avoid bypassing at all.
  show(
    "role attributes of the connecting user",
    (
      await pool.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
           FROM pg_roles WHERE rolname = current_user`
      )
    ).rows
  );

  show(
    "roles that CAN bypass row-level security",
    (await pool.query(`SELECT rolname FROM pg_roles WHERE rolbypassrls OR rolsuper ORDER BY rolname`)).rows
  );

  show(
    "owners of the bootstrap functions, and whether they bypass RLS",
    (
      await pool.query(
        `SELECT p.proname, r.rolname AS owner, r.rolsuper, r.rolbypassrls, p.prosecdef AS security_definer
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname IN ('app_lookup_business_by_phone','app_create_business_for_user','app_business_capabilities','app_lookup_user_by_email')
          ORDER BY p.proname`
      )
    ).rows
  );

  show(
    "tables with FORCE row level security",
    (
      await pool.query(
        `SELECT relname FROM pg_class
          WHERE relforcerowsecurity AND relkind = 'r' ORDER BY relname`
      )
    ).rows
  );

  // Proof of the live symptom, not an argument about it: does the read
  // bootstrap actually return the seeded business?
  show(
    "app_lookup_business_by_phone('+18176326969') with no tenant scope",
    (await pool.query(`SELECT count(*)::int AS rows_returned FROM app_lookup_business_by_phone('+18176326969')`)).rows
  );

  // And is the row really there, seen from a scope that can see it?
  const id = await pool.query(
    `SELECT id FROM businesses WHERE phone_number = '+18176326969'`
  );
  show("direct select on businesses (also RLS-bound, so 0 is expected)", [{ rows: id.rows.length }]);
} catch (err) {
  console.error("inspect failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await pool.end();
  await close?.();
}
