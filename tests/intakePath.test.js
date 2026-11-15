// ---------------------------------------------------------------------------
// Caller-experience Task 3: the per-caller-type path note, and the
// set_call_intent reply that carries it (Live + inbound only).
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { intakePathNote } from "../lib/voice/intakePath.js";
import { executeToolCall } from "../services/tools.js";

const std = (messagesCfg = {}, extra = {}) => ({ capabilities: { messages: messagesCfg }, ...extra });
const note = (callerType, over = {}) =>
  intakePathNote({ callerType, config: std(), callerNumberReal: true, outbound: false, ...over });

describe("intakePathNote", () => {
  it("every note starts [not caller speech] and carries no quoted question", () => {
    for (const t of ["personal", "new_enquiry", "existing_customer", "supplier", "sales_pitch", "other"]) {
      for (const cfg of [std(), std({ confirmStyle: "each", spellUpFront: "everyone" }), std({ spellUpFront: "leads" })]) {
        const n = intakePathNote({ callerType: t, config: cfg, callerNumberReal: false, outbound: false });
        expect(n, t).toMatch(/^\[not caller speech\] /);
        expect(/"[^"]+\?"/.test(n), n).toBe(false);
      }
    }
  });

  it("personal: first name and message only, no number question with a real caller ID, plain confirmation", () => {
    const n = note("personal");
    expect(n).toContain("first name and their message");
    expect(n).toContain("Do not ask for a number");
    expect(n).toContain("no read-back");
    expect(n).toContain("Do not ask them to spell");
  });

  it("personal with no real caller ID asks for the number once", () => {
    const n = note("personal", { callerNumberReal: false });
    expect(n).toContain("ask for the best number once");
    expect(n).not.toContain("Do not ask for a number");
  });

  it('personal is asked to spell only when spellUpFront is "everyone"', () => {
    expect(note("personal", { config: std({ spellUpFront: "everyone" }) })).toContain("Ask them to spell their name");
    expect(note("personal", { config: std({ spellUpFront: "leads" }) })).toContain("Do not ask them to spell");
  });

  it("new_enquiry and existing_customer: name and want, save, business questions, end read-back, spelling", () => {
    for (const t of ["new_enquiry", "existing_customer"]) {
      const n = note(t);
      expect(n).toContain("Take their name and what they want, and save");
      expect(n).toContain("this business's own questions");
      expect(n).toContain("one read-back: the surname spelled");
      expect(n).toContain("a number only if it is not the number they are calling from");
      expect(n).toContain("Do not ask them to spell; the read-back spells it");
    }
    expect(note("existing_customer")).toContain("an existing client");
    expect(note("new_enquiry")).toContain("a new enquiry");
  });

  it('leads: confirmStyle "each" confirms per answer and spells back, no closing recap', () => {
    const n = note("new_enquiry", { config: std({ confirmStyle: "each" }) });
    expect(n).toContain("Confirm each answer briefly");
    expect(n).toContain("spelling the surname back");
    expect(n).not.toContain("one read-back");
    expect(n).toContain("the confirmation spells it");
  });

  it('leads: spellUpFront "leads" and "everyone" ask for the surname before saving', () => {
    for (const s of ["leads", "everyone"]) {
      const n = note("new_enquiry", { config: std({ spellUpFront: s }) });
      expect(n).toContain("Ask them to spell their surname before you save");
    }
  });

  it("supplier and sales_pitch: the business's own rule when it has one, else the default bullet", () => {
    const own = std({ notes: "Sales calls: take a short message and a number." });
    for (const t of ["supplier", "sales_pitch"]) {
      expect(note(t, { config: own })).toContain("business's own rule");
      expect(note(t)).toContain("default for sales calls in your guardrails");
      expect(note(t)).toContain("Do not ask them to spell anything");
    }
    expect(note("sales_pitch", { config: std({ spellUpFront: "everyone" }) })).toContain("Ask them to spell their name");
  });

  it("other: does not repeat the greeting's open question, asks what it concerns before any detail question (M6)", () => {
    const n = note("other");
    expect(n).toContain("do not ask that again");
    expect(n).toContain("what it concerns in your own words, before any detail question");
    expect(n).not.toContain("one open question about how you can help");
  });

  it("M1: with a real caller ID, says they will be called back on that number and can give another", () => {
    for (const t of ["personal", "new_enquiry", "existing_customer"]) {
      const n = note(t);
      expect(n, t).toContain("they will be called back on the number they are calling from");
      expect(n, t).toContain("they can give another");
    }
  });

  describe("I3a: a business's own notes beat the note's absolute lines", () => {
    const notes = std({ notes: "Always ask a friend for a number and their surname." });
    it("personal: the first-name rule and the number rule defer to the notes", () => {
      const n = note("personal", { config: notes });
      expect(n).toContain("nothing more unless this business's notes ask for it");
      expect(n).toContain("Do not ask for a number unless this business's notes ask for one");
      expect(n).not.toContain("nothing more.");
    });
    it("every type: the number line defers when there are notes, and is absolute without", () => {
      for (const t of ["personal", "new_enquiry", "existing_customer"]) {
        expect(note(t, { config: notes }), t).toContain("unless this business's notes ask for one");
        expect(note(t), t).not.toContain("unless this business's notes");
      }
      expect(note("personal")).toContain("nothing more.");
    });
    it("blank notes are no notes", () => {
      expect(note("personal", { config: std({ notes: "   " }) })).not.toContain("unless this business's notes");
    });
    it("the added text is described, never a quoted question", () => {
      for (const t of ["personal", "new_enquiry", "other"]) {
        expect(/"[^"]+\?"/.test(note(t, { config: notes }))).toBe(false);
      }
    });
  });

  it("healthcare, outbound, null, unknown and wrong_number get no note", () => {
    expect(note("new_enquiry", { config: std({}, { complianceTier: "hipaa" }) })).toBeNull();
    expect(note("new_enquiry", { outbound: true })).toBeNull();
    expect(note(null)).toBeNull();
    expect(note(undefined)).toBeNull();
    expect(note("martian")).toBeNull();
    expect(note("wrong_number")).toBeNull();
  });
});

describe("set_call_intent reply carries the path note", () => {
  const fc = (args) => ({ id: "fc1", name: "set_call_intent", args });
  const live = (extra = {}) => ({ callerSaidThisCall: "", assistantSaidThisCall: "", config: std(), callerNumberReal: true, ...extra });

  it("inbound Live: next is the path note for the type reported on THIS call, before message", async () => {
    const out = await executeToolCall(fc({ intent: "take_message", caller_type: "new_enquiry" }), live());
    const r = out.functionResponse.response;
    expect(r.success).toBe(true);
    expect(r.next).toBe(note("new_enquiry"));
    expect(Object.keys(r)).toEqual(["success", "next"]);
  });

  it("uses the reported type, not the stale call state", async () => {
    const out = await executeToolCall(
      fc({ intent: "take_message", caller_type: "personal" }),
      live({ callerType: "new_enquiry" })
    );
    expect(out.functionResponse.response.next).toBe(note("personal"));
  });

  it("an absent or invalid caller_type gets no note (even with a type in call state)", async () => {
    for (const args of [{ intent: "take_message" }, { intent: "take_message", caller_type: "martian" }]) {
      const out = await executeToolCall(fc(args), live({ callerType: "new_enquiry" }));
      expect(out.functionResponse.response).toEqual({ success: true });
    }
  });

  it("the number rule follows ctx.callerNumberReal", async () => {
    const out = await executeToolCall(
      fc({ intent: "take_message", caller_type: "personal" }),
      live({ callerNumberReal: false })
    );
    expect(out.functionResponse.response.next).toContain("ask for the best number once");
  });

  it("outbound gets no next", async () => {
    const out = await executeToolCall(
      fc({ intent: "take_message", caller_type: "new_enquiry" }),
      live({ outboundCall: true })
    );
    expect(out.functionResponse.response.next).toBeUndefined();
  });

  it("the cascade reply (no assistantSaidThisCall) is unchanged", async () => {
    const out = await executeToolCall(fc({ intent: "take_message", caller_type: "new_enquiry" }), { config: std() });
    expect(out.functionResponse.response).toEqual({ success: true });
  });

  it("healthcare gets no next", async () => {
    const out = await executeToolCall(
      fc({ intent: "take_message", caller_type: "new_enquiry" }),
      live({ config: std({}, { complianceTier: "hipaa" }) })
    );
    expect(out.functionResponse.response).toEqual({ success: true });
  });
});
