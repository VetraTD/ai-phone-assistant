import { describe, it, expect } from "vitest";
import { cloudSqlConfig } from "../lib/db/cloudSqlPool.js";

// The connector itself is not exercised here — it opens a real mTLS session to
// a real instance, so testing it would mean testing Google's client. What IS
// worth pinning is the selection logic, because every one of its failure modes
// is silent: connecting to the wrong database, or with the wrong identity, or
// falling back to a local DATABASE_URL when the operator named a Cloud SQL
// instance, all look like success until something reads a row that is not there.

const BASE = {
  CLOUD_SQL_INSTANCE: "vetra-us-staging-c3a3bd:us-central1:vetra-us-staging",
  CLOUD_SQL_IAM_USER: "voice-us-staging@vetra-us-staging-c3a3bd.iam",
  CLOUD_SQL_DATABASE: "vetra_us_staging",
};

describe("cloudSqlConfig", () => {
  it("is inert unless CLOUD_SQL_INSTANCE is set", () => {
    // The whole local development story depends on this: no instance, no Cloud
    // SQL path, DATABASE_URL keeps working untouched.
    expect(cloudSqlConfig({})).toBeNull();
    expect(cloudSqlConfig({ DATABASE_URL: "postgres://localhost/x" })).toBeNull();
  });

  it("defaults to IAM auth with no password", () => {
    const cfg = cloudSqlConfig(BASE);
    expect(cfg.authType).toBe("IAM");
    expect(cfg.password).toBe("");
    expect(cfg.user).toBe(BASE.CLOUD_SQL_IAM_USER);
    expect(cfg.database).toBe("vetra_us_staging");
  });

  it("switches to password auth only when a password is present", () => {
    const cfg = cloudSqlConfig({ ...BASE, CLOUD_SQL_PASSWORD: "s3cret" });
    expect(cfg.authType).toBe("PASSWORD");
    expect(cfg.password).toBe("s3cret");
  });

  it("defaults to PRIVATE ip, because the instances have no public one", () => {
    expect(cloudSqlConfig(BASE).ipType).toBe("PRIVATE");
    expect(cloudSqlConfig({ ...BASE, CLOUD_SQL_IP_TYPE: "PUBLIC" }).ipType).toBe("PUBLIC");
    // Anything unrecognised stays PRIVATE. Failing closed matters here: a typo
    // must not open a path to a public endpoint.
    expect(cloudSqlConfig({ ...BASE, CLOUD_SQL_IP_TYPE: "public" }).ipType).toBe("PRIVATE");
    expect(cloudSqlConfig({ ...BASE, CLOUD_SQL_IP_TYPE: "" }).ipType).toBe("PRIVATE");
  });

  it("REFUSES a half-configured instance rather than falling back", () => {
    // The dangerous version of this bug is silent: CLOUD_SQL_INSTANCE set,
    // CLOUD_SQL_DATABASE forgotten, and the process quietly migrating the
    // developer's laptop database instead of staging.
    expect(() => cloudSqlConfig({ CLOUD_SQL_INSTANCE: BASE.CLOUD_SQL_INSTANCE })).toThrow(
      /CLOUD_SQL_IAM_USER and\/or CLOUD_SQL_DATABASE/
    );
    expect(() =>
      cloudSqlConfig({ ...BASE, CLOUD_SQL_DATABASE: "", DATABASE_URL: "postgres://localhost/x" })
    ).toThrow(/Refusing to fall back to DATABASE_URL/);
  });

  it("rejects an instance NAME given where a connection NAME belongs", () => {
    // `vetra-us-staging` instead of `project:region:vetra-us-staging` is the
    // single most likely typo, and at connect time it surfaces as a
    // not-found that reads like a permissions problem.
    expect(() => cloudSqlConfig({ ...BASE, CLOUD_SQL_INSTANCE: "vetra-us-staging" })).toThrow(
      /must be "project:region:instance"/
    );
    expect(() => cloudSqlConfig({ ...BASE, CLOUD_SQL_INSTANCE: "proj:us-central1" })).toThrow(
      /must be "project:region:instance"/
    );
  });

  it("trims surrounding whitespace, which a copy-paste from the console adds", () => {
    const cfg = cloudSqlConfig({
      CLOUD_SQL_INSTANCE: `  ${BASE.CLOUD_SQL_INSTANCE}  `,
      CLOUD_SQL_IAM_USER: ` ${BASE.CLOUD_SQL_IAM_USER} `,
      CLOUD_SQL_DATABASE: " vetra_us_staging ",
    });
    expect(cfg.instance).toBe(BASE.CLOUD_SQL_INSTANCE);
    expect(cfg.database).toBe("vetra_us_staging");
  });

  it("the IAM user is the SA email WITHOUT .gserviceaccount.com", () => {
    // Postgres caps identifiers at 63 characters and Cloud SQL trims the suffix
    // when it creates the user. Passing the full email produces a user that
    // exists and can never authenticate — a failure that looks like a wrong
    // password. Terraform trims it; this pins the shape it must arrive in.
    expect(cloudSqlConfig(BASE).user).not.toMatch(/\.gserviceaccount\.com$/);
    expect(cloudSqlConfig(BASE).user.length).toBeLessThanOrEqual(63);
  });
});
