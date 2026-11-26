// ---------------------------------------------------------------------------
// LVX181 / Hammersleys round 3 (2026-11-26): the "umm" reply hold.
//
// After our question, a caller makes a short sound with no word in it ("A",
// "el", nothing the transcript could spell) while they think. Gemini's own VAD
// ends the turn on sound + silence and the model answers it -- usually a
// re-ask ("Sorry, I'm not sure which day and time you need...") over the caller
// who was about to answer. Call B (CAfd5c1c…fdaf): "A" -> re-ask, ~9 s lost.
//
// The hold keeps that reply's audio back. The caller carries on talking ->
// the kept reply is dropped and the model answers their full sentence. The
// caller stays quiet for 2 s -> it plays. Every other reply is untouched.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Harbour Lane Studio",
  mainPhone: "+15550104000",
  timezone: "America/Chicago",
  businessHours: {},
  locale: "en-US",
  allowedTasks: ["general_question"],
  capabilities: {},
};
const QUESTION = "Lovely. What day and time would you like?";
const REASK = "Sorry, I'm not sure which day and time you need. Could you tell me again?";

/** 24 kHz PCM16, what Live sends. */
function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

async function boot({ env = {} } = {}) {
  const s = await bootLive({ config: CONFIG, callSid: "CA_umm", env });
  const enqueue = vi.spyOn(s.ws.liveAudioOut, "enqueue");
  const h = {
    ...s,
    enqueue,
    /** Model audio for the current generation. */
    async audio(ms = 1500) {
      s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });
      await s.feed(0);
    },
    /** Our question, spoken and finished, and its audio drained. */
    async asked(text = QUESTION) {
      await h.audio(1500);
      await s.assistantTurn(text);
      await s.feed(2500);
    },
    /** The caller makes a sound of `ms`, then `quietMs` of silence. */
    async sound(ms, quietMs = 600) {
      await s.feed(ms, { voiced: true });
      await s.feed(quietMs);
    },
  };
  return h;
}

const c = () => counters();

describe("LVX181 round 3 — a reply to a wordless sound after our question is held", () => {
  beforeEach(() => clearStats());

  it("'A' after our question: held, then released after 2 s of silence", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_hold_started).toBe(1);

    await s.feed(700); // ~1.3 s since the sound: still held
    expect(s.enqueue).not.toHaveBeenCalled();

    await s.feed(1000); // ~2.3 s: released
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_released).toBe(1);
    expect(c().live_umm_hold_dropped ?? 0).toBe(0);
  });

  it("the caller carries on talking before turnComplete: their words drop it, the rest of that generation too", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.feed(300, { voiced: true });
    // Review I2: our own VAD alone is not enough -- Live may ignore that sound.
    expect(c().live_umm_hold_dropped ?? 0).toBe(0);
    await s.callerSays(" Saturday at seven.");
    expect(c().live_umm_hold_dropped).toBe(1);
    await s.audio(800); // more of the dropped generation
    await s.feed(500);
    expect(s.enqueue).not.toHaveBeenCalled();

    // Live cuts its own generation on the new speech; the next reply plays at once.
    s.live.push({ serverContent: { interrupted: true } });
    await s.feed(0);
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("the caller carries on after turnComplete: dropped, and the NEXT reply is not thrown away", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1500);
    await s.assistantTurn(REASK);
    expect(s.enqueue).not.toHaveBeenCalled();

    await s.feed(300, { voiced: true });
    expect(c().live_umm_hold_dropped ?? 0).toBe(0);
    await s.callerSays("Saturday at seven, please.");
    expect(c().live_umm_hold_dropped).toBe(1);
    await s.feed(600);
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    // A dropped re-ask never leaves a nudge behind it.
    expect(c().nudges_fired ?? 0).toBe(0);
  });

  it("interrupted during the hold: dropped, nothing plays", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("el");
    s.enqueue.mockClear();
    await s.audio(1500);
    s.live.push({ serverContent: { interrupted: true } });
    await s.feed(3000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_hold_dropped).toBe(1);
  });

  it("a word arriving after the kept reply's turnComplete, with no new voice, is the same sound: released, not dropped", async () => {
    // Review I1: Live's copy of "A ... yes" can land late. Dropping it would
    // leave silence -- Live thinks it has already answered.
    const s = await boot();
    await s.asked("Will you need a child seat?");
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn("Sorry, was that a yes or a no?");
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.callerSays(" yes.");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_released).toBe(1);
    expect(c().live_umm_hold_dropped ?? 0).toBe(0);
  });

  it("noise after the kept reply (voice, never words): played 2 s after the noise ends", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn(REASK);
    await s.feed(3000, { voiced: true });
    await s.feed(1500);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.feed(700);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_released).toBe(1);
  });

  it("continuous noise never strands it: the hard cap plays it", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn(REASK);
    await s.feed(10_500, { voiced: true });
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_released).toBe(1);
  });

  // Re-review (new Important): past turnComplete Live sends no interrupted, so
  // a caller who thinks ~2 s and then answers -- with Live's copy of their
  // words landing late -- must not hear the stale re-ask after their answer.
  it("the caller answers after a pause, words land late: the stale re-ask never plays", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn(REASK);
    await s.feed(400);
    await s.feed(1500, { voiced: true }); // the real answer
    await s.feed(900); // its words not in yet
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.callerSays("Saturday at seven, please.");
    expect(c().live_umm_hold_dropped).toBe(1);
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("one noise frame before late words is not the caller resuming: released", async () => {
    const s = await boot();
    await s.asked("Will you need a child seat?");
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn("Sorry, was that a yes or a no?");
    await s.feed(20, { voiced: true });
    await s.callerSays(" yes.");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_dropped ?? 0).toBe(0);
  });

  it("a tool call after the kept reply's turnComplete drops it (the stale re-ask never plays first)", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    await s.assistantTurn(REASK);
    await s.callTool("set_call_intent", { intent: "general_question" });
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_hold_dropped).toBe(1);
  });

  it("a tool call during the hold releases it (tool effects never wait)", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.callTool("set_call_intent", { intent: "general_question" });
    expect(s.enqueue).toHaveBeenCalled();
  });
});

describe("LVX181 round 3 — what is never held", () => {
  beforeEach(() => clearStats());

  it("control: the same 'A' after a statement (no question) plays at once", async () => {
    const s = await boot();
    await s.asked("Thanks, I have that noted.");
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it("control: a real answer (1.2 s of voice, words) plays at once", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(1200, 600);
    await s.callerSays("Saturday at seven works.");
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it.each(["No.", "Two", "10", "Mhm."])("control: the short answer %j plays at once", async (said) => {
    const s = await boot();
    await s.asked("How many passengers will there be?");
    await s.sound(200, 600);
    await s.callerSays(said);
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it("control: an empty transcript (words not in yet) is not held", async () => {
    const s = await boot();
    await s.asked("Will you need a child seat?");
    await s.sound(300, 600);
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it("control: a tool call before the audio means no hold", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    await s.callTool("set_call_intent", { intent: "general_question" });
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it("LIVE_UMM_HOLD=off: no hold", async () => {
    const s = await boot({ env: { LIVE_UMM_HOLD: "off" } });
    await s.asked();
    await s.sound(40, 600);
    await s.callerSays("A");
    s.enqueue.mockClear();
    await s.audio(1200);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });
});
