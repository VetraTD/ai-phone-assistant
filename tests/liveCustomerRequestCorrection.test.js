/**
 * Round A1 S3 (I3), the Live wire: a real Live session, the REAL
 * record_customer_request (no execute override -- bootLive runs
 * executeToolCallGuarded and capabilities/messages.js), and a db whose
 * customer_requests table is an in-memory array. The unit half is
 * tests/customerRequestCorrection.test.js.
 *
 * What the owner asked for, end to end: a caller who corrects their number
 * leaves ONE row holding the corrected number and ONE owner email; and however
 * the call ends -- a goodbye, or the line dropping mid-turn -- the email goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  // Resolves whether the owner was reached (round A1 S3).
  notifyCustomerRequest: vi.fn(async () => true),
  notifyUnconfirmedClaim: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

import * as notifications from "../services/notifications.js";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork",
  greeting: "Thanks for calling Brightwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};

const MESSAGE = {
  request_type: "message",
  caller_name: "Jon",
  callback_number: "214 555 0123",
  message: "about the invoice",
};
const SUMMARY = "So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice — passing that on now.";

/** fakeDb plus a customer_requests table the three request functions really read and write. */
function storeDb() {
  const rows = [];
  let tenant = null;
  const db = {
    ...fakeDb(CONFIG, "biz-1"),
    withTenantSafe: async (id, fn) => {
      const previous = tenant;
      tenant = id;
      try {
        return await fn();
      } finally {
        tenant = previous;
      }
    },
    createCustomerRequest: vi.fn(async (r) => {
      if (tenant !== r.businessId) return null;
      const id = `req-${rows.length + 1}`;
      rows.push({
        id,
        business_id: r.businessId,
        call_id: r.callId,
        request_type: r.requestType,
        caller_name: r.callerName,
        callback_number: r.callbackNumber,
        message: r.message,
        preferred_time: r.preferredTime,
      });
      return id;
    }),
    listCallCustomerRequests: vi.fn(async (callId, businessId, type) =>
      rows.filter((r) => r.call_id === callId && r.business_id === businessId && r.request_type === type).reverse()
    ),
    updateCustomerRequest: vi.fn(async (u) => {
      const row = rows.find((r) => r.id === u.id && r.business_id === u.businessId && tenant === u.businessId);
      if (!row) return null;
      row.caller_name = u.callerName ?? row.caller_name;
      row.callback_number = u.callbackNumber ?? row.callback_number;
      row.message = u.message ?? row.message;
      return row.id;
    }),
  };
  return { db, rows };
}

/** The effect chain is fire-and-forget; let it land. */
const writesLand = () => new Promise((r) => setTimeout(r, 60));

let prior;
beforeEach(() => {
  clearStats();
  vi.mocked(notifications.notifyCustomerRequest).mockClear();
  vi.mocked(notifications.sendCallerSms).mockClear();
  // The spelling gate is not what this file is about (tests/spellOnce.test.js is).
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = prior;
});

async function boot() {
  const { db, rows } = storeDb();
  const s = await bootLive({ config: CONFIG, database: db, callSid: "CA_s3_live" });
  return { s, db, rows };
}

async function leaveMessage(s) {
  await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
  await s.assistantSays(SUMMARY);
  const [res] = await s.callTool("record_customer_request", MESSAGE);
  expect(res?.response?.success).toBe(true);
}

describe("Live: a corrected message is one row and one email (I3)", () => {
  it("the caller corrects the number: the first row is updated, the owner is emailed once", async () => {
    const { s, rows } = await boot();
    await leaveMessage(s);
    await s.turnEnds();
    await writesLand();
    expect(rows).toHaveLength(1);
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);

    await s.callerSays("No, it's 0 1 2 4 at the end.");
    await s.assistantSays("Sorry — 2 1 4, 5 5 5, 0 1 2 4. Passing that on now.");
    const [res] = await s.callTool("record_customer_request", { ...MESSAGE, callback_number: "214 555 0124" });
    expect(res?.response?.success).toBe(true);
    await s.turnEnds();
    await s.hangUp();
    await writesLand();

    expect(rows).toHaveLength(1);
    expect(rows[0].callback_number).toBe("214 555 0124");
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Live: the email is never lost to the way the call ends", () => {
  it("the line drops in the same turn as the record: the row is written and the owner emailed", async () => {
    const { s, rows } = await boot();
    await leaveMessage(s);
    // No turnComplete, no Twilio stop: the socket just closes.
    s.ws.emit("close");
    await writesLand();

    expect(rows).toHaveLength(1);
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });

  it("a correction still in flight when the line drops updates the row and sends nothing more", async () => {
    const { s, rows } = await boot();
    await leaveMessage(s);
    await s.turnEnds();
    await s.callerSays("No, it's 0 1 2 4.");
    await s.callTool("record_customer_request", { ...MESSAGE, callback_number: "214 555 0124" });
    s.ws.emit("close");
    await writesLand();

    expect(rows).toHaveLength(1);
    expect(rows[0].callback_number).toBe("214 555 0124");
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });

  it("a second, different message on the same call is its own row and its own email", async () => {
    const { s, rows } = await boot();
    await leaveMessage(s);
    await s.turnEnds();
    await s.callerSays("Also, tell them I'm running late for Thursday.");
    await s.callTool("record_customer_request", { ...MESSAGE, message: "running late for Thursday's appointment" });
    await s.turnEnds();
    await s.hangUp();
    await writesLand();

    expect(rows).toHaveLength(2);
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(2);
  });
});
