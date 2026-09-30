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
import { readFileSync } from "node:fs";

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
import { BACKSTOP_END_MARK, FIRST_AUDIO_MARK, CLIP_CALLER_HOLD_MAX_MS, CLIP_HOLD_DELAY_LINE_MS } from "../lib/outbound/firstSeconds.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { detectOptOut } from "../lib/outbound/detectors.js";
import { createPostCall } from "../lib/outbound/postCall.js";
import { ComplianceViolationError } from "../lib/compliance.js";
import * as realDb from "../services/db.js";
import { mulaw8kToPcm16k } from "../lib/voice/resample.js";

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
    // Stage 4 S4-2: the unverified-opt-out marker write (calls.answers).
    mergeCallAnswers: vi.fn(async () => {}),
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

function bootOutbound({ database = outboundDb(), env = {}, customParameters = { direction: "outbound" }, authorizedCallSid = SID, callSid = SID, waitForConnect = true, postCall, clipDrainMaxMs, clipDrainSettleMs, clipHoldStt, clipHoldSttTimeoutMs, connectGate } = {}) {
  return bootLive({ config: CONFIG, callSid, env, customParameters, authorizedCallSid, database, waitForConnect, postCall, clipDrainMaxMs, clipDrainSettleMs, clipHoldStt, clipHoldSttTimeoutMs, connectGate });
}

/** 24 kHz PCM16 as the model sends it: enough for several 20 ms mu-law frames. */
function modelAudioMsg(ms = 200) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data: buf.toString("base64") } }] } } };
}

// ---------------------------------------------------------------------------
// F-R2 (half-2 controller analysis). A minimal model of Gemini Live's OWN
// server-side VAD/end-of-turn detection, for the "the stale hello's reply
// escapes the clip discard" tests below. It decides a turn is over, and
// replies, only once it has RECEIVED -- via the REAL sendRealtimeInput call
// index.js makes, never a test-driven push -- at least LIVE_VAD_SILENCE_MS
// of TRAILING non-voiced audio since the last voiced chunk. This is the one
// thing every existing test in this file does NOT model: they all push
// modelAudioMsg() at a moment the TEST chooses, decoupled from what audio
// Live actually received, which is exactly why none of them could catch
// F-R2 (Live's reply to the hello is driven by what reaches its own ASR/VAD,
// not by test timing).
// ---------------------------------------------------------------------------
const LIVE_VAD_SILENCE_MS = 700;

/** Decode one sendAudio chunk (PCM16 LE, 16 kHz -- sendAudio's own encoding) to a peak amplitude. */
function pcmPeak(base64) {
  const buf = Buffer.from(base64, "base64");
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Arms `call.live` to behave like Live's own server-side VAD. Reads ONLY
 * `call.live.sent.audioIn` (every real sendRealtimeInput({audio}) call, in
 * order -- see fakeLive()'s own doc comment in tests/helpers/liveBoot.js),
 * never the test's own {voiced} intent -- the whole point is to prove what
 * lib/voice/live/index.js's hold/delay-line/gate routing ACTUALLY delivered.
 *
 * The synthesized reply fires on a LATER tick (setImmediate), deliberately
 * never reentrant in the same call stack as the audio that crossed the
 * threshold: a real network round trip is never synchronous with the send
 * that triggers it, and a same-stack push would, by chance, dodge the exact
 * race this test exists to reproduce -- firstSeconds.js's own C1
 * refreshStaleSnapshot (the seed callback) re-checks `generationOpen` at the
 * instant the seed callback RETURNS, not before, so a reentrant push from
 * inside that same callback would win a race a real (asynchronous) vendor
 * reply cannot win.
 */
function armServerVadReply(call, { silenceMs = LIVE_VAD_SILENCE_MS, msg = () => modelAudioMsg() } = {}) {
  let trailingSilenceMs = 0;
  let fired = false;
  const audioIn = call.live.sent.audioIn;
  const realPush = audioIn.push.bind(audioIn);
  audioIn.push = (audio) => {
    realPush(audio);
    if (fired) return;
    const voiced = pcmPeak(audio.data) > 4000; // VOICED_FRAME decodes to ~32124; SILENCE_FRAME to 0
    trailingSilenceMs = voiced ? 0 : trailingSilenceMs + 20; // one 20 ms mu-law frame per chunk
    if (trailingSilenceMs >= silenceMs) {
      fired = true;
      setImmediate(() => call.live.push(msg()));
    }
  };
  // Final wave W1: a handle, so a test can ask whether Live's end-of-turn
  // fired (and when, on the session clock) -- ignored by the older callers.
  return { fired: () => fired };
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

// ---------------------------------------------------------------------------
// Task 16, mechanical ruling (spec §9.5/§13.2). The LVX23 bisect arm
// (LIVE_PROMPT=minimal, lib/voice/live/minimalPrompt.js) predates outbound
// calling and carries no AI disclosure, no first-turn rule and no OUTBOUND
// CALL block. An outbound call must never run without those, so direction
// wins over the experiment flag outright. tests/liveBisectArms.test.js keeps
// proving the flag still shrinks the prompt on INBOUND, unchanged.
// ---------------------------------------------------------------------------
describe("outbound: LIVE_PROMPT=minimal is ignored (spec §13.2, mechanical ruling)", () => {
  it("still connects with the full instruction, including the OUTBOUND CALL block, and logs that the flag was ignored", async () => {
    const database = outboundDb();
    const { out: call, events: logEvents } = await logsDuring(() => bootOutbound({ database, env: { LIVE_PROMPT: "minimal" } }));
    const { systemInstruction } = call.live.connect.mock.calls[0][0].config;
    const text = systemInstruction.parts[0].text;
    expect(text).toContain("=== OUTBOUND CALL ===");
    expect(text.length).toBeGreaterThan(2000);
    expect(logEvents("live_outbound_minimal_prompt_ignored")).toHaveLength(1);
    expect(logEvents("live_bisect_arm")).toHaveLength(0);
    await call.hangUp();
  });
});

describe("outbound: the first seconds through the real session", () => {
  // CHANGED (S3-2, P-a): 1,640/1,650 -> 1,380/1,400 -- silenceBackstopMs's
  // default moved from 2,000 to 1,750, so the stream-clock fire time moved
  // with it (silenceBackstopMs - answerToStreamMs).
  it("silence: the backstop clip is queued at 1,400 ms and seeded as Live's own turn (S1)", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(1380);
    expect(enqueue).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toEqual([]);

    await call.feed(20);
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);
    await call.hangUp();
  });

  // CHANGED (S3-2, S3-D2): this used to test the OLD race (Live's own reply
  // preempts the backstop). Clip mode (the new default) never lets Live speak
  // first: the reply above is now discarded, and the clip still plays, at the
  // hello-end timer (helloEndGapMs after the hello ends). The stale-discard
  // wait (named risk 1) is proven here too -- a SECOND model-audio message,
  // pushed after the clip's own end mark echoes, is STILL discarded, because
  // the first one's generation never reported turnComplete/interrupted.
  it("the person says hello first: Live's reply is discarded (never played); the clip still plays via the hello-end timer", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // a hello; onset backdated to ~20 ms
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled(); // discarded, not played
    expect(call.live.sent.clientContent).toEqual([]);

    await call.feed(400); // the hello ends; helloEndGapMs (350 ms) later, the clip fires
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([]); // not seeded yet -- O-8, deferred to the end mark

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);

    // The FIRST reply's generation never closed (no turnComplete/interrupted
    // was ever sent for it), so it is still stale: nothing new plays.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await call.hangUp();
  });

  // C1, item 5 (fix round 2, re-review's remaining gap). The test above
  // pushes Live's chunk BEFORE the clip is queued -- the narrow case even
  // the queue-time-only snapshot already caught. This is the REALISTIC
  // hello timing the re-review's own probe used: NOTHING is open at the
  // moment the clip queues (Live's voice-to-voice latency is normally
  // longer than helloEndGapMs), and Live's reply only starts generating
  // afterwards, still before the seed (which the hello-end path defers to
  // the end-mark echo). Through the REAL session this time, not just the
  // pure controller.
  it("C1: a real session -- Live's first chunk arrives AFTER the clip is queued (before the seed); zero stale chunks reach the socket", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues via the hello-end timer
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([]); // not seeded yet -- deferred to the end mark (O-8)

    // Live's reply to the hello starts generating only NOW -- nothing was
    // open at the instant the clip queued.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1); // discarded, not forwarded

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } }); // the seed goes now; C1 re-checks fresh
    call.live.push(modelAudioMsg()); // more of the SAME generation, after the mark too
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1); // still zero stale chunks reached the socket

    await call.turnEnds(); // it finally closes
    call.live.push(modelAudioMsg());
    await call.settle();
    // A NEW generation, now trusted -- forwarded as many small framer-sized
    // enqueue calls (200 ms of audio), on top of the clip's own single call.
    expect(enqueue.mock.calls.length).toBeGreaterThan(1);
    await call.hangUp();
  });

  // CHANGED (item 3, fix round 2): a turnEnds() now sits between the mark
  // echo and the second push. Before item 3, the first chunk's generation
  // was simply forgotten the instant the mark echoed, so a SECOND push of
  // the SAME (never-closed) generation played -- indistinguishable, at the
  // controller level, from the exact partial-generation defect item 3 fixes
  // (a caller's "yes" mid-clip, dropped head, forwarded tail). Closing the
  // first generation before the second one arrives is what a real session
  // does (Gemini always bounds a generation with turnComplete/interrupted
  // before starting the next), and is what now makes the second push
  // trusted.
  it("model audio while the backstop plays is dropped until the backstop-end mark echoes AND that generation closes, then a NEW one plays", async () => {
    const call = await bootOutbound();
    await call.feed(1400);
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    call.live.push(modelAudioMsg()); // the SAME generation continuing: still stale
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    await call.turnEnds(); // it closes
    call.live.push(modelAudioMsg()); // a NEW generation
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.hangUp();
  });

  it("the backstop is interruptible: a barge past CLIP_BARGE_MIN_MS clears it like any assistant audio, the mark never echoes, and Live's answer PLAYS", async () => {
    const call = await bootOutbound();
    await call.feed(1400);
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    // Suppressed while the clip plays -- the state the barge has to undo.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    // The person talks over the clip: a sustained voiced run past
    // CLIP_BARGE_MIN_MS (600 ms, S3-2 -- higher than the ordinary 300 ms
    // threshold while our own clip is playing), with margin.
    await call.feed(900, { voiced: true });
    expect(clear).toHaveBeenCalled();

    // No `outbound-backstop-end` mark is ever delivered. Live answers them.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.hangUp();
  });

  // The SAME barge, but shorter than CLIP_BARGE_MIN_MS: a "hello" said back at
  // the clip must not stop it (S3-2).
  it("a short caller run (under CLIP_BARGE_MIN_MS) during the clip does not clear it", async () => {
    const call = await bootOutbound();
    await call.feed(1400);
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(400, { voiced: true }); // well under 600 ms
    expect(clear).not.toHaveBeenCalled();
    await call.hangUp();
  });

  // ---------------------------------------------------------------------
  // C1 (Critical, checkpoint-A review). The ordinary half-duplex gate
  // (lib/voice/live/halfDuplex.js, a 500 ms ring tuned for Live's OWN short
  // reply) was dropping a caller's whole utterance said during the opener
  // clip: confirmed on 3 real sim calls, the gate held it, evicted it as the
  // multi-second clip kept playing, and it never reached Live's ASR at all
  // -- including a gatekeeper's "He's out." (live_utterance{
  // playing_at_open:true, forwarded:0, dropped_voiced:16}). index.js now
  // bypasses that gate entirely, for outbound only, while the clip's own
  // audio is on the wire, and holds the caller's frames itself, releasing
  // them to Live the instant the seed goes out -- never before, so Live's
  // context reads [opener][what the caller said].
  // ---------------------------------------------------------------------
  it("C1 fix: caller speech during the clip reaches Live, in order, only after the seed", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true }); // a hello; onset confirmed
    await call.feed(400); // the hello ends; the clip queues via the hello-end timer (deferred seed, O-8)
    expect(call.live.sent.clientContent).toEqual([]); // not seeded yet

    // The gatekeeper keeps talking while the clip is STILL playing -- the
    // checkpoint-A shape ("He's out. Try tomorrow at ten."), well under
    // CLIP_BARGE_MIN_MS (600 ms) so it must not barge the clip either.
    const beforeSeed = call.live.sent.audioIn.length;
    await call.feed(320, { voiced: true });
    expect(call.live.sent.audioIn.length).toBe(beforeSeed); // held -- zero reached Live before the seed

    // The clip finishes; the seed goes now (O-8's own end-mark timing).
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);
    // The held frames reach Live now -- after the seed, never before.
    expect(call.live.sent.audioIn.length).toBeGreaterThan(beforeSeed);
    await call.hangUp();
  });

  it("C1 fix: an utterance AFTER the clip has ended is unaffected -- the ordinary gate forwards it as before", async () => {
    // The mark this test never delivers is expected to time out (M9) once
    // clipPlayingUntil passes -- that IS how clipPlaying lapses here.
    allowErrors("outbound_backstop_mark_timeout");
    const call = await bootOutbound();
    await call.feed(1400); // the silence backstop fires and plays (seed at once, no generation open)
    // CHANGED (final wave W1, F10 -- N5): speech said DURING the clip is now
    // unique frames, and must reach Live once the clip's own M9 bound lapses
    // (release point 3) -- the old assertion (audioIn merely grew) passed
    // whether or not the hold was ever released.
    const held = patternFrames([[300, true]]);
    await call.feedFrames(held.frames.map((f) => f.buf));
    // Let the clip's own (real, audioOut-timed) playback AND clipPlaying's
    // own M9 bound both lapse naturally -- OPENER_AUDIO is 1 s + markGraceMs
    // (1.5 s) = 2.5 s from fire; 2.3 s more of silence clears both without
    // needing the mark event this test is not about.
    await call.feed(2300);
    const heldIds = call.live.sent.audioIn.map((a) => held.byPcm.get(a.data)?.id).filter((x) => x !== undefined);
    expect(heldIds).toEqual(held.frames.map((f) => f.id)); // every held frame, in order, once
    const before = call.live.sent.audioIn.length;
    await call.feed(200, { voiced: true }); // ordinary caller speech, well after the clip
    // Forwarded frame-by-frame in real time -- no waiting for anything.
    expect(call.live.sent.audioIn.length).toBeGreaterThan(before);
    await call.hangUp();
  });

  // CHANGED (final wave W1, F10 -- checkpoint-A re-review N5): this used to
  // assert only that audioIn GREW, which frames forwarded in real time after
  // the barge satisfy whether or not the HELD lead-in was ever released. The
  // held frames are now unique and must each reach Live, in order.
  it("C1 fix: a real barge while speech is still held releases it too -- the seed for this clip is abandoned for good", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)

    // A genuine barge: sustained speech past CLIP_BARGE_MIN_MS (600 ms). The
    // clip is cleared and the seed for it is abandoned (giveUpOnSeed) -- the
    // lead-in speech held up to that point must still reach Live, not be
    // stranded waiting for a seed that will never come.
    const { frames, byPcm } = patternFrames([[900, true]]);
    await call.feedFrames(frames.map((f) => f.buf));
    const ids = call.live.sent.audioIn.map((a) => byPcm.get(a.data)?.id).filter((x) => x !== undefined);
    const leadIn = frames.slice(0, 20).map((f) => f.id); // the first 400 ms: held until the barge fired at ~600 ms
    for (const id of leadIn) expect(ids).toContain(id);
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b));
    await call.hangUp();
  });

  it("C1 fix: held audio is bounded by CLIP_CALLER_HOLD_MAX_MS -- past the cap the OLDEST frames are dropped, counted, never unbounded", async () => {
    clearStats();
    // A long clip (well past the cap) so the M9 mark-timeout cannot fire
    // first and mask the cap: this test is specifically about the explicit
    // duration bound, not the mark-echo safety net.
    const LONG_OPENER_AUDIO = Buffer.alloc(8 * 12_000, 0x7f); // 12 s of clip audio
    const call = await bootOutbound({ database: outboundDb({ openerAudio: LONG_OPENER_AUDIO }) });
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)
    expect(call.live.sent.clientContent).toEqual([]);
    // Taken right as the clip fires: everything up to here (the hello
    // itself) was forwarded in real time by the ORDINARY gate, before any
    // holding starts -- not part of what the cap bounds.
    const beforeHold = call.live.sent.audioIn.length;

    // Hold the caller's audio open far longer than the cap, in short voiced
    // bursts separated by brief silence so no single run ever crosses
    // CLIP_BARGE_MIN_MS (600 ms) and clears the clip early.
    const capFrames = Math.ceil(CLIP_CALLER_HOLD_MAX_MS / 20);
    let heldMs = 0;
    while (heldMs < CLIP_CALLER_HOLD_MAX_MS + 3000) {
      await call.feed(400, { voiced: true });
      await call.feed(40);
      heldMs += 440;
    }
    const counters = getLatencyStats().turnTaking;
    expect(counters.outbound_clip_hold_dropped).toBeGreaterThan(0);

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent.length).toBe(1); // the seed still went
    // Released, but never more than the cap's own worth of HELD frames.
    // CHANGED (final wave W1, A15): after a latch the silence between voiced
    // runs goes through the delay line, not the hold, and the release
    // flushes that line after the hold -- at most CLIP_HOLD_DELAY_LINE_MS
    // more (its own, separate bound), never unbounded.
    const released = call.live.sent.audioIn.length - beforeHold;
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThanOrEqual(capFrames + Math.ceil(CLIP_HOLD_DELAY_LINE_MS / 20));
    await call.hangUp();
  });

  // ---------------------------------------------------------------------
  // Checkpoint-A re-review, fix round 2.
  // ---------------------------------------------------------------------

  // N1 (Important). The fix round 1 report claimed "tick() is the only
  // place [the M9 mark-timeout] transition is visible from out here" -- the
  // re-review's own probe (P-B) disproved it: firstSeconds.js's onModelAudio
  // calls the SAME checkClipPlayingTimeout tick() does, and a Live audio
  // chunk arriving between two Twilio media frames can fire M9 (and abandon
  // the seed) with nothing in onMediaFrame ever seeing it at the instant it
  // happens. Round 1's release logic (clipPlaying() snapshotted only around
  // this file's own onCallerFrame/tick() calls) never caught this, and the
  // held buffer -- possibly including an opt-out -- was stranded forever.
  it("N1 fix (checkpoint-A re-review): a held run survives an M9 lapse triggered by onModelAudio, not just tick()", async () => {
    allowErrors("outbound_backstop_mark_timeout");
    const call = await bootOutbound();
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues via the hello-end timer (deferred seed, O-8)
    expect(call.live.sent.clientContent).toEqual([]); // not seeded yet

    const beforeHold = call.live.sent.audioIn.length;
    // The gatekeeper's own words, held during the clip -- well under
    // CLIP_BARGE_MIN_MS, matching the re-review's own probe (~480 ms).
    await call.feed(480, { voiced: true });
    expect(call.live.sent.audioIn.length).toBe(beforeHold); // held, not forwarded

    // Advance the clock past clipPlayingUntil (clip length 1,000 ms +
    // markGraceMs 1,500 ms = 2,500 ms from fire) WITHOUT feeding another
    // media frame, so tick() never runs and cannot be the one to notice M9.
    await call.starve(3000);

    // Live produces a chunk. onModelAudio's OWN checkClipPlayingTimeout call
    // is what fires M9 here, not tick() -- reproducing the re-review's
    // probe P-B (clipPlayingAfterChunk:false, m9:1, held_release:[]).
    call.live.push(modelAudioMsg());
    await call.settle();

    // The next Twilio media frame -- which never stops arriving on a real
    // call regardless of any mark or model event -- is what makes the
    // release observable. Round 1 had nothing to catch this transition
    // outside tick(), so the held burst stayed stuck in the buffer forever.
    await call.feed(20);

    expect(call.live.sent.audioIn.length - beforeHold).toBeGreaterThanOrEqual(24); // 480 ms / 20 ms
    await call.hangUp();
  });

  // N2 (Important). On the silence path (backstop_silence, nobody spoke
  // before the deadline), the seed is sent immediately at fire -- while the
  // clip's own audio is still on the wire for up to another ~2.5 s. Round
  // 1 released the caller-audio hold the instant the seed went out, so
  // speech said during the clip reached Live in real time; the review's own
  // probe (P-A) showed Live's reply to that speech, generated before the
  // clip's audio had finished, was then discarded whole as a generation
  // "opened during the clip" (catchMidClipGeneration) -- the caller heard
  // the clip finish and then silence, never an answer. Fixed: hold until
  // the LATER of "seed sent" and "clip no longer playing" -- on this path
  // that is the clip ending, so the caller's words reach Live only once
  // nothing can mistake Live's eventual reply for a stale, mid-clip one.
  it("N2 fix (checkpoint-A re-review): on the silence path, speech during the clip is held until the clip has actually ended", async () => {
    const call = await bootOutbound();
    await call.feed(1400); // backstop_silence fires; seed sent immediately (no generation open)
    expect(call.live.sent.clientContent.length).toBe(1); // already seeded

    const beforeHold = call.live.sent.audioIn.length;
    // "Hello?" -- said while the clip (1 s of audio + 1.5 s mark grace from
    // fire) is still playing, well under CLIP_BARGE_MIN_MS.
    await call.feed(300, { voiced: true });
    // Round 1's bug, exactly: the seed was already sent, so this reached
    // Live in real time regardless of the clip still playing.
    expect(call.live.sent.audioIn.length).toBe(beforeHold);

    // The clip finishes.
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20); // the next Twilio frame is what actually releases it

    expect(call.live.sent.audioIn.length - beforeHold).toBeGreaterThanOrEqual(15); // 300 ms / 20 ms
    await call.hangUp();
  });

  // Item 4 (fix round 2, re-review out-of-scope observation 2). Four
  // TEXT-triggered cutters (greeting-respoken, repeat-cut, offer-unverified,
  // the leak guard) all route through clearAudio, and all four judge Live's
  // OWN output transcription -- which can belong to a generation whose audio
  // is being discarded while our clip is still on the wire (the cut-window
  // check, aiAudioPlayingUntil, counts the clip same as any other assistant
  // audio). None of them are judging the CLIP, so none of them may clear it.
  // The offer-unverified guard is the simplest to reach on an outbound call
  // (no caller-turn-count carve-out, unlike the greeting-echo guard, which
  // is disabled outright on outbound; the repeat-cut guard needs a prior
  // caller turn).
  it("item 4: a text-triggered cutter (the unverified-offer guard) does not clear the outbound clip", async () => {
    allowErrors("live_offer_unverified");
    const call = await bootOutbound();
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(1400); // the silence backstop fires and is playing
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);

    // A stale generation's own transcription arrives while the clip plays --
    // it matches the unverified-offer pattern (nothing has been verified on
    // this fresh session), which would otherwise clear whatever is on the
    // wire.
    await call.assistantSays("We have a slot available on Monday at 9 AM.");
    expect(clear).not.toHaveBeenCalled();
    await call.hangUp();
  });

  // NB4 (fix round 3, re-review 2). clearAudio no-ops while the clip
  // protects itself (just above) -- nothing was cut, so the guard's OWN
  // bookkeeping must say so too: an honest `cut: false` in the log, the
  // "missed" counter rather than the "cut" one, and the per-call cut budget
  // left unspent.
  // CHANGED (final wave W1, A16): this test's own scenario -- a transcript
  // fragment arriving while the clip plays, with no audio chunk -- used to
  // reach the offer guard, which then logged an honest `cut: false`. That
  // fragment belongs to a generation the caller will never hear (its audio
  // would be discarded: the clip is on the wire), and the guard reaching it
  // at all was the A16 gap (re-review 1 m5: a spoken note went out to Live
  // on exactly this shape). The guard is now not reached; NB4's own contract
  // -- no cut claimed, no cut counted, no budget spent -- holds a fortiori.
  it("NB4: the offer guard does not log a cut, bump the cut counter, or spend its budget when the clip protects the audio", async () => {
    clearStats();
    const call = await bootOutbound();
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(1400); // the silence backstop fires and is playing

    await call.assistantSays("We have a slot available on Monday at 9 AM.");
    expect(clear).not.toHaveBeenCalled();
    expect(events("live_offer_unverified")).toHaveLength(0); // A16: not reached at all

    const counters = getLatencyStats().turnTaking;
    expect(counters.live_offer_cuts ?? 0).toBe(0);
    expect(counters.live_offer_cut_missed ?? 0).toBe(0);
    await call.hangUp();
  });

  // CHANGED (I1, fix round 1): this test used to assert the OPPOSITE --
  // that a vendor `interrupted` lifts the suppression and Live's next audio
  // plays. That is exactly the defect I1 fixes: index.js:5286's own
  // `sc.interrupted` handler called `clearAudio` unconditionally, so a
  // "hello?" the gate forwarded to Live (below CLIP_BARGE_MIN_MS) or the
  // seed's own resulting `interrupted` could cut the clip before the
  // disclosure. Controller ruling: the vendor's `interrupted` must not clear
  // clip frames; only our own barge (clipBarge, >= CLIP_BARGE_MIN_MS) may.
  it("I1: the vendor's `interrupted` does NOT clear the clip -- only our own barge (clipBarge) can", async () => {
    const call = await bootOutbound();
    await call.feed(1400); // the silence backstop fires and is playing
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    call.live.push(modelAudioMsg()); // a generation opens while the clip plays
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled();

    call.live.push({ serverContent: { interrupted: true } }); // Live's own detector fires
    await call.settle();
    expect(clear).not.toHaveBeenCalled(); // the clip's audio is untouched

    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled(); // still stale -- clipPlaying() is still true
    await call.hangUp();
  });

  it("I1: the silence path defers the seed when a generation is already open at fire (Live replying to something our own VAD never confirmed)", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400); // silence so far; nothing our own onset detector confirms
    call.live.push(modelAudioMsg()); // Live is already generating a reply to SOMETHING
    await call.settle();
    await call.feed(1000); // through the silence deadline (1,400)
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO); // the clip still fires, on time
    expect(call.live.sent.clientContent).toEqual([]); // NOT seeded yet -- deferred (I1)

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent).toEqual([
      { turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false },
    ]);
    await call.hangUp();
  });

  it("no clip (render failed): the silence path prompts Live to say the line instead", async () => {
    allowErrors("outbound_backstop_missing");
    const call = await bootOutbound({ database: outboundDb({ openerAudio: null }) });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    const { events } = await logsDuring(() => call.feed(1400));
    expect(enqueue).not.toHaveBeenCalled();
    expect(call.live.sent.clientContent).toHaveLength(1);
    expect(call.live.sent.clientContent[0].turnComplete).toBe(true);
    expect(call.live.sent.clientContent[0].turns[0].role).toBe("user");
    expect(call.live.sent.clientContent[0].turns[0].parts[0].text).toContain(`The person hasn't spoken. Say: ${OPENER}`);
    expect(events("outbound_backstop_missing")).toHaveLength(1);
    await call.hangUp();
  });

  // Live mode (contract item 6): this specifically tests Live's OWN first
  // turn arriving BEFORE any clip exists -- a scenario clip mode (the new
  // default) no longer allows (Live never speaks first, S3-D2). Numbers
  // unchanged from before S3-2.
  it("first-turn check: an incomplete first reply gets one correction note", async () => {
    allowErrors("outbound_first_turn_incomplete");
    const call = await bootOutbound({ env: { OUTBOUND_FIRST_SPEAKER: "live" } });
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
    await call.feed(1400); // backstop fires at 1,400 (S3-2) and is playing
    // "Yes, speaking" -- 800 ms of speech over the clip, past CLIP_BARGE_MIN_MS (600 ms).
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

  // Live mode (contract item 6): "not the backstop" is the whole point of
  // this test -- Live's own reply IS the first audio, which clip mode (the
  // new default) no longer permits.
  it("I5 (checkpoint 2b review): a barge into LIVE'S OWN first reply -- not the backstop -- never corrects on that interrupted turn itself, only re-arms", async () => {
    allowErrors("outbound_first_turn_incomplete");
    const call = await bootOutbound({ env: { OUTBOUND_FIRST_SPEAKER: "live" } });
    // Speech onset with no clip yet: the slow-Live path, so Live's own reply
    // is the first audio and there is no backstop in play at all.
    await call.feed(400, { voiced: true });
    // The person barges before Live has said anything of the disclosure --
    // the vendor's own `interrupted`, not a local clearAudio on our clip.
    await call.assistantSays("Hi, is that Sam?");
    call.live.push({ serverContent: { interrupted: true } });
    await call.settle();

    const isNote = (m) =>
      m.turns?.[0]?.parts?.[0]?.text?.includes("Tell them now, briefly: you are Ava, an AI assistant from Digile Media.");
    // The interrupted turn never corrects itself -- an in-flight barge is not
    // the moment to talk over the caller a second time -- although its own
    // text plainly lacks the disclosure. (Without I5's guard, `clearAudio`'s
    // unconditional call on every interrupted turn happens to re-arm a
    // wrongly-queued mark too, which is why this assertion, not a chained
    // one, is what actually distinguishes the fixed wire from the broken
    // one.)
    expect(call.live.sent.clientContent.filter(isNote)).toHaveLength(0);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(0);

    // Still armed: Live's NEXT (complete) turn is judged on its own merits,
    // and this one also carries no disclosure -- proof the check was never
    // silently spent by the interrupted turn.
    await call.assistantTurn("Great, what's the clinic called?");
    expect(call.live.sent.clientContent.filter(isNote)).toHaveLength(1);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(1);
    await call.hangUp();
  });

  // CHANGED (S3-2, P-a): 1,240/1,260/1,660 -> 990/1,010/1,410 -- shifted by
  // the same -250 ms the deadline itself moved (BACKSTOP_REFETCH_LEAD_MS is
  // unchanged at 400 ms; the deadline it counts back from moved).
  it("I4: a clip stored AFTER pickup is re-read once before the deadline and played", async () => {
    const LATE = Buffer.alloc(4000, 0x55);
    const database = outboundDb({ openerAudio: null, lateOpenerAudio: LATE });
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(980); // before deadline - lead (990 is not a frame multiple of 20; bootLive's feed() rounds)
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    await call.feed(20); // 1,000: past 1,400 - 400
    expect(database.fetchAttemptOpenerAudio).toHaveBeenCalledTimes(1);
    expect(database.fetchAttemptOpenerAudio).toHaveBeenCalledWith("att-1");
    expect(database.withTenant.mock.calls.at(-1)[0]).toBe(BIZ);

    await call.feed(400); // through 1,400
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
    await call.feed(1400);
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(events("outbound_backstop_render_refused")).toHaveLength(1);
    await call.hangUp();
  });

  // M1 (fix round 1): an unrecognised OUTBOUND_FIRST_SPEAKER value fails
  // safe to "clip" (never "live"), logged once.
  it("M1: an unknown OUTBOUND_FIRST_SPEAKER value ('lvie') behaves as clip mode and logs outbound_first_speaker_invalid", async () => {
    allowErrors("outbound_first_speaker_invalid");
    const call = await bootOutbound({ env: { OUTBOUND_FIRST_SPEAKER: "lvie" } });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // a hello
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).not.toHaveBeenCalled(); // clip behaviour: Live never speaks first, not "live" mode's race
    expect(events("outbound_first_speaker_invalid")).toHaveLength(1);
    expect(events("outbound_first_speaker_invalid")[0]).toMatchObject({ value: "lvie" });
    await call.feed(400); // the hello ends; the clip still plays via the hello-end timer
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 (half-2 controller analysis, superseding the investigation's "6 s
  // dead air" reading). Round-1's D1 double-talk/re-ask is back, reintroduced
  // by checkpoint-A's clip hold, through a different door: the hold withholds
  // the caller's TRAILING SILENCE after a hello, not just their speech, so
  // Live's OWN end-of-turn VAD for the hello never fires DURING the clip --
  // only once the whole hold releases in one synchronous burst at the seed,
  // by which point the local stale-discard state has already lifted
  // (nothing was ever `generationOpen` for refreshStaleSnapshot to catch).
  // Live's reply to the STALE hello then reaches the caller right after the
  // clip, on top of them already answering it.
  // -------------------------------------------------------------------
  it("F-R2: Live's reply to the STALE hello never reaches the Twilio side after the clip", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    armServerVadReply(call);

    await call.feed(400, { voiced: true }); // a hello; onset confirmed
    await call.feed(400); // the hello ends; the clip queues via the hello-end timer (deferred seed, O-8)
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO); // the clip is playing
    expect(call.live.sent.clientContent).toEqual([]); // not seeded yet

    // The caller says nothing more: 1 s of silence while the clip plays --
    // comfortably inside clipPlayingUntil (clip length 1,000 ms + markGraceMs
    // 1,500 ms = 2,500 ms from fire).
    await call.feed(1000);

    // The clip finishes; the seed goes now (O-8's own end-mark timing).
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20); // let the deferred (setImmediate) reply, if any, settle
    await call.settle();

    // Live's reply to the STALE "Hello?" must never reach the caller: only
    // the clip's own single enqueue call, nothing after it.
    expect(enqueue).toHaveBeenCalledTimes(1);
    await call.hangUp();
  });

  // Invariant 4 (F-R2): the shadow line must measure again on a hello-end
  // call -- spec S3-D2's "logged on every call", currently dead (the
  // investigation's own finding) because the hold prevents Live from ever
  // generating DURING the window logShadow measures.
  // CHANGED (final wave W1, F14 -- F-R2 review M3): the value is pinned now,
  // not just "not null" -- from the fake's own reply time, net of the clip
  // delay line (A8), which is reported alongside.
  it("F-R2 invariant 4: a hello-end call logs a real outbound_live_shadow.from_speech_ms, not null", async () => {
    const call = await bootOutbound();
    let replyAt = null;
    armServerVadReply(call, {
      msg: () => {
        replyAt = call.clock();
        return modelAudioMsg();
      },
    });

    await call.feed(400, { voiced: true }); // a hello: voiced frames at 20..400 (onset backdated to 20)
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)
    await call.feed(1000); // the caller says nothing more while the clip plays
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    await call.settle();
    await call.hangUp(); // onSessionEnd() -> logShadow()

    const shadow = events("outbound_live_shadow");
    expect(shadow).toHaveLength(1);
    expect(replyAt).not.toBeNull();
    expect(shadow[0]).toMatchObject({
      from_speech_ms: replyAt - 20 - CLIP_HOLD_DELAY_LINE_MS,
      from_speech_end_ms: replyAt - 400 - CLIP_HOLD_DELAY_LINE_MS,
      delay_line_adjust_ms: CLIP_HOLD_DELAY_LINE_MS,
      discarded_chunks: 1,
      reason: "measured",
    });
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 1 (opus review). I1: routeClipFrame latched the hold on
  // ANY raw voiced frame -- one loud 20 ms frame (a click, a cough, an early
  // second "Hello?"), or a backstop_slow greeting already mid-utterance when
  // the clip fired, brought the D1 double-talk/re-ask defect back in full,
  // because everything from that frame on was captured whole again and
  // Live's end-of-turn for the already-suppressed generation never fired
  // during the clip. Fixed: routeClipFrame now latches only on voiceActive
  // (the VAD's SUSTAINED/confirmed flag, O-6's own onset-confirm notion),
  // never on raw voiced alone.
  // -------------------------------------------------------------------
  // Both tests below assert TWO things, directly rather than through
  // armServerVadReply's own reconstructed timing (which has its own
  // ~CLIP_HOLD_DELAY_LINE_MS pipeline lag before a reset is even visible to
  // it, easy to miscalibrate against): (1) the ROUTING decision itself --
  // audioIn keeps growing after the blip, proving it never latched the
  // whole-clip hold -- and (2) the END-TO-END discard -- Live's reply to the
  // stale hello, pushed directly (the same style the committed C1/F-R2 tests
  // already use), still never reaches the caller. Together these are the
  // reviewer's own P1 probe shape without depending on precisely
  // reconstructing when a fake Live would perceive the blip.
  //
  // Fix round 2 (NB2): a raw voiced frame now latches PROVISIONALLY (a
  // SEPARATE buffer, not the delay line) for up to CLIP_CONFIRM_WINDOW_MS
  // (800 ms) before un-latching if it never confirms -- so both tests feed
  // enough silence AFTER the blip/burst to cross that window (not just
  // CLIP_HOLD_DELAY_LINE_MS, which no longer governs a voiced frame's own
  // fate at all) and observe the un-latch release.
  it("F-R2 fix round 1/2, I1/NB2: one loud frame early in the clip does not latch the hold (a click, not speech)", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);

    await call.feed(100); // some silence into the clip
    const beforeBlip = call.live.sent.audioIn.length;
    await call.feed(20, { voiced: true }); // ONE loud 20 ms frame -- a click, not speech
    // The provisional window starts AT the blip frame, not after the earlier
    // silence: 20 ms (the blip itself) + 800 ms more silence = 820 ms since
    // the provisional latch, comfortably past CLIP_CONFIRM_WINDOW_MS (800 ms)
    // -- the provisional latch times out unconfirmed and releases back to Live.
    await call.feed(800);

    // Proof the click never latched the whole-clip hold: it un-latched and
    // released instead -- the pre-fix defect starved Live of everything from
    // this point on, forever, with nothing ever un-latching.
    expect(call.live.sent.audioIn.length).toBeGreaterThan(beforeBlip);

    // Live's reply to the STALE hello, generated only now, is still
    // correctly recognised as stale and discarded.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1); // still just the clip

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await call.hangUp();
  });

  it("F-R2 fix round 1/2, I1/NB2: a cough-length voiced burst (under the confirm threshold) does not latch the hold either", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(400, { voiced: true });
    await call.feed(400);
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);

    await call.feed(200); // some silence into the clip
    const beforeBurst = call.live.sent.audioIn.length;
    await call.feed(100, { voiced: true }); // a 100 ms (5-frame) burst -- a cough, under CLIP_CONFIRM_VOICED_FRAMES (11)
    // 750 ms more silence: 100 + 750 = 850 ms since the burst started,
    // comfortably past CLIP_CONFIRM_WINDOW_MS (800 ms).
    await call.feed(750);

    expect(call.live.sent.audioIn.length).toBeGreaterThan(beforeBurst);

    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1);

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 1 (opus review). I2: a discarded (stale) generation's
  // TEXT still ran the whole turn pipeline as if Ava had said it -- an AI
  // transcript row (BEFORE the opener's own seed row), the outbound turn
  // detectors/counters, and the note-sending text guards (which can send
  // Live a note whose spoken reply may itself land after the seed, the F-R2
  // symptom through a new door). Fixed: dialFirstSeconds.onAssistantTurnText
  // now returns `heard` (false when any chunk of the generation's audio was
  // discarded), gating the transcript row and the outbound detectors; the
  // streaming guards are gated on dialFirstSeconds.droppedThisGeneration()
  // at the moment their text arrives (NOT suppressing() -- see NB4), which
  // since final wave W1 (A16) is also set by text arriving while Live's
  // audio would be discarded.
  // -------------------------------------------------------------------
  it("F-R2 fix round 1, I2 (sink 1): a discarded stale generation's text is never persisted as an AI transcript row", async () => {
    const database = outboundDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)

    // The stale generation: audio discarded (staleDiscard/clipPlaying still
    // true), AND its transcript text arrives too -- this is what makes the
    // text-side sinks reachable at all.
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantSays("Just to confirm, am I speaking with Sam?");
    await call.turnEnds(); // turnComplete for the STALE generation

    const aiRows = database.addTranscriptEntry.mock.calls.filter(([, speaker]) => speaker === "ai");
    expect(aiRows).toHaveLength(0);
    await call.hangUp();
  });

  it("F-R2 fix round 1, I2 (sink 2): a discarded stale generation never trips the outbound turn detectors", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400);

    call.live.push(modelAudioMsg());
    await call.settle();
    // CAMPAIGN_CONFIG.topic === "your enquiry"; detectOutboundTurn's
    // topicToUnverified fires on an unverified party naming the campaign's
    // own topic -- exactly the P8 false positive the review reported.
    await call.assistantSays("I'm calling about your enquiry.");
    await call.turnEnds();

    expect(events("outbound_topic_to_unverified")).toHaveLength(0);
    await call.hangUp();
  });

  it("F-R2 fix round 1, I2 (sink 3): a discarded stale generation's text never fires the note-sending guards", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400);

    call.live.push(modelAudioMsg());
    await call.settle();
    // The exact phrase the file's own "item 4" test already proves triggers
    // live_offer_unverified (the unverified-offer note-sending guard).
    // droppedThisGeneration() reads true here: the modelAudioMsg() chunk
    // just above was discarded for THIS still-open generation. Gated at the
    // moment this text arrives, not at turn end -- unlike NB4/item 4's own
    // scenario a few tests up, which never pushes an audio chunk at all and
    // so must still fire (droppedThisGeneration() stays false there).
    await call.assistantSays("We have a slot available on Monday at 9 AM.");

    expect(events("live_offer_unverified")).toHaveLength(0);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 2 (opus re-review). NB1: gating the WHOLE
  // persistTurnTranscript call on `heard` dropped the CALLER's own words
  // too, on a turn whose reply happened to be discarded -- the caller's
  // words are never stale (they came from the caller's own microphone),
  // and losing them silenced lib/outbound/detectors.js's detectOptOut, read
  // by lib/outbound/postCall.js -- a missing caller row means the person
  // gets called again after asking to be left alone.
  // -------------------------------------------------------------------
  it("F-R2 fix round 2, NB1: a discarded turn whose user text is an opt-out phrase still writes the caller row, and the post-call detector sees it", async () => {
    const database = outboundDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)

    // The stale generation: audio discarded, so this turn's REPLY is unheard.
    call.live.push(modelAudioMsg());
    await call.settle();
    // The caller's own words -- never stale, whatever the reply's fate.
    await call.callerSays("Stop calling me.");
    await call.turnEnds(); // turnComplete for the STALE generation

    const callerRows = database.addTranscriptEntry.mock.calls.filter(([, speaker]) => speaker === "caller");
    expect(callerRows).toHaveLength(1);
    expect(callerRows[0][2]).toBe("Stop calling me.");
    const aiRows = database.addTranscriptEntry.mock.calls.filter(([, speaker]) => speaker === "ai");
    expect(aiRows).toHaveLength(0); // the AI half is still correctly gated

    // The post-call opt-out detector, run over exactly what got persisted.
    expect(detectOptOut({ callerText: callerRows[0][2] })).toEqual({ hit: true, side: "caller" });
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 2 (opus re-review). NB2: latching on voiceActive let
  // GENUINE in-clip speech reach Live before the seed -- a real utterance
  // with natural micro-gaps never satisfies voiceActive's own strict
  // "consecutive frames, resets on ANY gap" rule, so it stayed in the
  // (unlatched) delay line the whole time. Fixed: a raw voiced frame latches
  // PROVISIONALLY at once (zero onset lag, matching the very first, pre-C1
  // design), and confirms on a COUNT of voiced frames within a window --
  // which gaps do not reset. Proven here with speech broken into four 80 ms
  // runs (320 ms of real voice, over CLIP_CONFIRM_VOICED_FRAMES) separated
  // by 40 ms gaps -- no single run ever reaches voiceActive's own 200 ms
  // activeMs, so the OLD mechanism would never have confirmed this at all.
  // -------------------------------------------------------------------
  it("F-R2 fix round 2, NB2: gappy in-clip speech (no run reaching activeMs) still confirms and stays held, not leaked", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)
    const beforeHold = call.live.sent.audioIn.length;

    // Four 80 ms voiced runs / 40 ms gaps: 320 ms of real voice, but no
    // single unbroken run ever reaches 200 ms (activeMs).
    for (let i = 0; i < 4; i++) {
      await call.feed(80, { voiced: true });
      if (i < 3) await call.feed(40);
    }
    // 440 ms elapsed so far. A CONSECUTIVE-frame confirm (voiceActive's own
    // rule) would never have reached CLIP_CONFIRM_VOICED_FRAMES within any
    // one run; this pushes total elapsed since the FIRST voiced frame past
    // CLIP_CONFIRM_WINDOW_MS (800 ms) -- BEFORE the clip's own end mark is
    // ever delivered. This is the assertion that actually distinguishes
    // "confirmed early via the count, now fully latched" from "never
    // confirmed, still pending": once latched, this trailing silence goes
    // straight into the capped hold and cannot leak before release,
    // regardless of how long the clip goes on playing; a provisional window
    // that never confirmed times out on ITS OWN clock and releases early,
    // mid-clip -- before the seed, breaching C1 -- with nothing to do with
    // whether the clip has ended yet. (A naive "nothing leaked before the
    // mark" check cannot tell these apart: releaseClipHold flushes ANY
    // still-pending provisional content too, so an unconfirmed run and a
    // confirmed one look identical if checked only after the mark.)
    await call.feed(500);
    expect(call.live.sent.audioIn.length).toBe(beforeHold);

    // The clip finishes; the seed goes now. The held speech reaches Live
    // only after it, never before (C1's own invariant, still intact).
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    expect(call.live.sent.audioIn.length).toBeGreaterThan(beforeHold);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 2 (opus re-review). NB3: droppedSinceTurnText survived
  // the stale-discard timeout (the abandoned generation never reports
  // turnComplete/interrupted, so onAssistantTurnText -- the only place that
  // clears it -- never runs for it), silently poisoning the NEXT
  // generation's own `heard` read. Real Gemini sims hit the timeout on 3 of
  // 23 calls. Fixed: checkStaleDiscardTimeout clears the flag itself.
  // -------------------------------------------------------------------
  it("F-R2 fix round 2, NB3: the discarded generation never reports its end, and the next heard reply's rows and guards still work", async () => {
    // live_offer_unverified is expected to fire, legitimately, for the
    // second (heard) turn -- that IS this test's own point.
    allowErrors("outbound_stale_discard_timeout", "live_offer_unverified");
    const database = outboundDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)

    // A generation opens (audio discarded) and NEVER closes -- no
    // turnComplete, no interrupted, ever, for this one.
    call.live.push(modelAudioMsg());
    await call.settle();
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } }); // seed sent; staleDiscardDeadline armed

    // Past the idle bound (STALE_GENERATION_IDLE_MS, final wave W1 -- was a
    // 2,000 ms wall clock) with no media frame in between, so tick() -- not
    // onModelAudio -- is what fires the timeout on the next ordinary frame,
    // same shape as the N1 fix test above.
    await call.starve(2100);
    await call.feed(20); // fires checkStaleDiscardTimeout via tick()
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);

    // The NEXT generation: genuinely heard (nothing discarded for it --
    // clipPlaying and staleDiscard are both false by now). CHANGED (final
    // wave W1, I1 -- replaces this test's own NB3 flag-clear ruling R2): it
    // PLAYS audio first. Heard-ness is scoped to the generation now, and a
    // text-only "reply" after an abandoned generation is indistinguishable
    // from that generation's own late transcript -- which must never read
    // heard. A reply the caller hears always carries audio.
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantSays("We have a slot available on Monday at 9 AM.");
    await call.turnEnds();

    // Its guard fired -- droppedSinceTurnText did not silently carry over
    // from the abandoned generation.
    expect(events("live_offer_unverified")).toHaveLength(1);
    // Its AI row was written -- heard read true for this turn.
    // Filtered to THIS turn's own text: the seed callback also legitimately
    // writes an "ai" row (the disclosure record, unrelated to NB3) when the
    // mark fires a few lines up, so the raw ai-row count is 2, correctly.
    const offerRows = database.addTranscriptEntry.mock.calls.filter(
      ([, speaker, message]) => speaker === "ai" && message === "We have a slot available on Monday at 9 AM."
    );
    expect(offerRows).toHaveLength(1);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 2 (opus re-review). I2 residual (out-of-scope in the
  // first review, same class through a sink it did not cite): auditTurn()
  // -- the claim ledger, the promise-only-turn guard, the sign-off exit
  // arming -- still consumed unheard stale text. Fixed with the reviewer's
  // own suggested line: `if (heardThisTurn) auditTurn();`.
  // -------------------------------------------------------------------
  it("F-R2 fix round 2, I2 residual: a discarded stale generation never trips auditTurn()'s own guards (live_promise_only_turn)", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400);

    call.live.push(modelAudioMsg());
    await call.settle();
    // The reviewer's own R11 phrase: matches promisedAction/S.promiseRe.
    await call.assistantSays("One moment, let me check that for you.");
    await call.turnEnds();

    expect(events("live_promise_only_turn")).toHaveLength(0);
    await call.hangUp();
  });

  // -------------------------------------------------------------------
  // F-R2 fix round 3 (opus re-review 2). N1: unlatchClipProvisional sent the
  // provisional buffer straight to Live while the delay line could still
  // hold up to 500 ms of OLDER frames -- an un-latch inverted order every
  // time it ran. Usually only silence got reordered, but the delay line can
  // hold a quiet caller's own sub-threshold onset, so their real speech
  // could arrive at Live out of order. Fixed: unlatchClipProvisional flushes
  // the delay line FIRST, then the provisional buffer, both still direct
  // and immediate.
  // -------------------------------------------------------------------
  it("F-R2 fix round 3, N1: after an un-latch, frames reach Live in arrival order -- delay-line frames ahead of the provisional ones", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true }); // a hello
    await call.feed(400); // the hello ends; the clip queues (deferred seed, O-8)

    const beforeDelayContent = call.live.sent.audioIn.length;
    // 5 OLDER frames sit in the delay line, unflushed (well under its own
    // 25-frame cap) -- these must reach Live BEFORE anything from the
    // provisional episode that follows.
    await call.feed(100);
    // ONE raw voiced frame: a click, not speech -- latches PROVISIONALLY.
    // The delay line's own 5 frames are now frozen (phase 3 stops feeding
    // it; see routeClipFrame's own phase comment).
    await call.feed(20, { voiced: true });
    // 800 ms more silence: comfortably past CLIP_CONFIRM_WINDOW_MS since the
    // provisional latch -- it times out unconfirmed and un-latches.
    await call.feed(800);

    const arrived = call.live.sent.audioIn.slice(beforeDelayContent);
    const voiced = arrived.map((a) => pcmPeak(a.data) > 4000);
    // The delay line's older (silent) frames -- whatever their exact count
    // (the hello-end sequence's own tail can leave a frame or two already
    // sitting there before the 100 ms feed above even starts) -- must all
    // reach Live BEFORE the single voiced (click) frame that starts the
    // provisional episode. Under the pre-fix order the click is sent alone,
    // first, with the delay line's own content left behind (never flushed
    // in this same burst) -- so the click would be entries[0], not later.
    const firstVoicedIdx = voiced.indexOf(true);
    expect(firstVoicedIdx).toBeGreaterThan(0);
    expect(voiced.slice(0, firstVoicedIdx).every((v) => v === false)).toBe(true);
    await call.hangUp();
  });
});

// ---------------------------------------------------------------------------
// FINAL FIX WAVE W1 -- the first seconds (final-review.md I1/I2 and the
// "First seconds" triage rows). Every test here drives the REAL session
// (index.js + the real firstSeconds controller) through liveBoot's fake Live.
// ---------------------------------------------------------------------------

/** The session's own AI transcript rows, minus the seed's disclosure row (b7). */
const aiRowsBesidesSeed = (database) =>
  database.addTranscriptEntry.mock.calls.filter(([, speaker, message]) => speaker === "ai" && message !== OPENER);

describe("W1 I1: the stale-reply discard lifts on the stale generation's OWN close", () => {
  // Sim A run 1 (harness-server-A.log:30-32): the stale reply to the pre-clip
  // "Hello?" was a full opener repeat, streamed at speaking pace on
  // gemini-3.8-live. No `interrupted` ever came; the 2 s wall-clock timeout
  // fired MID-GENERATION (waited 2004 ms), the rest of the generation played,
  // and its turnComplete 61 ms later wrote the whole stale opener as an AI
  // row. This is that shape, both ends real: the stale generation opens
  // mid-clip, streams a chunk + a transcript fragment every 100 ms of media
  // through the seed and past the OLD deadline (seed + 2,000), and closes
  // 60 ms after it.
  const STALE = ["Hello, is that Sam? ", "It's Ava, calling ", "on behalf of Digile Media ", "about your enquiry. "];

  async function staleStream(call, ms, state) {
    for (let t = 0; t < ms; t += 100) {
      await call.feed(100);
      call.live.push(modelAudioMsg(100));
      call.live.push({ serverContent: { outputTranscription: { text: STALE[state.i++ % STALE.length] } } });
    }
    await call.settle();
  }

  it("sim A run 1's shape: nothing of the stale generation reaches Twilio, the transcript, the detectors or the history -- and the next generation plays", async () => {
    allowErrors("outbound_stale_discard_timeout"); // so a regression fails on the named assertion below, not on afterEach
    const database = outboundDb();
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // "Hello?"
    await call.feed(400); // the hello ends; the clip queues via the hello-end timer (seed deferred, O-8)
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);

    const state = { i: 0 };
    await staleStream(call, 600, state); // the stale reply opens MID-CLIP
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } }); // the seed goes; still streaming
    expect(call.live.sent.clientContent).toHaveLength(1);
    await staleStream(call, 2000, state); // through seed + 2,000 -- the OLD wall-clock deadline
    await call.feed(60);
    call.live.push({ serverContent: { turnComplete: true } }); // 60 ms after the old deadline
    await call.settle();
    await call.settle();

    // Nothing of it reached the caller: only the clip's own single enqueue.
    expect(enqueue).toHaveBeenCalledTimes(1);
    // ...nor any sink: no AI row, no turn detector, no history entry.
    expect(aiRowsBesidesSeed(database)).toHaveLength(0);
    expect(events("outbound_topic_to_unverified")).toHaveLength(0);
    expect(call.ws.liveState.history.some((h) => /calling on behalf/.test(JSON.stringify(h)))).toBe(false);
    // The wait ended on the close, not on a clock.
    expect(events("outbound_stale_discard_timeout")).toHaveLength(0);

    // Ava is not muted: the NEXT generation plays.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue.mock.calls.length).toBeGreaterThan(1);
    await call.hangUp();
  });

  // The NB3 glue shape (F-R2 re-review 1): a stale generation that never
  // closes at all. The idle bound abandons it; its own late transcript
  // ("...Goodbye.") still arrives; then the next generation plays. The heard
  // reply's row must be exactly its own text -- none of the stale text glued
  // onto it -- and its guards/rows must still work (NB3's own concern).
  it("the NB3 glue shape: an abandoned generation's text is cut; the post-lift reply plays and is persisted alone", async () => {
    allowErrors("outbound_stale_discard_timeout");
    const database = outboundDb();
    const call = await bootOutbound({ database });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true });
    await call.feed(400);
    const state = { i: 0 };
    await staleStream(call, 300, state);
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(2100); // the generation goes quiet and never closes: idle bound (and the OLD 2 s clock) both pass
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);

    call.live.push({ serverContent: { outputTranscription: { text: "Goodbye." } } }); // its own late transcript
    await call.settle();
    call.live.push(modelAudioMsg()); // the NEXT generation: plays
    await call.settle();
    expect(enqueue.mock.calls.length).toBeGreaterThan(1);
    await call.assistantSays("I'm calling about your enquiry.");
    await call.turnEnds();

    const rows = aiRowsBesidesSeed(database);
    expect(rows.map((r) => r[2])).toEqual(["I'm calling about your enquiry."]);
    // Lifted by the idle bound, not a clock: reason recorded.
    expect(events("outbound_stale_discard_timeout")[0]).toMatchObject({ reason: "idle" });
    await call.hangUp();
  });

  it("an abandoned generation's own late close reads unheard: no AI row for it", async () => {
    allowErrors("outbound_stale_discard_timeout");
    const database = outboundDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true });
    await call.feed(400);
    const state = { i: 0 };
    await staleStream(call, 300, state);
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(2100); // abandoned by the idle bound (the OLD clock would have passed too)
    call.live.push({ serverContent: { outputTranscription: { text: "Goodbye." } } });
    await call.turnEnds(); // ITS close, late -- nothing has played since
    expect(aiRowsBesidesSeed(database)).toHaveLength(0);
    await call.hangUp();
  });
});

/**
 * runPostCall's own db calls, faked -- every field of outboundPostCallContext
 * taken from services/db.js's RETURN statement (the producer), not a log line.
 * `rows` is the SAME array the session's addTranscriptEntry writes into, so
 * the post-call transcript read sees exactly what the session persisted.
 */
function postCallDb(rows) {
  const ctx = {
    attemptNo: 1,
    dialedAt: new Date("2026-09-28T10:00:00Z"),
    answeredAt: new Date("2026-09-28T10:00:05Z"),
    endedAt: null,
    answeredBy: "human",
    result: null,
    silent: false,
    sessionFinishedAt: new Date("2026-09-28T10:00:20Z"),
    statusCompletedAt: null,
    twilioCallSid: SID,
    outreachId: "out-1",
    outreachState: "dialing",
    attemptsMade: 1,
    outreachCreatedAt: new Date("2026-09-28T09:59:00Z"),
    campaignId: "camp-1",
    campaignVersion: 3,
    contactId: "contact-1",
    complianceClass: "solicited",
    templateKey: "speed_to_lead",
    config: CAMPAIGN_CONFIG,
    phoneE164: CONTACT,
    contactTimezone: "America/Chicago",
    businessTimezone: "Europe/London",
    callId: "call-1",
    callSid: SID,
    outcomeCode: null,
    answers: null,
  };
  return {
    withTenant: vi.fn(async (_biz, fn) => fn()),
    claimPostCall: vi.fn(async () => new Date("2026-09-28T10:00:21Z")),
    releasePostCallClaim: vi.fn(async () => true),
    outboundPostCallContext: vi.fn(async () => ctx),
    fetchCallTranscript: vi.fn(async () => rows.map((r) => ({ ...r }))),
    finalizeAttemptResult: vi.fn(async () => {}),
    outboundCallEffects: vi.fn(async () => ({ booked: false, optedOut: false })),
    isSuppressed: vi.fn(async () => false),
    insertDetectorSuppression: vi.fn(async () => true),
    setCallOutcomeCode: vi.fn(async () => {}),
    updateCallSummary: vi.fn(async () => {}),
    setAttemptSilent: vi.fn(async () => {}),
    setOutreachHold: vi.fn(async () => {}),
    applyOutreachResult: vi.fn(async () => true),
  };
}
const noopSummarize = async () => ({ summary: null, sentiment: null, outcome: "unknown" });

/**
 * A fake Live that TRANSCRIBES what it receives: once it has been sent
 * `minVoiced` voiced frames (counted only from the moment this is armed), it
 * answers with an inputTranscription -- on a later tick, as a network reply
 * would. Reads only call.live.sent.audioIn, never the test's own intent.
 */
function transcribeOnReceipt(call, text, { minVoiced = 11, then = null } = {}) {
  let voicedSeen = 0;
  let fired = false;
  const audioIn = call.live.sent.audioIn;
  const realPush = audioIn.push.bind(audioIn);
  audioIn.push = (audio) => {
    const n = realPush(audio);
    if (!fired && audio?.data && pcmPeak(audio.data) > 4000) voicedSeen += 1;
    if (!fired && voicedSeen >= minVoiced) {
      fired = true;
      setImmediate(() => {
        call.live.push({ serverContent: { inputTranscription: { text } } });
        then?.();
      });
    }
    return n;
  };
}

describe("W1 I2 / A26 / A17 / A16 / A12: held speech and the turn rows at the edges", () => {
  function recordingDb() {
    const rows = [];
    const database = outboundDb();
    database.addTranscriptEntry = vi.fn(async (_callId, speaker, message, sequence) => {
      rows.push({ speaker, message, sequence });
    });
    // N2: the drain's row is read back, so the fixture needs the read side of
    // the same store (the producer's shape: rows of {speaker, message, sequence}).
    database.fetchCallTranscript = vi.fn(async () => rows.map((r) => ({ ...r })));
    return { rows, database };
  }

  // I2 (final review; ledger m1/A7). "Stop calling me." said DURING the
  // clip, then the caller hangs up before the clip ends. The words were held
  // (C1) and the hang-up dropped them: no transcript, no caller row, nothing
  // for the post-call D9 detector -- and the retry schedule re-dialled them.
  it("I2: 'Stop calling me.' said mid-clip, then the hang-up -- the held speech is drained to Live, its caller row is written, and post-call's opt-out detector writes the suppression", async () => {
    const { rows, database } = recordingDb();
    const pcDb = postCallDb(rows);
    const postCall = createPostCall({ db: pcDb, summarize: noopSummarize });
    const call = await bootOutbound({ database, postCall });
    await call.feed(400, { voiced: true }); // "Hello?"
    await call.feed(400); // the hello ends; the clip queues (hello-end)
    transcribeOnReceipt(call, "Stop calling me."); // armed only now: the hello itself already reached Live

    const beforeHold = call.live.sent.audioIn.length;
    for (let i = 0; i < 3; i++) {
      await call.feed(160, { voiced: true }); // runs well under CLIP_BARGE_MIN_MS: the clip keeps playing
      await call.feed(40);
    }
    expect(call.live.sent.audioIn.length).toBe(beforeHold); // held (C1): nothing reached Live yet

    await call.hangUp(); // Twilio `stop`, the clip still playing

    await vi.waitFor(() => expect(pcDb.insertDetectorSuppression).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(pcDb.insertDetectorSuppression).toHaveBeenCalledWith({ phone: CONTACT, sourceCallId: "call-1" });
    expect(rows.filter((r) => r.speaker === "caller").map((r) => r.message)).toContain("Stop calling me.");
    // The post-call claim ran only AFTER that row was written.
    const stopRowCall = database.addTranscriptEntry.mock.calls.findIndex(([, , message]) => message === "Stop calling me.");
    expect(pcDb.claimPostCall.mock.invocationCallOrder[0]).toBeGreaterThan(
      database.addTranscriptEntry.mock.invocationCallOrder[stopRowCall]
    );
    expect(events("outbound_clip_hold_drained")).toHaveLength(1);
    expect(events("outbound_clip_hold_drained")[0].voiced_frames).toBeGreaterThan(0);
    expect(events("outbound_clip_hold_drain_settled")[0]).toMatchObject({ transcribed: true, reason: "settled" });
    expect(events("outbound_clip_hold_teardown_dropped")).toHaveLength(0);
  });

  it("I2: nothing Live says during the drain is heard -- no AI row for its reply, the caller row still written", async () => {
    const { rows, database } = recordingDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true });
    await call.feed(400);
    transcribeOnReceipt(call, "Stop calling me.", {
      then: () => {
        call.live.push(modelAudioMsg());
        call.live.push({ serverContent: { outputTranscription: { text: "Of course, we won't call you again. Goodbye." } } });
        call.live.push({ serverContent: { turnComplete: true } });
      },
    });
    for (let i = 0; i < 3; i++) {
      await call.feed(160, { voiced: true });
      await call.feed(40);
    }
    await call.hangUp();
    await vi.waitFor(() => expect(events("outbound_clip_hold_drain_settled")).toHaveLength(1), { timeout: 4000 });
    expect(rows.filter((r) => r.speaker === "caller").map((r) => r.message)).toContain("Stop calling me.");
    expect(rows.filter((r) => r.speaker === "ai")).toEqual([]);
  });

  it("I2: a drain that never yields text ends at its bound, counted, and post-call still runs after it", async () => {
    const { database } = recordingDb();
    let claimed = 0;
    const call = await bootOutbound({
      database,
      clipDrainMaxMs: 150,
      postCall: { tryClaim: async () => false, tryClaimByAttempt: async () => { claimed += 1; return false; } },
    });
    await call.feed(400, { voiced: true });
    await call.feed(400);
    for (let i = 0; i < 3; i++) {
      await call.feed(160, { voiced: true });
      await call.feed(40);
    }
    await call.hangUp();
    await vi.waitFor(() => expect(claimed).toBe(1), { timeout: 2000 });
    expect(events("outbound_clip_hold_drain_settled")[0]).toMatchObject({ transcribed: false, reason: "max" });
  });

  // -------------------------------------------------------------------------
  // STAGE 4, S4-2. The failure this closes (sims-report-B run 4): "Hello?",
  // then "Please stop calling me." 300 ms later, DURING the opener clip, then
  // the hang-up 400 ms after. The drain sent 98 held frames (38 voiced) to
  // Live and Live never transcribed them: outcome unknown, re-dialled at +10
  // minutes, suppression never written. Owner rule 2026-09-29: (a) Deepgram
  // transcribes the held audio and the ordinary D9 detector reads it; (b) if
  // that fails, the lead is CLOSED for review, never silently re-dialled.
  //
  // The audio is the repo's REAL synthetic "Please stop calling me." mu-law
  // clip (tests/fixtures/audio/stop_ask.ulaw), fed frame by frame through the
  // real hold and the real drain. Only the two vendors are stubs.
  // -------------------------------------------------------------------------
  describe("S4-2: a mid-clip opt-out the drain could not transcribe", () => {
    const STOP_ASK = readFileSync(new URL("./fixtures/audio/stop_ask.ulaw", import.meta.url));
    const stopFrames = () => {
      const out = [];
      for (let i = 0; i < STOP_ASK.length; i += 160) {
        const f = Buffer.alloc(160, 0xff); // mu-law silence pads the last, partial frame
        STOP_ASK.copy(f, 0, i, Math.min(i + 160, STOP_ASK.length));
        out.push(f);
      }
      return out;
    };

    /** The database + post-call pair: mergeCallAnswers lands where post-call's context read finds it. */
    function heldRig({ mergeFails = false } = {}) {
      const { rows, database } = recordingDb();
      const answers = {};
      database.mergeCallAnswers = vi.fn(async (_sid, patch) => {
        if (mergeFails) throw new Error("db down");
        Object.assign(answers, patch);
      });
      database.fetchCallTranscript = vi.fn(async () => rows.map((r) => ({ ...r })));
      const pcDb = postCallDb(rows);
      pcDb.mergeCallAnswers = vi.fn(async (_sid, patch) => {
        Object.assign(answers, patch);
      });
      const baseCtx = pcDb.outboundPostCallContext;
      pcDb.outboundPostCallContext = vi.fn(async () => ({ ...(await baseCtx()), answers: { ...answers } }));
      const summarize = vi.fn(noopSummarize);
      const postCall = createPostCall({ db: pcDb, summarize });
      return { rows, database, answers, pcDb, summarize, postCall };
    }

    async function sayStopThenHangUp(call) {
      await call.feed(400, { voiced: true }); // "Hello?"
      await call.feed(400); // the hello ends; the clip queues
      await call.feed(300); // 300 ms later ...
      await call.feedFrames(stopFrames()); // "Please stop calling me." over the clip: HELD (C1)
      await call.feed(400); // ... and 400 ms after that
      await call.hangUp();
    }
    const heldAudio = (stt) => Buffer.concat(stt.mock.calls[0][0].frames);

    it("RED->GREEN: Deepgram transcribes the held frames; the caller row is written; post-call writes the suppression and the outcome is opted_out", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "Please stop calling me." }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await sayStopThenHangUp(call);

      await vi.waitFor(() => expect(r.pcDb.insertDetectorSuppression).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(r.pcDb.insertDetectorSuppression).toHaveBeenCalledWith({ phone: CONTACT, sourceCallId: "call-1" });
      expect(r.pcDb.setCallOutcomeCode).toHaveBeenCalledWith(SID, "opted_out");
      const applied = r.pcDb.applyOutreachResult.mock.calls[0];
      expect(applied[2]).toMatchObject({ terminal: true, closeReason: "terminal_outcome", outcome: "opted_out" });

      // The caller row is the STT text; it exists before the post-call claim.
      expect(r.rows.filter((x) => x.speaker === "caller").map((x) => x.message)).toEqual(["Please stop calling me."]);
      const at = r.database.addTranscriptEntry.mock.calls.findIndex(([, , m]) => m === "Please stop calling me.");
      expect(r.pcDb.claimPostCall.mock.invocationCallOrder[0]).toBeGreaterThan(r.database.addTranscriptEntry.mock.invocationCallOrder[at]);

      // ONE STT call, on the real fixture bytes, in order, frame-aligned.
      expect(stt).toHaveBeenCalledTimes(1);
      // The session's language (a UK number -> en-GB), not a hard-coded en-US.
      expect(stt.mock.calls[0][0].language).toMatch(/^en(-GB)?$/);
      const audio = heldAudio(stt);
      expect(audio.length % 160).toBe(0);
      // The WHOLE utterance, contiguous and in order -- not only the voiced
      // islands the hold kept (13 soft tail frames overflowed to Live).
      expect(audio.includes(STOP_ASK)).toBe(true);
      // No marker on a success; no retry armed.
      expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
      const settled = events("outbound_clip_hold_drain_settled")[0];
      expect(settled).toMatchObject({ transcribed: false, reason: "max" });
      const sttLog = events("outbound_clip_hold_stt");
      expect(sttLog).toHaveLength(1);
      expect(sttLog[0]).toMatchObject({ ok: true, chars: "Please stop calling me.".length });
      expect(typeof sttLog[0].ms).toBe("number");
      // No transcript text and no audio in any log line.
      expect(JSON.stringify(logged)).not.toMatch(/stop calling me/i);
      expect(events("outbound_optout_unverified_hold")).toHaveLength(0);
    });

    for (const [label, makeStt, opts, expectedWhy] of [
      ["Deepgram rejects", () => vi.fn(async () => { throw new Error("503"); }), {}],
      ["Deepgram returns empty text", () => vi.fn(async () => ({ text: "   " })), {}],
      ["Deepgram never answers (bounded)", () => vi.fn(() => new Promise(() => {})), { clipHoldSttTimeoutMs: 120 }],
      // The producer's own class, as assertVendorAllowed("deepgram") throws it in hipaa mode.
      ["hipaa refusal (ComplianceViolationError)", () => vi.fn(async () => { throw new ComplianceViolationError("deepgram"); }), {}, "hipaa_refused"],
    ]) {
      it(`${label}: the attempt is marked unverified, post-call holds it for review (CLOSED, no reschedule) and raises the alert event`, async () => {
        allowErrors("outbound_optout_unverified_hold");
        const r = heldRig();
        const stt = makeStt();
        const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150, ...opts });
        await sayStopThenHangUp(call);

        await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(stt).toHaveBeenCalledTimes(1);
        expect(r.database.mergeCallAnswers).toHaveBeenCalledWith(SID, { _optout_unverified: true });
        expect(r.rows.filter((x) => x.speaker === "caller")).toEqual([]);
        // Marker BEFORE the post-call claim (post-call reads it from the DB).
        expect(r.pcDb.claimPostCall.mock.invocationCallOrder[0]).toBeGreaterThan(r.database.mergeCallAnswers.mock.invocationCallOrder[0]);

        expect(r.pcDb.setCallOutcomeCode).toHaveBeenCalledWith(SID, "held_for_review");
        expect(r.pcDb.applyOutreachResult.mock.calls[0][2]).toEqual({
          terminal: true,
          closeReason: "held_for_review",
          outcome: "held_for_review",
          nextAttemptAt: null,
        });
        expect(r.pcDb.insertDetectorSuppression).not.toHaveBeenCalled();
        expect(r.summarize).not.toHaveBeenCalled(); // the LLM guess never gets a vote
        const alert = events("outbound_optout_unverified_hold");
        expect(alert).toHaveLength(1);
        expect(alert[0]).toMatchObject({ level: "ERROR", outreachId: "out-1", attemptId: "att-1", callSid: SID });
        expect(JSON.stringify(alert[0])).not.toMatch(/stop calling me/i);
        expect(events("outbound_clip_hold_stt")[0]).toMatchObject({ ok: false, chars: 0 });
        if (expectedWhy) expect(events("outbound_clip_hold_stt")[0].why).toBe(expectedWhy);
      });
    }

    it("a drain Live DID transcribe never touches Deepgram (no double ASR), and writes no marker", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "should never be asked" }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt });
      await call.feed(400, { voiced: true });
      await call.feed(400);
      transcribeOnReceipt(call, "Stop calling me.");
      for (let i = 0; i < 3; i++) {
        await call.feed(160, { voiced: true });
        await call.feed(40);
      }
      await call.hangUp();
      await vi.waitFor(() => expect(r.pcDb.insertDetectorSuppression).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(stt).not.toHaveBeenCalled();
      expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
      expect(events("outbound_clip_hold_stt")).toHaveLength(0);
    });

    it("a hang-up with only SILENCE held is not a drain: no Deepgram, no marker", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "x" }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt });
      await call.feed(1400);
      await call.feed(200);
      await call.hangUp();
      expect(stt).not.toHaveBeenCalled();
      expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
    });

    it("Deepgram text with NO opt-out is an ordinary caller row: no marker, no hold, the normal retry flow", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "Sorry, who is this?" }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await sayStopThenHangUp(call);
      await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(r.rows.filter((x) => x.speaker === "caller").map((x) => x.message)).toEqual(["Sorry, who is this?"]);
      expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
      expect(r.pcDb.applyOutreachResult.mock.calls[0][2].closeReason).not.toBe("held_for_review");
      expect(events("outbound_optout_unverified_hold")).toHaveLength(0);
    });

    it("a marker write that keeps failing is retried, logged as an ERROR, and never wedges teardown -- post-call still runs", async () => {
      allowErrors("outbound_optout_unverified_marker_failed");
      const r = heldRig({ mergeFails: true });
      const stt = vi.fn(async () => { throw new Error("503"); });
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await sayStopThenHangUp(call);
      await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalled(), { timeout: 4000 });
      expect(r.database.mergeCallAnswers.mock.calls.length).toBeGreaterThan(1);
      const failed = events("outbound_optout_unverified_marker_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ level: "ERROR", callSid: SID });
      // I2: the marker never landed, yet the SAME process's post-call claim
      // carried the verdict in-process -- held, closed, no reschedule.
      expect(r.pcDb.applyOutreachResult.mock.calls[0][2]).toEqual({
        terminal: true,
        closeReason: "held_for_review",
        outcome: "held_for_review",
        nextAttemptAt: null,
      });
      allowErrors("outbound_optout_unverified_hold");
    });

    // I1 (review). The row write "succeeds" against the REAL db layer even
    // when nothing landed: real withTenantSafe swallows into its fallback and
    // real addTranscriptEntry no-ops / logs and returns. Here the real
    // functions run with no pool (an INSERT that never happens), so the old
    // boolean said ok:true, wrote no marker, and the lead was re-dialled.
    it("I1: Deepgram recovered the words but the row never landed (real withTenantSafe/addTranscriptEntry/fetchCallTranscript) -> read-back fails -> unverified, held", async () => {
      allowErrors("outbound_optout_unverified_hold");
      const r = heldRig();
      Object.assign(r.database, {
        withTenantSafe: realDb.withTenantSafe,
        addTranscriptEntry: realDb.addTranscriptEntry,
        fetchCallTranscript: realDb.fetchCallTranscript,
      });
      const stt = vi.fn(async () => ({ text: "Please stop calling me." }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await sayStopThenHangUp(call);
      await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(events("outbound_clip_hold_stt")[0]).toMatchObject({ ok: false, why: "write_unverified" });
      expect(r.answers).toEqual({ _optout_unverified: true });
      expect(r.pcDb.applyOutreachResult.mock.calls[0][2].closeReason).toBe("held_for_review");
    });

    it("I1 control: with a working write path the read-back confirms the row and the run is ok:true", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "Please stop calling me." }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await sayStopThenHangUp(call);
      await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(r.database.fetchCallTranscript).toHaveBeenCalled();
      expect(events("outbound_clip_hold_stt")[0]).toMatchObject({ ok: true });
    });

    // FINAL FIX WAVE N2. A drain Live DID transcribe is verified by the same
    // read-back as the Deepgram branch: the row is fire-and-forget through
    // swallowing helpers, and a row that never landed must not read as "the
    // caller said nothing".
    it("N2: Live transcribed the drain but the row never landed (real withTenantSafe/addTranscriptEntry/fetchCallTranscript) -> unverified marker, held", async () => {
      allowErrors("outbound_optout_unverified_hold");
      const r = heldRig();
      Object.assign(r.database, {
        withTenantSafe: realDb.withTenantSafe,
        addTranscriptEntry: realDb.addTranscriptEntry,
        fetchCallTranscript: realDb.fetchCallTranscript,
      });
      const stt = vi.fn(async () => ({ text: "should never be asked" }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt });
      await call.feed(400, { voiced: true });
      await call.feed(400);
      transcribeOnReceipt(call, "Stop calling me.");
      for (let i = 0; i < 3; i++) {
        await call.feed(160, { voiced: true });
        await call.feed(40);
      }
      await call.hangUp();
      await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(stt).not.toHaveBeenCalled(); // Live transcribed: no second ASR
      expect(r.answers).toEqual({ _optout_unverified: true });
      expect(events("outbound_clip_hold_drain_row_unverified")).toHaveLength(1);
      expect(r.pcDb.applyOutreachResult.mock.calls[0][2].closeReason).toBe("held_for_review");
      expect(r.pcDb.insertDetectorSuppression).not.toHaveBeenCalled();
    });

    // FINAL FIX WAVE r1. The hint rides only THIS process's own claim. When that
    // claim is not ours, the durable marker is all another process can see.
    describe("r1: the hint only reaches this process's own claim", () => {
      const NOT_OURS = () => ({ tryClaim: async () => false, tryClaimByAttempt: vi.fn(async () => false) });

      it("a claim that is not ours re-tries a marker that was lost, and the retry lands: no hint_dropped alert", async () => {
        allowErrors("outbound_optout_unverified_marker_failed");
        const r = heldRig();
        // The first drain attempts all fail; a later one (post-claim) succeeds.
        let calls = 0;
        r.database.mergeCallAnswers = vi.fn(async (_sid, patch) => {
          calls += 1;
          if (calls <= 3) throw new Error("db down");
          Object.assign(r.answers, patch);
        });
        const postCall = NOT_OURS();
        const stt = vi.fn(async () => { throw new Error("503"); });
        const call = await bootOutbound({ database: r.database, postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
        await sayStopThenHangUp(call);
        await vi.waitFor(() => expect(r.answers).toEqual({ _optout_unverified: true }), { timeout: 12000 });
        expect(postCall.tryClaimByAttempt).toHaveBeenCalledWith("att-1", expect.anything(), { optoutUnverified: true });
        expect(events("outbound_optout_unverified_hint_dropped")).toHaveLength(0);
      }, 20000);

      it("a claim that is not ours and a marker that never lands: outbound_optout_unverified_hint_dropped (ERROR) fires", async () => {
        allowErrors("outbound_optout_unverified_marker_failed", "outbound_optout_unverified_hint_dropped");
        const r = heldRig({ mergeFails: true });
        const postCall = NOT_OURS();
        const stt = vi.fn(async () => { throw new Error("503"); });
        const call = await bootOutbound({ database: r.database, postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
        await sayStopThenHangUp(call);
        await vi.waitFor(() => expect(events("outbound_optout_unverified_hint_dropped")).toHaveLength(1), { timeout: 15000 });
        expect(events("outbound_optout_unverified_hint_dropped")[0]).toMatchObject({ level: "ERROR", callSid: SID, claim: "not_claimed" });
      }, 25000);

      it("a claim that IS ours never retries the marker (the hint already did its job)", async () => {
        allowErrors("outbound_optout_unverified_marker_failed", "outbound_optout_unverified_hold");
        const r = heldRig({ mergeFails: true });
        const stt = vi.fn(async () => { throw new Error("503"); });
        const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
        await sayStopThenHangUp(call);
        await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(events("outbound_optout_unverified_hint_dropped")).toHaveLength(0);
      });
    });

    // FINAL FIX WAVE I1. dialFirstSeconds is built before the vendor connect,
    // so on a cold (or failed) connect the clip plays and holds speech with no
    // Live session. The hang-up used to drop that speech: no Deepgram, no
    // marker, no hint -> re-dial. Real stop_ask frames; the connect never opens
    // until after the hang-up.
    describe("I1 (final review): hang-up before the Live session is open", () => {
      const openGate = () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        return { gate, release };
      };

      it("the held speech goes straight to Deepgram; the caller row lands; post-call writes the suppression (opted_out)", async () => {
        const r = heldRig();
        const stt = vi.fn(async () => ({ text: "Please stop calling me." }));
        const { gate, release } = openGate();
        const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, connectGate: gate, waitForConnect: false });
        try {
          await sayStopThenHangUp(call);
          await vi.waitFor(() => expect(r.pcDb.insertDetectorSuppression).toHaveBeenCalledTimes(1), { timeout: 4000 });
          expect(stt).toHaveBeenCalledTimes(1);
          expect(heldAudio(stt).includes(STOP_ASK)).toBe(true);
          expect(r.rows.filter((x) => x.speaker === "caller").map((x) => x.message)).toEqual(["Please stop calling me."]);
          expect(r.pcDb.setCallOutcomeCode).toHaveBeenCalledWith(SID, "opted_out");
          expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
          expect(events("outbound_clip_hold_stt")[0]).toMatchObject({ ok: true });
        } finally {
          release();
        }
      });

      it("Deepgram failing there: the marker is written, the claim carries the hint, the lead is held (CLOSED, no reschedule)", async () => {
        allowErrors("outbound_optout_unverified_hold");
        const r = heldRig();
        const stt = vi.fn(async () => { throw new Error("503"); });
        const { gate, release } = openGate();
        const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, connectGate: gate, waitForConnect: false });
        try {
          await sayStopThenHangUp(call);
          await vi.waitFor(() => expect(r.pcDb.applyOutreachResult).toHaveBeenCalledTimes(1), { timeout: 4000 });
          expect(r.database.mergeCallAnswers).toHaveBeenCalledWith(SID, { _optout_unverified: true });
          expect(r.pcDb.applyOutreachResult.mock.calls[0][2]).toEqual({
            terminal: true,
            closeReason: "held_for_review",
            outcome: "held_for_review",
            nextAttemptAt: null,
          });
          expect(r.pcDb.insertDetectorSuppression).not.toHaveBeenCalled();
        } finally {
          release();
        }
      });

      it("only silence held before the session opens is not a drain: no Deepgram, no marker", async () => {
        const r = heldRig();
        const stt = vi.fn(async () => ({ text: "x" }));
        const { gate, release } = openGate();
        const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, connectGate: gate, waitForConnect: false });
        try {
          await call.feed(1400);
          await call.feed(200);
          await call.hangUp();
          expect(stt).not.toHaveBeenCalled();
          expect(r.database.mergeCallAnswers).not.toHaveBeenCalled();
        } finally {
          release();
        }
      });
    });

    // M1 (review): a whitespace-only Live fragment is not a transcript.
    it("M1: a whitespace-only inputTranscription during the drain does not count as transcribed -- the Deepgram fallback still runs", async () => {
      const r = heldRig();
      const stt = vi.fn(async () => ({ text: "Please stop calling me." }));
      const call = await bootOutbound({ database: r.database, postCall: r.postCall, clipHoldStt: stt, clipDrainMaxMs: 150 });
      await call.feed(400, { voiced: true });
      await call.feed(400);
      transcribeOnReceipt(call, "   ");
      await call.feed(300);
      await call.feedFrames(stopFrames());
      await call.feed(400);
      await call.hangUp();
      await vi.waitFor(() => expect(r.pcDb.insertDetectorSuppression).toHaveBeenCalledTimes(1), { timeout: 4000 });
      expect(stt).toHaveBeenCalledTimes(1);
      expect(events("outbound_clip_hold_drain_settled")[0]).toMatchObject({ transcribed: false });
    });
  });

  // A12 (F-R2 M6/m4/m6): teardown's routine leftovers -- the delay line's
  // silence -- are not counted as dropped speech, and nothing is drained.
  it("A12: a hang-up with only SILENCE held is not a drain and counts no dropped frames; the log carries voiced_frames 0", async () => {
    clearStats();
    const call = await bootOutbound();
    await call.feed(1400); // backstop_silence: the clip plays
    await call.feed(200); // silence into the delay line
    await call.hangUp();
    expect(events("outbound_clip_hold_drained")).toHaveLength(0);
    const td = events("outbound_clip_hold_teardown_dropped");
    expect(td).toHaveLength(1);
    expect(td[0].voiced_frames).toBe(0);
    expect(td[0].frames).toBeGreaterThan(0);
    const c = getLatencyStats().turnTaking;
    expect(c.outbound_clip_hold_dropped ?? 0).toBe(0);
    expect(c.outbound_clip_hold_voiced_dropped ?? 0).toBe(0);
  });

  // A26 (F-R2 re-review 2 out-of-scope; probe Q10): the new-caller-turn
  // flush folded a model turn with no close WITHOUT persisting it -- a clip
  // barge while the stale hello reply was open lost the caller's "Hello?".
  it("A26: a clip barge while the stale hello reply is open -- the new-caller-turn flush writes the caller's 'Hello?' row (and no AI row for the unheard reply)", async () => {
    const { rows, database } = recordingDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true });
    await call.callerSays("Hello?"); // Live's transcript of the pre-clip hello
    await call.feed(400); // the clip queues (hello-end)
    call.live.push(modelAudioMsg()); // the stale reply opens: discarded
    await call.settle();
    await call.assistantSays("Hi, is that Sam?");
    // Quiet long enough for the hello's own turn to close on our side (the
    // vendor arm's 1.2 s bookkeeping hangover), still inside the clip...
    await call.feed(900);
    // ...then a genuine barge (>= CLIP_BARGE_MIN_MS): the gate forwards it and
    // the strategy opens a NEW caller turn -- the flush this test is about.
    await call.feed(900, { voiced: true });

    expect(rows.filter((r) => r.speaker === "caller").map((r) => r.message)).toContain("Hello?");
    expect(rows.filter((r) => r.speaker === "ai")).toEqual([]);
    expect(call.ws.liveState.history.some((h) => /is that Sam/.test(JSON.stringify(h)))).toBe(false); // A22 on this path too
    await call.hangUp();
  });

  // A17 (F-R2 re-review 1 m6): finish()'s own flush wrote the unheard stale
  // reply as an AI row on a mid-clip hang-up -- a record of a disclosure Live
  // never spoke to anyone.
  it("A17: a hang-up mid-clip while the stale reply is open writes the caller row but no AI row for the unheard reply", async () => {
    const { rows, database } = recordingDb();
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true });
    await call.callerSays("Hello?");
    await call.feed(400);
    call.live.push(modelAudioMsg()); // discarded
    await call.settle();
    await call.assistantSays("Hi, is that Sam? It's Ava, an AI assistant from Digile Media.");
    await call.hangUp();
    expect(rows.filter((r) => r.speaker === "caller").map((r) => r.message)).toEqual(["Hello?"]);
    expect(rows.filter((r) => r.speaker === "ai")).toEqual([]);
  });

  // A16 (F-R2 re-review 1 m5, probe R7): a stale generation whose transcript
  // arrives BEFORE its first audio chunk slipped past the streaming guards
  // (droppedThisGeneration() was still false) -- the offer guard fired and a
  // spoken note went to Live mid-clip.
  it("A16: stale text arriving before any audio during the clip trips no streaming guard, sends no note, and leaves no AI row", async () => {
    const { rows, database } = recordingDb();
    const call = await bootOutbound({ database });
    await call.feed(1400); // backstop_silence: the clip is playing
    const notesBefore = call.live.sent.clientContent.length;
    await call.assistantSays("We have a slot available on Monday at 9 AM."); // text only, no chunk yet
    expect(events("live_offer_unverified")).toHaveLength(0);
    expect(call.live.sent.clientContent.length).toBe(notesBefore); // no note to Live
    await call.turnEnds();
    expect(rows.filter((r) => r.speaker === "ai" && r.message !== OPENER)).toEqual([]);
    await call.hangUp();
  });
});

// ---------------------------------------------------------------------------
// W1 A15 / A18 / A20 / A28: what the clip hold withholds from Live.
// ---------------------------------------------------------------------------

/**
 * A 20 ms mu-law frame that is UNIQUE by `id`, so a test can say exactly
 * which frame reached Live and in what order: digital silence (0xff) or
 * full-scale voice (0x00), with the id stamped into three bytes the VAD
 * cannot hear (silence codes 0xf0-0xff stay ~16 RMS, far under the 700
 * floor; voice codes 0x00-0x0f stay near full scale).
 */
function uniqueFrame(id, voiced) {
  const f = Buffer.alloc(160, voiced ? 0x00 : 0xff);
  const base = voiced ? 0x00 : 0xf0;
  f[0] = base + (id & 15);
  f[1] = base + ((id >> 4) & 15);
  f[2] = base + ((id >> 8) & 15);
  return f;
}
/** Frames for a pattern: [[ms, voiced], ...] -> unique frames + a lookup from what Live receives back to the id. */
function patternFrames(pattern, startId = 1) {
  const frames = [];
  let id = startId;
  for (const [ms, voiced] of pattern) {
    for (let t = 0; t < ms; t += 20) frames.push({ id: id++, voiced, buf: uniqueFrame(id - 1, voiced) });
  }
  const byPcm = new Map(frames.map((f) => [mulaw8kToPcm16k(f.buf).toString("base64"), f]));
  return { frames, byPcm };
}
/** The seed's own index in audioIn: how many audio frames Live had received when the seed went out. */
function watchSeedIndex(call) {
  const at = [];
  const cc = call.live.sent.clientContent;
  const realPush = cc.push.bind(cc);
  cc.push = (m) => {
    at.push(call.live.sent.audioIn.length);
    return realPush(m);
  };
  return at;
}

describe("W1 A15: after a confirmed latch only VOICED runs (+ pre-roll) are withheld; silence keeps flowing", () => {
  // Final review A15 (F-R2 re-review 1 m1, re-review 2 m2): a sustained
  // (>= 220 ms) second "Hello?" early in the clip, or two short bursts inside
  // the 800 ms confirm window, latched the hold -- and a latched hold used to
  // withhold EVERY later frame, silence included. Live's own end-of-turn for
  // the pre-clip hello then never fired during the clip; the whole hold went
  // out at the seed and Live answered the stale hello AFTER the opener (the
  // D1 re-ask/repeat F-R2 exists to prevent). armServerVadReply is the fake
  // server VAD: it replies once it has RECEIVED 700 ms of trailing silence.
  it.each([
    ["a sustained 300 ms second 'Hello?'", [[100, false], [300, true]]],
    ["two short bursts inside the confirm window (120 ms, 300 ms gap, 120 ms)", [[100, false], [120, true], [300, false], [120, true]]],
  ])("%s early in the clip: Live's reply to the PRE-clip hello is generated DURING the clip and discarded -- nothing stale plays after the opener", async (_label, inClip) => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    const seedAt = watchSeedIndex(call);
    const liveVad = armServerVadReply(call);
    await call.feed(400, { voiced: true }); // hello #1
    await call.feed(400); // the hello ends; the clip queues (hello-end)
    const atFire = call.live.sent.audioIn.length;
    const { frames } = patternFrames(inClip);
    await call.feedFrames(frames.map((f) => f.buf));
    await call.feed(1500); // quiet: the rest of the clip
    // Live's own end-of-turn for the PRE-clip hello fired while the clip was
    // still playing -- the silence after the held second hello reached it.
    expect(call.ws.liveDialFirstSeconds.clipPlaying()).toBe(true);
    expect(liveVad.fired()).toBe(true);

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } }); // the seed goes
    await call.feed(20);
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } }); // the stale generation's own close
    await call.settle();
    await call.feed(200);
    await call.settle();

    // Nothing stale reached the caller: the clip's own single enqueue only.
    expect(enqueue).toHaveBeenCalledTimes(1);
    // C1 still holds: no voiced frame reached Live between the fire and the seed...
    const voicedBeforeSeed = call.live.sent.audioIn.slice(atFire, seedAt[0]).filter((a) => pcmPeak(a.data) > 4000);
    expect(voicedBeforeSeed).toHaveLength(0);
    // ...and the held speech reached it after the seed.
    const voicedAfterSeed = call.live.sent.audioIn.slice(seedAt[0]).filter((a) => pcmPeak(a.data) > 4000);
    expect(voicedAfterSeed.length).toBeGreaterThanOrEqual(frames.filter((f) => f.voiced).length);
    await call.hangUp();
  });

  // The F-R2 re-review 2 Q1 click/blip probe, through the real session: a
  // click (20 ms), a blip (40 ms) or a sub-threshold burst (200 ms) at points
  // across the clip never brings the stale hello reply back.
  it.each([
    ["a 20 ms click at +100", 100, 20],
    ["a 20 ms click at +500", 500, 20],
    ["a 20 ms click at +1000", 1000, 20],
    ["a 40 ms blip at +300", 300, 40],
    ["a 40 ms blip at +900", 900, 40],
    ["a 200 ms burst at +200", 200, 200],
  ])("I1 probe shape: %s -- no stale reply chunk reaches the caller", async (_label, atMs, burstMs) => {
    const call = await bootOutbound({ database: outboundDb({ openerAudio: Buffer.alloc(8 * 3000, 0x7f) }) }); // a 3 s clip
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    armServerVadReply(call);
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    await call.feed(atMs);
    await call.feed(burstMs, { voiced: true });
    await call.feed(2600 - atMs - burstMs); // the rest of the clip, quiet
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    await call.settle();
    call.live.push({ serverContent: { turnComplete: true } }); // whatever Live had open closes
    await call.settle();
    expect(enqueue).toHaveBeenCalledTimes(1); // the clip alone
    await call.hangUp();
  });

  it("frame order: the held stream is released in arrival order, the forwarded stream is in arrival order, nothing lost or duplicated", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    const atFire = call.live.sent.audioIn.length;
    const { frames, byPcm } = patternFrames([
      [100, false],
      [300, true], // latches (sustained)
      [700, false], // silence: flows (the part beyond the 500 ms delay line)
      [160, true], // a later voiced run: held, with its pre-roll
      [600, false],
    ]);
    await call.feedFrames(frames.map((f) => f.buf));
    const beforeRelease = call.live.sent.audioIn.length;
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } }); // seed + release
    await call.settle();

    const idsOf = (from, to) => call.live.sent.audioIn.slice(from, to).map((a) => byPcm.get(a.data)).filter(Boolean);
    const forwarded = idsOf(atFire, beforeRelease); // what flowed to Live while the clip played
    const released = idsOf(beforeRelease); // what the release delivered after the seed
    const ids = [...forwarded, ...released].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.slice().sort((a, b) => a - b)).toEqual(frames.map((f) => f.id)); // nothing lost
    // Silence kept flowing after the latch (the A15 rule) -- and none of it was speech.
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded.every((f) => !f.voiced)).toBe(true);
    // Each stream in arrival order.
    expect(forwarded.map((f) => f.id)).toEqual(forwarded.map((f) => f.id).sort((a, b) => a - b));
    expect(released.map((f) => f.id)).toEqual(released.map((f) => f.id).sort((a, b) => a - b));
    await call.hangUp();
  });
});

describe("W1 A18: the pre-clip-tail phase is bounded", () => {
  // F-R2 re-review 1 m7: phase 1 (the caller already mid-utterance when the
  // clip fires -- the backstop_slow shape) ended only when voiceActive
  // dropped, so a talker whose gaps stay under the VAD's 300 ms hangover was
  // never held: every in-clip voiced frame reached Live before the seed (R2:
  // 120 frames on a 3 s tail), and none of it got a reply the caller heard.
  it("a gappy talker who never pauses 300 ms: only a bounded head of the in-clip speech reaches Live before the seed; the rest is held", async () => {
    const LONG_CLIP = Buffer.alloc(8 * 5000, 0x7f); // 5 s clip, so the tail runs inside it
    const call = await bootOutbound({ database: outboundDb({ openerAudio: LONG_CLIP }) });
    const seedAt = watchSeedIndex(call);
    const gappy = async (ms) => {
      for (let t = 0; t < ms; t += 300) {
        await call.feed(260, { voiced: true }); // unbroken runs past the VAD's 200 ms activation, well under CLIP_BARGE_MIN_MS
        await call.feed(40); // gaps well under the VAD's 300 ms hangover: voiceActive never drops
      }
    };
    await gappy(1800); // onset, then on through the slow deadline (onset + 1,600): backstop_slow fires mid-utterance
    expect(events("outbound_backstop_played")[0]).toMatchObject({ path: "backstop_slow" });
    const atFire = call.live.sent.audioIn.length;
    await gappy(3000); // the talker keeps going over the clip
    const reachedPreSeed = call.live.sent.audioIn.slice(atFire).filter((a) => pcmPeak(a.data) > 4000).length;
    // Bounded by CLIP_PRE_CLIP_TAIL_MAX_MS (600 ms) less the 500 ms delay line: a handful of frames.
    expect(reachedPreSeed).toBeLessThanOrEqual(10);
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    expect(seedAt).toHaveLength(1);
    const afterSeed = call.live.sent.audioIn.slice(seedAt[0]).filter((a) => pcmPeak(a.data) > 4000).length;
    expect(afterSeed).toBeGreaterThan(50); // the held rest of it, delivered after the seed
    await call.hangUp();
  });
});

describe("W1 A19: tool calls from a generation the caller never heard", () => {
  // Final review A19 (F-R2 re-review 1/2, parked "tool calls from a
  // discarded generation still execute"): a stale reply mid-clip -- audio
  // discarded, never heard -- could still hang up (end_call) or perform a
  // caller-visible action. Refused now; suppression/opt-out writes still run.
  it("a stale generation mid-clip: end_call is refused (no exit is armed), while its set_call_outcome still runs", async () => {
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    call.live.push(modelAudioMsg()); // the stale reply opens: discarded
    await call.settle();
    const out = await call.callToolBatch([
      ["set_call_outcome", { outcome: "not_interested" }],
      ["end_call", { reason: "caller not interested" }],
    ]);
    const byName = Object.fromEntries(out.map((r) => [r.name, r.response]));
    expect(byName.set_call_outcome).toMatchObject({ success: true }); // kept: not caller-visible
    expect(byName.end_call).toMatchObject({ success: false });
    expect(byName.end_call.message).toMatch(/could not hear/i);
    await call.assistantSays("Thanks for your time. Goodbye.");
    await call.turnEnds();
    expect(events("live_exit_armed")).toHaveLength(0); // nothing hangs up on a reply nobody heard
    expect(events("outbound_unheard_tool_refused").map((l) => l.tool)).toEqual(["end_call"]);
    await call.hangUp();
  });

  it("a caller-visible action (a message write) from a stale generation is refused; a HEARD generation's is not gated", async () => {
    const database = outboundDb({ campaignConfig: { ...CAMPAIGN_CONFIG, capabilities: ["messages"] } });
    const call = await bootOutbound({ database });
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    call.live.push(modelAudioMsg()); // stale, discarded
    await call.settle();
    const refused = await call.callTool("record_customer_request", { request_type: "message", message: "call me back" });
    expect(refused[0].response).toMatchObject({ success: false });
    expect(refused[0].response.message).toMatch(/could not hear/i);
    await call.turnEnds();
    // The clip ends and the stale generation has closed: what follows is heard.
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    call.live.push(modelAudioMsg()); // plays
    await call.settle();
    // The same write, from a heard generation, passes every gate it has to
    // (O-12's identity check, the write-order read-back + agreement).
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.assistantTurn("I'll pass that along. Shall I go ahead and confirm that?");
    await call.callerSays("Yes, please.");
    call.live.push(modelAudioMsg()); // the next reply, heard
    await call.settle();
    const ran = await call.callTool("record_customer_request", { request_type: "message", message: "call me back" });
    expect(ran[0].response).toMatchObject({ success: true });
    await call.hangUp();
  });

  it("after the hang-up (the I2 drain), Live's opt_out still WRITES the suppression; its end_call is refused", async () => {
    const call = await bootOutbound();
    const insertSuppression = vi.fn(async () => true);
    call.deps.insertSuppression = insertSuppression;
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    transcribeOnReceipt(call, "Stop calling me.", {
      then: () => {
        call.live.push({
          toolCall: {
            functionCalls: [
              { id: "d1", name: "opt_out", args: {} },
              { id: "d2", name: "end_call", args: { reason: "opted out" } },
            ],
          },
        });
      },
    });
    for (let i = 0; i < 3; i++) {
      await call.feed(160, { voiced: true });
      await call.feed(40);
    }
    await call.hangUp(); // the drain starts; Live hears the held words and calls opt_out + end_call
    await vi.waitFor(() => expect(insertSuppression).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(insertSuppression.mock.calls[0][0]).toMatchObject({ phone: CONTACT, reason: "opted_out" });
    await vi.waitFor(() => expect(call.responsesFor("end_call")).toHaveLength(1));
    expect(call.responsesFor("end_call")[0].response).toMatchObject({ success: false });
  });
});

describe("W1 A5 / A14: the clip's two edges", () => {
  // A5 (checkpoint-A re-review N4; ported from its probe P-G, rr/c1probe2.test.js):
  // speech crossing the clip's end mark lost ~100-180 ms -- once the hold
  // released, clipPlaying() was false but isPlaying() stayed true for the
  // clip's own tail + 150 ms grace, and the half-duplex gate's ring (empty
  // at that point) dropped a short voiced run as echo. P-G at HEAD eba8fab:
  // 75 frames fed, 67 reached Live, 8 missing.
  it("A5 (P-G): speech across the end mark on the silence path -- every frame reaches Live, none twice", async () => {
    const call = await bootOutbound();
    await call.feed(1400); // backstop_silence: the clip fires, the seed goes at once
    const before = call.live.sent.audioIn.length;
    const inClip = patternFrames([
      [200, true], [40, false], [200, true], [40, false], [200, true], [40, false], [200, true], [40, false],
    ]);
    await call.feedFrames(inClip.frames.map((f) => f.buf));
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    const afterMark = patternFrames([[100, true], [40, false], [400, false]], 1000);
    await call.feedFrames(afterMark.frames.map((f) => f.buf));
    const byPcm = new Map([...inClip.byPcm, ...afterMark.byPcm]);
    const ids = call.live.sent.audioIn.slice(before).map((a) => byPcm.get(a.data)?.id).filter((x) => x !== undefined);
    const fed = [...inClip.frames, ...afterMark.frames].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.slice().sort((a, b) => a - b)).toEqual(fed); // missing 0 (P-G: 8 missing)
    await call.hangUp();
  });

  // A14 (F-R2 parked P9): on backstop_slow the clip barge measured the VAD's
  // voiced run from BEFORE the clip -- a greeting still going when the clip
  // fired (by design: onset + 1,600 ms) had >= CLIP_BARGE_MIN_MS already,
  // so the clip was cut on its FIRST frame. The run is measured from the
  // clip's own start now.
  it("A14: a greeting still going when backstop_slow fires does not cut the opener on its first frame; 600 ms more of it still barges", async () => {
    const call = await bootOutbound({ database: outboundDb({ openerAudio: Buffer.alloc(8 * 5000, 0x7f) }) }); // a 5 s clip
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(1700, { voiced: true }); // one unbroken greeting through the slow deadline (onset + 1,600)
    expect(events("outbound_backstop_played")[0]).toMatchObject({ path: "backstop_slow" });
    expect(clear).not.toHaveBeenCalled(); // not cut on (or near) its first frame
    expect(call.ws.liveDialFirstSeconds.clipPlaying()).toBe(true);
    await call.feed(600, { voiced: true }); // the same greeting, now >= CLIP_BARGE_MIN_MS INTO the clip
    expect(clear).toHaveBeenCalled(); // a real interruption still barges
    await call.hangUp();
  });
});

describe("W1 A4 / A24 / F12", () => {
  // A4 (checkpoint-A re-review N3, probe P-C: clearCalls 2): the clip barge
  // and the ordinary half-duplex barge both acted on the same >= 600 ms run.
  it("A4: a clip barge clears the audio and records the barge ONCE", async () => {
    const call = await bootOutbound();
    await call.feed(1400); // the clip plays
    const clear = vi.spyOn(call.ws.liveAudioOut, "clear");
    await call.feed(900, { voiced: true }); // a genuine barge
    expect(clear).toHaveBeenCalledTimes(1);
    await call.hangUp();
    expect(events("live_call_summary")[0].barges).toBe(1);
  });

  // A24 (F-R2 re-review 2 m7): gating auditTurn on `heard` also dropped the
  // caller-side instruments on every turn whose reply was discarded.
  it("A24: an unheard turn still runs the caller-side instruments (counts only, no note)", async () => {
    clearStats();
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    call.live.push(modelAudioMsg()); // the stale reply: discarded
    await call.settle();
    await call.callerSays("Hello?");
    const notesBefore = call.live.sent.clientContent.length;
    await call.turnEnds(); // unheard: auditTurn skipped
    const c = getLatencyStats().turnTaking;
    expect(c.live_transcript_script_checked).toBe(1);
    expect(c.live_caller_turn_language_checked).toBe(1);
    expect(call.live.sent.clientContent.length).toBe(notesBefore); // no note to Live
    await call.hangUp();
  });

  // F12 (checkpoint-A re-review 2 m2): the N2 test asserts the mechanism
  // (speech held until the clip ends), not the observable. Ported from its
  // probe P-A2 (rr/c1probe2.test.js): a CAUSAL Live that replies only once
  // it has received the speech -- its reply must reach the caller. Round-1
  // code (released at the seed, mid-clip): 0 reply chunks enqueued; P-A2 at
  // eba8fab: 20.
  it("F12 (P-A2): silence path, speech mid-clip -- Live's reply to it, generated once it hears it, reaches the Twilio side", async () => {
    const call = await bootOutbound({ database: outboundDb({ openerAudio: Buffer.alloc(8 * 4000, 0x7f) }) }); // 4 s clip
    await call.feed(1400); // backstop_silence: the seed goes at fire
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    const before = call.live.sent.audioIn.length;
    let replied = null;
    // Causal: Live answers only once it has RECEIVED the speech -- its 40
    // voiced frames (P-A2 counted every frame; since A15 the silence flows
    // during the clip, so the count is of voiced frames).
    const voicedReceived = () => call.live.sent.audioIn.slice(before).filter((a) => pcmPeak(a.data) > 4000).length;
    const maybeReply = async (when) => {
      if (replied || voicedReceived() < 40) return; // Live has not received the speech yet
      replied = { when, enqBefore: enqueue.mock.calls.length };
      call.live.push(modelAudioMsg(400));
      await call.settle();
      call.live.push({ serverContent: { outputTranscription: { text: "No problem, I'll call back tomorrow." } } });
      call.live.push({ serverContent: { turnComplete: true } });
      await call.settle();
      replied.enqAfter = enqueue.mock.calls.length;
    };
    for (let t = 0; t < 960; t += 240) {
      await call.feed(200, { voiced: true }); // broken speech mid-clip, runs under CLIP_BARGE_MIN_MS
      await call.feed(40);
    }
    await maybeReply("mid_clip");
    await call.feed(3040);
    await maybeReply("before_mark");
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    await maybeReply("after_mark");
    await call.feed(400);
    await maybeReply("late");
    expect(replied).not.toBeNull();
    expect(replied.when).not.toBe("mid_clip"); // held until the clip ended (N2)
    expect(replied.enqAfter - replied.enqBefore).toBeGreaterThan(0); // and the caller HEARS the answer
    await call.hangUp();
  });
});

describe("W1 A20 / A28: the un-latch instruments", () => {
  // A20 (F-R2 re-review 2 m1): a provisional latch still pending when the
  // clip's own end releases it is NOT an un-latch of noise -- the counter's
  // alarm ("a high rate means the confirm threshold is miscalibrated") must
  // not count it. Logged with a reason; counted only for the window timeout.
  it("A20: a provisional latch released by the clip's end logs reason clip_release and does not bump the un-latch counter", async () => {
    clearStats();
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    await call.feed(60, { voiced: true }); // a fresh onset, 80 ms before the mark: provisional, unconfirmed
    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    await call.feed(20);
    const lines = events("outbound_clip_provisional_unlatched");
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe("clip_release");
    expect(getLatencyStats().turnTaking.outbound_clip_provisional_unlatched ?? 0).toBe(0);
    await call.hangUp();
  });

  // A28 (F-R2 re-review 3 m2/m3): the un-latch log counted only the
  // provisional frames (40 when 65 went out), and the N1 test checked only
  // that SOME silence preceded the click -- a partial flush would pass it.
  it("A28: a window un-latch logs every frame it sent (delay line + provisional) and they arrive in full arrival order", async () => {
    clearStats();
    const call = await bootOutbound();
    await call.feed(400, { voiced: true });
    await call.feed(400); // the clip queues
    const atFire = call.live.sent.audioIn.length;
    const { frames, byPcm } = patternFrames([
      [100, false],
      [20, true], // a click: provisional, never confirms
      [900, false], // past CLIP_CONFIRM_WINDOW_MS: the window un-latch
    ]);
    await call.feedFrames(frames.map((f) => f.buf));
    const lines = events("outbound_clip_provisional_unlatched");
    expect(lines).toHaveLength(1);
    expect(lines[0].reason).toBe("window");
    expect(lines[0].frames).toBe(lines[0].provisional_frames + lines[0].delay_line_frames);
    expect(getLatencyStats().turnTaking.outbound_clip_provisional_unlatched).toBe(1);

    const ids = call.live.sent.audioIn.slice(atFire).map((a) => byPcm.get(a.data)?.id).filter((x) => x !== undefined);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual(ids.slice().sort((a, b) => a - b)); // FULL arrival order, not just a boundary
    expect(ids[0]).toBe(frames[0].id); // nothing older left behind
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

  // S4-2 (review M7): the Deepgram one-shot and the unverified marker are
  // outbound-only. An inbound hang-up with voiced audio in flight touches neither.
  it("S4-2: an inbound hang-up mid-speech never runs the STT one-shot or writes the unverified marker", async () => {
    const database = inboundDb();
    database.mergeCallAnswers = vi.fn(async () => {});
    const stt = vi.fn(async () => ({ text: "x" }));
    const call = await bootLive({ config: CONFIG, callSid: "CAinbound0003", businessPhone: CALLER_ID, callerPhone: INBOUND_CALLER, database, clipHoldStt: stt });
    await call.feed(400, { voiced: true });
    await call.feed(400);
    await call.feed(200, { voiced: true });
    await call.hangUp();
    await call.settle();
    expect(stt).not.toHaveBeenCalled();
    expect(database.mergeCallAnswers).not.toHaveBeenCalled();
    expect(events("outbound_clip_hold_stt")).toHaveLength(0);
  });

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

  // CHANGED (S3-2, P-a): 1,160/1,180/1,640/1,660 -> shifted by the same -250
  // ms the deadline itself moved.
  it("O-6: one loud frame near pickup + 1.26 s is not speech -- the backstop is queued at the silence deadline and seeded", async () => {
    const call = await bootOutbound();
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(900); // 910 is not a frame multiple of 20; bootLive's feed() rounds
    await call.feed(20, { voiced: true }); // 920: a click
    await call.feed(460); // 1,380
    expect(enqueue).not.toHaveBeenCalled();
    await call.feed(20); // 1,400
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent.filter(isSeed)).toHaveLength(1);
    expect(call.ws.liveDialFirstSeconds.onsetAt()).toBeNull();
    await call.hangUp();
  });

  // CHANGED (S3-2, P-a): the deadline itself is now 1,400 (a multiple of the
  // 20 ms frame size, unlike the old 1,650), so it is hit EXACTLY rather than
  // overshot to 1,660 -- from_answer_ms recomputed accordingly (1,400 + 350 =
  // 1,750 at enqueue; +140 ms to the mark echo = 1,890 at playout).
  it("O-7: the first-audio mark reaches the wire before the first frame, and the metric is taken at its echo", async () => {
    const call = await bootOutbound();
    const sent = [];
    vi.spyOn(call.ws, "send").mockImplementation((raw) => sent.push(JSON.parse(raw)));
    await call.feed(1400); // queued at 1,400
    const firstMark = sent.findIndex((m) => m.event === "mark" && m.mark.name === FIRST_AUDIO_MARK);
    const firstMedia = sent.findIndex((m) => m.event === "media");
    expect(firstMark).toBeGreaterThanOrEqual(0);
    expect(firstMedia).toBeGreaterThan(firstMark);

    expect(call.ws.liveDialFirstSeconds.firstAudio()).toMatchObject({ from_answer_ms: 1750, measured: "enqueue" });
    await call.feed(140); // 1,540: Twilio echoes the mark as the clip starts to play
    call.ws.deliver({ event: "mark", mark: { name: FIRST_AUDIO_MARK } });
    expect(call.ws.liveDialFirstSeconds.firstAudio()).toEqual({
      from_answer_ms: 1890,
      from_speech_ms: null,
      path: "backstop_silence",
      measured: "playout",
    });
    expect(events("outbound_first_audio")).toEqual([expect.objectContaining({ from_answer_ms: 1890, measured: "playout" })]);
    await call.hangUp();
    expect(events("outbound_first_audio")).toHaveLength(1);
  });

  it("O-7: no echo before the hang-up -- the queue-time value is logged, flagged measured:'enqueue'", async () => {
    const call = await bootOutbound();
    await call.feed(1400);
    await call.hangUp();
    expect(events("outbound_first_audio")).toEqual([expect.objectContaining({ from_answer_ms: 1750, measured: "enqueue" })]);
  });

  // Live mode (contract item 6): kept as continuous voice (rather than a
  // short hello) so the clip mode default's hello-end timer (which would
  // otherwise fire first, before onset + slowLiveMs) cannot interfere -- this
  // test is specifically about the SLOW path's own seed deferral.
  it("O-8: the slow-path clip is NOT seeded when it fires -- only when its end mark echoes", async () => {
    const call = await bootOutbound({ env: { OUTBOUND_FIRST_SPEAKER: "live" } });
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    await call.feed(400, { voiced: true }); // onset at 20 (confirmed at ~220)
    await call.feed(1240); // 1,640: past onset + 1,600
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(call.live.sent.clientContent).toEqual([]);

    call.ws.deliver({ event: "mark", mark: { name: BACKSTOP_END_MARK } });
    expect(call.live.sent.clientContent).toEqual([{ turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false }]);
    await call.hangUp();
  });

  // M2 (fix round 1): reverted to its ORIGINAL 600 ms -- CLIP_BARGE_MIN_MS is
  // clip-mode-only (the ordinary 300 ms gate threshold governs in `live`
  // mode, exactly as before S3-2), so this barge only needs to clear the
  // gate's own 300 ms threshold, not the 600 ms one.
  it("O-8: a slow-path clip cut by a barge is never seeded", async () => {
    const call = await bootOutbound({ env: { OUTBOUND_FIRST_SPEAKER: "live" } });
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
    await call.feed(1400);
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
    await call.feed(1400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(database.fetchAttemptOpenerAudio).not.toHaveBeenCalled();
    const [prompt] = call.live.sent.clientContent;
    expect(prompt.turns[0].parts[0].text).toContain("that you are Ava, an AI assistant from Digile Media.");
    expect(JSON.stringify(call.live.sent.clientContent)).not.toMatch(/\bnull\b|\bundefined\b/);
    await call.hangUp();
  });
});

describe("live_call_summary carries direction/attempt_id/campaign_id (spec §14, Task 21)", () => {
  it("outbound: direction, attempt_id and campaign_id are all present and correct", async () => {
    const call = await bootOutbound();
    await call.hangUp();
    const [summary] = events("live_call_summary");
    expect(summary).toBeTruthy();
    expect(summary.direction).toBe("outbound");
    expect(summary.attempt_id).toBe("att-1");
    expect(summary.campaign_id).toBe("camp-1");
  });
});
