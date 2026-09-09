// ---------------------------------------------------------------------------
// LVX53 — a name from the record, written to a booking the caller never made.
//
// Second local call, 2026-09-03. The caller's name was never intelligibly
// transcribed on that call at all -- the turn came through as "Hay en el
// Tíndala". The assistant replied "Thanks, Nithin Vodla" and booked under it.
// The local database now holds TWO rows reading "Nithin Vodla", the second
// created by a call on which the caller never said a name.
//
// ---------------------------------------------------------------------------
// Where the silence actually came from
// ---------------------------------------------------------------------------
//
// Not the code gate being absent. shouldConfirmSpelling returns FALSE when the
// name is already on file, on the reasoning "the record IS the spelling -- the
// business has had it right since the last call, and asking again is the
// repetition callers noticed". That reasoning is sound for a caller who says
// their name and is recognised. It is exactly wrong when the name did not come
// from the caller at all.
//
// LVX28 wrote this down as a worry before it was ever observed:
//
//   "'already on file' trusts a row that may itself never have been spelled. A
//    caller who declines, or who runs out of gate refusals, has their mis-heard
//    name written once -- and every later call treats that row as authority and
//    never asks again."
//
// The wrong value is self-perpetuating, and each new row makes it look better
// established. So the on-file bypass now requires that the caller said the name
// on THIS call. The record can confirm a spelling; it cannot supply the fact
// that the caller identified themselves.
//
// The cascade passes no caller transcript and is therefore unaffected: an
// absent callerSaidThisCall preserves the old bypass exactly.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();
vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: vi.fn().mockResolvedValue(0),
  listScheduledBetween: vi.fn().mockResolvedValue([]),
  listAppointmentsByCaller: vi.fn(),
  updateAppointmentStatus: vi.fn(),
  updateAppointment: vi.fn(),
  getAppointmentById: vi.fn(),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { shouldConfirmSpelling } from "../lib/nameQuality.js";
import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const ON_FILE = {
  upcomingAppointments: [
    { id: "a1", client_name: "Nithin Vodla", scheduled_at: "2026-09-20T15:00:00Z" },
  ],
};

describe("shouldConfirmSpelling — the on-file bypass needs the caller behind it", () => {
  it("does NOT trust the record when the caller never said the name (LVX53)", () => {
    expect(
      shouldConfirmSpelling({
        name: "Nithin Vodla",
        callerContext: ON_FILE,
        // What the caller's turn actually transcribed to on that call.
        callerSaidThisCall: "Hay en el Tíndala. Yeah. Tuesday works.",
      })
    ).toBe(true);
  });

  it("still trusts the record when the caller did say it", () => {
    // The repetition callers complained about. A returning caller who names
    // themselves must not be asked to spell it again.
    expect(
      shouldConfirmSpelling({
        name: "Nithin Vodla",
        callerContext: ON_FILE,
        callerSaidThisCall: "Hi, it's Nithin Vodla, I'd like to move my appointment.",
      })
    ).toBe(false);
  });

  it("accepts a partial match, because transcription garbles surnames", () => {
    // A first name is enough to establish that the caller identified
    // themselves. Requiring the full string back would re-ask every caller
    // whose surname came through imperfectly -- which is the disease.
    expect(
      shouldConfirmSpelling({
        name: "Nithin Vodla",
        callerContext: ON_FILE,
        callerSaidThisCall: "yeah it's Nithin",
      })
    ).toBe(false);
  });

  it("leaves the cascade exactly as it was when no transcript is supplied", () => {
    // The cascade never threads a call transcript, so the bypass must behave
    // precisely as before there. Byte-identical behaviour for tier 3 is the
    // same construction the hesitation gate uses.
    expect(
      shouldConfirmSpelling({ name: "Nithin Vodla", callerContext: ON_FILE })
    ).toBe(false);
    expect(
      shouldConfirmSpelling({ name: "Nithin Vodla", callerContext: ON_FILE, callerSaidThisCall: null })
    ).toBe(false);
  });

  it("does not change any of the other reasons the gate stays quiet", () => {
    expect(
      shouldConfirmSpelling({ name: "Nithin Vodla", callerContext: ON_FILE, spellingSettled: true, callerSaidThisCall: "" })
    ).toBe(false);
    expect(
      shouldConfirmSpelling({ name: "Nithin Vodla", callerContext: ON_FILE, policy: "off", callerSaidThisCall: "" })
    ).toBe(false);
  });

  it("is unaffected for a name that is not on file at all", () => {
    // Nothing to bypass: the gate already fires for an unknown name, which is
    // LVX40's verified path and must not move.
    expect(
      shouldConfirmSpelling({ name: "Marcus Bell", callerContext: ON_FILE, callerSaidThisCall: "it's Marcus Bell" })
    ).toBe(true);
  });
});

describe("LVX53 end to end — the booking is refused, not written", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
    mockCreateAppointment.mockResolvedValue("appt-1");
  });

  const ctx = (callerSaidThisCall) => ({
    businessId: "biz-1",
    callerPhone: "+15551234567",
    callId: "call-1",
    integrations: [],
    capabilityState: {},
    config: {},
    callerContext: ON_FILE,
    callerSaidThisCall,
    // Consent and ordering both satisfied, so the ONLY thing that can refuse
    // below is the provenance gate. Added 2026-09-09 with the LVX95 write-order
    // gate, which sits above this one for the reason the consent gate sits
    // above the spelling gate: checking whose name is on a write nobody
    // authorised is checking a decision that was never made.
    lastCallerText: "Yes, Tuesday works",
    lastReplyText: "Just to confirm, shall I go ahead and book that for you?",
  });

  const book = (c) =>
    executeToolCall(
      {
        id: "fc1",
        name: "book_appointment",
        args: {
          client_name: "Nithin Vodla",
          scheduled_at: `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00`,
          // The caller must have an appointment on file for the provenance case
          // to exist at all, and that trips the separate already-has-one guard.
          // Set on BOTH cases so the transcript is the only difference between
          // them -- otherwise the refusal below could be either guard and the
          // test would prove nothing.
          in_addition_to_existing: true,
        },
      },
      c
    );

  it("refuses a name lifted from the record and writes no row", async () => {
    const { functionResponse } = await book(ctx("Hay en el Tíndala. Tuesday works."));
    expect(functionResponse.response.success).toBe(false);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.write_refused_name_provenance).toBe(1);
  });

  it("books normally for a caller who identified themselves", async () => {
    const { functionResponse } = await book(ctx("Hi it's Nithin Vodla, Tuesday works."));
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalled();
    // The positive twin: without it, a call that booked correctly and a call
    // that never attempted a write both read write_refused_name_provenance: 0.
    expect(getLatencyStats().turnTaking.write_name_provenance_ok).toBe(1);
  });
});
