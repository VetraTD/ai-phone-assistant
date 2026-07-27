/**
 * Scheduling adapters.
 *
 * The property that matters most here is `verifiableFields`: it is what stops
 * an operator configuring a guarantee their backend cannot deliver. A business
 * on a webhook cannot verify a dental number against anything, and a settings
 * screen that offered to would be promising something that silently does
 * nothing.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSchedulingAdapter,
  getSchedulingAdapter,
  listSchedulingAdapters,
  verifiableFieldsFor,
  DEFAULT_SCHEDULING_ADAPTER,
} from "../adapters/scheduling/index.js";

const ATHENA_ON = [{ enabled: true, provider: "athenahealth" }];
const ATHENA_OFF = [{ enabled: false, provider: "athenahealth" }];

describe("adapter resolution", () => {
  it("explicit configuration wins", () => {
    expect(resolveSchedulingAdapter({ adapter: "webhook" }, ATHENA_ON).id).toBe("webhook");
    expect(resolveSchedulingAdapter({ adapter: "internal" }, ATHENA_ON).id).toBe("internal");
  });

  it("falls back to an enabled EHR integration when unconfigured", () => {
    // How every business was routed before business_capabilities existed. A
    // business mid-migration must keep reaching the same appointment book it
    // reached yesterday.
    expect(resolveSchedulingAdapter(null, ATHENA_ON).id).toBe("athenahealth");
    expect(resolveSchedulingAdapter({}, ATHENA_ON).id).toBe("athenahealth");
  });

  it("a disabled integration does not route anywhere", () => {
    expect(resolveSchedulingAdapter({}, ATHENA_OFF).id).toBe(DEFAULT_SCHEDULING_ADAPTER);
  });

  it("defaults to the internal table with nothing configured or connected", () => {
    expect(resolveSchedulingAdapter(null, []).id).toBe("internal");
    expect(resolveSchedulingAdapter(undefined, undefined).id).toBe("internal");
  });

  it("an unknown adapter id falls through rather than resolving to nothing", () => {
    // Never returns null: a call in progress must always have somewhere to
    // write, even if the config names a backend this build does not have.
    expect(resolveSchedulingAdapter({ adapter: "carrier_pigeon" }, []).id).toBe("internal");
  });

  it("a webhook is never auto-claimed", () => {
    // Guessing would silently reroute a business's appointments.
    const withWebhook = [{ enabled: true, provider: "webhook", name: "book_it" }];
    expect(resolveSchedulingAdapter(null, withWebhook).id).toBe("internal");
  });
});

describe("verifiableFields — what each backend can actually prove", () => {
  it("an EHR can check name and date of birth", () => {
    expect(verifiableFieldsFor(null, ATHENA_ON)).toContain("dob");
    expect(verifiableFieldsFor(null, ATHENA_ON)).toContain("name");
  });

  it("the internal table cannot verify a name on its own", () => {
    // A name is public information. Knowing one must never be enough to cancel
    // a stranger's appointment — the phone number is the second factor.
    const fields = verifiableFieldsFor(null, []);
    expect(fields).not.toContain("name");
    expect(fields).toContain("phone_on_file");
  });

  it("a webhook can prove nothing", () => {
    // So every identity field on it is collect-only, whatever an operator
    // configures. This is the list a settings UI reads to grey the option out.
    expect(verifiableFieldsFor({ adapter: "webhook" }, [])).toEqual([]);
  });

  it("every adapter declares the field explicitly", () => {
    for (const adapter of listSchedulingAdapters()) {
      expect(Array.isArray(adapter.verifiableFields), adapter.id).toBe(true);
    }
  });
});

describe("adapter interface", () => {
  it("every adapter declares an id and a human label", () => {
    for (const adapter of listSchedulingAdapters()) {
      expect(typeof adapter.id).toBe("string");
      expect(typeof adapter.label).toBe("string");
    }
  });

  it("the internal adapter implements the read/write methods", () => {
    const internal = getSchedulingAdapter("internal");
    for (const method of ["lookupByCaller", "book", "cancel", "reschedule"]) {
      expect(typeof internal[method], method).toBe("function");
    }
  });

  it("integration-routed adapters say so rather than leaving methods undefined", () => {
    // The distinction is legible on purpose: not "unsupported", but "the model
    // calls this backend's own tools and execution goes through
    // services/integrations.js".
    const athena = getSchedulingAdapter("athenahealth");
    expect(athena.routesThroughIntegration).toBe(true);
    expect(athena.book).toBeNull();
  });

  it("the internal adapter now has availability search and a point check", () => {
    // Appointment length + slot capacity config (migration 022) gave the
    // built-in calendar a real overlap model, so it can answer availability.
    const internal = getSchedulingAdapter("internal");
    expect(typeof internal.findSlots).toBe("function");
    expect(typeof internal.checkAvailability).toBe("function");
  });

  it("owner-managed / stub adapters still have no availability search", () => {
    expect(getSchedulingAdapter("athenahealth").findSlots).toBeNull();
    expect(getSchedulingAdapter("athenahealth").checkAvailability).toBeNull();
    expect(getSchedulingAdapter("webhook").findSlots).toBeNull();
    expect(getSchedulingAdapter("webhook").checkAvailability).toBeNull();
  });

  it("getSchedulingAdapter returns null for an unknown id", () => {
    expect(getSchedulingAdapter("nope")).toBeNull();
  });
});
