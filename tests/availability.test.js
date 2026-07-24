/**
 * Internal availability: length + capacity config turns a caller's requested
 * time into a real free/busy check BEFORE details are collected, instead of the
 * old book-then-recover. Everything here is gated on the availability toggle, so
 * a business that hasn't turned it on behaves exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import appointments from "../capabilities/appointments.js";
import internal from "../adapters/scheduling/internal.js";
import { loadConfig } from "../services/supabase.js";

const WEEKLY = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "17:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

function makeConfig({ length, capacity, availability = true, adapter = "internal" } = {}) {
  return loadConfig({
    id: "b1",
    name: "Testwork Dental",
    timezone: "America/Chicago",
    business_hours: WEEKLY,
    allowed_tasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
    business_capabilities: [
      {
        capability_id: "appointments",
        enabled: true,
        adapter,
        adapter_config: {},
        // Availability is always on for the built-in calendar; these are just the
        // slot numbers (omit them entirely to exercise the 30/1 defaults).
        config: availability
          ? { availability: { ...(length != null ? { length } : {}), ...(capacity != null ? { capacity } : {}) } }
          : {},
      },
    ],
  });
}
const ehrConfig = () => makeConfig({ adapter: "athenahealth", availability: false });

// An EHR-backed business (athena integration) — the pack defers to the EHR's own
// slots, so the internal availability tool/flow must NOT apply.
const ATHENA = [{ enabled: true, provider: "athenahealth", name: "athena", config: {} }];

// A future Tuesday 10:00 America/Chicago (CDT, UTC-5) — the anchored UTC value
// is 15:00Z. "now" is frozen to the Monday before, so it is always in-hours+future.
const REQUESTED = "2026-07-21T10:00:00";
const REQUESTED_UTC = "2026-07-21T15:00:00.000Z";

function makeDeps(overrides = {}) {
  return {
    countScheduledOverlapping: vi.fn().mockResolvedValue(0),
    listScheduledBetween: vi.fn().mockResolvedValue([]),
    createAppointmentIfAvailable: vi.fn().mockResolvedValue({ id: "appt-1" }),
    createAppointment: vi.fn().mockResolvedValue("appt-1"),
    captureException: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday 10:00 Chicago
});
afterEach(() => {
  vi.useRealTimers();
});

describe("check_appointment_availability registration", () => {
  it("is always registered for the built-in calendar (even with no slot config)", () => {
    const tools = appointments.adapterTools(makeConfig({ availability: false }), { integrations: [] });
    expect(tools.map((t) => t.name)).toContain("check_appointment_availability");
  });

  it("is NOT registered for an EHR-backed business (the EHR owns availability)", () => {
    const tools = appointments.adapterTools(ehrConfig(), { integrations: ATHENA });
    expect(tools.map((t) => t.name)).not.toContain("check_appointment_availability");
  });
});

describe("check_appointment_availability tool", () => {
  const ctxFor = (deps, config = makeConfig()) => ({
    businessId: "b1",
    config,
    integrations: [],
    callerPhone: "+15551234567",
    deps,
  });

  it("reports a free slot as available", async () => {
    const deps = makeDeps({ countScheduledOverlapping: vi.fn().mockResolvedValue(0) });
    const res = await appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at: REQUESTED } },
      ctxFor(deps)
    );
    expect(res.functionResponse.response.available).toBe(true);
  });

  it("reports a full slot as unavailable and offers alternatives", async () => {
    const deps = makeDeps({
      countScheduledOverlapping: vi.fn().mockResolvedValue(1), // capacity 1 => full
      listScheduledBetween: vi.fn().mockResolvedValue([{ scheduled_at: REQUESTED_UTC }]),
    });
    const res = await appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at: REQUESTED } },
      ctxFor(deps)
    );
    expect(res.functionResponse.response.available).toBe(false);
    expect(res.functionResponse.response.alternatives.length).toBeGreaterThan(0);
    // The taken 10:00 slot is never offered back.
    expect(res.functionResponse.response.alternatives).not.toContain(REQUESTED_UTC);
  });

  it("rejects a past/closed time with the booking-validation message", async () => {
    const deps = makeDeps();
    const res = await appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at: "2026-07-20T09:00:00" } },
      ctxFor(deps)
    );
    expect(res.functionResponse.response.available).toBe(false);
    expect(deps.countScheduledOverlapping).not.toHaveBeenCalled();
  });
});

describe("bookAppointment enforces availability", () => {
  const ctxFor = (deps, config = makeConfig()) => ({
    businessId: "b1",
    config,
    integrations: [],
    callerPhone: "+15551234567",
    callId: "call-1",
    capabilityState: {},
    deps,
  });

  it("refuses and does not insert when the slot is full", async () => {
    const deps = makeDeps({ countScheduledOverlapping: vi.fn().mockResolvedValue(1) });
    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: REQUESTED, client_name: "Jane" } },
      ctxFor(deps)
    );
    expect(res.functionResponse.response.success).toBe(false);
    expect(deps.createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(res.stateEffects.capabilityEffects).toBeUndefined();
  });

  it("books when free, passing the configured length and capacity to the atomic write", async () => {
    const deps = makeDeps({ countScheduledOverlapping: vi.fn().mockResolvedValue(0) });
    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: REQUESTED, client_name: "Jane" } },
      ctxFor(deps, makeConfig({ enabled: true, length: 45, capacity: 2 }))
    );
    expect(res.functionResponse.response.success).toBe(true);
    expect(deps.createAppointmentIfAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: REQUESTED_UTC, lengthMinutes: 45, capacity: 2 })
    );
  });

  it("uses the 30-min / capacity-1 defaults when the slot numbers are unconfigured", async () => {
    const deps = makeDeps({ countScheduledOverlapping: vi.fn().mockResolvedValue(0) });
    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: REQUESTED, client_name: "Jane" } },
      ctxFor(deps, makeConfig({ availability: false }))
    );
    expect(res.functionResponse.response.success).toBe(true);
    // Still pre-checks (always on) and books with the defaults.
    expect(deps.countScheduledOverlapping).toHaveBeenCalled();
    expect(deps.createAppointmentIfAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ lengthMinutes: 30, capacity: 1 })
    );
  });
});

describe("internal.findSlots — wall-clock hours map to UTC, overlap respects length", () => {
  it("drops the taken slot but keeps one exactly a length away (boundary)", async () => {
    // 10:00 Chicago (15:00Z) is taken. With length 30, a 10:30 candidate is
    // exactly 30 min away — NOT overlapping (strict <) — so it stays free.
    const deps = {
      listScheduledBetween: vi.fn().mockResolvedValue([{ scheduled_at: REQUESTED_UTC }]),
    };
    const slots = await internal.findSlots(
      { businessId: "b1", deps },
      { dateISO: REQUESTED_UTC, lengthMinutes: 30, capacity: 1, businessHours: WEEKLY, timezone: "America/Chicago" }
    );
    const starts = slots.map((s) => s.start);
    expect(starts).not.toContain(REQUESTED_UTC); // 10:00 taken
    expect(starts).toContain("2026-07-21T15:30:00.000Z"); // 10:30 free (boundary)
    // 09:00 Chicago == 14:00Z is the first slot of the day.
    expect(starts).toContain("2026-07-21T14:00:00.000Z");
  });
});

describe("checkAvailability point check honours capacity", () => {
  it("is available while count < capacity and full at capacity", async () => {
    const two = { countScheduledOverlapping: vi.fn().mockResolvedValue(1) };
    expect((await internal.checkAvailability({ businessId: "b1", deps: two }, { startISO: REQUESTED_UTC, lengthMinutes: 30, capacity: 2 })).available).toBe(true);
    const full = { countScheduledOverlapping: vi.fn().mockResolvedValue(2) };
    expect((await internal.checkAvailability({ businessId: "b1", deps: full }, { startISO: REQUESTED_UTC, lengthMinutes: 30, capacity: 2 })).available).toBe(false);
  });
});

describe("booking guidance is check-first for the built-in calendar, not for an EHR", () => {
  it("tells the model to call check_appointment_availability first (built-in calendar)", () => {
    const frag = appointments.prompt(makeConfig(), { now: new Date("2026-07-20T15:00:00Z"), integrations: [] });
    expect(frag.dynamic.stepGuidance.book_appointment).toContain("check_appointment_availability");
  });

  it("uses the original suggest-then-book guidance for an EHR-backed business", () => {
    const frag = appointments.prompt(ehrConfig(), { now: new Date("2026-07-20T15:00:00Z"), integrations: ATHENA });
    expect(frag.dynamic.stepGuidance.book_appointment).not.toContain("check_appointment_availability");
  });
});
