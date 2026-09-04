import { describe, it, expect } from "vitest";
import { createToolGuards } from "../lib/voice/live/guards.js";

// ---------------------------------------------------------------------------
// Guards in the reducer, counted -- not asked for in the prompt.
//
// This codebase has already established that "at most once" in a prompt does
// not hold (docs/receptionist-backlog.md; the doubled goodbye, the doubled
// end_call, the spelling caps). The two invariants here are the ones section 6
// of the handoff names as non-negotiable, and both have a measured defect
// behind them:
//
//   availability   gpt-realtime-2.1 books without checking in 9 of 20 trials.
//                  Gemini 2.5 re-fires tools in half its booking trials,
//                  including one doubled book_appointment.
//   idempotency    Gemini 3.1 doubled end_call in 2 of 26 trials.
//
// What the availability invariant actually buys, stated precisely because the
// obvious reading is wrong: book_appointment ALREADY re-checks with the adapter
// before writing, and createAppointmentIfAvailable is atomic on top of that. So
// this guard is not double-booking protection -- that exists. It catches a
// different thing: a slot the model INVENTED. The backend re-check asks "is
// this slot free", never "did anyone offer the caller this time". A fabricated
// 3pm that happens to be free passes every existing check.
// ---------------------------------------------------------------------------

const TZ = "Europe/London";

/** The declaration list a Digile-Media-shaped business gets: built-in calendar. */
const BUILTIN_TOOLS = [
  { name: "check_appointment_availability" },
  { name: "book_appointment" },
  { name: "end_call" },
];

function guards(declarations = BUILTIN_TOOLS) {
  return createToolGuards({ declarations, config: { timezone: TZ } });
}

/** A successful point check: the model named a time and it was open. */
function pointCheckAvailable(at) {
  return {
    fc: { id: "1", name: "check_appointment_availability", args: { requested_at: at } },
    result: { functionResponse: { response: { success: true, available: true, message: "That time is available." } } },
  };
}

/** A day query: the caller named a day, the tool answered with open times. */
function dayCheck({ open_times, all_open_times = open_times }) {
  return {
    fc: { id: "2", name: "check_appointment_availability", args: { requested_at: "2026-09-15" } },
    result: { functionResponse: { response: { success: true, open_times, all_open_times, total_open: all_open_times.length } } },
  };
}

const book = (at) => ({ id: "9", name: "book_appointment", args: { scheduled_at: at, caller_name: "Marcus" } });
const reschedule = (at) => ({
  id: "10",
  name: "reschedule_appointment_db",
  args: { appointment_id: "a1", new_scheduled_at: at },
});

// ---------------------------------------------------------------------------
// LVX49 — rescheduling walked around the invariant entirely.
//
// AVAILABILITY_SHAPES keys on tool NAME and book_appointment was the whole
// list, so reschedule_appointment_db -- which writes a time -- came back with
// slotArg undefined, returned {allow: true} immediately, and was not even
// counted as unarmed, because looksLikeBooking only matched /^(book|schedule)_/.
// So a reschedule to an invented time was both unguarded AND invisible, and
// LVX27's only structural protection covered booking alone.
//
// Observed on a real call the same evening: verified_slots: 1 while
// reschedule_appointment_db succeeded. The slot happened to be real because the
// model had checked separately; nothing required that it had.
//
// This is also the argument against a general update_appointment tool. A
// field-bag carrying scheduled_at would sit outside this map the same way. A
// list keyed by name has to be maintained deliberately, and that cost is real
// and is why it is written down here rather than hidden.
// ---------------------------------------------------------------------------
describe("LVX49 — a reschedule writes a time, so it needs a verified slot", () => {
  const TOOLS = [...BUILTIN_TOOLS, { name: "reschedule_appointment_db" }];

  it("blocks a reschedule to a time nothing ever verified", () => {
    const g = guards(TOOLS);
    expect(g.before(reschedule("2026-09-15T15:00:00")).allow).toBe(false);
    expect(g.counts().availability_blocked).toBe(1);
  });

  it("allows a reschedule to a slot the availability tool returned", () => {
    const g = guards(TOOLS);
    g.after(...Object.values(pointCheckAvailable("2026-09-15T15:00:00")));
    expect(g.before(reschedule("2026-09-15T15:00:00")).allow).toBe(true);
  });

  it("allows a reschedule to a time from a day query's full list", () => {
    const g = guards(TOOLS);
    g.after(...Object.values(dayCheck({ open_times: ["2026-09-15T14:00:00"], all_open_times: ["2026-09-15T14:00:00", "2026-09-15T16:30:00"] })));
    expect(g.before(reschedule("2026-09-15T16:30:00")).allow).toBe(true);
  });

  it("counts a reschedule as unarmed when the business's availability shape is unknown", () => {
    // The fail-open direction is unchanged -- an EHR clinic registering
    // get_available_slots still books -- but it is now VISIBLE for a
    // reschedule, which is what "not even counted" meant.
    const g = guards([{ name: "get_available_slots" }, { name: "reschedule_appointment_db" }]);
    expect(g.before(reschedule("2026-09-15T15:00:00")).allow).toBe(true);
    expect(g.counts().availability_unarmed).toBe(1);
  });
});

describe("the POSITIVE availability counter", () => {
  // Without it, a call where every write was properly checked and a call that
  // never attempted a write both report availability_blocked: 0. That is the
  // measure this round added everywhere, after two guards in one day turned out
  // to be readable only as failures.
  it("counts a write that passed BECAUSE its slot was verified", () => {
    const g = guards();
    g.after(...Object.values(pointCheckAvailable("2026-09-15T14:00:00")));
    g.before(book("2026-09-15T14:00:00"));
    expect(g.counts().availability_allowed).toBe(1);
    expect(g.counts().availability_blocked).toBe(0);
  });

  it("does not count a tool the invariant does not cover", () => {
    const g = guards();
    g.before({ id: "3", name: "end_call", args: {} });
    expect(g.counts().availability_allowed).toBe(0);
  });
});

describe("availability invariant", () => {
  it("blocks a booking for a slot no check ever returned", () => {
    // The fabrication case. Nothing was checked, so nothing was offered, so
    // the caller cannot have agreed to this time.
    const g = guards();
    const verdict = g.before(book("2026-09-15T15:00:00"));

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe("availability_unverified");
    expect(g.counts().availability_blocked).toBe(1);
  });

  it("hands the model a functionResponse telling it to check, not an error", () => {
    // A refusal the model can act on. An error string would surface to the
    // caller as a failure; this is an instruction to do the thing it skipped.
    const g = guards();
    const { functionResponse } = g.before(book("2026-09-15T15:00:00"));

    expect(functionResponse.name).toBe("book_appointment");
    expect(functionResponse.response.success).toBe(false);
    expect(functionResponse.response.message).toMatch(/check_appointment_availability/);
  });

  it("allows a booking for a slot a point check confirmed available", () => {
    const g = guards();
    const { fc, result } = pointCheckAvailable("2026-09-15T14:00:00");
    g.after(fc, result);

    expect(g.before(book("2026-09-15T14:00:00")).allow).toBe(true);
    expect(g.counts().availability_blocked).toBe(0);
  });

  it("does NOT verify a slot the point check reported as taken", () => {
    const g = guards();
    g.after(
      { id: "1", name: "check_appointment_availability", args: { requested_at: "2026-09-15T14:00:00" } },
      { functionResponse: { response: { success: true, available: false, alternatives: ["2026-09-15T16:00:00"], message: "That time is taken." } } }
    );

    expect(g.before(book("2026-09-15T14:00:00")).allow).toBe(false);
    // ...but the alternatives it offered instead ARE open, and were offered.
    expect(g.before(book("2026-09-15T16:00:00")).allow).toBe(true);
  });

  it("allows a time the day query offered", () => {
    const g = guards();
    const { fc, result } = dayCheck({ open_times: ["2026-09-15T09:00:00", "2026-09-15T11:00:00"] });
    g.after(fc, result);

    expect(g.before(book("2026-09-15T11:00:00")).allow).toBe(true);
  });

  it("allows a time from all_open_times that was not among the three picked", () => {
    // THE false positive that would break the documented happy path.
    // openTimesForDay returns three spread `open_times` for the model to speak
    // and the FULL `all_open_times` alongside them. A caller who asks "anything
    // around ten?" gets a time from the full list. Harvesting only the picked
    // three would refuse a slot the tool itself said was open.
    const g = guards();
    const { fc, result } = dayCheck({
      open_times: ["2026-09-15T09:00:00", "2026-09-15T13:00:00", "2026-09-15T16:00:00"],
      all_open_times: [
        "2026-09-15T09:00:00",
        "2026-09-15T10:00:00",
        "2026-09-15T13:00:00",
        "2026-09-15T16:00:00",
      ],
    });
    g.after(fc, result);

    expect(g.before(book("2026-09-15T10:00:00")).allow).toBe(true);
  });

  it("does not care how the same instant is spelled", () => {
    // The round trip is naive local by contract, but the model has been seen
    // handing back an offset-bearing ISO. Blocking on a formatting difference
    // would refuse a legitimate booking, and a guard whose false positives
    // break booking is worse than no guard.
    const g = guards();
    const { fc, result } = pointCheckAvailable("2026-09-15T14:00:00");
    g.after(fc, result);

    expect(g.before(book("2026-09-15 14:00")).allow).toBe(true);
    expect(g.before(book("2026-09-15T14:00")).allow).toBe(true);
    expect(g.before(book("2026-09-15T13:00:00Z")).allow).toBe(true); // 14:00 London, BST
  });

  it("is not armed when the business has no availability tool it understands", () => {
    // An EHR clinic registers get_available_slots instead, whose response comes
    // from athena and has no shape this file can read. Arming the invariant
    // there would block EVERY booking for that business.
    //
    // Fail OPEN, and count it, because the asymmetry runs that way: a false
    // block breaks booking outright, a false allow lands on a backend that
    // still re-checks the slot and writes atomically.
    const g = guards([{ name: "get_available_slots" }, { name: "book_appointment_in_ehr" }]);

    expect(g.before({ id: "9", name: "book_appointment_in_ehr", args: { scheduled_at: "2026-09-15T15:00:00" } }).allow).toBe(true);
    expect(g.counts().availability_unarmed).toBe(1);
  });

  it("keeps its ledger per call", () => {
    const a = guards();
    a.after(...Object.values(pointCheckAvailable("2026-09-15T14:00:00")));

    expect(guards().before(book("2026-09-15T14:00:00")).allow).toBe(false);
  });
});

describe("idempotent tool execution", () => {
  it("suppresses a repeated write and returns the first response", () => {
    // The measured defect: 3.1 doubled end_call in 2 of 26 trials, and 2.5
    // doubled book_appointment. Executing twice books twice.
    const g = guards();
    const fc = book("2026-09-15T14:00:00");
    g.after(...Object.values(pointCheckAvailable("2026-09-15T14:00:00")));
    expect(g.before(fc).allow).toBe(true);
    g.after(fc, { functionResponse: { id: "9", name: "book_appointment", response: { success: true, message: "Booked." } } });

    const second = g.before({ ...fc, id: "10" });
    expect(second.allow).toBe(false);
    expect(second.reason).toBe("duplicate_write");
    expect(second.functionResponse.response.message).toBe("Booked.");
    expect(g.counts().duplicate_suppressed).toBe(1);
  });

  it("suppresses a doubled end_call", () => {
    const g = guards();
    const fc = { id: "3", name: "end_call", args: {} };
    g.before(fc);
    g.after(fc, { functionResponse: { id: "3", name: "end_call", response: { success: true } } });

    expect(g.before({ ...fc, id: "4" }).allow).toBe(false);
  });

  it("lets a read run again", () => {
    // Re-checking availability is a legitimate thing to do twice: the answer
    // can change while the caller is on the line. Only writes are deduped.
    const g = guards();
    const { fc, result } = pointCheckAvailable("2026-09-15T14:00:00");
    g.before(fc);
    g.after(fc, result);

    expect(g.before({ ...fc, id: "5" }).allow).toBe(true);
    expect(g.counts().duplicate_suppressed).toBe(0);
  });

  it("lets the same write run with different arguments", () => {
    const g = guards();
    g.after(...Object.values(dayCheck({ open_times: ["2026-09-15T14:00:00", "2026-09-15T16:00:00"] })));
    const first = book("2026-09-15T14:00:00");
    g.before(first);
    g.after(first, { functionResponse: { id: "9", name: "book_appointment", response: { success: true } } });

    expect(g.before(book("2026-09-15T16:00:00")).allow).toBe(true);
  });

  it("does not cache a write that failed, so a retry can succeed", () => {
    // A transient backend failure must not be frozen into the call. The model
    // apologising and trying once more is the correct behaviour, and a cached
    // failure would make the second attempt a no-op.
    const g = guards();
    g.after(...Object.values(pointCheckAvailable("2026-09-15T14:00:00")));
    const fc = book("2026-09-15T14:00:00");
    g.before(fc);
    g.after(fc, { functionResponse: { id: "9", name: "book_appointment", response: { success: false, message: "Backend timed out." } } });

    expect(g.before({ ...fc, id: "11" }).allow).toBe(true);
  });
});
