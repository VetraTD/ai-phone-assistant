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

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // Session-level, so a crashed runner releases it when the connection dies
    // rather than wedging every future run.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);

    if (args.includes("--reset")) {
      if (!isObviouslyLocal(url)) {
        console.error(`Refusing --reset against ${new URL(url).hostname}. This flag is for local databases.`);
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
      return;
    }

    for (const m of pending) {
      const ms = await applyOne(client, m);
      console.log(`applied ${m.file} (${ms}ms)`);
    }
    console.log(`${pending.length} migration(s) applied.`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
