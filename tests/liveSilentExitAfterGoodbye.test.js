// ---------------------------------------------------------------------------
// S4-F1. SILENCE AFTER A HELD GOODBYE ENDS THE CALL WITHOUT ANOTHER LINE.
//
// Live, a wrong-number call: a polite close, then the goodbye's exit was HELD
// (live_goodbye_exit_held_no_ask: the call had never asked "anything else?").
// The caller stayed silent and heard "Hello? Are you still there?" twice, then
// a backwards "I will let you go. Before you go, is there anything else...":
// about 25 seconds of talk after the goodbye. checkSilence knew nothing about a
// goodbye that was spoken but whose exit was held, so rung 1 nudged.
//
// Owner's rule: after a goodbye has been said and held, a caller who stays
// quiet gets a SILENT hang-up -- no nudge, no second goodbye. If they speak,
// the call carries on normally.
//
// The three ways a farewell is spoken and its exit not armed: the no_ask hold,
// the caller-question hold, and a farewell suppressed because end_call was
// refused on the same turn. All three latch; real caller speech clears it.
//
// bootLive, so the real end_call gate (services/tools.js) decides the refusal.
// Made-up business; no real business's wording.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { getStrings } from "../lib/voice/strings.js";
import { greetingTextFor } from "../lib/voice/greeting.js";

const CONFIG = {
  businessName: "Harbour Lane Studio",
  mainPhone: "+15550104000",
  timezone: "America/Chicago",
  businessHours: {},
  locale: "en-US",
  allowedTasks: ["general_question"],
  capabilities: {},
};

const GOODBYE = "No problem at all. Thanks for calling Harbour Lane Studio, and have a great day!";
const EXIT_MARK = "live-exit-end_call";

/** 24 kHz PCM16, what Live sends; the session converts and queues it. */
function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

// An outbound call, on the same fakes tests/outboundSignoffGate.test.js uses.
const OUT_SID = "CA_s4f1_outbound";
const OUT_BIZ = "biz-s4f1";
const OUT_CONFIG = { ...CONFIG, businessId: OUT_BIZ, liveVoice: null };
function outboundDb() {
  return {
    ...fakeDb(OUT_CONFIG, OUT_BIZ),
    withTenant: vi.fn(async (_id, fn) => fn()),
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === OUT_SID
        ? { businessId: OUT_BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 }
        : null
    ),
    outboundCallContext: vi.fn(async () => ({
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
      config: { persona_name: "Ava", caller_id: CONFIG.mainPhone, capabilities: [] },
      firstName: "Priya",
      contactTimezone: "America/Chicago",
    })),
    fetchBusinessById: vi.fn(async () => ({
      id: OUT_BIZ,
      name: CONFIG.businessName,
      timezone: CONFIG.timezone,
      phone_number: CONFIG.mainPhone,
    })),
    fetchBusinessCapabilities: vi.fn(async () => []),
  };
}

async function boot({ outbound = false } = {}) {
  const s = outbound
    ? await bootLive({
        config: OUT_CONFIG,
        callSid: OUT_SID,
        customParameters: { direction: "outbound" },
        authorizedCallSid: OUT_SID,
        database: outboundDb(),
      })
    : await bootLive({ config: CONFIG, callSid: "CA_s4f1" });
  // The marks the session asks the pacing queue to send behind its audio. Read
  // at the request, not on the wire: this harness's clock jumps a whole feed()
  // in one synchronous loop, so the queue (paced against that clock) is still
  // holding the goodbye's frames when the exit is armed, and a real call's
  // has long drained by then.
  const marks = [];
  const audioOut = s.ws.liveAudioOut;
  const sendMark = audioOut.sendMark;
  audioOut.sendMark = (name) => {
    marks.push(name);
    return sendMark(name);
  };
  return {
    ...s,
    marks,
    /** The model speaks (audio, then its transcript) and the turn ends. */
    async says(text, ms = 2000) {
      s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });
      await s.assistantTurn(text);
    },
    /** Every line the silence ladder asked the model to speak. */
    silenceLines: () =>
      s.live.sent.clientContent
        .map((m) => m?.turns?.[0]?.parts?.[0]?.text || "")
        .filter((t) => t.includes("the caller has gone quiet")),
    /** Twilio echoing the exit mark, then the hang-up's grace window. */
    async exitPlays() {
      s.ws.deliver({ event: "mark", mark: { name: EXIT_MARK }, streamSid: "MZ1" });
      await new Promise((r) => setTimeout(r, 1_800));
    },
  };
}

const c = () => counters();

/** The wrong-number call: the caller says so, the model signs off without asking. */
async function heldGoodbye() {
  const s = await boot();
  await s.callerSays("Oh, sorry, I think I dialled the wrong number.");
  await s.says(GOODBYE);
  expect(c().live_goodbye_exit_held_no_ask).toBe(1);
  return s;
}

describe("S4-F1: a caller silent after a held goodbye is hung up on without another line", () => {
  beforeEach(() => clearStats());

  it("held goodbye (no ask), then silence: no nudge, the call ends, counted once", async () => {
    const s = await heldGoodbye();
    expect(c().live_goodbye_latched_silent).toBe(1);

    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    expect(c().silence_hangups ?? 0).toBe(0);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    // The hang-up rides the ordinary exit: its mark goes out, and the line
    // closes once Twilio says it played and the grace window has passed.
    expect(s.marks).toContain(EXIT_MARK);
    expect(s.ws.readyState).toBe(1);
    await s.exitPlays();
    expect(s.ws.readyState).toBe(3);
  });

  it("held goodbye, then the caller speaks, then silence: the normal ladder (nudge 1)", async () => {
    const s = await heldGoodbye();
    await s.feed(1_000);
    await s.callerSays("Actually, while I have you, do you do portraits?");
    await s.feed(12_000);

    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(s.silenceLines()[0]).toContain("Hello? Are you still there?");
    expect(c().live_silence_exit_after_goodbye ?? 0).toBe(0);
    // Latched, then the caller spoke: the two counters read apart.
    expect(c().live_goodbye_latched_silent).toBe(1);
  });

  it("held goodbye, then the caller's voice on the line (frames, no words yet), then silence: the normal ladder", async () => {
    const s = await heldGoodbye();
    // Past the goodbye's own audio, so this is the caller and not our echo.
    await s.feed(2_500);
    await s.feed(400, { voiced: true });
    await s.feed(12_000);

    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(c().live_silence_exit_after_goodbye ?? 0).toBe(0);
  });

  it("the greeting turn, then silence: the normal ladder; a greeting never latches", async () => {
    const s = await boot();
    const greeting = greetingTextFor(CONFIG);
    // signOffRe is what latches, and the greeting's "thanks for calling" is
    // not a sign-off.
    expect(getStrings(CONFIG).signOffRe.test(greeting)).toBe(false);
    await s.says(greeting);
    await s.feed(12_000);

    expect(c().live_goodbye_latched_silent ?? 0).toBe(0);
    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(s.silenceLines()[0]).toContain("Hello? Are you still there?");
    expect(c().live_silence_exit_after_goodbye ?? 0).toBe(0);
  });

  it("a farewell suppressed by a refused end_call, then silence: the silent exit", async () => {
    const s = await boot();
    await s.callerSays("Sorry, wrong number.");
    // Turn one, nothing done: the real gate refuses the hang-up.
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    await s.says(GOODBYE);
    expect(c().live_goodbye_suppressed_by_refusal).toBe(1);
    expect(c().live_goodbye_latched_silent).toBe(1);

    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    expect(s.marks).toContain(EXIT_MARK);
  });

  it("a farewell held for the caller's question back, then silence: the silent exit", async () => {
    const s = await boot();
    await s.says("Is there anything else I can help you with?");
    await s.callerSays("Do you open on Saturdays?");
    await s.says("We don't, I'm afraid. Thanks for calling Harbour Lane Studio, and have a great day!");
    expect(c().live_goodbye_exit_held_caller_question).toBe(1);
    expect(c().live_goodbye_latched_silent).toBe(1);

    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    expect(s.marks).toContain(EXIT_MARK);
  });

  it("the caller speaking in the hang-up's grace window calls it off, and the ladder carries on", async () => {
    const s = await heldGoodbye();
    await s.feed(30_000);
    expect(c().live_silence_exit_after_goodbye).toBe(1);

    await s.callerSays("Wait, sorry, one more thing please.");
    expect(c().live_exit_cancelled_by_caller).toBe(1);
    await s.feed(12_000);

    // Back on the ordinary ladder: a nudge, and no second silent exit.
    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    expect(s.ws.readyState).toBe(1);
  });

  it("outbound reaches the no_ask hold too, and gets the same silent exit (a goodbye was said either way)", async () => {
    const s = await boot({ outbound: true });
    // Past the opening seconds: in clip mode a turn before the backstop
    // decision is unheard (see tests/outboundSignoffGate.test.js).
    await s.feed(1_400);
    await s.says("Thanks for your time, Priya. Bye for now.");
    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
    expect(c().live_goodbye_latched_silent).toBe(1);

    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    expect(s.marks).toContain(EXIT_MARK);
  });

  // Review fix (S4-F1). The no_ask refusal tells the model to say exactly this
  // as its next turn. The caller has now been ASKED something; a silent
  // hang-up ~6 s after a question is not the owner's rule.
  it("held goodbye, then a separate turn that asks, then silence: the question gets the normal ladder", async () => {
    const s = await heldGoodbye();
    expect(c().live_goodbye_latched_silent).toBe(1);
    await s.says("Before you go - is there anything else I can help you with?");
    await s.feed(30_000);

    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(s.silenceLines()[0]).toContain("Hello? Are you still there?");
    expect(c().live_silence_exit_after_goodbye ?? 0).toBe(0);
  });

  it("ONE turn that says goodbye and then asks (backwards), then silence: still the silent exit", async () => {
    // The caller heard a goodbye in that turn, so the ask in it does not clear
    // the latch. The same turn sets it: the ask has not been answered (LVX145's
    // marker), so the no_ask hold fires on this turn's own farewell.
    const s = await boot();
    await s.callerSays("Oh, sorry, I think I dialled the wrong number.");
    await s.says(
      "No problem. Thanks for calling Harbour Lane Studio, have a great day. Is there anything else I can help you with?"
    );
    expect(c().live_goodbye_exit_held_no_ask).toBe(1);
    expect(c().live_goodbye_latched_silent).toBe(1);

    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    expect(s.marks).toContain(EXIT_MARK);
  });

  it("a transcript of only punctuation in the grace window is not the caller: the silent exit re-arms", async () => {
    const s = await heldGoodbye();
    await s.feed(30_000);
    await s.callerSays("?");
    await s.feed(30_000);

    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    expect(c().live_silence_exit_after_goodbye).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Hammersleys round 3, E3 (call CAde88b5…2fdea1, 2026-11-25): a nudge fired
// 1.5 s after live_exit_armed -- inside the hang-up's grace window -- and the
// exit cut it 0.1 s later. Nothing is said over ANY armed exit; S4-F1 above
// covered only the quiet-latched one.
// ---------------------------------------------------------------------------
describe("round 3 E3: no silence line while an exit is armed", () => {
  beforeEach(() => clearStats());

  async function askedThenGoodbye() {
    const s = await boot();
    await s.callerSays("Could you note that I'd like a portrait session on Saturday?");
    await s.says("I've noted that for Saturday. Is there anything else I can help you with?");
    await s.callerSays("No, that's all, thanks.");
    await s.says(GOODBYE);
    expect(c().live_goodbye_armed_exit).toBe(1);
    return s;
  }

  it("an armed goodbye exit whose mark is slow: no nudge over it, then it plays", async () => {
    const s = await askedThenGoodbye();
    expect(s.marks).toContain(EXIT_MARK);
    await s.feed(14_000);
    expect(s.silenceLines()).toEqual([]);
    expect(c().nudges_fired ?? 0).toBe(0);
    await s.exitPlays();
    expect(s.ws.readyState).toBe(3);
  });

  it("the caller calls the armed exit off: the ladder comes back", async () => {
    const s = await askedThenGoodbye();
    await s.callerSays("Oh wait, one more thing, sorry.");
    expect(c().live_exit_cancelled_by_caller).toBe(1);
    await s.feed(14_000);
    expect(c().nudges_fired).toBeGreaterThanOrEqual(1);
    expect(s.ws.readyState).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Hammersleys round 3, E4 (call CA…6c0d37, 2026-11-25): "Is there anything else
// I can assist you with today? Thank you for calling, and I hope you have a
// wonderful day." in ONE turn, end_call with it. The exit is held at turn end
// (the ask is unanswered) but the quiet latch was never set there, so 4 s later
// the ladder said "Hello? Are you still there?" and the caller got a second
// goodbye. A goodbye the caller heard is followed by silence, not a nudge.
// ---------------------------------------------------------------------------
describe("round 3 E4: ask + goodbye in one breath, held at turn end, goes quiet", () => {
  beforeEach(() => clearStats());
  const ASK = "Great. Is there anything else I can assist you with today?";
  const BYE = "Thank you for calling, and I hope you have a wonderful day.";

  async function heldAtTurnEnd({ goodbye }) {
    const s = await boot();
    await s.feed(800, { voiced: true });
    await s.feed(1500);
    await s.callerSays("Could you note that I'd like a portrait session on Saturday?");
    await s.says("Saturday works. What time suits you?");
    await s.feed(800, { voiced: true });
    await s.feed(1500);
    await s.callerSays("Ten in the morning, thanks.");
    await s.says("Ten in the morning works. Will it be just you?");
    await s.feed(800, { voiced: true });
    await s.feed(1500);
    await s.callerSays("Just me, thanks.");
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(3000) } }] } } });
    await s.assistantSays(ASK);
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(true);
    await s.assistantTurn(goodbye ? BYE : "");
    expect(c().live_exit_held_in_turn_ask).toBe(1);
    return s;
  }

  it("then silence: no 'are you still there?', the call ends quietly", async () => {
    const s = await heldAtTurnEnd({ goodbye: true });
    expect(c().live_goodbye_latched_silent).toBe(1);
    await s.feed(30_000);
    expect(s.silenceLines()).toEqual([]);
    expect(c().live_silence_exit_after_goodbye).toBe(1);
    await s.exitPlays();
    expect(s.ws.readyState).toBe(3);
  });

  it("control: the ask alone (no goodbye) keeps today's nudge", async () => {
    const s = await heldAtTurnEnd({ goodbye: false });
    expect(c().live_goodbye_latched_silent ?? 0).toBe(0);
    await s.feed(12_000);
    expect(s.silenceLines()[0]).toContain("Hello? Are you still there?");
  });

  it("the caller answers the held ask: no quiet exit, the call carries on", async () => {
    const s = await heldAtTurnEnd({ goodbye: true });
    await s.callerSays("Actually, is there parking near you?");
    await s.says("Yes, there is free parking right outside. Is there anything else?");
    await s.feed(12_000);
    expect(c().live_silence_exit_after_goodbye ?? 0).toBe(0);
    expect(s.ws.readyState).toBe(1);
  });
});
