/**
 * Loading and validating per-business capability config.
 *
 * The thing under test is trust: this config comes from a database row an
 * operator (later, a customer) edited. It runs while a call is being set up, so
 * a bad value must degrade rather than throw — a caller must never hear silence
 * because someone typed a bad regex into a settings box.
 */

import { describe, it, expect } from "vitest";

// A vi.mock of the Supabase client used to stand here, and it is gone with the
// package. services/db.js has connected to Postgres directly since A3, so the
// mock was insulating this suite from an import that no longer existed.
// tests/supabaseGone.test.js keeps it gone — and caught this comment naming the
// package literally, which is the scan working.

const { loadConfig, normalizeAllowedTasks, CORE_TASKS } = await import("../services/db.js");
const { validateCapabilityConfig } = await import("../lib/capabilities/configSchema.js");
const appointments = (await import("../capabilities/appointments.js")).default;
const messages = (await import("../capabilities/messages.js")).default;

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

  it("enabling a capability the business lacked ADDS its module tasks", () => {
    // Without this, switching a capability on in the dashboard stores
    // enabled=true and still registers no tools — a setting that looks like it
    // worked and does nothing.
    const plumber = { id: "biz-2", name: "Dave's Plumbing", allowed_tasks: [] };
    const config = loadConfig(plumber, [
      { capability_id: "quotes", enabled: true, config: {} },
    ]);
    expect(config.allowedTasks).toContain("quote_request");
  });

  it("enabling does not widen a finer-grained choice the business already made", () => {
    // A business that opted into booking but NOT cancelling expressed a real
    // preference at a finer grain than one capability row can carry. Enabling
    // the capability must not silently grant the rest.
    const config = loadConfig(
      { id: "biz-3", name: "Acme", allowed_tasks: ["book_appointment"] },
      [{ capability_id: "appointments", enabled: true, config: {} }]
    );
    expect(config.allowedTasks).toContain("book_appointment");
    expect(config.allowedTasks).not.toContain("cancel_reschedule");
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

  it("keeps well-formed availability numbers (no on/off flag — the calendar always checks)", () => {
    // A stray `enabled` from an older shape is ignored, not stored.
    const out = validate({ availability: { enabled: true, length: 45, capacity: 2 } });
    expect(out.availability).toEqual({ length: 45, capacity: 2 });
  });

  it("drops an out-of-range number but keeps the valid one", () => {
    const out = validate({ availability: { length: 4, capacity: 2 } });
    // length (below 5) dropped; capacity kept.
    expect(out.availability).toEqual({ capacity: 2 });
  });

  it("never injects availability defaults — absence stays absence (snapshot safety)", () => {
    expect(validate({}).availability).toBeUndefined();
    expect(validate({ availability: {} }).availability).toBeUndefined();
    expect(validate({ availability: { enabled: true } }).availability).toBeUndefined();
  });

  it("keeps a builtin identity array", () => {
    const out = validate({ require: { identity: { builtin: ["name", "dob", "phone_on_file"] } } });
    expect(out.require.identity.builtin).toEqual(["name", "dob", "phone_on_file"]);
  });

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

  it("keeps a valid existingAppointment policy", () => {
    for (const v of ["confirm", "allow", "block"]) {
      expect(validate({ existingAppointment: v }).existingAppointment).toBe(v);
    }
  });

  it("drops an existingAppointment value the engine would not understand", () => {
    // Silently reaching the pack would read as the default and hide a bad save.
    expect(validate({ existingAppointment: "maybe" }).existingAppointment).toBeUndefined();
    expect(validate({ existingAppointment: true }).existingAppointment).toBeUndefined();
  });

  it("never writes the existingAppointment default, so absence stays absence", () => {
    // Same rule availability follows: writing "confirm" into every business's
    // config would move every prompt snapshot and make an unset business
    // indistinguishable from one that chose.
    expect("existingAppointment" in validate({})).toBe(false);
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

  it("bounds a custom identity label so it cannot bloat guardrails and tool params", () => {
    // label flows into guardrail bullets AND tool param descriptions — unbounded
    // it would push the cacheable prefix around on every call.
    const out = validate({
      require: { identity: { custom: [{ key: "x", label: "L".repeat(500) }] } },
    });
    expect(out.require.identity.custom[0].label).toHaveLength(100);
  });

  it("bounds a custom identity ask — it is spoken verbatim", () => {
    const out = validate({
      require: { identity: { custom: [{ key: "x", ask: "A".repeat(1000) }] } },
    });
    expect(out.require.identity.custom[0].ask).toHaveLength(300);
  });

  it("rejects an overlong pattern rather than slicing it (slicing could corrupt a regex)", () => {
    // A valid-but-huge regex: slicing mid-escape would produce a different or
    // broken regex, so the whole pattern is dropped and the field kept unchecked.
    const out = validate({
      require: {
        identity: { custom: [{ key: "x", pattern: `^(?:${"a".repeat(300)})$` }] },
      },
    });
    expect(out.require.identity.custom).toHaveLength(1);
    expect(out.require.identity.custom[0].pattern).toBeUndefined();
  });

  it("keeps a pattern at the 200-char boundary", () => {
    const pattern = `^${"a".repeat(198)}$`; // exactly 200 chars, valid regex
    expect(pattern).toHaveLength(200);
    const out = validate({
      require: { identity: { custom: [{ key: "x", pattern }] } },
    });
    expect(out.require.identity.custom[0].pattern).toBe(pattern);
  });

  it("never throws on hostile input", () => {
    for (const raw of [null, undefined, "string", 42, [], { require: "nope" }]) {
      expect(() => validate(raw)).not.toThrow();
    }
  });
});

describe("loadConfig — allowPricierNumbers (migration 053)", () => {
  it("true passes through", () => {
    expect(loadConfig({ ...BUSINESS, allow_pricier_numbers: true }, []).allowPricierNumbers).toBe(true);
  });
  it("false, null, undefined and the string \"true\" are all false", () => {
    for (const v of [false, null, undefined, "true", 1, "t"]) {
      expect(loadConfig({ ...BUSINESS, allow_pricier_numbers: v }, []).allowPricierNumbers).toBe(false);
    }
  });
  it("null business is false", () => {
    expect(loadConfig(null).allowPricierNumbers).toBe(false);
  });
});

describe("loadConfig — transferNoAnswer (migration 052)", () => {
  it("passes own_voicemail through", () => {
    expect(loadConfig({ ...BUSINESS, transfer_no_answer: "own_voicemail" }, []).transferNoAnswer).toBe("own_voicemail");
  });
  it("unknown or missing falls back to take_message", () => {
    expect(loadConfig({ ...BUSINESS, transfer_no_answer: "maybe" }, []).transferNoAnswer).toBe("take_message");
    expect(loadConfig(BUSINESS, []).transferNoAnswer).toBe("take_message");
  });
  it("null business defaults to take_message", () => {
    expect(loadConfig(null).transferNoAnswer).toBe("take_message");
  });
});

describe("messages — callbackLine (who calls back and how soon)", () => {
  const CALLBACK = "Sam will call you back as soon as he can.";
  const validateMessages = (raw) => validateCapabilityConfig(raw, messages, "biz-1");
  // Caller-experience Task 3: the numbered checklist is the HEALTHCARE tier's
  // protocol now (byte-identical to before); the standard tier has a described
  // goal. The checklist assertions below therefore run on a hipaa config, and
  // the standard tier gets its own counterparts.
  const HIPAA = { complianceTier: "hipaa" };
  const rendered = (config, tier = HIPAA) => {
    const out = messages.prompt({ capabilities: { messages: config }, ...tier });
    return {
      protocol: out.static.protocols[0],
      take: out.dynamic.stepGuidance.take_message,
      callback: out.dynamic.stepGuidance.callback_request,
    };
  };

  it("standard tier: with no callbackLine the goal has an urgency line and the standing promise", () => {
    const { protocol, take } = rendered({}, {});
    expect(protocol).toContain("Urgency: ask an existing client");
    expect(protocol).toContain("Promise the callback: say someone will get back to them as soon as possible if it is urgent");
    expect(take).toContain("Urgency: ask an existing client");
    expect(take).toContain("Promise the callback: say someone will get back");
  });

  it("standard tier: callbackLine replaces the promise and removes the urgency line", () => {
    const { protocol, take, callback } = rendered({ callbackLine: CALLBACK }, {});
    expect(protocol).toContain(`Promise the callback: "${CALLBACK}"`);
    expect(protocol).not.toContain("Urgency:");
    expect(protocol).not.toContain("as soon as possible if it is urgent");
    for (const g of [take, callback]) {
      expect(g).toContain(`Promise the callback: "${CALLBACK}"`);
      expect(g).not.toContain("Urgency:");
    }
  });

  it("standard tier: the guidance says the caller-ID number is not asked for, as the protocol does", () => {
    const { protocol, take, callback } = rendered({}, {});
    for (const text of [protocol, take, callback]) {
      expect(text).toContain("Number: when THIS CALLER'S NUMBER is known, do not ask for a number");
    }
  });

  it("healthcare tier: with no callbackLine the protocol keeps the urgency step and the standing promise", () => {
    const { protocol, take } = rendered({});
    expect(protocol).toContain("4. Urgency: ask");
    expect(protocol).toContain('6. Promise the callback: "Someone will get back to you');
    expect(protocol).toContain("7. Extra questions:");
    expect(take).toContain("(4) ask if it's urgent");
    expect(take).toContain("(6) promise the callback.");
  });

  it("healthcare tier: callbackLine replaces the promise and removes the urgency step", () => {
    const { protocol, take, callback } = rendered({ callbackLine: CALLBACK });
    expect(protocol).toContain(`Promise the callback: "${CALLBACK}"`);
    expect(protocol).not.toContain("Is this urgent");
    expect(protocol).not.toContain("Someone will get back to you");
    expect(protocol).toContain("4. Summarise it ONCE");
    expect(protocol).toContain("5. Promise the callback:");
    expect(protocol).toContain("6. Extra questions:");
    expect(take).toContain(`(5) promise the callback: "${CALLBACK}".`);
    expect(take).not.toContain("urgent");
    expect(take).not.toContain("Someone will get back to you");
    expect(callback).toContain(`(5) promise the callback: "${CALLBACK}".`);
  });

  it("healthcare tier, LVX189: the step guidance offers the caller's number once, as protocol step 2 does", () => {
    // The guidance tail reaches the cascade path, so it must not keep the old
    // "ask for the best callback number" beside a step 2 that offers the
    // caller-ID number first. Both intents, with and without a callbackLine.
    const STEP =
      "(2) if you know the number they are calling from, ask once whether it is the best one; otherwise ask for the best number once;";
    for (const config of [{}, { callbackLine: CALLBACK }]) {
      const { protocol, take, callback } = rendered(config);
      expect(protocol).toContain("2. Number: if you know the number they are calling from, ask once:");
      for (const guidance of [take, callback]) {
        expect(guidance).toContain(STEP);
        expect(guidance).not.toContain("ask for the best callback number");
      }
    }
  });

  it("a non-string is dropped; a long one clamps to 160", () => {
    expect(validateMessages({ callbackLine: 42 }).callbackLine).toBeUndefined();
    expect(validateMessages({ callbackLine: "x".repeat(200) }).callbackLine).toHaveLength(160);
  });

  it("strips double quotes and collapses newlines before the prompt sees it", () => {
    const out = validateMessages({ callbackLine: 'Sam says "hi"\n\nthanks' });
    expect(out.callbackLine).toBe("Sam says hi thanks");
  });

  it("a blank callbackLine is absence, not an empty promise (both tiers)", () => {
    expect(validateMessages({ callbackLine: "   " }).callbackLine).toBeUndefined();
    const { protocol } = rendered({ callbackLine: "   " });
    expect(protocol).toContain("4. Urgency: ask");
    expect(rendered({ callbackLine: "   " }, {}).protocol).toContain("Urgency: ask an existing client");
  });

  it("a pack that does not declare callbackLine ignores it", () => {
    expect(validateCapabilityConfig({ callbackLine: CALLBACK }, appointments, "biz-1").callbackLine).toBeUndefined();
  });
});
