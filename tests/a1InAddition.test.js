// ---------------------------------------------------------------------------
// Round A1 part 4, F-E (owner, 2026-10-15; calls d1 CA6bf6e2, b CAdefce6ab).
//
// The in-addition guard lives inside book_appointment, after every gate. With
// no read-back standing, the write-order gate handed the model its sentence
// ("...booking that now") first, and the guard's "you already have one -- in
// addition?" landed AFTER it (F5). And it asked on call b, a booking for a
// colleague, which can never be a move of the caller's own booking.
//
// Owner rules: ask only when unclear and straight away; a booking for a
// different person than those on file is never asked about (code rule); the
// write-order gate steps aside when the guard would ask, so the question
// comes first. One predicate decides for both, so they cannot drift. G2: one
// or two bookings are named; three or more are a count and the next one, the
// count taken from the database (a sixth is never in the prompt's five).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();

vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: async () => [],
  updateAppointmentStatus: vi.fn(),
  updateAppointment: vi.fn(),
  getAppointmentById: vi.fn(),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import appointmentsPack, { inAdditionWouldRefuse } from "../capabilities/appointments.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const DAY_MS = 86_400_000;
const day = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const SLOT = `${day(30)}T14:00:00`;
const upcoming = (n, client_name = "Nithin Dodla") => ({
  id: `a${n}`,
  client_name,
  scheduled_at: `${day(n)}T11:00:00`,
});
const ON_FILE = { callCount: 3, upcomingAppointments: [upcoming(4)] };

const live = (over = {}) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
  spellingSettled: true,
  callerTurnCount: 4,
  callerSaidThisCall: "I'd like to book something",
  callerContext: ON_FILE,
  lastCallerText: "Friday at two works.",
  lastReplyText: "",
  inTurnReplyText: "",
  ...over,
});
const book = (c, args = {}) =>
  executeToolCall(
    { id: "fc1", name: "book_appointment", args: { client_name: "Nithin Dodla", scheduled_at: SLOT, ...args } },
    c
  );
const weekdayOf = (naive) =>
  new Date(`${naive.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const SAID = (name = "Nithin Dodla") => `${weekdayOf(SLOT)} at 2 p.m. for ${name}, booking that now.`;

beforeEach(() => {
  clearStats();
  mockCreateAppointment.mockReset().mockResolvedValue("appt-1");
});

describe("inAdditionWouldRefuse — one predicate for the guard and the gate", () => {
  const ctx = (callerContext) => ({ callerContext });
  it("nothing on file: never", () => {
    expect(inAdditionWouldRefuse({ client_name: "Nithin Dodla" }, ctx({ upcomingAppointments: [] }), {})).toBe(false);
  });
  it("the same person, flag unset: asks", () => {
    expect(inAdditionWouldRefuse({ client_name: "Nithin Dodla" }, ctx(ON_FILE), {})).toBe(true);
  });
  it("the flag set: does not ask", () => {
    expect(
      inAdditionWouldRefuse({ client_name: "Nithin Dodla", in_addition_to_existing: true }, ctx(ON_FILE), {})
    ).toBe(false);
  });
  it("a different person (call b's colleague): does not ask", () => {
    expect(inAdditionWouldRefuse({ client_name: "Maya Okafor" }, ctx(ON_FILE), {})).toBe(false);
  });
  it("no name given, a misheard first name, or a shared surname: treated as the same person (asks)", () => {
    expect(inAdditionWouldRefuse({}, ctx(ON_FILE), {})).toBe(true);
    expect(inAdditionWouldRefuse({ client_name: "Nitin Dodla" }, ctx(ON_FILE), {})).toBe(true);
    expect(inAdditionWouldRefuse({ client_name: "Anita Dodla" }, ctx(ON_FILE), {})).toBe(true);
    // The first name alone, or both halves misheard: only the one-edit rule
    // keeps these the same person (no surname to fall back on).
    expect(inAdditionWouldRefuse({ client_name: "Nitin" }, ctx(ON_FILE), {})).toBe(true);
    expect(inAdditionWouldRefuse({ client_name: "Nitin Dodda" }, ctx(ON_FILE), {})).toBe(true);
  });
  it("review M7: the same person in another name format still asks; a clearly different one does not", () => {
    const onFile = (client_name) => ctx({ upcomingAppointments: [{ ...upcoming(4), client_name }] });
    const asks = (onFileName, booking) => inAdditionWouldRefuse({ client_name: booking }, onFile(onFileName), {});
    expect(asks("Dodla, Nithin", "Nithin Dodla")).toBe(true); // surname first
    expect(asks("Mr Dodla", "Nithin Dodla")).toBe(true); // title + surname
    expect(asks("Nithin Dodla", "Maya Okafor")).toBe(false); // still different
    expect(asks("Dr Patel", "Dr Okafor")).toBe(false); // a shared title is not a shared name
  });
  it("re-review M7: a title alone is no name -- treated as the same person (asks)", () => {
    const onFile = (client_name) => ctx({ upcomingAppointments: [{ ...upcoming(4), client_name }] });
    expect(inAdditionWouldRefuse({ client_name: "Nithin Dodla" }, onFile("Mrs"), {})).toBe(true);
    expect(inAdditionWouldRefuse({ client_name: "Mr" }, onFile("Nithin Dodla"), {})).toBe(true);
  });
  it("a past booking does not count", () => {
    const past = { upcomingAppointments: [{ id: "p", client_name: "Nithin Dodla", scheduled_at: "2020-01-01T10:00:00" }] };
    expect(inAdditionWouldRefuse({ client_name: "Nithin Dodla" }, ctx(past), {})).toBe(false);
  });
});

describe("the guard: a booking for someone else is written without the question (call b)", () => {
  it("writes Maya Okafor's booking although Nithin Dodla has one on file", async () => {
    const { functionResponse } = await book(live({ inTurnReplyText: SAID("Maya Okafor") }), {
      client_name: "Maya Okafor",
    });
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
  });
});

describe("the guard: the flag set and read back once -- written", () => {
  it("books the same person a second appointment when the flag says it is extra", async () => {
    const { functionResponse } = await book(live({ inTurnReplyText: SAID() }), { in_addition_to_existing: true });
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
  });
});

describe("the write-order gate steps aside so the in-addition question comes first (F5)", () => {
  it("no read-back standing + the guard would ask: the caller hears the question, not 'booking that now'", async () => {
    const { functionResponse, stateEffects } = await book(live());
    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(functionResponse.response.message).toMatch(/already has an upcoming appointment/);
    expect(functionResponse.response.message).not.toMatch(/booking that now/);
    expect(stateEffects.writeGateRefusal).toBeUndefined();
    expect(stateEffects.capabilityState?.appointments?.pendingWrite?.reason).toBe("in_addition");
  });

  it("the flag already set: the gate hands its one read-back as before", async () => {
    const { functionResponse } = await book(live(), { in_addition_to_existing: true });
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/booking that now/);
  });

  it("counts a question that still lands after a read-back (the model said its own first)", async () => {
    const { functionResponse } = await book(live({ inTurnReplyText: SAID() }));
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/already has an upcoming appointment/);
    expect(getLatencyStats().turnTaking.in_addition_asked_after_readback).toBe(1);
  });
});

describe("G2 — the guard names the bookings on file", () => {
  it("one or two: each named", async () => {
    const ctx = live({ callerContext: { callCount: 3, upcomingAppointments: [upcoming(4), upcoming(5)] } });
    const { functionResponse, stateEffects } = await book(ctx);
    expect(functionResponse.response.message).not.toMatch(/upcoming appointments; the next is/);
    expect(stateEffects.toolResult.message).toMatch(/^You already have .+ and .+ — shall I book this additional one for .+ as well\?$/);
  });

  it("three or more: a count and the next one", async () => {
    const appts = [upcoming(6), upcoming(4), upcoming(5), upcoming(7)];
    const { functionResponse, stateEffects } = await book(
      live({ callerContext: { callCount: 3, upcomingAppointments: appts } })
    );
    expect(functionResponse.response.message).toMatch(/You have 4 upcoming appointments; the next is /);
    expect(stateEffects.toolResult.message).toMatch(
      /^You have 4 upcoming appointments; the next is .+ — shall I book this additional one for .+ as well\?$/
    );
  });

  it("more than five on file: the count is the database's, not the prompt's five", async () => {
    const appts = [upcoming(4), upcoming(5), upcoming(6), upcoming(7), upcoming(8)];
    const { stateEffects } = await book(
      live({ callerContext: { callCount: 3, upcomingAppointments: appts, upcomingOverflow: 2 } })
    );
    expect(stateEffects.toolResult.message).toMatch(/^You have 7 upcoming appointments; the next is /);
  });
});

describe("review M6 — the count follows the call, not the call-start snapshot", () => {
  // Drive the pack's own onEffect, as the engine does, and feed the next
  // snapshot to the guard.
  function afterEffects(start, effects) {
    let cc = start;
    const engine = {
      STEPS: { CONFIRM: "confirm" },
      setStep: () => {},
      addHistoryNote: () => {},
      setCallerContext: (n) => {
        cc = n;
      },
      call: { get callerContext() { return cc; }, config: {} },
    };
    for (const e of effects) appointmentsPack.onEffect({ capability: "appointments", ...e }, engine);
    return cc;
  }

  it("3 on file, one cancelled this call: the guard names the 2 left, not '3 upcoming'", async () => {
    const appts = [upcoming(4), upcoming(5), upcoming(6)];
    const cc = afterEffects(
      { callCount: 3, upcomingAppointments: appts, upcomingOverflow: 0 },
      [{ type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a6" } }]
    );
    const { stateEffects } = await book(live({ callerContext: cc }));
    expect(stateEffects.toolResult.message).toMatch(/^You already have .+ and .+ — shall I book/);
    expect(stateEffects.toolResult.message).not.toMatch(/upcoming appointments/);
  });

  it("7 on file (5 listed + 2 more), one booked this call: 8", async () => {
    const appts = [upcoming(4), upcoming(5), upcoming(6), upcoming(7), upcoming(8)];
    const cc = afterEffects(
      { callCount: 3, upcomingAppointments: appts, upcomingOverflow: 2 },
      [{ type: "booked", data: { scheduled_at: `${day(9)}T11:00:00`, client_name: "Nithin Dodla", id: "n1" } }]
    );
    const { stateEffects } = await book(live({ callerContext: cc }));
    expect(stateEffects.toolResult.message).toMatch(/^You have 8 upcoming appointments; the next is /);
  });

  it("re-review M6: 7 on file, one BEYOND the listed five cancelled: 6, not 7", async () => {
    const appts = [upcoming(4), upcoming(5), upcoming(6), upcoming(7), upcoming(8)];
    const cc = afterEffects(
      { callCount: 3, upcomingAppointments: appts, upcomingOverflow: 2 },
      [{ type: "changed", data: { tool: "cancel_appointment_db", appointmentId: "a-unlisted" } }]
    );
    expect(cc.upcomingOverflow).toBe(1);
    const { stateEffects } = await book(live({ callerContext: cc }));
    expect(stateEffects.toolResult.message).toMatch(/^You have 6 upcoming appointments; the next is /);
  });
});
