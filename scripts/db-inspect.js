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

// STAGING ONLY, and the reason is sharper now than when this file was
// read-only facts about roles.
//
// The transcript dump below prints what a caller SAID. On staging that is a
// synthetic clinic and the owner's own test calls; in production it would be
// patient speech, and Cloud Logging is not where that belongs. The whole
// design keeps transcripts in the database and out of logs.
if (!/staging/i.test(cfg.database) || !/staging/i.test(cfg.instance)) {
  console.error(
    `Refusing to inspect: this does not look like staging.
` +
      `  CLOUD_SQL_DATABASE = ${JSON.stringify(cfg.database)}
` +
      `  CLOUD_SQL_INSTANCE = ${JSON.stringify(cfg.instance)}
` +
      "This prints transcript text, which in production is patient speech."
  );
  process.exit(1);
}

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);

// One line per fact, no leading newline and no leading whitespace.
//
// Cloud Logging dropped every indented continuation line of the first version:
// the seven section headers arrived and not one row did, which reads as "every
// query returned nothing" rather than "the log shipper ate the answers". The
// seed script's unindented output had always come through fine.
//
// A diagnostic whose failure mode is silently losing its results is worse than
// no diagnostic at all.
const show = (label, rows) => {
  if (!rows.length) {
    console.log(`[inspect] ${label}: (none)`);
    return;
  }
  for (const r of rows) console.log(`[inspect] ${label}: ${JSON.stringify(r)}`);
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

  // ---------------------------------------------------------------------
  // What the receptionist actually HEARD.
  //
  // The question this exists to answer: a caller says "Nithin" and the bot
  // says "Nathan". Did speech-to-text mishear it, or did it hear correctly and
  // text-to-speech pronounce it wrong? Those are different subsystems with
  // different fixes, and no amount of listening distinguishes them — only the
  // stored transcript does.
  //
  // Scoped, because call_transcripts is under FORCE row-level security like
  // everything else. Unscoped this returns zero rows and looks like "no
  // transcripts exist".
  // ---------------------------------------------------------------------
  const biz = await pool.query(
    `SELECT id FROM app_lookup_business_by_phone('+18176326969')`
  );
  if (!biz.rows.length) {
    show("recent transcripts", []);
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [biz.rows[0].id]);
      const rows = await client.query(
        `SELECT c.created_at, t.speaker, t.message
           FROM call_transcripts t JOIN calls c ON c.id = t.call_id
          ORDER BY c.created_at DESC, t.sequence ASC
          LIMIT 40`
      );
      await client.query("COMMIT");
      show(
        "recent transcripts (newest call first)",
        rows.rows.map((r) => ({ speaker: r.speaker, message: r.message }))
      );
    } finally {
      client.release();
    }
  }
} catch (err) {
  console.error("inspect failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await pool.end();
  await close?.();
}
