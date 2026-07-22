/**
 * Loading and validating per-business capability config.
 *
 * The thing under test is trust: this config comes from a database row an
 * operator (later, a customer) edited. It runs while a call is being set up, so
 * a bad value must degrade rather than throw — a caller must never hear silence
 * because someone typed a bad regex into a settings box.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => null) }));

const { loadConfig, normalizeAllowedTasks, CORE_TASKS } = await import("../services/supabase.js");
const { validateCapabilityConfig } = await import("../lib/capabilities/configSchema.js");
const appointments = (await import("../capabilities/appointments.js")).default;

const BUSINESS = {
  id: "biz-1",
  name: "Riverside Family Clinic",
  allowed_tasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
};

describe("loadConfig — dual read", () => {
  it("falls back to allowed_tasks when a business has no capability rows", () => {
    // An un-migrated database, or a partial deploy. Silently disabling every
    // capability mid-call would be far worse than ignoring the new table.
    const config = loadConfig(BUSINESS, []);
    expect(config.allowedTasks).toContain("book_appointment");
    expect(config.capabilities).toEqual({});
  });

  it("reads rows embedded on the business row", () => {
    const config = loadConfig({
      ...BUSINESS,
      business_capabilities: [
        { capability_id: "appointments", enabled: true, adapter: "athenahealth", config: {} },
      ],
    });
    expect(config.capabilities.appointments.adapter).toBe("athenahealth");
  });

  it("an explicitly disabled capability removes its module tasks", () => {
    // The state allowed_tasks could never express. Dave's Plumbing does not do
    // appointments, and now that is sayable.
    const config = loadConfig(BUSINESS, [
      { capability_id: "appointments", enabled: false, config: {} },
    ]);
    expect(config.allowedTasks).not.toContain("book_appointment");
    expect(config.allowedTasks).not.toContain("cancel_reschedule");
    expect(config.capabilities.appointments).toBeUndefined();
  });

  it("ignores a row for a capability this build does not have", () => {
    // Expected during a rollback: newer config, older code. Ignore it rather
    // than failing the call.
    const config = loadConfig(BUSINESS, [
      { capability_id: "not_a_real_pack", enabled: true, config: {} },
    ]);
    expect(config.capabilities.not_a_real_pack).toBeUndefined();
    expect(config.allowedTasks).toContain("book_appointment");
  });

  it("a business with no row at all still exposes an empty capabilities map", () => {
    // So packs and the requirement engine can read config without guarding.
    expect(loadConfig(null).capabilities).toEqual({});
  });
});

describe("normalizeAllowedTasks — empty vs unset", () => {
  it("unset means default", () => {
    expect(normalizeAllowedTasks(null)).toContain("book_appointment");
    expect(normalizeAllowedTasks(undefined)).toContain("book_appointment");
  });

  it("empty means explicitly nothing", () => {
    expect(normalizeAllowedTasks([])).toEqual([...CORE_TASKS]);
  });
});

describe("validateCapabilityConfig", () => {
  const validate = (raw) => validateCapabilityConfig(raw, appointments, "biz-1");

  it("keeps a well-formed custom identity field", () => {
    const out = validate({
      require: {
        identity: {
          custom: [
            {
              key: "dental_number",
              label: "Dental number",
              ask: "And your dental number?",
              pattern: "^[0-9]{6}$",
              verify: "collect_only",
            },
          ],
        },
      },
    });
    expect(out.require.identity.custom[0]).toMatchObject({
      key: "dental_number",
      label: "Dental number",
      pattern: "^[0-9]{6}$",
      verify: "collect_only",
    });
  });

  it("keeps the field but drops an unusable pattern", () => {
    // Dropping the whole field would quietly remove a requirement the operator
    // asked for; keeping it unchecked is the lesser failure.
    const out = validate({
      require: { identity: { custom: [{ key: "member_id", pattern: "([" }] } },
    });
    expect(out.require.identity.custom).toHaveLength(1);
    expect(out.require.identity.custom[0].pattern).toBeUndefined();
  });

  it("rejects a key that cannot become a tool parameter name", () => {
    const out = validate({
      require: { identity: { custom: [{ key: "bad key!" }, { key: "good_key" }] } },
    });
    expect(out.require.identity.custom.map((f) => f.key)).toEqual(["good_key"]);
  });

  it("rejects duplicate keys rather than emitting two identical parameters", () => {
    const out = validate({
      require: { identity: { custom: [{ key: "x" }, { key: "x" }] } },
    });
    expect(out.require.identity.custom).toHaveLength(1);
  });

  it("defaults an unrecognised verify mode to collect_only", () => {
    // Failing toward the WEAKER check: claiming a verification the backend
    // cannot perform is a guarantee that is not real, which is worse than an
    // honest speed bump.
    const out = validate({
      require: { identity: { custom: [{ key: "x", verify: "definitely_verified" }] } },
    });
    expect(out.require.identity.custom[0].verify).toBe("collect_only");
  });

  it("keeps a real adapter_field verify mode intact", () => {
    const out = validate({
      require: {
        identity: { custom: [{ key: "x", verify: { adapter_field: "patient.dental_id" } }] },
      },
    });
    expect(out.require.identity.custom[0].verify).toEqual({ adapter_field: "patient.dental_id" });
  });

  it("rejects an adapter the capability does not offer", () => {
    // Routing at a backend that does not exist would fail mid-call, after the
    // caller has already given their details.
    expect(validate({ adapter: "athenahealth" }).adapter).toBe("athenahealth");
    expect(validate({ adapter: "carrier_pigeon" }).adapter).toBeUndefined();
  });

  it("drops wrong-typed values without discarding the rest", () => {
    const out = validate({
      notes: 12345,
      require: { confirmBeforeWrite: "yes", businessHoursOnly: true },
    });
    expect(out.notes).toBeUndefined();
    expect(out.require.confirmBeforeWrite).toBeUndefined();
    expect(out.require.businessHoursOnly).toBe(true);
  });

  it("bounds prose so it cannot crowd out the conversation", () => {
    const out = validate({ notes: "x".repeat(5000) });
    expect(out.notes).toHaveLength(2000);
  });

  it("never throws on hostile input", () => {
    for (const raw of [null, undefined, "string", 42, [], { require: "nope" }]) {
      expect(() => validate(raw)).not.toThrow();
    }
  });
});
