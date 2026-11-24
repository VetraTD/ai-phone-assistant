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

  it("2b: 45 turns later a fresh answer is still counted", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sg_d2b" });
    await s.callerSays("It's Jon, 214 555 0123, it's about the invoice.");
    await s.assistantSays(SUMMARY);
    expect(ok(await s.callTool("record_customer_request", MESSAGE))).toBe(true);
    await s.turnEnds();
    for (let i = 0; i < 44; i += 1) {
      await s.callerSays("No thanks");
      await s.assistantTurn(`Right, item ${i}. Anything at all?`);
    }
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
    expect(s.ws.liveState?.saveGuardPending ?? false).toBe(false);
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
