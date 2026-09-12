// ---------------------------------------------------------------------------
// LVX77 — a name the caller never said, written into an appointment row.
//
// The first UK-tenant call, 2026-09-05. The model called book_appointment with
// client_name "Jane Doe". The caller had said no such thing — confirmed by the
// owner — and the appointments table was EMPTY when the call started, so unlike
// LVX53 there was no record to lift a name from. It was invented.
//
// The spelling gate refused that booking, correctly. The caller then spelled
// their real name and the assistant read the letters back. The code-level retry
// (LVX72) replayed the refused arguments verbatim, and the invention became a
// database row.
//
// ---------------------------------------------------------------------------
// Why this is a COUNTER and not a refusal
// ---------------------------------------------------------------------------
//
// Refusing was built and reverted the same day. Judged against the caller's own
// transcript, nameSpokenIn cannot separate a FABRICATED name from an
// ASR-MANGLED one — and mangled is the common case on this path, since the
// vendor has rendered this caller as "Nitin Danda" and a spelled name arrives as
// loose letters that match no whole word. Measured over the observed cases it
// refuses four in five, two of them legitimate bookings.
//
// Enforcing it would therefore trade a rare wrong name for a commoner missing
// booking — the defect LVX72 exists to prevent, and one that five of its tests
// caught immediately.
//
// So this OVER-COUNTS by construction, and that is written into the test below
// rather than discovered later. Its value is not precision: it is that LVX77 was
// invisible to every instrument on the call that produced it. postcall_verify
// returned `ok`.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateAppointment = vi.fn();
vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: (...a) => mockCreateAppointment(...a),
  countScheduledOverlapping: vi.fn().mockResolvedValue(0),
  listScheduledBetween: vi.fn().mockResolvedValue([]),
  listAppointmentsByCaller: vi.fn(async () => []),
  updateAppointmentStatus: vi.fn(),
  updateAppointment: vi.fn(),
  getAppointmentById: vi.fn(async () => null),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const c = () => getLatencyStats().turnTaking;

const ctxWith = (heard) => ({
  businessId: "biz-1",
  callerPhone: "+14699338887",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {
    businessName: "Digile Media",
    timezone: "Europe/London",
    businessHours: null,
    capabilities: { appointments: { enabled: true, adapter: "internal" } },
  },
  callerContext: { callCount: 1, lastCallSummary: null, upcomingAppointments: [] },
  // The gate is settled so the booking is allowed to proceed to a row; this
  // test is about what gets WRITTEN, not about whether spelling was asked.
  spellingSettled: true,
  callerSaidThisCall: heard,
  // ...and an agreement already on the record, so a refusal here is never the
  // LVX117 silent-turn gate either. Added 2026-09-12 when that gate shipped and
  // all four tests in this file went red: callerSaidThisCall is non-null, which
  // is what marks this ctx as Live, and with no caller text and no token the new
  // gate refuses the write before provenance is ever computed.
  //
  // The token rather than caller text on purpose. Setting lastCallerText would
  // make the whole consent cascade run and this fixture would then have to
  // satisfy the write-order gate as well; the token leaves the cascade skipped
  // exactly as it was before the gate existed, so this file's subject is
  // unchanged. It is also the honest shape: LVX77 was a booking the caller HAD
  // agreed to, carrying a name they never said.
  lastAgreementReadBackKey: "k_agreed_earlier",
  callerTurnsSinceAgreement: 1,
});

const book = (client_name) => ({
  id: "fc1",
  name: "book_appointment",
  args: { client_name, scheduled_at: "2026-09-07T10:00:00", notes: "Strategy Call" },
});

// ---------------------------------------------------------------------------
// THE CLOCK IS FROZEN. See tests/whichAppointment.test.js for what happens
// otherwise: its fixture held an appointment at 15:00Z on 5 September 2026, and
// at 15:00Z on 5 September 2026 that row stopped being "upcoming". Ten tests
// went red mid-session on a change that touched nothing they import.
//
// Every file carrying a hard-coded date near today has the same shape, so they
// all get the same guard rather than waiting to find out one at a time. Friday
// 4 September 2026 sits before every fixture date in this repository.
// ---------------------------------------------------------------------------
const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  // shouldAdvanceTime, NOT a bare useFakeTimers(). Several of these files settle
  // async work with a real setTimeout, and a frozen timer queue never fires it:
  // the run hangs rather than failing, which is the worst way for a test to be
  // wrong. This pins the DATE while leaving timers working.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});


describe("LVX77 — a booked name that the caller never said", () => {
  beforeEach(() => {
    clearStats();
    mockCreateAppointment.mockReset();
    mockCreateAppointment.mockResolvedValue({ id: "row-1" });
  });

  it("counts a name that appears nowhere in what the caller said", async () => {
    // THE CALL, reproduced. The caller talked about booking and gave a name;
    // "Jane Doe" is in neither.
    const out = await executeToolCall(
      book("Jane Doe"),
      ctxWith("hi id like to book a strategy call its nitin danda")
    );

    expect(out.functionResponse.response.success).toBe(true);
    expect(c().booking_name_provenance_checked).toBe(1);
    expect(c().booking_name_never_spoken).toBe(1);
  });

  it("does NOT count a name the caller plainly said", async () => {
    await executeToolCall(
      book("Nithin Dodla"),
      ctxWith("hi its nithin dodla id like to book a strategy call")
    );

    expect(c().booking_name_provenance_checked).toBe(1);
    expect(c().booking_name_never_spoken).toBe(0);
  });

  it("still writes the booking — this counts, it does not refuse", async () => {
    // The guarantee that keeps LVX72 intact. Four consecutive calls lost a
    // booking on this path before the retry existed; a screen with a false
    // positive rate this high must never be allowed to become a gate.
    await executeToolCall(book("Jane Doe"), ctxWith("nothing like that name here"));

    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
    expect(mockCreateAppointment.mock.calls[0][0].clientName).toBe("Jane Doe");
  });

  it("counts NOTHING when there is no transcript to judge against", async () => {
    // An absent instrument is not evidence. The cascade threads no transcript
    // at all, so it must behave exactly as it did before this existed.
    await executeToolCall(book("Jane Doe"), ctxWith(""));

    expect(c().booking_name_provenance_checked).toBe(0);
    expect(c().booking_name_never_spoken).toBe(0);
  });

  it("OVER-COUNTS a mangled name, and that is recorded rather than fixed", async () => {
    // The reason this is not a gate, pinned as a test so nobody promotes it to
    // one. The caller really is Nithin Dodla and really said so; the vendor
    // transcribed "Nitin Danda"; the model passed the correct spelling. Nothing
    // is wrong, and the counter fires anyway.
    await executeToolCall(
      book("Nithin Dodla"),
      ctxWith("hi its nitin danda id like to book something")
    );

    expect(c().booking_name_never_spoken).toBe(1);
    // The booking is untouched, which is the only thing that matters.
    expect(mockCreateAppointment).toHaveBeenCalledTimes(1);
  });
});
