import { describe, it, expect, beforeEach } from "vitest";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { createToolGuards } from "../lib/voice/live/guards.js";

// ---------------------------------------------------------------------------
// A guard that is not registered is a guard that never reports.
//
// `bumpCounter` increments only names present in COUNTER_NAMES -- unknown ones
// are dropped on purpose, so a typo at a call site cannot invent a metric
// (lib/voice/metrics.js:246). The cost of that design is this failure mode: a
// guard can fire correctly, block correctly, log correctly, and contribute
// nothing to /api/debug/latency, with every one of its own unit tests passing
// because they assert the guard's LOCAL counts.
//
// The guards' own tests do exactly that, and they would not have caught it.
// This file asserts the other half: that the numbers reach the place anyone
// would actually look for them.
// ---------------------------------------------------------------------------

const DECLARATIONS = [
  { name: "check_appointment_availability" },
  { name: "book_appointment" },
];

describe("live guard counters reach the metrics snapshot", () => {
  beforeEach(() => clearStats());

  it("registers the availability block", () => {
    const g = createToolGuards({ declarations: DECLARATIONS, config: { timezone: "Europe/London" } });
    g.before({ id: "1", name: "book_appointment", args: { scheduled_at: "2026-09-15T15:00:00" } });

    expect(getLatencyStats().turnTaking.live_guard_availability_blocked).toBe(1);
  });

  it("registers a suppressed duplicate write", () => {
    // Uses book_appointment, and that changed on 2026-09-09. It used to use
    // end_call, which was convenient because it needs no verified slot -- and
    // end_call is no longer deduplicated at all. A repeated hang-up is not a
    // duplicate write: it writes no row, and the second request is legitimate
    // exactly when the first was cancelled. See tests/liveGuards.test.js for
    // the call that established it.
    const g = createToolGuards({ declarations: DECLARATIONS, config: { timezone: "Europe/London" } });
    const fc = { id: "2", name: "book_appointment", args: { scheduled_at: "2026-09-15T15:00:00" } };
    g.after(fc, { functionResponse: { id: "2", name: "book_appointment", response: { success: true } } });
    g.before({ ...fc, id: "3" });

    expect(getLatencyStats().turnTaking.live_guard_duplicate_suppressed).toBe(1);
  });

  it("registers an unarmed invariant, so fail-open is visible rather than silent", () => {
    const g = createToolGuards({
      declarations: [{ name: "get_available_slots" }, { name: "book_appointment_in_ehr" }],
      config: { timezone: "Europe/London" },
    });
    g.before({ id: "4", name: "book_appointment_in_ehr", args: { scheduled_at: "2026-09-15T15:00:00" } });

    expect(getLatencyStats().turnTaking.live_guard_availability_unarmed).toBe(1);
  });
});
