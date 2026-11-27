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

  // ---- Opus review fix pass (2026-11-26) -----------------------------------
  it("review I1: our own barge clear (no interrupt from Live) drops the held continuation", async () => {
    const s = await boot({ callSid: "CA_rh_clear" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.feed(800, { voiced: true }); // the caller talks over the first copy: the gate barges and clears
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("review I3: an acknowledgement before the same short question is still a repeat", async () => {
    const s = await boot({ callSid: "CA_rh_ack" });
    await s.spokeThenSaved("Got it, 12 High Street. Which terminal do you need?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("Got it. Which terminal do you need?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("review I3: 'And what's your full name?' after 'What's your full name?' is a repeat", async () => {
    const s = await boot({ callSid: "CA_rh_name" });
    await s.spokeThenSaved("Of course. What's your full name?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("Thanks. And what's your full name?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("review I3: a different question sharing only its opening ('What is the ...') is played", async () => {
    const s = await boot({ callSid: "CA_rh_diff" });
    await s.spokeThenSaved("Got it. What is the pickup address?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("What is the destination?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped ?? 0).toBe(0);
  });

  it("re-review 1: new information then the re-ask is played, never dropped whole (an offer must be heard)", async () => {
    const s = await boot({ callSid: "CA_rh_offer" });
    await s.spokeThenSaved("Lovely. What day works for you?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("I have Tuesday at ten or Wednesday at two open. What day works for you?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped ?? 0).toBe(0);
  });

  it("re-review 2: a different question in the same frame is played ('What's your name?' -> '...phone number?')", async () => {
    for (const [i, [q, next]] of [
      ["Thanks. What's your name?", "Thanks John. What's your phone number?"],
      ["Got it. Where are you going?", "Where are you being picked up from?"],
      ["Lovely. What's the pickup address?", "What's the pickup time?"],
    ].entries()) {
      clearStats();
      const s = await boot({ callSid: `CA_rh_frame${i}` });
      await s.spokeThenSaved(q);
      s.enqueue.mockClear();
      await s.audio(800);
      await s.assistantSays(next);
      expect(s.enqueue, next).toHaveBeenCalled();
      expect(c().live_repeat_hold_dropped ?? 0, next).toBe(0);
    }
  });

  it("re-review 3: a longer acknowledgement before the same question is still a repeat", async () => {
    const s = await boot({ callSid: "CA_rh_ack5" });
    await s.spokeThenSaved("Lovely. Which terminal do you need?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("Okay, great, thank you. And which terminal do you need?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("re-review 3: the old question plus a new clause is played ('...and how many suitcases?')", async () => {
    for (const [i, [q, next]] of [
      ["Got it. How many passengers?", "How many passengers, and how many suitcases?"],
      ["Thanks. Is that right?", "Is that right? And what time would you like picking up?"],
    ].entries()) {
      clearStats();
      const s = await boot({ callSid: `CA_rh_clause${i}` });
      await s.spokeThenSaved(q);
      s.enqueue.mockClear();
      await s.audio(800);
      await s.assistantSays(next);
      expect(s.enqueue, next).toHaveBeenCalled();
      expect(c().live_repeat_hold_dropped ?? 0, next).toBe(0);
    }
  });

  it("re-review 3: a short tail after the same question ('North or South?') is still a repeat", async () => {
    const s = await boot({ callSid: "CA_rh_tail" });
    await s.spokeThenSaved("Got it. Which terminal do you need?");
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("Which terminal do you need, North or South?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it("review I4: words of a dropped repeat that land after its turnComplete do not reach the next turn", async () => {
    const s = await boot({ callSid: "CA_rh_late" });
    await s.spokeThenSaved();
    await s.audio(800);
    await s.assistantSays(" Which terminal at Gatwick do you need?");
    await s.turnEnds(); // dropped at its generation's end
    expect(c().live_repeat_hold_dropped).toBe(1);
    // The caller answers the first copy; their turn opens (flushing the old turn)...
    await s.callerSays("North.");
    await s.feed(300, { voiced: true });
    // ...and only then does the dropped repeat's tail arrive.
    await s.assistantSays(" North or South?");
    // The model saves before it speaks: the turn's words must not read as "already asked"
    // (Task 1 and the live_tool_words instrument both read them).
    await s.callTool("record_customer_request", SAVE);
    expect(c().live_tool_words_q_at_call).toBe(1); // the first save only
    expect(c().live_tool_words_no_q_at_call).toBe(1);
    expect(c().live_repeat_hold_armed).toBe(1);
  });

  it("review I5: a two-word repeat decided at its turnComplete leaves no words in the turn", async () => {
    const s = await boot({ callSid: "CA_rh_short" });
    await s.spokeThenSaved("Got it. Which terminal?");
    s.enqueue.mockClear();
    await s.audio(600);
    await s.assistantSays("Which terminal?");
    await s.turnEnds();
    expect(c().live_repeat_hold_dropped).toBe(1);
    await s.callerSays("North.");
    await s.feed(600, { voiced: true });
    await s.feed(600);
    await s.assistantTurn("Got it, North.");
    const said = s.ws.liveTurnState().assistantSaidThisCall;
    expect(said.match(/which terminal/gi) || []).toHaveLength(1);
  });

  it("review M7: a hold still undecided after its turnComplete does not swallow the next generation", async () => {
    const s = await boot({ callSid: "CA_rh_next" });
    await s.spokeThenSaved();
    await s.audio(600); // held, no words yet
    await s.turnEnds();
    s.enqueue.mockClear();
    await s.audio(600); // a new generation (e.g. a reply to a note)
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("ruling: a question then end_call in one batch does not arm (a held goodbye could follow the hang-up)", async () => {
    const s = await boot({ callSid: "CA_rh_end" });
    await s.callerSays("No, that's all.");
    await s.audio(1500);
    await s.assistantSays("Lovely. Is there anything else?");
    await s.callTool("end_call", {});
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

// ---------------------------------------------------------------------------
// Hammersleys round 6, item 4: after the already-asked note the model emitted
// "<no speech detected>" (2 of 2 fires on round-5 calls). The hold counted it
// as three new words and played it after the 1.5 s cap; on an earlier call
// (O1 CA591a92) such markup was spoken aloud. A tail of markup only is never
// played; markup mixed with words is decided on the words.
// ---------------------------------------------------------------------------
describe("round 6: a markup-only tail", () => {
  beforeEach(() => clearStats());

  it("'<no speech detected>' after a held question: dropped at the generation's end, never played", async () => {
    const s = await boot({ callSid: "CA_r6_mk" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("<no speech detected>");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
    expect(c().live_repeat_hold_timeout ?? 0).toBe(0);
    expect(c().live_repeat_hold_released ?? 0).toBe(0);
  });

  it("'{pause}' alone, no turnComplete: dropped at the cap, never played", async () => {
    const s = await boot({ callSid: "CA_r6_mk_cap" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("{pause}");
    await s.feed(1700);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("markup then a new question: decided on the words, played", async () => {
    const s = await boot({ callSid: "CA_r6_mk_new" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("<no speech detected> ");
    await s.assistantSays("And what time is your flight?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_released).toBe(1);
  });

  it("markup then the same question again: dropped as a repeat", async () => {
    const s = await boot({ callSid: "CA_r6_mk_rep" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("{pause} Which terminal at Gatwick do you need?");
    await s.turnEnds();
    await s.feed(2000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped).toBe(1);
  });

  it("the next generation after a dropped markup tail plays at once (review M7 kept)", async () => {
    const s = await boot({ callSid: "CA_r6_mk_next" });
    await s.spokeThenSaved();
    await s.audio(600);
    await s.assistantSays("<no speech detected>");
    await s.turnEnds();
    await s.feed(1200);
    s.enqueue.mockClear();
    await s.audio(600);
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("markup outside any hold is counted (live_model_markup_seen) and its audio is untouched", async () => {
    const s = await boot({ callSid: "CA_r6_mk_seen" });
    await s.callerSays("Hello?");
    s.enqueue.mockClear();
    await s.audio(600);
    await s.assistantSays("<noise> Hello, how can I help?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_model_markup_seen).toBe(1);
    await s.assistantSays(" Sorry, go on.");
    expect(c().live_model_markup_seen).toBe(1);
  });

  it("LIVE_REPEAT_HOLD=off: nothing held, the markup audio plays as before", async () => {
    const s = await boot({ callSid: "CA_r6_mk_off", env: { LIVE_REPEAT_HOLD: "off" } });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped ?? 0).toBe(0);
  });
});

describe("round 6 review 6: markup then real words that land after turnComplete", () => {
  beforeEach(() => clearStats());
  it("'{pause}' and then the say-back's words arriving late: played, not dropped", async () => {
    const s = await boot({ callSid: "CA_r6_mk_late" });
    await s.spokeThenSaved();
    s.enqueue.mockClear();
    await s.audio(800);
    await s.assistantSays("{pause} ");
    await s.turnEnds();
    await s.assistantSays("I've got 12 High Street. And what time is your flight?");
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_repeat_hold_dropped ?? 0).toBe(0);
  });
});
