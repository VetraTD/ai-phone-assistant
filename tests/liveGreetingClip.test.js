import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { greetingClipSpec } from "../lib/voice/greetingClip.js";

// ---------------------------------------------------------------------------
// The recorded greeting through the real Live front-end (pronunciation build,
// Step 2). With a current clip: the clip plays, the model is NOT kicked to
// greet, it is told (seed + prompt) the greeting was already said, and the
// transcript keeps the written greeting. Without one: exactly today's call.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  let onmessage = null;
  const sent = { clientContent: [] };
  return {
    sent,
    connect: vi.fn(async ({ callbacks, config }) => {
      onmessage = callbacks.onmessage;
      sent.config = config;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: (m) => sent.clientContent.push(m),
          sendToolResponse: () => {},
          close: () => {},
        },
        languagePinned: true,
        surface: "aistudio",
        model: "m",
      };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessId: "biz-1",
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media. How can I help you today?",
  _hasCustomGreeting: true,
  timezone: "Europe/London",
  locale: "en-GB",
  allowedTasks: ["general_question", "take_message"],
  capabilities: { messages: { enabled: true } },
  businessHours: {},
  pronunciations: { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } },
};
const SPEC = greetingClipSpec(CONFIG, { languageCode: "en-GB", liveVoice: "Kore", variant: "custom" });
const CLIP_AUDIO = Buffer.alloc(8000, 0x7f); // one second of mu-law

async function boot({ env = { GREETING_CLIP: "on" }, row = { input_hash: SPEC.hash, audio: CLIP_AUDIO } } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const database = {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    withTenant: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    addTranscriptEntry: vi.fn(async () => {}),
    fetchGreetingClip: vi.fn(async () => row),
    upsertGreetingClip: vi.fn(async () => {}),
  };
  const synthesizeGreeting = vi.fn(async () => Buffer.alloc(4000, 0x7f));
  await handleLiveSessionConnection(ws, {}, { now: () => 0, connect: live.connect, database, env, writeCallState: vi.fn(), synthesizeGreeting });
  ws.deliver({ event: "start", start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } } });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return {
    ws,
    live,
    database,
    synthesizeGreeting,
    prompt: () => live.sent.config.systemInstruction.parts[0].text,
    kicked: () => live.sent.clientContent.some((m) => m.turns?.[0]?.parts?.[0]?.text?.includes("The caller has just connected")),
    seeds: () => live.sent.clientContent.filter((m) => m.turns?.[0]?.role === "model"),
    mediaFrames: () => ws.sent.filter((m) => m.event === "media").length,
    aiRows: () => database.addTranscriptEntry.mock.calls.filter((c) => c[1] === "ai").map((c) => c[2]),
  };
}

describe("recorded greeting at pickup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plays the current clip and does not ask the model to greet", async () => {
    const s = await boot();
    expect(s.database.fetchGreetingClip).toHaveBeenCalledWith("biz-1", "custom", "en-GB");
    expect(s.kicked()).toBe(false);
    await vi.waitFor(() => expect(s.mediaFrames()).toBeGreaterThan(0));
  });

  it("tells the model the greeting was said, in the spoken form, and never to say it", async () => {
    const s = await boot();
    expect(s.seeds()).toEqual([{ turns: [{ role: "model", parts: [{ text: SPEC.spokenText }] }], turnComplete: false }]);
    expect(s.prompt()).toContain("The caller was already greeted with:");
    expect(s.prompt()).not.toContain("Your FIRST words on this call");
  });

  it("writes the greeting to the transcript with the written name", async () => {
    const s = await boot();
    await vi.waitFor(() => expect(s.aiRows()).toEqual(["Thanks for calling Digile Media. How can I help you today?"]));
  });

  it("a stale clip: the model greets as today, and a fresh clip is made for the next call", async () => {
    const s = await boot({ row: { input_hash: "old", audio: CLIP_AUDIO } });
    expect(s.kicked()).toBe(true);
    expect(s.seeds()).toEqual([]);
    expect(s.prompt()).toContain("Your FIRST words on this call");
    await vi.waitFor(() => expect(s.database.upsertGreetingClip).toHaveBeenCalled());
    expect(s.synthesizeGreeting).toHaveBeenCalledWith(SPEC.ssml, "en-GB-Chirp3-HD-Kore");
  });

  it("off unless GREETING_CLIP=on: no lookup, the model greets", async () => {
    const s = await boot({ env: {} });
    expect(s.database.fetchGreetingClip).not.toHaveBeenCalled();
    expect(s.kicked()).toBe(true);
  });
});
