/**
 * The business's own number is never the caller (Ilija inbound, Task 8), the
 * Live door. /twilio/live-voice hands the stream an EMPTY callerPhone
 * parameter when From is one of the business's own numbers
 * (tests/inboundGuardRoutes.test.js proves that end). This file proves the
 * other end: a REAL Live session started from `callerPhone: ""` in the stream's
 * custom parameters.
 *
 * R29: the call row is created with caller_number "" (nothing breaks on it).
 * R30: a record_customer_request / record_quote_request that names no callback
 * number saves callback_number null -- the business's own number is never
 * filled in as the customer's callback.
 *
 * The cascade half is the last describe in tests/session.test.js.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => true),
  notifyUnconfirmedClaim: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork",
  greeting: "Thanks for calling Brightwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request", "quote_request"],
  capabilities: {},
};

function storeDb() {
  const rows = [];
  const db = {
    ...fakeDb(CONFIG, "biz-1"),
    createCall: vi.fn(async () => "call-1"),
    createCustomerRequest: vi.fn(async (r) => {
      rows.push({ request_type: r.requestType, callback_number: r.callbackNumber, owner_notice_pending: r.ownerNoticePending });
      return `req-${rows.length}`;
    }),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
  };
  return { db, rows };
}

const writesLand = () => new Promise((r) => setTimeout(r, 60));

let prior;
beforeEach(() => {
  clearStats();
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = prior;
});

// The stream parameters /twilio/live-voice sends for an own-number call.
const OWN_NUMBER_CALL = { businessPhone: CONFIG.mainPhone, callerPhone: "" };

async function boot() {
  const { db, rows } = storeDb();
  const s = await bootLive({ config: CONFIG, database: db, callSid: "CA_own_live", customParameters: OWN_NUMBER_CALL });
  return { s, db, rows };
}

describe("Live: a call whose callerPhone parameter is empty (the business's own number)", () => {
  it("R29: the call row is created with an empty caller number, and no caller history is fetched", async () => {
    const { db } = await boot();
    await vi.waitFor(() => expect(db.createCall).toHaveBeenCalled());
    const [businessId, callSid, callerNumber, businessNumber] = db.createCall.mock.calls[0];
    expect(businessId).toBe("biz-1");
    expect(callSid).toBe("CA_own_live");
    expect(callerNumber).toBe("");
    expect(businessNumber).toBe(CONFIG.mainPhone);
  });

  it("R30: a message with no spoken callback number saves callback_number null", async () => {
    const { s, rows } = await boot();
    await s.callerSays("It's Jon, can you tell them I called about the invoice.");
    await s.assistantSays("Got it, Jon, about the invoice. Passing that on now.");
    const [res] = await s.callTool("record_customer_request", {
      request_type: "message",
      caller_name: "Jon",
      message: "about the invoice",
    });
    expect(res?.response?.success).toBe(true);
    await s.turnEnds();
    await writesLand();
    expect(rows).toHaveLength(1);
    expect(rows[0].request_type).toBe("message");
    expect(rows[0].callback_number).toBeNull();
  });

  it("R30: a quote request with no spoken callback number saves callback_number null", async () => {
    const { s, rows } = await boot();
    await s.callerSays("It's Jon, I'd like a quote to replace a water heater.");
    await s.assistantSays("Got it, Jon, a quote for a water heater. Passing that on now.");
    const [res] = await s.callTool("record_quote_request", {
      caller_name: "Jon",
      service_description: "replace a water heater",
    });
    expect(res?.response?.success).toBe(true);
    await s.turnEnds();
    await writesLand();
    expect(rows).toHaveLength(1);
    expect(rows[0].request_type).toBe("quote");
    expect(rows[0].callback_number).toBeNull();
  });

  it("control: a real caller number still fills the callback fallback", async () => {
    const { db, rows } = storeDb();
    const s = await bootLive({
      config: CONFIG,
      database: db,
      callSid: "CA_real_live",
      customParameters: { businessPhone: CONFIG.mainPhone, callerPhone: "+15551234567" },
    });
    await s.callerSays("It's Jon, can you tell them I called about the invoice.");
    await s.assistantSays("Got it, Jon, about the invoice. Passing that on now.");
    await s.callTool("record_customer_request", { request_type: "message", caller_name: "Jon", message: "about the invoice" });
    await s.turnEnds();
    await writesLand();
    expect(db.createCall.mock.calls[0][2]).toBe("+15551234567");
    expect(rows[0].callback_number).toBe("+15551234567");
  });
});
