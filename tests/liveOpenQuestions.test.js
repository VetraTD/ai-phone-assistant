// LVX192 Task 5, the Live runner half. The save reply names the open notes
// questions (capabilities/messages.js, proven in tests/messagesOpenQuestions.test.js);
// here the REAL runner (bootLive, no execute override) must act on the two flags
// that reply sets:
//   questionsOpen  the completion "ask whether there is anything else" note is
//                  NOT attached (it contradicts "ask the open questions now").
//   quietSave      the save the end_call guard forced: no completion note, and
//                  it does not count as new work, so it does not re-arm the
//                  LVX132 "anything else?" latch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const BASE = {
  businessName: "Brightwork",
  greeting: "Thanks for calling Brightwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request"],
};
const WITH_NOTES = { ...BASE, capabilities: { messages: { enabled: true, notes: HAMMERSLEYS_NOTES } } };
const NO_NOTES = { ...BASE, capabilities: {} };

const MESSAGE = {
  request_type: "message",
  caller_name: "Jon",
  callback_number: "214 555 0123",
  message: "Taxi booking request",
};
const SUMMARY = "So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 for a taxi, passing that on now.";
const ASK = "Is there anything else I can help you with today?";
const d = (...labels) => labels.map((label) => ({ label, answer: "x" }));

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

let priorSpellPolicy;
beforeEach(() => {
  clearStats();
  priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
});

async function firstSave(callSid, config, args = {}) {
  const s = await bootLive({ config, callSid });
  await s.callerSays("It's Jon, 214 555 0123, I need a taxi.");
  await s.assistantSays(SUMMARY);
  const res = await s.callTool("record_customer_request", { ...MESSAGE, ...args });
  expect(res[0].response.success).toBe(true);
  return { s, res: res[0].response };
}

describe("the completion ask note and open questions", () => {
  it("is not attached while notes questions remain open", async () => {
    const { res } = await firstSave("CA_oq_open", WITH_NOTES, { details: d("Pickup") });
    expect(res.next).toContain("questions with no saved answer yet: 2. Destination");
    expect(res.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_skipped_open_questions).toBe(1);
    expect(counters().live_completion_ask_note_sent ?? 0).toBe(0);
  });

  it("is attached when every question is answered", async () => {
    const { res } = await firstSave("CA_oq_done", WITH_NOTES, {
      details: d("Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"),
    });
    expect(res.next_step).toMatch(/anything else/i);
    expect(counters().live_completion_ask_note_sent).toBe(1);
    expect(counters().live_completion_ask_note_skipped_open_questions ?? 0).toBe(0);
  });

  it("is attached when the business has no notes", async () => {
    const { res } = await firstSave("CA_oq_none", NO_NOTES);
    expect(res.next_step).toMatch(/anything else/i);
    expect(counters().live_completion_ask_note_sent).toBe(1);
    expect(counters().live_completion_ask_note_skipped_open_questions ?? 0).toBe(0);
    expect(counters().live_completion_ask_note_skipped_quiet_save ?? 0).toBe(0);
  });
});

describe("a save the end_call guard forced", () => {
  it("is quiet: no completion note, and the ask latch is not re-armed", async () => {
    const { s } = await firstSave("CA_oq_quiet", NO_NOTES);
    await s.turnEnds();
    // The ask is spoken in an EARLIER turn than the hang-up, so it only covers
    // the work that existed then: a re-save that counted as new work would
    // make the next end_call refuse "no_ask".
    await s.assistantTurn("How many passengers?");
    await s.callerSays("Three of us");
    await s.assistantTurn(ASK);
    // Not a close ("that's all" would satisfy the ask gate on its own).
    await s.callerSays("Yes, there will be two suitcases as well.");
    const [refused] = await s.callTool("end_call", {});
    expect(refused.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
    const refusedNoAsk = counters().end_call_refused_no_ask ?? 0;

    const [resave] = await s.callTool("record_customer_request", { ...MESSAGE, message: "Taxi booking, 3 people" });
    expect(resave.response.success).toBe(true);
    expect(resave.response.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_skipped_quiet_save).toBe(1);
    expect(counters().live_completion_ask_note_sent).toBe(1);

    const [bye] = await s.callTool("end_call", {});
    expect(bye.response.success).toBe(true);
    expect(counters().end_call_refused_no_ask ?? 0).toBe(refusedNoAsk);
    expect(counters().end_call_ask_rearmed_by_action ?? 0).toBe(0);
  });

  it("is quiet even when notes questions are open: list kept, no completion note", async () => {
    const { s } = await firstSave("CA_oq_quiet_open", WITH_NOTES, { details: d("Pickup") });
    await s.turnEnds();
    await s.assistantTurn("Where to?");
    await s.callerSays("The airport");
    await s.assistantTurn("Lovely. Anything else?");
    await s.callerSays("No, bye");
    const [refused] = await s.callTool("end_call", {});
    expect(refused.response.success).toBe(false);
    const [resave] = await s.callTool("record_customer_request", { ...MESSAGE, details: d("Pickup") });
    expect(resave.response.next).toContain("questions with no saved answer yet");
    expect(resave.response.next_step).toBeUndefined();
  });
});

// Fix round 2 (owner's call 5(i), 2026-11-24): an URGENT save and request_transfer
// in one batch -- the save reply still said "ask whether there is anything else",
// and the caller heard "anything else?" while being put through.
describe("a save in the same batch as request_transfer", () => {
  const XFER = { ...BASE, transferPhoneNumber: "+18175550199", capabilities: {} };
  const URGENT = { ...MESSAGE, message: "URGENT: car now from Lingfield station" };

  it("save then transfer: no completion note on the save", async () => {
    const s = await bootLive({ config: XFER, callSid: "CA_oq_xfer_1" });
    await s.callerSays("I need a car right now, it's Jon at Lingfield station.");
    const out = await s.callToolBatch([
      ["record_customer_request", URGENT],
      ["request_transfer", { reason: "needs a car now" }],
    ]);
    const save = out.find((r) => r.name === "record_customer_request");
    expect(save.response.success).toBe(true);
    expect(save.response.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_skipped_transfer).toBe(1);
    expect(counters().live_completion_ask_note_sent ?? 0).toBe(0);
  });

  it("transfer then save: no completion note either", async () => {
    const s = await bootLive({ config: XFER, callSid: "CA_oq_xfer_2" });
    await s.callerSays("I need a car right now, it's Jon at Lingfield station.");
    const out = await s.callToolBatch([
      ["request_transfer", { reason: "needs a car now" }],
      ["record_customer_request", URGENT],
    ]);
    const save = out.find((r) => r.name === "record_customer_request");
    expect(save.response.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_skipped_transfer).toBe(1);
  });

  it("control: the same save alone still gets the completion note", async () => {
    const s = await bootLive({ config: XFER, callSid: "CA_oq_xfer_3" });
    await s.callerSays("I need a car right now, it's Jon at Lingfield station.");
    const out = await s.callToolBatch([["record_customer_request", URGENT]]);
    expect(out[0].response.next_step).toMatch(/anything else/i);
    expect(counters().live_completion_ask_note_skipped_transfer ?? 0).toBe(0);
  });
});
