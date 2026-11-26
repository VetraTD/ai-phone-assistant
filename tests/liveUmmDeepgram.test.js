// ---------------------------------------------------------------------------
// Hammersleys round 5, Task 4 (owner rulings R42 + R46): the "Ahm" hold reads
// Deepgram when Live's own transcript is late.
//
// Owner call 3: "Ahm" + a 2 s pause got a reply, because Live's side transcript
// lagged 5-10 s and the umm hold never holds an EMPTY transcript (a real "Yes."
// may still be on its way). The Deepgram shadow lands ~0.6 s after speech.
// Task 0 (2026-11-26): Deepgram writes "Ahm" as a word but drops "um"/"uh"
// (filler_words changes nothing) and writes nothing at all for a bare "Ummm".
// So, with Live's text empty after our question and a short sound:
//   - Deepgram words ("Two.", "Yes.", "Mm-mm.", "Uh-huh.") -> play at once;
//   - Deepgram "Ahm"/"um" -> held as a hesitation (round-4 rules);
//   - Deepgram nothing -> wait <= 700 ms for it; words -> play; still nothing
//     -> held as a hesitation (dropped if the caller goes on, played after 3 s).
// Off unless LIVE_UMM_DEEPGRAM lists the business AND the shadow is connected:
// otherwise exactly round 4.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork Cars",
  mainPhone: "+15550104000",
  timezone: "Europe/London",
  businessHours: {},
  locale: "en-GB",
  allowedTasks: ["general_question"],
  capabilities: {},
};
const QUESTION = "Lovely. What is the pickup address?";
const ON = { LIVE_SHADOW_STT: "biz-1", LIVE_UMM_DEEPGRAM: "biz-1", DEEPGRAM_API_KEY: "test-key", DEEPGRAM_REGION: "eu" };

function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

/** A fake Deepgram stream the test speaks through. */
function fakeDeepgram({ fail = false } = {}) {
  const dg = { onFinal: null, onInterim: null, connected: false };
  dg.connect = async (opts) => {
    if (fail) throw new Error("bad key");
    dg.onFinal = opts.onFinal;
    dg.onInterim = opts.onInterim;
    dg.connected = true;
    return { sendAudio() {}, close() {}, finalize: async () => {} };
  };
  dg.say = (text, { final = true } = {}) => (final ? dg.onFinal?.(text, { confidence: 0.9 }) : dg.onInterim?.(text, { confidence: 0.9 }));
  return dg;
}

async function boot({ env = ON, dg = fakeDeepgram(), callSid = "CA_udg" } = {}) {
  const s = await bootLive({ config: CONFIG, callSid, env, shadowConnect: dg.connect });
  await s.feed(0);
  const enqueue = vi.spyOn(s.ws.liveAudioOut, "enqueue");
  const h = {
    ...s,
    dg,
    enqueue,
    async audio(ms = 1500) {
      s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });
      await s.feed(0);
    },
    async asked(text = QUESTION) {
      await h.audio(1500);
      await s.assistantTurn(text);
      await s.feed(2500);
    },
    async sound(ms, quietMs = 600) {
      await s.feed(ms, { voiced: true });
      await s.feed(quietMs);
    },
  };
  return h;
}
const c = () => counters();

describe("round 5: the umm hold reads Deepgram when Live's text is empty", () => {
  beforeEach(() => clearStats());

  it("Deepgram 'Ahm.' before the reply: held as a hesitation; played after 3 s of quiet", async () => {
    const s = await boot();
    await s.asked();
    await s.sound(500, 300);
    s.dg.say("Ahm.", { final: false });
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_dg_hold).toBe(1);
    await s.feed(2000); // ~2.3 s quiet: still held (a hesitation waits 3 s)
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.feed(1000);
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("Deepgram 'Ahm.' then the caller goes on (Live interrupts): the kept reply is dropped", async () => {
    const s = await boot({ callSid: "CA_udg_resume" });
    await s.asked();
    await s.sound(500, 300);
    s.dg.say("Ahm.");
    s.enqueue.mockClear();
    await s.audio(1500);
    s.live.push({ serverContent: { interrupted: true } });
    await s.feed(4000);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_hold_dropped).toBe(1);
  });

  it("Deepgram 'Two.' before the reply: not held, no delay", async () => {
    const s = await boot({ callSid: "CA_udg_two" });
    await s.asked();
    await s.sound(400, 300);
    s.dg.say("Two.");
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_dg_words).toBe(1);
    expect(c().live_umm_hold_started ?? 0).toBe(0);
  });

  it("Deepgram nothing yet: pending; 'Yes.' 300 ms later releases it then", async () => {
    const s = await boot({ callSid: "CA_udg_yes" });
    await s.asked();
    await s.sound(400, 300);
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).not.toHaveBeenCalled();
    await s.feed(300);
    s.dg.say("Yes.");
    await s.feed(0);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_dg_wait_released).toBe(1);
  });

  it("Deepgram nothing by 700 ms: becomes a hesitation hold (not played at 700 ms)", async () => {
    const s = await boot({ callSid: "CA_udg_none" });
    await s.asked();
    await s.sound(600, 300);
    s.enqueue.mockClear();
    await s.audio(1500);
    await s.feed(800);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_dg_wait_timeout).toBe(1);
    await s.feed(2200); // > 3 s since the caller's last voice
    expect(s.enqueue).toHaveBeenCalled();
  });

  it("'Mm-mm.' and 'Uh-huh.' are answers, never thinking (Review Focus 4)", async () => {
    for (const [i, word] of ["Mm-mm.", "Uh-huh.", "Mhmm.", "Nuh-uh."].entries()) {
      clearStats();
      const s = await boot({ callSid: `CA_udg_hum${i}` });
      await s.asked();
      await s.sound(400, 300);
      s.dg.say(word);
      s.enqueue.mockClear();
      await s.audio(1500);
      expect(s.enqueue, word).toHaveBeenCalled();
      expect(c().live_umm_hold_started ?? 0, word).toBe(0);
    }
  });

  it("review M10: spaced hums ('Uh uh.', 'Mm mm.', 'Mm hmm.') are answers too", async () => {
    for (const [i, word] of ["Uh uh.", "Mm mm.", "Mm hmm.", "Uh huh."].entries()) {
      clearStats();
      const s = await boot({ callSid: `CA_udg_sp${i}` });
      await s.asked();
      await s.sound(400, 300);
      s.dg.say(word);
      s.enqueue.mockClear();
      await s.audio(1500);
      expect(s.enqueue, word).toHaveBeenCalled();
      expect(c().live_umm_hold_started ?? 0, word).toBe(0);
    }
  });

  it("review M10: the caller carries on during a pending hold -> Deepgram's words drop it, not play it", async () => {
    const s = await boot({ callSid: "CA_udg_pres" });
    await s.asked();
    await s.sound(500, 300);
    s.enqueue.mockClear();
    await s.audio(1500); // pending: Deepgram has nothing yet
    await s.feed(400, { voiced: true }); // the caller goes on
    s.dg.say("The Greyhound pub in Lingfield.");
    await s.feed(3500);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_hold_dropped).toBe(1);
  });

  it("Deepgram text from before the caller's current sound does not count", async () => {
    const s = await boot({ callSid: "CA_udg_stale" });
    await s.asked();
    s.dg.say("Two."); // a late final for something said before our question
    await s.sound(600, 300);
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(c().live_umm_dg_words ?? 0).toBe(0);
  });

  it("LIVE_UMM_DEEPGRAM on but the shadow never connected: exactly round 4, no hold (Review Focus 3)", async () => {
    const s = await boot({ dg: fakeDeepgram({ fail: true }), callSid: "CA_udg_fail" });
    await s.asked();
    await s.sound(600, 300);
    s.enqueue.mockClear();
    await s.audio(1500);
    expect(s.enqueue).toHaveBeenCalled();
    expect(c().live_umm_hold_started ?? 0).toBe(0);
    expect(c().live_umm_skip_empty).toBe(1);
  });

  it("LIVE_UMM_DEEPGRAM absent, or another business listed: exactly round 4", async () => {
    for (const env of [{ ...ON, LIVE_UMM_DEEPGRAM: "" }, { ...ON, LIVE_UMM_DEEPGRAM: "biz-other" }]) {
      clearStats();
      const s = await boot({ env, callSid: `CA_udg_off_${env.LIVE_UMM_DEEPGRAM || "none"}` });
      await s.asked();
      await s.sound(600, 300);
      s.dg.say("Ahm.");
      s.enqueue.mockClear();
      await s.audio(1500);
      expect(s.enqueue).toHaveBeenCalled();
      expect(c().live_umm_hold_started ?? 0).toBe(0);
    }
  });

  it("skip reasons are counted: not after a question", async () => {
    const s = await boot({ callSid: "CA_udg_skip" });
    await s.asked("Lovely, that's noted.");
    await s.sound(600, 300);
    await s.audio(1500);
    expect(c().live_umm_skip_not_question).toBe(1);
  });
});
