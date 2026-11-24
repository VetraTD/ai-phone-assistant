// Pending dials, Live transfers (batch 3 S4, Task 4.2): every <Dial> we place is
// recorded just before it starts, so a forward-all bounce of it can be refused.
// A refused (price) or no-number transfer records nothing; a failed write is
// logged and the transfer still goes ahead.
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
  };
}

async function boot({
  live = fakeLive(),
  db,
  twilioClient,
  twilioClientFor,
  customParameters,
  timers,
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
    ...(timers ? { setTimer: timers.setTimer, clearTimer: timers.clearTimer } : {}),
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
const NORMAL = "+442079460958"; // London landline
const CALLER = "+15559990000";

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

async function inboundTransfer(number, { extra = {}, callerPhone = CALLER, record } = {}) {
  const order = [];
  const updates = [];
  const twilioClient = {
    calls: () => ({
      update: async (opts) => {
        order.push("update");
        updates.push(opts);
      },
    }),
  };
  const live = fakeLive();
  const db = fakeDb();
  db.markCallTransferred = vi.fn(async () => {});
  db.recordPendingDial = vi.fn(
    record ??
      (async () => {
        // Resolves on a LATER tick, so a fire-and-forget record (no await) would
        // put "update" before "record:done" and fail the order assertion.
        await new Promise((r) => setTimeout(r, 5));
        order.push("record:done");
        return "pd-1";
      })
  );
  db.loadConfig = () => ({ ...CONFIG, transferPhoneNumber: number, ...extra });
  const { ws } = await boot({
    live,
    db,
    twilioClient,
    customParameters: { businessPhone: "+441372656055", callerPhone },
  });
  await callTool(live, "request_transfer");
  await driveTransfer(ws, live, updates);
  await new Promise((r) => setImmediate(r));
  return { updates, db, order, ws };
}

describe("Live inbound transfer: pending dial", () => {
  it("records the dial BEFORE the REST update that starts it", async () => {
    const { db, order } = await inboundTransfer(NORMAL);
    expect(db.recordPendingDial).toHaveBeenCalledTimes(1);
    expect(db.recordPendingDial).toHaveBeenCalledWith({
      businessId: BIZ,
      callSid: OUT_SID,
      callerNumber: CALLER,
      dialledNumber: NORMAL,
      timeoutSec: 20,
    });
    expect(order).toEqual(["record:done", "update"]);
  });

  it("a formatted stored transfer number is refused by the price check, so no row (normalising at the record is defence only)", async () => {
    // checkDial accepts strict E.164 only, so a formatted number never reaches
    // the record on any front-end; the E.164 normalisation there is a backstop.
    const { db, updates } = await inboundTransfer("+1 817-555-0102");
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.recordPendingDial).not.toHaveBeenCalled();
  });

  it("own_voicemail widens the window to 45 s", async () => {
    const { db } = await inboundTransfer(NORMAL, { extra: { transferNoAnswer: "own_voicemail" } });
    expect(db.recordPendingDial.mock.calls[0][0].timeoutSec).toBe(45);
  });

  describe("screening", () => {
    const BUSINESS_NUMBER = "+441372656055";
    it("screening on: <Number url> whisper, callerId = the business number, row screened with that callerId and +16 s", async () => {
      const { db, updates } = await inboundTransfer(NORMAL, { extra: { transferScreening: true } });
      const twiml = updates[0].twiml;
      expect(twiml).toContain(`callerId="${BUSINESS_NUMBER}"`);
      expect(twiml).not.toContain(CALLER);
      expect(twiml).toContain('action="https://voice.example.com/twilio/transfer-result?screened=1"');
      expect(twiml).toContain(`<Number url="https://voice.example.com/twilio/transfer-whisper?b=${BIZ}" method="POST">${NORMAL}</Number>`);
      expect(db.recordPendingDial).toHaveBeenCalledWith({
        businessId: BIZ,
        callSid: OUT_SID,
        callerNumber: BUSINESS_NUMBER,
        dialledNumber: NORMAL,
        timeoutSec: 36,
        screened: true,
      });
    });

    it("screening on with the dispatcher's own voicemail: today's TwiML and today's row", async () => {
      const { db, updates } = await inboundTransfer(NORMAL, {
        extra: { transferScreening: true, transferNoAnswer: "own_voicemail" },
      });
      expect(updates[0].twiml).not.toContain("<Number");
      expect(updates[0].twiml).toContain(`callerId="${CALLER}"`);
      expect(updates[0].twiml).not.toContain("screened");
      expect(db.recordPendingDial).toHaveBeenCalledWith({
        businessId: BIZ,
        callSid: OUT_SID,
        callerNumber: CALLER,
        dialledNumber: NORMAL,
        timeoutSec: 45,
      });
    });

    it("screening off: no whisper, caller's number", async () => {
      const { updates } = await inboundTransfer(NORMAL, { extra: { transferScreening: false } });
      expect(updates[0].twiml).not.toContain("<Number");
      expect(updates[0].twiml).toContain(`callerId="${CALLER}"`);
    });
  });

  it("an anonymous or withheld caller is recorded as null, never the placeholder", async () => {
    for (const callerPhone of ["anonymous", "+266696687", "+7378742833", "+86282452253", "+2562533"]) {
      const { db } = await inboundTransfer(NORMAL, { callerPhone });
      expect(db.recordPendingDial.mock.calls[0][0].callerNumber).toBeNull();
    }
  });

  it("a price-refused transfer writes no row", async () => {
    const { db, updates } = await inboundTransfer(NEVER);
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.recordPendingDial).not.toHaveBeenCalled();
  });

  it("a transfer with no number never reaches a <Dial> and writes no row", async () => {
    const prior = process.env.TRANSFER_NUMBER;
    delete process.env.TRANSFER_NUMBER;
    try {
      const updates = [];
      const live = fakeLive();
      const db = fakeDb();
      db.recordPendingDial = vi.fn(async () => "pd-1");
      db.loadConfig = () => ({ ...CONFIG, transferPhoneNumber: "" });
      await boot({
        live,
        db,
        twilioClient: { calls: () => ({ update: async (o) => updates.push(o) }) },
        customParameters: { businessPhone: "+441372656055", callerPhone: CALLER },
      });
      live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: {} }] } });
      await new Promise((r) => setTimeout(r, 30));
      expect(db.recordPendingDial).not.toHaveBeenCalled();
      expect(updates.some((u) => (u.twiml || "").includes("<Dial"))).toBe(false);
    } finally {
      if (prior !== undefined) process.env.TRANSFER_NUMBER = prior;
    }
  });

  it("a write that throws is logged (no number in it) and the transfer still dials", async () => {
    const cap = captureEvents("pending_dial_write_failed");
    const { updates } = await inboundTransfer(NORMAL, {
      record: async () => {
        throw new Error("db down");
      },
    });
    cap.restore();
    expect(updates).toHaveLength(1);
    expect(updates[0].twiml).toContain("<Dial");
    const ev = cap.of("pending_dial_write_failed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      callSid: OUT_SID,
      businessId: BIZ,
      site: "live_inbound_transfer",
      reason: "db down",
      severity: "warn",
    });
    expect(JSON.stringify(ev[0])).not.toContain("5559990000");
    expect(JSON.stringify(ev[0])).not.toContain("2079460958");
  });

  it("a write that returns nothing is logged too, and the transfer still dials", async () => {
    const cap = captureEvents("pending_dial_write_failed");
    const { updates } = await inboundTransfer(NORMAL, { record: async () => null });
    cap.restore();
    expect(updates[0].twiml).toContain("<Dial");
    expect(cap.of("pending_dial_write_failed")).toHaveLength(1);
  });

  it("a database without recordPendingDial surfaces as a logged failure, not a silent skip", async () => {
    const cap = captureEvents("pending_dial_write_failed");
    const updates = [];
    const live = fakeLive();
    const db = fakeDb();
    db.markCallTransferred = async () => {};
    db.loadConfig = () => ({ ...CONFIG, transferPhoneNumber: NORMAL });
    const { ws } = await boot({
      live,
      db,
      twilioClient: { calls: () => ({ update: async (o) => updates.push(o) }) },
      customParameters: { businessPhone: "+441372656055", callerPhone: CALLER },
    });
    await callTool(live, "request_transfer");
    await driveTransfer(ws, live, updates);
    cap.restore();
    expect(updates[0].twiml).toContain("<Dial");
    expect(cap.of("pending_dial_write_failed")).toHaveLength(1);
  });
});

describe("Live inbound transfer: pending dial write is bounded at 2 s", () => {
  it("a write that never settles times out after 2 s: logged once as 'timeout', the transfer still dials, timer cleared", async () => {
    // Injected timers: only the 2 s bound is ever fired, by hand.
    const timers = [];
    const fake = {
      setTimer: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clearTimer: (id) => {
        if (timers[id]) timers[id].cleared = true;
      },
    };
    const cap = captureEvents("pending_dial_write_failed");
    const updates = [];
    const live = fakeLive();
    const db = fakeDb();
    db.markCallTransferred = vi.fn(async () => {});
    db.recordPendingDial = vi.fn(() => new Promise(() => {}));
    db.loadConfig = () => ({ ...CONFIG, transferPhoneNumber: NORMAL });
    const { ws } = await boot({
      live,
      db,
      twilioClient: { calls: () => ({ update: async (o) => updates.push(o) }) },
      customParameters: { businessPhone: "+441372656055", callerPhone: CALLER },
      timers: fake,
    });
    await callTool(live, "request_transfer");
    live.push({ serverContent: { outputTranscription: { text: "Putting you through now." }, turnComplete: true } });
    await new Promise((r) => setImmediate(r));
    ws.deliver({ event: "mark", mark: { name: ws.marks().at(-1) } });
    await vi.waitFor(() => expect(db.recordPendingDial).toHaveBeenCalledTimes(1));
    await new Promise((r) => setImmediate(r));
    expect(updates).toHaveLength(0); // still waiting on the write
    const bound = timers.filter((t) => t.ms === 2000 && !t.cleared);
    expect(bound).toHaveLength(1);
    bound[0].fn();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    cap.restore();
    expect(updates[0].twiml).toContain("<Dial");
    const ev = cap.of("pending_dial_write_failed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ site: "live_inbound_transfer", reason: "timeout", severity: "warn" });
    expect(bound[0].cleared).toBe(true);
  });
});

describe("Live outbound transfer: pending dial", () => {
  async function outboundTransfer(to, record) {
    const updates = [];
    const order = [];
    const out = {};
    await withPinnedClock(async () => {
      const twilioClientFor = vi.fn(() => ({
        calls: () => ({
          update: async (opts) => {
            order.push("update");
            updates.push(opts);
          },
        }),
      }));
      const live = fakeLive();
      const db = fakeDb({ transfer: { to, when: "Daily 00:00-23:59", whisper: true } });
      db.markCallTransferred = vi.fn(async () => {});
      db.recordPendingDial = vi.fn(
        record ??
          (async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push("record:done");
            return "pd-1";
          })
      );
      const { ws } = await boot({ live, db, twilioClientFor });
      await callTool(live, "request_transfer");
      await driveTransfer(ws, live, updates);
      await new Promise((r) => setImmediate(r));
      out.db = db;
    });
    return { updates, order, ...out };
  }

  it("records the CAMPAIGN caller id (not the contact) and 20 s, before the update", async () => {
    const { db, order } = await outboundTransfer(NORMAL);
    expect(db.recordPendingDial).toHaveBeenCalledWith({
      businessId: BIZ,
      callSid: OUT_SID,
      callerNumber: CALLER_ID,
      dialledNumber: NORMAL,
      timeoutSec: 20,
    });
    expect(order).toEqual(["record:done", "update"]);
  });

  it("a formatted campaign transfer number is refused by the price check, so no row", async () => {
    const { db, updates } = await outboundTransfer("+1 817-555-0102");
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.recordPendingDial).not.toHaveBeenCalled();
  });

  it("a price-refused outbound transfer writes no row", async () => {
    const { db, updates } = await outboundTransfer(NEVER);
    expect(updates[0].twiml).not.toContain("<Dial");
    expect(db.recordPendingDial).not.toHaveBeenCalled();
  });

  it("a write that throws is logged and the outbound transfer still dials", async () => {
    const cap = captureEvents("pending_dial_write_failed");
    const { updates } = await outboundTransfer(NORMAL, async () => {
      throw new Error("db down");
    });
    cap.restore();
    expect(updates[0].twiml).toContain("<Dial");
    expect(cap.of("pending_dial_write_failed")[0]).toMatchObject({ site: "live_outbound_transfer", reason: "db down" });
  });
});
