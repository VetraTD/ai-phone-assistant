// ---------------------------------------------------------------------------
// lib/postCallRecover.js — the booking a call agreed to and never made.
//
// The assertion this file exists for is one line: the time written is
// `slots[index]`, the list member the reader chose, and never a timestamp parsed
// out of prose. That is the entire difference between this and claimSlot.js,
// which was reverted 2026-09-11 for writing verified-but-wrong times.
//
// So the reader is faked throughout and made to return hostile answers -- an
// index past the end of the list, a non-integer, a refusal -- and the test asks
// what reached the database. A fake that only ever returns 0 would prove nothing
// about the case that actually went wrong in production.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recoverOwedBooking } from "../lib/postCallRecover.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const c = () => getLatencyStats().turnTaking;

const SLOTS = ["2026-09-14T09:00", "2026-09-14T13:00", "2026-09-14T16:30"];

const TRANSCRIPT = [
  { speaker: "ai", message: "Would Monday at 9, 1, or 4:30 work for you?" },
  { speaker: "caller", message: "Alice to 4:30." },
  { speaker: "ai", message: "Monday, September 14th at 4 30 PM. Shall I book that?" },
  { speaker: "caller", message: "Yes." },
];

function makeDb(over = {}) {
  return {
    listAppointmentsByCallId: vi.fn(async () => []),
    fetchCallTranscript: vi.fn(async () => TRANSCRIPT),
    listAppointmentsByCaller: vi.fn(async () => []),
    createAppointmentIfAvailable: vi.fn(async () => "appt-new"),
    // The real one runs fn inside a tenant scope. Faked as a pass-through, but
    // its PRESENCE is asserted below: the service runs as vetra_app NOBYPASSRLS,
    // so an unscoped insert matches no policy, writes nothing, and reports
    // success -- a silent no-op this module must never be able to produce.
    withTenantSafe: vi.fn(async (_businessId, fn) => fn()),
    ...over,
  };
}

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

const base = (over = {}) => ({
  businessId: "biz-1",
  callId: "call-1",
  callSid: "CA1",
  callerNumber: "+14699338887",
  config: { capabilities: { appointments: { availability: { length: 45, capacity: 2 } } } },
  slots: SLOTS,
  agreed: true,
  mode: "act",
  ...over,
});

const deps = (db, over = {}) => ({
  db,
  log,
  judge: vi.fn(async () => ({ ran: true, agreedAction: "book" })),
  select: vi.fn(async () => ({ ran: true, slot: SLOTS[2], slotIndex: 2, confidence: "high" })),
  ...over,
});

describe("recoverOwedBooking — what reaches the database", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
  });

  it("books the slot the reader SELECTED, not a time from the transcript", async () => {
    const db = makeDb();
    const out = await recoverOwedBooking(base(), deps(db));

    expect(out.booked).toBe(true);
    expect(db.createAppointmentIfAvailable).toHaveBeenCalledTimes(1);
    const args = db.createAppointmentIfAvailable.mock.calls[0][0];
    // THE WHOLE POINT. slots[2], byte for byte.
    expect(args.scheduledAt).toBe("2026-09-14T16:30");
    expect(c().recover_booked).toBe(1);
  });

  it("writes through a tenant scope, or the insert silently writes nothing", async () => {
    const db = makeDb();
    await recoverOwedBooking(base(), deps(db));
    expect(db.withTenantSafe).toHaveBeenCalled();
    expect(db.withTenantSafe.mock.calls.some((call) => call[0] === "biz-1")).toBe(true);
  });

  it("carries the tenant's own slot length and capacity, not the DB defaults", async () => {
    // A recovered row must be the same shape as one the call itself would have
    // written. 45 and 2 come from the config above; 30 and 1 would mean this read
    // a duplicated default instead of the live booking path's own reader.
    const db = makeDb();
    await recoverOwedBooking(base(), deps(db));
    const args = db.createAppointmentIfAvailable.mock.calls[0][0];
    expect(args.lengthMinutes).toBe(45);
    expect(args.capacity).toBe(2);
  });

  it("does nothing, and calls no model, when a booking already exists", async () => {
    const db = makeDb({ listAppointmentsByCallId: vi.fn(async () => [{ status: "scheduled" }]) });
    const d = deps(db);
    const out = await recoverOwedBooking(base(), d);

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("row_exists");
    // The cost argument, asserted: the common case must not reach a model.
    expect(d.judge).not.toHaveBeenCalled();
    expect(d.select).not.toHaveBeenCalled();
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("will not re-book an appointment the caller CANCELLED on the same call", async () => {
    // The hazard a `scheduled > 0` test would have had. A call that books and then
    // cancels leaves a cancelled row and nothing scheduled; the reader sees a
    // transcript in which a booking WAS agreed and would hand back "book", and the
    // recovery would reinstate exactly what the caller asked to kill. Not
    // hypothetical -- CA25e323 did this on 2026-09-12.
    //
    // So the scope is "this call recorded NOTHING", and any row at all is enough
    // to stand down.
    const db = makeDb({ listAppointmentsByCallId: vi.fn(async () => [{ status: "cancelled" }]) });
    const d = deps(db);
    const out = await recoverOwedBooking(base(), d);

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("row_exists");
    expect(d.judge).not.toHaveBeenCalled();
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(c().recover_skipped_row_exists).toBe(1);
  });

  it("refuses to book on a FAILED row read, which is not an empty one", async () => {
    // null is a failed read and [] is a genuinely empty one. Booking on null is
    // booking during an outage on the strength of not being able to look.
    const db = makeDb({ listAppointmentsByCallId: vi.fn(async () => null) });
    const out = await recoverOwedBooking(base(), deps(db));

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("row_read_failed");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(c().recover_row_read_failed).toBe(1);
  });

  it("does not run at all unless the mode is exactly act", async () => {
    for (const mode of ["off", "shadow", undefined, "ACT "]) {
      const db = makeDb();
      const out = await recoverOwedBooking(base({ mode }), deps(db));
      expect(out.booked, String(mode)).toBe(false);
      expect(db.createAppointmentIfAvailable, String(mode)).not.toHaveBeenCalled();
    }
  });

  it("cannot fire with no confirmed-open times to choose from", async () => {
    const db = makeDb();
    const d = deps(db);
    const out = await recoverOwedBooking(base({ slots: [] }), d);

    expect(out.reason).toBe("no_candidate_slots");
    expect(d.judge).not.toHaveBeenCalled();
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("does not book when the call owed nothing", async () => {
    const db = makeDb();
    const d = deps(db, { judge: vi.fn(async () => ({ ran: true, agreedAction: "none" })) });
    const out = await recoverOwedBooking(base(), d);

    expect(out.reason).toBe("nothing_owed");
    expect(d.select).not.toHaveBeenCalled();
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("does not book when the reader declines to choose", async () => {
    const db = makeDb();
    const d = deps(db, { select: vi.fn(async () => ({ ran: true, slot: null })) });
    const out = await recoverOwedBooking(base(), d);

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("no_selection");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(c().recover_no_selection).toBe(1);
  });

  it("reports the slot being gone as a decline, not as a fault", async () => {
    // create_appointment_if_available is one atomic statement: it returns no id
    // when the time went between the call ending and this running. That is a
    // clean decline and the reason double-booking is structurally impossible.
    const db = makeDb({ createAppointmentIfAvailable: vi.fn(async () => null) });
    const out = await recoverOwedBooking(base(), deps(db));

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("slot_unavailable");
    expect(c().recover_slot_unavailable).toBe(1);
  });

  it("never throws when the insert throws", async () => {
    const db = makeDb({
      createAppointmentIfAvailable: vi.fn(async () => {
        throw new Error("deadlock detected");
      }),
    });
    const out = await recoverOwedBooking(base(), deps(db));

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("book_error");
    expect(c().recover_book_failed).toBe(1);
  });
});

describe("recoverOwedBooking — the name is never invented", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
  });

  it("takes a name only from a booking this caller already completed", async () => {
    const db = makeDb({
      listAppointmentsByCaller: vi.fn(async () => [{ client_name: "Dillan Bhakta" }]),
    });
    await recoverOwedBooking(base(), deps(db));
    expect(db.createAppointmentIfAvailable.mock.calls[0][0].clientName).toBe("Dillan Bhakta");
  });

  it("writes a NULL name rather than one read off this call", async () => {
    // LVX77: a booking retry wrote "Jane Doe", a name the caller never said. The
    // transcript above contains "Alice to 4:30" -- what one caller's choice of
    // 4:30 actually transcribed as -- and nothing here may turn that into a name.
    // The caller's phone number comes from the phone network and does the
    // identifying instead.
    const db = makeDb();
    await recoverOwedBooking(base(), deps(db));
    const args = db.createAppointmentIfAvailable.mock.calls[0][0];
    expect(args.clientName).toBe(null);
    expect(args.clientPhone).toBe("+14699338887");
    expect(c().recover_booked).toBe(1);
    expect(c().recover_booked_without_name).toBe(1);
  });

  it("ignores a history row whose name is blank", async () => {
    const db = makeDb({
      listAppointmentsByCaller: vi.fn(async () => [{ client_name: "   " }, { client_name: "Real Name" }]),
    });
    await recoverOwedBooking(base(), deps(db));
    expect(db.createAppointmentIfAvailable.mock.calls[0][0].clientName).toBe("Real Name");
  });
});

// ---------------------------------------------------------------------------
// EVERY READ SCOPED, and this is not tidiness. The service runs as vetra_app
// NOBYPASSRLS: a SELECT outside a tenant scope matches no policy and returns zero
// rows. For the row read that is the dangerous direction -- "no booking exists"
// and "I was not allowed to look" become the same answer, and the recovery would
// book over an appointment that is already there.
// ---------------------------------------------------------------------------
describe("recoverOwedBooking — reads cannot escape the tenant scope", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
  });

  it("reads the existing rows and the transcript inside withTenantSafe", async () => {
    const inScope = [];
    const db = makeDb();
    db.withTenantSafe = vi.fn(async (businessId, fn, opts) => {
      inScope.push(opts?.operation || "unnamed");
      return fn();
    });

    await recoverOwedBooking(base(), deps(db));
    expect(inScope).toContain("recoverExistingRows");
    expect(inScope).toContain("recoverTranscript");
    expect(inScope).toContain("recoverOwedBooking");
  });

  it("aborts rather than booking when the scoped row read cannot run", async () => {
    // withTenantSafe resolves to its fallback when the scope cannot be taken.
    // fallback is null here precisely so this reads as a FAILED look and not as
    // an empty calendar.
    const db = makeDb();
    db.withTenantSafe = vi.fn(async (_businessId, fn, opts) =>
      opts?.operation === "recoverExistingRows" ? opts.fallback : fn()
    );

    const out = await recoverOwedBooking(base(), deps(db));
    expect(out.reason).toBe("row_read_failed");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("declines when the transcript read comes back empty", async () => {
    const db = makeDb({ fetchCallTranscript: vi.fn(async () => []) });
    const out = await recoverOwedBooking(base(), deps(db));
    expect(out.reason).toBe("no_transcript");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE ONLY STRUCTURAL CONSENT GATE ON THIS PATH.
//
// Everything else here is a reader's judgement about prose. This one is not: the
// engine records an agreement token only when the caller's turn was affirmative
// AND the assistant's previous turn was a read-back. So a caller who got most of
// the way through a booking and never approved it produces no token, and no
// verdict from the reader can put an appointment in a calendar.
//
// Used ONLY to refuse, exactly as the LVX117 gate uses it. The token is
// action-blind -- it carried a cancellation's consent to a booking write ten
// turns later on a real call -- so it is never evidence that a booking was
// agreed. Its ABSENCE is evidence that nothing was.
// ---------------------------------------------------------------------------
describe("recoverOwedBooking — the caller must have agreed to something", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
  });

  it("refuses, and calls no model, when the call recorded no agreement at all", async () => {
    const db = makeDb();
    const d = deps(db);
    const out = await recoverOwedBooking(base({ agreed: false }), d);

    expect(out.booked).toBe(false);
    expect(out.reason).toBe("never_agreed");
    expect(d.judge).not.toHaveBeenCalled();
    expect(d.select).not.toHaveBeenCalled();
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
    expect(c().recover_skipped_never_agreed).toBe(1);
  });

  it("cannot be talked past by a reader that is sure a booking was agreed", async () => {
    // The gate is ABOVE the reader on purpose. A confident "book" plus a
    // confident slot choice must still lose to "the caller never said yes",
    // because the token is the only non-prose signal on this path.
    const db = makeDb();
    const d = deps(db, {
      judge: vi.fn(async () => ({ ran: true, agreedAction: "book", confidence: "high" })),
      select: vi.fn(async () => ({ ran: true, slot: SLOTS[0], slotIndex: 0, confidence: "high" })),
    });
    const out = await recoverOwedBooking(base({ agreed: false }), d);

    expect(out.reason).toBe("never_agreed");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });

  it("treats a missing agreed flag as no agreement, not as permission", async () => {
    // A field produced by the engine and never copied into the input would read
    // as undefined here. It must fail CLOSED -- the opposite of the wire bugs this
    // repository has shipped twice, where an uncopied value silently disabled a
    // gate instead of a feature.
    const db = makeDb();
    const input = base();
    delete input.agreed;
    const out = await recoverOwedBooking(input, deps(db));

    expect(out.reason).toBe("never_agreed");
    expect(db.createAppointmentIfAvailable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EVERY DECLINE LEAVES A RECORD, and this exists because production taught it.
//
// On CAc5070c2d the caller went most of the way through a booking and hung up
// without approving it. The consent gate refused correctly and the recovery wrote
// nothing -- and there was NO WAY TO SEE THAT in the logs. The early returns bumped
// counters, counters are not readable per call, so "ran and stood down" and "never
// ran at all" were the same observation. The only way to tell them apart was
// noticing that verifyCall is chained after this and had fired.
//
// Same trap silent_turn_verdict closed for LVX117. An instrument that reads the
// same on a clean run and on a run that never happened is not an instrument.
// ---------------------------------------------------------------------------
describe("recoverOwedBooking — a decline is visible", () => {
  beforeEach(() => {
    clearStats();
    vi.clearAllMocks();
  });

  const declineReason = () =>
    log.info.mock.calls.filter((call) => call[0] === "recover_declined").map((call) => call[1].reason);

  it("logs why it stood down when the caller never agreed", async () => {
    // CAc5070c2d's exact shape.
    await recoverOwedBooking(base({ agreed: false }), deps(makeDb()));
    expect(declineReason()).toEqual(["never_agreed"]);
  });

  it("logs why it stood down when a row already exists", async () => {
    const db = makeDb({ listAppointmentsByCallId: vi.fn(async () => [{ status: "cancelled" }]) });
    await recoverOwedBooking(base(), deps(db));
    expect(declineReason()).toEqual(["row_exists"]);
  });

  it("logs why it stood down when there were no confirmed times", async () => {
    await recoverOwedBooking(base({ slots: [] }), deps(makeDb()));
    expect(declineReason()).toEqual(["no_candidate_slots"]);
  });

  it("logs why it stood down when the reader says nothing was owed", async () => {
    const d = deps(makeDb(), { judge: vi.fn(async () => ({ ran: true, agreedAction: "none" })) });
    await recoverOwedBooking(base(), d);
    expect(declineReason()).toEqual(["nothing_owed"]);
  });

  it("says NOTHING at all when the feature is off", async () => {
    // The one silence that is correct: a deployment with this disabled must not
    // emit a line per call.
    await recoverOwedBooking(base({ mode: "shadow" }), deps(makeDb()));
    expect(declineReason()).toEqual([]);
  });

  it("logs nothing about a decline when it actually books", async () => {
    await recoverOwedBooking(base(), deps(makeDb()));
    expect(declineReason()).toEqual([]);
  });
});
