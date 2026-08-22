#!/usr/bin/env node
/**
 * Migration runner for database/NNN_*.sql.
 *
 * ---------------------------------------------------------------------------
 * Why this and not node-pg-migrate
 * ---------------------------------------------------------------------------
 *
 * Writing a migration runner is usually a mistake, so the reasons are here to
 * be argued with rather than assumed.
 *
 *   1. The migrations already exist, as 26 plain-SQL files with a strict
 *      numeric prefix. node-pg-migrate wants `<timestamp>_<name>.sql` with
 *      `-- Up Migration` / `-- Down Migration` markers, so adopting it means
 *      rewriting every one of them — editing history to satisfy a tool, on a
 *      set of files whose whole value is that they are a faithful record.
 *
 *   2. Down-migrations would be fiction. None has ever been written, and one
 *      written now, untested, is worse than none: it is a rollback that looks
 *      available and is not.
 *
 *   3. CHECKSUMS, which node-pg-migrate does not do, are the feature this
 *      repository actually needs. Its live failure mode is drift between what
 *      the files say and what a database contains — schema.sql claimed "002
 *      through 018" for nine migrations past 018. An applied migration that
 *      has since been EDITED is the same defect with a worse blast radius, and
 *      it is invisible to a runner that only records filenames.
 *
 * What is deliberately kept from the grown-up tools: one transaction per
 * migration, a session advisory lock so two runners cannot interleave, and an
 * ordered, append-only ledger table.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   node scripts/migrate.js              apply everything outstanding
 *   node scripts/migrate.js --status     list applied/pending, apply nothing
 *   node scripts/migrate.js --reset      DROP the schema, then apply from zero
 *
 * Reads DATABASE_URL. Refuses --reset against anything that is not obviously
 * local, because "reset the database" is only ever one flag away from being
 * the last thing you do.
 */
import crypto from "crypto";
import { cloudSqlConfig, cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "database");

/** One lock id for this repo's migrations; arbitrary, and it only has to be stable. */
const ADVISORY_LOCK_ID = 8264113;

/**
 * `schema.sql` is the fully-migrated state for a FRESH install, not step one of
 * the sequence. Applying it and then the migrations would double-apply
 * everything. It is handled separately by --reset.
 */
const BASELINE = "schema.sql";

/** @returns {Array<{ version: string, name: string, file: string, sql: string, checksum: string }>} */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f !== BASELINE)
    .filter((f) => /^\d+_/.test(f))
    .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return {
        version: file.split("_")[0],
        name: file.replace(/^\d+_/, "").replace(/\.sql$/, ""),
        file,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )
  `);
  await client.query(
    `COMMENT ON TABLE schema_migrations IS
     'Applied migrations, one row per database/NNN_*.sql. checksum is sha256 of the file as applied: a mismatch means an applied migration was edited afterwards, which the runner refuses rather than silently tolerates.'`
  );
}

/**
 * Compare the ledger against the files on disk.
 * @returns {Promise<{ applied: Map<string, {checksum: string}>, pending: Array, drifted: Array }>}
 */
export async function inspect(client, migrations = loadMigrations()) {
  await ensureLedger(client);
  const { rows } = await client.query("SELECT version, name, checksum FROM schema_migrations");
  const applied = new Map(rows.map((r) => [r.version, r]));

  const pending = [];
  const drifted = [];
  for (const m of migrations) {
    const seen = applied.get(m.version);
    if (!seen) pending.push(m);
    else if (seen.checksum !== m.checksum) drifted.push({ ...m, appliedChecksum: seen.checksum });
  }
  return { applied, pending, drifted };
}

async function applyOne(client, m) {
  const started = Date.now();
  await client.query("BEGIN");
  try {
    await client.query(m.sql);
    await client.query(
      "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
      [m.version, m.name, m.checksum, Date.now() - started]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`${m.file} failed and was rolled back: ${err.message}`);
  }
  return Date.now() - started;
}

function isObviouslyLocal(url) {
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "db"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Two ways to reach a database, and the difference is the whole deployment
 * story.
 *
 * DATABASE_URL          local Docker PG16, the tests/db suites, anything with
 *                       a password. Unchanged, and still the default.
 *
 * CLOUD_SQL_INSTANCE    Cloud SQL over private IP with automatic IAM database
 *                       authentication. NO PASSWORD EXISTS — see
 *                       lib/db/cloudSqlPool.js. This is how the migration job
 *                       running inside the VPC reaches staging and, at D3,
 *                       production.
 *
 * The connector holds a per-instance refresh timer, so `close` is not optional:
 * a Cloud Run Job that skips it succeeds and then hangs until its timeout,
 * which reads as a stuck migration and is not one.
 *
 * @returns {Promise<{ client: import("pg").Client, close: () => Promise<void>, describe: string, isLocal: boolean }>}
 */
async function connect() {
  // Configuration report, before anything can fail on it.
  //
  // A migration that cannot connect gives you one line from `pg` — "client
  // password must be a string", "no pg_hba.conf entry" — and none of them say
  // WHICH setting was missing. Env vars supplied by Cloud Run from Secret
  // Manager are the worst case: a reference that does not resolve produces an
  // empty string, and an empty string looks exactly like a variable nobody set.
  //
  // Lengths, never values. `hasPassword` and a length are enough to tell
  // "resolved" from "silently empty", and neither is a credential.
  console.log(
    "config: " +
      JSON.stringify({
        CLOUD_SQL_INSTANCE: process.env.CLOUD_SQL_INSTANCE || null,
        CLOUD_SQL_IAM_USER: process.env.CLOUD_SQL_IAM_USER || null,
        CLOUD_SQL_DATABASE: process.env.CLOUD_SQL_DATABASE || null,
        hasPassword: Boolean(process.env.CLOUD_SQL_PASSWORD),
        passwordLength: (process.env.CLOUD_SQL_PASSWORD || "").length,
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        grantAppRoleTo: process.env.CLOUD_SQL_GRANT_APP_ROLE_TO || null,
      })
  );

  const cfg = cloudSqlConfig();

  if (cfg) {
    const { poolConfig, close } = await cloudSqlPoolConfig(cfg);
    const client = new pg.Client(poolConfig);
    await client.connect();
    return {
      client,
      close: async () => {
        await client.end();
        close();
      },
      describe: `${cfg.instance} db=${cfg.database} as ${cfg.user} (${cfg.authType === "PASSWORD" ? "password" : "IAM, no password"})`,
      // --reset is refused on Cloud SQL unconditionally. `isObviouslyLocal`
      // inspects a URL hostname and there is no URL here, so the guard it
      // implements would silently not apply — and "reset the database" is only
      // ever one flag away from being the last thing you do.
      isLocal: false,
    };
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Neither DATABASE_URL nor CLOUD_SQL_INSTANCE is set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    client,
    close: () => client.end(),
    describe: new URL(url).hostname,
    isLocal: isObviouslyLocal(url),
  };
}

/**
 * Give the runtime principal `vetra_app`'s privileges, and nothing more.
 *
 * Migration 029 creates `vetra_app` NOSUPERUSER NOBYPASSRLS NOLOGIN and hangs
 * every table grant off it, with a comment saying the login credential belongs
 * in Secret Manager and that "B2/B4 grants login with a real credential".
 *
 * IAM database authentication changes that answer for the better: there is no
 * credential to grant. The runtime connects as its own service-account
 * identity, and role MEMBERSHIP hands it exactly the privileges 029 defined —
 * inherited, so RLS still applies, because the IAM user is not a superuser and
 * does not have BYPASSRLS.
 *
 * The role name cannot live in a migration file: it is a service account email
 * that differs per environment, and a migration is a fixed artefact with a
 * checksum. So it is a parameter, applied after the migrations that define
 * `vetra_app` have run.
 *
 * Idempotent. Runs on every invocation, including ones with nothing to apply,
 * so a grant that was somehow lost is repaired by re-running the job.
 */
async function grantAppRole(client) {
  const grantee = (process.env.CLOUD_SQL_GRANT_APP_ROLE_TO || "").trim();
  if (!grantee) return;

  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", ["vetra_app"]);
  if (!rows.length) {
    console.log("vetra_app does not exist yet; skipping role grant.");
    return;
  }

  // Identifiers cannot be parameterised, and this value comes from the
  // environment, so it is validated rather than trusted. A service account
  // email is a narrow grammar and anything outside it is refused instead of
  // quoted-and-hoped.
  if (!/^[A-Za-z0-9._@-]+$/.test(grantee)) {
    throw new Error(`CLOUD_SQL_GRANT_APP_ROLE_TO contains unexpected characters: ${JSON.stringify(grantee)}`);
  }

  const quoted = `"${grantee.replace(/"/g, '""')}"`;
  await client.query(`GRANT vetra_app TO ${quoted}`);
  console.log(`granted vetra_app to ${grantee}`);
}

async function main() {
  const args = process.argv.slice(2);

  const { client, close, describe, isLocal } = await connect();
  console.log(`connected: ${describe}`);

  try {
    // Session-level, so a crashed runner releases it when the connection dies
    // rather than wedging every future run.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);

    if (args.includes("--reset")) {
      if (!isLocal) {
        console.error(`Refusing --reset against ${describe}. This flag is for local databases.`);
        process.exit(1);
      }
      console.log("Dropping and recreating schema public…");
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      // The baseline is the fully-migrated state, so it stands in for the whole
      // sequence. Recorded as applied so a later `migrate` is a no-op rather
      // than a double-apply.
      const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE), "utf8");
      await client.query(baseline);
      await ensureLedger(client);
      for (const m of loadMigrations()) {
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING",
          [m.version, m.name, m.checksum]
        );
      }
      console.log(`schema.sql applied; ${loadMigrations().length} migrations recorded as baseline.`);
      return;
    }

    // -----------------------------------------------------------------------
    // --init-if-empty: the ONLY safe way to bring up a brand-new database.
    //
    // The ledger records this as a trap and it fired exactly as written:
    // `002_business_config.sql failed and was rolled back: relation
    // "businesses" does not exist`. The migrations move an EXISTING database
    // forward; they are not a from-zero install. `schema.sql` is the from-zero
    // install, and running it and then the migrations double-applies.
    //
    // `--reset` already knows how to do this, but it starts with
    // `DROP SCHEMA public CASCADE` and is refused anywhere non-local for
    // exactly the reason you would hope.
    //
    // So: same baseline behaviour, no DROP, and a precondition that makes it
    // harmless — it refuses the moment the database contains a single user
    // table. On an empty database there is nothing to destroy; on a populated
    // one it declines and falls through to ordinary migration. That makes one
    // command correct both for a fresh Cloud SQL instance today and for D3,
    // where `pg_restore` lands the data first and only the pending migrations
    // should follow.
    // -----------------------------------------------------------------------
    if (args.includes("--init-if-empty")) {
      // `schema_migrations` is excluded, and leaving it in cost a run. A
      // FAILED migration still calls `ensureLedger`, so the runner's own
      // bookkeeping table survives the rollback — and on the next attempt a
      // database containing nothing but that table counted as "already has 1
      // table", skipped the baseline, and failed at 002 all over again.
      //
      // The ledger table is this tool's artefact, not schema. Emptiness means
      // "no APPLICATION tables", and it is also checked against the ledger's
      // own contents: rows there mean migrations really have run, whatever the
      // table list says.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`
      );
      const tableCount = rows[0].n;

      const ledgerRows = await client
        .query("SELECT count(*)::int AS n FROM schema_migrations")
        .then((r) => r.rows[0].n)
        .catch(() => 0);

      if (tableCount === 0 && ledgerRows === 0) {
        console.log("database is empty; applying schema.sql as the baseline.");
        const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE), "utf8");
        await client.query(baseline);
        await ensureLedger(client);
        const all = loadMigrations();
        for (const m of all) {
          await client.query(
            "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING",
            [m.version, m.name, m.checksum]
          );
        }
        console.log(`schema.sql applied; ${all.length} migrations recorded as baseline.`);
        await grantAppRole(client);
        return;
      }

      console.log(
        `database already has ${tableCount} application table(s) and ${ledgerRows} ledger row(s); ` +
          "skipping baseline, migrating normally."
      );
    }

    const { applied, pending, drifted } = await inspect(client);

    if (drifted.length) {
      console.error("An already-applied migration has been EDITED since it ran:");
      for (const d of drifted) console.error(`  ${d.file}  applied ${d.appliedChecksum.slice(0, 12)} … file ${d.checksum.slice(0, 12)}`);
      console.error("\nThe database and the file no longer agree, and the runner cannot tell which is right.");
      console.error("Write a NEW migration for the change, or reset a local database with --reset.");
      process.exit(1);
    }

    if (args.includes("--status")) {
      console.log(`applied: ${applied.size}`);
      for (const m of pending) console.log(`pending: ${m.file}`);
      if (!pending.length) console.log("pending: none");
      return;
    }

    if (!pending.length) {
      console.log("Nothing to apply.");
      await grantAppRole(client);
      return;
    }

    for (const m of pending) {
      const ms = await applyOne(client, m);
      console.log(`applied ${m.file} (${ms}ms)`);
    }
    console.log(`${pending.length} migration(s) applied.`);
    await grantAppRole(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]).catch(() => {});
    await close();
  }
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
