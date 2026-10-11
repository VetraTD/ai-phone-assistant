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
