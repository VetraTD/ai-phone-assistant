import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Static pin (no DB): migration 054 (loop guard, block list, repeat-caller
// counts) is folded into schema.sql exactly. The 054 file itself is never
// edited once applied (checksum recorded).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const schema = read("database/schema.sql");
const mig = read("database/054_loop_guard_block_list.sql");

const FNS = [
  "app_record_pending_dial",
  "app_end_pending_dial",
  "app_dial_bounced",
  "app_caller_blocked",
  "app_calls_from_today",
  "app_ai_seconds_today",
];

const fnBlock = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(start, close + 2);
};

describe("migration 054 is folded into schema.sql exactly", () => {
  it("054 begins (after its comments) with the lock_timeout line", () => {
    const first = mig.split("\n").find((l) => l.trim() !== "" && !l.startsWith("--"));
    expect(first).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("schema.sql carries no lock_timeout", () => {
    expect(schema).not.toMatch(/lock_timeout/);
  });

  it("both platform tables are revoked from vetra_app in both files", () => {
    for (const t of ["pending_dials", "blocked_callers"]) {
      const line = `REVOKE ALL ON ${t} FROM vetra_app;`;
      expect(mig, `${t} revoke missing from 054`).toContain(line);
      expect(schema, `${t} revoke missing from schema.sql`).toContain(line);
    }
  });

  it("the pending_dials id sequence is revoked from vetra_app in both files", () => {
    const line = "REVOKE ALL ON SEQUENCE pending_dials_id_seq FROM vetra_app;";
    expect(mig).toContain(line);
    expect(schema).toContain(line);
  });

  it("app_end_pending_dial also purges rows older than a day", () => {
    expect(fnBlock(mig, "app_end_pending_dial")).toContain("DELETE FROM pending_dials WHERE started_at < now() - interval '1 day';");
  });

  it("neither platform table enables row-level security", () => {
    expect(mig).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  for (const name of FNS) {
    it(`${name}: definition is byte-identical in 054 and schema.sql`, () => {
      const a = fnBlock(mig, name);
      const b = fnBlock(schema, name);
      expect(a.length).toBeGreaterThan(100);
      expect(b).toBe(a);
    });

    it(`${name}: is definer-only (REVOKE PUBLIC, GRANT vetra_app) in both files`, () => {
      for (const sql of [mig, schema]) {
        expect(sql).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${name}\([^)]*\) FROM PUBLIC;`));
        expect(sql).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${name}\([^)]*\) TO vetra_app;`));
      }
    });
  }

  it("the bounce function only matches open, unexpired rows", () => {
    const body = fnBlock(mig, "app_dial_bounced");
    expect(body).toContain("pd.ended_at IS NULL");
    expect(body).toContain("AND pd.expires_at > now()");
    expect(mig.split("AND pd.expires_at > now()").length - 1).toBe(1);
  });

  it("the record function expires a dial at timeout + 15 s", () => {
    expect(fnBlock(mig, "app_record_pending_dial")).toContain("+ 15");
  });

  it("the functions that read calls set and restore their own tenant scope", () => {
    const walk = fnBlock(mig, "app_calls_from_today");
    expect(walk).toContain("PERFORM set_config('app.business_id', v_id::text, true)");
    expect(walk).toContain("PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true)");
    const secs = fnBlock(mig, "app_ai_seconds_today");
    expect(secs).toContain("PERFORM set_config('app.business_id', p_business::text, true)");
    expect(secs).toContain("PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true)");
  });
});
