import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { cloudSqlConfig } = require("../db/cloudSqlPool.js");

// ---------------------------------------------------------------------------
// Reading Cloud SQL settings out of the environment.
//
// The third deliberate CommonJS twin of an ESM module in the voice server,
// after sessionAge.js and idToken.js, and tested to the same behaviour rather
// than assumed to have it.
//
// WHAT THIS EXISTS FOR, because "the backend can talk to the database" sounds
// like it was always true: until 2026-08-22 this backend understood only
// DATABASE_URL — a connection string with a host and a password. The Cloud SQL
// instance is PRIVATE IP ONLY and has no password at all, because B2 created no
// `google_sql_user` on the grounds that a password in a Terraform resource is a
// password in state. There was therefore NO connection string that could have
// worked, and the dashboard could not have reached a GCP database however it
// was deployed. The image would have built and had nothing to talk to.
//
// Only the pure half is covered here. `cloudSqlPoolConfig` opens a real
// connector and fetches certificates from Google, which is an integration test
// and not this.
// ---------------------------------------------------------------------------

const BASE = {
  CLOUD_SQL_INSTANCE: "vetra-us-staging-c3a3bd:us-central1:vetra-us-staging",
  CLOUD_SQL_DATABASE: "vetra_us_staging",
  CLOUD_SQL_IAM_USER: "voice-us-staging@vetra-us-staging-c3a3bd.iam",
};

describe("cloudSqlConfig", () => {
  it("returns NULL with no CLOUD_SQL_INSTANCE, so a workstation takes the DATABASE_URL path", () => {
    // Null rather than a throw is the whole ergonomics of this: local dev has no
    // instance and does not want one, and the call site should not have to
    // branch on which kind of database it has.
    expect(cloudSqlConfig({})).toBeNull();
    expect(cloudSqlConfig({ CLOUD_SQL_INSTANCE: "   " })).toBeNull();
  });

  it("reads a complete IAM configuration — the shape a running service has", () => {
    expect(cloudSqlConfig(BASE)).toEqual({
      instance: BASE.CLOUD_SQL_INSTANCE,
      database: BASE.CLOUD_SQL_DATABASE,
      user: BASE.CLOUD_SQL_IAM_USER,
      password: "",
      authType: "IAM",
      ipType: "PRIVATE",
    });
  });

  it("switches to PASSWORD auth only when a password is present", () => {
    // The two identities, and the runtime is the weak one. A password means the
    // migration job; a service never has one. Passing a password alongside
    // authType IAM is silently ignored by the connector, which reads as a wrong
    // password — so the choice is made here, from the presence of the value.
    const cfg = cloudSqlConfig({ ...BASE, CLOUD_SQL_PASSWORD: "s3cret" });
    expect(cfg.authType).toBe("PASSWORD");
    expect(cfg.password).toBe("s3cret");
  });

  it("defaults to PRIVATE ip, because the instance has no public address at all", () => {
    expect(cloudSqlConfig(BASE).ipType).toBe("PRIVATE");
    expect(cloudSqlConfig({ ...BASE, CLOUD_SQL_IP_TYPE: "anything-else" }).ipType).toBe("PRIVATE");
  });

  it("allows PUBLIC only when asked for by that exact word", () => {
    // Present for a scratch instance in a restore test (C7), not for production.
    expect(cloudSqlConfig({ ...BASE, CLOUD_SQL_IP_TYPE: "PUBLIC" }).ipType).toBe("PUBLIC");
  });

  it("NAMES the missing setting rather than failing as one 'misconfigured'", () => {
    // A missing database and a missing user produce identical downstream
    // symptoms — a pool that never connects — and the entire cost of this
    // failure is working out which one it was.
    expect(() => cloudSqlConfig({ ...BASE, CLOUD_SQL_DATABASE: "" })).toThrow(
      /CLOUD_SQL_DATABASE is not/
    );
    expect(() => cloudSqlConfig({ ...BASE, CLOUD_SQL_IAM_USER: "" })).toThrow(
      /CLOUD_SQL_IAM_USER is not/
    );
  });

  it("trims, so a trailing newline in a secret does not become part of an identifier", () => {
    // A leading newline in a Supabase cell once made every business answer as
    // "our office". Whitespace from a copied value is a real failure mode here.
    const cfg = cloudSqlConfig({
      CLOUD_SQL_INSTANCE: ` ${BASE.CLOUD_SQL_INSTANCE}\n`,
      CLOUD_SQL_DATABASE: ` ${BASE.CLOUD_SQL_DATABASE} `,
      CLOUD_SQL_IAM_USER: `${BASE.CLOUD_SQL_IAM_USER}\n`,
    });
    expect(cfg.instance).toBe(BASE.CLOUD_SQL_INSTANCE);
    expect(cfg.database).toBe(BASE.CLOUD_SQL_DATABASE);
    expect(cfg.user).toBe(BASE.CLOUD_SQL_IAM_USER);
  });
});

describe("the two twins agree", () => {
  it("reads the same environment the voice server's ESM copy does", async () => {
    // The whole risk of a deliberate duplicate is that one side drifts. This
    // pins the CONTRACT — same inputs, same decisions — rather than the code.
    const esm = await import("../../../../lib/db/cloudSqlPool.js");
    const mine = cloudSqlConfig(BASE);
    const theirs = esm.cloudSqlConfig(BASE);
    expect(mine).toEqual(theirs);

    const minePw = cloudSqlConfig({ ...BASE, CLOUD_SQL_PASSWORD: "p" });
    const theirsPw = esm.cloudSqlConfig({ ...BASE, CLOUD_SQL_PASSWORD: "p" });
    expect(minePw.authType).toBe(theirsPw.authType);
    expect(cloudSqlConfig({})).toEqual(esm.cloudSqlConfig({}));
  });
});
