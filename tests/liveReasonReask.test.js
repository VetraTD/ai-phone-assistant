/**
 * Caller-experience Task 5: a reason the caller already gave is never asked
 * again (cut with the repeat cut's own mechanism), and a number ask on a call
 * that came with a real caller ID is counted, never cut.
 *
 * The real Live runner and the real ask ledger. Every line is invented.
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
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";
import { bootOutboundCall } from "./helpers/outboundBoot.js";

const CONFIG = {
  businessName: "Brightwork",
  greeting: "Thanks for calling Brightwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};

const ASK = "What is the reason for your call today?";
const MESSAGE = {
  request_type: "message",
  caller_name: "Jon",
  callback_number: "214 555 0123",
  message: "about the invoice",
};

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

/** A booted call past the greeting: one answered exchange, so the next reply is judged. */
async function pastGreeting(opts = {}) {
  const s = await bootLive({ config: CONFIG, callSid: "CA_reason", ...opts });
  const cleared = [];
  const real = s.ws.liveAudioOut.clear.bind(s.ws.liveAudioOut);
  s.ws.liveAudioOut.clear = (o) => {
    cleared.push(o || {});
    return real(o);
  };
  await s.assistantTurn("Thanks for calling Brightwork.");
  await s.callerSays("Hi, it's about my sister's party.");
  await s.assistantTurn("Lovely.");
  return { s, cleared };
}

const cuts = () => getLatencyStats().turnTaking.live_reason_reask_cut;

describe("a reason the caller gave is never asked again", () => {
  it("reported, then asked in the SAME model turn: cut, counted once", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting();
      cleared = x.cleared;
      await x.s.callerSays("It's about the invoice.");
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      await x.s.assistantSays(ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].fadeMs).toBeGreaterThan(0);
    expect(cuts()).toBe(1);
    expect(summary.intake.reason_reasked).toBe(1);
    expect(summary.intake.reason_reask_cut).toBe(1);
  });

  it("reported in a wordless turn, asked in the NEXT turn: cut", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting();
      cleared = x.cleared;
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      // The turn carries no words at all, so the report stays pending.
      await x.s.turnEnds();
      expect(cleared).toHaveLength(0);
      await x.s.assistantSays(ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(1);
    expect(summary.intake.reason_reasked).toBe(1);
    expect(summary.intake.reason_reask_cut).toBe(1);
  });

  it("an ask spoken BEFORE the report in the same turn is counted but cannot be cut", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting();
      cleared = x.cleared;
      await x.s.callerSays("It's about the invoice.");
      await x.s.assistantSays(ASK);
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(summary.intake.reason_reasked).toBe(1);
    expect(summary.intake.reason_reask_cut).toBe(0);
  });

  it("reason not given: the same ask is not cut and not counted", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting();
      cleared = x.cleared;
      await x.s.callerSays("Hello again.");
      await x.s.assistantSays(ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(summary.intake.reason_reasked).toBe(0);
    expect(summary.intake.reason_reask_cut).toBe(0);
  });

  it("a per-answer confirmation of the reason is not a re-ask", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting({ config: { ...CONFIG, capabilities: { messages: { confirmStyle: "each" } } } });
      cleared = x.cleared;
      await x.s.callerSays("It's about Saturday.");
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      await x.s.assistantSays("So that's about Saturday, right?");
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(summary.intake.reason_reasked).toBe(0);
  });

  it("after a message is saved, the same ask is about a new request: neither cut nor counted", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting({ database: storeDb() });
      cleared = x.cleared;
      await x.s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      await x.s.assistantSays("So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice, passing that on now.");
      const [res] = await x.s.callTool("record_customer_request", MESSAGE);
      expect(res?.response?.success).toBe(true);
      await x.s.turnEnds();
      await x.s.callerSays("One more thing.");
      await x.s.assistantSays(ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(summary.intake.reason_reasked).toBe(0);
    expect(summary.intake.reason_reask_cut).toBe(0);
  });
});

describe("a number ask with a real caller ID", () => {
  const NUMBER_ASK = "And what's the best number to reach you on?";

  it("is counted and never cut", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting({ callerPhone: "+15551234567" });
      cleared = x.cleared;
      await x.s.callerSays("Could you call me back?");
      await x.s.assistantSays(NUMBER_ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(summary.intake.number_asked_with_caller_id).toBe(1);
  });

  it("with a withheld number is not counted", async () => {
    const summary = await record(async () => {
      const x = await pastGreeting({ callerPhone: "" });
      await x.s.callerSays("Could you call me back?");
      await x.s.assistantSays(NUMBER_ASK);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(summary.intake.number_asked_with_caller_id).toBe(0);
  });
});

describe("the repeat ledger and a message save (P22 on the ledger path)", () => {
  const ASK2 = "What is the call regarding?";
  /** The reason asked and answered twice, so a third ask is at the ledger's cap. */
  async function askedTwice(x) {
    await x.s.assistantTurn(ASK2);
    await x.s.callerSays("It's about the invoice.");
    await x.s.assistantTurn(ASK2);
    await x.s.callerSays("The invoice, like I said.");
  }

  it("before any save, a third ask is still cut by the ledger", async () => {
    let cleared;
    await record(async () => {
      const x = await pastGreeting();
      cleared = x.cleared;
      await askedTwice(x);
      await x.s.assistantSays(ASK2);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(1);
    expect(getLatencyStats().turnTaking.live_ask_repeat_cut).toBe(1);
  });

  it("after a message save the same ask is not cut by the ledger, not counted", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await pastGreeting({ database: storeDb() });
      cleared = x.cleared;
      await askedTwice(x);
      await x.s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
      await x.s.assistantSays("So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice, passing that on now.");
      const [res] = await x.s.callTool("record_customer_request", MESSAGE);
      expect(res?.response?.success).toBe(true);
      await x.s.turnEnds();
      await x.s.callerSays("One more thing.");
      await x.s.assistantSays(ASK2);
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(getLatencyStats().turnTaking.live_ask_repeat_cut ?? 0).toBe(0);
    expect(cuts() ?? 0).toBe(0);
    expect(summary.intake.reason_reasked).toBe(0);
  });
});

describe("outbound is unchanged", () => {
  it("a reported reason is never cut or counted, and a number ask is not counted", async () => {
    let cleared;
    const summary = await record(async () => {
      const x = await bootOutboundCall(CONFIG);
      cleared = x.cleared;
      await x.s.callerSays("It's about the invoice.");
      await x.s.callTool("set_call_intent", { intent: "take_message", reason_given: true });
      await x.s.assistantSays(ASK);
      await x.s.turnEnds();
      await x.s.callerSays("Sure.");
      await x.s.assistantSays("And what's the best number to reach you on?");
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(cuts() ?? 0).toBe(0);
    expect(summary.intake.reason_reasked).toBe(0);
    expect(summary.intake.reason_reask_cut).toBe(0);
    expect(summary.intake.number_asked_with_caller_id).toBe(0);
  });

  // What b96fe90 did, checked against its asksIn: "the reason for your call" is
  // the q: key "q:reason call" (cut at the cap, as any q: need), and the
  // "today" phrasing is skipped by the scheduling filter (never an ask).
  it("a reason-style ask is cut at the ledger cap exactly as before (its q: key)", async () => {
    let cleared;
    await record(async () => {
      const x = await bootOutboundCall(CONFIG);
      cleared = x.cleared;
      for (let i = 0; i < 2; i += 1) {
        await x.s.assistantTurn("What is the reason for your call?");
        await x.s.callerSays("It's about the invoice.");
      }
      await x.s.assistantSays("What is the reason for your call?");
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(1);
    expect(getLatencyStats().turnTaking.live_ask_repeat_cut).toBe(1);
    expect(cuts() ?? 0).toBe(0);
  });

  it("the 'today' phrasing is never cut, as before", async () => {
    let cleared;
    await record(async () => {
      const x = await bootOutboundCall(CONFIG);
      cleared = x.cleared;
      for (let i = 0; i < 3; i += 1) {
        await x.s.assistantTurn("What is the reason for your call today?");
        await x.s.callerSays("It's about the invoice.");
      }
      await x.s.assistantSays("What is the reason for your call today?");
      await x.s.turnEnds();
      await x.s.hangUp();
    });
    expect(cleared).toHaveLength(0);
    expect(getLatencyStats().turnTaking.live_ask_repeat_cut ?? 0).toBe(0);
  });
});
