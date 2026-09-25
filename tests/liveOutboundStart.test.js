// tests/liveOutboundStart.test.js
/**
 * Spec §9.2 / §9.3 through the REAL Live session (lib/voice/live/index.js),
 * booted on tests/helpers/liveBoot.js with fake vendors.
 *
 * Outbound: `customParameters.direction === "outbound"` selects the branch and
 * grants nothing. The context is resolved BY CALLSID -- the one the signed
 * stream token bound (`ws.authorizedCallSid`) -- never from stream parameters
 * and never from LIVE_BUSINESS_PHONE. No kick: the session listens first, and
 * the backstop line is played and seeded only when the person says nothing.
 *
 * Inbound: the same boot without `direction` must do exactly what it did
 * before this task, down to the createCall arguments and the kick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fix round 1 (M8): every structured log line the engine writes is RECORDED
// here instead of printed, so this file's output is clean -- and any ERROR
// line a test did not declare with allowErrors() fails that test (afterEach).
const logged = vi.hoisted(() => []);
vi.mock("../lib/logger.js", async (importOriginal) => {
  const rec = (level) => (event, fields = {}) => {
    logged.push({ level, event, ...fields });
  };
  return { ...(await importOriginal()), log: { debug: rec("DEBUG"), info: rec("INFO"), error: rec("ERROR") } };
});

import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { readShared } from "../lib/callState.js";
import { BACKSTOP_END_MARK, FIRST_AUDIO_MARK } from "../lib/outbound/firstSeconds.js";

let allowed = new Set();
/** Declare the ERROR-level events this test expects. Anything else fails it. */
const allowErrors = (...names) => names.forEach((n) => allowed.add(n));
const events = (name) => logged.filter((l) => l.event === name);

beforeEach(() => {
  logged.length = 0;
  allowed = new Set();
});
afterEach(() => {
  const unexpected = logged.filter((l) => l.level === "ERROR" && !allowed.has(l.event)).map((l) => `${l.event}: ${l.reason ?? ""}`);
  expect(unexpected).toEqual([]);
});

const BIZ = "biz-digile";
const SID = "CAoutbound0001";
const CALLER_ID = "+441372656055"; // our number, UK
const CONTACT = "+15551230000"; // the person, US -- deliberately a different country
const OPENER = "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.";
const OPENER_AUDIO = Buffer.alloc(8000, 0x7f); // one second of 8 kHz mu-law

const CONFIG = {
  businessId: BIZ,
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: CALLER_ID,
  timezone: "Europe/London",
  businessHours: {},
  // No locale: the language then derives from a NUMBER, and the business's and
  // the contact's disagree, so the test can see which one was used.
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: CALLER_ID,
  opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
  topic: "your enquiry",
  objective: "Qualify.",
  capabilities: ["qualification"],
  retries: { schedule: ["+0m"], voicemail_on: [] },
};

const BUSINESS_ROW = { id: BIZ, name: "Digile Media", timezone: "Europe/London", phone_number: CALLER_ID };

function outboundDb({ openerAudio = OPENER_AUDIO, resolves = true, lateOpenerAudio = null, firstName = "Sam", campaignConfig = CAMPAIGN_CONFIG } = {}) {
  const base = fakeDb(CONFIG, BIZ);
  return {
    ...base,
    lookupBusinessByPhone: vi.fn(base.lookupBusinessByPhone),
    loadConfig: vi.fn(() => CONFIG),
    createCall: vi.fn(async () => "call-1"),
    fetchCallerContext: vi.fn(async () => null),
    // The per-turn transcript write (LVX83); absent from fakeDb.
    addTranscriptEntry: vi.fn(async () => {}),
    // Fix round 1 (I4): the one late re-read of a clip stored after pickup.
    fetchAttemptOpenerAudio: vi.fn(async () => lateOpenerAudio),
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      resolves && sid === SID
        ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 3 }
        : null
    ),
    withTenant: vi.fn(async (_id, fn) => fn()),
    outboundCallContext: vi.fn(async () => ({
      attemptNo: 1,
      openerAudio,
      toNumber: CONTACT,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 3,
      contactId: "contact-1",
      trigger: { source: "outbound-admin" },
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: campaignConfig,
      firstName,
      contactTimezone: "America/Chicago",
    })),
    fetchBusinessById: vi.fn(async () => BUSINESS_ROW),
    fetchBusinessCapabilities: vi.fn(async () => []),
  };
}

/** Every structured log line the engine writes while `run` executes. */
async function logsDuring(run) {
  const start = logged.length;
  const out = await run();
  const lines = logged.slice(start);
  return { out, lines, events: (name) => lines.filter((l) => l.event === name) };
}

function bootOutbound({ database = outboundDb(), env = {}, customParameters = { direction: "outbound" }, authorizedCallSid = SID, callSid = SID, waitForConnect = true } = {}) {
  return bootLive({ config: CONFIG, callSid, env, customParameters, authorizedCallSid, database, waitForConnect });
}

/** 24 kHz PCM16 as the model sends it: enough for several 20 ms mu-law frames. */
function modelAudioMsg(ms = 200) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data: buf.toString("base64") } }] } } };
}

const KICK = {
  turns: [{ role: "user", parts: [{ text: "(The caller has just connected. Open the call now.)" }] }],
  turnComplete: true,
};

describe("outbound: context by CallSid", () => {
  it("never looks the business up by phone; resolves the bound CallSid instead", async () => {
    const database = outboundDb();
    const call = await bootOutbound({ database });
    expect(database.lookupBusinessByPhone).not.toHaveBeenCalled();
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledWith(SID);
    expect(call.ws.closeCode).toBeUndefined();
    await call.hangUp();
  });

  it("state.config is the BUSINESS config: loadConfig gets the business row, one argument, as inbound does", async () => {
    const database = outboundDb();
    const call = await bootOutbound({ database });
    expect(database.loadConfig).toHaveBeenCalledTimes(1);
    expect(database.loadConfig.mock.calls[0]).toEqual([{ ...BUSINESS_ROW, business_capabilities: [] }]);
    expect(call.ws.liveState.config).toBe(CONFIG);
    await call.hangUp();
  });

  it("createCall gets the contact as the other party, our caller_id, and the link ids", async () => {
    const database = outboundDb();
    const call = await bootOutbound({ database });
    expect(database.createCall).toHaveBeenCalledTimes(1);
    expect(database.createCall.mock.calls[0]).toEqual([
      BIZ,
      SID,
      CONTACT,
      CALLER_ID,
      { direction: "outbound", campaignId: "camp-1", campaignVersion: 3, outreachId: "out-1", attemptId: "att-1", contactId: "contact-1" },
    ]);
    await call.hangUp();
  });

  it("state carries direction, attemptId, the contact as callerNumber and caller_id as twilioNumber", async () => {
    const call = await bootOutbound();
    const s = call.ws.liveState;
    expect(s.direction).toBe("outbound");
    expect(s.attemptId).toBe("att-1");
    expect(s.businessId).toBe(BIZ);
    expect(s.callerNumber).toBe(CONTACT);
    expect(s.twilioNumber).toBe(CALLER_ID);
    expect(s.outboundCall).toMatchObject({ attemptId: "att-1", openerText: OPENER, contact: { firstName: "Sam" } });
    await call.hangUp();
  });

  it("writeCallState carries direction and attemptId through the REAL shared store", async () => {
    const call = await bootOutbound();
    await vi.waitFor(async () => {
      expect(await readShared(SID)).toMatchObject({ direction: "outbound", attemptId: "att-1", businessId: BIZ, dbCallId: "call-1" });
    });
    await call.hangUp();
  });

  it("D-b: no caller-history lookup, and the prompt carries no THIS CALLER'S NUMBER block (extras.callerPhone stays empty, P-3)", async () => {
    const database = outboundDb();
    // Even with a callerPhone stream parameter present: on outbound it is not read.
    const call = await bootOutbound({ database, customParameters: { direction: "outbound", callerPhone: CONTACT } });
    expect(database.fetchCallerContext).not.toHaveBeenCalled();
    const { systemInstruction } = call.live.connect.mock.calls[0][0].config;
    expect(systemInstruction.parts[0].text).not.toContain(CONTACT);
    expect(systemInstruction.parts[0].text).not.toMatch(/THIS CALLER'S NUMBER/);
    await call.hangUp();
  });

  it("voice and language come from the BUSINESS number (caller_id +44 -> en-GB), not the contact's (+1)", async () => {
    const call = await bootOutbound();
    const { speechConfig } = call.live.connect.mock.calls[0][0].config;
    expect(speechConfig.languageCode).toBe("en-GB");
    expect(speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    await call.hangUp();
  });

  it("sends NO kick at start: the session listens first", async () => {
    const call = await bootOutbound();
    expect(call.live.sent.clientContent).toEqual([]);
    await call.feed(1000);
    expect(call.live.sent.clientContent).toEqual([]);
    await call.hangUp();
  });

  it("an unresolvable CallSid closes the socket with 1008 and logs outbound_context_missing", async () => {
    allowErrors("outbound_context_missing");
    const database = outboundDb({ resolves: false });
    const { out: call, events } = await logsDuring(async () => {
      const c = await bootOutbound({ database, waitForConnect: false });
      await vi.waitFor(() => expect(c.ws.closeCode).toBe(1008));
      return c;
    });
    expect(events("outbound_context_missing")).toHaveLength(1);
    expect(events("outbound_context_missing")[0]).toMatchObject({ callSid: SID, reason: "no_attempt" });
    expect(call.live.connect).not.toHaveBeenCalled();
    expect(database.createCall).not.toHaveBeenCalled();
    expect(database.lookupBusinessByPhone).not.toHaveBeenCalled();
    // A clean miss is an answer, not a blip: not retried (M11).
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledTimes(1);
  });

  it("a resolver that keeps throwing: one retry, then 1008, outbound_context_missing, nothing connected", async () => {
    allowErrors("outbound_context_missing");
    const database = outboundDb();
    database.outboundAttemptByCallSid.mockRejectedValue(new Error("db down"));
    const { out: call, events } = await logsDuring(async () => {
      const c = await bootOutbound({ database, waitForConnect: false });
      await vi.waitFor(() => expect(c.ws.closeCode).toBe(1008));
      return c;
    });
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledTimes(2);
    expect(events("outbound_context_missing")).toHaveLength(1);
    expect(events("outbound_context_missing")[0]).toMatchObject({ reason: "db down" });
    expect(call.live.connect).not.toHaveBeenCalled();
  });

  it("M11: a single database blip at pickup is retried once (~150 ms) and the call goes ahead", async () => {
    const database = outboundDb();
    database.outboundAttemptByCallSid.mockRejectedValueOnce(new Error("connection reset"));
    const t0 = Date.now();
    const call = await bootOutbound({ database });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledTimes(2);
    expect(call.ws.closeCode).toBeUndefined();
    expect(database.createCall).toHaveBeenCalledTimes(1);
    expect(events("outbound_context_missing")).toHaveLength(0);
    await call.hangUp();
  });

  it("a forged direction on an INBOUND call's stream grants nothing: 1008 + outbound_context_missing, no business by phone", async () => {
    allowErrors("outbound_context_missing");
    // An inbound call's token binds CAinbound. Its start frame claims
    // direction=outbound and names a real business number.
    const database = outboundDb();
    const { out: call, events } = await logsDuring(async () => {
      const c = await bootOutbound({
        database,
        callSid: "CAinbound0001",
        authorizedCallSid: "CAinbound0001",
        customParameters: { direction: "outbound", businessPhone: CALLER_ID, callerPhone: CONTACT },
        waitForConnect: false,
      });
      await vi.waitFor(() => expect(c.ws.closeCode).toBe(1008));
      return c;
    });
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledWith("CAinbound0001");
    expect(events("outbound_context_missing")).toHaveLength(1);
    expect(database.lookupBusinessByPhone).not.toHaveBeenCalled();
    expect(database.createCall).not.toHaveBeenCalled();
    expect(call.live.connect).not.toHaveBeenCalled();
  });

  it("with LIVE_BUSINESS_PHONE set and stream params naming another business, it still resolves by CallSid", async () => {
    const database = outboundDb();
    const call = await bootOutbound({
      database,
      env: { LIVE_BUSINESS_PHONE: "+442000000888" },
      customParameters: { direction: "outbound", businessPhone: "+442000000999", callerPhone: "+15550000999" },
    });
    expect(database.lookupBusinessByPhone).not.toHaveBeenCalled();
    expect(database.outboundAttemptByCallSid).toHaveBeenCalledWith(SID);
    expect(database.createCall.mock.calls[0].slice(0, 4)).toEqual([BIZ, SID, CONTACT, CALLER_ID]);
    expect(call.ws.liveState.twilioNumber).toBe(CALLER_ID);
    await call.hangUp();
  });

  it("with the stream token required and no CallSid bound to the socket, it refuses (1008)", async () => {
    allowErrors("outbound_context_missing");
    const database = outboundDb();
    const call = await bootOutbound({ database, authorizedCallSid: null, waitForConnect: false });
    await vi.waitFor(() => expect(call.ws.closeCode).toBe(1008));
    expect(database.outboundAttemptByCallSid).not.toHaveBeenCalled();
    expect(events("outbound_context_missing")).toEqual([
      expect.objectContaining({ level: "ERROR", callSid: SID, reason: "unbound" }),
    ]);
  });
});

describe("outbound: the first seconds through the real session", () => {
  it("silence: the backstop clip is queued at 1,650 ms and seeded as Live's own turn (S1)", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(1640);
    expect(enqueue).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toEqual([]);

    await call.feed(20);
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);
    await call.hangUp();
  });

  it("the person says hello first: no backstop, Live's reply plays", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(1100);
    await call.feed(300, { voiced: true });
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls.every(([buf]) => buf !== OPENER_AUDIO)).toBe(true);
    await call.feed(3000);
    expect(enqueue.mock.calls.every(([buf]) => buf !== OPENER_AUDIO)).toBe(true);
    expect(call.live.sent.clientContent).toEqual([]);
    await call.hangUp();
  });

  it("model audio while the backstop plays is dropped until the backstop-end mark echoes, then plays", async () => {
    const call = await bootOutbound();
    await call.feed(1660);
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.hangUp();
  });

  it("the backstop is interruptible: a barge clears it like any assistant audio, the mark never echoes, and Live's answer PLAYS", async () => {
    const call = await bootOutbound();
    await call.feed(1660);
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    // Suppressed while the clip plays -- the state the barge has to undo.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    // The person talks over the clip: a sustained voiced run past the gate's
    // barge threshold, while our audio is playing.
    await call.feed(600, { voiced: true });
    expect(clear).toHaveBeenCalled();

    // No `outbound-backstop-end` mark is ever delivered. Live answers them.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.hangUp();
  });

  it("the vendor's `interrupted` lifts the suppression too", async () => {
    const call = await bootOutbound();
    await call.feed(1660);
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    call.live.push({ serverContent: { interrupted: true } });
    await call.settle();
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.hangUp();
  });

  it("no clip (render failed): the silence path prompts Live to say the line instead", async () => {
    allowErrors("outbound_backstop_missing");
    const call = await bootOutbound({ database: outboundDb({ openerAudio: null }) });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    const { events } = await logsDuring(() => call.feed(1660));
    expect(enqueue).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toHaveLength(1);
    expect(call.live.sent.clientContent[0].turnComplete).toBe(true);
    expect(call.live.sent.clientContent[0].turns[0].role).toBe("user");
    expect(call.live.sent.clientContent[0].turns[0].parts[0].text).toContain(`The person hasn't spoken. Say: ${OPENER}`);
    expect(events("outbound_backstop_missing")).toHaveLength(1);
    await call.hangUp();
  });

  it("first-turn check: an incomplete first reply gets one correction note", async () => {
    allowErrors("outbound_first_turn_incomplete");
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    call.live.push(modelAudioMsg());
    await call.settle();
    const { events } = await logsDuring(() => call.assistantTurn("Hi, is that Sam?"));
    expect(events("outbound_first_turn_incomplete")).toHaveLength(1);
    const notes = call.live.sent.clientContent.filter((m) =>
      m.turns?.[0]?.parts?.[0]?.text?.includes("Tell them now, briefly: you are Ava, an AI assistant from Digile Media.")
    );
    expect(notes).toHaveLength(1);
    await call.assistantTurn("Great, and what's the clinic called?");
    expect(
      call.live.sent.clientContent.filter((m) => m.turns?.[0]?.parts?.[0]?.text?.includes("Tell them now, briefly"))
    ).toHaveLength(1);
    await call.hangUp();
  });

  it("I1: the reviewer's probe -- a barge cuts the backstop before the disclosure, Live's next turn lacks it, and it is corrected", async () => {
    allowErrors("outbound_first_turn_incomplete");
    const call = await bootOutbound();
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(1660); // backstop fires at 1,650 and is playing
    // "Yes, speaking" -- 800 ms of speech over the clip.
    await call.feed(800, { voiced: true });
    expect(clear).toHaveBeenCalled();
    await call.feed(200);

    // Live answers what it heard, believing (from the seed) it already said
    // the whole line.
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Great, thanks Sam. I'm calling about your enquiry.");

    const isNote = (m) => m.turns?.[0]?.parts?.[0]?.text?.includes("Tell them now, briefly: you are Ava, an AI assistant from Digile Media.");
    expect(call.live.sent.clientContent.filter(isNote)).toHaveLength(1);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(1);
    await call.hangUp();
  });

  it("I4: a clip stored AFTER pickup is re-read once before the deadline and played", async () => {
    const LATE = Buffer.alloc(4000, 0x55);
    const database = outboundDb({ openerAudio: null, lateOpenerAudio: LATE });
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(1240); // before deadline - lead
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    await call.feed(20); // 1,260: past 1,650 - 400
    expect(database.fetchAttemptOpenerAudio).toHaveBeenCalledTimes(1);
    expect(database.fetchAttemptOpenerAudio).toHaveBeenCalledWith("att-1");
    expect(database.withTenant.mock.calls.at(-1)[0]).toBe(BIZ);

    await call.feed(400); // through 1,660
    expect(enqueue).toHaveBeenCalledWith(LATE);
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);
    expect(database.fetchAttemptOpenerAudio).toHaveBeenCalledTimes(1);
    await call.hangUp();
  });

  it("I4: no re-read when the call-time re-render refused the clip (O-4)", async () => {
    allowErrors("outbound_backstop_render_refused", "outbound_backstop_missing");
    const database = outboundDb({ openerAudio: Buffer.alloc(100, 1), lateOpenerAudio: Buffer.alloc(100, 1) });
    database.fetchBusinessById.mockResolvedValue({ ...BUSINESS_ROW, name: "N".repeat(100) });
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(1660);
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(events("outbound_backstop_render_refused")).toHaveLength(1);
    await call.hangUp();
  });
});

describe("inbound unchanged", () => {
  const INBOUND_CALLER = "+447700900555";

  function inboundDb() {
    const base = fakeDb(CONFIG, BIZ);
    return {
      ...base,
      lookupBusinessByPhone: vi.fn(base.lookupBusinessByPhone),
      loadConfig: vi.fn(() => CONFIG),
      createCall: vi.fn(async () => "call-in-1"),
      fetchCallerContext: vi.fn(async () => null),
      outboundAttemptByCallSid: vi.fn(async () => {
        throw new Error("the inbound path must never reach the outbound resolver");
      }),
    };
  }

  it("looks the business up by phone, loads caller history, creates the call with the 4-arg shape, and sends the kick", async () => {
    const database = inboundDb();
    const call = await bootLive({
      config: CONFIG,
      callSid: "CAinbound0002",
      businessPhone: CALLER_ID,
      callerPhone: INBOUND_CALLER,
      database,
    });

    expect(database.lookupBusinessByPhone).toHaveBeenCalledTimes(1);
    expect(database.lookupBusinessByPhone).toHaveBeenCalledWith(CALLER_ID);
    expect(database.loadConfig.mock.calls[0]).toHaveLength(1);
    expect(database.fetchCallerContext).toHaveBeenCalledWith(BIZ, INBOUND_CALLER);
    expect(database.createCall).toHaveBeenCalledTimes(1);
    expect(database.createCall.mock.calls[0]).toEqual([BIZ, "CAinbound0002", INBOUND_CALLER, CALLER_ID]);
    expect(database.outboundAttemptByCallSid).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toEqual([KICK]);
    expect(call.ws.liveState.direction).toBeUndefined();
    expect(call.ws.liveState.attemptId).toBeUndefined();
    expect(call.ws.closeCode).toBeUndefined();

    // The shared slice carries no outbound fields.
    await vi.waitFor(async () => expect(await readShared("CAinbound0002")).toMatchObject({ dbCallId: "call-in-1", businessId: BIZ }));
    const shared = await readShared("CAinbound0002");
    expect(shared).not.toHaveProperty("direction");
    expect(shared).not.toHaveProperty("attemptId");

    // Silence never plays a backstop on inbound.
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(3000);
    expect(enqueue).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toEqual([KICK]);
    await call.hangUp();
  });

  it("LIVE_BUSINESS_PHONE still overrides the stream's businessPhone on inbound, exactly as before", async () => {
    const database = inboundDb();
    const call = await bootLive({
      config: CONFIG,
      callSid: "CAinbound0003",
      businessPhone: "+442000000999",
      callerPhone: INBOUND_CALLER,
      env: { LIVE_BUSINESS_PHONE: CALLER_ID },
      database,
    });
    expect(database.lookupBusinessByPhone).toHaveBeenCalledWith(CALLER_ID);
    expect(database.createCall.mock.calls[0]).toEqual([BIZ, "CAinbound0003", INBOUND_CALLER, CALLER_ID]);
    await call.hangUp();
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 -- owner decisions O-6..O-9, through the real session.
// ---------------------------------------------------------------------------
describe("outbound fix round 2: the owner decisions through the real session", () => {
  const isSeed = (m) => m.turns?.[0]?.role === "model" && m.turnComplete === false;

  it("O-6: one loud frame near pickup + 1.5 s is not speech -- the backstop is queued at the silence deadline and seeded", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(1160);
    await call.feed(20, { voiced: true }); // 1,180: a click
    await call.feed(460); // 1,640
    expect(enqueue).not.toHaveBeenCalled();
    await call.feed(20); // 1,660
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent.filter(isSeed)).toHaveLength(1);
    expect(call.ws.liveDialFirstSeconds.onsetAt()).toBeNull();
    await call.hangUp();
  });

  it("O-7: the first-audio mark reaches the wire before the first frame, and the metric is taken at its echo", async () => {
    const call = await bootOutbound();
    const sent = [];
    vi.spyOn(call.ws, "send").mockImplementation((raw) => sent.push(JSON.parse(raw)));
    await call.feed(1660); // queued at 1,660
    const firstMark = sent.findIndex((m) => m.event === "mark" && m.mark.name === FIRST_AUDIO_MARK);
    const firstMedia = sent.findIndex((m) => m.event === "media");
    expect(firstMark).toBeGreaterThanOrEqual(0);
    expect(firstMedia).toBeGreaterThan(firstMark);

    expect(call.ws.liveDialFirstSeconds.firstAudio()).toMatchObject({ from_answer_ms: 2010, measured: "enqueue" });
    await call.feed(140); // 1,800: Twilio echoes the mark as the clip starts to play
    call.ws.deliver({ event: "mark", mark: { name: FIRST_AUDIO_MARK } });
    expect(call.ws.liveDialFirstSeconds.firstAudio()).toEqual({
      from_answer_ms: 2150,
      from_speech_ms: null,
      path: "backstop_silence",
      measured: "playout",
    });
    expect(events("outbound_first_audio")).toEqual([expect.objectContaining({ from_answer_ms: 2150, measured: "playout" })]);
    await call.hangUp();
    expect(events("outbound_first_audio")).toHaveLength(1);
  });

  it("O-7: no echo before the hang-up -- the queue-time value is logged, flagged measured:'enqueue'", async () => {
    const call = await bootOutbound();
    await call.feed(1660);
    await call.hangUp();
    expect(events("outbound_first_audio")).toEqual([expect.objectContaining({ from_answer_ms: 2010, measured: "enqueue" })]);
  });

  it("O-8: the slow-path clip is NOT seeded when it fires -- only when its end mark echoes", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // onset at 20 (confirmed at ~220)
    await call.feed(1240); // 1,640: past onset + 1,600
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([]);

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent).toEqual([{ turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false }]);
    await call.hangUp();
  });

  it("O-8: a slow-path clip cut by a barge is never seeded", async () => {
    const call = await bootOutbound();
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(400, { voiced: true });
    await call.feed(1240);
    await call.feed(600, { voiced: true }); // talks over the clip
    expect(clear).toHaveBeenCalled();
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent.filter(isSeed)).toEqual([]);
    await call.hangUp();
  });

  it("O-9: no first name -- the seed is the opener without its first-name sentence", async () => {
    const call = await bootOutbound({ database: outboundDb({ firstName: null }) });
    await call.feed(1660);
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: "It's Ava, an AI assistant from Digile Media." }] }], turnComplete: false },
    ]);
    await call.hangUp();
  });

  it("O-9: no first name and nothing usable left -- no clip; Live is asked to introduce itself with the disclosure", async () => {
    allowErrors("outbound_backstop_render_refused", "outbound_backstop_missing");
    const campaignConfig = { ...CAMPAIGN_CONFIG, opener: "Hi {first_name}, it's {persona_name}, an AI assistant from {business_name}." };
    const database = outboundDb({ firstName: null, campaignConfig });
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(1660);
    expect(enqueue).not.toHaveBeenCalled();
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    const [prompt] = call.live.sent.clientContent;
    expect(prompt.turns[0].parts[0].text).toContain("that you are Ava, an AI assistant from Digile Media.");
    expect(JSON.stringify(call.live.sent.clientContent)).not.toMatch(/\bnull\b|\bundefined\b/);
    await call.hangUp();
  });
});
