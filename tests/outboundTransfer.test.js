// tests/outboundTransfer.test.js
/**
 * The outbound transfer variant (spec §9.7, correction C9, Task 19).
 *
 * Three layers, each tested at the level that actually exercises it:
 *   - lib/outbound/schedule.js's pure parser (parseTransferWhen /
 *     isInsideTransferWindow) -- no I/O, exact.
 *   - lib/voice/live/index.js's redialForTransfer, transferNumber and
 *     transferAllowed, through a real Live session on fakes (the same
 *     boot()/fakeLive()/callTool() shape tests/liveHangup.test.js already
 *     uses for the INBOUND transfer -- extended here with an outbound-capable
 *     fake db, following tests/liveOutboundHarness.test.js's "one fake
 *     database, shared" shape).
 *   - lib/outbound/doorRoutes.js's two new routes, through express + supertest
 *     (tests/outboundDoor.test.js's own harness shape).
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { registerOutboundDoorRoutes } from "../lib/outbound/doorRoutes.js";
import { verifyMediaUrl } from "../lib/outbound/mediaUrl.js";
import { parseTransferWhen, isInsideTransferWindow } from "../lib/outbound/schedule.js";

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------
describe("parseTransferWhen (pure)", () => {
  it("parses a day range and a time range", () => {
    expect(parseTransferWhen("Mon-Fri 09:00-18:00")).toEqual({
      days: new Set(["mon", "tue", "wed", "thu", "fri"]),
      time: { start: 9 * 60, end: 18 * 60 },
    });
  });

  it("accepts Mon-Sat and Daily", () => {
    expect(parseTransferWhen("Mon-Sat 10:00-16:00").days).toEqual(
      new Set(["mon", "tue", "wed", "thu", "fri", "sat"])
    );
    expect(parseTransferWhen("Daily 08:00-20:00").days).toEqual(
      new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
    );
  });

  it("throws on a shape campaignSchema.js's TRANSFER_WHEN_RE would also refuse", () => {
    expect(() => parseTransferWhen("Weekdays 09:00-18:00")).toThrow();
    expect(() => parseTransferWhen("Mon-Fri 9:00-18:00")).toThrow();
    expect(() => parseTransferWhen(null)).toThrow();
  });
});

describe("isInsideTransferWindow (pure, business timezone)", () => {
  const WHEN = "Mon-Fri 09:00-18:00";
  const TZ = "America/Chicago";

  it("true inside the window", () => {
    // Wed 2026-09-23 12:00 America/Chicago = 17:00Z
    expect(isInsideTransferWindow(new Date("2026-09-23T17:00:00Z"), WHEN, TZ)).toBe(true);
  });

  it("false before opening and after closing, same day", () => {
    expect(isInsideTransferWindow(new Date("2026-09-23T13:00:00Z"), WHEN, TZ)).toBe(false); // 08:00 local
    expect(isInsideTransferWindow(new Date("2026-09-23T23:30:00Z"), WHEN, TZ)).toBe(false); // 18:30 local
  });

  it("false on a day outside the range (Saturday)", () => {
    // 2026-09-26 is a Saturday.
    expect(isInsideTransferWindow(new Date("2026-09-26T17:00:00Z"), WHEN, TZ)).toBe(false);
  });

  it("fails closed on a malformed or missing when, rather than throwing", () => {
    expect(isInsideTransferWindow(new Date(), "garbage", TZ)).toBe(false);
    expect(isInsideTransferWindow(new Date(), null, TZ)).toBe(false);
    expect(isInsideTransferWindow(new Date(), undefined, TZ)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redialForTransfer, through a real Live session on fakes
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
// the same business. transferPhoneNumber/transferPolicy are read only on the
// INBOUND branch (state.outboundCall absent); the outbound branch bypasses
// them entirely (this task's whole point), so their presence here is inert
// for every outbound test and load-bearing for the inbound ones.
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
 * A Saturday, outside "Mon-Fri 09:00-18:00" in any timezone this file uses --
 * for the one test that needs the window CLOSED. Every other test uses the
 * always-open default below, deliberately, so it needs no clock control at
 * all (real time, whenever the suite happens to run).
 */
const OUTSIDE_WINDOW = new Date("2026-09-26T17:00:00Z");
const OUTSIDE_WINDOW_WHEN = "Mon-Fri 09:00-18:00";

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
  exitFallbackMs,
  callSid = OUT_SID,
  customParameters,
  env = {},
} = {}) {
  const ws = new FakeSocket();
  let clock = 0;
  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: db,
    env: { TWILIO_VALIDATE_SIGNATURE: "false", BASE_URL: "https://voice.example.com", ...env },
    // Task 20: never the REAL, wired-up singleton (it would try services/
    // db.js's real pool -- unconfigured in every test here).
    postCall: { tryClaim: async () => false, tryClaimByAttempt: async () => false },
    ...(twilioClient ? { twilioClient } : {}),
    ...(twilioClientFor ? { twilioClientFor } : {}),
    ...(exitFallbackMs !== undefined ? { exitFallbackMs } : {}),
  });
  ws.deliver({
    event: "start",
    start: {
      callSid,
      streamSid: "MZ1",
      customParameters: customParameters ?? { direction: "outbound" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));
  return { ws, live };
}

/** A tool that reports success and asks for whatever effect the test wants (identical to liveHangup.test.js's own). */
const toolReturning = (stateEffects) => async (fc) => ({
  functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
  stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" }, ...stateEffects },
});

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

describe("redialForTransfer — inbound is byte-for-byte unchanged", () => {
  it("same client resolution path, same TwiML string as before this task", async () => {
    const updates = [];
    const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
    const live = fakeLive();
    const { ws } = await boot({
      live,
      db: fakeDb(),
      twilioClient,
      customParameters: { businessPhone: "+441372656055", callerPhone: "+15559990000" },
    });
    await callTool(live, "request_transfer");
    await driveTransfer(ws, live, updates);

    expect(updates).toHaveLength(1);
    // Captured exactly: lib/voice/live/index.js's inbound branch, byte for
    // byte -- resolveRingTone("Europe/London") is "uk", callerId is the
    // CALLER's number (state.callerNumber), never the campaign's.
    expect(updates[0].twiml).toBe(
      '<Response><Dial ringTone="uk" callerId="+15559990000">+441111222333</Dial></Response>'
    );
  });

  it("does not transfer a business whose policy forbids it (inbound rule untouched)", async () => {
    const updates = [];
    const twilioClient = { calls: () => ({ update: async (opts) => updates.push(opts) }) };
    const live = fakeLive();
    const db = fakeDb();
    db.loadConfig = () => ({ ...CONFIG, transferPolicy: "never" });
    await boot({ live, db, twilioClient, customParameters: { businessPhone: "+441372656055", callerPhone: "+15559990000" } });
    await callTool(live, "request_transfer");
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
  });
});

describe("redialForTransfer — outbound variant (spec §9.7)", () => {
  it("dials from the CAMPAIGN's caller_id, never the contact's number, with the whisper and result URLs", async () => {
    const updates = [];
    // b22: pinned clock -- see SAFE_INSTANT's own doc.
    await withPinnedClock(async () => {
      const twilioClientFor = vi.fn(() => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) }));
      const live = fakeLive();
      const { ws } = await boot({ live, db: fakeDb(), twilioClientFor });
      await callTool(live, "request_transfer");
      await driveTransfer(ws, live, updates);

      expect(updates).toHaveLength(1);
      expect(updates[0].twiml).toBe(
        // O-14 (fix round 1): ringTone, resolved from CONFIG.timezone
        // (Europe/London) exactly as the inbound branch resolves it -- "uk".
        '<Response><Dial ringTone="uk" timeout="20" callerId="+441372656055" action="https://voice.example.com/twilio/outbound-transfer-result?attempt=att-transfer-1">' +
          '<Number url="https://voice.example.com/twilio/outbound-whisper?attempt=att-transfer-1">+15550001111</Number></Dial></Response>'
      );
      // C17 seam: the client came from twilioClientFor(campaign caller_id), not
      // a client built ad hoc or keyed on the contact's number.
      expect(twilioClientFor).toHaveBeenCalledWith(CALLER_ID);
    });
  });

  it("transfer.whisper === false omits the url attribute entirely", async () => {
    const updates = [];
    // b22: pinned clock -- this test is about the whisper attribute, not the
    // window, and must not depend on the real wall-clock time the suite
    // happens to run at.
    await withPinnedClock(async () => {
      const twilioClientFor = () => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) });
      const live = fakeLive();
      const { ws } = await boot({
        live,
        // Always-open window (the default), only `whisper` overridden.
        db: fakeDb({ transfer: { ...campaignConfig().transfer, whisper: false } }),
        twilioClientFor,
      });
      await callTool(live, "request_transfer");
      await driveTransfer(ws, live, updates);

      expect(updates[0].twiml).not.toContain("outbound-whisper");
      expect(updates[0].twiml).toContain(`<Number>${TRANSFER_TO}</Number>`);
    });
  });

  it("O-14 (fix round 1): carries ringTone, resolved from the business config, same as inbound", async () => {
    const updates = [];
    // b22: pinned clock -- see SAFE_INSTANT's own doc.
    await withPinnedClock(async () => {
      const twilioClientFor = () => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) });
      const live = fakeLive();
      const { ws } = await boot({ live, db: fakeDb(), twilioClientFor });
      await callTool(live, "request_transfer");
      await driveTransfer(ws, live, updates);

      expect(updates[0].twiml).toContain('ringTone="uk"');
    });
  });

  it("outside transfer.when: the tool refuses, no REST update is ever made", async () => {
    const updates = [];
    const twilioClientFor = () => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) });
    const live = fakeLive();
    const db = fakeDb({ transfer: { to: TRANSFER_TO, when: OUTSIDE_WINDOW_WHEN, whisper: true } });
    // Booted on REAL timers -- the session's own startup awaits real promises
    // (tests/liveHangup.test.js's own note: fake timers deadlock vi.waitFor
    // against them). Only `Date` is faked, and only once boot has finished, so
    // transferAllowed()'s `new Date()` reads a Saturday while every setTimeout
    // in the engine (settle, marks, the exit machinery) keeps running for real.
    await boot({ live, db, twilioClientFor });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(OUTSIDE_WINDOW);
      // No `execute` override: the REAL tool pipeline runs, so the refusal is
      // capabilities/transfer.js's own ctx.transferAllowed gate, driven by the
      // real transferAllowed() closure this task changed.
      live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: { reason: "x" } }] } });
      await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    const response = live.sent.toolResponses[0].functionResponses[0].response;
    expect(response.success).toBe(false);
    expect(updates).toHaveLength(0);
  });

  // Checkpoint 2b review, b17. capabilities/transfer.js's execute() refusal
  // said "Offer to take a message instead" unconditionally -- the same
  // phantom-tool wording its own prompt() function already avoids for
  // outbound (ESCALATION_SECTION_OUTBOUND, above this file's own comment on
  // "the message protocol" not existing there), just reachable at a
  // different point: EXECUTION time, when transferAllowed() itself refuses.
  it("b17: the out-of-window refusal offers a callback, never 'take a message', on outbound", async () => {
    const updates = [];
    const twilioClientFor = () => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) });
    const live = fakeLive();
    const db = fakeDb({ transfer: { to: TRANSFER_TO, when: OUTSIDE_WINDOW_WHEN, whisper: true } });
    await boot({ live, db, twilioClientFor });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(OUTSIDE_WINDOW);
      live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: { reason: "x" } }] } });
      await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    const response = live.sent.toolResponses[0].functionResponses[0].response;
    expect(response.success).toBe(false);
    expect(response.message).not.toMatch(/take a message/i);
    expect(response.message).toMatch(/call.*back/i);
  });

  it("with no campaign transfer target at all, transferNumber() is null and the redial is refused before any client is built", async () => {
    const updates = [];
    const twilioClientFor = vi.fn(() => ({ calls: () => ({ update: async (opts) => updates.push(opts) }) }));
    const live = fakeLive();
    const db = fakeDb();
    const baseCtx = await db.outboundCallContext();
    db.outboundCallContext = async () => ({ ...baseCtx, config: { ...baseCtx.config, transfer: null } });
    await boot({ live, db, twilioClientFor });
    live.push({ toolCall: { functionCalls: [{ id: "t1", name: "request_transfer", args: { reason: "x" } }] } });
    await vi.waitFor(() => expect(live.sent.toolResponses).toHaveLength(1));
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    expect(updates).toHaveLength(0);
    expect(twilioClientFor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The two new doors
// ---------------------------------------------------------------------------
const DOOR_BIZ = "11111111-1111-1111-1111-111111111111";
const DOOR_ATTEMPT = "22222222-2222-2222-2222-222222222222";
const PARENT_SID = "CAparent00000000000000000000000001";
const CHILD_SID = "CAchild000000000000000000000000001";

function doorFakeDb(over = {}) {
  return {
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === PARENT_SID
        ? { businessId: DOOR_BIZ, attemptId: DOOR_ATTEMPT, outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null
    ),
    // S3-4 fix round 2 (review): mirrors the REAL withTenantSafe's contract
    // (services/db.js) -- it swallows a throw from `fn` itself and resolves
    // to `opts.fallback` (default null), logging its own generic `db_error`.
    // The earlier bare `(_id, fn) => fn()` shape propagated a throw, which
    // is what let a dead try/catch in doorRoutes.js look load-bearing.
    withTenantSafe: vi.fn(async (_id, fn, opts = {}) => {
      try {
        return await fn();
      } catch {
        return opts.fallback ?? null;
      }
    }),
    withTenant: vi.fn(async (_id, fn) => fn()),
    outboundCallContext: vi.fn(async () => ({
      config: { persona_name: "Ava" },
      firstName: "Priya",
    })),
    fetchBusinessById: vi.fn(async () => ({ id: DOOR_BIZ, name: "Riverside Family Clinic" })),
    setCallOutcomeCode: vi.fn(async () => {}),
    // S3-4 (D6): no stored clip by default -- every existing test in this
    // file that never overrides this keeps getting today's <Say> fallback.
    fetchAttemptTransferMissAudio: vi.fn(async () => null),
    ...over,
  };
}

function doorApp(db, envOverride = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerOutboundDoorRoutes(app, {
    validate: (req, res, next) => next(),
    db,
    mintToken: () => "tok",
    postCall: { tryClaim: async () => false },
    twilioClientFor: () => ({}),
    log: { info: vi.fn(), error: vi.fn() },
    now: () => 1_700_000_000_000,
    env: { BASE_URL: "https://voice.example.com", ...envOverride },
  });
  return app;
}

describe("POST /twilio/outbound-whisper", () => {
  it("speaks the persona and first name, resolved by ParentCallSid", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .query({ attempt: DOOR_ATTEMPT })
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: PARENT_SID });

    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response><Say voice="Polly.Joanna">Transfer from Ava: Priya.</Say></Response>');
    expect(db.outboundAttemptByCallSid).toHaveBeenCalledWith(PARENT_SID);
  });

  it("omits the name clause when the contact has none on file", async () => {
    const db = doorFakeDb({ outboundCallContext: vi.fn(async () => ({ config: { persona_name: "Ava" }, firstName: null })) });
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: PARENT_SID });

    expect(res.text).toBe('<Response><Say voice="Polly.Joanna">Transfer from Ava.</Say></Response>');
  });

  it("XML-escapes the persona/first names", async () => {
    const db = doorFakeDb({
      outboundCallContext: vi.fn(async () => ({ config: { persona_name: "Ava & Co" }, firstName: 'Sam "Q"' })),
    });
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: PARENT_SID });

    expect(res.text).toBe('<Response><Say voice="Polly.Joanna">Transfer from Ava &amp; Co: Sam &quot;Q&quot;.</Say></Response>');
  });

  // b19 (fix wave, checkpoint 2b): Ruling 12-b's country-based selection
  // (missCallProfile), read from the SAME From/To the miss path reads.
  it("b19: a GB From/To pair speaks in the en-GB voice, not the default", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: PARENT_SID, From: "+441372656055", To: "+447700900311" });

    expect(res.text).toBe('<Response><Say voice="Polly.Amy">Transfer from Ava: Priya.</Say></Response>');
  });

  it("Ruling P-5: an ?attempt= mismatch refuses safely rather than trusting the query string", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .query({ attempt: "not-the-real-attempt-id" })
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: PARENT_SID });

    expect(res.status).toBe(200);
    expect(res.text).toBe("<Response><Hangup/></Response>");
    // Refused before ever reading the campaign context.
    expect(db.outboundCallContext).not.toHaveBeenCalled();
  });

  it("an unresolved ParentCallSid (no attempt at all) also refuses safely", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-whisper")
      .type("form")
      .send({ CallSid: CHILD_SID, ParentCallSid: "CAunknown" });

    expect(res.text).toBe("<Response><Hangup/></Response>");
  });
});

describe("POST /twilio/outbound-transfer-result", () => {
  // S3-4 (D6, controller ruling): a completed transfer now writes the
  // deterministic outcome_code -- postCall.js's TERMINAL_OUTCOMES then closes
  // the outreach terminal_outcome instead of rescheduling a contact who was
  // already transferred. The empty TwiML is unchanged.
  it("DialCallStatus=completed: empty TwiML, outcome_code 'transferred' written", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-transfer-result")
      .query({ attempt: DOOR_ATTEMPT })
      .type("form")
      .send({ CallSid: PARENT_SID, DialCallStatus: "completed" });

    expect(res.status).toBe(200);
    expect(res.text).toBe("<Response></Response>");
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(PARENT_SID, "transferred");
  });

  // I7 (Controller Ruling, OVERNIGHT, fix wave checkpoint 2b): the line no
  // longer promises a callback from "someone at the business" -- Part 1 has
  // no owner-notification wiring, so the only follow-up that actually
  // happens is the AI's own retry.
  it("DialCallStatus=no-answer (Ruling P-6): the callback line, outcome_code written, and the log event fires", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-transfer-result")
      .query({ attempt: DOOR_ATTEMPT })
      .type("form")
      .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer" });

    expect(res.status).toBe(200);
    expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(PARENT_SID, "callback_requested");
    // I7: no longer needs the business's name at all.
    expect(db.fetchBusinessById).not.toHaveBeenCalled();
  });

  it("busy and failed take the same unanswered path as no-answer", async () => {
    for (const status of ["busy", "failed", "canceled"]) {
      const db = doorFakeDb();
      const res = await request(doorApp(db))
        .post("/twilio/outbound-transfer-result")
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: status });
      expect(res.text).toContain("We&apos;ll call you back shortly");
      expect(db.setCallOutcomeCode).toHaveBeenCalledWith(PARENT_SID, "callback_requested");
    }
  });

  it("an unresolved CallSid gets the SAME callback line (I7: no longer business-specific) and writes nothing", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-transfer-result")
      .type("form")
      .send({ CallSid: "CAunknown", DialCallStatus: "no-answer" });

    expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
    expect(db.setCallOutcomeCode).not.toHaveBeenCalled();
    expect(db.fetchBusinessById).not.toHaveBeenCalled();
    // No tenant to scope a read to either -- never even attempted.
    expect(db.fetchAttemptTransferMissAudio).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // S3-4 (D6): the transfer-miss clip, in Ava's own Live voice.
  // ---------------------------------------------------------------------
  describe("S3-4: the transfer-miss clip (D6, one voice per call)", () => {
    // Named risk 1: a <Play> URL the media route would actually refuse. So
    // this fetches the URL through the REAL route on the SAME app/db, never
    // just asserting it signs and verifies in isolation.
    it("an unanswered transfer WITH a stored clip: <Play> of a signed transfer_miss URL, no <Say> -- and the URL actually plays through the real media route", async () => {
      const clip = Buffer.from([1, 2, 3]);
      const db = doorFakeDb({ fetchAttemptTransferMissAudio: vi.fn(async () => clip) });
      const app = doorApp(db, { OUTBOUND_MEDIA_URL_SECRET: "a-test-secret" });
      const res = await request(app)
        .post("/twilio/outbound-transfer-result")
        .query({ attempt: DOOR_ATTEMPT })
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer" });

      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<Say");
      expect(res.text).toMatch(/^<Response><Play>.*<\/Play><Hangup\/><\/Response>$/);
      const urlMatch = res.text.match(/<Play>(.*)<\/Play>/);
      const url = urlMatch[1].replace(/&amp;/g, "&");
      expect(url).toMatch(
        /^https:\/\/voice\.example\.com\/media\/outbound\/CAparent00000000000000000000000001\/transfer_miss\.wav\?exp=\d+&sig=[0-9a-f]+$/
      );
      const parsed = new URL(url);
      const verdict = verifyMediaUrl({
        callSid: PARENT_SID,
        kind: "transfer_miss",
        exp: parsed.searchParams.get("exp"),
        sig: parsed.searchParams.get("sig"),
        now: 1_700_000_000_000,
        env: { OUTBOUND_MEDIA_URL_SECRET: "a-test-secret" },
      });
      expect(verdict).toEqual({ ok: true });

      // Named risk 1, for real: fetch the URL through the SAME app's own
      // GET /media/outbound/:callSid/:kind.wav -- the sabotage protocol
      // (dropping transfer_miss from doorRoutes.js's MEDIA_KINDS) turns THIS
      // 200 into a 404.
      const mediaPath = url.replace("https://voice.example.com", "");
      const mediaRes = await request(app).get(mediaPath);
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers["content-type"]).toMatch(/audio\/wav/);
      expect(Buffer.from(mediaRes.body).slice(0, 4).toString("ascii")).toBe("RIFF");

      // The outcome_code write still happens -- the clip only changes what
      // TwiML the caller hears, never the deterministic outcome (Named risk 2).
      expect(db.setCallOutcomeCode).toHaveBeenCalledWith(PARENT_SID, "callback_requested");
    });

    it("an unanswered transfer with NO stored clip: today's <Say>, unchanged", async () => {
      const db = doorFakeDb(); // default: fetchAttemptTransferMissAudio resolves null
      const res = await request(doorApp(db))
        .post("/twilio/outbound-transfer-result")
        .query({ attempt: DOOR_ATTEMPT })
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer" });

      expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
      expect(db.fetchAttemptTransferMissAudio).toHaveBeenCalledWith(DOOR_ATTEMPT);
    });

    it("a completed transfer never plays or fetches the miss clip -- it never rang unanswered", async () => {
      const db = doorFakeDb({ fetchAttemptTransferMissAudio: vi.fn(async () => Buffer.from([1])) });
      const res = await request(doorApp(db))
        .post("/twilio/outbound-transfer-result")
        .query({ attempt: DOOR_ATTEMPT })
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: "completed" });

      expect(res.text).toBe("<Response></Response>");
      expect(db.fetchAttemptTransferMissAudio).not.toHaveBeenCalled();
    });

    // S3-4 fix round 2 (review): `withTenantSafe` itself swallows the throw
    // from `fetchAttemptTransferMissAudio` and resolves to `null` (its own
    // fallback, services/db.js) -- doorRoutes.js has no try/catch of its own
    // around this call any more (matching every other withTenantSafe site in
    // the file). `missAudio` ends up null exactly as it would for "no clip
    // stored", so this must go RED if the `if (missAudio)` gate below it is
    // ever weakened to treat a falsy value as playable.
    it("a read failure falls back to <Say> rather than 500ing (its failure must never affect the call)", async () => {
      const db = doorFakeDb({ fetchAttemptTransferMissAudio: vi.fn(async () => { throw new Error("db down"); }) });
      const res = await request(doorApp(db))
        .post("/twilio/outbound-transfer-result")
        .query({ attempt: DOOR_ATTEMPT })
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer" });

      expect(res.status).toBe(200);
      expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
      // The throw was swallowed by withTenantSafe's own fallback, not by a
      // dead outer catch in doorRoutes.js -- proven by fetchAttemptTransferMissAudio
      // having actually been called (the fake's fn() ran and threw).
      expect(db.fetchAttemptTransferMissAudio).toHaveBeenCalledWith(DOOR_ATTEMPT);
    });

    it("a stored clip but no signing secret configured falls back to <Say> rather than 500ing", async () => {
      const db = doorFakeDb({ fetchAttemptTransferMissAudio: vi.fn(async () => Buffer.from([1])) });
      // doorApp()'s default env carries no OUTBOUND_MEDIA_URL_SECRET/
      // MEDIA_STREAM_SECRET/TWILIO_AUTH_TOKEN -- signMediaUrl throws.
      const res = await request(doorApp(db))
        .post("/twilio/outbound-transfer-result")
        .query({ attempt: DOOR_ATTEMPT })
        .type("form")
        .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer" });

      expect(res.status).toBe(200);
      expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
    });
  });

  it("Ruling P-5: an ?attempt= mismatch takes the unresolved path even though the CallSid itself is real", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-transfer-result")
      .query({ attempt: "not-the-real-attempt-id" })
      .type("form")
      .send({ CallSid: PARENT_SID, DialCallStatus: "completed" });

    expect(res.text).toBe("<Response><Say voice=\"Polly.Joanna\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
    expect(db.setCallOutcomeCode).not.toHaveBeenCalled();
  });

  // b19 (fix wave, checkpoint 2b): same GB/US selection as the whisper leg,
  // read from THIS leg's own From/To (the original outbound call).
  it("b19: a GB From/To pair speaks in the en-GB voice, not the default", async () => {
    const db = doorFakeDb();
    const res = await request(doorApp(db))
      .post("/twilio/outbound-transfer-result")
      .query({ attempt: DOOR_ATTEMPT })
      .type("form")
      .send({ CallSid: PARENT_SID, DialCallStatus: "no-answer", From: "+441372656055", To: "+447700900311" });

    expect(res.text).toBe("<Response><Say voice=\"Polly.Amy\">We&apos;ll call you back shortly.</Say><Hangup/></Response>");
  });
});
