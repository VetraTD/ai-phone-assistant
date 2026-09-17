// ---------------------------------------------------------------------------
// Boot a real Live session against fake vendors, and drive it with the four
// things a phone call is made of: the caller speaks, the assistant speaks, a
// tool is called, the turn ends.
//
// Extracted from tests/liveWritePathEndToEnd.test.js so the corpus replay
// (tests/liveCorpusReplay.test.js) drives the same path rather than a second
// approximation of it. That file's header explains why the path matters and is
// still the place to read first; what follows is only the mechanism.
//
// THE ONE PROPERTY WORTH RESTATING: there is NO `execute` override. The real
// executeToolCallGuarded runs, so every gate in services/tools.js and every
// guard in lib/voice/live/guards.js is in the path, and `callerSaidThisCall` is
// set by the real accumulator in lib/voice/live/index.js rather than by a test
// helper. That is what separates this from lib/harness/liveTextSession.js,
// which sets none of those fields and therefore cannot reach a consent gate at
// all.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { vi, expect } from "vitest";
import { handleLiveSessionConnection } from "../../lib/voice/live/index.js";
import { makeFakeDeps } from "../../lib/harness/fakeDeps.js";
import { getLatencyStats } from "../../lib/voice/metrics.js";

export class FakeSocket extends EventEmitter {
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

export function fakeLive() {
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
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

export function fakeDb(config, businessId) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: businessId, name: config.businessName }),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

/** Counters, by the same names the production logs carry. */
export const counters = () => getLatencyStats().turnTaking;

/**
 * @param {object} opts
 * @param {object} opts.config - the business config the session loads
 * @param {string} [opts.businessId]
 * @param {string} [opts.businessPhone] - must match `config.mainPhone`
 * @param {string} [opts.callerPhone]
 * @param {string} [opts.callSid]
 * @param {Array}  [opts.seedAppointments] - rows already in the diary
 * @param {number} [opts.slotCapacity]
 * @param {object} [opts.env]
 */
export async function bootLive({
  config,
  businessId = "biz-1",
  businessPhone,
  callerPhone = "+15551234567",
  callSid = "CA_test",
  seedAppointments = [],
  slotCapacity = 1,
  env = {},
} = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const { deps, store } = makeFakeDeps({ seedAppointments, slotCapacity });

  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database: fakeDb(config, businessId),
    env,
    capabilityDeps: deps,
  });

  ws.deliver({
    event: "start",
    start: {
      callSid,
      streamSid: "MZ1",
      customParameters: {
        businessPhone: businessPhone || config.mainPhone,
        callerPhone,
      },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // A tool round is fire-and-forget from the outside -- guards, packForTool, the
  // awaited execute, the effect merge -- so there is nothing to await. 25 ms is
  // the figure tests/liveWriteRetry.test.js settled on after two setTimeout(0)s
  // proved insufficient and failed reporting that execute had never run.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  let toolSeq = 0;

  const api = {
    ws,
    live,
    store,
    settle,

    /** The caller speaks. Does NOT end the turn. */
    async callerSays(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },

    /** The model speaks, and the turn ends. This is what sets lastReplyText. */
    async assistantTurn(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },

    /** The model speaks without ending the turn -- a tool round follows. */
    async assistantSays(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
    },

    /** End the current model turn with no further speech. */
    async turnEnds() {
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },

    /** Any tool, with any args. Returns the functionResponses it produced. */
    async callTool(name, args = {}) {
      const before = live.sent.toolResponses.length;
      toolSeq += 1;
      live.push({ toolCall: { functionCalls: [{ id: `fc${toolSeq}`, name, args }] } });
      await settle();
      await settle();
      return live.sent.toolResponses
        .slice(before)
        .flatMap((m) => m.functionResponses || [])
        .filter((r) => r.name === name);
    },

    toolResponses: () => live.sent.toolResponses.flatMap((m) => m.functionResponses || []),
    responsesFor: (name) =>
      live.sent.toolResponses.flatMap((m) => (m.functionResponses || []).filter((r) => r.name === name)),

    /** Close the socket the way Twilio does, so finish() runs. */
    async hangUp() {
      ws.deliver({ event: "stop" });
      await settle();
      await settle();
    },
  };

  return api;
}
