#!/usr/bin/env node
/**
 * B1(2) — Supabase Auth -> Identity Platform, without making anybody reset a
 * password.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MEASURED, 2026-08-22, against the live API rather than the docs.
 * Every rule below is here because a probe established it.
 *
 *  1. Supabase's bcrypt hashes import and the ORIGINAL password then signs in.
 *     GoTrue is Go and emits `$2a$`; Node's bcrypt emits `$2b$`. BOTH work.
 *     `passwordHash` is the bcrypt string's own bytes, base64url — there is no
 *     separate salt, no signer key and no rounds parameter for BCRYPT.
 *
 *  2. **HTTP 200 DOES NOT MEAN SUCCESS.** Partial failures come back as a
 *     per-record `error[]` array with an `index` and a `message`, inside a 200.
 *     A script that checks the status code reports success while dropping
 *     users, and the users it drops are the ones who cannot log in on Monday.
 *
 *  3. **`accounts:batchCreate` IGNORES `allow_duplicate_emails`.** The config
 *     forbids duplicates and the bulk import creates them anyway, silently, no
 *     error. Two accounts on one address, and `signInWithPassword` then returns
 *     the LAST-imported one — so a careless second run does not merely make a
 *     mess, it SILENTLY REPOINTS every member of staff onto a new account id.
 *     With the tenant lookup keyed on `auth_uid`, that is every clinic losing
 *     access at once, reported as HTTP 200.
 *
 *  4. **Setting `localId` explicitly is what makes the import idempotent.**
 *     Same localId twice = one account, upserted. That single choice is the
 *     difference between a re-runnable import and one that destroys access on
 *     a retry, so `localId` is REQUIRED here and never left to the service.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECURITY STEP AND NOT A DATA MOVE.
 *
 * Migration 034 resolves a session's tenant BY EMAIL, and signup is open. So an
 * address that has a `users` row but NO Identity Platform account can be
 * claimed by a stranger who simply signs up with it — and they inherit that
 * clinic's tenant. That window OPENS at this import and is closed by migration
 * 036, which moves the lookup onto `auth_uid` and refuses to apply while any
 * row still lacks one. Import, backfill, then 036, in that order.
 * ---------------------------------------------------------------------------
 */

import fs from "fs";
import process from "process";
import pg from "pg";
import { cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";

const IDP_HOST = "https://identitytoolkit.googleapis.com";

/** Identity Platform's documented ceiling for one batchCreate call. */
export const MAX_BATCH = 1000;

/**
 * A bcrypt hash, as Identity Platform wants it.
 *
 * Validated rather than trusted: a Supabase export can contain rows whose
 * `encrypted_password` is empty (an OAuth-only account) or is some other
 * algorithm entirely, and sending those produces an account nobody can sign in
 * to — which looks exactly like a successful import.
 *
 * @param {string} hash
 * @returns {string} base64url
 */
export function encodeBcryptHash(hash) {
  if (typeof hash !== "string" || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
    throw new Error(`not a bcrypt hash: ${JSON.stringify(String(hash).slice(0, 12))}…`);
  }
  return Buffer.from(hash, "utf8").toString("base64url");
}

/** @param {any[]} items @param {number} size */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Decide what to do, before doing any of it.
 *
 * Pure, so the decisions are testable without an auth store. Every category it
 * returns is a category somebody has to look at — nothing is silently dropped,
 * because "silently dropped" here means a member of staff who cannot log in and
 * an import that said it worked.
 *
 * @param {object} args
 * @param {Array<{id: string, email: string, encrypted_password: string}>} args.exportRows  Supabase auth.users
 * @param {Array<{id: string, email: string, auth_uid: string|null}>} args.dbUsers          our users table
 * @param {Set<string>} args.existingAccounts  emails that ALREADY have an Identity Platform account
 */
export function buildPlan({ exportRows, dbUsers, existingAccounts }) {
  const byEmail = new Map(dbUsers.map((u) => [u.email, u]));
  const plan = { toImport: [], alreadyPresent: [], unmatched: [], unusable: [] };
  const seen = new Set();

  for (const row of exportRows) {
    const email = typeof row.email === "string" ? row.email.trim() : "";

    if (!email) {
      plan.unusable.push({ row, reason: "no email address" });
      continue;
    }
    if (seen.has(email)) {
      // Two export rows for one address. Importing both is the duplicate-account
      // failure mode above, arriving from our own input rather than from a
      // second run.
      plan.unusable.push({ row, reason: `duplicate email in the export: ${email}` });
      continue;
    }
    seen.add(email);

    const dbUser = byEmail.get(email);
    if (!dbUser) {
      // An auth account with no staff row. Importing it creates a login that
      // resolves to no tenant — a 403 that reads as an authorisation bug.
      plan.unmatched.push({ email, reason: "no users row for this address" });
      continue;
    }

    let passwordHash;
    try {
      passwordHash = encodeBcryptHash(row.encrypted_password);
    } catch (err) {
      plan.unusable.push({ row, reason: err.message });
      continue;
    }

    // THE ASSUMPTION MIGRATION 036 RESTS ON, checked rather than trusted.
    //
    // Every path that ever created a `users` row set `users.id` from the auth
    // provider's id, so for pre-Identity-Platform rows `users.id` IS the
    // Supabase auth uid — which is what lets 036 backfill `auth_uid` from it
    // with no export at all. If a row disagrees, that person's `auth_uid` is
    // WRONG: their token would carry one id and the directory another, and they
    // would be locked out. Safe direction, but it must not pass silently.
    if (dbUser.auth_uid && dbUser.auth_uid !== row.id) {
      plan.unusable.push({
        row,
        reason:
          `auth_uid disagreement for ${email}: the database says ${dbUser.auth_uid}, ` +
          `the export says ${row.id}. Migration 036 backfilled from users.id and one of them is wrong.`,
      });
      continue;
    }

    if (existingAccounts.has(email)) {
      plan.alreadyPresent.push({ email });
      continue;
    }

    plan.toImport.push({
      localId: row.id,
      email,
      passwordHash,
      // NOT true. Supabase does not verify addresses for password signups and
      // neither does this; claiming otherwise would assert something we have
      // not checked, on the field that gates a password reset.
      emailVerified: false,
      dbUserId: dbUser.id,
    });
  }

  return plan;
}

/**
 * Push one batch and turn a 200-with-errors into a real failure.
 *
 * @param {{ post: (path: string, body: object) => Promise<{status: number, body: any}> }} idp
 * @param {Array<object>} users
 * @returns {Promise<Array<{index: number, message: string}>>}
 */
export async function importBatch(idp, users) {
  const { status, body } = await idp.post("/accounts:batchCreate", {
    hashAlgorithm: "BCRYPT",
    users: users.map(({ localId, email, passwordHash, emailVerified }) => ({
      localId,
      email,
      passwordHash,
      emailVerified,
    })),
  });

  if (status !== 200) {
    throw new Error(`batchCreate failed: ${status} ${JSON.stringify(body)}`);
  }
  // THE WHOLE POINT. A 200 with an error array is a partial import, and the
  // records it names did not land.
  return Array.isArray(body?.error) ? body.error : [];
}

/**
 * Look every imported address back up and prove exactly one account exists with
 * the id we asked for.
 *
 * Not belt-and-braces. `batchCreate` returns an EMPTY body on success — it does
 * not tell you what it created — and it will happily make a second account on an
 * address that already has one. The only way to know the auth store is in the
 * shape we intended is to read it back.
 *
 * @returns {Promise<Array<string>>} human-readable problems, empty when clean
 */
export async function verifyImport(idp, records) {
  const problems = [];
  for (const batch of chunk(records, 100)) {
    const { status, body } = await idp.post("/accounts:lookup", {
      email: batch.map((r) => r.email),
    });
    if (status !== 200) {
      throw new Error(`lookup failed: ${status} ${JSON.stringify(body)}`);
    }
    const found = new Map();
    for (const u of body?.users || []) {
      if (!found.has(u.email)) found.set(u.email, []);
      found.get(u.email).push(u.localId);
    }
    for (const r of batch) {
      const ids = found.get(r.email) || [];
      if (ids.length === 0) problems.push(`${r.email}: no account was created`);
      else if (ids.length > 1) problems.push(`${r.email}: ${ids.length} accounts — duplicates: ${ids.join(", ")}`);
      else if (ids[0] !== r.localId) problems.push(`${r.email}: localId is ${ids[0]}, expected ${r.localId}`);
    }
  }
  return problems;
}

/**
 * Write the account ids onto the staff rows.
 *
 * FORCE ROW LEVEL SECURITY IS STOOD DOWN FOR THIS, and it has to be. `users` is
 * FORCE RLS on `business_id = app_current_business_id()`, so an UPDATE with no
 * tenant scope matches NOTHING and reports success — the fourth appearance of
 * that trap, after migrations 032, 033 and 034. A backfill that quietly updates
 * zero rows here is the worst possible outcome: migration 036 would then refuse
 * to apply, correctly, and the reason would look like the import failed when it
 * did not.
 *
 * Wrapped in one transaction so a failure cannot leave FORCE switched off.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rowCount: number, rows: any[]}> }} db
 * @param {Array<{dbUserId: string, localId: string}>} pairs
 */
export async function backfillAuthUids(db, pairs) {
  if (!pairs.length) return 0;
  await db.query("BEGIN");
  try {
    await db.query("ALTER TABLE users NO FORCE ROW LEVEL SECURITY");
    const res = await db.query(
      `UPDATE users AS u
          SET auth_uid = v.auth_uid
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS auth_uid) AS v
        WHERE u.id = v.id`,
      [pairs.map((p) => p.dbUserId), pairs.map((p) => p.localId)]
    );
    await db.query("ALTER TABLE users FORCE ROW LEVEL SECURITY");
    await db.query("COMMIT");
    return res.rowCount;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * A client with enough privilege to stand FORCE row security down.
 *
 * That means the SUPERUSER path (a password from Secret Manager), not the IAM
 * runtime identity — an IAM user is in `cloudsqliamuser`, does not own `users`,
 * and cannot ALTER it. Same two-identity split migrations already use, and for
 * the same reason.
 */
async function connectDatabase() {
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (instance) {
    const { poolConfig } = await cloudSqlPoolConfig(
      {
        instance,
        database: process.env.CLOUD_SQL_DATABASE,
        user: process.env.CLOUD_SQL_IAM_USER,
        password: process.env.CLOUD_SQL_PASSWORD,
        authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
      },
      { connectionTimeoutMillis: 10_000 }
    );
    const client = new pg.Client(poolConfig);
    await client.connect();
    return client;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("neither CLOUD_SQL_INSTANCE nor DATABASE_URL is set");
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

function summarise(plan, log) {
  log(`  to import        ${plan.toImport.length}`);
  log(`  already present  ${plan.alreadyPresent.length}   (skipped — re-importing would upsert)`);
  log(`  no users row     ${plan.unmatched.length}`);
  log(`  unusable         ${plan.unusable.length}`);
  for (const u of plan.unmatched) log(`    ! ${u.email}: ${u.reason}`);
  for (const u of plan.unusable) log(`    ! ${u.reason}`);
}

async function main() {
  const args = process.argv.slice(2);
  const exportPath = args.find((a) => !a.startsWith("--"));
  const confirm = args.includes("--confirm");
  const log = console.log;

  if (!exportPath) {
    console.error(
      "usage: node scripts/import-users.js <supabase-export.json> [--confirm]\n" +
        "\n" +
        "  Reads Supabase's auth.users export (id, email, encrypted_password).\n" +
        "  DRY RUN unless --confirm. Writing to a real auth store is something\n" +
        "  you should have to say out loud.\n"
    );
    process.exit(2);
  }

  const project = (process.env.IDENTITY_PLATFORM_PROJECT_ID || "").trim();
  if (!project) throw new Error("IDENTITY_PLATFORM_PROJECT_ID is not set");
  const token = (process.env.IDP_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("IDP_ACCESS_TOKEN is not set (gcloud auth print-access-token)");

  const idp = {
    async post(path, body) {
      const r = await fetch(`${IDP_HOST}/v1/projects/${project}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Goog-User-Project": project,
        },
        body: JSON.stringify(body),
      });
      let parsed = null;
      try { parsed = await r.json(); } catch { /* empty body is valid */ }
      return { status: r.status, body: parsed };
    },
  };

  const exportRows = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  if (!Array.isArray(exportRows)) throw new Error("export must be a JSON array of auth.users rows");

  // Connected the same way scripts/db-inspect.js and scripts/migrate.js are,
  // not through services/db.js: that module's `q` is deliberately unexported
  // and routes through the tenant-scoped runner, which is exactly wrong for a
  // cross-tenant backfill. Cloud SQL is private-IP only, so this runs inside
  // the VPC through the migration job:
  //
  //   gcloud run jobs execute vetra-migrate-<env> --args=scripts/import-users.js,<export>,--confirm
  const db = await connectDatabase();
  const dbUsers = (await db.query("SELECT id, email, auth_uid FROM users")).rows;

  // Which addresses already have an account. Asked BEFORE importing, because
  // batchCreate will not tell us and will duplicate rather than refuse.
  const existingAccounts = new Set();
  for (const batch of chunk(exportRows.map((r) => r.email).filter(Boolean), 100)) {
    const { status, body } = await idp.post("/accounts:lookup", { email: batch });
    if (status !== 200) throw new Error(`lookup failed: ${status} ${JSON.stringify(body)}`);
    for (const u of body?.users || []) existingAccounts.add(u.email);
  }

  const plan = buildPlan({ exportRows, dbUsers, existingAccounts });
  log(`export rows ${exportRows.length} · users rows ${dbUsers.length}`);
  summarise(plan, log);

  if (plan.unmatched.length || plan.unusable.length) {
    log("\nRefusing: every row must be accounted for before anything is written.");
    log("Fix the export or the users table, then re-run. Nothing has been changed.");
    process.exit(1);
  }

  if (!confirm) {
    log("\nDRY RUN. Nothing was written. Re-run with --confirm to import.");
    return;
  }

  let failures = 0;
  for (const [i, batch] of chunk(plan.toImport, MAX_BATCH).entries()) {
    const errors = await importBatch(idp, batch);
    for (const e of errors) {
      failures += 1;
      log(`  ! batch ${i} index ${e.index} (${batch[e.index]?.email}): ${e.message}`);
    }
    log(`  batch ${i}: ${batch.length - errors.length}/${batch.length} imported`);
  }

  const problems = await verifyImport(idp, plan.toImport);
  for (const p of problems) log(`  ! ${p}`);

  if (failures || problems.length) {
    log(`\nIMPORT INCOMPLETE — ${failures} rejected, ${problems.length} failed verification.`);
    log("auth_uid NOT backfilled. Migration 036 will refuse to apply, which is correct.");
    process.exit(1);
  }

  const updated = await backfillAuthUids(db, plan.toImport);
  log(`\nimported ${plan.toImport.length}, auth_uid set on ${updated} rows`);
  if (updated !== plan.toImport.length) {
    log("MISMATCH between accounts created and rows updated. Do NOT run migration 036.");
    process.exit(1);
  }
  log("Next: migration 036, which moves the tenant lookup off email and onto auth_uid.");
}

// Run as a script, not when imported by a test. `process.argv[1]` is undefined
// under `node --input-type=module -e`, so it is checked before use rather than
// dereferenced — a module that cannot be imported is a worse bug than a CLI
// that does not fire.
if (typeof process.argv[1] === "string" && /import-users\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
