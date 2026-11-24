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
    expect(next(r)).toBe("[not caller speech] Every numbered question in this business's notes has a saved answer. If the notes give a further step after them, do it now.");
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

  it("no labels at all (the first save): the list starts, every question open (fix round 2)", async () => {
    const got = await save(cfg(HAMMERSLEYS_NOTES));
    expect(next(got)).toContain(
      "This business's questions with no saved answer yet: 1. Pickup, 2. Destination, 3. When, 4. Passengers, 5. Luggage, 6. Payment."
    );
    expect(got.stateEffects.questionsOpen).toBe(true);
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
  const ALL = ["Pickup", "Destination", "When", "Passengers", "Luggage", "Payment"];
  const PENDING = { saveGuardPending: true };

  it("in scope, all answered: the quiet sentence with the model-note prefix, quietSave", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details(...ALL) }, PENDING);
    expect(next(r)).toBe(`[not caller speech] ${QUIET}`);
    expect(r.stateEffects.quietSave).toBe(true);
    expect(r.stateEffects.questionsOpen).toBe(false);
  });

  it("in scope, all answered, with a number note ahead: 'Then: ' leads the quiet sentence", async () => {
    const r = await messages.execute(
      { id: "f", name: "record_customer_request", args: { request_type: "message", caller_name: "Jon", message: "m", details: details(...ALL) } },
      { config: cfg(HAMMERSLEYS_NOTES), callerPhone: "anonymous", saveGuardPending: true }
    );
    expect(next(r)).toMatch(/no number to call them back on.* Then: Saved\. If the caller already said/s);
    expect(next(r)).not.toContain("[not caller speech] Saved.");
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("in scope with questions open: the list, and the save is still quiet", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup") }, PENDING);
    expect(next(r)).toContain("questions with no saved answer yet: 2. Destination");
    expect(next(r)).not.toContain("Saved. If the caller");
    expect(r.stateEffects.questionsOpen).toBe(true);
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("out of scope (labels match nothing): today's questions note, still quiet", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Trip date", "What happened") }, PENDING);
    expect(next(r)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
    expect(next(r)).not.toContain("Saved. If the caller");
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("question-like notes, nothing answered yet: today's note, still quiet", async () => {
    const r = await save(cfg("Always ask which department."), {}, PENDING);
    expect(next(r)).toMatch(/^\[not caller speech\] If this business's notes list questions/);
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("no notes: no questions note, still quiet", async () => {
    const r = await save(cfg(undefined), {}, PENDING);
    expect(next(r)).toBeUndefined();
    expect(r.stateEffects.quietSave).toBe(true);
  });

  it("without saveGuardPending nothing is quiet", async () => {
    const r = await save(cfg(undefined), {});
    expect(r.stateEffects.quietSave).not.toBe(true);
  });

  it("list wording: label shown, and the short-of-time sentence", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup") });
    expect(next(r)).toContain("save it under the label shown instead of asking again");
    expect(next(r)).toContain("If they say they are short of time, offer to leave the rest for the callback.");
  });
});

// Fix round 2 (owner's 08:17 call, 2026-11-24): the caller opened with the pickup
// and the time, the first save carried only the name, the list never started,
// and the call closed on "anything else?" with no trip questions asked.
describe("the list starts on a label-less save, except a skip reason (fix round 2)", () => {
  const mcfg = (msg = {}, extra = {}) => ({ ...extra, capabilities: { messages: { notes: HAMMERSLEYS_NOTES, ...msg } } });
  const SKIP = { questionsSkipReasonPrefixes: ["URGENT"] };
  const TODAY = /^\[not caller speech\] If this business's notes list questions, ask them now: new enquiries by default/;

  it("a second label-less save (name corrected) still lists every question", async () => {
    const r = await save(mcfg(), {}, { capabilityState: { messages: { firstSaveDone: true, savedLabels: [] } } });
    expect(next(r)).toContain("questions with no saved answer yet: 1. Pickup,");
    expect(r.stateEffects.questionsOpen).toBe(true);
  });

  it.each(["URGENT: car now from Lingfield station", "urgent - car now", "  Urgent car to Gatwick"])(
    "a save whose reason starts with a skip prefix (%j) gets today's text",
    async (message) => {
      const r = await save(mcfg(SKIP), { message });
      expect(next(r)).toMatch(TODAY);
      expect(r.stateEffects.questionsOpen).toBeUndefined();
    }
  );

  it("a skip reason wins even when a label matches a numbered question", async () => {
    const r = await save(mcfg(SKIP), { message: "URGENT: car now", details: details("Pickup") });
    expect(next(r)).toMatch(TODAY);
    expect(r.stateEffects.questionsOpen).toBeUndefined();
  });

  it("the same reason without the setting: the list (the word lives in config, not code)", async () => {
    const r = await save(mcfg(), { message: "URGENT: car now" });
    expect(next(r)).toContain("questions with no saved answer yet: 1. Pickup,");
  });

  it("a booking at a business with skip prefixes still gets the list", async () => {
    const r = await save(mcfg(SKIP), { message: "Taxi booking request" });
    expect(next(r)).toContain("questions with no saved answer yet: 1. Pickup,");
  });
});

// Fix round 2 (owner's calls 1-2): the list said "ask them now in that order" and
// the pickup was never read back, so "RH7 642" reached the email.
describe("confirm the answer just saved before the next question (fix round 2)", () => {
  const each = (extra = {}) => ({ ...extra, capabilities: { messages: { notes: HAMMERSLEYS_NOTES, confirmStyle: "each" } } });
  const LEAD =
    "[not caller speech] First confirm the answer you just saved, the way this business's notes say (read an address back, ask for any part left out). Then: ";

  it("confirmStyle each + a labelled save: the confirm step leads the list", async () => {
    const r = await save(each(), { details: details("Pickup") });
    expect(next(r)).toBe(
      LEAD +
        "This business's questions with no saved answer yet: 2. Destination, 3. When, 4. Passengers, 5. Luggage, 6. Payment. If they apply to this caller (new enquiries by default, other callers only when the notes say so), ask them now in that order, one at a time; if the caller already gave one, save it under the label shown instead of asking again; skip any they would rather not answer. If they say they are short of time, offer to leave the rest for the callback. Then save again with the same message and all the answers in details."
    );
  });

  it("confirmStyle each + all answered: the confirm step leads the all-answered sentence", async () => {
    const r = await save(each(), { details: details("Pickup", "Destination", "When", "Passengers", "Luggage", "Payment") });
    expect(next(r)).toBe(
      LEAD + "Every numbered question in this business's notes has a saved answer. If the notes give a further step after them, do it now."
    );
  });

  it("a label-less save has nothing to confirm: no confirm step", async () => {
    const r = await save(each());
    expect(next(r)).toMatch(/^\[not caller speech\] This business's questions with no saved answer yet: 1\. Pickup/);
    expect(next(r)).not.toContain("First confirm");
  });

  it("confirmStyle end (one read-back at the end): no confirm step, today's list text", async () => {
    const r = await save(cfg(HAMMERSLEYS_NOTES), { details: details("Pickup") });
    expect(next(r)).toMatch(/^\[not caller speech\] This business's questions with no saved answer yet: 2\. Destination/);
    expect(next(r)).not.toContain("First confirm");
  });

  it("healthcare tier never gets it", async () => {
    const r = await save(each({ complianceTier: "hipaa" }), { details: details("Pickup") });
    expect(next(r)).not.toContain("First confirm");
  });
});
