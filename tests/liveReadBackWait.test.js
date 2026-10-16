// ---------------------------------------------------------------------------
// Round A1 part 4, F-D (owner, 2026-10-15): WAIT FOR THE WORDS.
//
// On Gemini Live the model's tool call reaches us BEFORE the transcript of
// the words it spoke with it. On call b (CAdefce6ab) and d1b (CA046f67) the
// write-order gate judged "was it read back?" before the read-back text had
// arrived, saw none, and handed the model sentence S -- so the caller heard
// the read-back twice in one turn (F6). Measured: the text was in the turn
// <= 1.1 s (b) and <= 1.5 s (d1b) after the refused call (upper bounds).
//
// Owner: wait up to 2 s, only when the model sent audio this turn, ending the
// moment a read-back of the slot arrives; logged (live_readback_wait) so the
// real gap is measured on the next calls.
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

function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}
const speakAudio = (s, ms) =>
  s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(ms) } }] } } });

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

/** Run a call; return the live_readback_wait log events it wrote. */
async function waits(run) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") lines.push(...chunk.split("\n"));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines.filter((l) => l.includes('"event":"live_readback_wait"')).map((l) => JSON.parse(l));
}

async function upToTheBooking(s) {
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("Friday at two works.");
}

const said = (r) => String(r?.response?.message || "");

describe("F-D — the gate waits for the read-back words that follow the call", () => {
  it("words land 600 ms after the call: saved, and no second sentence handed", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_arrive" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      const early = await s.callTool("book_appointment", ARGS);
      // Held for the words: not answered yet, so nothing was handed.
      expect(early).toHaveLength(0);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(true);
    expect(said(r[0])).not.toMatch(/in exactly these words/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "book_appointment", outcome: "arrived" });
  });

  it("no model audio this turn: no wait (the gate decides at once, as before)", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_noaudio" });
      await upToTheBooking(s);
      const r = await s.callTool("book_appointment", ARGS);
      expect(r).toHaveLength(1);
      expect(r[0].response.success).toBe(false);
      expect(said(r[0])).toMatch(/in exactly these words/);
    });
    expect(events).toHaveLength(0);
  });

  it("a read-back already in the turn: no wait, saved at once", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_already" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.assistantSays(READ_BACK);
      const r = await s.callTool("book_appointment", ARGS);
      expect(r).toHaveLength(1);
      expect(r[0].response.success).toBe(true);
    });
    expect(events).toHaveLength(0);
  });

  it("no words within 2 s: the gate hands its sentence, as today", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_timeout" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      const early = await s.callTool("book_appointment", ARGS);
      expect(early).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2100);
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(false);
    expect(said(r[0])).toMatch(/in exactly these words/);
    expect(events[0]).toMatchObject({ outcome: "timeout" });
  });

  it("the turn ends while waiting: stops waiting at once", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_turnend" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.turnEnds();
      await s.settle();
    });
    expect(s.responsesFor("book_appointment")).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "turn_end" });
  });

  // Live can deliver the last transcript chunk and turnComplete in ONE
  // message. The wait ends on the words, but the gate's continuation runs a
  // microtask later -- after the turn has rolled. Judged on the rolled state,
  // the read-back looks like LAST turn's with no sound since, and the save is
  // held for an answer nobody is going to give. The state is frozen when the
  // wait ends, so the gate judges the turn the call was made on.
  it("words and turnComplete in one message: judged on the turn the call was made on, saved", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_same_msg" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      s.live.push({ serverContent: { outputTranscription: { text: READ_BACK }, turnComplete: true } });
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(true);
    expect(events[0]).toMatchObject({ outcome: "arrived" });
  });

  it("a second call during the wait runs after it, never beside it: one row", async () => {
    let s;
    await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_twice" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(2);
    expect(r.filter((x) => x.response.success === true).length).toBeGreaterThanOrEqual(1);
    expect((s.store.appointments || []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round A1 part 4, opus review (owner decisions 2026-10-16).
// ---------------------------------------------------------------------------
async function summaryOf(run) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") lines.push(...chunk.split("\n"));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const parse = (ev) => lines.filter((l) => l.includes(`"event":"${ev}"`)).map((l) => JSON.parse(l));
  return { summary: parse("live_call_summary")[0], waits: parse("live_readback_wait") };
}

describe("F-D review — the wait reads text that is still arriving", () => {
  it("I3: a bare hour that ends a chunk is not a read-back yet ('at two', then ' thirty')", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_open_end" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays("I'll book you in for Friday at two");
      await s.settle();
      expect(s.responsesFor("book_appointment")).toHaveLength(0);
      await s.assistantSays(" thirty for Jon Dodla.");
      await vi.advanceTimersByTimeAsync(2100);
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(false);
    expect(events[0]).toMatchObject({ outcome: "timeout" });
  });

  it("I3: the same bare hour, once a word follows it, is the read-back", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_open_then" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays("I'll book you in for Friday at two");
      await s.assistantSays(" for Jon Dodla.");
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(true);
    expect(events[0]).toMatchObject({ outcome: "arrived" });
  });
});

describe("F-D review — saved on the words, then the turn asked (I3: counted)", () => {
  it("a confirming question after the saved read-back is counted", async () => {
    const { summary } = await summaryOf(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wait_saved_asked" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
      expect(s.responsesFor("book_appointment")[0].response.success).toBe(true);
      await s.assistantSays(" Is that right?");
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.saved_then_asked).toBe(1);
  });

  it("the closing question is not counted", async () => {
    const { summary } = await summaryOf(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wait_saved_tic" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
      await s.assistantSays(" Is there anything else I can help you with?");
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.saved_then_asked).toBe(0);
  });
});

describe("F-D review — the wait ends on close (M5)", () => {
  it("hanging up while waiting ends it at once", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_close" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.hangUp();
      await s.settle();
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "closed" });
  });
});

describe("F-D re-review — the skip-the-wait check reads arriving text too (M3)", () => {
  it("a bare hour that ends the words said before the call does not skip the wait", async () => {
    let s;
    const events = await waits(async () => {
      s = await bootLive({ config: CONFIG, callSid: "CA_wait_skip_open" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.assistantSays("I'll book you in for Friday at two");
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(" thirty for Jon Dodla.");
      await vi.advanceTimersByTimeAsync(2100);
      await s.settle();
      await s.settle();
    });
    const r = s.responsesFor("book_appointment");
    expect(r).toHaveLength(1);
    expect(r[0].response.success).toBe(false);
    expect(events[0]).toMatchObject({ outcome: "timeout" });
  });
});

describe("F-D re-review — saved_then_asked counts any question but the closing one (M5)", () => {
  it("'Does that work for you?' after the saved read-back is counted", async () => {
    const { summary } = await summaryOf(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wait_saved_work" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
      await s.assistantSays(" Does that work for you?");
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.saved_then_asked).toBe(1);
  });

  it("after an interrupt, the next turn's question is not counted against the old read-back", async () => {
    const { summary } = await summaryOf(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_wait_saved_interrupt" });
      await upToTheBooking(s);
      speakAudio(s, 3000);
      await s.callTool("book_appointment", ARGS);
      await s.assistantSays(READ_BACK);
      await s.settle();
      await s.settle();
      s.live.push({ serverContent: { interrupted: true } });
      await s.settle();
      await s.callerSays("Sorry, one more thing.");
      await s.assistantSays("Of course. What else can I do for you today, and would you like a reminder text?");
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.saved_then_asked).toBe(0);
  });
});
