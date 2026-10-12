import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

const b64 = (s) => Buffer.from(s).toString("base64");
function run(field, value) {
  return spawnSync(
    process.execPath,
    ["scripts/set-business-config.js", "--to", "+441372656055", "--set", `${field}=${b64(value)}`],
    {
      env: { ...process.env, CLOUD_SQL_INSTANCE: "", DATABASE_URL: "", CLOUD_SQL_PASSWORD: "" },
      encoding: "utf8",
      timeout: 20000,
    }
  );
}

describe("set-business-config validation (before any connect)", () => {
  it("refuses a bad transfer_no_answer", () => {
    const r = run("transfer_no_answer", "maybe");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing: --set transfer_no_answer");
  });
  for (const bad of ["+44 1372 656055", "01372656055"]) {
    it(`refuses transfer_phone_number ${JSON.stringify(bad)} without echoing it`, () => {
      const r = run("transfer_phone_number", bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Refusing: --set transfer_phone_number");
      expect(r.stderr).not.toContain(bad);
    });
  }
  it("lets valid values past validation", () => {
    for (const [f, v] of [["transfer_no_answer", "own_voicemail"], ["transfer_no_answer", "take_message"], ["transfer_phone_number", "+441372656055"]]) {
      const r = run(f, v);
      expect(r.stderr).not.toContain("Refusing");
      // Got PAST validation to the connect stage (not a crash at import): with
      // no instance and no URL, cloudSqlPoolConfig fails to connect.
      expect(r.stderr).toContain("Missing instance connection name");
    }
  });
});

// Number block (batch 3 S3, Task 3.2a)
function runMany(sets) {
  const args = ["scripts/set-business-config.js", "--to", "+441372656055"];
  for (const [f, v] of sets) args.push("--set", `${f}=${b64(v)}`);
  return spawnSync(process.execPath, args, {
    env: { ...process.env, CLOUD_SQL_INSTANCE: "", DATABASE_URL: "", CLOUD_SQL_PASSWORD: "" },
    encoding: "utf8",
    timeout: 20000,
  });
}
const PASSED = (r) => {
  expect(r.stderr).not.toContain("Refusing");
  expect(r.stderr).toContain("Missing instance connection name");
};

describe("set-business-config: allow_pricier_numbers", () => {
  it("refuses anything but exactly true or false", () => {
    for (const bad of ["maybe", "TRUE", "1", "yes"]) {
      const r = run("allow_pricier_numbers", bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Refusing: --set allow_pricier_numbers");
    }
  });
  it("lets true and false past validation", () => {
    PASSED(run("allow_pricier_numbers", "true"));
    PASSED(run("allow_pricier_numbers", "false"));
  });
});

describe("set-business-config: transfer_phone_number price check", () => {
  const NEVER = "+449090123456";
  const NEEDS_SWITCH = "+447624123456";
  it("refuses a never number without echoing it", () => {
    const r = run("transfer_phone_number", NEVER);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing: --set transfer_phone_number");
    expect(r.stderr).not.toContain(NEVER);
    expect(r.stderr).not.toContain(NEVER.slice(1));
  });
  it("refuses a needs_switch_on number alone, and with allow_pricier_numbers=false", () => {
    const r = run("transfer_phone_number", NEEDS_SWITCH);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing");
    expect(r.stderr).not.toContain(NEEDS_SWITCH);
    expect(runMany([["transfer_phone_number", NEEDS_SWITCH], ["allow_pricier_numbers", "false"]]).status).toBe(1);
  });
  it("passes with allow_pricier_numbers=true in the same command, either argument order", () => {
    PASSED(runMany([["transfer_phone_number", NEEDS_SWITCH], ["allow_pricier_numbers", "true"]]));
    PASSED(runMany([["allow_pricier_numbers", "true"], ["transfer_phone_number", NEEDS_SWITCH]]));
  });
  it("passes a normal London number", () => {
    PASSED(run("transfer_phone_number", "+442079460958"));
  });
  it("allow_pricier_numbers=true does not unlock a never number", () => {
    const r = runMany([["transfer_phone_number", NEVER], ["allow_pricier_numbers", "true"]]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing");
  });
});
