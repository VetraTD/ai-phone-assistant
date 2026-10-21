import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// Pronunciation box, wired through the real Live front-end (2026-10-20).
// The MODEL is given only the spoken form ("Dij-aisle Media"); what a PERSON
// reads -- the stored transcript -- keeps the written one ("Digile Media").
// ---------------------------------------------------------------------------

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
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media. How can I help you today?",
  _hasCustomGreeting: true,
  timezone: "Europe/London",
  allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
  capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
  businessHours: {},
};

async function boot({ pronunciations } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const database = {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => ({ ...CONFIG, ...(pronunciations ? { pronunciations } : {}) }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    addTranscriptEntry: vi.fn(async () => {}),
  };
  await handleLiveSessionConnection(ws, {}, { now: () => 0, connect: live.connect, database, env: {}, writeCallState: vi.fn() });
  ws.deliver({ event: "start", start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } } });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    live,
    database,
    prompt: () => live.sent.config.systemInstruction.parts[0].text,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    hear: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    endTurn: async () => {
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    aiRows: () => database.addTranscriptEntry.mock.calls.filter((c) => c[1] === "ai").map((c) => c[2]),
  };
}

const MAP = { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } };

describe("pronunciation box on a Live call", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives the model the spoken name and never the written one", async () => {
    const s = await boot({ pronunciations: MAP });
    expect(s.prompt()).toContain("Dij-aisle Media");
    expect(s.prompt()).not.toMatch(/\bDigile\b/);
    expect(s.prompt()).toContain("=== SAYING NAMES ===");
    expect(s.prompt()).toContain("D-I-G-I-L-E");
  });

  it("leaves a business without a map exactly as before", async () => {
    const s = await boot();
    expect(s.prompt()).toContain("Digile Media");
    expect(s.prompt()).not.toContain("SAYING NAMES");
  });

  it("stores the assistant's words with the real name", async () => {
    const s = await boot({ pronunciations: MAP });
    s.hear("Who am I speaking to?");
    s.say("You've reached Dij-aisle Media. How can I help?");
    await s.endTurn();
    expect(s.aiRows()).toEqual(["You've reached Digile Media. How can I help?"]);
  });
});
