/**
 * Connecting to Cloud SQL without a password.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * The staging and production databases are private-IP only and have
 * `cloudsql.iam_authentication` on. THE RUNTIME HAS NO PASSWORD: it connects as
 * its own service-account identity with a short-lived OAuth token minted at
 * connect time from the metadata server.
 *
 * One password does exist, and it is worth being precise about rather than
 * claiming otherwise. Applying a schema needs privileges the application must
 * never hold — CREATE on `public`, role creation, ownership — so MIGRATIONS
 * connect as a superuser with a password from Secret Manager. Nothing that
 * serves a call ever reads it.
 *
 * Three things follow, and the third is why this file is worth its weight:
 *
 *   1. Nothing to store, rotate, or leak. Revocation is removing an IAM
 *      binding, which is how offboarding already works.
 *   2. Postgres sees the IAM identity, so the instance's `log_connections`
 *      records WHO connected rather than a shared `vetra_app` — an actual
 *      §164.312(b) answer instead of a login nobody can attribute.
 *   3. TLS is handled correctly by construction. B2-rls found
 *      `ssl: { rejectUnauthorized: false }` shipped against the PHI database —
 *      verification off, on the connection that carries patient data. The
 *      connector does mTLS with certificates it fetches from the Cloud SQL
 *      Admin API, so there is no `rejectUnauthorized` to get wrong and no CA
 *      bundle to ship.
 *
 * ---------------------------------------------------------------------------
 * It does NOT replace DATABASE_URL
 * ---------------------------------------------------------------------------
 *
 * Local development, the Docker PG16 in `infra/docker-compose.dev.yml`, and
 * every `tests/db/*` suite run against a plain connection string and must keep
 * working untouched. So this is additive: `CLOUD_SQL_INSTANCE` selects it, and
 * its absence means nothing here is loaded at all — the import is dynamic
 * precisely so a developer without the dependency installed, or without GCP
 * credentials, never trips over it.
 */

/**
 * @typedef {object} CloudSqlConfig
 * @property {string} instance  Connection name, `project:region:instance`.
 * @property {string} user      IAM principal. A service account WITHOUT the
 *                              `.gserviceaccount.com` suffix — Postgres caps
 *                              identifiers at 63 characters, and the full email
 *                              produces a user that exists and can never
 *                              authenticate.
 * @property {string} database
 * @property {string} password  Empty for IAM auth. Set only for migrations.
 * @property {"IAM"|"PASSWORD"} authType
 * @property {"PRIVATE"|"PUBLIC"} ipType
 */

/**
 * Read the Cloud SQL settings from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {CloudSqlConfig|null} null when this path is not in use.
 */
export function cloudSqlConfig(env = process.env) {
  const instance = (env.CLOUD_SQL_INSTANCE || "").trim();
  if (!instance) return null;

  const user = (env.CLOUD_SQL_IAM_USER || "").trim();
  const database = (env.CLOUD_SQL_DATABASE || "").trim();

  // Announced loudly rather than half-configured. An operator who set
  // CLOUD_SQL_INSTANCE asked for this path; falling back to DATABASE_URL here
  // would give them a different database than the one they named, silently.
  if (!user || !database) {
    throw new Error(
      "CLOUD_SQL_INSTANCE is set but CLOUD_SQL_IAM_USER and/or CLOUD_SQL_DATABASE are not. " +
        "Refusing to fall back to DATABASE_URL, which would connect somewhere other than the " +
        "instance you named."
    );
  }

  // `project:region:instance`. Getting this wrong fails at connect time with a
  // message about the instance not being found, which reads like a permissions
  // problem — so it is checked here, where the fix is obvious.
  if (instance.split(":").length !== 3) {
    throw new Error(
      `CLOUD_SQL_INSTANCE must be "project:region:instance", got "${instance}". ` +
        "This is the connection name, not the instance name."
    );
  }

  // Password auth is for the MIGRATION path only, and the asymmetry is
  // deliberate. Applying a schema needs privileges the application must never
  // have: CREATE on `public`, role creation, ownership. Migration 029 builds
  // `vetra_app` as NOSUPERUSER NOBYPASSRLS precisely so the runtime cannot do
  // those things, and RLS would be decorative if the app connected as the role
  // that can turn it off.
  //
  // So: migrations connect as a superuser with a password held in Secret
  // Manager; the runtime connects as an IAM principal with no password at all.
  // Two identities, two privilege levels, one of which never appears in a
  // running service.
  const password = env.CLOUD_SQL_PASSWORD || "";

  return {
    instance,
    user,
    database,
    password,
    authType: password ? "PASSWORD" : "IAM",
    // PRIVATE because the instances have `ipv4_enabled = false`. PUBLIC is left
    // reachable only for a future non-private instance; it is not a fallback,
    // and asking for it against a private-only instance fails rather than
    // quietly opening a path to the internet.
    ipType: env.CLOUD_SQL_IP_TYPE === "PUBLIC" ? "PUBLIC" : "PRIVATE",
  };
}

/**
 * Build `pg.Pool` options for a Cloud SQL instance using automatic IAM
 * database authentication.
 *
 * The caller owns the returned `close`: the connector holds a refresh timer per
 * instance, and a process that never calls it will not exit. Cloud Run Jobs in
 * particular hang forever at the end of a successful run.
 *
 * @param {CloudSqlConfig} cfg
 * @param {object} [extra] Extra pg.Pool options, e.g. `{ max: 5 }`.
 * @returns {Promise<{ poolConfig: object, close: () => void }>}
 */
export async function cloudSqlPoolConfig(cfg, extra = {}) {
  const { Connector, AuthTypes, IpAddressTypes } = await import("@google-cloud/cloud-sql-connector");

  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: cfg.instance,
    // IAM unless a password was supplied. Never both — a password present
    // alongside authType IAM is silently ignored by the connector, which is
    // how you end up debugging a permission error while holding the right
    // credential.
    authType: cfg.authType === "PASSWORD" ? AuthTypes.PASSWORD : AuthTypes.IAM,
    ipType: cfg.ipType === "PUBLIC" ? IpAddressTypes.PUBLIC : IpAddressTypes.PRIVATE,
  });

  return {
    poolConfig: {
      ...clientOpts,
      user: cfg.user,
      database: cfg.database,
      ...(cfg.password ? { password: cfg.password } : {}),
      ...extra,
    },
    close: () => connector.close(),
  };
}
