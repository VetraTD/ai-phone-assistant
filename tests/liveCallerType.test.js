/**
 * Caller-experience Task 2: the model reports WHO is calling and whether the
 * reason was already given; both land in Live call state, reach the tool
 * context, and the call summary carries an `intake` counter block.
 *
 * Both ends of the tool-context wire are real here (turnState in the Live
 * session, the ctx copy in lib/voice/live/tools.js), as in
 * tests/liveToolContext.test.js.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => true),
  notifyUnconfirmedClaim: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

// Wraps the REAL guarded executor and records the ctx each call received, so the
// Live session's own turnState() -> ctx copy can be asserted end to end.
const seenCtx = vi.hoisted(() => []);
vi.mock("../services/tools.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeToolCallGuarded: async (fc, ctx, ...rest) => {
      seenCtx.push({ name: fc.name, ctx });
      return actual.executeToolCallGuarded(fc, ctx, ...rest);
    },
  };
});

import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { buildAllDeclarations } from "../services/gemini.js";
import { createToolRunner } from "../lib/voice/live/tools.js";
import { INTAKE_CALLER_TYPES } from "../lib/capabilities/intakeSettings.js";
import { isRealCallerNumber } from "../lib/inboundGuards.js";
import { asksIn } from "../lib/voice/askLedger.js";

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

const intentDecl = (decls) => decls.find((d) => d.name === "set_call_intent");

describe("set_call_intent declaration", () => {
  it("inbound gains caller_type and reason_given, neither required", () => {
    const d = intentDecl(buildAllDeclarations(CONFIG, {}));
    expect(d.parameters.properties.caller_type.enum).toEqual(INTAKE_CALLER_TYPES);
    expect(d.parameters.properties.reason_given.type).toBe("boolean");
    expect(d.parameters.required).toEqual(["intent"]);
    // Described, never a sentence for the model to recite.
    expect(d.parameters.properties.caller_type.description).not.toMatch(/"[^"]+\?"/);
    expect(d.description).not.toMatch(/"[^"]+\?"/);
  });

  it("outbound is unchanged", () => {
    const d = intentDecl(buildAllDeclarations(CONFIG, { outboundCall: { contact: { firstName: "Sam" } } }));
    expect(d.parameters.properties).toEqual({
      intent: { type: "string", enum: d.parameters.properties.intent.enum, description: "The caller's primary intent" },
    });
    expect(d.parameters.required).toEqual(["intent"]);
    expect(d.description).toBe(
      "Bookkeeping only: record what this call turned out to be about, once it is clear. " +
        "Never mention it, and never let it change what you say next."
    );
  });
});

/** The call-state reducer runs at the end of the turn that made the call. */
async function reportIntent(s, args) {
  await s.callTool("set_call_intent", args);
  // The reducer skips a turn with no words at all, so the turn carries some.
  await s.assistantTurn("Got it.");
}

describe("state and the intake block", () => {
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

  async function record(run) {
    const lines = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string") lines.push(...chunk.split("\n"));
      return true;
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const summaries = lines.filter((l) => l.includes('"event":"live_call_summary"')).map((l) => JSON.parse(l));
    expect(summaries).toHaveLength(1);
    return summaries[0];
  }

  function storeDb() {
    const rows = [];
    let tenant = null;
    return {
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
        rows.push({ id: `req-${rows.length + 1}`, ...r });
        return `req-${rows.length}`;
      }),
      listCallCustomerRequests: vi.fn(async () => []),
      updateCustomerRequest: vi.fn(async () => null),
    };
  }

  it("stores the type and the reason flag; the latest valid report wins; reason is sticky", async () => {
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_1" });
      expect(s.ws.liveState.callerType).toBeNull();
      expect(s.ws.liveState.reasonGiven).toBe(false);
      await s.callerSays("Hi, it's about my sister's party.");
      await reportIntent(s, { intent: "take_message", caller_type: "personal", reason_given: true });
      expect(s.ws.liveState.callerType).toBe("personal");
      expect(s.ws.liveState.reasonGiven).toBe(true);
      // The same type again is not a change.
      await reportIntent(s, { intent: "take_message", caller_type: "personal" });
      await reportIntent(s, { intent: "take_message", caller_type: "new_enquiry", reason_given: false });
      expect(s.ws.liveState.callerType).toBe("new_enquiry");
      expect(s.ws.liveState.reasonGiven).toBe(true);
      await s.hangUp();
    });
    expect(summary.intake.caller_type).toBe("new_enquiry");
    expect(summary.intake.caller_type_changes).toBe(1);
  });

  it("the Live session's own tool context carries them (producer and copy both real)", async () => {
    await record(async () => {
      seenCtx.length = 0;
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_ctx", callerPhone: "+15551234567" });
      await s.callerSays("About my sister's party.");
      await reportIntent(s, { intent: "take_message", caller_type: "personal", reason_given: true });
      await s.callTool("record_customer_request", MESSAGE);
      const last = seenCtx.filter((c) => c.name === "record_customer_request").pop();
      expect(last.ctx.callerType).toBe("personal");
      expect(last.ctx.callerNumberReal).toBe(true);
      await s.hangUp();
    });
  });

  it("a caller with no number reads as not real on the Live context", async () => {
    await record(async () => {
      seenCtx.length = 0;
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_nonum", callerPhone: "" });
      await s.callTool("record_customer_request", MESSAGE);
      const last = seenCtx.filter((c) => c.name === "record_customer_request").pop();
      expect(last.ctx.callerNumberReal).toBe(false);
      await s.hangUp();
    });
  });

  it("an invalid caller_type is ignored", async () => {
    await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_2" });
      await reportIntent(s, { intent: "take_message", caller_type: "supplier" });
      await reportIntent(s, { intent: "take_message", caller_type: "martian" });
      expect(s.ws.liveState.callerType).toBe("supplier");
      await s.hangUp();
    });
  });

  it("initialises every intake field", async () => {
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_3" });
      await s.hangUp();
    });
    expect(summary.intake).toEqual({
      caller_type: null,
      caller_type_changes: 0,
      questions_asked: 0,
      first_words_to_save_ms: null,
      reason_reasked: 0,
      reason_asked_after_save: 0,
      number_asked_with_caller_id: 0,
      spell_asks: 0,
      ended_before_save: false,
      goodbye_turns: 0,
      goodbye_named_business: 0,
      readbacks: 0,
      readbacks_without_check: 0,
      tier: "standard",
    });
  });

  it("questions_asked counts the asks across assistant turns", async () => {
    const turns = ["Can I get your name?", "And what's the best number to reach you on?"];
    const expected = turns.reduce((n, t) => n + asksIn(t).length, 0);
    expect(expected).toBeGreaterThan(0);
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_4" });
      for (const t of turns) {
        await s.assistantTurn(t);
        await s.callerSays("Sure.");
      }
      await s.hangUp();
    });
    expect(summary.intake.questions_asked).toBe(expected);
  });

  it("first_words_to_save_ms is a number after a successful record_customer_request", async () => {
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, database: storeDb(), callSid: "CA_ct_5" });
      await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
      await s.assistantSays("So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice, passing that on now.");
      const [res] = await s.callTool("record_customer_request", MESSAGE);
      expect(res?.response?.success).toBe(true);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(typeof summary.intake.first_words_to_save_ms).toBe("number");
    expect(summary.intake.ended_before_save).toBe(false);
  });

  it("ended_before_save: a lead who spoke and never got a message saved", async () => {
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_6" });
      await s.callerSays("I want a quote for a boiler.");
      await reportIntent(s, { intent: "take_message", caller_type: "new_enquiry", reason_given: true });
      await s.hangUp();
    });
    expect(summary.intake.ended_before_save).toBe(true);
    expect(summary.intake.first_words_to_save_ms).toBeNull();
  });

  it("ended_before_save stays false for a supplier", async () => {
    const summary = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ct_7" });
      await s.callerSays("We sell phone systems.");
      await reportIntent(s, { intent: "take_message", caller_type: "supplier" });
      await s.hangUp();
    });
    expect(summary.intake.ended_before_save).toBe(false);
  });
});

describe("the tool context carries the intake fields (both ends real)", () => {
  async function ctxFor(turnState) {
    const execute = vi.fn(async (fc) => ({
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
    }));
    const runner = createToolRunner({
      config: CONFIG,
      extras: { integrations: [], businessId: "b1", callerPhone: "+14699338887", callId: "c1" },
      execute,
      turnState,
    });
    await runner.handleToolCall({
      functionCalls: [{ id: "1", name: "record_customer_request", args: { request_type: "message" } }],
    });
    return execute.mock.calls[0][1];
  }

  it("copies callerType and callerNumberReal", async () => {
    const ctx = await ctxFor(() => ({
      step: "gather_details",
      callerType: "personal",
      callerNumberReal: true,
    }));
    expect(ctx.callerType).toBe("personal");
    // Nothing reads a reasonGiven on the tool context (M5): it is not copied.
    expect("reasonGiven" in ctx).toBe(false);
    expect(ctx.callerNumberReal).toBe(true);
  });

  it("defaults: null, false", async () => {
    const ctx = await ctxFor(() => ({ step: "gather_details" }));
    expect(ctx.callerType).toBeNull();
    expect(ctx.callerNumberReal).toBe(false);
  });

  it("an empty caller number is not real, a real one is", () => {
    expect(isRealCallerNumber("")).toBe(false);
    expect(isRealCallerNumber("+15551234567")).toBe(true);
  });
});
