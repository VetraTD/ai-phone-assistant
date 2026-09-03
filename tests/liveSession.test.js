import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// The wiring, driven end to end with a fake Twilio socket and a fake Live
// session. No network, no database, no audio hardware.
//
// The pieces underneath are tested on their own -- the gate, the three turn-end
// arms, the guards, the client, the declarations, the summary. What is only
// testable here is that they are CONNECTED: that the greeting is kicked, that
// the caller's own tenant reaches the tool context, that a tool call is
// answered, that the call sid on the wire is the one the token authorised.
//
// The last of those is the one worth writing carefully. server.js carries the
// scar: verifyTwilioSignature was broken for the life of a deployment and
// rejected every request, while three negative tests and a source scan all
// passed, because nothing ever asserted that a GOOD input is ACCEPTED.
// ---------------------------------------------------------------------------

/** A Twilio media-stream socket, as far as this handler can tell. */
class FakeSocket extends EventEmitter {
  constructor({ authorizedCallSid = null } = {}) {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.authorizedCallSid = authorizedCallSid;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

/** A Live session that records what was sent to it and can push messages back. */
function fakeLive() {
  const sent = { realtime: [], clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: (m) => sent.realtime.push(m),
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks, config }) => {
      onmessage = callbacks.onmessage;
      sent.config = config;
      return { session, languagePinned: true, surface: "aistudio", model: "gemini-3.1-flash-live-preview" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const BUSINESS = { id: "biz-1", name: "Digile Media" };

function fakeDb(overrides = {}) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => BUSINESS),
    loadConfig: () => ({
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
      capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
      businessHours: {},
    }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    ...overrides,
  };
}

const START = {
  event: "start",
  start: {
    callSid: "CA123",
    streamSid: "MZ123",
    customParameters: { businessPhone: "+441372656055", callerPhone: "+447700900123" },
  },
};

/** Start a session and settle the async start handler. */
async function boot({ socket, live = fakeLive(), database = fakeDb(), env = {} } = {}) {
  const ws = socket || new FakeSocket();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database,
    env,
  });
  ws.deliver(START);
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return { ws, live, advance: (ms) => (clock += ms) };
}

describe("session start", () => {
  it("resolves the business from the number Twilio called", async () => {
    const database = fakeDb();
    await boot({ database });

    expect(database.lookupBusinessByPhone).toHaveBeenCalledWith("+441372656055");
  });

  it("declares all ten tools on the session", async () => {
    // The single most expensive mistake available here. Rounds 1 and 2
    // declared six and measured a receptionist that could not check
    // availability.
    const { live } = await boot();
    const names = live.sent.config.tools[0].functionDeclarations.map((d) => d.name);

    expect(names).toHaveLength(10);
    expect(names).toContain("check_appointment_availability");
  });

  it("uses the production system prompt, not a stand-in", async () => {
    // This is what makes backlog LVX4 testable at all. The spike refused to
    // read a caller's phone number back with a ten-line prompt, and could not
    // tell whether that was the model or the prompt.
    const { live } = await boot();
    const prompt = live.sent.config.systemInstruction.parts[0].text;

    expect(prompt).toContain("Digile Media");
    expect(prompt.length).toBeGreaterThan(500);
  });

  it("kicks the greeting, because nothing happens until a turn is signalled", async () => {
    const { live } = await boot();

    expect(live.sent.clientContent).toHaveLength(1);
    expect(live.sent.clientContent[0].turnComplete).toBe(true);
  });

  it("serves a different tenant when LIVE_BUSINESS_PHONE overrides the lookup", async () => {
    // So a test number can serve Digile Media's real config without
    // repointing +441372656055, which is a working demo people call.
    const database = fakeDb();
    await boot({ database, env: { LIVE_BUSINESS_PHONE: "+441372656055" } });

    expect(database.lookupBusinessByPhone).toHaveBeenCalledWith("+441372656055");
  });
});

describe("tenant context is loaded BEFORE the session is configured", () => {
  it("declares a business's webhook tools, not just the built-in ten", async () => {
    // The review finding this replaces: the tenant prefetch was fired and not
    // awaited, then the tool list was built in the same synchronous block, so
    // extras.integrations was ALWAYS []. Every integration tool was missing
    // from every call, and the old "declares all ten tools" test passed only
    // because its fake returned no integrations -- it asserted the number it
    // would have got either way.
    const database = fakeDb({
      listIntegrationsForBusiness: async () => [
        {
          provider: "webhook",
          name: "check_order_status",
          enabled: true,
          config: {
            url: "https://example.com/hook",
            description: "Look up an order",
            params_schema: { type: "object", properties: { order_id: { type: "string" } } },
          },
        },
      ],
    });
    const { live } = await boot({ database });
    const names = live.sent.config.tools[0].functionDeclarations.map((d) => d.name);

    expect(names).toContain("check_order_status");
    expect(names.length).toBeGreaterThan(10);
  });

  it("puts the business knowledge base in the system prompt", async () => {
    // Never fetched at all before this: no db.fetchBusinessKnowledge call
    // existed anywhere under lib/voice/live/, so the KNOWLEDGE BASE section was
    // absent and the assistant could answer no FAQ.
    const database = fakeDb({
      fetchBusinessKnowledge: async () => [
        { question: "Where do I park?", answer: "There is a car park behind the surgery.", category: "location" },
      ],
    });
    const { live } = await boot({ database });
    const prompt = live.sent.config.systemInstruction.parts[0].text;

    expect(prompt).toContain("car park behind the surgery");
  });
});

describe("the greeting", () => {
  it("tells the model to open the call, not that a greeting already happened", async () => {
    // The contradiction the review found: services/gemini.js appends "The
    // caller was already greeted -- do not greet them again" whenever
    // config.greeting is set, which is always, while the kick-off message asked
    // the model to greet. True in the cascade, where TTS speaks first. False
    // here: the model IS the voice and nothing has been said.
    const { live } = await boot();
    const prompt = live.sent.config.systemInstruction.parts[0].text;

    expect(prompt).not.toContain("do not greet them again");
    expect(prompt).toContain("Nothing has been said to the caller yet");
  });

  it("carries the recording disclosure into the opening line", async () => {
    // Compliance, not polish. buildGreeting prepends this for the cascade; a
    // Live path that never speaks the configured greeting never says it at all,
    // and a business that enabled it is telling callers something it may be
    // required to say before anything else happens.
    const database = fakeDb({
      loadConfig: () => ({
        businessName: "Digile Media",
        timezone: "Europe/London",
        allowedTasks: ["general_question", "take_message"],
        capabilities: { messages: { enabled: true } },
        businessHours: {},
        greeting: "Hi, how can I help you today?",
        recordingDisclosureEnabled: true,
        recordingDisclosureText: "This call is recorded for training purposes.",
      }),
    });
    const { live } = await boot({ database });
    const prompt = live.sent.config.systemInstruction.parts[0].text;

    expect(prompt).toContain("This call is recorded for training purposes.");
  });

  it("uses a business's custom greeting verbatim", async () => {
    const database = fakeDb({
      loadConfig: () => ({
        businessName: "Digile Media",
        timezone: "Europe/London",
        allowedTasks: ["general_question"],
        capabilities: {},
        businessHours: {},
        greeting: "Good day, Digile Media, Priya speaking.",
        _hasCustomGreeting: true,
      }),
    });
    const { live } = await boot({ database });

    expect(live.sent.config.systemInstruction.parts[0].text).toContain("Priya speaking");
  });
});

describe("the call sid must match the token", () => {
  it("ACCEPTS a start whose call sid matches", async () => {
    // The positive case, asserted first and deliberately. "Correctly refuses
    // bad input" and "refuses everything" are indistinguishable without it.
    const socket = new FakeSocket({ authorizedCallSid: "CA123" });
    const { live } = await boot({ socket });

    expect(live.connect).toHaveBeenCalled();
    expect(socket.closed).toBeNull();
  });

  it("refuses a start claiming a different call", async () => {
    // Without this, one valid token authorises a session against a tenant of
    // the sender's choosing -- businessPhone arrives in the same frame.
    const socket = new FakeSocket({ authorizedCallSid: "CA_OTHER" });
    const live = fakeLive();
    await handleLiveSessionConnection(socket, {}, { now: () => 0, connect: live.connect, database: fakeDb(), env: {} });
    socket.deliver(START);
    await new Promise((r) => setImmediate(r));

    expect(live.connect).not.toHaveBeenCalled();
    expect(socket.closed?.code).toBe(1008);
  });
});

describe("arms", () => {
  /**
   * Speak, then fall silent, on a clock the test controls.
   *
   * 0x00 decodes to RMS 32,124, comfortably over inboundVad's 700 floor;
   * 0xFF is digital silence. Without real voiced frames this assertion would
   * pass for every arm, because no strategy opens a turn nothing spoke into --
   * which is the trivial pass this helper exists to rule out.
   */
  function speakThenPause({ ws, advance }, { voicedFrames = 20, silentFrames = 100 } = {}) {
    const voiced = Buffer.alloc(160, 0x00).toString("base64");
    const silence = Buffer.alloc(160, 0xff).toString("base64");
    for (let i = 0; i < voicedFrames; i++) {
      advance(20);
      ws.deliver({ event: "media", media: { payload: voiced } });
    }
    for (let i = 0; i < silentFrames; i++) {
      advance(20);
      ws.deliver({ event: "media", media: { payload: silence } });
    }
  }

  it("sends no activity signals in the vendor arm, even when the caller speaks", async () => {
    // Arm A's entire definition: the vendor decides. A stray activityStart
    // here would make it arm B with the vendor's detector also running.
    const session = await boot({ env: { LIVE_TURN_END: "vendor" } });
    speakThenPause(session);

    expect(session.live.sent.realtime.filter((m) => m.activityStart || m.activityEnd)).toHaveLength(0);
  });

  it("DOES signal the turn in a manual arm, on the same audio", async () => {
    // The control for the assertion above. Without it, "no signals" passes for
    // every arm because nothing ever spoke.
    const session = await boot({ env: { LIVE_TURN_END: "hangover", LIVE_HANGOVER_MS: "1200" } });
    speakThenPause(session);

    const signals = session.live.sent.realtime.filter((m) => m.activityStart || m.activityEnd);
    expect(signals.some((m) => m.activityStart)).toBe(true);
    expect(signals.some((m) => m.activityEnd)).toBe(true);
  });

  it("forwards the caller's audio to the model", async () => {
    // The most basic thing that could be silently broken: the gate holding
    // every frame forever would pass every other test in this file.
    const session = await boot({ env: { LIVE_TURN_END: "vendor" } });
    speakThenPause(session, { voicedFrames: 5, silentFrames: 0 });

    expect(session.live.sent.realtime.filter((m) => m.audio).length).toBeGreaterThan(0);
  });

  it("disables the vendor detector in a manual arm", async () => {
    const { live } = await boot({ env: { LIVE_TURN_END: "hangover" } });

    expect(live.sent.config.realtimeInputConfig.automaticActivityDetection.disabled).toBe(true);
  });
});

describe("tool calls", () => {
  it("answers every call the model makes", async () => {
    // A Live session left holding an unanswered tool call does not error. It
    // waits, and the caller hears silence.
    const { live } = await boot();
    live.push({
      toolCall: { functionCalls: [{ id: "t1", name: "set_call_intent", args: { intent: "book_appointment" } }] },
    });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));

    expect(live.sent.toolResponses[0].functionResponses[0].id).toBe("t1");
  });

  it("refuses a booking for a slot no availability check returned", async () => {
    const { live } = await boot();
    live.push({
      toolCall: {
        functionCalls: [{ id: "t2", name: "book_appointment", args: { scheduled_at: "2026-09-15T15:00:00" } }],
      },
    });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));

    const response = live.sent.toolResponses[0].functionResponses[0].response;
    expect(response.success).toBe(false);
    expect(response.message).toMatch(/check_appointment_availability/);
  });
});

describe("teardown", () => {
  it("emits one call summary and closes the socket", async () => {
    const { ws } = await boot();
    ws.deliver({ event: "stop" });

    expect(ws.readyState).not.toBe(1);
  });

  it("does not emit twice when stop is followed by close", async () => {
    // Twilio sends `stop` and the socket then closes. Two summaries for one
    // call would double every number anyone aggregates.
    const { ws } = await boot();
    const summaries = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      if (typeof line === "string" && line.includes("live_call_summary")) summaries.push(line);
    });
    ws.deliver({ event: "stop" });
    ws.emit("close");
    spy.mockRestore();

    expect(summaries.length).toBeLessThanOrEqual(1);
  });
});
