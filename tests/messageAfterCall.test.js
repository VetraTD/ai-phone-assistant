// ---------------------------------------------------------------------------
// The after-call message: a message was owed, none was saved, so the call's end
// writes ONE ordinary message from the caller's own words.
//
// Finish-level, like tests/messageLastChance.test.js: a real Live session, the
// real messages pack for the write, fake vendors. Only `execute` is a seam, and
// it records what the write was called with (lastChance included).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => {}),
  notifyUnconfirmedClaim: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import messages from "../capabilities/messages.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  let onmessage = null;
  const sent = { toolResponses: [] };
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: () => {},
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessName: "Digile Media",
  mainPhone: "+441372656055",
  timezone: "Europe/London",
  allowedTasks: ["take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
};

const REAL_NUMBER = "+447700900123";
const WORDS_1 = "Hi, I want a website built for my plumbing business.";
const WORDS_2 = "It needs online booking and a gallery of our past jobs.";

/**
 * @param {object} [o]
 * @param {object} [o.config]
 * @param {string|null} [o.callerPhone]
 * @param {boolean} [o.refuseFirst] - the first record_customer_request is refused and stashed (the spelling gate)
 * @param {boolean} [o.failLastChance] - the last-chance write itself fails
 * @param {object} [o.env]
 * @param {boolean} [o.outbound]
 */
async function boot({
  config = CONFIG,
  callerPhone = REAL_NUMBER,
  refuseFirst = false,
  failLastChance = false,
  env = {},
  owedDelayMs = 0,
} = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const calls = [];
  const rows = [];
  const database = {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: config.businessName })),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    addTranscriptEntry: async () => {},
    createCustomerRequest: vi.fn(async (r) => {
      rows.push(r);
      return `req-${rows.length}`;
    }),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
  };
  const verify = vi.fn(async () => ({ verdict: "ok" }));

  const execute = vi.fn(async (fc, ctx) => {
    calls.push({ name: fc.name, args: fc.args, lastChance: ctx?.lastChance === true, id: fc.id });
    if (fc.name === "set_call_intent") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { intentArgs: fc.args },
      };
    }
    if (fc.name === "end_call") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: { endCallArgs: {} },
      };
    }
    if (fc.name === "record_customer_request") {
      if (owedDelayMs && fc.id === "after_call_record_customer_request") {
        await new Promise((r) => setTimeout(r, owedDelayMs));
      }
      if (refuseFirst && ctx?.lastChance !== true) {
        return {
          functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "spell it first" } },
          stateEffects: {
            capabilityState: { messages: { pendingWrite: { name: fc.name, args: fc.args || {} } } },
          },
        };
      }
      if (failLastChance && ctx?.lastChance === true && !String(fc.id).startsWith("after_call")) {
        return { functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "no" } } };
      }
      return messages.execute(fc, ctx);
    }
    return { functionResponse: { id: fc.id, name: fc.name, response: { success: true } } };
  });

  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database,
      env,
      execute,
      verify,
      recover: vi.fn(async () => ({ ran: false, booked: false })),
      judge: vi.fn(async () => ({ ran: true, agreedAction: "none" })),
    }
  );
  ws.deliver({
    event: "start",
    start: {
      callSid: "CA_after",
      streamSid: "MZ1",
      customParameters: {
        businessPhone: config.mainPhone,
        ...(callerPhone ? { callerPhone } : {}),
      },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  const settle = () => new Promise((r) => setTimeout(r, 25));

  return {
    calls,
    rows,
    verify,
    live,
    owedCalls: () => calls.filter((x) => x.id === "after_call_record_customer_request"),
    writes: () => calls.filter((x) => x.name === "record_customer_request"),
    /** One finished caller turn. */
    async callerTurn(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    /** Words the caller said that no turn close has filed yet. */
    async callerSays(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },
    async tool(name, args = {}) {
      live.push({ toolCall: { functionCalls: [{ id: `t_${name}`, name, args }] } });
      await settle();
      await settle();
    },
    async hangUp() {
      ws.emit("close");
      await new Promise((r) => setTimeout(r, 80));
    },
  };
}

const c = () => getLatencyStats().turnTaking;
const INTENT = (extra = {}) => ({ intent: "general_question", ...extra });

describe("the after-call message", () => {
  let lines;
  let spy;
  beforeEach(() => {
    clearStats();
    lines = [];
    spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string") lines.push(...chunk.split("\n"));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  it("a lead hangs up mid-intake: one normal message from their words", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.callerTurn(WORDS_2);
    await s.hangUp();

    const owed = s.owedCalls();
    expect(owed).toHaveLength(1);
    expect(owed[0].name).toBe("record_customer_request");
    expect(owed[0].lastChance).toBe(true);
    expect(owed[0].args.caller_type).toBe("new_enquiry");
    expect(owed[0].args.request_type).toBe("message");
    expect(owed[0].args.message).toContain(WORDS_1);
    expect(owed[0].args.message).toContain(WORDS_2);
    expect(owed[0].args.caller_name).toBeUndefined();
    expect(owed[0].args.callback_number).toBeUndefined();
    expect(c().message_saved_after_call).toBe(1);
    // The messages effect ran through onEffect: one row, the real caller ID, pending for the one email.
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ callbackNumber: REAL_NUMBER, ownerNoticePending: true });
    expect(s.rows[0].message).toContain(WORDS_1);
    expect(s.rows[0].message).not.toContain("withheld");
  });

  it("the words of the call in flight at the hang-up are in the message", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.callerSays("Can you also do the logo");
    await s.hangUp();
    const owed = s.owedCalls();
    expect(owed).toHaveLength(1);
    expect(owed[0].args.message).toContain(WORDS_1);
    expect(owed[0].args.message).toContain("Can you also do the logo");
  });

  it("the receptionist ends the call with a message owed: the same single write, end_call untouched", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "existing_customer", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("end_call");
    // end_call answered exactly as it always does: no refusal, nothing extra for the model.
    const endReply = s.live.sent.toolResponses
      .flatMap((m) => m.functionResponses || [])
      .filter((r) => r.name === "end_call");
    expect(endReply).toEqual([{ id: "t_end_call", name: "end_call", response: { success: true } }]);
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(1);
    expect(s.writes()).toHaveLength(1);
    expect(c().message_saved_after_call).toBe(1);
  });

  it("a withheld number: the text says so and no number is stored", async () => {
    const s = await boot({ callerPhone: null });
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.hangUp();
    expect(s.owedCalls()[0].args.message).toContain("Their number was withheld or did not come through.");
    expect(s.rows[0].callbackNumber).toBeNull();
  });

  it("take_message reported with no reason given writes; callback_request makes it a callback", async () => {
    const s = await boot();
    await s.tool("set_call_intent", { intent: "callback_request" });
    await s.callerTurn(WORDS_1);
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(1);
    expect(s.owedCalls()[0].args.request_type).toBe("callback");
  });

  it("a save already made: nothing", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("record_customer_request", { request_type: "message", message: "wants a website" });
    await s.hangUp();
    expect(s.writes()).toHaveLength(1);
    expect(s.owedCalls()).toHaveLength(0);
    expect(c().message_saved_after_call ?? 0).toBe(0);
  });

  it("a quote request already saved counts as a save: nothing", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("record_quote_request", { description: "a website" });
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(0);
  });

  it("a refused write is stashed: only the last-chance write, never a second row", async () => {
    const s = await boot({ refuseFirst: true });
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("record_customer_request", {
      request_type: "message",
      caller_name: "Sam Rivers",
      message: "wants a website",
    });
    await s.hangUp();
    const lastChance = s.writes().filter((x) => x.lastChance);
    expect(lastChance).toHaveLength(1);
    expect(lastChance[0].args.message).toBe("wants a website");
    expect(s.owedCalls()).toHaveLength(0);
    expect(s.rows).toHaveLength(1);
    expect(c().message_saved_last_chance).toBe(1);
  });

  it("when the last-chance write itself fails, the owed write then runs", async () => {
    const s = await boot({ refuseFirst: true, failLastChance: true });
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("record_customer_request", {
      request_type: "message",
      caller_name: "Sam Rivers",
      message: "wants a website",
    });
    await s.hangUp();
    expect(c().message_lost_at_close).toBe(1);
    expect(s.owedCalls()).toHaveLength(1);
    expect(c().message_saved_after_call).toBe(1);
    expect(s.rows).toHaveLength(1);
  });

  it("nothing for a wrong number, a decline, a silent caller", async () => {
    const wrong = await boot();
    await wrong.tool("set_call_intent", INTENT({ caller_type: "wrong_number", reason_given: true }));
    await wrong.callerTurn("Sorry, I think I have the wrong number.");
    await wrong.hangUp();
    expect(wrong.owedCalls()).toHaveLength(0);

    const declined = await boot();
    await declined.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await declined.callerTurn(WORDS_1);
    await declined.callerTurn("Never mind. I'm done.");
    await declined.hangUp();
    expect(declined.owedCalls()).toHaveLength(0);

    const silent = await boot();
    await silent.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await silent.hangUp();
    expect(silent.owedCalls()).toHaveLength(0);

    const noise = await boot();
    await noise.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await noise.callerTurn("...");
    await noise.hangUp();
    expect(noise.owedCalls()).toHaveLength(0);
  });

  it("a closing 'no, that's all' is not a decline", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.callerTurn("No, that's all, thanks.");
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(1);
  });

  it("type other with only a reason: nothing; seller with no business seller rule: nothing", async () => {
    const other = await boot();
    await other.tool("set_call_intent", INTENT({ caller_type: "other", reason_given: true }));
    await other.callerTurn(WORDS_1);
    await other.hangUp();
    expect(other.owedCalls()).toHaveLength(0);

    const seller = await boot();
    await seller.tool("set_call_intent", { intent: "take_message", caller_type: "sales_pitch", reason_given: true });
    await seller.callerTurn("We offer discounted printer toner for offices.");
    await seller.hangUp();
    expect(seller.owedCalls()).toHaveLength(0);
  });

  it("a seller WITH the business's own seller rule and take_message reported: written", async () => {
    const config = {
      ...CONFIG,
      customInstructions: "Sales calls and cold callers: take a message and do not transfer them.",
    };
    const s = await boot({ config });
    await s.tool("set_call_intent", { intent: "take_message", caller_type: "sales_pitch", reason_given: true });
    await s.callerTurn("We offer discounted printer toner for offices.");
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(1);
    expect(s.owedCalls()[0].args.caller_type).toBe("sales_pitch");
  });

  it("healthcare tier: nothing", async () => {
    const s = await boot({ config: { ...CONFIG, complianceTier: "hipaa" } });
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(0);
  });

  it("an appointment action tool attempted: nothing", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.tool("cancel_appointment", { client_name: "Sam Rivers" });
    await s.hangUp();
    expect(s.owedCalls()).toHaveLength(0);
  });

  it("verify reads the owed write as a recorded message", async () => {
    // A slow write: verify must wait for it, not race past it.
    const s = await boot({ env: { POSTCALL_VERIFY: "count" }, owedDelayMs: 150 });
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.hangUp();
    await vi.waitFor(() => expect(s.verify).toHaveBeenCalled());
    expect(s.verify.mock.calls[0][0].messagesRecorded).toBe(1);
  });

  it("logs the outcome only: no caller words in any line", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn(WORDS_1);
    await s.hangUp();
    const mine = lines.filter((l) => l.includes("live_message_after_call"));
    expect(mine).toHaveLength(1);
    const parsed = JSON.parse(mine[0]);
    expect(parsed).toMatchObject({ event: "live_message_after_call", callSid: "CA_after", ok: true });
    expect(Object.keys(parsed).filter((k) => !["event", "callSid", "ok", "ts", "level", "time", "timestamp", "message"].includes(k))).toEqual([]);
    for (const l of lines) {
      expect(l).not.toContain("plumbing");
      expect(l).not.toContain("gallery");
    }
  });
});
