// LVX192 Task 5. The save reply names the notes questions that still have no
// saved answer. Pack-level: the real messages.execute with a hand-built ctx.
import { describe, expect, it } from "vitest";
import messages from "../capabilities/messages.js";
import { HAMMERSLEYS_NOTES, DIGILE_NOTES } from "./fixtures/notesQuestionsFixtures.js";

const NUMBER = "+12145550123";
const cfg = (notes, extra = {}) => ({ ...extra, capabilities: { messages: { notes } } });
const details = (...labels) => labels.map((label) => ({ label, answer: "x" }));

function save(config, args = {}, extraCtx = {}) {
  const fc = {
    id: "f",
    name: "record_customer_request",
    args: { request_type: "message", caller_name: "Jon", callback_number: "2145550123", message: "Taxi booking request", ...args },
  };
  return messages.execute(fc, { config, callerPhone: NUMBER, ...extraCtx });
}
const next = (r) => r.functionResponse.response.next;
const saved = (r) => r.stateEffects.capabilityState.messages.savedLabels;


describe("open questions named in the save reply", () => {
  it("three labels saved in one save: lists 4, 5, 6 in order and keeps the new-enquiries clause", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup", "Destination", "When") });
    expect(next(r)).toContain("This business's questions with no saved answer yet: 4. Passengers, 5. Luggage, 6. Payment.");
    expect(next(r)).toMatch(/^\[not caller speech\]/);
    expect(next(r)).toContain("(new enquiries by default, other callers only when the notes say so)");
    expect(next(r)).toContain("Then save again with the same message and all the answers in details.");
    expect(r.stateEffects.questionsOpen).toBe(true);
    expect(saved(r)).toEqual(["Pickup", "Destination", "When"]);
    expect(r.stateEffects.capabilityState.messages.firstSaveDone).toBe(true);
  });

  it("labels persist across saves: the second save only names what is still open", async () => {
    const first = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup", "Destination", "When") });
    const second = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Passengers") }, {
      capabilityState: { messages: first.stateEffects.capabilityState.messages },
    });
    expect(next(second)).toContain("questions with no saved answer yet: 5. Luggage, 6. Payment.");
    expect(saved(second)).toEqual(["Pickup", "Destination", "When", "Passengers"]);
  });

  it("all answered: the all-answered sentence, nothing open", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), {
      details: details("Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"),
    });
    expect(next(r)).toBe("[not caller speech] Every question in this business's notes has a saved answer.");
    expect(r.stateEffects.questionsOpen).toBe(false);
  });

  it("caps the remembered labels at 20", async () => {
    const many = Array.from({ length: 19 }, (_, i) => `Extra ${i}`);
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup", "Luggage") }, {
      capabilityState: { messages: { savedLabels: many } },
    });
    expect(saved(r)).toHaveLength(20);
    expect(saved(r)).toContain("Luggage");
  });

  it("a save whose labels match no numbered question: today's text", async () => {
    for (const labels of [["Trip date", "What happened"], ["Where", "Where to"]]) {
      const got = await save(cfg(HAMMERSLEYS_NOTES), { details: details(...labels) });
      expect(next(got)).toMatch(/^\[not caller speech\] If this business's notes list questions, ask them now: new enquiries by default/);
      expect(got.stateEffects.questionsOpen).not.toBe(true);
    }
  });

  it("no labels at all (the first save): today's text", async () => {
    const got = await save(cfg(HAMMERSLEYS_NOTES));
    expect(next(got)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
  });

  it("notes without a question mark or the word ask: today's text", async () => {
    const rules = "1. Pickup is the street.\n2. Destination is the town.\n3. When is the day.";
    const got = await save(cfg(rules), { details: details("Pickup") });
    expect(next(got)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
    expect(got.stateEffects.questionsOpen).not.toBe(true);
  });

  it("notes with no numbered list: today's text", async () => {
    const got = await save(cfg("Always ask which department the message is for."), { details: details("Department") });
    expect(next(got)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
  });

  it("Digile notes: company answered, the rest listed", async () => {
    const r = await save(cfg(DIGILE_NOTES), { details: details("Company") });
    expect(next(r)).toContain("2. Their industry, 3. What they sell, 4. The main thing holding back the growth, 5. Their email address, 6. Roughly what they spend.");
  });

  it("healthcare tier: byte-identical, no list, no new state", async () => {
    const old =
      "[not caller speech] If this business's notes list more questions for this caller, ask them now, one at a time, before closing. Then save again with the same message and the answers in details.";
    const r = await save(cfg(HAMMERSLEYS_NOTES, { complianceTier: "hipaa" }), { details: details("Pickup", "Destination", "When") });
    expect(next(r)).toBe(old);
    expect(r.stateEffects.capabilityState).toEqual({ messages: { firstSaveDone: true } });
    expect(r.stateEffects.questionsOpen).toBeUndefined();
    const q = await save(cfg(HAMMERSLEYS_NOTES, { complianceTier: "hipaa" }), {}, { saveGuardPending: true });
    expect(next(q)).toBe(old);
    expect(q.stateEffects.quietSave).toBeUndefined();
  });

  it("keeps the number note and the read-back ahead of the list", async () => {
    const r = await messages.execute(
      { id: "f", name: "record_customer_request", args: { request_type: "message", caller_name: "Jon", message: "m", details: details("Pickup") } },
      { config: cfg(HAMMERSLEYS_NOTES), callerPhone: "anonymous" }
    );
    expect(next(r)).toMatch(/no number to call them back on.*questions with no saved answer yet: 2\. Destination/s);
  });
});

describe("a save the end_call guard forced is a quiet one", () => {
  const QUIET =
    "Saved. If the caller already said they need nothing else, say a short goodbye and call end_call; otherwise ask whether there is anything else.";

  it("saveGuardPending with nothing open: exactly the quiet sentence and quietSave", async () => {
    const r = await save(cfg(undefined), {}, { saveGuardPending: true });
    expect(next(r)).toBe(QUIET);
    expect(r.stateEffects.quietSave).toBe(true);
    expect(r.stateEffects.questionsOpen).not.toBe(true);
  });

  it("notes that are rules, not questions: still the quiet sentence", async () => {
    const r = await save(cfg("Be brief and polite."), {}, { saveGuardPending: true });
    expect(next(r)).toBe(QUIET);
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("question notes with nothing answered yet (scope unknown): today's text, not quiet", async () => {
    const r = await save(cfg("Always ask which department."), {}, { saveGuardPending: true });
    expect(next(r)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
    expect(r.stateEffects.quietSave).not.toBe(true);
  });

  it("all notes questions answered: the quiet sentence follows the all-answered one", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), {
      details: details("Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"),
    }, { saveGuardPending: true });
    expect(next(r)).toBe(`[not caller speech] Every question in this business's notes has a saved answer. ${QUIET}`);
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("with questions open, the list wins and the save is not quiet", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup") }, { saveGuardPending: true });
    expect(next(r)).toContain("questions with no saved answer yet: 2. Destination");
    expect(next(r)).not.toContain("Saved. If the caller");
    expect(r.stateEffects.quietSave).not.toBe(true);
    expect(r.stateEffects.questionsOpen).toBe(true);
  });

  it("without saveGuardPending nothing is quiet", async () => {
    const r = await save(cfg(undefined), {});
    expect(r.stateEffects.quietSave).not.toBe(true);
  });
});
