import { describe, it, expect } from "vitest";
import {
  localIdFor,
  assertE164,
  assertUuid,
  assertEmail,
  jobArgs,
  parseArgs,
} from "../scripts/onboard-tenant.js";

// ---------------------------------------------------------------------------
// The pure half of onboard-tenant.js.
//
// The rest of that script drives gcloud and Identity Platform and is verified
// by running it. What is tested here is the part where a mistake is SILENT:
// an id that is not stable, a delimiter that collides with the data, or an
// argument that reaches a shell unvalidated.
// ---------------------------------------------------------------------------

describe("localIdFor — stable, so a re-run upserts instead of duplicating", () => {
  it("returns the same id for the same address", () => {
    expect(localIdFor("owner@clinic.uk")).toBe(localIdFor("owner@clinic.uk"));
  });

  it("ignores case and surrounding whitespace, because a human types the address", () => {
    expect(localIdFor("  Owner@Clinic.UK ")).toBe(localIdFor("owner@clinic.uk"));
  });

  it("separates different addresses", () => {
    expect(localIdFor("a@clinic.uk")).not.toBe(localIdFor("b@clinic.uk"));
  });

  it("refuses an empty address rather than deriving an id from nothing", () => {
    expect(() => localIdFor("")).toThrow(/email is required/i);
    expect(() => localIdFor(null)).toThrow(/email is required/i);
  });

  it("produces something usable as an Identity Platform localId", () => {
    // Bounded and alphanumeric-with-dash. An id carrying whatever a person
    // typed would be rejected by the API at the least convenient moment.
    expect(localIdFor("owner@clinic.uk")).toMatch(/^tenant-[0-9a-f]{24}$/);
  });
});

describe("jobArgs — the delimiter that cost three failed executions", () => {
  it("joins arguments with a separator that survives an email address", () => {
    // gcloud's documented override is ^X^; `^@^` was tried first and the `@` in
    // an address was read as a separator. The failure named none of that.
    const out = jobArgs(["scripts/attach-tenant-user.js", "--email", "owner@clinic.uk"]);
    expect(out).toBe("^#^scripts/attach-tenant-user.js#--email#owner@clinic.uk");
    expect(out).toContain("owner@clinic.uk");
  });

  it("refuses an argument containing the delimiter rather than silently splitting it", () => {
    expect(() => jobArgs(["--note", "a#b"])).toThrow(/delimiter/i);
  });
});

describe("input validation — these values are interpolated into a shell command", () => {
  it("accepts real E.164 numbers and rejects the rest", () => {
    expect(assertE164("+441372656055")).toBe("+441372656055");
    expect(assertE164("+18176011171")).toBe("+18176011171");
    for (const bad of ["441372656055", "+44 1372 656055", "+0123456", "", "+44137265605; rm -rf /"]) {
      expect(() => assertE164(bad)).toThrow(/E.164/);
    }
  });

  it("accepts a uuid and rejects a near-miss", () => {
    expect(assertUuid("55c7c8c4-2c33-463c-875a-7f16d6bcc17e")).toBeTruthy();
    for (const bad of ["55c7c8c4", "55c7c8c4-2c33-463c-875a-7f16d6bcc17", "not-a-uuid", ""]) {
      expect(() => assertUuid(bad)).toThrow(/uuid/i);
    }
  });

  it("rejects an address carrying shell metacharacters", () => {
    expect(assertEmail("owner@clinic.uk")).toBe("owner@clinic.uk");
    expect(assertEmail("first.last+tag@sub.clinic.co.uk")).toBeTruthy();
    for (const bad of ["owner@clinic", "owner clinic.uk", "owner@clinic.uk; whoami", "$(id)@x.uk", ""]) {
      expect(() => assertEmail(bad)).toThrow();
    }
  });
});

describe("parseArgs", () => {
  it("reads the flags it documents", () => {
    const a = parseArgs(["--email", "o@c.uk", "--business", "abc", "--confirm"]);
    expect(a).toEqual({ email: "o@c.uk", business: "abc", phone: null, confirm: true });
  });

  it("defaults to a dry run, because the alternative writes to production", () => {
    expect(parseArgs(["--email", "o@c.uk", "--phone", "+441372656055"]).confirm).toBe(false);
  });
});
