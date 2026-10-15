// ---------------------------------------------------------------------------
// A message the caller was promised must not die with the call.
//
// 2026-09-06. The caller asked for a callback. record_customer_request was
// refused by the spelling gate — they had given "Nithin Dodla" and never spelled
// it — and the assistant told them:
//
//   "I have your message... and I'll fix it so someone calls you back by the
//    next business day."
//
// customer_requests: 0 rows. postcall_verify: write_abandoned.
//
// ---------------------------------------------------------------------------
// Why this is a last-chance write and not a relaxed gate
// ---------------------------------------------------------------------------
//
// Three mechanisms already ask for the spelling: the nudge note (it fired, and
// was logged as sent), the gate's own refusal text ("ask the caller to spell
// their FULL name, then call this again"), and the prompt. On that call the
// model asked about the number, the message and the urgency instead, then
// claimed success. A refusal is a request and the model can decline it — LVX34's
// class, which has now resisted three rewordings.
//
// So the gate keeps refusing and the asking keeps happening. What changes is
// that the message stops being LOST when the asking does not work. The
// arguments are already stashed by the gate (services/tools.js pendingWrite);
// nothing was reading them at the end of a call.
//
// MESSAGES ONLY. Bookings keep the spelling-settled retry, because LVX77 —
// the same morning — had that retry write "Jane Doe", a name the caller never
// said, into an appointment. A booking's name identifies the row; a message's
// phone number does the work, and it comes from the call rather than the model.
// A callback from "Nathan Dasler" on the right number reaches the right person;
// a callback that does not exist reaches nobody.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Round A1 S3: the last-chance write's effect reaches the real messages pack,
// whose owner email is this module.
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
import * as notifications from "../services/notifications.js";

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
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: () => {},
    sendToolResponse: () => {},
    close: () => {},
  };
  return {
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

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

const MESSAGE_ARGS = {
  request_type: "callback",
  caller_name: "Nithin Dodla",
  message: "wants to talk about the strategy call",
};

/**
 * Boot a call whose message write is refused the way the spelling gate refuses
 * it: success false, and the arguments stashed for later.
 */
async function boot({ refuse = true } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const calls = [];

  const execute = vi.fn(async (fc, ctx) => {
    calls.push({ name: fc.name, args: fc.args, lastChance: ctx?.lastChance === true });
    // The gate refuses the FIRST attempt and stashes it — exactly what
    // services/tools.js does — and lets a last-chance attempt through.
    if (refuse && fc.name === "record_customer_request" && ctx?.lastChance !== true) {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "spell it first" } },
        stateEffects: {
          capabilityState: { messages: { pendingWrite: { name: fc.name, args: fc.args || {} } } },
        },
      };
    }
    return { functionResponse: { id: fc.id, name: fc.name, response: { success: true } } };
  });

  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect: live.connect, database: fakeDb(), env: {}, execute }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_msg", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    calls,
    async takeMessage() {
      live.push({
        toolCall: { functionCalls: [{ id: "m1", name: "record_customer_request", args: MESSAGE_ARGS }] },
      });
      await new Promise((r) => setTimeout(r, 25));
    },
    async hangUp() {
      ws.emit("close");
      await new Promise((r) => setTimeout(r, 25));
    },
  };
}

const c = () => getLatencyStats().turnTaking;

describe("a promised message survives the end of the call", () => {
  beforeEach(() => clearStats());

  it("re-issues a refused message write when the call ends", async () => {
    const s = await boot();
    await s.takeMessage();
    // One attempt so far, refused and stashed. Nothing has reached the database.
    expect(s.calls).toHaveLength(1);

    await s.hangUp();

    const retried = s.calls.filter((x) => x.name === "record_customer_request" && x.lastChance);
    expect(retried).toHaveLength(1);
    // The caller's own words, unchanged. This is the message they were promised.
    expect(retried[0].args.message).toBe(MESSAGE_ARGS.message);
    expect(c().message_saved_last_chance).toBe(1);
  });

  it("does nothing when the message already went through", async () => {
    // The common case, and it must stay silent: a second write would be a
    // duplicate callback request, which is its own defect.
    const s = await boot({ refuse: false });
    await s.takeMessage();
    await s.hangUp();

    expect(s.calls.filter((x) => x.name === "record_customer_request")).toHaveLength(1);
    expect(c().message_saved_last_chance ?? 0).toBe(0);
  });

  it("does nothing on a call with no message at all", async () => {
    const s = await boot();
    await s.hangUp();

    expect(s.calls).toHaveLength(0);
    expect(c().message_saved_last_chance ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round A1 S3 (owner, 2026-10-14): the re-issued write must actually WRITE.
//
// Every test above stubs `execute` with a bare success, so none of them could
// see that saveOutstandingMessage only read the function response. The real
// messages.execute does no write of its own -- it returns a capability effect
// and onEffect writes the row and emails the owner -- and finish() had already
// flushed its effects before the re-issued call came back. The counter said
// message_saved_last_chance; customer_requests had no row and nobody was told.
//
// So here the last-chance attempt runs the REAL pack.
// ---------------------------------------------------------------------------
async function bootRealPack() {
  const ws = new FakeSocket();
  const live = fakeLive();
  const rows = [];
  const database = {
    ...fakeDb(),
    createCustomerRequest: vi.fn(async (r) => {
      rows.push(r);
      return `req-${rows.length}`;
    }),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
    addTranscriptEntry: async () => {},
  };
  const verify = vi.fn(async () => ({ verdict: "ok" }));
  const execute = vi.fn(async (fc, ctx) => {
    if (fc.name === "record_customer_request" && ctx?.lastChance !== true) {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "spell it first" } },
        stateEffects: {
          capabilityState: { messages: { pendingWrite: { name: fc.name, args: fc.args || {} } } },
        },
      };
    }
    return messages.execute(fc, ctx);
  });

  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database,
      env: { POSTCALL_VERIFY: "count" },
      execute,
      verify,
      recover: vi.fn(async () => ({ ran: false, booked: false })),
      judge: vi.fn(async () => ({ ran: true, agreedAction: "none" })),
    }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_msg_real", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  return {
    rows,
    verify,
    async takeMessage() {
      live.push({
        toolCall: { functionCalls: [{ id: "m1", name: "record_customer_request", args: MESSAGE_ARGS }] },
      });
      await new Promise((r) => setTimeout(r, 25));
    },
    async hangUp() {
      ws.emit("close");
      await new Promise((r) => setTimeout(r, 60));
    },
  };
}

describe("the last-chance message reaches the database and the owner (S3)", () => {
  beforeEach(() => {
    clearStats();
    vi.mocked(notifications.notifyCustomerRequest).mockClear();
  });

  it("writes the row and emails the owner once", async () => {
    const s = await bootRealPack();
    await s.takeMessage();
    expect(s.rows).toHaveLength(0);

    await s.hangUp();

    expect(c().message_saved_last_chance).toBe(1);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ requestType: "callback", callerName: "Nithin Dodla", message: MESSAGE_ARGS.message });
    expect(notifications.notifyCustomerRequest).toHaveBeenCalledTimes(1);
  });

  it("the post-call read counts it as recorded, not abandoned", async () => {
    const s = await bootRealPack();
    await s.takeMessage();
    await s.hangUp();
    await vi.waitFor(() => expect(s.verify).toHaveBeenCalled());

    const args = s.verify.mock.calls[0][0];
    expect(args.messagesRecorded).toBe(1);
    // An abandoned message write is what files "A caller may need a call
    // back" -- a false alarm about a message that was in fact passed on.
    expect(args.abandoned).not.toContain("record_customer_request");
  });
});
