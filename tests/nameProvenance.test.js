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
import { composeReadBack } from "../lib/voice/savePolicy.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const ON_FILE = {
  upcomingAppointments: [
    { id: "a1", client_name: "Nithin Vodla", scheduled_at: "2026-09-20T15:00:00Z" },
  ],
};

describe("shouldConfirmSpelling — a name on file is never asked for", () => {
  // OLD BEHAVIOUR (LVX53, 2026-09-03): the record was not trusted unless the
  // caller said the name on this call, and the gate asked them to spell it.
  // Owner, 2026-10-15 (round A1 part 3, F4, call CAfbe569): a name on file for
  // the caller's number is never asked for; the ONE read-back spells its
  // surname as a statement instead, so a wrong record or a different person on
  // the same phone is heard and corrected without a question.
  it("does not ask for a name on file even when the caller never said it (owner F4)", () => {
    clearStats();
    expect(
      shouldConfirmSpelling({
        name: "Nithin Vodla",
        callerContext: ON_FILE,
        // What the caller's turn actually transcribed to on that call.
        callerSaidThisCall: "Hay en el Tíndala. Yeah. Tuesday works.",
      })
    ).toBe(false);
    // Still measured: the unspoken case is what LVX53 was about.
    expect(getLatencyStats().turnTaking.write_name_on_file_unspoken).toBe(1);
    expect(getLatencyStats().turnTaking.write_refused_name_provenance).toBeFalsy();
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

describe("LVX53 end to end — owner F4: booked, and counted", () => {
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
    // LVX179: the ONE question names the slot being written.
    lastReplyText: composeReadBack({
      toolName: "book_appointment",
      args: { client_name: "Nithin Vodla", scheduled_at: `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00` },
      config: {},
    }),
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

  // OLD BEHAVIOUR (part 3, F4): the handed sentence spelled an on-file surname
  // ("for Nithin, V-O-D-L-A"). Owner, part 4 (2026-10-15, call d1): a name on
  // file is SAID, not spelled -- spelling it back "felt weird".
  it("the one read-back says a name taken from the record, without spelling it (owner, part 4)", async () => {
    const { functionResponse } = await book({
      ...ctx("Hay en el Tíndala. Tuesday works."),
      lastReplyText: "Thanks. And which day suits you?",
      lastCallerText: "Tuesday works",
    });
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.gated).toBe(true);
    expect(functionResponse.response.message).toMatch(/ for Nithin Vodla, is that right\?/);
    expect(functionResponse.response.message).not.toMatch(/V-O-D-L-A/);
    expect(mockCreateAppointment).not.toHaveBeenCalled();
    // The write-order gate's look-ahead at the spelling gate (F2) decides
    // only: nothing reached the spelling gate itself, so nothing is counted.
    expect(getLatencyStats().turnTaking.write_name_on_file_unspoken).toBeFalsy();
  });

  it("the spelling ask is made once: the model does not ask again itself (owner F4)", async () => {
    const { functionResponse } = await executeToolCall(
      {
        id: "fc1",
        name: "book_appointment",
        args: {
          client_name: "Marcus Bell",
          scheduled_at: `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00`,
          in_addition_to_existing: true,
        },
      },
      ctx("it's Marcus Bell, Tuesday works")
    );
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/ask (?:them )?once/i);
    expect(functionResponse.response.message).toMatch(/do not ask (?:them )?(?:to spell it )?again/i);
  });

  // OLD BEHAVIOUR: refused, no row (LVX53). Owner F4 (2026-10-15): booked.
  it("books a name on file the caller never said, and counts it", async () => {
    const { functionResponse } = await book(ctx("Hay en el Tíndala. Tuesday works."));
    expect(functionResponse.response.success).toBe(true);
    expect(mockCreateAppointment).toHaveBeenCalled();
    expect(getLatencyStats().turnTaking.write_name_on_file_unspoken).toBe(1);
    expect(getLatencyStats().turnTaking.write_refused_name_provenance).toBeFalsy();
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
