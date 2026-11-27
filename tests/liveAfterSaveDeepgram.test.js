// ---------------------------------------------------------------------------
// Hammersleys round 6, item 3 (owner R54), on the Live front-end: round-5
// call 1 said "No, that's it" (Deepgram heard it), Live's side transcript wrote
// "No hace", and the after-save note put a junk line in the email. Where the
// Deepgram shadow (already streaming for the listed tenant: EU, inbound, never
// healthcare) covered the window after the last save and heard only a plain
// closing, no line is written. A shadow that never connected, or Deepgram
// hearing a real detail, leaves today's note. Counts only; no words logged.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork Cars",
  mainPhone: "+15550104000",
  timezone: "Europe/London",
  businessHours: {},
  locale: "en-GB",
  allowedTasks: ["take_message", "general_question"],
  capabilities: {},
};
const ON = { LIVE_SHADOW_STT: "biz-1", DEEPGRAM_API_KEY: "test-key", DEEPGRAM_REGION: "eu" };
const SAVE = { request_type: "message", caller_name: "Jon Smith", callback_number: "+447700900123", message: "Taxi to Oxted station" };
const ASK = "That's passed to the dispatcher, who will confirm. Is there anything else?";

function fakeDeepgram({ fail = false } = {}) {
  const dg = { onFinal: null };
  dg.connect = async (opts) => {
    if (fail) throw new Error("bad key");
    dg.onFinal = opts.onFinal;
    dg.onInterim = opts.onInterim;
    return { sendAudio() {}, close() {}, finalize: async () => {} };
  };
  dg.say = (text) => dg.onFinal?.(text, { confidence: 0.9 });
  dg.interim = (text) => dg.onInterim?.(text, { confidence: 0.5 });
  return dg;
}

async function call({ dg = fakeDeepgram(), env = ON, callSid = "CA_asdg", heard = ["No, that's it."], interimAfter = null } = {}) {
  const s = await bootLive({ config: CONFIG, callSid, env, shadowConnect: dg.connect });
  await s.feed(0);
  await s.callerSays("I'm Jon Smith, I need a taxi to Oxted station.");
  await s.feed(300);
  const [r] = await s.callTool("record_customer_request", SAVE);
  expect(r.response.success).toBe(true);
  await s.feed(300);
  await s.assistantTurn(ASK);
  await s.callerSays("No hace");
  await s.feed(400);
  for (const t of heard) dg.say(t);
  if (interimAfter) {
    await s.feed(50);
    dg.interim(interimAfter);
  }
  await s.feed(200);
  await s.assistantTurn("Lovely, goodbye.");
  s.ws.emit("close");
  await new Promise((r) => setTimeout(r, 150));
  return s;
}
const c = () => counters();

describe("round 6: the after-save note reads Deepgram's words", () => {
  beforeEach(() => clearStats());

  it("Deepgram heard only 'No, that's it.': no line written, counted", async () => {
    await call();
    expect(c().after_save_note_dropped_dg_closing).toBe(1);
    expect(c().after_save_note_saved ?? 0).toBe(0);
  });

  it("the shadow never connected: today's note is written", async () => {
    await call({ dg: fakeDeepgram({ fail: true }), callSid: "CA_asdg_fail" });
    expect(c().after_save_note_dropped_dg_closing ?? 0).toBe(0);
    expect(c().after_save_note_saved).toBe(1);
  });

  it("Deepgram heard a detail too: today's note is written", async () => {
    await call({ callSid: "CA_asdg_detail", heard: ["No, that's it.", "Oh, and two cases."] });
    expect(c().after_save_note_dropped_dg_closing ?? 0).toBe(0);
    expect(c().after_save_note_saved).toBe(1);
  });

  it("Deepgram heard nothing after the save: today's note is written", async () => {
    await call({ callSid: "CA_asdg_none", heard: [] });
    expect(c().after_save_note_saved).toBe(1);
  });

  it("the caller spoke again after Deepgram's last final (hung up before it landed): today's note is written", async () => {
    const dg = fakeDeepgram();
    const s = await bootLive({ config: CONFIG, callSid: "CA_asdg_late", env: ON, shadowConnect: dg.connect });
    await s.feed(0);
    await s.callerSays("I'm Jon Smith, I need a taxi to Oxted station.");
    await s.feed(300);
    await s.callTool("record_customer_request", SAVE);
    await s.feed(300);
    await s.assistantTurn(ASK);
    await s.callerSays("No hace");
    await s.feed(400);
    dg.say("No, that's it.");
    await s.feed(200);
    // A new sound: "Oh, and two cases" -- Deepgram's final for it has not landed.
    await s.feed(600, { voiced: true });
    await s.callerSays(" two cases");
    await s.feed(300);
    s.ws.emit("close");
    await new Promise((r) => setTimeout(r, 150));
    expect(c().after_save_note_dropped_dg_closing ?? 0).toBe(0);
    expect(c().after_save_note_saved).toBe(1);
  });

  it("review 10: Deepgram was mid-utterance (an interim after its last final): today's note is written", async () => {
    await call({ callSid: "CA_asdg_interim", interimAfter: "and two" });
    expect(c().after_save_note_dropped_dg_closing ?? 0).toBe(0);
    expect(c().after_save_note_saved).toBe(1);
  });

  it("the shadow is off for this business: today's note is written", async () => {
    await call({ env: {}, callSid: "CA_asdg_off" });
    expect(c().after_save_note_saved).toBe(1);
  });
});
