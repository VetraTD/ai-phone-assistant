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

function bootLiveMode({ env = {}, database = outboundDb(), verify, judge } = {}) {
  return bootLive({
    config: CONFIG,
    callSid: SID,
    env,
    customParameters: { direction: "outbound" },
    authorizedCallSid: SID,
    database,
    verify,
    judge,
  });
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
const INTRO = "Hi, this is Ava, an AI assistant calling from Digile Media. Am I speaking with Sam?";
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
    // Final review: 200 ms -- under our OWN 300 ms barge rule, so the clear
    // below can only come from the vendor's `interrupted`.
    await call.feed(200, { voiced: true });
    expect(clear).not.toHaveBeenCalled();
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
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
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
    await call.assistantTurn(INTRO);
    call.ws.liveFirstLine.enterHold(call.clock());
    await call.feed(121000);
    await call.settle();
    expect(db.setCallOutcomeCode).toHaveBeenCalledWith(SID, "other");
    expect(db.mergeCallAnswers).toHaveBeenCalledWith(SID, { _outcome_note: "hold timeout" });
    expect(events("outbound_hold_timeout")).toHaveLength(1);
    // finish() ran: the session wrote its one summary line.
    expect(events("live_call_summary")).toHaveLength(1);
  });

  it("release mid-generation flushes the muted start of the reply to the new person", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
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

describe("the prompt and tools Live connects with follow the mode", () => {
  const connectArgs = (call) => JSON.stringify(call.live.connect.mock.calls[0][0]);
  it("live: FIRST REPLY block + wait_on_hold declared", async () => {
    const call = await bootLiveMode();
    expect(connectArgs(call)).toContain("=== FIRST REPLY ===");
    expect(connectArgs(call)).toContain('"wait_on_hold"');
    await call.hangUp();
  });
  it("clip: neither (the clip prompt and tools are unchanged)", async () => {
    const call = await bootLiveMode({ env: { OUTBOUND_FIRST_SPEAKER: "clip" } });
    expect(connectArgs(call)).not.toContain("=== FIRST REPLY ===");
    expect(connectArgs(call)).not.toContain("wait_on_hold");
    expect(connectArgs(call)).toContain("played for you automatically before you connected");
    await call.hangUp();
  });
});

describe("read-back of a confirm answer, through the running session (spec §5b; both ends real)", () => {
  function confirmDb() {
    const db = outboundDb();
    const base = db.outboundCallContext;
    db.outboundCallContext = vi.fn(async (...a) => {
      const ctx = await base(...a);
      return {
        ...ctx,
        config: {
          ...ctx.config,
          questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text", confirm: true }],
        },
      };
    });
    return db;
  }

  it("refused until the AI's HEARD speech reads the value back; then saved", async () => {
    const call = await bootLiveMode({ database: confirmDb() });
    const merge = vi.fn(async () => {});
    call.deps.mergeCallAnswers = merge;
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    await call.callerSays("It's Brightwork Clinic.");

    const [first] = await call.callTool("record_answer", { key: "clinic_name", value: "Brightwork Clinic" });
    expect(first.response).toEqual({ success: false, message: "Read the answer back to them first, then save it." });
    expect(merge).not.toHaveBeenCalled();

    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Brightwork Clinic -- did I get that right?");
    await call.callerSays("Yes.");
    const [second] = await call.callTool("record_answer", { key: "clinic_name", value: "Brightwork Clinic" });
    expect(second.response).toEqual({ success: true, message: "Recorded." });
    expect(merge).toHaveBeenCalledWith(SID, { clinic_name: "Brightwork Clinic" });
    await call.hangUp();
  });

  it("a read-back said while muted on hold is not evidence (never heard)", async () => {
    const call = await bootLiveMode({ database: confirmDb() });
    call.deps.mergeCallAnswers = vi.fn(async () => {});
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    call.ws.liveFirstLine.enterHold(call.clock());
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Brightwork Clinic -- did I get that right?");
    const [r] = await call.callTool("record_answer", { key: "clinic_name", value: "Brightwork Clinic" });
    expect(r.response.success).toBe(false);
    await call.hangUp();
  });
});

describe("wait_on_hold (spec §4; ruling R3)", () => {
  it("answers 'wait quietly', and the hold engages at the END of the generation that called it -- its 'Sure, thank you' is heard", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    await call.feed(400, { voiced: true }); // "Hold on, I'll get him."
    await call.feed(800);
    call.live.push(modelAudioMsg()); // "Sure, thank you."
    await call.settle();
    const [r] = await call.callTool("wait_on_hold", {});
    // Real Hold call 2026-10-01 (defect A, R31 reverted): Live continues the SAME turn after a tool
    // reply, so a restart instruction here was executed at once ("Sure, thank you.Hi, it's Ava ...").
    // The reply says only what to do NOW; the restart rule rides on the release note instead.
    expect(r.response).toEqual({ success: true, message: "Wait quietly. Say nothing until a person speaks." });
    expect(r.response.message).not.toMatch(/who you are|intro|AI assistant|start your reply/i);
    expect(call.ws.liveFirstLine.onHold()).toBe(false); // the ack's own generation still plays
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    await call.assistantTurn("Sure, thank you.");
    expect(call.ws.liveFirstLine.onHold()).toBe(true);
    expect(events("outbound_hold_entered")).toHaveLength(1);
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
    await call.assistantTurn(INTRO);
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

describe("disclosure check on the first reply (spec §5; rulings R4, R14)", () => {
  const CUE = "Say plainly in your next sentence that you are an AI assistant calling from Digile Media.";
  const cues = (call) => call.live.sent.clientContent.filter((c) => JSON.stringify(c).includes(CUE));

  async function personSpeaks(call) {
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
  }

  it("a first reply without 'AI' -> one ERROR + one cue appended as context (no forced turn); never again", async () => {
    allowErrors("outbound_disclosure_missing");
    const call = await bootLiveMode();
    await personSpeaks(call);
    await call.assistantTurn("Hi, this is Ava from Digile Media. Am I speaking with Sam?");
    expect(events("outbound_disclosure_missing")).toHaveLength(1);
    expect(events("outbound_disclosure_missing")[0]).not.toHaveProperty("text");
    expect(cues(call)).toEqual([
      { turns: [{ role: "user", parts: [{ text: `(System: ${CUE})` }] }], turnComplete: false },
    ]);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Great, thanks Sam.");
    expect(events("outbound_disclosure_missing")).toHaveLength(1);
    expect(cues(call)).toHaveLength(1);
    await call.hangUp();
  });

  it("a first reply that discloses -> nothing", async () => {
    const call = await bootLiveMode();
    await personSpeaks(call);
    await call.assistantTurn("Hi, this is Ava, an AI assistant calling from Digile Media. Am I speaking with Sam?");
    expect(events("outbound_disclosure_missing")).toHaveLength(0);
    expect(cues(call)).toHaveLength(0);
    await call.hangUp();
  });

  it("an audio-only first reply (no output transcript) fails closed -> missing", async () => {
    allowErrors("outbound_disclosure_missing");
    const call = await bootLiveMode();
    await personSpeaks(call);
    await call.turnEnds();
    expect(events("outbound_disclosure_missing")).toHaveLength(1);
    await call.hangUp();
  });

  it("I5 kept: a first reply interrupted before the disclosure never corrects itself; the next completed turn is judged", async () => {
    allowErrors("outbound_disclosure_missing");
    const call = await bootLiveMode();
    await personSpeaks(call);
    await call.assistantSays("Hi, is that Sam?");
    call.live.push({ serverContent: { interrupted: true } });
    await call.settle();
    expect(events("outbound_disclosure_missing")).toHaveLength(0);
    expect(cues(call)).toHaveLength(0);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Sorry, go ahead -- what's the clinic called?");
    expect(events("outbound_disclosure_missing")).toHaveLength(1);
    expect(cues(call)).toHaveLength(1);
    await call.hangUp();
  });

  it("an interrupted first reply that DID disclose satisfies the check", async () => {
    const call = await bootLiveMode();
    await personSpeaks(call);
    await call.assistantSays("Hi, this is Ava, an AI assistant calling from");
    call.live.push({ serverContent: { interrupted: true } });
    await call.settle();
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Sure -- is that Sam?");
    expect(events("outbound_disclosure_missing")).toHaveLength(0);
    await call.hangUp();
  });

  it("R4: the silence 'Hello?' turn is not checked; the reply after it is", async () => {
    const call = await bootLiveMode();
    await call.feed(2300);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Hello?");
    expect(events("outbound_disclosure_missing")).toHaveLength(0);
    await call.feed(500, { voiced: true });
    await call.feed(800);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Hi, this is Ava, an AI assistant calling from Digile Media. Am I speaking with Sam?");
    expect(events("outbound_disclosure_missing")).toHaveLength(0);
    await call.hangUp();
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

// ---------------------------------------------------------------------------
// Final review fix pass (2026-10-01): engine wiring.
// ---------------------------------------------------------------------------
describe("final review #6: the release note and the disclosure re-check", () => {
  async function heldThenReleased({ dropOnHold }) {
    allowErrors("outbound_disclosure_missing");
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    call.ws.liveFirstLine.enterHold(call.clock());
    if (dropOnHold) {
      call.live.push(modelAudioMsg()); // the intro again, to the hold music -- muted
      await call.settle();
      await call.assistantTurn("Hi, this is Ava, an AI assistant calling from Digile Media.");
    }
    await call.feed(5000);
    await call.feed(600, { voiced: true });
    await call.feed(400);
    await call.callerSays("Hi, this is Sam.");
    expect(call.ws.liveFirstLine.onHold()).toBe(false);
    return call;
  }
  const NOTE = "nothing you said while waiting was heard";
  const RESTART = "has not heard who you are";
  const notes = (call) => call.live.sent.clientContent.filter((c) => JSON.stringify(c).includes(NOTE));
  const releaseNotes = (call) => call.live.sent.clientContent.filter((c) => JSON.stringify(c).includes(RESTART));

  it("a muted turn dropped on hold -> one note appended (no forced turn) telling Live it was not heard", async () => {
    const call = await heldThenReleased({ dropOnHold: true });
    expect(notes(call)).toHaveLength(1);
    expect(notes(call)[0].turnComplete).toBe(false);
    expect(releaseNotes(call)).toHaveLength(1); // the same note carries the restart rule
    await call.hangUp();
  });

  it("nothing dropped on hold -> STILL one release note (intro + name check), appended, without the dropped clause", async () => {
    // Real Hold call 2026-10-01 (defect A): the restart rule moved out of wait_on_hold's tool reply,
    // so the release note is now its ONLY carrier -- it must go on every release.
    const call = await heldThenReleased({ dropOnHold: false });
    expect(releaseNotes(call)).toHaveLength(1);
    expect(releaseNotes(call)[0].turnComplete).toBe(false);
    expect(JSON.stringify(releaseNotes(call)[0])).toMatch(/intro/);
    expect(JSON.stringify(releaseNotes(call)[0])).toMatch(/name check/);
    expect(notes(call)).toHaveLength(0);
    await call.hangUp();
  });

  it("the first heard turn after the release is checked again: no 'AI' -> outbound_disclosure_missing", async () => {
    const call = await heldThenReleased({ dropOnHold: true });
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Great, thanks Sam -- so, about your enquiry.");
    expect(events("outbound_disclosure_missing")).toHaveLength(1);
    await call.hangUp();
  });
});

describe("final review (re-graded minor): identity does not survive a hold", () => {
  it("confirmed before the hold -> after it, confirm_identity is a FIRST confirmation again", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    const [first] = await call.callTool("confirm_identity", { name_confirmed: true });
    expect(first.response.message).toMatch(/^Identity confirmed\. Next step of the call plan/);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.callTool("wait_on_hold", {});
    await call.assistantTurn("Sure, thank you.");
    expect(call.ws.liveFirstLine.onHold()).toBe(true);
    await call.feed(5000);
    await call.feed(600, { voiced: true });
    await call.feed(400);
    await call.callerSays("Hi, it's his wife.");
    const [again] = await call.callTool("confirm_identity", { name_confirmed: true });
    expect(again.response.message).toMatch(/^Identity confirmed\. Next step of the call plan/);
    await call.hangUp();
  });
});

describe("final review #8: the read-back must be an EARLIER heard turn, not the same reply as the save", () => {
  it("'Best College -- did I get that right?' + record_answer in one reply is refused", async () => {
    const db = outboundDb();
    const base = db.outboundCallContext;
    db.outboundCallContext = vi.fn(async (...a) => ({
      ...(await base(...a)),
      config: { ...CAMPAIGN_CONFIG, questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text", confirm: true }] },
    }));
    const call = await bootLiveMode({ database: db });
    call.deps.mergeCallAnswers = vi.fn(async () => {});
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    await call.callerSays("It's Best College.");
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantSays("Best College -- did I get that right?");
    const [r] = await call.callTool("record_answer", { key: "clinic_name", value: "Best College" });
    expect(r.response.success).toBe(false);
    await call.hangUp();
  });
});

describe("paid sim hold_transfer-2: a reply Live never closed (no turnComplete) is still a closed generation", () => {
  it("the new-caller-turn flush closes it: its disclosure counts, the next turn is not judged as the first reply", async () => {
    const call = await bootLiveMode();
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantSays(INTRO); // ...and Live never sends turnComplete for it
    await call.feed(500);
    await call.feed(600, { voiced: true }); // the person answers: a new caller turn flushes the open one
    await call.feed(800);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("What were you hoping we could help with?");
    expect(events("outbound_disclosure_missing")).toEqual([]);
    expect(events("live_debug_assistant_turn")).toEqual([]); // (LIVE_DEBUG_TRANSCRIPT is off here)
    await call.hangUp();
  });
});

// ---------------------------------------------------------------------------
// Gatekeeper call 2026-10-01 (CA450e3d...): "I've scheduled a callback for
// tomorrow at ten o'clock" -- TRUE, schedule_callback had succeeded -- was read
// as an unbacked booking claim: live_claim_unbacked_by_action + a claim note,
// then post-call claim_without_row (matcher AND judge, agreed_action "none")
// -> a false "unconfirmed booking" alert to the tenant. Both ends real: the REAL
// schedule_callback pack (capabilities/callback.js) answers the tool call, the
// REAL claim predicates read the sentence, the REAL verifyCall reconciles.
// ---------------------------------------------------------------------------
describe("a successful schedule_callback backs a callback claim (live gate + post-call)", () => {
  const HANDSET = "+14699338887"; // a dialable US number: the callback pack checks the legal floor for it
  const CLAIM = "Perfect. I've scheduled a callback for tomorrow at ten o'clock. Have a great day!";
  const tomorrowAt = (hhmm) =>
    `${new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" })}T${hhmm}`;
  const yesterdayAt = (hhmm) =>
    `${new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" })}T${hhmm}`;

  function gatekeeperDb() {
    const db = outboundDb();
    // The teardown judge reads the call's rows and transcript first (lib/voice/live/index.js).
    db.listAppointmentsByCallId = vi.fn(async () => []);
    db.fetchCallTranscript = vi.fn(async () => []);
    const base = db.outboundCallContext;
    // A real campaign always carries a calling window; without one the pack refuses
    // ("no_legal_opening"). Every day, so the test does not depend on the weekday it runs.
    db.outboundCallContext = vi.fn(async (...a) => {
      const ctx = await base(...a);
      return {
        ...ctx,
        toNumber: HANDSET,
        config: { ...ctx.config, calling_window: { mon_fri: "09:00-17:00", sat: "09:00-17:00", sun: "12:00-17:00" } },
      };
    });
    return db;
  }

  async function gatekeeperCall({ whenIso, claim = CLAIM, ...boot }) {
    const call = await bootLiveMode({ database: gatekeeperDb(), ...boot });
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    await call.feed(600, { voiced: true });
    await call.feed(400);
    await call.callerSays("He's out until tomorrow. Try him at ten.");
    call.live.push(modelAudioMsg());
    await call.settle();
    const [r] = await call.callTool("schedule_callback", { when_iso: whenIso });
    await call.assistantTurn(claim);
    return { call, r };
  }

  it("the real Gatekeeper shape: callback booked, then claimed -> no unbacked-claim error, no claim note", async () => {
    const { call, r } = await gatekeeperCall({ whenIso: tomorrowAt("14:00") });
    expect(r.response).toMatchObject({ success: true }); // the real pack really booked it
    expect(events("live_claim_unbacked_by_action")).toEqual([]);
    expect(events("live_turn_note").filter((e) => e.kind === "claim")).toEqual([]);
    await call.hangUp();
  });

  it("schedule_callback REFUSED (a time in the past), then the same claim -> the guard still fires", async () => {
    allowErrors("live_claim_unbacked_by_action", "live_claim_without_action");
    const { call, r } = await gatekeeperCall({ whenIso: yesterdayAt("14:00") });
    expect(r.response.success).toBe(false);
    expect(events("live_claim_unbacked_by_action")).toHaveLength(1);
    await call.hangUp();
  });

  it("a callback booked does not vouch for a BOOKING claim in the same reply -> the guard still fires", async () => {
    allowErrors("live_claim_unbacked_by_action", "live_claim_without_action");
    const { call, r } = await gatekeeperCall({
      whenIso: tomorrowAt("14:00"),
      claim: "You're all booked for Tuesday at 2 p.m., and I've scheduled a callback for Monday.",
    });
    expect(r.response).toMatchObject({ success: true });
    expect(events("live_claim_unbacked_by_action")).toHaveLength(1);
    await call.hangUp();
  });

  it("post-call: the engine hands verifyCall the callback and the judge's agreed action; the REAL reconcile says ok", async () => {
    const { verifyCall } = await import("../lib/postCallVerify.js");
    // judgeCall's RETURN shape (lib/postCallJudge.js `verdict`), as the prod judge read this call:
    // agreed_action none, claimed_done true. Never the log line's snake_case.
    const judge = vi.fn(async () => ({ ran: true, agreedAction: "none", agreedTurn: null, timeStated: true, claimedDone: true, claimedFailure: false, confidence: "high" }));
    const seen = [];
    const verify = vi.fn(async (input) => {
      seen.push(input);
      return verifyCall(input, {
        db: { withTenantSafe: async (_b, fn) => fn(), listAppointmentsByCallId: async () => [], getAppointmentById: async () => null },
        notifications: { notifyUnconfirmedClaim: vi.fn(async () => {}) },
        log: { info: vi.fn(), error: vi.fn() },
      });
    });
    const { call } = await gatekeeperCall({
      whenIso: tomorrowAt("14:00"),
      env: { POSTCALL_VERIFY: "count", POSTCALL_JUDGE: "shadow" },
      verify,
      judge,
    });
    await call.hangUp();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    const input = seen[0];
    expect(input.callbacksScheduled).toBe(1);
    expect(input.judgeClaimedDone).toBe(true);
    expect(input.judgeAgreedAction).toBe("none");
    expect(input.claims).toEqual([expect.objectContaining({ kind: "claim", topic: "callback" })]);
    expect((await verify.mock.results[0].value).verdict).toBe("ok");
  });
});

// Hello call 2026-10-01: the redial rule (lib/outbound/postCall.js) needs to know
// the PERSON was confirmed, after the call -- the engine marks it in calls.answers.
describe("confirm_identity(true) marks calls.answers._identity_confirmed once (the no-redial rule's input)", () => {
  async function confirmedCall(db = outboundDb()) {
    const call = await bootLiveMode({ database: db });
    await call.feed(500, { voiced: true });
    await call.feed(1000);
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn(INTRO);
    return { call, db };
  }
  const marks = (db) => db.mergeCallAnswers.mock.calls.filter(([, patch]) => patch && "_identity_confirmed" in patch);

  it("a confirmed person -> one merge of {_identity_confirmed: true} for this call", async () => {
    const { call, db } = await confirmedCall();
    await call.callTool("confirm_identity", { name_confirmed: true });
    await vi.waitFor(() => expect(marks(db)).toHaveLength(1));
    expect(marks(db)[0]).toEqual([SID, { _identity_confirmed: true }]);
    await call.hangUp();
  });

  it("confirm_identity(false) -> no mark", async () => {
    const { call, db } = await confirmedCall();
    await call.callTool("confirm_identity", { name_confirmed: false });
    await call.settle();
    expect(marks(db)).toHaveLength(0);
    await call.hangUp();
  });

  it("confirmed again after a hold -> still one mark", async () => {
    const { call, db } = await confirmedCall();
    await call.callTool("confirm_identity", { name_confirmed: true });
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.callTool("wait_on_hold", {});
    await call.assistantTurn("Sure, thank you.");
    await call.feed(5000);
    await call.feed(600, { voiced: true });
    await call.feed(400);
    await call.callerSays("Hi, it's Sam.");
    await call.callTool("confirm_identity", { name_confirmed: true });
    await call.settle();
    expect(marks(db)).toHaveLength(1);
    await call.hangUp();
  });
});
