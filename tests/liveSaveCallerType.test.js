/**
 * Fix wave I1 / M4: the caller type a message save sees.
 *
 * A save in the SAME turn as the first set_call_intent used to read a stale
 * (null) caller type, because the call state only learns the type at turn end.
 * A friend then got the lead treatment (a spelled read-back, a spelling ask
 * under "leads"). Both ends are real: the Live session's turnState(), the tool
 * runner's ctx (lib/voice/live/tools.js) and the real record_customer_request
 * reply. Every line is invented.
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
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};

const SAVE = { request_type: "message", caller_name: "Mike", callback_number: "214 555 0123", message: "about the party" };
const READ_BACK = /read back to the caller exactly what was saved/;

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

async function boot(callSid, config = CONFIG) {
  const database = {
    ...fakeDb(config, "biz-1"),
    createCustomerRequest: vi.fn(async () => "req-1"),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
  };
  return bootLive({ config, database, callSid });
}

describe("a save in the same turn as set_call_intent reads that turn's caller type", () => {
  it("one batch [personal, save with no type]: no read-back note", async () => {
    const s = await boot("CA_i1_batch");
    await s.callerSays("Hi, it's Mike, about my sister's party.");
    const out = await s.callToolBatch([
      ["set_call_intent", { intent: "take_message", caller_type: "personal", reason_given: true }],
      ["record_customer_request", SAVE],
    ]);
    const save = out.find((r) => r.name === "record_customer_request");
    expect(save.response.success).toBe(true);
    expect(save.response.next ?? "").not.toMatch(READ_BACK);
  });

  it("the wordless-turn variant: the type is reported in an earlier call of the turn, the save comes in the next", async () => {
    const s = await boot("CA_i1_wordless");
    await s.callerSays("Hi, it's Mike, about my sister's party.");
    await s.callTool("set_call_intent", { intent: "take_message", caller_type: "personal", reason_given: true });
    // No turn end between the two: the report is still pending, not in call state.
    const [res] = await s.callTool("record_customer_request", SAVE);
    expect(res.response.success).toBe(true);
    expect(res.response.next ?? "").not.toMatch(READ_BACK);
  });

  it("a type of other at the save reads like null: the lead read-back still fires", async () => {
    const s = await boot("CA_i1_other");
    await s.callerSays("Hi, it's Mike, about something.");
    const out = await s.callToolBatch([
      ["set_call_intent", { intent: "take_message", caller_type: "other" }],
      ["record_customer_request", SAVE],
    ]);
    const save = out.find((r) => r.name === "record_customer_request");
    expect(save.response.next).toMatch(READ_BACK);
    expect(save.response.next).toContain("Mike, M-I-K-E");
  });

  it("a lead reported in the batch is read back (the batch-local type is a lead's)", async () => {
    const s = await boot("CA_i1_lead");
    await s.callerSays("Hi, it's Mike, I would like a quote.");
    const out = await s.callToolBatch([
      ["set_call_intent", { intent: "take_message", caller_type: "new_enquiry" }],
      ["record_customer_request", SAVE],
    ]);
    expect(out.find((r) => r.name === "record_customer_request").response.next).toMatch(READ_BACK);
  });

  it("the save's own caller_type still wins over the batch's", async () => {
    const s = await boot("CA_i1_own");
    await s.callerSays("Hi, it's Mike, about the party.");
    const out = await s.callToolBatch([
      ["set_call_intent", { intent: "take_message", caller_type: "new_enquiry" }],
      ["record_customer_request", { ...SAVE, caller_type: "personal" }],
    ]);
    expect(out.find((r) => r.name === "record_customer_request").response.next ?? "").not.toMatch(READ_BACK);
  });
});

describe("two set_call_intent calls in one turn merge (M4)", () => {
  it("reason_given is sticky and the last valid caller_type wins", async () => {
    const s = await boot("CA_m4_merge");
    await s.callerSays("Hi, it's about the party.");
    await s.callToolBatch([
      ["set_call_intent", { intent: "take_message", caller_type: "new_enquiry", reason_given: true }],
      ["set_call_intent", { intent: "take_message", caller_type: "personal" }],
    ]);
    await s.assistantTurn("Got it.");
    expect(s.ws.liveState.reasonGiven).toBe(true);
    expect(s.ws.liveState.callerType).toBe("personal");
  });

  it("a later call without a type keeps the earlier valid type", async () => {
    const s = await boot("CA_m4_keep");
    await s.callerSays("Hi, it's about the party.");
    await s.callTool("set_call_intent", { intent: "take_message", caller_type: "personal", reason_given: true });
    await s.callTool("set_call_intent", { intent: "take_message" });
    await s.assistantTurn("Got it.");
    expect(s.ws.liveState.callerType).toBe("personal");
    expect(s.ws.liveState.reasonGiven).toBe(true);
  });

  it("an invalid later type does not replace a valid one", async () => {
    const s = await boot("CA_m4_invalid");
    await s.callerSays("Hi, it's about the party.");
    await s.callTool("set_call_intent", { intent: "take_message", caller_type: "personal" });
    await s.callTool("set_call_intent", { intent: "take_message", caller_type: "nonsense" });
    await s.assistantTurn("Got it.");
    expect(s.ws.liveState.callerType).toBe("personal");
  });
});
