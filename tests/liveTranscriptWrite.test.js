import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { log } from "../lib/logger.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

// ---------------------------------------------------------------------------
// LVX83 and LVX30. The two writes this front-end never made.
//
// The cascade wrote a transcript row per speaker per turn and published the
// call's dbCallId and businessId to the shared store at pickup. This front-end
// did neither, and every consequence downstream was read as a dashboard bug:
// "No transcript was captured" on every call, a blank summary, a blank
// sentiment, and a status stuck at in-progress.
//
// The status one is worth spelling out, because it was NOT what it looked
// like. /twilio/status calls completeCall inside withTenantSafe(businessId),
// and businessId came from the shared store this path never wrote. With no
// tenant, withTenantSafe takes its unscoped branch, `app.business_id` is never
// set, and the service connects as vetra_app -- NOSUPERUSER NOBYPASSRLS since
// migration 029. Under FORCE RLS the UPDATE matches zero rows and reports
// success. services/db.js said this would happen the day the superuser went
// away; it went away, and nothing announced it.
//
// So these are one fix with two halves, and the halves are tested together
// because they fail together.
//
// WHAT IS DELIBERATELY DIFFERENT FROM THE CASCADE: hipaa mode. The cascade
// persists caller speech verbatim with no gate at all (session.js:2810). This
// path refuses it, on the same reasoning as LIVE_DEBUG_TRANSCRIPT -- a Live
// session carries the caller's entire utterance and the estate holds no BAA.
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
  let onmessage = null;
  return {
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: () => {},
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

function fakeDb(overrides = {}) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
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
    addTranscriptEntry: vi.fn(async () => {}),
    ...overrides,
  };
}

async function boot({ env = {}, dbOverrides = {} } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const database = fakeDb(dbOverrides);
  const writeCallState = vi.fn();
  await handleLiveSessionConnection(ws, {}, {
    now: () => 0,
    connect: live.connect,
    database,
    env,
    writeCallState,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    database,
    writeCallState,
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    hear: (text) => live.push({ serverContent: { inputTranscription: { text } } }),
    endTurn: async () => {
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    interrupt: async () => {
      live.push({ serverContent: { interrupted: true } });
      await settle();
    },
    settle,
    rows: () =>
      database.addTranscriptEntry.mock.calls.map(([callId, speaker, message, sequence]) => ({
        callId,
        speaker,
        message,
        sequence,
      })),
  };
}

describe("LVX83 - the Live front-end writes transcripts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes one caller row and one assistant row per turn", async () => {
    const s = await boot();
    s.hear("I would like to book an appointment.");
    s.say("Of course. What day suits you?");
    await s.endTurn();

    expect(s.rows()).toEqual([
      {
        callId: "call-1",
        speaker: "caller",
        message: "I would like to book an appointment.",
        sequence: 0,
      },
      { callId: "call-1", speaker: "ai", message: "Of course. What day suits you?", sequence: 1 },
    ]);
  });

  it("writes one row per turn, not one per fragment", async () => {
    const s = await boot();
    s.hear("I would like ");
    s.hear("to book.");
    s.say("Of course. ");
    s.say("What day?");
    await s.endTurn();

    expect(s.rows()).toHaveLength(2);
    expect(s.rows()[0].message).toBe("I would like to book.");
    expect(s.rows()[1].message).toBe("Of course. What day?");
  });

  it("keeps the caller ahead of the assistant across several turns", async () => {
    const s = await boot();
    s.hear("Hello.");
    s.say("Hello, how can I help?");
    await s.endTurn();
    s.hear("Tuesday please.");
    s.say("Tuesday it is.");
    await s.endTurn();

    expect(s.rows().map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    expect(s.rows().map((r) => r.speaker)).toEqual(["caller", "ai", "caller", "ai"]);
  });

  it("writes the assistant alone when the caller said nothing that turn", async () => {
    // The opening greeting is exactly this shape: the model speaks first and
    // there is no caller half at all. A row pair with an empty caller message
    // would be a lie about what happened.
    const s = await boot();
    s.say("Thanks for calling Digile Media.");
    await s.endTurn();

    expect(s.rows()).toEqual([
      { callId: "call-1", speaker: "ai", message: "Thanks for calling Digile Media.", sequence: 1 },
    ]);
  });

  it("records what was actually spoken before a barge-in cut it off", async () => {
    // applyTurn is never reached on an interrupted turn -- the accumulators are
    // cleared outright. The cascade records the partial (session.js:2360) and
    // so does this, or a barged turn is a hole in the record rather than a
    // short entry in it.
    const s = await boot();
    s.hear("Actually, wait.");
    s.say("Your appointment is confirmed for Tues");
    await s.interrupt();

    expect(s.rows()).toEqual([
      { callId: "call-1", speaker: "caller", message: "Actually, wait.", sequence: 0 },
      {
        callId: "call-1",
        speaker: "ai",
        message: "Your appointment is confirmed for Tues",
        sequence: 1,
      },
    ]);
  });

  it("does not write the same turn twice when a barge-in is followed by turnComplete", async () => {
    const s = await boot();
    s.say("Your appointment is confirmed for Tues");
    await s.interrupt();
    await s.endTurn();

    expect(s.rows()).toHaveLength(1);
  });

  it("writes nothing when there is no call row to attach to", async () => {
    const s = await boot({ dbOverrides: { createCall: async () => null } });
    s.hear("Hello.");
    s.say("Hello.");
    await s.endTurn();

    expect(s.rows()).toHaveLength(0);
  });

  it("survives a write that fails, and keeps writing the next turn", async () => {
    // A turn's two rows share ONE transaction, so a failure loses the whole
    // turn rather than half of it. That is the better failure: an assistant
    // row with no caller row above it reads as the receptionist answering
    // something nobody asked, which is the exact defect class this transcript
    // exists to adjudicate.
    let n = 0;
    const s = await boot({
      dbOverrides: {
        addTranscriptEntry: vi.fn(async () => {
          n += 1;
          if (n === 1) throw new Error("connection terminated");
        }),
      },
    });
    s.hear("One.");
    s.say("First.");
    await s.endTurn();
    s.hear("Two.");
    s.say("Second.");
    await s.endTurn();

    // Turn one aborts on its first row; turn two writes both.
    const written = s.rows().slice(1);
    expect(written.map((r) => r.speaker)).toEqual(["caller", "ai"]);
    expect(written.map((r) => r.message)).toEqual(["Two.", "Second."]);
    expect(log.error.mock.calls.some((c) => c[0] === "live_transcript_write_failed")).toBe(true);
  });

  it("refuses to persist anything in hipaa mode, and says so once", async () => {
    const s = await boot({ env: { DEPLOYMENT_MODE: "hipaa" } });
    s.hear("My mobile is 07700 900123.");
    s.say("Thank you.");
    await s.endTurn();
    s.hear("And my postcode is SW1A 1AA.");
    s.say("Noted.");
    await s.endTurn();

    expect(s.rows()).toHaveLength(0);
    const refusals = log.error.mock.calls.filter((c) => c[0] === "live_transcript_refused");
    expect(refusals).toHaveLength(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("900123");
  });
});

describe("LVX30 - the Live front-end publishes its call state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("publishes dbCallId and businessId at pickup", async () => {
    const s = await boot();

    expect(s.writeCallState).toHaveBeenCalled();
    const patch = s.writeCallState.mock.calls.find((c) => c[0] === "CA1")?.[1];
    expect(patch).toMatchObject({ dbCallId: "call-1", businessId: "biz-1" });
  });

  it("latches sawCallerFinal on the caller's first real utterance", async () => {
    const s = await boot();
    s.hear("Hello there.");
    await s.settle();

    const latch = s.writeCallState.mock.calls.filter(
      (c) => c[1] && c[1].sawCallerFinal === true
    );
    expect(latch).toHaveLength(1);
  });

  it("latches once, not once per utterance", async () => {
    const s = await boot();
    s.hear("Hello there.");
    await s.settle();
    s.hear("Tuesday please.");
    await s.settle();

    const latch = s.writeCallState.mock.calls.filter(
      (c) => c[1] && c[1].sawCallerFinal === true
    );
    expect(latch).toHaveLength(1);
  });
});
