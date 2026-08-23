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

// ---------------------------------------------------------------------------
// TWO WAYS TO HAVE A POOL, and only one of them can be built at module load.
//
// DATABASE_URL is a string: the pool exists immediately, and every local run
// and every existing test keeps working with no init step and no change.
//
// Cloud SQL is not. The instance is PRIVATE IP ONLY with no password — B2
// created no `google_sql_user`, because a password in a Terraform resource is a
// password in state — so the connector has to fetch ephemeral certificates
// before a socket exists. That is asynchronous, so `init()` below builds it and
// src/server.js awaits that BEFORE the port opens.
//
// Until 2026-08-22 only the first path existed, which meant this backend could
// not reach a GCP database at all: there was no connection string that would
// have worked. See src/db/cloudSqlPool.js.
// ---------------------------------------------------------------------------
let pool = process.env.CLOUD_SQL_INSTANCE
  ? null
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
    });

let closeConnector = null;

/**
 * Build the Cloud SQL pool, if this deployment uses one.
 *
 * A no-op on the DATABASE_URL path, so server.js can await it unconditionally
 * and no caller has to know which kind of database it has.
 *
 * Idempotent: a second call returns the pool already built rather than opening
 * a second connector, because a supervisor restarting a partially-initialised
 * process is a real thing and leaking a connector per attempt is how a service
 * runs out of file descriptors slowly.
 */
async function init() {
  if (pool) return pool;

  const { cloudSqlConfig, cloudSqlPoolConfig } = require("./cloudSqlPool");
  const cfg = cloudSqlConfig();
  if (!cfg) {
    // CLOUD_SQL_INSTANCE was set at module load and is gone now — only
    // reachable if something mutated the environment mid-process. Refuse rather
    // than silently building a DATABASE_URL pool that points somewhere else.
    throw new Error("CLOUD_SQL_INSTANCE disappeared between module load and init()");
  }

  const { poolConfig, close } = await cloudSqlPoolConfig(cfg, {
    max: Number.parseInt(process.env.DB_POOL_MAX || "10", 10),
  });
  pool = new Pool(poolConfig);
  closeConnector = close;
  return pool;
}

/** Release the connector's timers and sockets. Tests and shutdown only. */
async function close() {
  await pool?.end().catch(() => {});
  await closeConnector?.();
  pool = null;
  closeConnector = null;
}

const tenantContext = new AsyncLocalStorage();

/**
 * Run one statement, on the tenant-scoped client when there is one.
 *
 * Signature-compatible with `pool.query` on purpose — see the header.
 */
function query(text, params) {
  const runner = tenantContext.getStore()?.client ?? pool;
  if (!runner) {
    // Reached only when a Cloud SQL deployment serves a request before init()
    // resolved. Named, because the alternative is `Cannot read properties of
    // null (reading 'query')` on a route, which reads as a bug in that route.
    throw new Error("database pool is not ready — init() must be awaited before serving");
  }
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
  if (!pool) {
    // Same guard as query(). This path takes a client from the pool directly
    // rather than going through query(), so it needs its own.
    throw new Error("database pool is not ready — init() must be awaited before serving");
  }

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

// `pool` is a GETTER, not the value.
//
// It used to be the Pool itself, exported once at module load. On the Cloud SQL
// path there is no pool at module load, so a plain property would have captured
// `null` forever and every consumer holding it would have kept a null after
// init() replaced it.
module.exports = {
  query,
  withTenant,
  currentTenant,
  init,
  close,
  get pool() {
    return pool;
  },
};
