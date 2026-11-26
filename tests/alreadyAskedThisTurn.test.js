// Hammersleys round 5, Task 1. A question already asked in this turn is not asked
// again after a tool reply: Live continues the turn after a tool response, so a
// save reply that says "ask them now" after the model has just asked makes it ask
// twice (13 of 15 round-3/4 repeat cuts came 0.5-2.2 s after a tool). Probe 0b
// (2026-11-26): on gemini-3.8-live the "?" is already in the turn's text when the
// tool call arrives (12/12), so ctx.inTurnReplyText can see it.
import { beforeEach, describe, expect, it } from "vitest";
import messages from "../capabilities/messages.js";
import { executeToolCall } from "../services/tools.js";
import { intakePathNote } from "../lib/voice/intakePath.js";
import { replyEndsWithQuestion, ALREADY_ASKED_NOTE } from "../lib/voice/turnText.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";
import { HAMMERSLEYS_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const NUMBER = "+12145550123";
const taxiCfg = (extra = {}, cfgExtra = {}) => ({
  ...cfgExtra,
  capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each", questionsFor: "customers", ...extra } },
});
const pickup = [{ label: "Pickup", answer: "12 High Street, Lingfield" }];
function save(ctx = {}, args = {}, config = taxiCfg()) {
  const fc = {
    id: "f",
    name: "record_customer_request",
    args: { request_type: "message", caller_name: "Jon Doe", callback_number: "2145550123", message: "Taxi booking request", details: pickup, ...args },
  };
  return messages.execute(fc, { config, callerPhone: NUMBER, ...ctx });
}
const next = (r) => r.functionResponse.response.next;
const LIVE = { assistantSaidThisCall: "Hello, Hammersleys Taxis. How can I help?" };
const ASKED = "Got it, 12 High Street, Lingfield. Which terminal at Gatwick do you need?";
const STATED = "Got it, 12 High Street, Lingfield.";
// Today's reply for this save (snapshot taken from the code before Task 1, 2026-11-26).
const TODAY =
  "[not caller speech] First confirm the answer you just saved, the way this business's notes say (read an address back, ask for any part left out). Then: This business's questions with no saved answer yet: 2. Destination, 3. When, 4. Passengers, 5. Luggage, 6. Payment. If they apply to this caller (new and returning customers, other callers only when the notes say so), ask them now in that order, one at a time; if the caller already gave one, save it under the label shown instead of asking again; skip any they would rather not answer. If they say they are short of time, offer to leave the rest for the callback. Then save again with the same message and all the answers in details.";
const counters = () => getLatencyStats()?.turnTaking ?? {};

beforeEach(() => clearStats());

describe("replyEndsWithQuestion", () => {
  it("true when the trimmed text ends with ?, optionally followed by quotes, brackets or space", () => {
    expect(replyEndsWithQuestion(ASKED)).toBe(true);
    expect(replyEndsWithQuestion('Which terminal do you need?" ')).toBe(true);
    expect(replyEndsWithQuestion("Which terminal do you need?) ")).toBe(true);
  });
  it("false for a statement, a question mid-text, empty and non-strings", () => {
    expect(replyEndsWithQuestion(STATED)).toBe(false);
    expect(replyEndsWithQuestion("Is that right? Lovely, saved.")).toBe(false);
    expect(replyEndsWithQuestion("")).toBe(false);
    expect(replyEndsWithQuestion(undefined)).toBe(false);
    expect(replyEndsWithQuestion(42)).toBe(false);
  });
});

describe("record_customer_request reply when the question was already asked this turn", () => {
  it("Live, the turn so far ends with a question: 'already asked, wait', no 'ask them now'", async () => {
    const r = await save({ ...LIVE, inTurnReplyText: ASKED });
    expect(next(r)).toBe(ALREADY_ASKED_NOTE);
    expect(next(r)).not.toMatch(/ask them now/);
    expect(counters().tool_reply_already_asked_save).toBe(1);
  });
  it("Live, the turn so far is a statement: today's reply byte for byte", async () => {
    const r = await save({ ...LIVE, inTurnReplyText: STATED });
    expect(next(r)).toBe(TODAY);
    expect(counters().tool_reply_already_asked_save).toBe(0);
  });
  it("cascade (no assistantSaidThisCall): today's reply even if the text ends with ?", async () => {
    expect(next(await save({ inTurnReplyText: ASKED }))).toBe(TODAY);
    expect(next(await save({}))).toBe(TODAY);
  });
  it("kept as today when a spelled read-back is owed", async () => {
    const r = await save({ ...LIVE, inTurnReplyText: ASKED, callerSpelled: true });
    expect(next(r)).not.toBe(ALREADY_ASKED_NOTE);
    expect(next(r)).toMatch(/ask them now/);
  });
  it("kept as today when the number is missing", async () => {
    const r = await save({ ...LIVE, inTurnReplyText: ASKED, callerPhone: "anonymous" }, { callback_number: "" });
    expect(next(r)).toContain("there is no number to call them back on");
    expect(next(r)).not.toContain(ALREADY_ASKED_NOTE);
  });
  it("kept as today on a skip-reason save (URGENT)", async () => {
    const r = await save(
      { ...LIVE, inTurnReplyText: ASKED },
      { message: "URGENT taxi now", details: [{ label: "Where", answer: "x" }] },
      taxiCfg({ questionsSkipReasonPrefixes: ["URGENT"] })
    );
    expect(next(r)).toMatch(/handles this caller's reason without its numbered questions/);
  });
  it("kept as today on the save the end_call guard forced", async () => {
    const r = await save({ ...LIVE, inTurnReplyText: ASKED, saveGuardPending: true });
    expect(next(r)).not.toBe(ALREADY_ASKED_NOTE);
    expect(r.stateEffects.quietSave).toBe(true);
  });
  it("healthcare tier: unchanged (the tier's notes stay byte for byte)", async () => {
    const hc = taxiCfg({}, { complianceTier: "hipaa" });
    const asked = await save({ ...LIVE, inTurnReplyText: ASKED }, {}, hc);
    const stated = await save({ ...LIVE, inTurnReplyText: STATED }, {}, hc);
    expect(next(asked)).toBe(next(stated));
  });
});

describe("set_call_intent reply when the question was already asked this turn", () => {
  const fc = { id: "fc1", name: "set_call_intent", args: { intent: "take_message", caller_type: "new_enquiry" } };
  const ctx = (inTurnReplyText) => ({
    callerSaidThisCall: "",
    assistantSaidThisCall: "",
    config: taxiCfg(),
    callerNumberReal: true,
    inTurnReplyText,
  });
  const path = () => intakePathNote({ callerType: "new_enquiry", config: taxiCfg(), callerNumberReal: true, outbound: false });

  it("ends with a question: the intake path is not sent; the reply says it was already asked", async () => {
    const out = await executeToolCall(fc, ctx("Sure. Can I take your name, please?"));
    const r = out.functionResponse.response;
    expect(r.next).toBe(ALREADY_ASKED_NOTE);
    expect(r.next).not.toBe(path());
    expect(counters().tool_reply_already_asked_intent).toBe(1);
  });
  it("a statement: today's path note", async () => {
    const out = await executeToolCall(fc, ctx("Sure, I can help with that."));
    expect(out.functionResponse.response.next).toBe(path());
    expect(counters().tool_reply_already_asked_intent).toBe(0);
  });
});
