#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Close out appointments left `scheduled` in the PAST.
//
//   gcloud run jobs execute vetra-migrate-uk-prod \
//     --args=scripts/close-stale-appointments.js,--business,+18176011171
//   ...and again with ,--apply once the dry run reads right.
//
// ---------------------------------------------------------------------------
// Why this exists, and why it is a script rather than a migration
// ---------------------------------------------------------------------------
//
// A row with `status = 'scheduled'` and a time in the past is read by
// availability arithmetic as if it were still coming. LVX137's audit found one
// on 2026-09-17 -- `2026-09-14T21:00Z`, three days gone -- and it was still
// there on 2026-09-20, six days gone, because nothing sweeps them and nothing
// could: `db-inspect` is read-only by design and Cloud SQL is private-IP only,
// so there has never been a way to touch a row from outside the VPC.
//
// NOT a migration. Migrations are checksummed, permanent, and run on every
// database; this is a data correction for ONE tenant that should leave no trace
// in a schema history. The three-tier rule this repository already follows --
// infrastructure is Terraform, schema is migrations, rows are scripts -- puts
// it here.
//
// ---------------------------------------------------------------------------
// What it refuses to do
// ---------------------------------------------------------------------------
//
// DRY RUN BY DEFAULT. It prints what it would change and exits 0 without
// writing. `--apply` is the only thing that writes, and it is deliberately not
// the default: a destructive default in a job whose arguments are typed by hand
// into a gcloud command is how the wrong tenant gets edited.
//
// ONE TENANT, ALWAYS. `--business` is required and is resolved through
// `app_lookup_business_by_phone`, the same function db-inspect uses, and every
// statement runs inside a transaction with `app.business_id` set. The service
// runs as a NOBYPASSRLS role, so a tenantless write matches zero rows and
// reports success -- which is exactly the failure this scoping prevents.
//
// PAST AND SCHEDULED ONLY. `scheduled_at < now()` and `status = 'scheduled'`
// are both in the WHERE clause. A future appointment can never match, whatever
// else is passed.
//
// CANCELLED, NOT DELETED. The row stays, with the status every other closed row
// on the tenant already carries, so the change is visible and reversible. A
// DELETE here would be irreversible from a job nobody can see the output of
// until it has finished.
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

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const BUSINESS = argOf("business");
const APPLY = argv.includes("--apply");

if (!BUSINESS) {
  console.error(
    "Refusing: --business <e164> is required.\n" +
      "  --args=scripts/close-stale-appointments.js,--business,+18176011171\n" +
      "Add ,--apply to write. Without it this is a dry run."
  );
  process.exit(1);
}
// E.164 only. A phone number reaches a SQL function argument, so it is checked
// rather than trusted -- db-inspect draws the same line for the same reason.
if (!/^\+[1-9]\d{6,14}$/.test(BUSINESS)) {
  console.error(`Refusing: --business ${JSON.stringify(BUSINESS)} is not an E.164 number.`);
  process.exit(1);
}

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);

// One line per fact, unindented. Cloud Logging drops indented continuation
// lines, which once ate every row of a diagnostic and read as "the query
// returned nothing" rather than "the log shipper lost the answer".
const show = (label, rows) => {
  if (!rows.length) {
    console.log(`[stale] ${label}: (none)`);
    return;
  }
  for (const r of rows) console.log(`[stale] ${label}: ${JSON.stringify(r)}`);
};

let exitCode = 0;
try {
  const who = await pool.query(`SELECT id, name FROM app_lookup_business_by_phone($1)`, [BUSINESS]);
  const businessId = who.rows[0]?.id ?? null;
  if (!businessId) {
    console.error(`Refusing: no business routes to ${BUSINESS} on this database.`);
    process.exit(1);
  }
  console.log(`[stale] tenant: ${JSON.stringify({ id: businessId, name: who.rows[0]?.name })}`);
  console.log(`[stale] mode: ${APPLY ? "APPLY -- rows will be written" : "dry run -- nothing will be written"}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);

    // Printed BEFORE anything changes, and the same predicate the update uses.
    // A dry run that describes a different set from the one the apply would
    // touch is worse than no dry run at all.
    const found = await client.query(
      `SELECT right(id::text, 6) AS id_tail, scheduled_at, created_at
         FROM appointments
        WHERE status = 'scheduled' AND scheduled_at < now()
        ORDER BY scheduled_at`
    );
    show("would close", found.rows);
    console.log(`[stale] count: ${found.rowCount}`);

    if (APPLY && found.rowCount > 0) {
      const done = await client.query(
        `UPDATE appointments
            SET status = 'cancelled'
          WHERE status = 'scheduled' AND scheduled_at < now()
        RETURNING right(id::text, 6) AS id_tail, scheduled_at`
      );
      show("closed", done.rows);
      console.log(`[stale] updated: ${done.rowCount}`);
      await client.query("COMMIT");
    } else {
      // A dry run rolls back rather than committing nothing, so the transaction
      // boundary is identical on both paths and there is no branch in which a
      // half-applied change could survive.
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error(`[stale] failed: ${err?.message}`);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  await close?.().catch?.(() => {});
}
process.exit(exitCode);
