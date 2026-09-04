// ---------------------------------------------------------------------------
// LVX72 — a refused write, answered, never retried, announced as done.
//
// Call 6 of the verification round, 2026-09-04, verbatim:
//
//   caller> Actually, can we change that name on that appointment to Nathan Dodla?
//   asst  > Of course. Just so I get that spelled correctly, could you spell
//           "Nathan" for me?
//   caller> Yeah, n a t h a n
//   asst  > Thanks, N A T H A N — so that's Nathan Dodla for the crown on the 10th.
//
// The row still read `Nithin Dodla`. `changed_rows: 0`. The model called the
// name-correction tool, the spelling gate refused it pending a spelling, the
// caller answered — and the model never called the tool again. It went straight
// to announcing the change.
//
// ---------------------------------------------------------------------------
// Why neither existing guard saw it
// ---------------------------------------------------------------------------
//
// postcall_verify returned `verdict: ok`, because reconcile() asks whether the
// call wrote ANYTHING and a booking had succeeded in the same call. That coarse
// boolean is documented on this page as a known flaw -- "unrelated successful
// writes mask a fabrication" -- and this is it, observed rather than reasoned
// about.
//
// The claim detector missed the sentence too, and that is not fixable here:
// "so that's Nathan Dodla for the crown" carries no completion verb. It is a
// claim about the CONTENT of a record, the LVX59 class, which nothing detects.
//
// So the signal used is neither of those. A tool that was REFUSED and never
// subsequently SUCCEEDED is structurally detectable, exactly, with no language
// analysis at all -- and it is a stronger signal than matching sentences,
// because it does not depend on how the model phrased anything.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import { verifyCall } from "../lib/postCallVerify.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const CONFIG = { businessName: "Brightwork Family Dental", timezone: "America/Chicago" };

function deps({ booked = [], byId = {} } = {}) {
  return {
    db: {
      withTenantSafe: async (_id, fn) => fn(),
      listAppointmentsByCallId: async () => booked,
      getAppointmentById: async (id) => byId[id] ?? null,
    },
    notifications: { sendSms: vi.fn() },
  };
}

const base = {
  businessId: "biz-1",
  callId: "call-1",
  config: CONFIG,
  callerNumber: "+14699338887",
  mode: "count",
  callSid: "CA1",
};

describe("LVX72 — a write that was refused and never completed", () => {
  it("is reported even when an unrelated write succeeded on the same call", async () => {
    // The exact shape of call 6: a booking succeeded, a name correction was
    // refused and abandoned. Before this, `wroteAnything` was true and the
    // verdict was `ok`.
    clearStats();
    const out = await verifyCall(
      {
        ...base,
        writes: [{ type: "booked", tool: "book_appointment" }],
        claims: [{ turn: 9, kind: "claim", step: "confirm", toolBacked: true }],
        abandoned: ["correct_appointment_name"],
      },
      deps({ booked: [{ id: "a1", client_name: "Nithin Dodla", scheduled_at: "2026-09-10T14:00:00Z" }] })
    );

    expect(out.verdict).toBe("write_abandoned");
    expect(out.abandoned).toEqual(["correct_appointment_name"]);
    expect(getLatencyStats().turnTaking.postcall_write_abandoned).toBe(1);
  });

  it("outranks ok, because ok is what it was wrongly reported as", async () => {
    clearStats();
    const out = await verifyCall(
      { ...base, writes: [], claims: [], abandoned: ["cancel_appointment_db"] },
      deps()
    );
    expect(out.verdict).toBe("write_abandoned");
  });

  it("says nothing when a refused write was afterwards completed", async () => {
    // A refusal that the model acted on is the system working. The spelling
    // gate refuses on purpose, and the retry is the whole point of its wording.
    clearStats();
    const out = await verifyCall(
      {
        ...base,
        writes: [{ type: "changed", tool: "correct_appointment_name", appointmentId: "a1" }],
        claims: [{ turn: 9, kind: "claim", step: "confirm", toolBacked: true }],
        abandoned: [],
      },
      deps({ byId: { a1: { id: "a1", client_name: "Nathan Dodla" } } })
    );
    expect(out.verdict).toBe("ok");
    expect(getLatencyStats().turnTaking.postcall_write_abandoned).toBe(0);
  });

  it("leaves every other verdict alone", async () => {
    clearStats();
    const claimOnly = await verifyCall(
      { ...base, writes: [], claims: [{ turn: 3, kind: "claim", step: "confirm", toolBacked: false }] },
      deps()
    );
    expect(claimOnly.verdict).toBe("claim_without_row");

    const rowOnly = await verifyCall(
      { ...base, writes: [{ type: "booked", tool: "book_appointment" }], claims: [] },
      deps({ booked: [{ id: "a1", client_name: "X", scheduled_at: "2026-09-10T14:00:00Z" }] })
    );
    expect(rowOnly.verdict).toBe("row_without_claim");
  });

  it("treats an absent abandoned list as nothing abandoned", async () => {
    // Every existing caller passes no such field, and the cascade never will.
    clearStats();
    const out = await verifyCall(
      { ...base, writes: [{ type: "booked", tool: "book_appointment" }], claims: [] },
      deps({ booked: [{ id: "a1", client_name: "X", scheduled_at: "2026-09-10T14:00:00Z" }] })
    );
    expect(out.verdict).toBe("row_without_claim");
  });
});
