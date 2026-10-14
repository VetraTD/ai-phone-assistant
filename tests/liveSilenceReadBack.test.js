// ---------------------------------------------------------------------------
// Round A1, T5b — "said something the transcript lost" vs "made no sound".
//
// S1 saved a booking whose one read-back stood on the previous turn even when
// NOTHING had been heard since. The owner reversed that the same evening: a
// person who reads a booking back and hears nothing checks the caller is still
// there; they do not book it. So a read-back followed by NO voiced sound is
// HELD, and the silence ladder's first rung asks "Hello? Are you still there?".
// A caller who made a sound -- however garbled, however short, even while the
// utterance is still open -- still saves (owner 2026-10-13: "any heard voice").
//
// Both ends real (a-test-proves-a-wire-only-if-both-ends-are-real): frames go
// in through the Twilio socket, the wire is produced in lib/voice/live/index.js,
// copied by the runner, and read by services/tools.js.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { composeReadBack } from "../lib/voice/savePolicy.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: {
    mon: OPEN,
    tue: OPEN,
    wed: OPEN,
    thu: OPEN,
    fri: OPEN,
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: { appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } } },
};
const SLOT = "2026-09-18T14:00:00";
const ARGS = { client_name: "Jon Dodla", scheduled_at: SLOT, notes: "strategy call" };
const READ_BACK = composeReadBack({ toolName: "book_appointment", args: ARGS, config: CONFIG });

/** 24 kHz PCM the model "speaks"; long enough to still be playing. */
function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}
const speakAudio = (s, ms) =>
  s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });
const notes = (s) =>
  s.live.sent.clientContent.map((m) => m?.turns?.[0]?.parts?.[0]?.text || "").filter(Boolean);

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

let prior;
beforeEach(() => {
  clearStats();
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
  return () => {
    if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = prior;
  };
});

/** Up to the one read-back, which ends the model's turn. */
async function readBack(callSid) {
  const s = await bootLive({ config: CONFIG, callSid });
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  // The caller's words BEFORE the read-back must not count as an answer to it.
  await s.feed(600, { voiced: true });
  await s.callerSays("Friday at two works.");
  await s.feed(800);
  await s.assistantTurn(READ_BACK);
  return s;
}

describe("a read-back followed by no sound at all is held", () => {
  it("holds the booking, then saves it once the caller answers", async () => {
    const s = await readBack("CA_t5b_silent");
    const [held] = await s.callTool("book_appointment", ARGS);
    expect(held.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
    // Not "tell them it failed", not a second read-back.
    expect(held.response.message).not.toMatch(/did not agree/i);

    await s.feed(400, { voiced: true });
    await s.callerSays("Yes.");
    await s.feed(600);
    await s.callTool("book_appointment", ARGS);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("does not count our own audio echoing back while the read-back plays", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_t5b_echo" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at two works.");
    speakAudio(s, 5000);
    await s.assistantTurn(READ_BACK);
    const forwardedBefore = s.live.sent.audioIn.length;
    await s.feed(200, { voiced: true });
    // The half-duplex gate withheld it: the model never heard it.
    expect(s.live.sent.audioIn.length).toBe(forwardedBefore);
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

describe("any heard voice is an answer — the transcript is not the input", () => {
  it("saves on voiced audio that transcribed to nothing", async () => {
    const s = await readBack("CA_t5b_garbled");
    await s.feed(800, { voiced: true });
    await s.feed(800);
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("saves on a short 'yeah' under the 400 ms spelling threshold", async () => {
    const s = await readBack("CA_t5b_short");
    await s.feed(200, { voiced: true });
    await s.feed(800);
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
  });

  it("saves when the tool call arrives while the caller's utterance is still open", async () => {
    const s = await readBack("CA_t5b_open");
    await s.feed(300, { voiced: true });
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
  });
});

describe("the ladder, after a read-back", () => {
  it("asks 'Hello? Are you still there?' first, and the read-back still stands after it", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_t5b_ladder" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at two works.");
    speakAudio(s, 400);
    await s.assistantTurn(READ_BACK);
    const before = notes(s).length;
    await s.feed(12_000);
    const lines = notes(s).slice(before);
    expect(lines.some((t) => t.includes("Hello? Are you still there?"))).toBe(true);
    expect(lines.join(" ")).not.toMatch(/say yes/i);

    // The model speaks the ladder line; then the caller answers.
    await s.assistantTurn("Hello? Are you still there?");
    await s.feed(400, { voiced: true });
    await s.callerSays("Yes, sorry.");
    await s.feed(600);
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("a ladder line does not wipe the sound the caller made since the read-back", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_t5b_survives" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at two works.");
    speakAudio(s, 400);
    await s.assistantTurn(READ_BACK);
    await s.feed(600, { voiced: true }); // garbled, nothing transcribed
    await s.feed(12_000);
    expect(notes(s).some((t) => t.includes("Hello? Are you still there?"))).toBe(true);
    await s.assistantTurn("Hello? Are you still there?");
    const [r] = await s.callTool("book_appointment", ARGS);
    expect(r.response.success).toBe(true);
  });
});
