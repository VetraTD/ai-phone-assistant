// ---------------------------------------------------------------------------
// LVX192, Task 3. THE SAVE GUARD, WIRED INTO THE LIVE ENGINE.
//
// services/tools.js refuses end_call once while the caller has said more since
// the last save (tests/endCallSaveGuard.test.js proves that half with a stubbed
// ctx). It does nothing until the Live tool context carries four fields, and a
// stubbed ctx cannot see whether they arrive. This file runs the REAL engine
// and the REAL gate (bootLive: no execute override), so a field produced and not
// copied reads as a guard that never fires.
//
// Scripted callers desync (memory): every script here is short and each test
// asserts the number it cares about rather than "it did not throw".
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const CONFIG = {
  businessName: "Brightwork",
  greeting: "Thanks for calling Brightwork.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};

const MESSAGE = {
  request_type: "message",
  caller_name: "Jon",
  callback_number: "214 555 0123",
  message: "about the invoice",
};
const SUMMARY = "So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice, passing that on now.";
const ASK = "Is there anything else I can help you with today?";
const ANSWER = "There will be three of us and two suitcases.";

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

const ok = (responses) => responses[0]?.response?.success === true;

/** A call whose first turn ended in a successful save. Turn 1 is covered. */
async function savedCall(callSid, config = CONFIG) {
  const s = await bootLive({ config, callSid });
  await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
  await s.assistantSays(SUMMARY);
  const res = await s.callTool("record_customer_request", MESSAGE);
  expect(ok(res)).toBe(true);
  await s.turnEnds();
  return s;
}

/** The caller answers something new and the model signs off in the same turn. */
async function answerThenSignOff(s, answer = ANSWER) {
  await s.callerSays(answer);
  await s.assistantSays(`Lovely, thank you. ${ASK}`);
}

async function summaryOf(run) {
  const chunks = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string" && chunk.includes('"event":"live_call_summary"')) chunks.push(chunk);
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const lines = chunks.flatMap((c) => c.split("\n")).filter((l) => l.includes('"event":"live_call_summary"'));
  return lines.map((l) => JSON.parse(l))[0];
}

describe("(a) the answer and its save in one turn", () => {
  it("end_call passes", async () => {
    const s = await savedCall("CA_sg_a");
    await answerThenSignOff(s);
    expect(ok(await s.callTool("record_customer_request", { ...MESSAGE, message: "about the invoice, 3 people, 2 bags" }))).toBe(true);
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
    expect(counters().end_call_save_guard_ran).toBeGreaterThan(0);
  });
});

describe("(b) a later answer is refused, then re-saved", () => {
  it("refuses once with the unsaved kind, and passes after the re-save", async () => {
    const s = await savedCall("CA_sg_b");
    await answerThenSignOff(s);
    const [refused] = await s.callTool("end_call", {});
    expect(refused.response.success).toBe(false);
    expect(refused.response.message).toMatch(/record_customer_request/);
    expect(counters().end_call_refused_unsaved).toBe(1);

    expect(ok(await s.callTool("record_customer_request", { ...MESSAGE, message: "about the invoice, 3 people, 2 bags" }))).toBe(true);
    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });
});

describe("(c) the latch: one refusal per save stamp", () => {
  it("the next end_call passes when nothing was saved in between", async () => {
    const s = await savedCall("CA_sg_c");
    await answerThenSignOff(s);
    const [first] = await s.callTool("end_call", {});
    expect(first.response.success).toBe(false);
    const second = await s.callTool("end_call", {});
    expect(ok(second)).toBe(true);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });
});

describe("(d) review focus", () => {
  it("1: 'No that's all, thanks, bye' after a save is not refused", async () => {
    const s = await savedCall("CA_sg_d1");
    await s.callerSays("No that's all, thanks, bye");
    await s.assistantSays("Thanks for calling, goodbye.");
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
    expect(counters().end_call_save_guard_ran).toBeGreaterThan(0);
  });

  it("2: 45 turns later the count is still right (indices, not array positions)", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sg_d2" });
    for (let i = 0; i < 45; i += 1) {
      await s.callerSays(`detail number ${i} about the job site`);
      await s.assistantTurn(`Noted item ${i}, what else?`);
    }
    // The save comes in turn 46 and covers it.
    await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
    await s.assistantSays(SUMMARY);
    expect(ok(await s.callTool("record_customer_request", MESSAGE))).toBe(true);
    await s.turnEnds();

    // Only a closer after the save: nothing unsaved, so the hang-up passes.
    await s.callerSays("No that's all, thanks, bye");
    await s.assistantSays("Goodbye.");
    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
  });

  it("2b: after more than 40 informative turns and a save, a fresh answer is still counted", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sg_d2b" });
    for (let i = 0; i < 45; i += 1) {
      await s.callerSays(`detail number ${i} about the job site`);
      await s.assistantTurn(`Noted item ${i}, what else?`);
    }
    await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
    await s.assistantSays(SUMMARY);
    expect(ok(await s.callTool("record_customer_request", MESSAGE))).toBe(true);
    await s.turnEnds();
    expect(s.ws.liveSaveGuard().turnLog).toHaveLength(40);
    await answerThenSignOff(s);
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("3: a save and end_call in ONE batch is not refused", async () => {
    const s = await savedCall("CA_sg_d3");
    await answerThenSignOff(s);
    const responses = await s.callToolBatch([
      ["record_customer_request", { ...MESSAGE, message: "about the invoice, 3 people, 2 bags" }],
      ["end_call", {}],
    ]);
    const end = responses.find((r) => r.name === "end_call");
    expect(end.response.success).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
  });
});

describe("(e) the per-call summary", () => {
  it("carries end_call_refusals.unsaved", async () => {
    const summary = await summaryOf(async () => {
      const s = await savedCall("CA_sg_e");
      await answerThenSignOff(s);
      await s.callTool("end_call", {});
      await s.hangUp();
    });
    expect(summary.end_call_refusals.unsaved).toBe(1);
  });
});

describe("(f) the refusal turn does not arm the sign-off exit", () => {
  it("the farewell spoken because of the refusal leaves the line open", async () => {
    const s = await savedCall("CA_sg_f");
    await s.callerSays(ANSWER);
    await s.assistantSays("Lovely, thank you. Goodbye, have a great day.");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    await s.turnEnds();
    expect(counters().live_goodbye_suppressed_by_refusal).toBe(1);
    expect(counters().live_exit_arm_checked).toBe(0);
    expect(s.ws.readyState).toBe(1);
  });
});

describe("(g) a voiced turn the model could not transcribe", () => {
  it("counts as unsaved", async () => {
    const s = await savedCall("CA_sg_g");
    await s.feed(600, { voiced: true });
    await s.feed(1500, { voiced: false });
    await s.assistantTurn("Sorry, could you say that again?");
    await s.callerSays("No that's all, thanks, bye");
    await s.assistantSays("Goodbye.");
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("control: the same call with no voiced audio passes", async () => {
    const s = await savedCall("CA_sg_g0");
    await s.feed(2100, { voiced: false });
    await s.assistantTurn("Is there anything else?");
    await s.callerSays("No that's all, thanks, bye");
    await s.assistantSays("Goodbye.");
    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
  });
});

describe("(h) a call whose only save is a quote request", () => {
  it("is never refused as unsaved", async () => {
    const config = { ...CONFIG, capabilities: { quotes: { enabled: true } } };
    const s = await bootLive({ config, callSid: "CA_sg_h" });
    await s.callerSays("I want a quote for a website, I'm Jon on 214 555 0123.");
    await s.assistantSays("Passing that on now.");
    const quote = await s.callTool("record_quote_request", {
      service_description: "a website",
      caller_name: "Jon",
      callback_number: "214 555 0123",
    });
    expect(ok(quote)).toBe(true);
    await s.turnEnds();
    await answerThenSignOff(s);
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);
  });
});

describe("(j) saveGuardPending", () => {
  it("is true after an unsaved refusal and false after the next successful save", async () => {
    const s = await savedCall("CA_sg_j");
    expect(s.ws.liveTurnState().saveGuardPending).toBe(false);
    await answerThenSignOff(s);
    await s.callTool("end_call", {});
    // Read through the one door Task 5 will use: the tool context. A probe tool
    // is not available, so the engine's exposed turn state is the wire.
    expect(s.ws.liveTurnState?.().saveGuardPending).toBe(true);
    expect(ok(await s.callTool("record_customer_request", { ...MESSAGE, message: "about the invoice, 3 people" }))).toBe(true);
    expect(s.ws.liveTurnState?.().saveGuardPending).toBe(false);
  });
});

describe("(k) what the after-save note will read (Task 4)", () => {
  it("turnLog, savedThroughTurn, lastSaveArgs and the in-flight turn have the agreed shape", async () => {
    const s = await savedCall("CA_sg_k");
    await s.callerSays(ANSWER);
    const seam = s.ws.liveSaveGuard();
    expect(seam.turnLog).toHaveLength(1);
    expect(seam.turnLog[0]).toEqual({
      index: 1,
      caller: expect.any(String),
      prevReply: "",
      voiced: false,
    });
    expect(seam.savedThroughTurn).toBe(1);
    expect(seam.lastSaveArgs).toEqual({
      request_type: "message",
      caller_name: "Jon",
      callback_number: "214 555 0123",
      message: "about the invoice",
      caller_type: undefined,
    });
    // The in-flight turn answers the reply the previous turn ended on.
    expect(seam.inFlight).toEqual({ caller: ANSWER, prevReply: SUMMARY, voiced: false });
  });

  it("turnState carries numbers and booleans only", async () => {
    const s = await savedCall("CA_sg_k2");
    await s.callerSays(ANSWER);
    const st = s.ws.liveTurnState();
    expect(st.unsavedCallerTurns).toBe(1);
    expect(st.messagesSaved).toBe(1);
    expect(st.promisedWithoutSave).toBe(false);
    expect(st.saveGuardSpent).toBe(false);
    expect(st.saveGuardPending).toBe(false);
  });
});

describe("fix round 1", () => {
  it("I1a: a save, then a new caller turn that opens with no turnComplete, then an answer: refused", async () => {
    const s = await savedCall("CA_sg_i1a");
    await s.feed(600, { voiced: true });
    await s.feed(1500, { voiced: false });
    await s.callerSays("Two bags then.");
    expect(ok(await s.callTool("record_customer_request", { ...MESSAGE, message: "about the invoice, 2 bags" }))).toBe(true);
    // No turnComplete: the caller starts a new turn and the old one is flushed.
    await s.feed(600, { voiced: true });
    await s.callerSays(ANSWER);
    await s.assistantSays(`Lovely. ${ASK}`);
    expect(s.ws.liveSaveGuard().turnLog.map((t) => t.index)).toEqual([1, 2]);
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("I1b: an interrupt between the save call and its result: the barge-in words are not covered", async () => {
    const s = await savedCall("CA_sg_i1b");
    await s.callerSays("Two bags then.");
    s.live.push({
      toolCall: {
        functionCalls: [
          { id: "fcI", name: "record_customer_request", args: { ...MESSAGE, message: "about the invoice, 2 bags" } },
        ],
      },
    });
    s.live.push({ serverContent: { interrupted: true } });
    s.live.push({ serverContent: { inputTranscription: { text: ANSWER } } });
    await s.settle();
    await s.settle();
    await s.assistantSays(`Lovely. ${ASK}`);
    expect(s.ws.liveSaveGuard().savedThroughTurn).toBe(2);
    const [res] = await s.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("I2: one loud frame is not an answer; 600 ms of speech is", async () => {
    const quiet = await savedCall("CA_sg_i2a");
    await quiet.feed(20, { voiced: true });
    await quiet.feed(1500, { voiced: false });
    await quiet.assistantTurn("Is there anything else?");
    await quiet.callerSays("No that's all, thanks, bye");
    await quiet.assistantSays("Goodbye.");
    expect(ok(await quiet.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);

    const loud = await savedCall("CA_sg_i2b");
    await loud.feed(600, { voiced: true });
    await loud.feed(1500, { voiced: false });
    await loud.assistantTurn("Sorry, could you say that again?");
    await loud.callerSays("No that's all, thanks, bye");
    await loud.assistantSays("Goodbye.");
    const [res] = await loud.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    // The refusal rested on sound with no words: counted so live calls show how often.
    expect(counters().end_call_refused_unsaved_voiced_only).toBe(1);
  });

  it("M1: a batch [unsaved refusal, no_ask refusal] still spends the latch", async () => {
    const s = await savedCall("CA_sg_m1");
    await s.callerSays(ANSWER);
    // No ask in this turn, so the second end_call is refused as no_ask.
    await s.assistantSays("Lovely, thank you.");
    const responses = await s.callToolBatch([["end_call", {}], ["end_call", {}]]);
    expect(responses.every((r) => r.response.success === false)).toBe(true);
    expect(counters().end_call_refused_unsaved).toBe(1);
    expect(s.ws.liveTurnState().saveGuardSpent).toBe(true);
    await s.assistantSays(ASK);
    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("M1b: the summary records the unsaved refusal that the batch's last kind hid", async () => {
    const summary = await summaryOf(async () => {
      const s = await savedCall("CA_sg_m1b");
      await s.callerSays(ANSWER);
      await s.assistantSays("Lovely, thank you.");
      await s.callToolBatch([["end_call", {}], ["end_call", {}]]);
      await s.hangUp();
    });
    expect(summary.end_call_refusals.unsaved).toBe(1);
    expect(summary.end_call_refusals.no_ask).toBe(1);
  });

  it("R2-1: a yes to 'Two passengers, right?' is a confirmation; a yes to an offer is an answer", async () => {
    const check = await savedCall("CA_sg_r21a");
    await check.assistantTurn("Two passengers, right?");
    await check.callerSays("yes");
    await check.assistantSays(`Lovely. ${ASK}`);
    expect(ok(await check.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_unsaved ?? 0).toBe(0);

    const offer = await savedCall("CA_sg_r21b");
    await offer.assistantTurn("Shall I put you down for the airport run?");
    await offer.callerSays("yes please");
    await offer.assistantSays(`Lovely. ${ASK}`);
    const [res] = await offer.callTool("end_call", {});
    expect(res.response.success).toBe(false);
    expect(counters().end_call_refused_unsaved).toBe(1);
  });

  it("the after-save snapshot still sees the log, the stamp and the args", async () => {
    const s = await savedCall("CA_sg_snap");
    const seam = s.ws.liveSaveGuard();
    expect(seam.turnLog.map((t) => t.index)).toEqual([1]);
    expect(seam.savedThroughTurn).toBe(1);
    expect(seam.lastSaveArgs.caller_name).toBe("Jon");
  });
});
