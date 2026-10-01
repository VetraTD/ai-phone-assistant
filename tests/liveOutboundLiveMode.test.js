/**
 * 2026-10-01 (spec 2026-10-01-outbound-live-first-line-design.md, plan Task 3):
 * the `live` first-speaker mode -- the new DEFAULT -- through the REAL Live
 * session (lib/voice/live/index.js) on tests/helpers/liveBoot.js's fake
 * vendors. No recorded opener: the AI's own live reply is the first thing
 * heard; silence gets a live "Hello?" heard at ~3 s; hold mutes the model.
 *
 * `clip` mode (the rollback) keeps its own suites, pinned with
 * OUTBOUND_FIRST_SPEAKER=clip (tests/liveOutboundStart.test.js and friends).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logged = vi.hoisted(() => []);
vi.mock("../lib/logger.js", async (importOriginal) => {
  const rec = (level) => (event, fields = {}) => {
    logged.push({ level, event, ...fields });
  };
  return { ...(await importOriginal()), log: { debug: rec("DEBUG"), info: rec("INFO"), error: rec("ERROR") } };
});

import { bootLive, fakeDb } from "./helpers/liveBoot.js";

let allowed = new Set();
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
const SID = "CAoutboundLive01";
const CALLER_ID = "+441372656055";
const CONTACT = "+15551230000";
const OPENER_AUDIO = Buffer.alloc(8000, 0x7f); // a stored clip that live mode must never play

const CONFIG = {
  businessId: BIZ,
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: CALLER_ID,
  timezone: "Europe/London",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: CALLER_ID,
  opener: "Hi, this is {persona_name}, an AI assistant calling from {business_name}. Am I speaking with {first_name}?",
  topic: "your enquiry",
  objective: "Qualify.",
  capabilities: ["qualification"],
  retries: { schedule: ["+0m"], voicemail_on: [] },
};

function outboundDb() {
  const base = fakeDb(CONFIG, BIZ);
  return {
    ...base,
    loadConfig: vi.fn(() => CONFIG),
    createCall: vi.fn(async () => "call-1"),
    fetchCallerContext: vi.fn(async () => null),
    addTranscriptEntry: vi.fn(async () => {}),
    mergeCallAnswers: vi.fn(async () => {}),
    setCallOutcomeCode: vi.fn(async () => {}),
    finishAttemptSession: vi.fn(async () => {}),
    fetchAttemptOpenerAudio: vi.fn(async () => OPENER_AUDIO),
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === SID ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 3 } : null
    ),
    withTenant: vi.fn(async (_id, fn) => fn()),
    withTenantSafe: vi.fn(async (_id, fn) => fn()),
    outboundCallContext: vi.fn(async () => ({
      attemptNo: 1,
      openerAudio: OPENER_AUDIO,
      toNumber: CONTACT,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 3,
      contactId: "contact-1",
      trigger: { source: "outbound-admin" },
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: CAMPAIGN_CONFIG,
      firstName: "Sam",
      contactTimezone: "America/Chicago",
    })),
    fetchBusinessById: vi.fn(async () => ({ id: BIZ, name: "Digile Media", timezone: "Europe/London", phone_number: CALLER_ID })),
    fetchBusinessCapabilities: vi.fn(async () => []),
  };
}

function bootLiveMode({ env = {}, database = outboundDb() } = {}) {
  return bootLive({ config: CONFIG, callSid: SID, env, customParameters: { direction: "outbound" }, authorizedCallSid: SID, database });
}

/** 24 kHz PCM16 as the model sends it. */
function modelAudioMsg(ms = 200) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data: buf.toString("base64") } }] } } };
}

const helloCues = (call) =>
  call.live.sent.clientContent.filter((c) => JSON.stringify(c).includes('word for word: \\"Hello?\\"'));
const KICK_TEXT = "(The caller has just connected. Open the call now.)";

describe("live mode is the default (OUTBOUND_FIRST_SPEAKER unset)", () => {
  it("(a) builds the live controller, not the clip one; no kick; no clip audio is ever enqueued or fetched", async () => {
    const db = outboundDb();
    const call = await bootLiveMode({ database: db });
    expect(call.ws.liveFirstLine).toBeTruthy();
    expect(call.ws.liveDialFirstSeconds).toBeUndefined();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(2100); // silence, before the Hello is due
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    expect(JSON.stringify(call.live.sent.clientContent)).not.toContain(KICK_TEXT);
    expect(call.live.sent.clientContent).toEqual([]);
    await call.hangUp();
  });

  it("a typo still fails to clip (the rollback path), with the warn log", async () => {
    allowErrors("outbound_first_speaker_invalid");
    const call = await bootLiveMode({ env: { OUTBOUND_FIRST_SPEAKER: "lvie" } });
    expect(call.ws.liveFirstLine).toBeUndefined();
    expect(call.ws.liveDialFirstSeconds).toBeTruthy();
    expect(events("outbound_first_speaker_invalid")).toHaveLength(1);
    await call.hangUp();
  });
});

describe("silence -> a live 'Hello?'", () => {
  it("(c) the speakLine Hello turn is sent at 2,200 ms stream time, once", async () => {
    const call = await bootLiveMode();
    await call.feed(2180);
    expect(helloCues(call)).toHaveLength(0);
    await call.feed(40);
    expect(helloCues(call)).toHaveLength(1);
    await call.feed(1000);
    expect(helloCues(call)).toHaveLength(1);
    await call.hangUp();
  });

  it("(b) Live's first audio after the Hello reaches audioOut from its first chunk (nothing discarded)", async () => {
    const call = await bootLiveMode();
    await call.feed(2300);
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    expect(events("outbound_first_reply")).toEqual([
      expect.objectContaining({ path: "silence_hello", attemptId: "att-1", from_speech_end_ms: null }),
    ]);
    await call.hangUp();
  });

  it("speech first: no Hello at all, and Live's reply plays as soon as it starts", async () => {
    const call = await bootLiveMode();
    await call.feed(400);
    await call.feed(600, { voiced: true });
    await call.feed(1400);
    expect(helloCues(call)).toHaveLength(0);
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    const [fr] = events("outbound_first_reply");
    expect(fr).toMatchObject({ path: "speech" });
    expect(fr.from_speech_end_ms).toBeGreaterThanOrEqual(1300);
    expect(fr.from_speech_end_ms).toBeLessThanOrEqual(1500);
    await call.feed(10000);
    expect(helloCues(call)).toHaveLength(0);
    await call.hangUp();
  });
});

describe("Review Focus 1: the person talks over the AI's first reply", () => {
  it("(d) the vendor's `interrupted` clears the forwarded audio in live mode", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1200);
    call.live.push(modelAudioMsg(2000));
    await call.settle();
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(400, { voiced: true });
    call.live.push({ serverContent: { interrupted: true } });
    await call.settle();
    expect(clear).toHaveBeenCalled();
    await call.hangUp();
  });
});

describe("hold", () => {
  it("(e) on hold the silence ladder does not fire, even at 40 s; model audio is muted", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    await call.assistantTurn("Hi, this is Ava, an AI assistant calling from Digile Media. Am I speaking with Sam?");
    call.live.push(modelAudioMsg());
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } });
    await call.settle();
    call.ws.liveFirstLine.enterHold(call.clock());
    const before = call.live.sent.clientContent.length;
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(40000);
    expect(call.live.sent.clientContent.length).toBe(before); // no nudge, no goodbye
    call.live.push(modelAudioMsg()); // Live chatting to the music
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();
    await call.hangUp();
  });

  it("hold timeout at 120 s ends the call and records outcome other / 'hold timeout'", async () => {
    const db = outboundDb();
    const call = await bootLiveMode({ database: db });
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } });
    await call.settle();
    call.ws.liveFirstLine.enterHold(call.clock());
    await call.feed(121000);
    await call.settle();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(SID, "other");
    expect(db.mergeCallAnswers).toHaveBeenCalledWith(SID, { _outcome_note: "hold timeout" });
    expect(events("live_session_end").length + events("outbound_hold_timeout").length).toBeGreaterThan(0);
    expect(call.ws.readyState === 3 || events("outbound_hold_timeout").length === 1).toBe(true);
  });

  it("release mid-generation flushes the muted start of the reply to the new person", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } });
    await call.settle();
    call.ws.liveFirstLine.enterHold(call.clock());
    await call.feed(5000);
    await call.feed(600, { voiced: true }); // a person picks up
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    call.live.push(modelAudioMsg(400)); // Live answers before its transcript lands
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();
    await call.callerSays("Hello? This is Sam.");
    expect(call.ws.liveFirstLine.onHold()).toBe(false);
    expect(enqueue).toHaveBeenCalled(); // the muted start, flushed
    await call.hangUp();
  });
});

describe("hold: what the model does while nobody is on the line", () => {
  async function onHold(database = outboundDb()) {
    const call = await bootLiveMode({ database });
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } });
    await call.settle();
    call.ws.liveFirstLine.enterHold(call.clock());
    return call;
  }

  it("end_call to the hold music is refused, with the hold wording", async () => {
    const call = await onHold();
    const [r] = await call.callTool("end_call", {});
    expect(r.response).toMatchObject({ success: false });
    expect(r.response.message).toContain("you are on hold");
    expect(events("outbound_unheard_tool_refused")).toEqual([expect.objectContaining({ tool: "end_call" })]);
    await call.hangUp();
  });

  it("a muted generation leaves no AI transcript row", async () => {
    const db = outboundDb();
    const call = await onHold(db);
    db.addTranscriptEntry.mockClear();
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("La la la, I'm still waiting here.");
    const aiRows = db.addTranscriptEntry.mock.calls.filter((c) => JSON.stringify(c).includes("still waiting here"));
    expect(aiRows).toEqual([]);
    await call.hangUp();
  });

  it("a muted generation whose TEXT arrives before any audio leaves no AI row either", async () => {
    const db = outboundDb();
    const call = await onHold(db);
    db.addTranscriptEntry.mockClear();
    await call.assistantTurn("Hello? Is anyone there? I'm waiting.");
    const aiRows = db.addTranscriptEntry.mock.calls.filter((c) => JSON.stringify(c).includes("Is anyone there"));
    expect(aiRows).toEqual([]);
    await call.hangUp();
  });
});

describe("Live unresponsive: what counts as Live answering", () => {
  it("a tool call before any audio (confirm_identity on 'Sam speaking') re-arms the deadline", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(4000);
    await call.callTool("set_call_intent", { intent: "general_question" });
    await call.feed(4000); // 8.5 s past their speech, 4 s past the tool call
    expect(events("outbound_live_unresponsive")).toHaveLength(0);
    await call.hangUp();
  });

  it("a hang-up before any reply still logs one outbound_first_reply, path none", async () => {
    const call = await bootLiveMode();
    await call.feed(1000);
    await call.hangUp();
    expect(events("outbound_first_reply")).toEqual([expect.objectContaining({ path: "none", from_answer_ms: null })]);
  });
});

describe("Review Focus 3: a machine answers before AMD reports", () => {
  it("(f) once the stream stops (AMD redirected the call to the voicemail <Play>), no further Live audio is forwarded", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    const sent = [];
    call.ws.send = (m) => sent.push(m);
    call.ws.deliver({ event: "stop", stop: {} });
    await call.settle();
    call.live.push(modelAudioMsg(1000));
    await call.settle();
    await call.feed(200);
    expect(sent.filter((m) => String(m).includes('"event":"media"'))).toEqual([]);
  });
});

describe("Review Focus 4: 'Hi' just as the Hello is due", () => {
  it("speech at 2.0-2.4 s (onset confirmed before the 2.2 s cue) -> no Hello, exactly one AI turn", async () => {
    const call = await bootLiveMode();
    await call.feed(1980);
    await call.feed(400, { voiced: true });
    await call.feed(1000);
    expect(helloCues(call)).toHaveLength(0);
    await call.hangUp();
  });
});

describe("Live unresponsive", () => {
  it("the person speaks and Live never answers: ends at 6 s past their speech, ERROR, no recorded fallback", async () => {
    allowErrors("outbound_live_unresponsive");
    const call = await bootLiveMode();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(500, { voiced: true });
    await call.feed(5800);
    expect(events("outbound_live_unresponsive")).toHaveLength(0);
    await call.feed(400);
    expect(events("outbound_live_unresponsive")).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("finish(): the §13.4 silent verdict and first audio in live mode (ruling R8)", () => {
  it("a reply 1.4 s after the person's speech is not silent, and first_audio_ms is recorded", async () => {
    const db = outboundDb();
    const call = await bootLiveMode({ database: db });
    await call.feed(500, { voiced: true });
    await call.feed(1400);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.hangUp();
    await vi.waitFor(() => expect(db.finishAttemptSession).toHaveBeenCalled());
    const [, args] = db.finishAttemptSession.mock.calls[0];
    expect(args.silent).toBe(false);
    expect(typeof args.firstAudioMs).toBe("number");
  });

  it("speech, then 2.5 s of nothing and a hang-up -> silent", async () => {
    const db = outboundDb();
    const call = await bootLiveMode({ database: db });
    await call.feed(500, { voiced: true });
    await call.feed(2600);
    await call.hangUp();
    await vi.waitFor(() => expect(db.finishAttemptSession).toHaveBeenCalled());
    expect(db.finishAttemptSession.mock.calls[0][1]).toMatchObject({ silent: true, firstAudioMs: null });
  });
});
