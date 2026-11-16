/**
 * Round A1 S3 (review finding I3, owner 2026-10-13): a caller who corrects a
 * message on the same call ("no, it's 0 1 2 4") must not file a second one.
 *
 * The prompt still tells the model to record it again with the fix
 * (capabilities/messages.js MESSAGE_PROTOCOL_SECTION step 5). The CODE turns
 * that second record into an UPDATE of the first row. Ilija inbound, Task 4:
 * a row filed on a call is saved pending and nothing is emailed at save; the
 * owner's one email goes at call end (Tasks 5 and 6), so a correction has no
 * email of its own to send or to withhold.
 */

import { describe, it, expect, vi } from "vitest";
import messages from "../capabilities/messages.js";
import quotes from "../capabilities/quotes.js";
import {
  sameRequest,
  saveCustomerRequest,
  detailsFromArgs,
  mergeDetails,
  CALLER_TYPES,
  MAX_MESSAGE_LENGTH,
} from "../lib/capabilities/customerRequests.js";
import { renderCallRequestsEmail } from "../services/notifications.js";
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
        details: r.details ?? null,
        owner_notice_pending: r.ownerNoticePending ?? false,
        seq,
      });
      return id;
    }),
    listCallCustomerRequests: vi.fn(async (cid, biz, type) => {
      if (calls.activeTenant !== biz) return [];
      return rows
        .filter((r) => r.call_id === cid && r.business_id === biz && [].concat(type).includes(r.request_type))
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
      row.details = u.details ?? row.details;
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

  it("nothing is emailed at save or at a correction; the row stays pending", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    expect(calls.notify).not.toHaveBeenCalled();
    expect(calls.rows[0].owner_notice_pending).toBe(true);

    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();
    expect(calls.notify).not.toHaveBeenCalled();
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
    expect(calls.notify).not.toHaveBeenCalled();
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
    expect(calls.notify).not.toHaveBeenCalled();
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
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("a correction that cannot be written as an update is filed as new, never dropped", async () => {
    const { engine, calls } = makeEngine({ failUpdate: true });
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: "214 555 0124" }), engine);
    await settle();

    expect(calls.rows.map((r) => r.callback_number)).toEqual(["214 555 0123", "214 555 0124"]);
    expect(calls.rows.every((r) => r.owner_notice_pending)).toBe(true);
    expect(calls.notify).not.toHaveBeenCalled();
  });
});

describe("different requests on one call stay separate", () => {
  it("two unrelated messages file two pending rows", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, message: "running late for Thursday's appointment" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.rows.every((r) => r.owner_notice_pending)).toBe(true);
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("a message and a quote file two pending rows", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, message: "the water heater quote" }), engine);
    await settle();
    quotes.onEffect(quoted({ service_description: "replace a water heater", caller_name: "Jon", callback_number: "214 555 0123" }), engine);
    await settle();

    expect(calls.rows.map((r) => r.request_type).sort()).toEqual(["message", "quote"]);
    expect(calls.notify).not.toHaveBeenCalled();
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
    expect(calls.notify).not.toHaveBeenCalled();
  });

  // Production call CA082a6db7: one caller, one request, saved twice -- once as
  // "message", once as "callback" -- made TWO rows and an email listing the caller
  // twice, because the lookup for a same-call match filtered on the request type.
  // The two types are one pack and one request; quotes stay separate.
  it("the same request saved as a message and then as a callback is ONE row", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(recorded({ ...MESSAGE, request_type: "callback", preferred_time: "after 3" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(1);
    expect(calls.logs.some((l) => l.e === "customer_request_corrected")).toBe(true);
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("and the other way round, callback then message", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, request_type: "callback" }), engine);
    await settle();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    expect(calls.rows).toHaveLength(1);
  });

  it("a callback about a different reason is still a second row", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded(MESSAGE), engine);
    await settle();
    messages.onEffect(
      recorded({ ...MESSAGE, request_type: "callback", message: "running late for the appointment", preferred_time: "after 3" }),
      engine
    );
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.notify).not.toHaveBeenCalled();
  });

  it("a quote never merges with a message or a callback of the same caller and reason", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, request_type: "callback", message: "replace a water heater" }), engine);
    await settle();
    quotes.onEffect(
      quoted({ service_description: "replace a water heater", caller_name: "Jon", callback_number: "214 555 0123" }),
      engine
    );
    await settle();

    expect(calls.rows.map((r) => r.request_type).sort()).toEqual(["callback", "quote"]);
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
  it("writes once inside the tenant scope, pending, and emails nothing", async () => {
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
      details: null,
      ownerNoticePending: true,
    });
    expect(db.updateCustomerRequest).not.toHaveBeenCalled();
    expect(calls.notify).not.toHaveBeenCalled();
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

describe("a withheld caller number", () => {
  it("is never stored as the callback number when the caller gave none", async () => {
    const { engine, calls } = makeEngine();
    engine.call.callerNumber = "+266696687"; // what Twilio sends for a withheld caller
    messages.onEffect(recorded({ ...MESSAGE, callback_number: undefined }), engine);
    quotes.onEffect(quoted({ service_description: "replace a water heater", caller_name: "Ann" }), engine);
    await settle();
    expect(calls.rows).toHaveLength(2);
    expect(calls.rows.map((r) => r.callback_number)).toEqual([null, null]);
  });

  it("a real caller number still fills a missing one on a new row", async () => {
    const { engine, calls } = makeEngine();
    messages.onEffect(recorded({ ...MESSAGE, callback_number: undefined }), engine);
    await settle();
    expect(calls.rows[0].callback_number).toBe("+12145550100");
  });
});

describe("a lead's answers merge onto one row", () => {
  const D = (answers, callerType = "new_enquiry") => ({ callerType, answers });
  const saveRow = (engine, row) =>
    saveCustomerRequest({
      db: engine.deps.db,
      businessId: "biz-1",
      callId: engine.call.callId,
      row: { requestType: "message", callerName: "Jane Doe", callbackNumber: "214 555 0123", message: null, preferredTime: null, ...row },
    });

  it("a later save with details updates the row even when the reason was reworded", async () => {
    const { engine, calls, db } = makeEngine();
    await saveRow(engine, { message: "wants help with Meta ads" });
    const res = await saveRow(engine, {
      message: "interested in advertising",
      details: D([{ label: "Company", answer: "Acme" }]),
    });
    expect(res).toMatchObject({ corrected: true, ownerNoticePending: true });
    expect(db.createCustomerRequest).toHaveBeenCalledTimes(1);
    expect(db.updateCustomerRequest).toHaveBeenCalledTimes(1);
    const arg = db.updateCustomerRequest.mock.calls[0][0];
    // Final review I-1: a reworded reason the matcher cannot pair is appended,
    // so the owner reads both wordings; a second request would not be lost.
    expect(arg.message).toBe("wants help with Meta ads / interested in advertising");
    expect(arg.details).toEqual(D([{ label: "Company", answer: "Acme" }]));
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message).toBe("wants help with Meta ads / interested in advertising");
  });

  it("without details a reworded reason is still a new row", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "wants help with Meta ads" });
    await saveRow(engine, { message: "needs a copy of the invoice" });
    expect(calls.rows).toHaveLength(2);
  });

  it("a partial save cannot wipe an earlier answer", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "ads", details: D([{ label: "Company", answer: "Acme" }, { label: "Industry", answer: "Retail" }]) });
    await saveRow(engine, { message: "ads", details: D([{ label: "Email", answer: "j@acme.test" }]) });
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].details.answers.map((a) => a.label)).toEqual(["Company", "Industry", "Email"]);
  });

  it("a later answer for the same label replaces it", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "ads", details: D([{ label: "Company", answer: "Acme" }, { label: "Industry", answer: "Retail" }]) });
    await saveRow(engine, { message: "ads", details: D([{ label: "company ", answer: "Acme Ltd" }]) });
    expect(calls.rows[0].details.answers).toEqual([
      { label: "company", answer: "Acme Ltd" },
      { label: "Industry", answer: "Retail" },
    ]);
  });

  it("a different person is still a new row", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "ads", details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { callerName: "Tom Hill", message: "ads", details: D([{ label: "Company", answer: "Zed" }]) });
    expect(calls.rows).toHaveLength(2);
  });

  it("a first save is pending when there is a call", async () => {
    const { engine, db } = makeEngine();
    const res = await saveRow(engine, { message: "ads" });
    expect(res).toMatchObject({ corrected: false, ownerNoticePending: true });
    expect(db.createCustomerRequest.mock.calls[0][0].ownerNoticePending).toBe(true);
  });

  it("a save with no call id is not pending", async () => {
    const { engine, db } = makeEngine({ callId: null });
    const res = await saveRow(engine, { message: "ads" });
    expect(res).toMatchObject({ corrected: false, ownerNoticePending: false });
    expect(db.createCustomerRequest.mock.calls[0][0].ownerNoticePending).toBe(false);
  });

  it("a plain correction leaves details out of the update", async () => {
    const { engine, db } = makeEngine();
    await saveRow(engine, { message: "about the invoice" });
    await saveRow(engine, { message: "about the invoice", callbackNumber: "214 555 0124" });
    expect("details" in db.updateCustomerRequest.mock.calls[0][0]).toBe(false);
  });
});

// Final review I-1: the person-only match was taken by any save with details,
// and a caller_type alone is details. A second, different request from the
// same caller was merged onto the first row with its reason thrown away, and
// the tool still answered success.
describe("a second, different message from the same caller is never dropped (final review I-1)", () => {
  const D = (answers, callerType = "new_enquiry") => ({ callerType, answers });
  const saveRow = (engine, row) =>
    saveCustomerRequest({
      db: engine.deps.db,
      businessId: "biz-1",
      callId: engine.call.callId,
      row: { requestType: "message", callerName: "Jane Doe", callbackNumber: "214 555 0123", message: null, preferredTime: null, ...row },
    });
  const emailOf = (rows) => renderCallRequestsEmail({ businessName: "Brightwork", rows }).text;

  it("two different reasons, both saved with caller_type, both reach the rows and the email", async () => {
    const { engine, calls } = makeEngine();
    const first = { ...MESSAGE, caller_name: "Sam Client", caller_type: "existing_customer", message: "call me about invoice 4471" };
    messages.onEffect(recorded(first), engine);
    await settle();
    messages.onEffect(recorded({ ...first, message: "the contact form on our site has been broken since Monday" }), engine);
    await settle();

    expect(calls.rows).toHaveLength(2);
    expect(calls.rows.map((r) => r.message)).toEqual([
      "call me about invoice 4471",
      "the contact form on our site has been broken since Monday",
    ]);
    const text = emailOf(calls.rows);
    expect(text).toContain("invoice 4471");
    expect(text).toContain("contact form on our site has been broken since Monday");
  });

  it("a caller_type-only second save with a different reason does not take the person-only path", async () => {
    const { engine, db } = makeEngine();
    await saveRow(engine, { message: "wants help with Meta ads", details: D([]) });
    await saveRow(engine, { message: "needs a copy of the invoice", details: D([], "existing_customer") });
    expect(db.updateCustomerRequest).not.toHaveBeenCalled();
    expect(db.createCustomerRequest).toHaveBeenCalledTimes(2);
  });

  it("a lead with answers who adds a different request keeps both reasons on the one row", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "about invoice 4471", details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { message: "contact form broken since Monday", details: D([{ label: "Email", answer: "j@acme.test" }]) });

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message).toBe("about invoice 4471 / contact form broken since Monday");
    expect(calls.rows[0].details.answers.map((a) => a.label)).toEqual(["Company", "Email"]);
    const text = emailOf(calls.rows);
    expect(text).toContain("invoice 4471");
    expect(text).toContain("contact form broken since Monday");
  });

  it("a later correction of one of two joined reasons keeps the other", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "about invoice 4471", details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { message: "contact form broken since Monday", details: D([{ label: "Email", answer: "j@acme.test" }]) });
    // Close enough to the whole stored message to be a correction of it.
    await saveRow(engine, {
      message: "the contact form has been broken since Monday morning",
      details: D([{ label: "Email", answer: "j@acme.test" }]),
    });

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message).toBe("about invoice 4471 / the contact form has been broken since Monday morning");
  });

  it("the same reason again is not appended twice", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "about invoice 4471", details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { message: "contact form broken since Monday", details: D([{ label: "Email", answer: "j@acme.test" }]) });
    await saveRow(engine, { message: "contact form broken since Monday", details: D([{ label: "Industry", answer: "Retail" }]) });

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message).toBe("about invoice 4471 / contact form broken since Monday");
  });

  it("a nameless save with only a caller_type and a different reason files a row of its own", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "about invoice 4471", details: D([], "existing_customer") });
    await saveRow(engine, { callerName: null, message: "the gate code changed", details: D([], "existing_customer") });

    expect(calls.rows).toHaveLength(2);
    expect(calls.rows.map((r) => r.message)).toEqual(["about invoice 4471", "the gate code changed"]);
  });

  it("a nameless save with answers merges onto the call's row and keeps both reasons", async () => {
    const { engine, calls } = makeEngine();
    await saveRow(engine, { message: "about invoice 4471", details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { callerName: null, message: "the gate code changed", details: D([{ label: "Email", answer: "j@acme.test" }]) });

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].caller_name).toBe("Jane Doe");
    expect(calls.rows[0].message).toBe("about invoice 4471 / the gate code changed");
  });

  it("an appended message is clamped", async () => {
    const { engine, calls } = makeEngine();
    // Each about 1,200 characters: under the cap alone, over it joined.
    const long = (w) => Array.from({ length: 150 }, (_, i) => `${w}${i}`).join(" ");
    await saveRow(engine, { message: long("alpha"), details: D([{ label: "Company", answer: "Acme" }]) });
    await saveRow(engine, { message: long("bravo"), details: D([{ label: "Email", answer: "j@acme.test" }]) });

    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0].message.length).toBe(MAX_MESSAGE_LENGTH);
    expect(calls.rows[0].message.startsWith(long("alpha"))).toBe(true);
  });
});

describe("mergeDetails", () => {
  const D = (answers, callerType = null) => ({ callerType, answers });
  it("keeps the earlier position and takes the later spelling", () => {
    const m = mergeDetails(D([{ label: "A", answer: "1" }, { label: "Company", answer: "x" }, { label: "Z", answer: "2" }]), D([{ label: " COMPANY  ", answer: "y" }]));
    expect(m.answers).toEqual([
      { label: "A", answer: "1" },
      { label: "COMPANY", answer: "y" },
      { label: "Z", answer: "2" },
    ]);
  });
  it("collapses inner whitespace when comparing labels", () => {
    const m = mergeDetails(D([{ label: "Job   title", answer: "x" }]), D([{ label: "job title", answer: "y" }]));
    expect(m.answers).toHaveLength(1);
    expect(m.answers[0].answer).toBe("y");
  });
  it("incoming callerType wins when present, else stored stays", () => {
    expect(mergeDetails(D([], "personal"), D([], "supplier")).callerType).toBe("supplier");
    expect(mergeDetails(D([{ label: "a", answer: "b" }], "personal"), D([{ label: "c", answer: "d" }], null)).callerType).toBe("personal");
  });
  it("returns null when both are empty, and tolerates a null side", () => {
    expect(mergeDetails(null, null)).toBeNull();
    expect(mergeDetails(D([]), D([]))).toBeNull();
    expect(mergeDetails(null, D([{ label: "a", answer: "b" }]))).toEqual(D([{ label: "a", answer: "b" }]));
    expect(mergeDetails(D([{ label: "a", answer: "b" }]), null)).toEqual(D([{ label: "a", answer: "b" }]));
  });
  it("caps at 20: a new label past the cap is dropped, a replacement still works", () => {
    const full = D(Array.from({ length: 20 }, (_, i) => ({ label: `q${i}`, answer: "a" })));
    const m = mergeDetails(full, D([{ label: "extra", answer: "z" }, { label: "Q3", answer: "new" }]));
    expect(m.answers).toHaveLength(20);
    expect(m.answers.some((a) => a.label === "extra")).toBe(false);
    expect(m.answers[3]).toEqual({ label: "Q3", answer: "new" });
  });
});

describe("detailsFromArgs", () => {
  it("drops junk", () => {
    expect(detailsFromArgs({ details: "nope" })).toBeNull();
    expect(detailsFromArgs({ details: [{ label: "", answer: "x" }] })).toBeNull();
    expect(detailsFromArgs({ caller_type: "vip" })).toBeNull();
    expect(detailsFromArgs({})).toBeNull();
    expect(detailsFromArgs()).toBeNull();
  });
  it("a valid caller_type alone is enough", () => {
    expect(CALLER_TYPES).toContain("new_enquiry");
    expect(detailsFromArgs({ caller_type: "supplier" })).toEqual({ callerType: "supplier", answers: [] });
  });
  it("drops bad entries one by one", () => {
    const out = detailsFromArgs({
      caller_type: "vip",
      details: [null, "x", 4, { label: "Ok", answer: "yes" }, { label: 5, answer: "x" }, { label: "L", answer: "  " }, { label: "L", answer: 7 }],
    });
    expect(out).toEqual({ callerType: null, answers: [{ label: "Ok", answer: "yes" }] });
  });
  it("caps at 20, clamps 60/500, collapses whitespace first", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ label: `l${i}`, answer: "a" }));
    expect(detailsFromArgs({ details: many }).answers).toHaveLength(20);
    const out = detailsFromArgs({ details: [{ label: "x".repeat(100), answer: "y".repeat(600) }] });
    expect(out.answers[0].label).toHaveLength(60);
    expect(out.answers[0].answer).toHaveLength(500);
    const nl = detailsFromArgs({ details: [{ label: "  a\n\n b ", answer: "line one\r\n\tline   two\n" }] });
    expect(nl.answers[0]).toEqual({ label: "a b", answer: "line one line two" });
    const pad = detailsFromArgs({ details: [{ label: "a" + " ".repeat(100) + "b", answer: "ok" }] });
    expect(pad.answers[0].label).toBe("a b");
  });
});

describe("M3: the after-call message is never acknowledged to the caller", () => {
  it("a normal save texts the caller; the owed write's marked effect does not, but its row is still written", async () => {
    const normal = makeEngine();
    messages.onEffect(recorded(MESSAGE), normal.engine);
    await settle();
    expect(normal.calls.sms).toHaveBeenCalledTimes(1);

    const owed = makeEngine();
    messages.onEffect({ ...recorded(MESSAGE), afterCall: true }, owed.engine);
    await settle();
    expect(owed.calls.rows).toHaveLength(1);
    expect(owed.calls.rows[0].owner_notice_pending).toBe(true);
    expect(owed.calls.sms).not.toHaveBeenCalled();
  });
});
