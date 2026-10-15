/**
 * Round A1 S3 (review finding I3, owner 2026-10-13): a caller who corrects a
 * message on the same call ("no, it's 0 1 2 4") must not file a second one.
 *
 * The prompt still tells the model to record it again with the fix
 * (capabilities/messages.js MESSAGE_PROTOCOL_SECTION step 5). The CODE turns
 * that second record into an UPDATE of the first row, and the owner gets ONE
 * "New customer request" email -- sent at the first save, as before. The email
 * is link-only by design (services/notifications.js), so the details the owner
 * reads are the row's, and the row is the thing the correction fixes.
 */

import { describe, it, expect, vi } from "vitest";
import messages from "../capabilities/messages.js";
import quotes from "../capabilities/quotes.js";
import { sameRequest } from "../lib/capabilities/customerRequests.js";
import { STEPS } from "../lib/callState.js";

/** An in-memory customer_requests table behind the three db functions the packs use. */
function makeEngine({ callId = "call-1", businessId = "biz-1", failUpdate = false, delivered = true } = {}) {
  const rows = [];
  let seq = 0;
  const calls = {
    rows,
    activeTenant: null,
    // notifyCustomerRequest resolves whether the owner was reached.
    notify: vi.fn().mockResolvedValue(delivered),
    sms: vi.fn().mockResolvedValue(undefined),
    logs: [],
    errors: [],
  };
  const db = {
    withTenantSafe: async (tenant, fn) => {
      const previous = calls.activeTenant;
      calls.activeTenant = tenant ?? null;
      try {
        return await fn();
      } finally {
        calls.activeTenant = previous;
      }
    },
    createCustomerRequest: vi.fn(async (r) => {
      // A write outside a tenant scope is refused under FORCE RLS.
      if (calls.activeTenant !== r.businessId) return null;
      // A real insert round trip -- what a back-to-back second record races.
      await new Promise((res) => setTimeout(res, 5));
      const id = `req-${++seq}`;
      rows.push({
        id,
        business_id: r.businessId,
        call_id: r.callId ?? null,
        request_type: r.requestType,
        caller_name: r.callerName ?? null,
        callback_number: r.callbackNumber ?? null,
        message: r.message ?? null,
        preferred_time: r.preferredTime ?? null,
        seq,
      });
      return id;
    }),
    listCallCustomerRequests: vi.fn(async (cid, biz, type) => {
      if (calls.activeTenant !== biz) return [];
      return rows
        .filter((r) => r.call_id === cid && r.business_id === biz && r.request_type === type)
        .sort((a, b) => b.seq - a.seq);
    }),
    updateCustomerRequest: vi.fn(async (u) => {
      if (failUpdate) return null;
      if (calls.activeTenant !== u.businessId) return null;
      const row = rows.find((r) => r.id === u.id && r.business_id === u.businessId);
      if (!row) return null;
      row.caller_name = u.callerName ?? row.caller_name;
      row.callback_number = u.callbackNumber ?? row.callback_number;
      row.message = u.message ?? row.message;
      row.preferred_time = u.preferredTime ?? row.preferred_time;
      return row.id;
    }),
  };
  const engine = {
    STEPS,
    setStep: () => {},
    addHistoryNote: () => {},
    setCapabilityState: () => {},
    call: {
      callSid: "CA_s3",
      businessId,
      callId,
      callerNumber: "+12145550100",
      config: { businessName: "Brightwork" },
      party: null,
    },
    deps: {
      db,
      notifications: { notifyCustomerRequest: calls.notify, sendCallerSms: calls.sms, MESSAGE_SLA_TEXT: "soon" },
      log: {
        info: (e, d) => calls.logs.push({ e, d }),
        error: (e, d) => calls.errors.push({ e, d }),
        warn: () => {},
      },
      captureException: (err) => calls.errors.push({ err }),
    },
  };
  return { engine, calls, db };
}

const MESSAGE = {
  request_type: "message",
  caller_name: "Jon",
  callback_number: "214 555 0123",
  message: "about the invoice",
};
const recorded = (data) => ({ capability: "messages", type: "recorded", data });
const quoted = (data) => ({ capability: "quotes", type: "requested", data });

/** onEffect is fire-and-forget; wait for the call's writes to settle. */
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("sameRequest -- a correction, or a different request?", () => {
  const P = (callerName, callbackNumber, message) => ({ callerName, callbackNumber, message });
  it.each([
    ["a corrected number", P("Jon", "2145550123", "about the invoice"), P("Jon", "2145550124", "about the invoice"), true],
    ["a corrected name", P("Jon", "2145550123", "about the invoice"), P("John", "2145550123", "about the invoice"), true],
    ["the model rewording the reason", P("Jon", "2145550123", "wants to discuss the invoice"), P("Jon", "2145550124", "about the invoice"), true],
    ["a reason filled in", P("Jon", "2145550123", null), P("Jon", "2145550123", "the invoice"), true],
    // Ruling (after the opus review): most of the words new -> a new request.
    // Filed as new, nothing lost; merging would let "invoice" overwrite it.
    ["detail added to the reason", P("Jon", "2145550123", "invoice"), P("Jon", "2145550123", "invoice 4471 is overdue"), false],
    ["a different reason", P("Jon", "2145550123", "running late for the appointment"), P("Jon", "2145550123", "needs a copy of the invoice"), false],
    ["a message for someone else", P("Jon", "2145550123", "tell Bob I'm running late"), P("Jon", "2145550123", "ask Sarah to send the contract"), false],
    ["half the reason changed", P("Jon", "2145550123", "tell billing about the invoice"), P("Jon", "2145550123", "tell sales about the invoice"), false],
    ["another person, same reason", P("Bob", "2145550123", "about the invoice"), P("Sarah", "9725550199", "about the invoice"), false],
    // Opus review C1: each of these merged, and the update overwrote the first request.
    ["the caller's name inside both messages", P("Jon Smith", "1", "Jon Smith wants a callback about his invoice"), P("Jon Smith", "1", "Jon Smith says the gate code changed"), false],
    // The name is half of each reason's words here: counted, these two would merge.
    ["the caller's name is not the reason", P("Jon Smith", "1", "Jon Smith about the invoice"), P("Jon Smith", "1", "Jon Smith about the contract"), false],
    ["two Spanish messages", P("Ana", "1", "Quiere que le llamen sobre la factura"), P("Ana", "1", "Quiere que le llamen sobre la cita de su hija"), false],
    ["two people on one phone", P("Jon", "2145550123", "schedule an appointment"), P("Jane", "2145550123", "schedule an appointment"), false],
    // Ruling: a big name change is a different person, even if it was a
    // correction -- filed as new, nothing lost.
    ["Jon -> Jonathan", P("Jon", "2145550123", "about the invoice"), P("Jonathan", "2145550124", "about the invoice"), false],
    ["a surname spelling fix", P("Ann Smith", "2145550123", "fence repair"), P("Ann Smyth", "2145550123", "fence repair"), true],
  ])("%s", (_label, prev, next, want) => {
    expect(sameRequest(prev, next)).toBe(want);
  });
});

describe("a correction on the same call updates the first message (I3)", () => {
  it("a corrected number updates the one row instead of filing a second", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].callback_number).toBe("214 555 0124");
    expect(calls.rows[0].message).toBe("about the invoice");
    expect(calls.logs.some((l) => l.e === "customer_request_corrected")).toBe(true);
  });

  it("the owner gets ONE email, at the first save, and none for the correction", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    // Sent at the first save: an email held back for a correction that may
    // never come is an email a dropped call can lose.
    expect(calls.notify).toHaveBeenCalledTimes(1);

    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();
    expect(calls.notify).toHaveBeenCalledTimes(1);
    // The caller's acknowledgement text is not re-sent either.
    expect(calls.sms).toHaveBeenCalledTimes(1);
  });

  it("two records dispatched back to back still make one row", async () => {
    const { engine, calls } = makeEngine();
    // Same turn, no await between: the second must see the first's row.
    messages.onEffect(recorded(MESSAGE), engine);
    messages.onEffect(recorded({ ...MESSAGE, caller_name: "John" }), engine);
    await settle();
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].caller_name).toBe("John");
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  it("a corrected quote updates its row too", async () => {
    const { engine, calls } = makeEngine();
    const q = { service_description: "replace a water heater", caller_name: "Ann", callback_number: "214 555 0177" };
    quotes.onEffect(quoted(q), engine);
    await settle();
    quotes.onEffect(quoted({ ...q, callback_number: "214 555 0178" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].request_type).toBe("quote");
    expect(calls.rows[0].callback_number).toBe("214 555 0178");
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  it("a re-record that names no reason keeps the message it corrects", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, message: "about invoice 4471" }), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124", message: "wants a call back" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message).toBe("about invoice 4471");
    expect(calls.rows[0].callback_number).toBe("214 555 0124");
  });

  it("a quote correction keeps the number and address the caller gave", async () => {
    const { engine, calls } = makeEngine();
    const q = {
      service_description: "replace a water heater",
      caller_name: "Ann Smith",
      callback_number: "214 555 0177",
      service_address: "12 Oak Street",
    };
    quotes.onEffect(quoted(q), engine);
    await settle();
    // The re-record fixes the surname and repeats nothing else.
    quotes.onEffect(quoted({ service_description: "replace a water heater", caller_name: "Ann Smyth" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].caller_name).toBe("Ann Smyth");
    // Not the caller ID (+12145550100): that fills a NEW row only.
    expect(calls.rows[0].callback_number).toBe("214 555 0177");
    expect(calls.rows[0].message).toBe("replace a water heater — Address: 12 Oak Street");
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  it("a correction sends the email the first save could not", async () => {
    const { engine, calls } = makeEngine();
    calls.notify.mockResolvedValueOnce(false); // SMTP refused, or the rate limit dropped it
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.notify).toHaveBeenCalledTimes(2);
    // The caller's acknowledgement is still sent once.
    expect(calls.sms).toHaveBeenCalledTimes(1);
  });

  it("a correction while the first email is still sending waits for it: one email", async () => {
    const { engine, calls } = makeEngine();
    let land;
    calls.notify.mockImplementationOnce(() => new Promise((r) => (land = r)));
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();
    land(true);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.notify).toHaveBeenCalledTimes(1);
  });

  it("a correction that cannot be written as an update is filed as new, never dropped", async () => {
    const { engine, calls } = makeEngine({ failUpdate: true });
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();

    expect(calls.rows.map((r) => r.callback_number)).toEqual(["214 555 0123", "214 555 0124"]);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });
});

describe("different requests on one call stay separate", () => {
  it("two unrelated messages file two rows and two emails", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, message: "running late for Thursday's appointment" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });

  it("a message and a quote file two rows and two emails", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, message: "the water heater quote" }), engine);
    await settle();
    quotes.onEffect(quoted({ service_description: "replace a water heater", caller_name: "Jon", callback_number: "214 555 0123" }), engine);
    await settle();

    expect(calls.rows.map((r) => r.request_type).sort()).toEqual(["message", "quote"]);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });

  it("two quotes for one address are two jobs", async () => {
    const { engine, calls } = makeEngine();
    // The address and urgency are most of each stored text: counted as the
    // reason, these two jobs would merge.
    const at = { caller_name: "Ann", callback_number: "214 555 0177", service_address: "12 Oak Street", urgency: "this week" };
    quotes.onEffect(quoted({ ...at, service_description: "gutters" }), engine);
    await settle();
    quotes.onEffect(quoted({ ...at, service_description: "fence" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });

  it("a message and a callback request are different request types", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, request_type: "callback", preferred_time: "after 3" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });

  it("the same message on another call is another row", async () => {
    const a = makeEngine({ callId: "call-1" });
    const b = makeEngine({ callId: "call-2" });
    // One table shared by both calls.
    b.engine.deps.db = a.db;
    messages.onEffect(recorded(MESSAGE), a.engine);
    await settle();
    messages.onEffect(recorded(MESSAGE), b.engine);
    await settle();

    expect(a.calls.rows).toHaveLength(2);
  });
});

describe("a single message is unchanged", () => {
  it("writes once inside the tenant scope and emails at once", async () => {
    const { engine, calls, db } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();

    expect(db.createCustomerRequest).toHaveBeenCalledTimes(1);
    expect(db.createCustomerRequest.mock.calls[0][0]).toEqual({
      businessId: "biz-1",
      callId: "call-1",
      requestType: "message",
      callerName: "Jon",
      callbackNumber: "214 555 0123",
      message: "about the invoice",
      preferredTime: null,
    });
    expect(db.updateCustomerRequest).not.toHaveBeenCalled();
    expect(calls.notify).toHaveBeenCalledTimes(1);
    expect(calls.notify.mock.calls[0][0]).toMatchObject({ businessId: "biz-1", customerRequest: MESSAGE });
  });

  it("with no call row there is nothing to match against: each record files as today", async () => {
    const { engine, calls, db } = makeEngine({ callId: null });
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();

    expect(db.listCallCustomerRequests).not.toHaveBeenCalled();
    expect(calls.rows).toHaveLength(2);
    expect(calls.notify).toHaveBeenCalledTimes(2);
  });
});
