import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// LVX23 -- the arms of a bisect, not a redesign.
//
// The owner, unprompted: "When I first got gemini live it was working
// beautifully. Now it seems like it is having issues once connected to
// everything." The spike had NO tools and a ten-line prompt and was recorded as
// "it sounds amazing". The current configuration gives the same model ten tools
// and a ~17,000-character prompt, and the last call produced three bookings, a
// cancellation, a mid-booking hang-up and audible confusion.
//
// Two knobs, so the same handset can hear one variable move at a time. What
// they are NOT: a licence to rewrite the prompt. It is SHARED with the cascade,
// which runs it acceptably, so it is the control here and not the variable --
// and most of its GUARDRAILS block is scar tissue from specific past failures.
//
// The minimal prompt is deliberately not the spike's. The spike's said the
// assistant had no tools and that "someone will confirm", and that wording
// alone suppressed phone-number read-back -- a behaviour production depends on
// (backlog LVX4). Reproducing it would build the answer into the instrument.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
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
  let captured = null;
  return {
    get config() {
      return captured;
    },
    connect: vi.fn(async ({ config, callbacks }) => {
      captured = config;
      callbacks.onmessage;
      return {
        session: { sendClientContent: () => {}, sendRealtimeInput: () => {}, sendToolResponse: () => {}, close: () => {} },
        languagePinned: true,
        surface: "aistudio",
        model: "m",
      };
    }),
  };
}

const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: { monday: { open: "00:00", close: "23:59" } },
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

async function boot(env = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(),
    env,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return live.config;
}

const declaredNames = (cfg) => (cfg.tools?.[0]?.functionDeclarations || []).map((d) => d.name);
const instruction = (cfg) => cfg.systemInstruction.parts[0].text;

describe("LVX23 bisect arms", () => {
  afterEach(() => {
    delete process.env.LIVE_TOOLS;
    delete process.env.LIVE_PROMPT;
  });

  it("arm 0 is unchanged: the full prompt and every tool this tenant has", async () => {
    const cfg = await boot();
    // Ten since 2026-09-04: this fixture is Digile Media, which cannot text, and
    // record_sms_consent is withheld from a tenant that cannot use it (LVX52).
    // The arm is still "unchanged" -- what changed is the tenant's tool set,
    // not this arm's treatment of it.
    expect(declaredNames(cfg)).toHaveLength(10);
    expect(instruction(cfg).length).toBeGreaterThan(10_000);
  });

  it("arm 1 declares no tools at all", async () => {
    const cfg = await boot({ LIVE_TOOLS: "none" });
    expect(cfg.tools).toEqual([]);
    expect(instruction(cfg).length).toBeGreaterThan(10_000);
  });

  it("arm 2 keeps every tool and shrinks only the prompt", async () => {
    const cfg = await boot({ LIVE_PROMPT: "minimal" });
    expect(declaredNames(cfg)).toHaveLength(10);
    expect(instruction(cfg).length).toBeLessThan(2_000);
  });

  it("the minimal prompt still names the business it is answering for", async () => {
    const cfg = await boot({ LIVE_PROMPT: "minimal" });
    expect(instruction(cfg)).toContain("Digile Media");
    expect(instruction(cfg)).toContain("Europe/London");
  });

  it("the minimal prompt does not repeat the spike's read-back-suppressing wording", async () => {
    const text = instruction(await boot({ LIVE_PROMPT: "minimal" }));
    expect(text).not.toMatch(/no tools/i);
    expect(text).not.toMatch(/someone will confirm/i);
  });

  it("reads both knobs from the injected env, not process.env", async () => {
    process.env.LIVE_TOOLS = "none";
    process.env.LIVE_PROMPT = "minimal";
    const cfg = await boot({});
    expect(declaredNames(cfg)).toHaveLength(10);
    expect(instruction(cfg).length).toBeGreaterThan(10_000);
  });
});
