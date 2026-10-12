// Inbound guards (batch 3 S4, Task 4.2): the helper both webhooks call.
// Fails OPEN, refuses only on a block-list match or a forward-all bounce, and
// raises an alert (never a refusal) on the 31st call from one number in a day.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  inboundGuardTwiml,
  isRealCallerNumber,
  isOwnNumber,
  REPEAT_CALLS_ALERT_AT,
} from "../lib/inboundGuards.js";
import { last4 } from "../lib/phone.js";

const BIZ = {
  id: "biz-1",
  phone_number: "+18175550100",
  main_phone: "+18175550101",
  transfer_phone_number: "+18175550102",
  notification_phone: "+18175550103",
};
const CALLER = "+15559990000";

function capture(...events) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") {
      for (const l of chunk.split("\n")) {
        if (events.some((e) => l.includes(`"event":"${e}"`))) lines.push(JSON.parse(l));
      }
    }
    return true;
  });
  return { of: (e) => lines.filter((l) => l.event === e), restore: () => spy.mockRestore() };
}

function fakeDatabase(facts) {
  return { inboundGuardFacts: vi.fn(async () => facts) };
}

async function run(database, over = {}) {
  return inboundGuardTwiml({ database, business: BIZ, from: CALLER, callSid: "CA1", route: "live", ...over });
}

afterEach(() => vi.restoreAllMocks());

describe("inboundGuardTwiml", () => {
  it("a blocked caller is rejected, logged with the last four digits only", async () => {
    const cap = capture("inbound_caller_blocked");
    const twiml = await run(fakeDatabase({ blocked: true, bounced: false, callsToday: 0 }));
    cap.restore();
    expect(twiml).toBe('<Response><Reject reason="rejected"/></Response>');
    const ev = cap.of("inbound_caller_blocked");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ callSid: "CA1", businessId: "biz-1", route: "live", callerLast4: "0000" });
    expect(JSON.stringify(ev[0])).not.toContain("5559990000");
  });

  it("a forward-all bounce is refused as busy and logged as an alert", async () => {
    const cap = capture("transfer_loop_refused");
    const twiml = await run(fakeDatabase({ blocked: false, bounced: true, callsToday: 0 }), { route: "cascade" });
    cap.restore();
    expect(twiml).toBe('<Response><Reject reason="busy"/></Response>');
    expect(cap.of("transfer_loop_refused")).toEqual([
      expect.objectContaining({ callSid: "CA1", businessId: "biz-1", route: "cascade", severity: "warn" }),
    ]);
  });

  it("blocked wins over bounced", async () => {
    const twiml = await run(fakeDatabase({ blocked: true, bounced: true, callsToday: 0 }));
    expect(twiml).toContain('reason="rejected"');
  });

  it("a clean caller is answered (null)", async () => {
    expect(await run(fakeDatabase({ blocked: false, bounced: false, callsToday: 3 }))).toBeNull();
  });

  it("FAILS OPEN: a throwing lookup answers the call and logs inbound_guard_failed", async () => {
    const cap = capture("inbound_guard_failed");
    const database = {
      inboundGuardFacts: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    expect(await run(database)).toBeNull();
    cap.restore();
    expect(cap.of("inbound_guard_failed")).toEqual([
      expect.objectContaining({ callSid: "CA1", businessId: "biz-1", route: "live", message: "db down", severity: "warn" }),
    ]);
  });

  it("FAILS OPEN when the database lacks the method (a missing wire is a logged failure)", async () => {
    const cap = capture("inbound_guard_failed");
    expect(await run({})).toBeNull();
    cap.restore();
    expect(cap.of("inbound_guard_failed")).toHaveLength(1);
  });

  it("no facts (database not configured) answers the call", async () => {
    expect(await run(fakeDatabase(null))).toBeNull();
  });

  it("no business, or one without an id: nothing to check, the database is not asked", async () => {
    const database = fakeDatabase({ blocked: true, bounced: true, callsToday: 0 });
    expect(await run(database, { business: null })).toBeNull();
    expect(await run(database, { business: {} })).toBeNull();
    expect(database.inboundGuardFacts).not.toHaveBeenCalled();
  });

  it("asks for the count only for a real caller that is not the business's own number", async () => {
    const database = fakeDatabase({ blocked: false, bounced: false, callsToday: 0 });
    await run(database);
    expect(database.inboundGuardFacts).toHaveBeenLastCalledWith({ businessId: "biz-1", from: CALLER, countCalls: true });
  });

  describe("repeat-caller alert", () => {
    it("fires once, on exactly 30 prior calls, reporting the 31st", async () => {
      const cap = capture("repeat_caller_calls");
      const twiml = await run(fakeDatabase({ blocked: false, bounced: false, callsToday: REPEAT_CALLS_ALERT_AT }));
      cap.restore();
      expect(twiml).toBeNull(); // an alert, never a refusal
      expect(REPEAT_CALLS_ALERT_AT).toBe(30);
      const ev = cap.of("repeat_caller_calls");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ callSid: "CA1", businessId: "biz-1", callerLast4: "0000", count: 31, severity: "warn" });
      expect(JSON.stringify(ev[0])).not.toContain("5559990000");
    });

    it("does not fire at 29 or 31 prior calls", async () => {
      const cap = capture("repeat_caller_calls");
      await run(fakeDatabase({ blocked: false, bounced: false, callsToday: 29 }));
      await run(fakeDatabase({ blocked: false, bounced: false, callsToday: 31 }));
      cap.restore();
      expect(cap.of("repeat_caller_calls")).toHaveLength(0);
    });

    it("never counts or alerts for the business's own numbers (each field, any format)", async () => {
      const cases = [
        BIZ.phone_number,
        BIZ.main_phone,
        BIZ.transfer_phone_number,
        BIZ.notification_phone,
      ];
      for (const from of cases) {
        const cap = capture("repeat_caller_calls");
        const database = fakeDatabase({ blocked: false, bounced: false, callsToday: 30 });
        await run(database, { from });
        cap.restore();
        expect(database.inboundGuardFacts).toHaveBeenCalledWith({ businessId: "biz-1", from, countCalls: false });
        expect(cap.of("repeat_caller_calls")).toHaveLength(0);
      }
      // A differently formatted stored number still matches.
      const messy = { ...BIZ, transfer_phone_number: "\n+1 (817) 555-0102 " };
      const database = fakeDatabase({ blocked: false, bounced: false, callsToday: 30 });
      await run(database, { business: messy, from: "+18175550102" });
      expect(database.inboundGuardFacts).toHaveBeenCalledWith(expect.objectContaining({ countCalls: false }));
    });

    it("never counts anonymous placeholders or non-E.164 values", async () => {
      for (const from of ["+266696687", "+7378742833", "+86282452253", "+2562533", "anonymous", "", "5559990000", undefined]) {
        const cap = capture("repeat_caller_calls");
        const database = fakeDatabase({ blocked: false, bounced: false, callsToday: 30 });
        await run(database, { from });
        cap.restore();
        expect(database.inboundGuardFacts.mock.calls[0][0].countCalls).toBe(false);
        expect(cap.of("repeat_caller_calls")).toHaveLength(0);
      }
    });
  });
});

describe("isRealCallerNumber", () => {
  it.each([
    ["+15559990000", true],
    ["+442079460958", true],
    ["+1234567", true], // 7 digits: the shortest accepted
    ["+266696687", false], // ANONYMOUS
    ["+7378742833", false], // RESTRICTED
    ["+86282452253", false], // UNAVAILABLE
    ["+2562533", false], // BLOCKED
    ["anonymous", false],
    ["15559990000", false],
    ["+0559990000", false],
    ["+123456", false],
    ["+1234567890123456", false],
    ["", false],
    [null, false],
    [undefined, false],
    [15559990000, false],
  ])("%s -> %s", (from, expected) => {
    expect(isRealCallerNumber(from)).toBe(expected);
  });
});

describe("isOwnNumber", () => {
  it("is false for an unknown caller, a missing business or an unparseable caller", () => {
    expect(isOwnNumber(BIZ, CALLER)).toBe(false);
    expect(isOwnNumber(null, CALLER)).toBe(false);
    expect(isOwnNumber(BIZ, "anonymous")).toBe(false);
  });
  it("ignores empty own fields", () => {
    expect(isOwnNumber({ phone_number: null, main_phone: "" }, "+18175550100")).toBe(false);
  });
});

describe("last4", () => {
  it("is the last four digits, or empty under four", () => {
    expect(last4("+15559990000")).toBe("0000");
    expect(last4("+44 20 7946 0958")).toBe("0958");
    expect(last4("123")).toBe("");
    expect(last4(null)).toBe("");
    expect(last4("anonymous")).toBe("");
  });
});
