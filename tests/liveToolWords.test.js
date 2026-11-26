// ---------------------------------------------------------------------------
// Hammersleys round 5, Task 1 through the REAL Live engine, and Task 1a (R45):
// the instrument that says, at every save / set_call_intent call, whether the
// turn's words already ended in a question when the call arrived.
//
// Probe 0b (2026-11-26, gemini-3.8-live): the model's words reach us BEFORE the
// tool call that rides with them (18/18 question trials), so the order here is
// the measured one: audio, then its transcript, then the toolCall. The log is
// what checks that order on real calls (an older F-D note, 2026-10-15, saw the
// opposite on two booking calls).
// ---------------------------------------------------------------------------
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { ALREADY_ASKED_NOTE } from "../lib/voice/turnText.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const CONFIG = {
  businessName: "Brightwork Cars",
  greeting: "Thanks for calling Brightwork Cars.",
  mainPhone: "+18176011171",
  timezone: "Europe/London",
  locale: "en-GB",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers" } },
};
const SAVE = {
  request_type: "message",
  caller_name: "Jon Doe",
  callback_number: "214 555 0123",
  message: "Taxi booking request",
  details: [{ label: "Pickup", answer: "12 High Street, Lingfield" }],
};
const ASKED = "Got it, 12 High Street, Lingfield. Which terminal at Gatwick do you need?";
const STATED = "Got it, 12 High Street, Lingfield.";
// 100 ms of 24 kHz 16-bit silence: the model "spoke" this turn.
const AUDIO = Buffer.alloc(4800).toString("base64");

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());
let priorSpell;
beforeEach(() => {
  clearStats();
  priorSpell = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (priorSpell === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = priorSpell;
});

/** Run `fn` and return the parsed `live_tool_words` log lines it wrote. */
async function wordsLogs(fn) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string" && chunk.includes('"event":"live_tool_words"')) lines.push(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.flatMap((c) => c.split("\n")).filter((l) => l.includes('"event":"live_tool_words"')).map((l) => JSON.parse(l));
}

async function turnWith(callSid, words, { audio = true } = {}) {
  const s = await bootLive({ config: CONFIG, callSid });
  await s.callerSays("I'm Jon Doe, from 12 High Street, Lingfield, going to Gatwick.");
  if (audio) {
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: AUDIO } }] } } });
    await s.settle();
  }
  await s.assistantSays(words);
  return s;
}

describe("Task 1 through the Live engine: the save reply after a question already asked", () => {
  it("words end with a question before the save: the reply says already asked, wait", async () => {
    const s = await turnWith("CA_tw_asked", ASKED);
    const [r] = await s.callTool("record_customer_request", SAVE);
    expect(r.response.success).toBe(true);
    expect(r.response.next).toBe(ALREADY_ASKED_NOTE);
    expect(counters().tool_reply_already_asked_save).toBe(1);
  });
  it("a statement before the save: the questions list, as today", async () => {
    const s = await turnWith("CA_tw_stated", STATED);
    const [r] = await s.callTool("record_customer_request", SAVE);
    expect(r.response.next).toMatch(/ask them now in that order/);
    expect(counters().tool_reply_already_asked_save).toBe(0);
  });
});

describe("review I9: the completion ask is not added after a question already asked", () => {
  const PLAIN = { ...CONFIG, capabilities: {} };
  const MSG = { request_type: "message", caller_name: "Jon Doe", callback_number: "214 555 0123", message: "about the invoice" };
  async function said(callSid, words) {
    const s = await bootLive({ config: PLAIN, callSid });
    await s.callerSays("It's Jon Doe about the invoice, 214 555 0123.");
    await s.assistantSays(words);
    const [r] = await s.callTool("record_customer_request", MSG);
    return r.response;
  }
  it("'...Is there anything else I can help with?' then the save: no second 'anything else' note", async () => {
    const r = await said("CA_tw_ca_q", "Thanks Jon, I'll pass that on. Is there anything else I can help with?");
    expect(r.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_skipped_already_asked).toBe(1);
  });
  it("a statement then the save: the completion ask as today", async () => {
    const r = await said("CA_tw_ca_s", "Thanks Jon, I'll pass that on.");
    expect(r.next_step).toMatch(/anything else they need/);
  });
});

describe("Task 1a: the words-at-the-call instrument", () => {
  it("logs q_at_call true, spoke true and the length, with no words", async () => {
    let s;
    const logs = await wordsLogs(async () => {
      s = await turnWith("CA_tw_log_q", ASKED);
      await s.callTool("record_customer_request", SAVE);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tool: "record_customer_request", q_at_call: true, spoke: true, chars: ASKED.length });
    expect(JSON.stringify(logs[0])).not.toMatch(/Lingfield|terminal|Gatwick/i);
    expect(counters().live_tool_words_q_at_call).toBe(1);
    expect(counters().live_tool_words_no_q_at_call ?? 0).toBe(0);
  });
  it("a statement: q_at_call false, counted apart", async () => {
    const logs = await wordsLogs(async () => {
      const s = await turnWith("CA_tw_log_s", STATED);
      await s.callTool("record_customer_request", SAVE);
    });
    expect(logs[0]).toMatchObject({ q_at_call: false, spoke: true, chars: STATED.length });
    expect(counters().live_tool_words_no_q_at_call).toBe(1);
    expect(counters().live_tool_words_q_at_call ?? 0).toBe(0);
  });
  it("no audio this turn: spoke false; set_call_intent is logged too", async () => {
    const logs = await wordsLogs(async () => {
      const s = await turnWith("CA_tw_log_i", "Sure, can I take your name?", { audio: false });
      await s.callTool("set_call_intent", { intent: "take_message", caller_type: "new_enquiry" });
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ tool: "set_call_intent", q_at_call: true, spoke: false });
  });
  it("other tools are not logged", async () => {
    const logs = await wordsLogs(async () => {
      const s = await turnWith("CA_tw_log_o", ASKED);
      await s.callTool("end_call", {});
    });
    expect(logs).toHaveLength(0);
  });
});
