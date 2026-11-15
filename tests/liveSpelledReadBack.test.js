/**
 * S4-F3, the Live wire, both ends real: the caller's own turn sets
 * spellingCaptured (lib/voice/live/index.js turnState -> callerSpelled), the
 * assistant's heard speech fills assistantSaidThisCall and the turn in progress
 * fills inTurnReplyText, the runner copies all three into ctx
 * (lib/voice/live/tools.js), and the REAL record_customer_request
 * (capabilities/messages.js, no execute override) builds its reply from them.
 * The unit half is tests/spelledReadBackNote.test.js.
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

const MESSAGE = {
  request_type: "message",
  caller_name: "Priya Raman",
  callback_number: "214 555 0123",
  message: "about the invoice",
};
const READ_BACK = /^\[not caller speech\] Before anything else, read back to the caller exactly what was saved, one letter at a time/;
const NAME_LETTERS = "Priya, P-R-I-Y-A, Raman, R-A-M-A-N";

let prior;
beforeEach(() => {
  clearStats();
  // The spelling gate is not what this file is about (tests/spellOnce.test.js is).
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = prior;
});

async function boot(callSid) {
  const database = {
    ...fakeDb(CONFIG, "biz-1"),
    createCustomerRequest: vi.fn(async () => "req-1"),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
  };
  return bootLive({ config: CONFIG, database, callSid });
}

describe("Live: a spelled name is read back from what was saved", () => {
  it("the caller spells, nothing is read back, the save's reply leads with the note", async () => {
    const s = await boot("CA_f3_spelled");
    await s.callerSays("It's Priya, R A M A N, on 214 555 0123, about the invoice.");
    const [res] = await s.callTool("record_customer_request", MESSAGE);
    expect(res.response.success).toBe(true);
    expect(res.response.message).toBe("I'll make sure they get your message.");
    expect(res.response.next).toMatch(READ_BACK);
    expect(res.response.next).toContain(NAME_LETTERS);
    expect(Object.keys(res.response).indexOf("next")).toBeLessThan(Object.keys(res.response).indexOf("message"));
  });

  it("call 14's shape: the surname spelled in the same breath as the save, no note", async () => {
    const s = await boot("CA_f3_inturn");
    await s.callerSays("It's Priya, R A M A N, on 214 555 0123, about the invoice.");
    await s.assistantSays("So that's Priya, Raman, R-A-M-A-N, on 2 1 4, 5 5 5, 0 1 2 3 about the invoice -- passing that on now.");
    const [res] = await s.callTool("record_customer_request", MESSAGE);
    expect(res.response.success).toBe(true);
    expect("next" in res.response).toBe(false);
  });

  it("the note obeyed in a heard turn: the next save with the same letters is quiet", async () => {
    const s = await boot("CA_f3_resave");
    await s.callerSays("It's Priya, R A M A N, on 214 555 0123, about the invoice.");
    const [first] = await s.callTool("record_customer_request", MESSAGE);
    expect(first.response.next).toContain(NAME_LETTERS);
    await s.assistantTurn(`Just to check -- ${NAME_LETTERS}. Is that right?`);
    await s.callerSays("Yes, that's right. And it's quite urgent.");
    const [second] = await s.callTool("record_customer_request", { ...MESSAGE, message: "about the invoice, urgent" });
    expect(second.response.success).toBe(true);
    expect("next" in second.response).toBe(false);
  });

  it("the caller never spelled, on a personal call: no note", async () => {
    // A lead gets the end read-back even unspelled (tests/spelledReadBackNote.test.js);
    // a personal caller does not, so the type rides on the save here.
    const s = await boot("CA_f3_unspelled");
    await s.callerSays("It's Priya Raman, on 214 555 0123, about the invoice.");
    const [res] = await s.callTool("record_customer_request", { ...MESSAGE, caller_type: "personal" });
    expect(res.response.success).toBe(true);
    expect("next" in res.response).toBe(false);
  });
});

describe("Live: one read-back at the end for a lead at a business with its own questions (fix wave I8)", () => {
  const NOTES = { ...CONFIG, capabilities: { messages: { notes: "Ask which company they are with." } } };
  const LEAD = { ...MESSAGE, caller_name: "Jonathan Daniel", caller_type: "new_enquiry" };
  const bootWith = (config, callSid) => {
    const database = {
      ...fakeDb(config, "biz-1"),
      createCustomerRequest: vi.fn(async () => "req-1"),
      listCallCustomerRequests: vi.fn(async () => []),
      updateCustomerRequest: vi.fn(async () => null),
    };
    return bootLive({ config, database, callSid });
  };

  it("the first save: the questions note and no letters; the answers save: the surname's letters", async () => {
    const s = await bootWith(NOTES, "CA_i8_lead");
    await s.callerSays("It's Jonathan Daniel, on 214 555 0123, I'd like a quote.");
    const [first] = await s.callTool("record_customer_request", LEAD);
    expect(first.response.success).toBe(true);
    expect(first.response.next).toMatch(/^\[not caller speech\] If this business's notes list questions/);
    expect(first.response.next).not.toContain("D-A-N-I-E-L");
    await s.assistantTurn("Which company are you with?");
    await s.callerSays("Acme Plumbing.");
    const [second] = await s.callTool("record_customer_request", {
      ...LEAD,
      details: [{ label: "Company", answer: "Acme Plumbing" }],
    });
    expect(second.response.success).toBe(true);
    expect(second.response.next).toContain('"Daniel, D-A-N-I-E-L"');
    expect(second.response.next).not.toContain("J-O-N-A-T-H-A-N");
  });

  it("the same lead at a business with no notes: the letters at the first save", async () => {
    const s = await bootWith(CONFIG, "CA_i8_nonotes");
    await s.callerSays("It's Jonathan Daniel, on 214 555 0123, I'd like a quote.");
    const [first] = await s.callTool("record_customer_request", LEAD);
    expect(first.response.next).toContain('"Daniel, D-A-N-I-E-L"');
  });

  it("an existing client at a notes business: the letters at the first save", async () => {
    const s = await bootWith(NOTES, "CA_i8_client");
    await s.callerSays("It's Jonathan Daniel, on 214 555 0123, about my job.");
    const [first] = await s.callTool("record_customer_request", { ...LEAD, caller_type: "existing_customer" });
    expect(first.response.next).toContain('"Daniel, D-A-N-I-E-L"');
  });
});

describe("Live: only the first save is deferred (P32 N2)", () => {
  it("a correction re-save without details, after the first save, hands the corrected letters", async () => {
    const config = { ...CONFIG, capabilities: { messages: { notes: "Ask which company they are with." } } };
    const database = {
      ...fakeDb(config, "biz-1"),
      createCustomerRequest: vi.fn(async () => "req-1"),
      listCallCustomerRequests: vi.fn(async () => []),
      updateCustomerRequest: vi.fn(async () => null),
    };
    const s = await bootLive({ config, database, callSid: "CA_n2_resave" });
    const lead = { ...MESSAGE, caller_name: "Jonathan Daniel", caller_type: "new_enquiry" };
    await s.callerSays("It's Jonathan Daniel, on 214 555 0123, I'd like a quote.");
    const [first] = await s.callTool("record_customer_request", lead);
    expect(first.response.next).toMatch(/after the last answer/i);
    await s.assistantTurn("Which company are you with?");
    await s.callerSays("No, it's Daniels with an S.");
    const [second] = await s.callTool("record_customer_request", { ...lead, caller_name: "Jonathan Daniels" });
    expect(second.response.next).toContain('"Daniels, D-A-N-I-E-L-S"');
    expect(second.response.next).not.toMatch(/after the last answer/i);
  });
});
