import { describe, it, expect } from "vitest";
import {
  makeHangupPlan,
  hangupArmed,
  hangupDecision,
  counterValue,
  parseExpectation,
  checkExpectations,
} from "../lib/probe/hangup.js";

// ---------------------------------------------------------------------------
// WHEN A SCRIPTED CALL HANGS UP.
//
// LVX121's write path has never executed. The window it needs -- a recorded
// agreement with no row yet -- is opened by the caller's yes and closed by the
// write, and it was measured at 2.7 SECONDS on a clean call (CA6b773e2a:
// yes 08:39:23, row 08:39:25.9). The 44-second case that made it look reachable
// existed only because the assistant became confused about the caller's
// existing appointments.
//
// Eleven real calls on 2026-09-12 failed to discriminate old code from new on
// LVX125 and LVX126 for the same reason: the windows are three seconds wide and
// a human cannot hit them.
//
// The decision lives in a pure module so it can be tested without spending a
// phone call on it. The harness owns the timers, the socket and the clock, and
// asks this one question per tick.
// ---------------------------------------------------------------------------

describe("hangupDecision — the label trigger", () => {
  it("does not hang up before the named line has been spoken", () => {
    const plan = makeHangupPlan({ afterLabel: "demo_accept" });
    expect(hangupDecision({ plan, now: 9999, spokenEndedAt: null }).hangUp).toBe(false);
  });

  it("hangs up once the named line's audio has finished", () => {
    const plan = makeHangupPlan({ afterLabel: "demo_accept" });
    expect(hangupDecision({ plan, now: 1000, spokenEndedAt: 1000 })).toEqual({
      hangUp: true,
      reason: "after_label",
    });
  });

  it("waits the extra delay when one is asked for", () => {
    // The delay is how the window gets swept. Fire at 0 and the agreement
    // ledger may not have recorded the yes yet (recover declines
    // never_agreed); fire too late and the write has landed (row_exists).
    const plan = makeHangupPlan({ afterLabel: "demo_accept", delayMs: 500 });
    expect(hangupDecision({ plan, now: 1499, spokenEndedAt: 1000 }).hangUp).toBe(false);
    expect(hangupDecision({ plan, now: 1500, spokenEndedAt: 1000 }).hangUp).toBe(true);
  });
});

describe("hangupDecision — the counter trigger", () => {
  const plan = makeHangupPlan({ onCounter: "consent_agreement_recorded" });

  it("hangs up the moment the counter rises", () => {
    expect(hangupDecision({ plan, now: 0, counterBefore: 0, counterNow: 1 })).toEqual({
      hangUp: true,
      reason: "counter",
    });
  });

  it("does not hang up while the counter is unchanged", () => {
    expect(hangupDecision({ plan, now: 0, counterBefore: 1, counterNow: 1 }).hangUp).toBe(false);
  });

  it("refuses to fire when the server restarted mid-run", () => {
    // Every counter resets to zero on a restart, so "rose" and "reset then
    // rose" are the same number. The harness already refuses to PRINT a counter
    // delta across a bootId change; a trigger built on one must refuse to FIRE
    // for the same reason. An unreadable signal is not a signal.
    //
    // THE VALUES HERE ARE LOAD-BEARING. The first version of this test used
    // before 5 / now 1, which is false under the fix AND false without it,
    // because 1 > 5 is false on its own -- so deleting the bootIdStable term
    // left the suite green. Only a pair that genuinely LOOKS like a rise can
    // tell the two apart. Caught by sabotage, which is the only thing that
    // could have caught it.
    const looksLikeARise = { plan, now: 0, counterBefore: 0, counterNow: 1 };

    expect(hangupDecision({ ...looksLikeARise, bootIdStable: false }).hangUp).toBe(false);
    // ...and the same numbers DO fire when the boot is stable, which is what
    // pins the refusal on the bootId and not on the arithmetic.
    expect(hangupDecision({ ...looksLikeARise, bootIdStable: true }).hangUp).toBe(true);
  });

  it("does not fire when the counters could not be read at all", () => {
    expect(hangupDecision({ plan, now: 0, counterBefore: null, counterNow: null }).hangUp).toBe(
      false
    );
  });
});

describe("counterValue", () => {
  it("treats a counter absent before and present after as a rise", () => {
    // A counter nobody has bumped yet is ABSENT from the stats object, not
    // zero. Reading it as undefined makes the first rise on a fresh boot
    // invisible, which is the one that matters.
    expect(counterValue({}, "consent_agreement_recorded")).toBe(0);
    expect(counterValue({ consent_agreement_recorded: 1 }, "consent_agreement_recorded")).toBe(1);
    expect(counterValue(null, "anything")).toBe(0);
  });
});

describe("an unarmed plan", () => {
  it("never hangs up, whatever else is true", () => {
    const plan = makeHangupPlan({});
    expect(hangupArmed(plan)).toBe(false);
    expect(
      hangupDecision({ plan, now: 1e9, spokenEndedAt: 0, counterBefore: 0, counterNow: 9 }).hangUp
    ).toBe(false);
  });
});

describe("expectations — what makes this harness able to FAIL", () => {
  // The harness prints a report and exits 0 whatever happened. That is a sim
  // that cannot fail, and this repository has one entry about exactly that.
  it("defaults to a minimum of one", () => {
    expect(parseExpectation("recover_booked")).toEqual({ name: "recover_booked", min: 1 });
  });

  it("reads an explicit minimum", () => {
    expect(parseExpectation("write_order_refused:2")).toEqual({
      name: "write_order_refused",
      min: 2,
    });
  });

  it("refuses an empty name rather than expecting nothing", () => {
    expect(() => parseExpectation(":3")).toThrow();
    expect(() => parseExpectation("")).toThrow();
  });

  it("fails when the counter did not move", () => {
    const r = checkExpectations(
      [{ name: "recover_booked", min: 1 }],
      { recover_booked: 0 },
      { recover_booked: 0 }
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0].moved).toBe(0);
  });

  it("passes at exactly the minimum", () => {
    const r = checkExpectations([{ name: "recover_booked", min: 1 }], {}, { recover_booked: 1 });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("measures the DELTA, not the absolute value", () => {
    // A counter that was already at 5 before the call started has not moved
    // because it reads 5 afterwards.
    const r = checkExpectations(
      [{ name: "recover_booked", min: 1 }],
      { recover_booked: 5 },
      { recover_booked: 5 }
    );
    expect(r.ok).toBe(false);
  });

  it("reports every failure, not just the first", () => {
    const r = checkExpectations(
      [
        { name: "a", min: 1 },
        { name: "b", min: 2 },
      ],
      {},
      { b: 1 }
    );
    expect(r.failures.map((f) => f.name)).toEqual(["a", "b"]);
  });
});
