// ---------------------------------------------------------------------------
// Hammersleys round 5, Task 3 (owner ruling R43): after a tool reply that
// followed a question, the model's next audio is held until its words show it
// is not that question again. A repeat is dropped (the caller never hears it);
// anything new plays; no decision in 1.5 s plays; the caller breaking in drops
// it. Kill switch LIVE_REPEAT_HOLD=off.
//
// Why: the existing within-turn repeat cut reads the transcript, which lands
// behind the audio, so on owner call 2 part of each second copy was heard
// ("Yes I heard questions twice"). Holding the audio until the words arrive
// costs nothing audible: Live is seconds ahead of playback at a tool call
// (probe 0b: 2.4-4.9 s), so the caller is still hearing the first copy.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork Cars",
  greeting: "Thanks for calling Brightwork Cars.",
  mainPhone: "+18176011171",
  timezone: "Europe/London",
  locale: "en-GB",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};
const SAVE = { request_type: "message", caller_name: "Jon Doe", callback_number: "214 555 0123", message: "Taxi to Gatwick" };
const QUESTION = "Got it, 12 High Street. Which terminal at Gatwick do you need?";

function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

async function boot({ env = {}, callSid = "CA_rh" } = {}) {
  const s = await bootLive({ config: CONFIG, callSid, env });
  const enqueue = vi.spyOn(s.ws.liveAudioOut, "enqueue");
  const h = {
    ...s,
    enqueue,
    async audio(ms = 800) {
      s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });
      await s.feed(0);
    },
    /** The caller gives the pickup; the model speaks `words` and saves, in one turn. */
    async spokeThenSaved(words = QUESTION) {
      await s.callerSays("Pick me up from 12 High Street, going to Gatwick.");
      await h.audio(1500);
      await s.assistantSays(words);
      const [r] = await s.callTool("record_customer_request", SAVE);
      expect(r.response.success).toBe(true);
    },
  };
  return h;
}
const c = () => counters();

describe("round 5: the repeat hold", () => {
  beforeEach(() => clearStats());

  it("question, save, the same question again: the second copy's audio never reaches Twilio", async () => {
    const s = await boot();
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_started).toBe(1);
    await s.assistantSays("Which terminal at Gatwick do you need?");
    await s.audio(800);
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
    // The dropped words were never heard: the transcript cut does not fire on them.
    expect(c().live_repeat_cut ?? 0).toBe(0);
  });

  it("the continuation comes after the tool turn's own turnComplete: still held and dropped", async () => {
    const s = await boot({ callSid: "CA_rh_tc" });
    await s.spokeThenSaved();
    await s.turnEnds(); // Gemini's turnComplete ~17 ms after the call, before the continuation
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.assistantSays("Which terminal at Gatwick do you need?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("question, save, a reworded question: played once its words arrive (Review Focus 2)", async () => {
    const s = await boot({ callSid: "CA_rh_new" });
    await s.spokeThenSaved("Got it, 12 High Street. Which terminal do you need?");
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.assistantSays("What terminal are you flying from, North or South?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_released).toBe(1);
    expect(c().live_repeat_hold_dropped ?? 0).toBe(0);
  });

  it("statement, save, question: not held at all (the normal path)", async () => {
    const s = await boot({ callSid: "CA_rh_stmt" });
    await s.spokeThenSaved("Got it, 12 High Street.");
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_started ?? 0).toBe(0);
    expect(c().live_repeat_hold_armed ?? 0).toBe(0);
  });

  it("no words within 1.5 s: played (timeout)", async () => {
    const s = await boot({ callSid: "CA_rh_to" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.feed(1000);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.feed(700);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_timeout).toBe(1);
  });

  it("the caller breaks in while it is held: dropped, nothing stale plays after (Review Focus 5)", async () => {
    const s = await boot({ callSid: "CA_rh_barge" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    s.live.push({ serverContent: { interrupted: true } });
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_barged).toBe(1);
    // The model's next reply (to what the caller said) plays at once.
    await s.callerSays("North terminal.");
    await s.audio(600);
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("the caller answers before any continuation: the arm is spent, their reply is not held", async () => {
    const s = await boot({ callSid: "CA_rh_ans" });
    await s.spokeThenSaved();
    await s.turnEnds();
    await s.feed(600, { voiced: true });
    await s.feed(900);
    await s.callerSays("North.");
    s.enqueue.mockClear();
    await s.audio(600);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_started ?? 0).toBe(0);
  });

  it("LIVE_REPEAT_HOLD=off: today's behaviour, nothing held", async () => {
    const s = await boot({ env: { LIVE_REPEAT_HOLD: "off" }, callSid: "CA_rh_off" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_armed ?? 0).toBe(0);
  });

  it("the umm hold never keeps a chunk the repeat hold has", async () => {
    const s = await boot({ callSid: "CA_rh_umm" });
    await s.spokeThenSaved();
    await s.audio(800);
    await s.assistantSays("Which terminal at Gatwick do you need?");
    await s.turnEnds();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
    expect(c().live_repeat_hold_dropped).toBe(1);
  });
});
