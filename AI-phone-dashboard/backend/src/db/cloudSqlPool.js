const { Connector, AuthTypes, IpAddressTypes } = require("@google-cloud/cloud-sql-connector");

// ---------------------------------------------------------------------------
// Reaching Cloud SQL from this backend.
//
// A deliberate copy of lib/db/cloudSqlPool.js in the voice server, for the same
// reason src/middleware/sessionAge.js and src/middleware/idToken.js are copies:
// this backend is CommonJS, ships as its own image containing only `src` and
// its own node_modules, and that module is ESM in a package the image does not
// carry. A relative import across the package boundary would work on a
// workstation and break in the container. The third twin, and each one is
// tested to the same behaviour rather than assumed to have it.
//
// ---------------------------------------------------------------------------
// WHY THIS HAD TO EXIST AT ALL
// ---------------------------------------------------------------------------
//
// Until 2026-08-22 this backend understood only DATABASE_URL — a connection
// string with a host and a password. Cloud SQL here is PRIVATE IP ONLY and has
// no password: B2 created no `google_sql_user`, on the grounds that a password
// in a Terraform resource is a password in state, and the runtime authenticates
// as its own IAM principal instead.
//
// So there was no connection string that could have worked, and the dashboard
// backend could not have reached a GCP database no matter how it was deployed.
// The image built fine; it just had nothing to talk to. Found by reading rather
// than by a failed deploy, which is the cheaper of the two.
//
// ---------------------------------------------------------------------------
// TWO IDENTITIES, and this one is the WEAK one
// ---------------------------------------------------------------------------
//
// Migrations connect as the superuser with a password from Secret Manager,
// because an IAM user is in `cloudsqliamuser` and cannot CREATE in `public`.
// The runtime — this — connects as an IAM principal with NO credential at all,
// inheriting `vetra_app` through role membership, so row-level security applies
// to it exactly as migration 029 intends. The powerful identity never appears
// in a running service.
// ---------------------------------------------------------------------------

/**
 * Read the Cloud SQL settings out of the environment, or null when this
 * deployment uses a plain DATABASE_URL instead.
 *
 * Returns null rather than throwing so a local workstation — which has no
 * CLOUD_SQL_INSTANCE and does not want one — takes the DATABASE_URL path with
 * no special casing at the call site.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{instance: string, database: string, user: string, password: string, authType: "IAM"|"PASSWORD", ipType: "PRIVATE"|"PUBLIC"}|null}
 */
function cloudSqlConfig(env = process.env) {
  const instance = (env.CLOUD_SQL_INSTANCE || "").trim();
  if (!instance) return null;

  const database = (env.CLOUD_SQL_DATABASE || "").trim();
  const user = (env.CLOUD_SQL_IAM_USER || "").trim();
  // Empty string, not undefined, matching the ESM twin exactly. The twin
  // agreement test caught this drifting on its first run — which is the
  // whole reason that test exists, since two copies with the same job and
  // subtly different return shapes is the failure mode of duplicating a
  // module rather than sharing it.
  const password = env.CLOUD_SQL_PASSWORD || "";

  // Named individually rather than as one "misconfigured" error. A missing
  // CLOUD_SQL_DATABASE and a missing CLOUD_SQL_IAM_USER produce identical
  // downstream symptoms — a pool that never connects — and the whole cost of
  // this failure is working out which one it was.
  if (!database) throw new Error("CLOUD_SQL_INSTANCE is set but CLOUD_SQL_DATABASE is not");
  if (!user) throw new Error("CLOUD_SQL_INSTANCE is set but CLOUD_SQL_IAM_USER is not");

  return {
    instance,
    database,
    user,
    password,
    // A password turns this into an ordinary Postgres login; without one the
    // connector fetches an OAuth token per connection. The migration job sets
    // one, a running service never does.
    authType: password ? "PASSWORD" : "IAM",
    // PRIVATE, because the instance has no public address at all
    // (`ipv4Enabled: false`). PUBLIC is here only so a scratch instance in a
    // restore test can be reached without editing this file.
    ipType: env.CLOUD_SQL_IP_TYPE === "PUBLIC" ? "PUBLIC" : "PRIVATE",
  };
}

/**
 * Build `pg.Pool` options that route through the Cloud SQL connector.
 *
 * ASYNCHRONOUS, and that is the awkward part rather than an implementation
 * detail: the connector fetches ephemeral client certificates before it can
 * hand over socket options, so this pool cannot be constructed at module load
 * the way a DATABASE_URL pool can. src/db/index.js therefore has an `init()`
 * that server.js awaits BEFORE the port opens — the same shape the voice server
 * uses, and for the same reason: a service that is listening and cannot reach
 * its database is worse than one that has not started.
 *
 * @param {ReturnType<typeof cloudSqlConfig>} cfg
 * @param {object} [extra] merged over the result, e.g. { max, connectionTimeoutMillis }
 */
async function cloudSqlPoolConfig(cfg, extra = {}) {
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: cfg.instance,
    // AuthTypes.PASSWORD when a password is present. Passing a password
    // alongside authType IAM is silently ignored by the connector, which is
    // the kind of thing that reads as a wrong password.
    authType: cfg.authType === "PASSWORD" ? AuthTypes.PASSWORD : AuthTypes.IAM,
    ipType: cfg.ipType === "PUBLIC" ? IpAddressTypes.PUBLIC : IpAddressTypes.PRIVATE,
  });

  return {
    poolConfig: {
      ...clientOpts,
      user: cfg.user,
      database: cfg.database,
      ...(cfg.password ? { password: cfg.password } : {}),
      // No `ssl` key. The connector terminates TLS itself; setting `ssl` here
      // makes pg try to negotiate a second time and the connection fails in a
      // way that reads as a certificate problem.
      ...extra,
    },
    // The connector holds timers and sockets. A process that builds a pool and
    // never closes it will not exit, which matters for a test run more than for
    // a service.
    close: () => connector.close(),
  };
}

module.exports = { cloudSqlConfig, cloudSqlPoolConfig };
