// ---------------------------------------------------------------------------
// LVX192 fix 2: the after-save note. A caller saves a message, keeps talking,
// and hangs up: the extra words go onto the SAME row as one detail before the
// owner email is claimed. Same harness as tests/messageAfterCall.test.js, with
// the db stub listing the rows it created so the merge path is real.
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
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";

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
  realTools = false,
  refuseOwed = false,
} = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const calls = [];
  const rows = [];
  const updates = [];
  let saveCalls = 0;
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
    listCallCustomerRequests: vi.fn(async () =>
      rows.map((r, i) => ({ id: `req-${i + 1}`, caller_name: r.callerName, message: r.message, details: r.details })).reverse()
    ),
    updateCustomerRequest: vi.fn(async (u) => {
      updates.push(u);
      return u.id;
    }),
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
      if (refuseOwed && fc.id === "after_call_record_customer_request") {
        return {
          functionResponse: {
            id: fc.id,
            name: fc.name,
            response: { success: false, gated: true, message: `held: ${fc.args?.message}` },
          },
          stateEffects: { writeGateRefusal: typeof refuseOwed === "string" ? refuseOwed : "consent" },
        };
      }
      if (ctx?.lastChance !== true) saveCalls += 1;
      if (refuseFirst && ctx?.lastChance !== true && saveCalls === (refuseFirst === true ? 1 : refuseFirst)) {
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
      ...(realTools ? { capabilityDeps: makeFakeDeps({}).deps } : { execute }),
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
    updates,
    database,
    ws,
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
    /** One finished assistant turn (what the receptionist said to the caller). */
    async assistantTurn(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
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
const INTENT = (extra = {}) => ({ intent: "take_message", ...extra });
const SAVE = { request_type: "message", caller_name: "Jon Smith", callback_number: "+447700900123", message: "about the invoice" };
const NOTE_ID = "after_save_note_record_customer_request";
const LABEL = "Said after the last save (unchecked transcript)";

/** Intent, then a successful save, then the receptionist's follow-up question. */
async function savedCall(s, question = "How will you be paying?") {
  await s.tool("set_call_intent", INTENT({ caller_type: "existing_customer", reason_given: true }));
  await s.callerTurn("It is about the invoice, I am Jon Smith.");
  await s.tool("record_customer_request", SAVE);
  await s.assistantTurn(question);
}
const noteCalls = (s) => s.calls.filter((x) => x.id === NOTE_ID);

describe("the after-save note", () => {
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

  it("hang-up after a payment answer: the same row gets one detail", async () => {
    const s = await boot();
    await savedCall(s);
    await s.callerTurn("By card, a Visa.");
    await s.hangUp();

    const n = noteCalls(s);
    expect(n).toHaveLength(1);
    expect(n[0].lastChance).toBe(true);
    expect(n[0].args).toMatchObject(SAVE);
    expect(n[0].args.details).toHaveLength(1);
    expect(n[0].args.details[0].label).toBe(LABEL);
    expect(n[0].args.details[0].answer).toBe('"How will you be paying?" — By card, a Visa.');
    // One row: the first save created it, the note merged into it.
    expect(s.rows).toHaveLength(1);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0].id).toBe("req-1");
    expect(JSON.stringify(s.updates[0].details)).toContain("card");
    expect(JSON.stringify(s.updates[0].details)).toContain(LABEL);
    expect(c().after_save_note_saved).toBe(1);
    expect(c().after_save_note_failed ?? 0).toBe(0);
  });

  it("Review Focus 4: words only in the in-flight turn at the hang-up are included", async () => {
    const s = await boot();
    await savedCall(s);
    await s.callerSays("by card, and we are four passengers");
    await s.hangUp();
    const n = noteCalls(s);
    expect(n).toHaveLength(1);
    expect(n[0].args.details[0].answer).toContain("four passengers");
  });

  it("words said during the save's own turn are covered by it: no note", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "existing_customer", reason_given: true }));
    await s.callerSays("it is about the invoice, I am Jon Smith");
    await s.tool("record_customer_request", SAVE);
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
  });

  it("the write is dispatched before any awaited verify step", async () => {
    const s = await boot({ env: { POSTCALL_VERIFY: "count" } });
    await savedCall(s);
    await s.callerTurn("By card.");
    await s.hangUp();
    await vi.waitFor(() => expect(s.verify).toHaveBeenCalled());
    expect(s.updates).toHaveLength(1);
    const upd = s.database.updateCustomerRequest.mock.invocationCallOrder[0];
    expect(upd).toBeLessThan(s.verify.mock.invocationCallOrder[0]);
  });

  it("the chain runs straight from finish() to the write", async () => {
    const s = await boot();
    await savedCall(s);
    await s.callerTurn("By card.");
    const t0 = Date.now();
    s.ws.emit("close");
    await vi.waitFor(() => expect(s.updates).toHaveLength(1));
    const ms = Date.now() - t0;
    console.info(`after-save chain: finish() to update call took ${ms} ms`);
    expect(ms).toBeLessThan(500);
  });

  it("nothing informative after the save (a closer): no note", async () => {
    const s = await boot();
    await savedCall(s, "Is there anything else I can help with?");
    await s.callerTurn("No, that's all, thanks.");
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
    expect(c().after_save_note_saved ?? 0).toBe(0);
  });

  it("no save happened: the owed path's job, not the note's", async () => {
    const s = await boot();
    await s.tool("set_call_intent", INTENT({ caller_type: "new_enquiry", reason_given: true }));
    await s.callerTurn("I want a website built for my plumbing business.");
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
    expect(s.owedCalls()).toHaveLength(1);
  });

  it("the owed path wrote: no note", async () => {
    // Pending stash: first save refused, last chance re-issues it; no owed write.
    const s = await boot({ refuseFirst: true });
    await s.tool("set_call_intent", INTENT({ caller_type: "existing_customer", reason_given: true }));
    await s.callerTurn("It is about the invoice.");
    await s.tool("record_customer_request", SAVE);
    await s.callerTurn("By card.");
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
  });

  it("a stashed save re-issued by the last chance does not hide words said after the last real save", async () => {
    // Save 1 lands; save 2 is refused and stashed; the caller then answers a
    // question; the hang-up re-issues the stash, which moves savedThroughTurn.
    const s = await boot({ refuseFirst: 2 });
    await savedCall(s);
    await s.tool("record_customer_request", { ...SAVE, message: "about the invoice, 3 people" });
    await s.assistantTurn("And how will you be paying?");
    await s.callerTurn("By card, a Visa.");
    await s.hangUp();
    expect(s.calls.filter((x) => x.name === "record_customer_request" && x.lastChance && x.id !== NOTE_ID)).toHaveLength(1);
    const n = noteCalls(s);
    expect(n).toHaveLength(1);
    expect(n[0].args.details[0].answer).toContain("By card, a Visa.");
    expect(c().after_save_note_saved).toBe(1);
  });

  it("healthcare tier: no note", async () => {
    const s = await boot({ config: { ...CONFIG, complianceTier: "hipaa" } });
    await savedCall(s);
    await s.callerTurn("By card.");
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
  });

  it("a hipaa deployment: no note", async () => {
    const s = await boot({ env: { DEPLOYMENT_MODE: "hipaa" } });
    await savedCall(s);
    await s.callerTurn("By card.");
    await s.hangUp();
    expect(noteCalls(s)).toHaveLength(0);
  });

  it("a refused note write counts as failed and logs a closed outcome", async () => {
    const s = await boot({ refuseOwed: false });
    s.database.updateCustomerRequest.mockImplementation(async () => null);
    await savedCall(s);
    await s.callerTurn("By card.");
    await s.hangUp();
    // The update found no row to merge, so the pack created a second one: the
    // write still succeeded. Counter is saved, never both.
    expect((c().after_save_note_saved ?? 0) + (c().after_save_note_failed ?? 0)).toBe(1);
  });

  it("logs the outcome only: no caller words in any line", async () => {
    const s = await boot();
    await savedCall(s);
    await s.callerTurn("By card, a Visa with a zebra sticker.");
    await s.hangUp();
    const mine = lines.filter((l) => l.includes("live_after_save_note"));
    expect(mine).toHaveLength(1);
    const parsed = JSON.parse(mine[0]);
    expect(parsed).toMatchObject({ event: "live_after_save_note", callSid: "CA_after", ok: true, turns: 1 });
    expect(typeof parsed.ms).toBe("number");
    expect(Object.keys(parsed).filter((k) => !["event", "callSid", "ok", "turns", "ms", "ts", "level", "time", "timestamp", "message"].includes(k))).toEqual([]);
    for (const l of lines) {
      expect(l).not.toContain("zebra");
      expect(l).not.toContain("Visa");
    }
  });
});
