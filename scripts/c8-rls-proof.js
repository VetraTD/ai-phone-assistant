#!/usr/bin/env node
/**
 * C8 — the RLS half. Tenant isolation proved IN THE DATABASE, where the PHI is.
 *
 *   Local:    DATABASE_URL=... node scripts/c8-rls-proof.js
 *   Staging:  gcloud run jobs execute vetra-migrate-us-staging \
 *               --args=scripts/c8-rls-proof.js \
 *               --region=us-central1 --project=vetra-us-staging-c3a3bd --wait
 *
 *   --structure-only   catalogue checks only; writes nothing, seeds nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT A TEST
 * ---------------------------------------------------------------------------
 *
 * Staging's Cloud SQL is private-IP only: ipv4Enabled false, one address on a
 * VPC this workstation is not on. There is no psql, no tunnel and no connection
 * string that would work. The only way to run a statement against the database
 * that actually holds the data is to put it in the image and run it through the
 * migrate job — so anything you would do by hand has to be a committed script,
 * because there is no hand to do it with.
 *
 * tests/db/* already prove these properties on local PG16, and that is not the
 * same claim. Local `vetra` is a SUPERUSER with rolbypassrls=true, and six RLS
 * tests once passed green against a bootstrap function that was completely
 * defeated on Cloud SQL. "Isolated locally" and "isolated where the PHI is"
 * have already been different facts once, which is the entire reason C8 exists
 * as a separate verification rather than as a test run.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST CHECK IS WHETHER THIS SCRIPT CAN PROVE ANYTHING AT ALL
 * ---------------------------------------------------------------------------
 *
 * Every assertion below is vacuous if the connected role can bypass row-level
 * security, and vacuous in the direction that reports success. A BYPASSRLS role
 * sees every tenant's rows, so "tenant A cannot see B" would fail loudly — but
 * a table with RLS switched off, or a policy that was never created, refuses
 * nothing while every negative assertion still passes.
 *
 * So this refuses to run until it has established, from the catalogue:
 *
 *   1. the effective role is NOT superuser and NOT rolbypassrls;
 *   2. every tenant-scoped table has relrowsecurity AND relforcerowsecurity;
 *   3. every table it is about to test actually has a policy on it.
 *
 * SET LOCAL ROLE vetra_app is what makes (1) true in both places. On Cloud SQL
 * the job connects as `postgres`, a cloudsqlsuperuser with rolbypassrls=false,
 * so RLS would apply anyway; locally it connects as `vetra`, a superuser with
 * rolbypassrls=true, so it would not. One SET ROLE and the same script is
 * honest in both — and it also tests the role the runtime actually uses, since
 * the runtime IAM principal is a MEMBER of vetra_app and inherits exactly these
 * privileges.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE LIST COMES FROM THE CATALOGUE, NOT FROM THIS FILE
 * ---------------------------------------------------------------------------
 *
 * A hardcoded list of tenant-scoped tables is a coverage claim that goes stale
 * silently: someone adds a table with a business_id, nobody adds it here, and
 * the report still says "all tenant-scoped tables isolated". So the set is
 * discovered by asking for every table carrying a business_id column, plus the
 * two that are tenant-scoped WITHOUT one — `businesses`, scoped by its own id,
 * and `call_transcripts`, scoped by a join through `calls`, which is precisely
 * the table a hand-written filter forgets.
 *
 * ---------------------------------------------------------------------------
 * EVERY REFUSAL IS PAIRED WITH A PROOF THE SAME CALL SUCCEEDS
 * ---------------------------------------------------------------------------
 *
 * The most expensive lesson in this project's ledger: three negative tests —
 * 403 with no signature, with a bogus one, with a wrong-length one — passed for
 * months while signature validation was rejecting one hundred percent of
 * requests, genuine ones included. All three 403s are exactly what a validator
 * that refuses EVERYTHING produces. Nothing asserted that a CORRECT request was
 * ACCEPTED, and that is the only assertion separating "correctly refuses bad
 * input" from "refuses everything".
 *
 * Under FORCE RLS the same hole has a sharper edge, because the refusal is
 * SILENT: an unscoped SELECT returns zero rows and an unscoped UPDATE reports
 * success having matched nothing. "I cannot see any rows" and "there are no
 * rows" are different facts that look identical.
 *
 * So each table gets its control FIRST:
 *
 *   OWN READ      scoped to A, A sees its own row              (must find it)
 *   CROSS READ    scoped to A, A cannot see B's row            (must find 0)
 *   UNSCOPED READ no scope at all, nothing is visible          (must find 0)
 *   CROSS WRITE   scoped to A, A cannot INSERT a row owned by B
 *
 * If OWN READ fails, the refusals below it prove nothing and are reported as
 * UNPROVEN rather than as passes.
 *
 * CROSS WRITE is not redundant with CROSS READ. USING governs what is visible;
 * WITH CHECK governs what may be written. A policy carrying only USING lets a
 * scoped connection INSERT a row belonging to another tenant which it then
 * cannot see — a write-only cross-tenant leak, and the kind found much later
 * than a read one.
 *
 * ---------------------------------------------------------------------------
 * A PERMISSION ERROR IS NOT AN RLS PASS
 * ---------------------------------------------------------------------------
 *
 * "permission denied for table x" and "row-level security filtered it" both
 * stop the statement, and only one is the property C8 claims. They are reported
 * separately: a refusal that came from a missing GRANT is recorded as a GRANT
 * refusal, because a table nobody may touch is isolated by accident and stops
 * being so the moment somebody fixes the grant.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES NOTHING THAT SURVIVES
 * ---------------------------------------------------------------------------
 *
 * Everything runs inside ONE transaction that always ends in ROLLBACK. This
 * runs against a live staging database and at D3 will be pointed at production;
 * a script that seeds two tenants and tidies up afterwards leaves them behind
 * the first time it crashes between the seed and the tidy. A rollback cannot be
 * forgotten and cannot half-happen — kill the job mid-run and the transaction
 * dies with the connection.
 *
 * Statements that are EXPECTED to fail are wrapped in SAVEPOINTs. Without them
 * the first intentional WITH CHECK violation aborts the transaction and every
 * later assertion fails with "current transaction is aborted", which reads as a
 * cascade of isolation failures and is one script bug.
 */

import { pathToFileURL } from "node:url";
import { connect } from "./migrate.js";

const STRUCTURE_ONLY = process.argv.includes("--structure-only");

// Tables that are tenant-scoped WITHOUT carrying a business_id column. Kept
// explicit because they cannot be discovered by looking for that column, and
// each is annotated with what actually scopes it.
const SCOPED_WITHOUT_BUSINESS_ID = {
  businesses: "its own id",
  call_transcripts: "a join through calls.business_id",
};

// Tables that carry a business_id but are deliberately NOT reachable by
// vetra_app, so an isolation assertion against them would be measuring a
// missing GRANT rather than a policy. Excluded ON PURPOSE, and named in the
// report so the exclusion is visible rather than silent.
const NOT_APP_REACHABLE = {
  business_directory: "no RLS, granted to nobody; read only by a definer function (migration 033)",
  user_directory: "no RLS, granted to nobody; read only by a definer function (migrations 034/036)",
};

// Tables that carry a business_id, have RLS forced, and deliberately have NO
// POLICY — which locks them to everyone but a superuser. That is the accurate
// description of a table nothing uses, and it is a legitimate state for exactly
// these two and nothing else.
//
// The list exists so the check can be an ASSERTION rather than an observation.
// Reported as a note, a policy-less table is something a reader skimming for
// FAIL scrolls straight past — and "somebody added a table and forgot the
// policy" is the most likely way this system loses tenant isolation. Anything
// policy-less that is NOT named here is therefore a failure.
const DELIBERATELY_POLICYLESS = {
  oauth_states: "inert since A1.1 — the code that read or wrote it is deleted",
  calendar_connections: "inert since A1.1 — same story, same treatment",
};

const results = [];

function record(area, name, pass, detail) {
  results.push({ area, name, pass, detail });
  const tag = pass === true ? " ok " : pass === null ? "note" : "FAIL";
  console.log(`[${tag}] ${area} :: ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Run a statement that may legitimately fail; return the error rather than throwing. */
async function attempt(client, sql, params) {
  await client.query("SAVEPOINT s");
  try {
    const r = await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT s");
    return { ok: true, rowCount: r.rowCount, rows: r.rows };
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    await client.query("RELEASE SAVEPOINT s");
    return { ok: false, code: err.code, message: err.message };
  }
}

/** Scope the transaction to one tenant, or to none when id is null. */
async function scopeTo(client, id) {
  await client.query("SELECT set_config('app.business_id', $1, true)", [id ?? ""]);
}

/** Identifiers come from the catalogue; quoting them keeps the shape honest anyway. */
function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing to interpolate ${name}`);
  return `"${name}"`;
}

function readSql(t) {
  if (t === "businesses") return "SELECT id FROM businesses WHERE id = $1";
  if (t === "call_transcripts") {
    return "SELECT ct.id FROM call_transcripts ct JOIN calls c ON c.id = ct.call_id WHERE c.business_id = $1";
  }
  return `SELECT 1 FROM ${quoteIdent(t)} WHERE business_id = $1`;
}

async function main() {
  const { client, close, describe } = await connect();
  console.log(`\nC8 RLS proof — ${describe}\n`);

  let aborted = false;
  try {
    await client.query("BEGIN");

    // -------------------------------------------------------------------
    // 0. Can this script prove anything at all?
    // -------------------------------------------------------------------
    const before = await client.query(
      "SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    console.log(
      `connected as ${before.rows[0].who} ` +
        `(superuser=${before.rows[0].rolsuper}, bypassrls=${before.rows[0].rolbypassrls})`
    );

    const hasAppRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'vetra_app'");
    if (!hasAppRole.rowCount) {
      record("preflight", "vetra_app role exists", false, "migration 029 has not run on this database");
      throw new Error("cannot continue without the application role");
    }

    // SET ROLE IS A MEANS, NOT THE REQUIREMENT — and the first version of this
    // file confused the two, which cost its first real run.
    //
    // On Cloud SQL the migrate job connects as `postgres`, which is NOT a
    // member of vetra_app, so `SET LOCAL ROLE vetra_app` is refused outright:
    // `permission denied to set role "vetra_app"`. Locally `vetra` is a
    // superuser and SET ROLE always works, so the failure could only ever
    // appear where it mattered.
    //
    // The requirement is that the EFFECTIVE role cannot bypass row-level
    // security. On Cloud SQL `postgres` already satisfies it — measured on the
    // live instance: `superuser=false, bypassrls=false`, because Google keeps
    // BYPASSRLS for `cloudsqladmin` alone — and it OWNS the tables, which under
    // FORCE row security is still fully subject to every policy.
    //
    // So: prefer vetra_app, fall back to whatever we are, and let the assertion
    // below decide. Which role actually ran is reported everywhere, because it
    // changes what a pass means.
    let ranAs = "vetra_app";
    const setRole = await attempt(client, "SET LOCAL ROLE vetra_app");
    if (!setRole.ok) {
      ranAs = null; // resolved from current_user below
      record(
        "preflight",
        "drop to the application role",
        null,
        `cannot SET ROLE vetra_app (${setRole.code}) — falling back to the connected role, ` +
          "which is correct as long as it cannot bypass RLS"
      );
    }

    const eff = await client.query(
      "SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    const { who, rolsuper, rolbypassrls } = eff.rows[0];
    ranAs = who;
    const usable = !rolsuper && !rolbypassrls;
    record(
      "preflight",
      "effective role cannot bypass row-level security",
      usable,
      `running as ${who} — superuser=${rolsuper} bypassrls=${rolbypassrls}`
    );
    if (!usable) {
      // Refusing here is the point. Reporting "isolated" from a role that
      // bypasses the mechanism under test is worse than reporting nothing,
      // because it would be believed.
      throw new Error("every assertion below would be vacuous — refusing to report a pass");
    }

    // What a pass means depends on which role produced it, so say so once,
    // loudly, rather than leaving the reader to infer it from a line above.
    const isAppRole = who === "vetra_app";
    if (!isAppRole) {
      record(
        "preflight",
        "SCOPE OF THIS RUN",
        null,
        `running as ${who}, not vetra_app. RLS POLICIES are fully exercised — FORCE binds the ` +
          "table owner too. The GRANT surface is NOT: this role has broader privileges, so any " +
          "check that depends on vetra_app being REFUSED is skipped rather than passed"
      );
    }

    // -------------------------------------------------------------------
    // 1. Which tables are tenant-scoped? Ask the catalogue, not this file.
    // -------------------------------------------------------------------
    const discovered = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (
            EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema = 'public'
                       AND col.table_name = c.relname
                       AND col.column_name = 'business_id')
            OR c.relname = ANY($1::text[])
          )
        ORDER BY c.relname`,
      [Object.keys(SCOPED_WITHOUT_BUSINESS_ID)]
    );

    const testable = discovered.rows.filter(
      (r) => !(r.table_name in NOT_APP_REACHABLE) && Number(r.policies) > 0
    );
    console.log(
      `\ndiscovered ${discovered.rows.length} tenant-scoped tables — ` +
        `${testable.length} with policies to test, ` +
        `${discovered.rows.length - testable.length} reported and not tested\n`
    );

    for (const row of discovered.rows) {
      // The two routing tables are the one place where RLS being OFF is the
      // design rather than a defect, so asserting "enabled AND forced" against
      // them would report a correct system as broken — it did, on the first
      // run of this script. What makes them safe is not a policy but the
      // GRANT: only the SECURITY DEFINER functions read them, and a table
      // nobody is granted is not a cross-tenant window. That is the property
      // worth checking, and it is checked by trying it.
      if (row.table_name in NOT_APP_REACHABLE) {
        // This check asks whether vetra_app is REFUSED. Asking it as any other
        // role answers a different question and answers it wrongly: `postgres`
        // OWNS these tables and can obviously read them, so running this as
        // postgres would report a correct system as a cross-tenant window.
        // Skip rather than pass, and say which.
        if (!isAppRole) {
          record(
            "structure",
            `${row.table_name}: unreachable by the application role`,
            null,
            `NOT EXERCISED as ${who} — this asks whether vetra_app is refused, and ${who} ` +
              "owns the table. Needs a run as vetra_app to answer"
          );
          continue;
        }
        const reach = await attempt(client, `SELECT 1 FROM ${quoteIdent(row.table_name)} LIMIT 1`);
        record(
          "structure",
          `${row.table_name}: unreachable by the application role`,
          !reach.ok && reach.code === "42501",
          reach.ok
            ? "READABLE by vetra_app — this table has no RLS, so that would be a cross-tenant window"
            : `${reach.code}: refused (${NOT_APP_REACHABLE[row.table_name]})`
        );
        continue;
      }

      const forced = row.relrowsecurity && row.relforcerowsecurity;
      record(
        "structure",
        `${row.table_name}: RLS enabled AND forced`,
        forced,
        `enabled=${row.relrowsecurity} forced=${row.relforcerowsecurity} policies=${row.policies}`
      );
      if (forced && Number(row.policies) === 0) {
        // Locked, not isolated — and whether that is correct depends entirely
        // on whether somebody meant it. See DELIBERATELY_POLICYLESS.
        const intended = row.table_name in DELIBERATELY_POLICYLESS;
        record(
          "structure",
          `${row.table_name}: no policy — locked, not isolated`,
          intended ? null : false,
          intended
            ? DELIBERATELY_POLICYLESS[row.table_name]
            : "a tenant-scoped table with NO POLICY — nothing but a superuser can touch it, " +
              "and it is not isolated. If this is deliberate, name it in DELIBERATELY_POLICYLESS"
        );
      }
    }

    if (STRUCTURE_ONLY) {
      console.log("\n--structure-only: nothing was written and no tenant was created.\n");
    } else {
      await runDataChecks(client, testable);
    }
  } catch (err) {
    aborted = true;
    console.error(`\nABORTED: ${err.message}`);
  } finally {
    // Always, and it is the only cleanup there is. See the header.
    await client.query("ROLLBACK").catch(() => {});
    await close();
  }

  const fails = results.filter((r) => r.pass === false);
  const passes = results.filter((r) => r.pass === true);
  const notes = results.filter((r) => r.pass === null);
  console.log(
    `\n${passes.length} passed, ${fails.length} failed, ${notes.length} noted. ` +
      "Nothing was persisted — the transaction was rolled back."
  );
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(`  ${f.area} :: ${f.name} — ${f.detail}`);
  }
  process.exitCode = aborted || fails.length ? 1 : 0;
}

/**
 * Seed two tenants and prove each table isolates them.
 *
 * The tenants are created with app_create_business_for_user, which is the ONLY
 * supported way: businesses' WITH CHECK is `id = app_current_business_id()`, so
 * a brand-new tenant is by definition not the current one and a plain INSERT
 * can never satisfy the policy. The function generates the id, adopts it as the
 * transaction-local scope, inserts, and restores the previous scope — satisfying
 * the policy rather than bypassing it.
 */
async function runDataChecks(client, testable) {
  const seeded = {};
  for (const label of ["A", "B"]) {
    const r = await attempt(client, "SELECT (app_create_business_for_user($1, $2, $3, $4)).id AS id", [
      `c8-rls-proof-${label}`,
      `c8-rls-proof-${label}@example.invalid`,
      `C8 RLS Proof ${label}`,
      "America/Chicago",
    ]);
    if (!r.ok) {
      record("seed", `create tenant ${label}`, false, `${r.code}: ${r.message}`);
      return;
    }
    seeded[label] = r.rows[0].id;
    record("seed", `create tenant ${label}`, true, seeded[label]);
  }

  const { A, B } = seeded;

  for (const row of testable) {
    const t = row.table_name;

    const ready = await seedRowsFor(client, t, A, B);
    if (!ready.ok) {
      record("isolation", `${t}: seed a row for each tenant`, null, `skipped — ${ready.why}`);
      continue;
    }

    // --- the control, first ----------------------------------------------
    await scopeTo(client, A);
    const own = await attempt(client, readSql(t), [A]);
    if (!own.ok) {
      record("isolation", `${t}: OWN READ`, false, `${own.code}: ${own.message}`);
      record("isolation", `${t}: CROSS READ`, null, "UNPROVEN — the positive control failed");
      continue;
    }
    const ownFound = own.rows.length > 0;
    record("isolation", `${t}: OWN READ — A sees its own row`, ownFound, `${own.rows.length} row(s)`);
    if (!ownFound) {
      record("isolation", `${t}: CROSS READ`, null, "UNPROVEN — A cannot see its own row either");
      continue;
    }

    // --- the refusals, which now mean something ---------------------------
    const cross = await attempt(client, readSql(t), [B]);
    if (!cross.ok) {
      record(
        "isolation",
        `${t}: CROSS READ`,
        false,
        `refused by GRANT, not by RLS — ${cross.code}: ${cross.message}`
      );
    } else {
      record(
        "isolation",
        `${t}: CROSS READ — A cannot see B's row`,
        cross.rows.length === 0,
        `${cross.rows.length} of B's row(s) visible to A`
      );
    }

    await scopeTo(client, null);
    const unscoped = await attempt(client, readSql(t), [B]);
    record(
      "isolation",
      `${t}: UNSCOPED READ — no tenant set, nothing visible`,
      unscoped.ok ? unscoped.rows.length === 0 : false,
      unscoped.ok ? `${unscoped.rows.length} row(s) visible with no scope` : `${unscoped.code}: ${unscoped.message}`
    );

    // --- the write half of the policy -------------------------------------
    await scopeTo(client, A);
    if (t !== "businesses" && t !== "call_transcripts") {
      const write = await attempt(client, `INSERT INTO ${quoteIdent(t)} (business_id) VALUES ($1)`, [B]);
      // 42501 is the policy refusing. Anything else (a NOT NULL column, a
      // foreign key) stopped it before the policy was consulted, which is not
      // the property under test and must not be counted as though it were.
      const byPolicy = !write.ok && write.code === "42501";
      const byOther = !write.ok && write.code !== "42501";
      record(
        "isolation",
        `${t}: CROSS WRITE — A cannot insert a row owned by B`,
        byPolicy ? true : byOther ? null : false,
        write.ok
          ? "THE INSERT SUCCEEDED — a write-only cross-tenant leak"
          : byPolicy
            ? "refused by WITH CHECK"
            : `stopped by ${write.code} before the policy applied — not proven either way`
      );
    }
  }
}

/**
 * The columns a row in `t` cannot omit: NOT NULL, no default, not generated.
 *
 * Asked of the catalogue rather than written down here for the same reason the
 * table list is. A hand-maintained map of "what appointments needs" is correct
 * until someone adds a NOT NULL column, at which point every isolation check on
 * that table starts silently reporting "skipped" — and a skip in a security
 * report reads almost exactly like a pass.
 */
async function requiredColumns(client, t) {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND is_nullable = 'NO'
        AND column_default IS NULL
        AND is_generated = 'NEVER'
        AND is_identity = 'NO'
      ORDER BY ordinal_position`,
    [t]
  );
  return r.rows;
}

/**
 * Columns of `t` that point at another table, and where they point.
 *
 * pg_catalog, NOT information_schema. `constraint_column_usage` is restricted
 * to constraints on tables the current user OWNS, and this runs as vetra_app,
 * which owns nothing — so the information_schema version returned an empty set
 * and call_transcripts was reported as unseedable when its one foreign key was
 * sitting right there. A view that filters by privilege will answer "no
 * constraints" rather than "you may not look", and those read identically.
 */
async function foreignKeys(client, t) {
  const r = await client.query(
    `SELECT att.attname AS column_name, ref.relname AS ref_table
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_class ref ON ref.oid = con.confrelid
       JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
      WHERE con.contype = 'f' AND rel.relname = $1
        AND rel.relnamespace = 'public'::regnamespace`,
    [t]
  );
  return new Map(r.rows.map((x) => [x.column_name, x.ref_table]));
}

// Unique-ish suffix per synthesised row. `calls.twilio_call_sid` and
// `users.email` both carry UNIQUE constraints, so seeding tenant A and tenant B
// with the same literal made the SECOND insert fail with 23505 — reported as
// "cannot seed", which looks like a limitation of the script and was a
// collision in it.
let seq = 0;

/**
 * A value of the right type. Deliberately dull: these rows exist to be counted,
 * never to be realistic, and they never outlive the transaction.
 */
function synthesise(col, tenantId, parentIds) {
  if (col.column_name === "business_id") return tenantId;
  if (parentIds.has(col.column_name)) return parentIds.get(col.column_name);
  // Array types are named with a leading underscore in pg_type (_text, _uuid).
  if (col.udt_name.startsWith("_")) return "{}";
  switch (col.udt_name) {
    case "uuid":
      return null; // an unresolved FK; the caller turns this into an honest skip
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return 0;
    case "bool":
      return false;
    case "timestamptz":
    case "timestamp":
    case "date":
      return new Date().toISOString();
    case "jsonb":
    case "json":
      return "{}";
    default:
      return `c8-rls-proof-${++seq}`;
  }
}

/**
 * Give each tenant one row in `t` to own, so the control has something to find.
 *
 * Returns {ok:false, why} rather than throwing, so a table this cannot seed is
 * reported as an explicit skip with the reason. A silent skip would leave the
 * report claiming coverage it does not have.
 */
async function seedRowsFor(client, t, A, B) {
  if (t === "businesses") return { ok: true }; // the tenants themselves are the rows

  const cols = await requiredColumns(client, t);
  const fks = await foreignKeys(client, t);

  for (const tenantId of [A, B]) {
    await scopeTo(client, tenantId);

    // Satisfy any FK to a table we can seed ourselves, one level deep. In
    // practice that is call_transcripts -> calls, which is the whole reason
    // that table is interesting: nothing on the row says which tenant it
    // belongs to, so its policy reaches through the parent.
    const parentIds = new Map();
    for (const [col, refTable] of fks) {
      if (col === "business_id" || refTable === t) continue;
      const parent = await seedOneRow(client, refTable, tenantId, new Map());
      if (!parent.ok) return { ok: false, why: `parent ${refTable}: ${parent.why}` };
      parentIds.set(col, parent.id);
    }

    const made = await seedOneRow(client, t, tenantId, parentIds);
    if (!made.ok) return { ok: false, why: made.why };
  }
  return { ok: true };
}

/**
 * Values a CHECK constraint will actually accept, per column.
 *
 * `phi_access_log.action` is `CHECK (action = ANY (ARRAY['read','write',...]))`,
 * so an arbitrary string is refused with 23514 and the table gets reported as
 * unseedable — a skip, which in a security report reads too much like a pass.
 * Read out of pg_get_constraintdef rather than copied into this file, so a new
 * enumerated column needs no edit here and a changed one cannot go stale.
 */
async function checkAllowedValues(client, t) {
  const r = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c'`,
    [`public.${t}`]
  );
  const allowed = new Map();
  for (const { def } of r.rows) {
    // CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))
    const m = /\(\(?\s*([a-z_][a-z0-9_]*)\s*=\s*ANY\s*\(\s*ARRAY\[(.+?)\]/is.exec(def);
    if (!m) continue;
    const literals = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
    if (literals.length) allowed.set(m[1], literals[0]);
  }
  return allowed;
}

/** Insert one minimal row into `t` for `tenantId`; returns its id when there is one. */
async function seedOneRow(client, t, tenantId, parentIds) {
  const cols = await requiredColumns(client, t);
  const allowed = await checkAllowedValues(client, t);
  const names = [];
  const values = [];
  for (const col of cols) {
    const v = allowed.has(col.column_name)
      ? allowed.get(col.column_name)
      : synthesise(col, tenantId, parentIds);
    if (v === null) {
      return { ok: false, why: `cannot synthesise ${t}.${col.column_name} (${col.udt_name})` };
    }
    names.push(quoteIdent(col.column_name));
    values.push(v);
  }
  // business_id is not always NOT NULL, but the row still has to belong to the
  // tenant or the policy will refuse it for the right reason at the wrong time.
  if (!names.includes('"business_id"')) {
    const has = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name='business_id'`,
      [t]
    );
    if (has.rowCount) {
      names.push('"business_id"');
      values.push(tenantId);
    }
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const sql = names.length
    ? `INSERT INTO ${quoteIdent(t)} (${names.join(", ")}) VALUES (${placeholders}) RETURNING *`
    : `INSERT INTO ${quoteIdent(t)} DEFAULT VALUES RETURNING *`;
  const r = await attempt(client, sql, values);
  if (!r.ok) return { ok: false, why: `${r.code} ${r.message}` };
  return { ok: true, id: r.rows[0]?.id };
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
