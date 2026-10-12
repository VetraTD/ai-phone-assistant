// Number block, Live transfers (batch 3 S3, Task 3.2a): the price check runs
// before any TwiML exists. A refused number is never sent a <Dial>; the call
// still ENDS somewhere the caller hears (inbound: message line + Record;
// outbound: Redirect to the existing transfer-result handler); and a refused
// transfer is never marked transferred.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";

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
  marks() {
    return this.sent.filter((m) => m.event === "mark").map((m) => m.mark?.name);
  }
}

function fakeLive() {
  const sent = { toolResponses: [] };
  let onmessage = null;
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
    push: (m) => onmessage?.(m),
  };
}

// ONE config for every test, inbound and outbound alike -- the same tenant,
// the same business. transferPhoneNumber/transferPolicy feed only the INBOUND
// transfer; an outbound call transfers to the campaign's own transfer.to
// (fakeDb below), so they are inert for the outbound tests.
const CONFIG = {
  businessName: "Digile Media",
  timezone: "Europe/London",
  allowedTasks: ["general_question"],
  capabilities: {},
  businessHours: {},
  transferPhoneNumber: "+441111222333",
  transferPolicy: "always",
};

const CALLER_ID = "+441372656055"; // campaign's own number
const CONTACT_PHONE = "+15559876543";
const TRANSFER_TO = "+15550001111";
const ATTEMPT_ID = "att-transfer-1";
const BIZ = "biz-transfer";
const OUT_SID = "CAoutTransfer0001";

/**
 * b22 (fix wave, checkpoint 2b): every test below that relies on the
 * DEFAULT "Daily 00:00-23:59" transfer window used the REAL wall clock --
 * isInsideTransferWindow's end bound is exclusive-by-minute, so a run that
 * happens to land in the last minute of the day (23:59:00-23:59:59.999,
 * local to Europe/London) would read the "always open" window as CLOSED and
 * fail once in roughly 1,440 runs. Pinned to a fixed midday instant so the
 * window check can never itself be what closes it.
 */
const SAFE_INSTANT = new Date("2026-09-23T12:00:00Z"); // Wednesday noon UTC

/** Runs `fn` with Date pinned to SAFE_INSTANT (b22), restoring real timers after. */
async function withPinnedClock(fn) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SAFE_INSTANT);
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

function campaignConfig(overrides = {}) {
  return {
    persona_name: "Ava",
    caller_id: CALLER_ID,
    capabilities: ["appointments", "transfer"],
    // Always open, in every timezone: no clock control needed for the happy
    // path. isInsideTransferWindow still runs for real on every one of these
    // tests -- it just never has anything to refuse.
    transfer: { to: TRANSFER_TO, when: "Daily 00:00-23:59", whisper: true },
    ...overrides,
  };
}

/** One fake db, shared by every test: both the inbound branch (lookupBusinessByPhone) and the outbound one (by-CallSid resolution). */
function fakeDb({ transfer } = {}) {
  const config = { ...campaignConfig({ transfer: transfer ?? campaignConfig().transfer }) };
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: BIZ, name: CONFIG.businessName }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    withTenant: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    // b2 (checkpoint 2b fix wave): teardown flushes the transcript on every
    // stop, this session included -- an unstubbed method threw and printed
    // live_transcript_write_failed on every test in this file.
    addTranscriptEntry: async () => {},
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    markCallTransferred: async () => {},
    outboundAttemptByCallSid: async (sid) =>
      sid === OUT_SID
        ? { businessId: BIZ, attemptId: ATTEMPT_ID, outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null,
    outboundCallContext: async () => ({
      attemptNo: 1,
      openerAudio: null,
      toNumber: CONTACT_PHONE,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: {},
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config,
      firstName: "Priya",
      contactTimezone: "America/Chicago",
    }),
    fetchBusinessById: async () => ({ id: BIZ, name: CONFIG.businessName, timezone: CONFIG.timezone }),
    fetchBusinessCapabilities: async () => [],
    // Task 20: the outbound finish() hook's own half of post-call.
    finishAttemptSession: async () => {},
    // I6 (fix wave, checkpoint 2b): the session's own answered stamp.
    stampAttemptAnswered: async () => {},
    // Batch-3 S4: the dial is recorded before it starts.
    recordPendingDial: async () => "pd-1",
  };
}

async function boot({
  live = fakeLive(),
  db,
  twilioClient,
  twilioClientFor,
  customParameters,
} = {}) {
  const ws = new FakeSocket();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: db,
    env: { TWILIO_VALIDATE_SIGNATURE: "false", BASE_URL: "https://voice.example.com" },
    // Task 20: never the REAL, wired-up singleton (it would try services/
    // db.js's real pool -- unconfigured in every test here).
    postCall: { tryClaim: async () => false, tryClaimByAttempt: async () => false },
    ...(twilioClient ? { twilioClient } : {}),
    ...(twilioClientFor ? { twilioClientFor } : {}),
  });
  ws.deliver({
    event: "start",
    start: {
      callSid: OUT_SID,
      streamSid: "MZ1",
      customParameters: customParameters ?? { direction: "outbound" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  // CHANGED (final wave W1, A19): an OUTBOUND call is taken past the first
  // seconds before any test here calls a tool. In clip mode Live never speaks
  // first: until the backstop decision its output is discarded, and a
  // caller-visible tool from it -- request_transfer among them -- is refused
  // (A19), since the caller never heard the model propose it. 1,400 ms of
  // silence frames fires the no-clip silence backstop (this file's opener
  // renders no clip). Inbound is left exactly as it was.
  if ((customParameters ?? { direction: "outbound" }).direction === "outbound") {
    const SILENCE = Buffer.alloc(160, 0xff).toString("base64");
    for (let i = 0; i < 70; i++) {
      clock += 20;
      ws.deliver({ event: "media", media: { payload: SILENCE } });
    }
    await new Promise((r) => setImmediate(r));
  }
  return { ws, live };
}

async function callTool(live, name, args = {}) {
  live.push({ toolCall: { functionCalls: [{ id: "t1", name, args }] } });
  await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
}

/** Drives a redial to completion: the announcement, its mark, the REST update. */
async function driveTransfer(ws, live, updates) {
  live.push({ serverContent: { outputTranscription: { text: "Putting you through now." }, turnComplete: true } });
  await new Promise((r) => setImmediate(r));
  const mark = ws.marks().at(-1);
  ws.deliver({ event: "mark", mark: { name: mark } });
  await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
}

const NEVER = "+449090123456"; // UK premium 090: never
const NEEDS_SWITCH = "+447624123456"; // Isle of Man mobile: 10-60 cents/min
const NORMAL = "+442079460958"; // London landline

function captureEvents(...events) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") {
      for (const l of chunk.split("\n")) {
        if (events.some((e) => l.includes(`"event":"${e}"`))) lines.push(JSON.parse(l));
      }
    }
    return true;
  });
  return { of: (e) => lines.filter((l) => l.event === e), restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

/** Inbound: a transfer to `number` with `extra` config; resolves once the REST update landed. */
async function inboundTransfer(number, extra = {}) {
  const updates = [];
  const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
  const live = fakeLive();
  const db = fakeDb();
  db.markCallTransferred = vi.fn(async () => {});
  db.loadConfig = () => ({ ...CONFIG, transferPhoneNumber: number, ...extra });
  const { ws } = await boot({
    live,
    db,
    twilioClient,
    customParameters: { businessPhone: "+441372656055", callerPhone: "+15559990000" },
  });
  await callTool(live, "request_transfer");
  await driveTransfer(ws, live, updates);
  await new Promise((r) => setImmediate(r));
  return { updates, db, ws };
}

describe("Live inbound transfer — price check", () => {
  it("a never number: ONE message update (Record + cantTransfer line), no <Dial>, not marked transferred, logged", async () => {
    const cap = captureEvents("dial_destination_refused");
    const { updates, db, ws } = await inboundTransfer(NEVER);
    cap.restore();
    expect(updates).toHaveLength(1);
    expect(ws.readyState).toBe(3); // the call finishes, not left open
    expect(updates[0].twiml).toContain("<Record");
    expect(updates[0].twiml).toContain("can&apos;t put you through");
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.markCallTransferred).not.toHaveBeenCalled();
    const ev = cap.of("dial_destination_refused");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ site: "live_inbound_transfer", reason: "never" });
    expect(JSON.stringify(ev[0])).not.toContain("9090123456");
  });

  it("a needs_switch_on number is refused when allowPricierNumbers is false or absent", async () => {
    for (const extra of [{}, { allowPricierNumbers: false }, { allowPricierNumbers: "true" }]) {
      const { updates, db } = await inboundTransfer(NEEDS_SWITCH, extra);
      expect(updates).toHaveLength(1);
      expect(updates[0].twiml).not.toContain("<Dial");
      expect(updates[0].twiml).toContain("<Record");
      expect(db.markCallTransferred).not.toHaveBeenCalled();
    }
  });

  it("the same number dials normally once allowPricierNumbers is true, and is marked transferred", async () => {
    const { updates, db } = await inboundTransfer(NEEDS_SWITCH, { allowPricierNumbers: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].twiml).toContain("<Dial");
    expect(updates[0].twiml).toContain(NEEDS_SWITCH);
    expect(db.markCallTransferred).toHaveBeenCalled();
  });

  it("a normal London number dials as before", async () => {
    const { updates, db } = await inboundTransfer(NORMAL);
    expect(updates).toHaveLength(1);
    expect(updates[0].twiml).toContain("<Dial");
    expect(db.markCallTransferred).toHaveBeenCalled();
  });

  it("the TRANSFER_NUMBER env fallback is checked like any number", async () => {
    const prior = process.env.TRANSFER_NUMBER;
    process.env.TRANSFER_NUMBER = NEVER;
    try {
      const { updates, db } = await inboundTransfer("");
      expect(updates).toHaveLength(1);
      expect(updates[0].twiml).not.toContain("<Dial");
      expect(updates[0].twiml).toContain("<Record");
      expect(db.markCallTransferred).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.TRANSFER_NUMBER;
      else process.env.TRANSFER_NUMBER = prior;
    }
  });
});

describe("Live outbound transfer — price check", () => {
  async function outboundTransfer(to) {
    const updates = [];
    const out = {};
    await withPinnedClock(async () => {
      const twilioClientFor = vi.fn(() => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) }));
      const live = fakeLive();
      const db = fakeDb({ transfer: { to, when: "Daily 00:00-23:59", whisper: true } });
      db.markCallTransferred = vi.fn(async () => {});
      const { ws } = await boot({ live, db, twilioClientFor });
      await callTool(live, "request_transfer");
      await driveTransfer(ws, live, updates);
      await new Promise((r) => setImmediate(r));
      out.db = db;
      out.ws = ws;
    });
    return { updates, ...out };
  }

  it("a never number: ONE update, a POST Redirect to the transfer-result handler, no <Dial>", async () => {
    const cap = captureEvents("dial_destination_refused");
    const { updates, db, ws } = await outboundTransfer(NEVER);
    cap.restore();
    expect(updates).toHaveLength(1);
    expect(ws.readyState).toBe(3); // the call finishes, not left open
    expect(updates[0].twiml).toBe(
      '<Response><Redirect method="POST">https://voice.example.com/twilio/outbound-transfer-result?attempt=att-transfer-1</Redirect></Response>'
    );
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.markCallTransferred).not.toHaveBeenCalled();
    expect(cap.of("dial_destination_refused")[0]).toMatchObject({ site: "live_outbound_transfer", reason: "never" });
  });

  it("an allowed number still dials (regression)", async () => {
    const { updates } = await outboundTransfer(NORMAL);
    expect(updates).toHaveLength(1);
    expect(updates[0].twiml).toContain("<Dial");
  });
});

// The Q2 no-number branch (endRefusedTransfer on a missing number) is not
// reachable through the harness: transferAllowed() requires a number before
// the transfer is ever armed (see the "no campaign transfer target" test in
// tests/outboundTransfer.test.js), so redialForTransfer never sees an empty one.
