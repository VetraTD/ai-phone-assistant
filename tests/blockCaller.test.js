// scripts/block-caller.js (batch-3 S4, Task 4.3): argument validation, with no
// database. A bad invocation must be refused before any connection is tried,
// and nothing it prints may carry a whole phone number.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { parseArgs, formatRow } from "../scripts/block-caller.js";

const NUM = "+15559990000";
const WHOLE_NUMBER = /\+?\d{7,}/; // a whole phone number anywhere in the output

function run(args) {
  // No CLOUD_SQL_* and no DATABASE_URL: if validation let anything through,
  // connect() would print "Neither DATABASE_URL nor CLOUD_SQL_INSTANCE is set".
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CLOUD_SQL_") || k === "DATABASE_URL") delete env[k];
  return spawnSync(process.execPath, ["scripts/block-caller.js", ...args], { encoding: "utf8", env, timeout: 20000 });
}

describe("parseArgs", () => {
  it("accepts a global add", () => {
    const r = parseArgs(["--add", NUM, "--reason", "prank caller"]);
    expect(r).toEqual({
      ok: true,
      value: { mode: "add", confirm: false, phone: NUM, reason: "prank caller", days: null, businessPhone: null },
    });
  });

  it("accepts a scoped, expiring, confirmed add", () => {
    const r = parseArgs(["--add", NUM, "--reason", "x", "--business", "+18175550100", "--days", "7", "--confirm"]);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ confirm: true, days: 7, businessPhone: "+18175550100" });
  });

  it("accepts a Twilio withheld placeholder", () => {
    expect(parseArgs(["--add", "+266696687", "--reason", "withheld flood"]).ok).toBe(true);
  });

  it("accepts remove and list", () => {
    expect(parseArgs(["--remove", NUM]).value).toMatchObject({ mode: "remove", phone: NUM, confirm: false });
    expect(parseArgs(["--list"]).value).toMatchObject({ mode: "list" });
  });

  it.each([
    ["a malformed number", ["--add", "5559990000", "--reason", "x"]],
    ["a number with formatting", ["--add", "+1 555 999 0000", "--reason", "x"]],
    ["a leading-zero country code", ["--add", "+05559990000", "--reason", "x"]],
    ["a missing reason", ["--add", NUM]],
    ["an empty reason", ["--add", NUM, "--reason", "  "]],
    ["a reason over 200 characters", ["--add", NUM, "--reason", "x".repeat(201)]],
    ["two modes", ["--add", NUM, "--reason", "x", "--remove", NUM]],
    ["no mode", ["--confirm"]],
    ["days of zero", ["--add", NUM, "--reason", "x", "--days", "0"]],
    ["days over a year", ["--add", NUM, "--reason", "x", "--days", "366"]],
    ["days that is not a number", ["--add", NUM, "--reason", "x", "--days", "soon"]],
    ["a malformed --business", ["--add", NUM, "--reason", "x", "--business", "office"]],
    ["--reason with --remove", ["--remove", NUM, "--reason", "x"]],
    ["--days with --list", ["--list", "--days", "3"]],
    ["--confirm with --list", ["--list", "--confirm"]],
    ["an unknown flag", ["--list", "--force"]],
    ["a repeated flag", ["--add", NUM, "--add", NUM, "--reason", "x"]],
    ["a flag with no value", ["--add", "--reason", "x"]],
  ])("refuses %s", (_name, argv) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join("\n")).not.toMatch(WHOLE_NUMBER);
  });

  it("accepts the bounds: 200-character reason, 365 days", () => {
    expect(parseArgs(["--add", NUM, "--reason", "x".repeat(200), "--days", "365"]).ok).toBe(true);
  });
});

describe("formatRow", () => {
  it("masks the number and marks an expired row", () => {
    const line = formatRow({ phone: NUM, business_id: null, reason: "r", expires_at: new Date(Date.now() - 1000) });
    expect(line).toContain("ending 0000");
    expect(line).toContain("scope: all");
    expect(line).toContain("(expired)");
    expect(line).not.toContain(NUM);
  });

  it("says until removed for a row with no expiry", () => {
    const line = formatRow({ phone: NUM, business_id: "11111111-1111-1111-1111-111111111111", reason: "r", expires_at: null });
    expect(line).toContain("until removed");
    expect(line).toContain("business 11111111");
  });

  it("masks a number typed into the reason down to its last four digits", () => {
    const line = formatRow({ phone: NUM, business_id: null, reason: "caller +447700900123 again, 12 calls", expires_at: null });
    expect(line).toContain("reason: caller +…0123 again, 12 calls");
    expect(line).not.toContain("7700900");
    expect(line).not.toMatch(WHOLE_NUMBER);
  });
});

describe("the script, run with no database configured", () => {
  it.each([
    ["a bad number", ["--add", "12345", "--reason", "x"]],
    ["a missing reason", ["--add", NUM]],
    ["two modes", ["--list", "--remove", NUM]],
    ["bad days", ["--add", NUM, "--reason", "x", "--days", "999"]],
  ])("%s exits non-zero with a message and never tries to connect", (_name, args) => {
    const r = run(args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Refusing: /m);
    expect(r.stdout + r.stderr).not.toMatch(/DATABASE_URL|CLOUD_SQL|config:/);
    expect(r.stdout + r.stderr).not.toMatch(WHOLE_NUMBER);
  });

  it("a valid command gets as far as the connection and stops there", () => {
    const r = run(["--list"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Neither DATABASE_URL nor CLOUD_SQL_INSTANCE is set/);
  });
});
