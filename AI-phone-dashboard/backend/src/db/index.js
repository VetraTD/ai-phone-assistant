const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// The dashboard's database handle, and its tenant scope.
//
// This backend has its own pool and never touches services/db.js — it is
// CommonJS and that module is ESM, so it cannot import it even if it wanted to.
// The mechanism here is therefore a deliberate parallel of services/db.js's,
// not a shortcut: AsyncLocalStorage carrying a scoped client, and `query()`
// preferring it over the pool.
//
// WHY THIS SHAPE, and it is the reason 48 call sites did not have to change.
// Every route does `const pool = require("../db"); pool.query(...)`, and nothing
// in this backend uses pool.connect() or opens a transaction. So exporting an
// object with a `query` method is a drop-in for exporting the Pool itself, and
// the tenant scope reaches all 48 queries without editing one of them.
//
// Until this existed, 23 of those queries were hand-filtered by business_id and
// the rest were not filtered at all — which was survivable only because the
// connection was a superuser and row-level security was inert for it. Cloud SQL
// grants no superuser. On the day B2 moves the connection string, an unscoped
// dashboard returns nothing, everywhere, and looks like an authentication bug.
// ---------------------------------------------------------------------------

/**
 * TLS verification is no longer disabled unconditionally.
 *
 * `ssl: { rejectUnauthorized: false }` was set for every connection, including
 * the production one to the database holding patient data — which accepts any
 * certificate any host presents. It also made a plain local Postgres
 * unreachable, which is why nothing had ever run these routes against a real
 * database.
 *
 * The rule: verify unless told otherwise, and never require TLS from a local
 * database that does not speak it. Cloud SQL's connector terminates TLS itself
 * (B2), so the production path does not need this either.
 */
function sslConfig() {
  const url = process.env.DATABASE_URL || "";
  if (process.env.PGSSLMODE === "disable" || /[?&]sslmode=disable/.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  // An explicit opt-out, for a managed database presenting a certificate whose
  // CA is not in the container's trust store. Named so it shows up in a search
  // rather than living silently in a connection string.
  if (process.env.DB_SSL_INSECURE === "true") return { rejectUnauthorized: false };
  return process.env.DATABASE_URL ? { rejectUnauthorized: true } : false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

const tenantContext = new AsyncLocalStorage();

/**
 * Run one statement, on the tenant-scoped client when there is one.
 *
 * Signature-compatible with `pool.query` on purpose — see the header.
 */
function query(text, params) {
  const runner = tenantContext.getStore()?.client ?? pool;
  return runner.query(text, params);
}

/**
 * Run `fn` with the database scoped to one tenant.
 *
 * WRAP A UNIT OF WORK, NEVER A CALL — the same rule services/db.js states at
 * length, and here a unit of work is one HTTP handler. That is why
 * withTenantHandler wraps the HANDLER rather than sitting in front of `next()`:
 * `next()` returns before the handler finishes, so a middleware-shaped version
 * would COMMIT while the handler was still running, and committing on
 * `res.on("finish")` instead would hold a connection across response
 * serialisation and could not roll back a late error.
 *
 * `SET LOCAL` (set_config with `true`) rather than a session-level setting, so
 * COMMIT or ROLLBACK discards the scope — including when `fn` throws. A scope
 * that outlived the checkout would leak one tenant onto whatever request
 * borrowed that connection next.
 *
 * @template T
 * @param {string} businessId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenant(businessId, fn) {
  if (!businessId) throw new Error("withTenant: businessId is required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const result = await tenantContext.run({ client, businessId }, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The tenant the current async context is scoped to, or null. */
function currentTenant() {
  return tenantContext.getStore()?.businessId ?? null;
}

module.exports = { query, withTenant, currentTenant, pool };
