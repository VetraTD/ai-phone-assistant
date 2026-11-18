/**
 * Internal availability: length + capacity config turns a caller's requested
 * time into a real free/busy check BEFORE details are collected, instead of the
 * old book-then-recover. Everything here is gated on the availability toggle, so
 * a business that hasn't turned it on behaves exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import appointments from "../capabilities/appointments.js";
import internal from "../adapters/scheduling/internal.js";
import { loadConfig } from "../services/db.js";

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

  // -------------------------------------------------------------------------
  // Round 3, 2026-08-29. A caller said only "next Tuesday" and the assistant
  // invented a time rather than asking or offering. There was nothing to call:
  // this tool required a full datetime, `book_appointment` accepts whatever
  // datetime the model computed, and no code anywhere turns a bare day into a
  // list of open times. internal.findSlots already enumerates the whole day —
  // it was simply never reachable except as the alternatives to a REFUSED
  // point-check.
  // -------------------------------------------------------------------------
  describe("a date with no time", () => {
    // A future Tuesday, as a bare date. Frozen "now" is the Monday before.
    const DATE_ONLY = "2026-07-21";

    it("returns the open times for that day instead of rejecting it", async () => {
      const deps = makeDeps();
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const r = res.functionResponse.response;

      expect(r.success).toBe(true);
      // Not a yes/no question — nothing was asked about a specific time.
      expect(r.available).toBeUndefined();
      expect(Array.isArray(r.open_times)).toBe(true);
      expect(r.open_times.length).toBeGreaterThan(0);
      expect(r.open_times.length).toBeLessThanOrEqual(3);
      expect(r.message).not.toMatch(/didn't catch a valid date and time/i);
    });

    it("offers times spread across the day, not the first three of the morning", async () => {
      // A whole 9-5 day at 30 minutes is 16 slots; the first three are all
      // before 10:30, which is a worse offer than it looks.
      const deps = makeDeps();
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const { open_times: open } = res.functionResponse.response;

      expect(open).toHaveLength(3);
      const hours = open.map((t) => Number(t.slice(11, 13)));
      expect(hours[0]).toBeLessThan(hours[1]);
      expect(hours[1]).toBeLessThan(hours[2]);
      // The last offer is in the afternoon, not 10am.
      expect(hours[2]).toBeGreaterThanOrEqual(13);
    });

    it("hands back naive LOCAL times, the same frame book_appointment expects", async () => {
      const deps = makeDeps();
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const { open_times: open, message } = res.functionResponse.response;

      // Naive local, no Z, no offset — otherwise the model hands a UTC instant
      // back as scheduled_at and the booking lands hours away.
      expect(open.every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t))).toBe(true);
      // ...and what it is told to SAY carries no ISO at all.
      expect(message).not.toMatch(/T\d{2}:\d{2}/);
      expect(message).toMatch(/\d{1,2}(:\d{2})?\s?[AP]M/);
    });

    it("omits times that are already taken", async () => {
      const deps = makeDeps({
        listScheduledBetween: vi.fn().mockResolvedValue([{ scheduled_at: REQUESTED_UTC }]),
      });
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const { open_times: open } = res.functionResponse.response;
      // 15:00Z is 10:00 Chicago — the taken slot must not be offered.
      expect(open).not.toContain("2026-07-21T10:00:00");
    });

    it("refuses a date in the past with the same wording as a past time", async () => {
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: "2026-07-13" } },
        ctxFor(makeDeps())
      );
      const r = res.functionResponse.response;
      expect(r.open_times ?? []).toHaveLength(0);
      expect(r.message).toMatch(/already passed/i);
    });

    it("refuses a day the business is closed", async () => {
      // 2026-07-25 is a Saturday; the fixture is closed at weekends.
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: "2026-07-25" } },
        ctxFor(makeDeps())
      );
      const r = res.functionResponse.response;
      expect(r.open_times ?? []).toHaveLength(0);
      expect(r.message).toMatch(/closed/i);
    });

    it("says so plainly when the day is fully booked", async () => {
      const deps = makeDeps({
        listScheduledBetween: vi
          .fn()
          // Every 30-minute slot from 09:00 to 17:00 Chicago (14:00Z-21:30Z).
          .mockResolvedValue(
            Array.from({ length: 16 }, (_, i) => ({
              scheduled_at: new Date(Date.UTC(2026, 6, 21, 14, 0) + i * 30 * 60_000).toISOString(),
            }))
          ),
      });
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const r = res.functionResponse.response;
      expect(r.open_times).toHaveLength(0);
      expect(r.message).toMatch(/nothing (else )?(open|available)|fully booked|another day/i);
    });

    // -----------------------------------------------------------------
    // Live call, 2026-08-30. The caller was offered three times, asked "have
    // you got anything else that day?", and was told nothing else was
    // available — while eleven other slots were open. Asking for one of them
    // by name then worked, which is what proved the data was there and only
    // the ANSWER was wrong.
    //
    // The tool offered three and said "Open times that day: X, Y, Z." Nothing
    // in that response says the three are a SELECTION, so the model reasonably
    // concluded they were the whole set. A short list to speak is right; a
    // short list presented as exhaustive is a lie the model then repeats.
    // -----------------------------------------------------------------
    it("says how many are actually open, so three offers are not mistaken for three slots", async () => {
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(makeDeps())
      );
      const r = res.functionResponse.response;

      // A 9-5 day at 30 minutes is 16 slots. Three are offered; the model must
      // be able to see that the other thirteen exist.
      expect(r.open_times).toHaveLength(3);
      expect(r.total_open).toBeGreaterThan(3);
      expect(Array.isArray(r.all_open_times)).toBe(true);
      expect(r.all_open_times.length).toBe(r.total_open);
      // ...and be told, in words, not to claim otherwise.
      expect(r.message).toMatch(/more|other|\d+ (times|slots)/i);
    });

    it("carries every open time in the same local frame book_appointment wants", async () => {
      // So a follow-up question is answered from what it already has, instead
      // of a second tool round the caller waits through.
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(makeDeps())
      );
      const { all_open_times: all, open_times: offered } = res.functionResponse.response;
      expect(all.every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t))).toBe(true);
      // The three offered are drawn from the full list, not a separate universe.
      for (const t of offered) expect(all).toContain(t);
    });

    it("still says nothing is open when nothing is", async () => {
      const deps = makeDeps({
        listScheduledBetween: vi
          .fn()
          .mockResolvedValue(
            Array.from({ length: 16 }, (_, i) => ({
              scheduled_at: new Date(Date.UTC(2026, 6, 21, 14, 0) + i * 30 * 60_000).toISOString(),
            }))
          ),
      });
      const res = await appointments.execute(
        { id: "1", name: "check_appointment_availability", args: { requested_at: DATE_ONLY } },
        ctxFor(deps)
      );
      const r = res.functionResponse.response;
      expect(r.total_open).toBe(0);
      expect(r.all_open_times).toEqual([]);
    });

    it("still rejects a date-only value at BOOKING time — the backstop stays", async () => {
      // The model must never turn "next Tuesday" into a booking on its own.
      const res = await appointments.execute(
        { id: "1", name: "book_appointment", args: { client_name: "Ada", scheduled_at: DATE_ONLY } },
        ctxFor(makeDeps())
      );
      expect(res.functionResponse.response.success).toBe(false);
    });
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

  it("speaks the alternatives as local times, keeping the raw ISO in the machine field", async () => {
    // 15:00Z is taken; the model must SPEAK plausible local (America/Chicago)
    // times, never the raw UTC ISO it would otherwise read as "3 PM" wrong.
    const deps = makeDeps({
      countScheduledOverlapping: vi.fn().mockResolvedValue(1),
      listScheduledBetween: vi.fn().mockResolvedValue([{ scheduled_at: REQUESTED_UTC }]),
    });
    const res = await appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at: REQUESTED } },
      ctxFor(deps)
    );
    const { message, alternatives } = res.functionResponse.response;

    // The machine-readable alternatives field stays raw UTC ISO (unchanged contract).
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.every((a) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a))).toBe(true);

    // The spoken message carries NO raw ISO fragment and DOES carry human times.
    expect(message).not.toMatch(/T\d{2}:\d{2}/);
    expect(message).not.toMatch(/\dZ/);
    expect(message).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
    expect(message).toMatch(/July/); // long month name, i.e. localized date
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

// ---------------------------------------------------------------------------
// A declaration must describe what the handler actually does.
//
// The precedent this guards: get_caller_appointments_from_db once advertised
// caller_phone and caller_name parameters the handler had never read. Told it
// could search by name, the model searched by name and then reported the result
// of a lookup that never ran.
// ---------------------------------------------------------------------------
describe("appointments — the in_addition_to_existing parameter is declared only where it works", () => {
  const cfgFor = (policy) => ({
    allowedTasks: ["book_appointment"],
    ...(policy ? { capabilities: { appointments: { existingAppointment: policy } } } : {}),
  });
  const bookDecl = (policy) =>
    appointments.tools(cfgFor(policy)).find((d) => d.name === "book_appointment");

  it("is offered under confirm, which is also the default when nothing is configured", () => {
    for (const policy of [undefined, "confirm"]) {
      const props = bookDecl(policy).parameters.properties;
      expect(props.in_addition_to_existing).toBeDefined();
      expect(props.in_addition_to_existing.type).toBe("boolean");
    }
  });

  it("is NOT offered under allow — nothing blocks, so the flag would be a lie", () => {
    expect(bookDecl("allow").parameters.properties.in_addition_to_existing).toBeUndefined();
  });

  it("is NOT offered under block — nothing can unblock, so it would be a bypass", () => {
    expect(bookDecl("block").parameters.properties.in_addition_to_existing).toBeUndefined();
  });

  it("is never required, so the model is not forced to guess a boolean", () => {
    // Forcing it on every booking, including for callers who have no
    // appointment at all, is how it ends up defaulting to true and silently
    // disabling the guard.
    for (const policy of [undefined, "confirm", "allow", "block"]) {
      expect(bookDecl(policy).parameters.required || []).not.toContain("in_addition_to_existing");
    }
  });
});

// ---------------------------------------------------------------------------
// The same slot, asked twice in one call.
//
// Reported live 2026-08-31: a caller gave their name and heard "Checking the
// calendar now." The engine's line was accurate — the model really was calling
// check_appointment_availability again, for a time it had already agreed with
// the caller. That is a wasted round trip in the middle of a booking, and it
// puts the caller on hold to be told something they were told a minute ago.
//
// The booking guidance now says not to. This is the half that does not depend
// on the model reading it — the same division of labour the spelling caps
// settled on, for the same reason: prose cannot hold a budget.
// ---------------------------------------------------------------------------
describe("check_appointment_availability — a slot already confirmed this call", () => {
  const ctxFor = (deps, capabilityState = undefined) => ({
    businessId: "b1",
    config: makeConfig(),
    integrations: [],
    callerPhone: "+15551234567",
    capabilityState,
    deps,
  });

  const check = (deps, capabilityState, requested_at = REQUESTED) =>
    appointments.execute(
      { id: "1", name: "check_appointment_availability", args: { requested_at } },
      ctxFor(deps, capabilityState),
    );

  it("remembers an available verdict on the call's scratchpad", async () => {
    const res = await check(makeDeps());
    expect(res.functionResponse.response.available).toBe(true);
    // Keyed by the ANCHORED UTC instant, not the naive string the model sent,
    // so "2026-07-21T10:00" and "2026-07-21T10:00:00" are the same slot.
    expect(res.stateEffects.capabilityState.appointments.availableSlot.slot).toBe(REQUESTED_UTC);
  });

  it("answers a repeat check without touching the calendar at all", async () => {
    const first = await check(makeDeps());
    const deps = makeDeps();
    const res = await check(deps, { appointments: first.stateEffects.capabilityState.appointments });

    expect(res.functionResponse.response.available).toBe(true);
    // The whole point: no second query.
    expect(deps.countScheduledOverlapping).not.toHaveBeenCalled();
    // ...and the caller is not put on hold for work that is not happening.
    expect(res.stateEffects.toolCallEvent.silent).toBe(true);
  });

  it("still checks a DIFFERENT time properly", async () => {
    const first = await check(makeDeps());
    const deps = makeDeps();
    const res = await check(
      deps,
      { appointments: first.stateEffects.capabilityState.appointments },
      "2026-07-21T11:00:00",
    );

    expect(deps.countScheduledOverlapping).toHaveBeenCalled();
    expect(res.stateEffects.toolCallEvent.silent).toBeUndefined();
    expect(res.functionResponse.response.available).toBe(true);
  });

  it("never caches a TAKEN verdict — that is the one that can change", async () => {
    // A slot someone else holds can free up while this caller is still on the
    // line, and the alternatives offered alongside it go stale the same way.
    // Only "yes, that is free" is safe to reuse, and only because
    // book_appointment re-checks and writes atomically underneath it.
    const deps = makeDeps({
      countScheduledOverlapping: vi.fn().mockResolvedValue(1),
      listScheduledBetween: vi.fn().mockResolvedValue([{ scheduled_at: REQUESTED_UTC }]),
    });
    const res = await check(deps);
    expect(res.functionResponse.response.available).toBe(false);
    expect(res.stateEffects.capabilityState).toBeUndefined();
  });
});
