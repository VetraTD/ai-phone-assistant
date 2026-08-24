#!/usr/bin/env node
/**
 * C7 — prove a Cloud SQL backup actually restores. Evidence for §164.308(a)(7).
 *
 *   gcloud sql backups list --instance=vetra-us-staging --project=<p>
 *   gcloud sql backups restore <BACKUP> --restore-instance=<SCRATCH> ...
 *   gcloud run jobs execute vetra-migrate-us-staging \
 *     --args=scripts/c7-restore-parity.js \
 *     --update-env-vars=C7_RESTORED_INSTANCE=<project:region:SCRATCH> \
 *     --region=us-central1 --project=vetra-us-staging-c3a3bd --wait
 *   gcloud sql instances delete <SCRATCH>          # stop the meter
 *
 * Local rehearsal, two databases on the same server:
 *   DATABASE_URL=…/vetra C7_RESTORED_URL=…/vetra_restore_probe node scripts/c7-restore-parity.js
 *
 * ---------------------------------------------------------------------------
 * WHAT C7 IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * §164.308(a)(7)(ii)(D) asks for TESTING of the contingency plan. The plan for
 * this system is "if the database dies, restore it from its automated backups",
 * so the thing under test is the BACKUP — a managed, instance-level artefact.
 *
 * This is NOT D3. D3 runs a cross-vendor logical `pg_dump` from Supabase into
 * `pg_restore`, which proves the data MOVED. A successful D3 says nothing about
 * whether a Cloud SQL backup restores, because it exercises a different source
 * and a different mechanism. The ledger recommended merging them and that
 * recommendation was wrong; this script is what makes C7 standalone.
 *
 * It also means C7 needs no production and no `terraform apply`: staging has
 * been taking automated backups since B2, and `gcloud sql backups restore`
 * creates the scratch instance directly. A db-g1-small for an hour is pennies.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THAT WOULD MAKE THIS REPORT A CATASTROPHE THAT DID NOT HAPPEN
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is `SELECT count(*)` per table on both sides.
 * ON CLOUD SQL THAT RETURNS ZERO FOR EVERY TENANT-SCOPED TABLE, on a database
 * that is completely intact.
 *
 * The migrate job connects as `postgres`, which on Cloud SQL is a
 * `cloudsqlsuperuser` with `rolbypassrls = false` — Google keeps BYPASSRLS for
 * `cloudsqladmin` alone — and migration 029 uses FORCE ROW LEVEL SECURITY,
 * which applies to the table OWNER too. So an unscoped count as `postgres` sees
 * nothing, reports success, and this script would announce that the restore
 * lost every row in the database.
 *
 * That is the same silent-refusal shape the ledger has now recorded four times:
 * an unscoped read under FORCE RLS returns zero rows and reports success, and
 * "I cannot see any rows" is indistinguishable from "there are no rows".
 *
 * So rows are counted PER TENANT, with `app.business_id` set, which satisfies
 * the policy instead of trying to evade it. Tenants are enumerated from
 * `business_directory` — the routing table that deliberately carries no RLS,
 * used for exactly what it is for. That is also better evidence than a global
 * count: it shows each tenant's data survived, which is what a covered entity
 * cares about, rather than a single number that a busy table can mask.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL THAT MATTERS MOST: ARE THESE TWO DIFFERENT DATABASES?
 * ---------------------------------------------------------------------------
 *
 * If `C7_RESTORED_INSTANCE` is misconfigured and resolves to the SOURCE, every
 * comparison in this file passes perfectly, because a database is identical to
 * itself. That is the vacuous pass this project keeps rediscovering — three
 * signature tests that agreed for months while the validator refused
 * everything, a credential gate checking an empty project, a cross-tenant probe
 * whose "pass" came from a tenant that could not read its OWN rows.
 *
 * So before comparing anything it establishes that the two connections reach
 * DIFFERENT servers, by configuration and by asking each server, and refuses to
 * report a pass otherwise.
 *
 * ---------------------------------------------------------------------------
 * DRIFT IS EXPECTED AND IS NOT A FAILURE
 * ---------------------------------------------------------------------------
 *
 * The source is live and keeps answering calls; the backup is a point in time.
 * So the restored side having FEWER rows than the source is normal and says
 * only that time passed. What is NOT normal, and what this actually asserts:
 *
 *   restored > source            impossible from a backup of that source
 *   source > 0 and restored = 0  a table that did not come back
 *   schema differs               the restore produced a different database
 *   RLS flags or policies differ a restore that returned the data UNPROTECTED
 *
 * The last one is the one nobody checks. A restore that brings back every row
 * and loses `relforcerowsecurity` has produced a readable copy of everyone's
 * PHI, and a row-count check would call that a complete success.
 */

import { pathToFileURL } from "node:url";
import pg from "pg";
import { connect } from "./migrate.js";
import { cloudSqlConfig, cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";
import { schemaFingerprint } from "../lib/db/schemaFingerprint.js";

const results = [];
function record(area, name, pass, detail) {
  results.push({ area, name, pass, detail });
  const tag = pass === true ? " ok " : pass === null ? "note" : "FAIL";
  console.log(`[${tag}] ${area} :: ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Open the RESTORED side.
 *
 * Reuses `cloudSqlConfig` with a synthetic env rather than re-deriving how to
 * reach a Cloud SQL instance — same reason migrate.js exports `connect` and
 * eval/run.js stopped carrying its own copy of getClient's rules. The restored
 * instance is a restore OF the source, so it carries the same database name,
 * the same users and the same password; only the instance name differs.
 */
async function connectRestored() {
  const localUrl = (process.env.C7_RESTORED_URL || "").trim();
  if (localUrl) {
    const client = new pg.Client({ connectionString: localUrl });
    await client.connect();
    return { client, close: () => client.end(), describe: new URL(localUrl).hostname + new URL(localUrl).pathname };
  }

  const instance = (process.env.C7_RESTORED_INSTANCE || "").trim();
  if (!instance) {
    throw new Error(
      "Set C7_RESTORED_INSTANCE to the scratch instance's connection name " +
        "(project:region:instance), or C7_RESTORED_URL for a local rehearsal."
    );
  }
  const cfg = cloudSqlConfig({ ...process.env, CLOUD_SQL_INSTANCE: instance });
  const { poolConfig, close } = await cloudSqlPoolConfig(cfg);
  const client = new pg.Client(poolConfig);
  await client.connect();
  return {
    client,
    close: async () => {
      await client.end();
      close();
    },
    describe: `${cfg.instance} db=${cfg.database} as ${cfg.user}`,
  };
}

/**
 * Who am I talking to? Catalogue only, so row-level security cannot filter it.
 *
 * `pg_control_system()` is superuser-gated and Cloud SQL's `postgres` may or
 * may not be allowed it, so it is asked for separately and its absence is not
 * an error — the identity check below does not depend on it. A hard failure
 * here would block C7 over a diagnostic nicety.
 */
async function identify(client) {
  const r = await client.query(`
    SELECT current_database()               AS db,
           inet_server_addr()::text         AS addr,
           pg_postmaster_start_time()::text AS started`);
  const out = r.rows[0];
  try {
    const sys = await client.query("SELECT system_identifier::text AS sysid FROM pg_control_system()");
    out.sysid = sys.rows[0].sysid;
  } catch {
    out.sysid = "(not permitted)";
  }
  return out;
}

/** The migration head, which says WHICH version of the schema this is. */
async function migrationHead(client) {
  const r = await client.query(`
    SELECT count(*)::int AS applied,
           coalesce(max(version), '(none)') AS head
      FROM schema_migrations`);
  return r.rows[0];
}

/**
 * Row counts per tenant per table, under a scope the policy accepts.
 *
 * Returns a Map of "table" -> total, plus the per-tenant detail, plus the list
 * of tenants it managed to enumerate — because a count over ZERO tenants is
 * zero, and that number must never be mistaken for evidence.
 */
async function tenantRowCounts(client) {
  // BOTH routing tables, because they cover different populations: a clinic
  // with a dialled number but no staff account yet appears only in
  // business_directory, and one whose number has not been provisioned appears
  // only in user_directory. Measured locally, business_directory alone found
  // 1 of 3 tenants — a count that would have looked like a clean pass while
  // silently ignoring two thirds of the database.
  const tenants = await client.query(`
    SELECT DISTINCT id FROM (
      SELECT business_id::text AS id FROM business_directory
      UNION
      SELECT business_id::text AS id FROM user_directory
    ) t ORDER BY 1`);
  const ids = tenants.rows.map((r) => r.id);

  // How many tenants EXIST, asked of the catalogue so FORCE RLS cannot filter
  // it. reltuples is an estimate and is used only to say whether the
  // enumeration above is plausibly complete — never as a count.
  const est = await client.query(
    "SELECT greatest(reltuples, 0)::int AS n FROM pg_class WHERE relname = 'businesses'"
  );
  const estimated = est.rows[0]?.n ?? 0;

  const tables = await client.query(`
    SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'public'
                      AND col.table_name = c.relname
                      AND col.column_name = 'business_id')
     ORDER BY 1`);

  const totals = new Map();
  for (const { name } of tables.rows) {
    let total = 0;
    for (const id of ids) {
      await client.query("SELECT set_config('app.business_id', $1, false)", [id]);
      const r = await client.query(`SELECT count(*)::int AS n FROM "${name}" WHERE business_id = $1`, [id]);
      total += r.rows[0].n;
    }
    totals.set(name, total);
  }
  await client.query("SELECT set_config('app.business_id', '', false)");
  return { tenants: ids, totals, estimated };
}

/** An instance connection name is safe to print. A libpq URL is not. */
function describeTarget(instance, url) {
  if (instance) return instance;
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

function diffKeyed(a, b, label) {
  const onlyA = [...a.keys()].filter((k) => !b.has(k));
  const onlyB = [...b.keys()].filter((k) => !a.has(k));
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  const ok = !onlyA.length && !onlyB.length && !changed.length;
  return {
    ok,
    detail: ok
      ? `${a.size} ${label} identical`
      : `only on source: [${onlyA}] · only on restored: [${onlyB}] · differing: [${changed}]`,
  };
}

async function main() {
  const source = await connect();
  let restored;
  try {
    restored = await connectRestored();
  } catch (err) {
    console.error(`\nCannot reach the restored instance: ${err.message}`);
    await source.close();
    process.exitCode = 1;
    return;
  }

  console.log(`\nC7 restore parity\n  source:   ${source.describe}\n  restored: ${restored.describe}\n`);

  try {
    // ------------------------------------------------------------------
    // 0. Are these two DIFFERENT databases? Everything below is vacuous
    //    otherwise, and vacuous in the direction that reports success.
    // ------------------------------------------------------------------
    const srcId = await identify(source.client);
    const dstId = await identify(restored.client);
    console.log(`  source   ${JSON.stringify(srcId)}`);
    console.log(`  restored ${JSON.stringify(dstId)}\n`);

    const namedSame =
      (process.env.C7_RESTORED_INSTANCE || "").trim() === (process.env.CLOUD_SQL_INSTANCE || "").trim() &&
      !process.env.C7_RESTORED_URL;
    const looksSame = srcId.addr === dstId.addr && srcId.started === dstId.started && srcId.db === dstId.db;
    const distinct = !namedSame && !looksSame;
    // Say WHAT distinguished them. The first version printed
    // "different (172.20.0.2 vs 172.20.0.2)" during a local rehearsal, where
    // the two databases share a server and only the database name differs —
    // a line that asserts a difference while displaying two identical values
    // is exactly the kind of evidence nobody rereads.
    const differsBy = [
      srcId.db !== dstId.db ? `database (${srcId.db} vs ${dstId.db})` : null,
      srcId.addr !== dstId.addr ? `address (${srcId.addr} vs ${dstId.addr})` : null,
      srcId.started !== dstId.started ? "postmaster start time" : null,
      srcId.sysid !== dstId.sysid ? "system identifier" : null,
    ].filter(Boolean);
    record(
      "preflight",
      "source and restored are not the same database",
      distinct,
      distinct
        ? `differs by ${differsBy.join(", ")}`
        : "THE SAME DATABASE ON BOTH SIDES — every comparison below would pass by definition"
    );
    if (!distinct) throw new Error("refusing to report parity between a database and itself");

    // ------------------------------------------------------------------
    // 1. Is the SOURCE worth comparing against? A restore that matches an
    //    empty source is not evidence of anything.
    // ------------------------------------------------------------------
    const srcCounts = await tenantRowCounts(source.client);
    const srcTotal = [...srcCounts.totals.values()].reduce((a, b) => a + b, 0);
    record(
      "preflight",
      "the source holds data to compare",
      srcCounts.tenants.length > 0 && srcTotal > 0,
      `${srcCounts.tenants.length} tenant(s), ${srcTotal} row(s) across ${srcCounts.totals.size} tables`
    );
    if (!srcCounts.tenants.length || srcTotal === 0) {
      throw new Error("the source is empty or no tenant could be enumerated — parity would be meaningless");
    }

    // ------------------------------------------------------------------
    // 2. Schema, RLS flags, policies, functions, triggers, grants.
    // ------------------------------------------------------------------
    const a = await schemaFingerprint(source.client);
    const b = await schemaFingerprint(restored.client);

    // Name what differs. "15 vs 15 tables" beside a FAIL is a line that tells
    // the reader nothing and invites them to distrust the check rather than
    // the database — the same defect as the address message above.
    const tableSig = (t) => `${t.name}(rls=${t.relrowsecurity},force=${t.relforcerowsecurity})`;
    const aSigs = new Map(a.tables.map((t) => [t.name, tableSig(t)]));
    const bSigs = new Map(b.tables.map((t) => [t.name, tableSig(t)]));
    const tableDiff = diffKeyed(aSigs, bSigs, "tables");
    record("schema", "same tables, with the same RLS flags", tableDiff.ok, tableDiff.detail);
    record("schema", "same columns", JSON.stringify(a.columns) === JSON.stringify(b.columns),
      `${a.columns.length} vs ${b.columns.length}`);
    for (const [label, key] of [["functions", "functions"], ["triggers", "triggers"], ["policies", "policies"]]) {
      const d = diffKeyed(a[key], b[key], label);
      record("schema", `same ${label}`, d.ok, d.detail);
    }
    record("schema", "same vetra_app grants", JSON.stringify(a.grants) === JSON.stringify(b.grants),
      `${a.grants.length} vs ${b.grants.length}`);

    // The one a row-count check would call a success: everything came back,
    // and came back readable by anyone.
    const unprotected = b.tables.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity)
      .map((t) => t.name)
      .filter((n) => a.tables.find((x) => x.name === n)?.relforcerowsecurity);
    record(
      "schema",
      "the restore did not return any table UNPROTECTED",
      unprotected.length === 0,
      unprotected.length ? `RLS lost on: ${unprotected.join(", ")}` : "every forced table is still forced"
    );

    // ------------------------------------------------------------------
    // 3. Migration head.
    // ------------------------------------------------------------------
    const srcHead = await migrationHead(source.client);
    const dstHead = await migrationHead(restored.client);
    record(
      "migrations",
      "same migration head",
      srcHead.head === dstHead.head && srcHead.applied === dstHead.applied,
      `source ${srcHead.applied} applied, head ${srcHead.head} · restored ${dstHead.applied}, head ${dstHead.head}`
    );

    // ------------------------------------------------------------------
    // 4. The rows. Drift downward is expected; the other directions are not.
    // ------------------------------------------------------------------
    const dstCounts = await tenantRowCounts(restored.client);
    record(
      "rows",
      "the same tenants came back",
      JSON.stringify(srcCounts.tenants) === JSON.stringify(dstCounts.tenants),
      `source ${srcCounts.tenants.length} · restored ${dstCounts.tenants.length}`
    );

    console.log("\n  table                          source   restored   delta");
    let impossible = 0;
    let vanished = 0;
    for (const [name, srcN] of [...srcCounts.totals].sort()) {
      const dstN = dstCounts.totals.get(name) ?? 0;
      const delta = dstN - srcN;
      if (delta > 0) impossible++;
      if (srcN > 0 && dstN === 0) vanished++;
      console.log(
        `  ${name.padEnd(28)} ${String(srcN).padStart(6)} ${String(dstN).padStart(10)} ${String(delta).padStart(7)}`
      );
    }
    console.log();

    record(
      "rows",
      "no table has MORE rows than its source",
      impossible === 0,
      impossible ? `${impossible} table(s) grew, which a backup of this source cannot produce` : "none grew"
    );
    record(
      "rows",
      "no non-empty table came back empty",
      vanished === 0,
      vanished ? `${vanished} table(s) have rows on the source and none on the restore` : "none vanished"
    );
    // Stated as two totals rather than one signed number: the first version
    // printed "-2 row(s) written since the backup", which is not a thing that
    // can happen and reads as a bug in the report rather than in the restore.
    const srcSum = [...srcCounts.totals.values()].reduce((x, y) => x + y, 0);
    const dstSum = [...dstCounts.totals.values()].reduce((x, y) => x + y, 0);
    record(
      "rows",
      "drift between the backup and now",
      null,
      dstSum <= srcSum
        ? `source ${srcSum}, restored ${dstSum} — ${srcSum - dstSum} row(s) written since the backup, which is expected on a live source`
        : `source ${srcSum}, restored ${dstSum} — THE RESTORE IS AHEAD OF ITS SOURCE, see the failure above`
    );

    // Coverage, stated rather than implied: a tenant in neither routing table
    // is not counted anywhere above, and a report that does not say so is
    // claiming completeness it does not have.
    if (srcCounts.estimated > srcCounts.tenants.length) {
      record(
        "rows",
        "tenants NOT covered by these counts",
        null,
        `enumerated ${srcCounts.tenants.length} from the routing tables, but pg_class estimates ` +
          `~${srcCounts.estimated} businesses — a tenant with neither a dialled number nor a staff ` +
          "account appears in neither directory and its rows are not counted here"
      );
    }
  } catch (err) {
    console.error(`\nABORTED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await source.close().catch(() => {});
    await restored.close().catch(() => {});
  }

  const fails = results.filter((r) => r.pass === false);
  const passes = results.filter((r) => r.pass === true);
  console.log(`\n${passes.length} passed, ${fails.length} failed, ${results.filter((r) => r.pass === null).length} noted.`);
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(`  ${f.area} :: ${f.name} — ${f.detail}`);
  }
  // Paste this into the ledger. "Once, documented" is half the requirement.
  //
  // REDACTED, because the first version printed C7_RESTORED_URL verbatim and a
  // libpq URL carries the password in it — on a line whose entire purpose is to
  // be copied into a file. An instance connection name is not a credential; a
  // connection string is.
  console.log(
    `\nEVIDENCE LINE: restore parity ${fails.length ? "FAILED" : "PASSED"} — ` +
      `${passes.length}/${passes.length + fails.length} checks · ` +
      `source ${describeTarget(process.env.CLOUD_SQL_INSTANCE, process.env.DATABASE_URL)} · ` +
      `restored ${describeTarget(process.env.C7_RESTORED_INSTANCE, process.env.C7_RESTORED_URL)}`
  );
  if (fails.length) process.exitCode = 1;
}

// Guarded so the Cloud Build smoke step can IMPORT this file to prove its whole
// module tree resolves inside the image, without running it against a database.
// Same shape as scripts/migrate.js and eval/run.js — and the reason it matters
// here is that these two scripts are the ONLY things in the image that nothing
// else imports, so a forgotten COPY would surface as "Cannot find module" in
// front of the owner during a scheduled verification rather than in a build.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
