// The polite failure (batch-3 S2, Task C): when the AI will not start or drops,
// the caller hears Twilio's own apology and (inbound) can leave a message.
// Never a silent open line; never a second ending on top of one already under way.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootLive, fakeDb, fakeTwilioClient } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CLOSED = { open: null, close: null, closed: true };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: CLOSED, sun: CLOSED },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment", "transfer_human"],
  transferPhoneNumber: "+441111222333",
  transferPolicy: "always",
  capabilities: {
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};
const SLOT = "2026-09-18T15:30:00";
const READ_BACK =
  "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";
const ASKED = "That is now booked for you. Is there anything else I can help you with today?";
const HARD_MS = 570_000;
const ENV = { BASE_URL: "https://voice.example.test" };

/** Real stdout lines for events (lib/logger.js writes there directly). */
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
  return { lines, restore: () => spy.mockRestore(), of: (e) => lines.filter((l) => l.event === e) };
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false, unref: vi.fn() };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
    fireAt(ms) {
      for (const t of timers) if (t.ms === ms && !t.cleared) t.fn();
    },
  };
}

describe("the polite failure", () => {
  let priorSpellPolicy;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    clearStats();
    priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
    process.env.VOICE_SPELL_POLICY = "off";
  });
  afterEach(() => {
    vi.useRealTimers();
    if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
  });

  async function boot({ twilioClient = fakeTwilioClient(), ...rest } = {}) {
    const sch = fakeScheduler();
    const s = await bootLive({
      config: CONFIG,
      env: ENV,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClient,
      ...rest,
    });
    const marks = [];
    s.ws.send = (raw) => {
      const m = JSON.parse(raw);
      if (m.event === "mark") marks.push(m.mark.name);
    };
    return { s, sch, tw: twilioClient, marks };
  }

  async function bookedCall(opts) {
    const c = await boot(opts);
    await c.s.callTool("check_appointment_availability", { requested_at: SLOT });
    await c.s.callerSays("I'd like Friday afternoon.");
    await c.s.assistantTurn(READ_BACK);
    await c.s.callerSays("Yes, that works.");
    await c.s.callTool("book_appointment", { client_name: "Marcus Bell", scheduled_at: SLOT });
    return c;
  }

  /** end_call armed: the goodbye has played out to the wire, the mark echo has not come. */
  async function endCallQueued(c) {
    await c.s.assistantTurn(ASKED);
    await c.s.callerSays("No, that's everything.");
    await c.s.callTool("end_call", {});
    await c.s.assistantTurn("Thanks for calling. Goodbye.");
    expect(c.marks).toContain("live-exit-end_call");
  }

  /**
   * end_call armed, and the goodbye has REAL audio on the wire (3 s, 24 kHz
   * PCM16), so a local barge has something to cut. Returns once the exit is
   * queued; the audio is still playing (the injected clock has not moved).
   */
  async function endCallWithAudio(c) {
    await c.s.assistantTurn(ASKED);
    await c.s.callerSays("No, that's everything.");
    await c.s.callTool("end_call", {});
    const audio = Buffer.alloc(24000 * 3 * 2);
    for (let i = 0; i < audio.length / 2; i++) audio.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
    c.s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio.toString("base64") } }] } } });
    await c.s.assistantTurn("Thanks for calling. Goodbye.");
    // The exit mark is queued BEHIND the 3 s of audio, so it has not reached the
    // wire (the pacer sends it after the audio); the exit is armed and pending.
    expect(c.marks).not.toContain("live-exit-end_call");
  }

  async function transferArmed(c) {
    await c.s.callTool("request_transfer", { reason: "billing" });
    await c.s.assistantTurn("Putting you through now.");
    expect(c.marks).toContain("live-exit-transfer");
  }
  const echo = (c, name) => c.s.ws.deliver({ event: "mark", mark: { name }, streamSid: "MZ1" });

  function expectMessageTwiml(update) {
    expect(update.sid).toBe("CA_test");
    expect(update.twiml).toContain("technical problem");
    expect(update.twiml).toContain("<Record");
    expect(update.twiml).toContain('action="https://voice.example.test/twilio/message-done"');
    expect(update.twiml).toContain(
      'recordingStatusCallback="https://voice.example.test/twilio/voicemail?to=%2B18176011171"',
    );
  }

  /** An outbound call's config and database (test 2 and 2b). */
  function outboundFixture() {
  const BIZ = "biz-pf-out";
  const SID = "CApfoutbound1";
  const CALLER_ID = "+441372656055";
  const OUT_CONFIG = {
    businessId: BIZ,
    businessName: "Digile Media",
    mainPhone: CALLER_ID,
    timezone: "Europe/London",
    businessHours: {},
    locale: null,
    liveVoice: null,
    allowedTasks: ["general_question"],
    capabilities: {},
  };
  const database = {
    ...fakeDb(OUT_CONFIG, BIZ),
    withTenant: async (_id, fn) => fn(),
    outboundAttemptByCallSid: async (sid) =>
      sid === SID
        ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null,
    outboundCallContext: async () => ({
      attemptNo: 1,
      openerAudio: null,
      toNumber: "+15559876543",
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: {},
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: { persona_name: "Ava", caller_id: CALLER_ID, capabilities: [] },
      firstName: "Priya",
      contactTimezone: "America/Chicago",
    }),
    fetchBusinessById: async () => ({
      id: BIZ,
      name: "Digile Media",
      timezone: "Europe/London",
      phone_number: CALLER_ID,
    }),
    fetchBusinessCapabilities: async () => [],
  };
  return { BIZ, SID, CALLER_ID, OUT_CONFIG, database };
  }

  it("1. connect rejects (inbound): one message update, a log line, then the call is finished", async () => {
    const cap = captureEvents("live_polite_failure");
    const tw = fakeTwilioClient();
    let c;
    try {
      c = await boot({ twilioClient: tw, connectError: new Error("no AI today") });
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expectMessageTwiml(tw.updates[0]);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ callSid: "CA_test", reason: "connect_failed", severity: "warn" });
    expect(JSON.stringify(cap.lines[0])).not.toContain("+1555");
    expect(c.s.ws.readyState).toBe(3);
  });

  it("2. connect rejects (outbound): the hang-up line only, never a voicemail", async () => {
    const { BIZ, SID, OUT_CONFIG, database } = outboundFixture();
    const outClient = fakeTwilioClient();
    const s = await bootLive({
      config: OUT_CONFIG,
      env: ENV,
      callSid: SID,
      customParameters: { direction: "outbound" },
      authorizedCallSid: SID,
      database,
      twilioClientFor: vi.fn(async () => outClient),
      connectError: new Error("no AI today"),
    });
    await s.settle();
    expect(outClient.updates).toHaveLength(1);
    expect(outClient.updates[0].twiml).toContain("We&apos;ll be in touch");
    expect(outClient.updates[0].twiml).toContain("<Hangup/>");
    expect(outClient.updates[0].twiml).not.toContain("<Record");
    expect(s.ws.readyState).toBe(3);
  });

  it("2b. an outbound start that crashes before the context is read: the hang-up line only, never a voicemail", async () => {
    const { SID, OUT_CONFIG, database } = outboundFixture();
    const outClient = fakeTwilioClient();
    const s = await bootLive({
      config: OUT_CONFIG,
      env: ENV,
      callSid: SID,
      customParameters: { direction: "outbound" },
      authorizedCallSid: SID,
      database: { ...database, loadConfig: () => { throw new Error("config exploded"); } },
      twilioClientFor: vi.fn(async () => outClient),
      twilioClient: outClient,
      waitForConnect: false,
    });
    await s.settle();
    expect(outClient.updates).toHaveLength(1);
    expect(outClient.updates[0].twiml).toContain("<Hangup/>");
    expect(outClient.updates[0].twiml).not.toContain("<Record");
    expect(s.ws.readyState).toBe(3);
  });

  it("3a. Gemini closes 1011 mid-call: the message update, then finish", async () => {
    const c = await boot();
    c.s.live.close({ code: 1011, reason: "internal error" });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
    expectMessageTwiml(c.tw.updates[0]);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("3b. Gemini closes 1000 (clean) mid-call: just as silent, so the same message", async () => {
    const c = await boot();
    c.s.live.close({ code: 1000 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
    expectMessageTwiml(c.tw.updates[0]);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("4. a normal end_call and then the Live socket closing: no update", async () => {
    const c = await bookedCall();
    await endCallQueued(c);
    echo(c, "live-exit-end_call");
    await vi.advanceTimersByTimeAsync(3000);
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(3);
    c.s.live.close({ code: 1000 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(0);
  });

  it("5. a transfer and then the Live socket closing: only the transfer's own update", async () => {
    const c = await boot();
    await transferArmed(c);
    echo(c, "live-exit-transfer");
    await vi.waitFor(() => expect(c.tw.updates).toHaveLength(1));
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(3);
    c.s.live.close({ code: 1000 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
    expect(c.tw.updates[0].twiml).toContain("<Dial");
  });

  it("6. the update throws: the failure is logged, the call is still finished", async () => {
    const cap = captureEvents("live_polite_failure_failed", "live_polite_failure");
    const tw = fakeTwilioClient({ failWith: new Error("twilio down") });
    let c;
    try {
      c = await boot({ twilioClient: tw });
      c.s.live.close({ code: 1011 });
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expect(cap.of("live_polite_failure_failed")).toHaveLength(1);
    expect(cap.of("live_polite_failure_failed")[0]).toMatchObject({ reason: "live_dropped", message: "twilio down" });
    expect(cap.of("live_polite_failure")).toHaveLength(0);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("6b. the update never answers: the redirect is bounded and the call is still finished", async () => {
    const hang = {
      updates: [],
      calls: (sid) => ({
        update: async (p) => {
          hang.updates.push({ sid, twiml: p.twiml });
          await new Promise(() => {});
        },
      }),
    };
    const c = await boot({ twilioClient: hang });
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(1);
    const bound = c.sch.timers.filter((t) => t.ms === 5_000 && !t.cleared);
    expect(bound).toHaveLength(1);
    bound[0].fn();
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(3);
  });

  it("7. two close events: one update", async () => {
    const c = await boot();
    c.s.live.close({ code: 1011 });
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
  });

  it("8a. (O1) a drop while an end_call exit is queued: no update, the call is not finished by the drop; the mark ends it", async () => {
    const c = await bookedCall();
    await endCallQueued(c);
    const cap = captureEvents("live_polite_failure_deferred");
    try {
      c.s.live.close({ code: 1011 });
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(c.tw.updates).toHaveLength(0);
    expect(c.s.ws.readyState).toBe(1);
    expect(cap.lines).toHaveLength(1);

    echo(c, "live-exit-end_call");
    await vi.advanceTimersByTimeAsync(3000);
    await c.s.settle();
    expect(c.s.ws.readyState).toBe(3);
    expect(c.tw.updates).toHaveLength(0);
  });

  it("8b. (O1) a drop while an end_call exit is queued, then the caller talks over the goodbye audio (a LOCAL barge): the message goes, then finish", async () => {
    const c = await bookedCall();
    await endCallWithAudio(c);
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(0);
    expect(c.s.ws.readyState).toBe(1);

    const cap = captureEvents("live_exit_cancelled");
    try {
      await c.s.feed(800, { voiced: true });
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ reason: "barge" });
    expect(c.tw.updates).toHaveLength(1);
    expectMessageTwiml(c.tw.updates[0]);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("9. (O1) a drop while a transfer is in flight: no polite-failure update", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const tw = fakeTwilioClient();
    const slow = {
      updates: tw.updates,
      calls: (sid) => ({
        update: async (p) => {
          tw.updates.push({ sid, twiml: p.twiml });
          await gate;
          return {};
        },
      }),
    };
    const c = await boot({ twilioClient: slow });
    await transferArmed(c);
    echo(c, "live-exit-transfer");
    await vi.waitFor(() => expect(tw.updates).toHaveLength(1));

    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(tw.updates).toHaveLength(1);
    expect(tw.updates[0].twiml).toContain("<Dial");
    release();
    await c.s.settle();
    expect(tw.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("10. precedence: a drop replaces a deferred hard end (the message, not the time-up line); a hard end never replaces a deferred drop", async () => {
    // hard end deferred first, then a drop; the caller's local barge releases it
    const c = await bookedCall();
    await endCallWithAudio(c);
    c.sch.fireAt(HARD_MS);
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(0);
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(0);
    await c.s.feed(800, { voiced: true });
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(1);
    expectMessageTwiml(c.tw.updates[0]);
    expect(c.tw.updates[0].twiml).not.toContain("time limit");
    expect(c.s.ws.readyState).toBe(3);

    // drop deferred first, then a hard end: the drop stays in the slot
    const d = await bookedCall({ callSid: "CA_test", twilioClient: fakeTwilioClient() });
    await endCallWithAudio(d);
    d.s.live.close({ code: 1011 });
    await d.s.settle();
    d.sch.fireAt(HARD_MS);
    await d.s.settle();
    expect(d.tw.updates).toHaveLength(0);
    await d.s.feed(800, { voiced: true });
    await d.s.settle();
    expect(d.tw.updates).toHaveLength(1);
    expectMessageTwiml(d.tw.updates[0]);
  });

  it("10b. a drop while the hard end's redirect is in flight: no second update", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = {
      updates: [],
      calls: (sid) => ({
        update: async (p) => {
          slow.updates.push({ sid, twiml: p.twiml });
          await gate;
          return {};
        },
      }),
    };
    const c = await boot({ twilioClient: slow });
    c.sch.fireAt(HARD_MS);
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);
    release();
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("10c. defence in depth (unreachable with today's SDK: no tool call arrives after the Live socket closed): a transfer cannot start while the polite failure's redirect is in flight", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = {
      updates: [],
      calls: (sid) => ({
        update: async (p) => {
          slow.updates.push({ sid, twiml: p.twiml });
          await gate;
          return {};
        },
      }),
    };
    const c = await boot({ twilioClient: slow });
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);

    const cap = captureEvents("live_exit_refused_polite_failure");
    try {
      await c.s.callTool("request_transfer", { reason: "billing" });
      await c.s.assistantTurn("Putting you through now.");
    } finally {
      cap.restore();
    }
    expect(c.marks).not.toContain("live-exit-transfer");
    expect(cap.lines.length).toBeGreaterThan(0);
    release();
    await c.s.settle();
    expect(slow.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  /** A client whose update waits on a gate. */
  function gatedClient() {
    let release;
    const gate = new Promise((r) => (release = r));
    const client = {
      updates: [],
      calls: (sid) => ({
        update: async (p) => {
          client.updates.push({ sid, twiml: p.twiml });
          await gate;
          return {};
        },
      }),
    };
    return { client, release };
  }

  it("10d. (D1) a drop starts the polite failure, then the connect catch runs: the socket stays open until the redirect has landed", async () => {
    const { client, release } = gatedClient();
    let rejectConnect;
    const connectGate = new Promise((_, rej) => (rejectConnect = rej));
    const c = await boot({ twilioClient: client, connectGate });
    c.s.live.close({ code: 1006 });
    await c.s.settle();
    expect(client.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(1);

    rejectConnect(new Error("handshake refused"));
    await c.s.settle();
    // The connect catch has run politeFailure (latched) and must be waiting.
    expect(client.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(1);

    release();
    await c.s.settle();
    expect(client.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("10e. (D2) a refused handshake: onclose fires (reason live_dropped) while connect never settles: one message update, then finish", async () => {
    // With the real SDK a refused handshake fires onclose and connect stays
    // pending. S6: such a refusal logs as a live_dropped polite failure, not
    // connect_failed.
    const cap = captureEvents("live_polite_failure");
    const tw = fakeTwilioClient();
    const connectGate = new Promise(() => {});
    let c;
    try {
      c = await boot({ twilioClient: tw, connectGate });
      c.s.live.close({ code: 1006 });
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(tw.updates).toHaveLength(1);
    expectMessageTwiml(tw.updates[0]);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({ reason: "live_dropped" });
    expect(c.s.ws.readyState).toBe(3);
  });

  it("10f. (D4a) the 9:30 hard end while the polite failure's redirect is in flight: no second update", async () => {
    const { client, release } = gatedClient();
    const c = await boot({ twilioClient: client });
    c.s.live.close({ code: 1011 });
    await c.s.settle();
    expect(client.updates).toHaveLength(1);

    const cap = captureEvents("live_max_duration_skipped", "live_max_duration_hard_end");
    try {
      c.sch.fireAt(HARD_MS);
      await c.s.settle();
    } finally {
      cap.restore();
    }
    expect(cap.of("live_max_duration_skipped")).toHaveLength(1);
    expect(cap.of("live_max_duration_hard_end")).toHaveLength(0);
    expect(client.updates).toHaveLength(1);
    release();
    await c.s.settle();
    expect(client.updates).toHaveLength(1);
    expect(c.s.ws.readyState).toBe(3);
  });

  it("10g. (D6) a deferred ending that rejects still ends the call", async () => {
    const c = await bookedCall();
    await endCallWithAudio(c);
    c.sch.fireAt(HARD_MS); // stored as the deferred ending (an exit is queued)
    await c.s.settle();
    expect(c.tw.updates).toHaveLength(0);

    // Make the stored hard end reject: its first log line throws.
    const real = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...rest) => {
      if (typeof chunk === "string" && chunk.includes('"event":"live_max_duration_hard_end"')) {
        throw new Error("log sink exploded");
      }
      return real(chunk, ...rest);
    });
    try {
      await c.s.feed(800, { voiced: true }); // the local barge cancels the exit and runs it
      await c.s.settle();
    } finally {
      spy.mockRestore();
    }
    expect(c.s.ws.readyState).toBe(3);
  });

  it("11. on an account-B call the update goes through account B's client", async () => {
    const clientB = fakeTwilioClient();
    const lookup = vi.fn(async (sid) => (sid === "ACbbbb" ? clientB : null));
    const sch = fakeScheduler();
    const s = await bootLive({
      config: CONFIG,
      env: ENV,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
      twilioClientForAccountSid: lookup,
      accountSid: "ACbbbb",
    });
    s.live.close({ code: 1011 });
    await s.settle();
    expect(lookup).toHaveBeenCalledWith("ACbbbb");
    expect(clientB.updates).toHaveLength(1);
    expectMessageTwiml(clientB.updates[0]);
  });

  it("12a. a start failure after the CallSid is known: one message update, then finish", async () => {
    const cap = captureEvents("live_start_failed", "live_polite_failure");
    const tw = fakeTwilioClient();
    const database = { ...fakeDb(CONFIG, "biz-1"), loadConfig: () => { throw new Error("config exploded"); } };
    let s;
    try {
      s = await bootLive({ config: CONFIG, env: ENV, twilioClient: tw, database, waitForConnect: false });
      await s.settle();
    } finally {
      cap.restore();
    }
    expect(cap.of("live_start_failed")).toHaveLength(1);
    expect(tw.updates).toHaveLength(1);
    expectMessageTwiml(tw.updates[0]);
    expect(cap.of("live_polite_failure")[0]).toMatchObject({ reason: "start_failed" });
    expect(s.ws.readyState).toBe(3);
  });

  it("12b. an intentional 1008 refusal gets no update", async () => {
    const tw = fakeTwilioClient();
    const s = await bootLive({
      config: CONFIG,
      env: ENV,
      twilioClient: tw,
      authorizedCallSid: "CA_other",
      waitForConnect: false,
    });
    await s.settle();
    expect(s.ws.closeCode).toBe(1008);
    expect(tw.updates).toHaveLength(0);
  });

  it("12c. an outbound stream refused for want of a context (1008) gets no update either", async () => {
    const tw = fakeTwilioClient();
    const database = { ...fakeDb(CONFIG, "biz-1"), outboundAttemptByCallSid: async () => { throw new Error("db down"); } };
    const s = await bootLive({
      config: CONFIG,
      env: ENV,
      callSid: "CA_out_crash",
      customParameters: { direction: "outbound" },
      authorizedCallSid: "CA_out_crash",
      twilioClient: tw,
      database,
      waitForConnect: false,
    });
    await new Promise((r) => setTimeout(r, 400));
    await s.settle();
    expect(s.ws.closeCode).toBe(1008);
    expect(tw.updates).toHaveLength(0);
  });
});
