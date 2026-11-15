/**
 * S4-F3: a spelled name or email is read back, letter by letter, from what was
 * saved.
 *
 * The prompt already says "whenever the caller has spelled a name, say it back
 * one letter at a time", and on the 2026-11 test calls it held about half the
 * time. Call 15: the caller spelled R-A-M-A-N, the save wrote "Roman", nothing
 * was read back, and the wrong surname reached the owner. On Gemini Live a
 * tool's reply is obeyed at once, so the instruction rides in the save's own
 * model-only `next`, FIRST, and the letters in it are composed from the saved
 * args -- the caller hears what the business will get, not what the model
 * remembers.
 *
 * The unit half: the messages pack's execute with the ctx shape the Live runner
 * builds (lib/voice/live/tools.js). The wire half, both ends real, is
 * tests/liveSpelledReadBack.test.js.
 */
import { describe, it, expect } from "vitest";
import messages from "../capabilities/messages.js";

const fc = (args) => ({ id: "f1", name: "record_customer_request", args });
const BASE = {
  request_type: "message",
  caller_name: "Priya Raman",
  callback_number: "2145550123",
  message: "about the invoice",
};
const EMAIL_ARGS = { ...BASE, details: [{ label: "Email", answer: "priya.raman23@gmail.com" }] };

// The Live runner's ctx: inbound, a real caller number, the wire present.
const LIVE = {
  callerPhone: "+18175551234",
  config: {},
  outboundCall: null,
  callerSpelled: true,
  assistantSaidThisCall: "",
  inTurnReplyText: "",
};

const HIPAA = { complianceTier: "hipaa" };

const run = (args, ctx = {}) => messages.execute(fc(args), { ...LIVE, ...ctx });
const replyOf = (r) => r.functionResponse.response;

const READ_BACK = /^\[not caller speech\] Before anything else, read back to the caller exactly what was saved, one letter at a time/;
const NAME_LETTERS = "Priya, P-R-I-Y-A, Raman, R-A-M-A-N";
const EMAIL_LETTERS = "P-R-I-Y-A dot R-A-M-A-N-2-3 at gmail dot com";

describe("record_customer_request: the spelled read-back note", () => {
  it("a spelled name nobody has read back: next starts with the note, every name spelled", async () => {
    const r = await run(BASE);
    const res = replyOf(r);
    expect(res.success).toBe(true);
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain(NAME_LETTERS);
    expect(res.next).toMatch(/ask whether that is right/i);
    expect(res.next).toMatch(/save again with the fix/i);
    // Model-only: never in the text that may be spoken.
    expect(res.message).toBe("I'll make sure they get your message.");
    expect(JSON.stringify(r.stateEffects)).not.toContain("not caller speech");
    expect(r.stateEffects.capabilityEffects).toHaveLength(1);
  });

  it("the reply leads with next: it comes before message", async () => {
    const keys = Object.keys(replyOf(await run(BASE)));
    expect(keys.indexOf("next")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("next")).toBeLessThan(keys.indexOf("message"));
  });

  describe("no double read-back: letters already spoken stay quiet", () => {
    const FORMS = [
      "Priya, Raman, R-A-M-A-N, on 2 1 4, 5 5 5, 0 1 2 3 -- passing that on now.",
      "That's Raman, R A M A N.",
      "Raman -- R. A. M. A. N. -- got it.",
      "So that's R, A, M, A, N.",
      "Thanks, P-R-I-Y-A, R-A-M-A-N.",
      "Priya, P-R-I-Y-A, Raman, R-A-M-A-N, is that right?",
      "so that's r-a-m-a-n",
    ];

    it("in an earlier turn (assistantSaidThisCall)", async () => {
      for (const said of FORMS) {
        const res = replyOf(await run(BASE, { assistantSaidThisCall: `Hello, how can I help? ${said}` }));
        expect(res.next, said).toBeUndefined();
      }
    });

    it("in this turn, before the tool call (inTurnReplyText -- call 14's shape)", async () => {
      for (const said of FORMS) {
        const res = replyOf(await run(BASE, { inTurnReplyText: said }));
        expect(res.next, said).toBeUndefined();
      }
    });

    it("other letters do not count: a longer spelled name holding the same letters, or one letter off", async () => {
      for (const said of ["That's J-O-A-N-N-E.", "So that's R-A-M-A-N-I.", "So that's R-O-M-A-N."]) {
        const res = replyOf(await run({ ...BASE, caller_name: said.includes("J-O") ? "Ann" : "Priya Raman" }, { assistantSaidThisCall: said }));
        expect(res.next, said).toMatch(READ_BACK);
      }
    });
  });

  it("a corrected save with new letters fires again; the same letters, already read back, stay quiet", async () => {
    // "Roman" was read back as R-O-M-A-N; the caller said no, it's Raman.
    const earlier = "Priya, P-R-I-Y-A, Roman, R-O-M-A-N, is that right?";
    const corrected = replyOf(await run(BASE, { assistantSaidThisCall: earlier }));
    expect(corrected.next).toMatch(READ_BACK);
    expect(corrected.next).toContain("R-A-M-A-N");
    expect(corrected.next).not.toContain("R-O-M-A-N");

    // The note was obeyed; a re-save with the same letters says nothing more.
    const again = replyOf(await run(BASE, { assistantSaidThisCall: `${earlier} Priya, P-R-I-Y-A, Raman, R-A-M-A-N, is that right?` }));
    expect(again.next).toBeUndefined();
  });

  it("the caller did not spell their name and gave no email, on a personal call: no note", async () => {
    // (A lead gets the end read-back even unspelled; see the caller-type block below.)
    const res = replyOf(await run(BASE, { callerSpelled: false, callerType: "personal" }));
    expect(res.next).toBeUndefined();
  });

  it("an email needs no spelling signal: the note reads the email only", async () => {
    // Healthcare tier: the rule as it always was, whatever the settings say.
    const res = replyOf(await run(EMAIL_ARGS, { callerSpelled: false, config: HIPAA }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain(EMAIL_LETTERS);
    expect(res.next).not.toContain("P-R-I-Y-A, Raman");
  });

  it("a spelled name and an email: both are read back, name first", async () => {
    const res = replyOf(await run(EMAIL_ARGS));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next.indexOf(NAME_LETTERS)).toBeGreaterThan(0);
    expect(res.next.indexOf(EMAIL_LETTERS)).toBeGreaterThan(res.next.indexOf(NAME_LETTERS));
  });

  it("an email answer said in words is still read back from what was saved", async () => {
    const args = { ...BASE, details: [{ label: "Email", answer: "priya dot raman23 at gmail dot com" }] };
    const res = replyOf(await run(args, { callerSpelled: false, config: HIPAA }));
    expect(res.next).toContain(EMAIL_LETTERS);
  });

  it("an answer that is not an email is not read back", async () => {
    const args = { ...BASE, details: [{ label: "Company", answer: "Raman Design" }, { label: "Website", answer: "they found us at www.example.com" }] };
    const res = replyOf(await run(args, { callerSpelled: false, config: HIPAA }));
    expect(res.next).toBeUndefined();
  });

  describe("an email already voiced is not read again", () => {
    const VOICED = [
      // the local part spelled, the domain said
      "Your email is P-R-I-Y-A dot R-A-M-A-N-2-3 at gmail dot com.",
      "That's P R I Y A, dot, R A M A N 2 3, at gmail dot com?",
      // the whole address as text
      "I have priya.raman23@gmail.com.",
      "I have priya dot raman23 at gmail dot com.",
    ];
    for (const said of VOICED) {
      it(said, async () => {
        const quiet = replyOf(await run(EMAIL_ARGS, { callerSpelled: false, assistantSaidThisCall: said, config: HIPAA }));
        expect(quiet.next).toBeUndefined();
        // The name is still owed when it was spelled and never read back.
        const nameOnly = replyOf(await run(EMAIL_ARGS, { inTurnReplyText: said }));
        expect(nameOnly.next).toContain(NAME_LETTERS);
        expect(nameOnly.next).not.toContain(EMAIL_LETTERS);
      });
    }

    it("the local part spelled with a different domain is not the saved email", async () => {
      const res = replyOf(await run(EMAIL_ARGS, { callerSpelled: false, assistantSaidThisCall: "P-R-I-Y-A dot R-A-M-A-N-2-3 at hotmail dot com." }));
      expect(res.next).toContain(EMAIL_LETTERS);
    });
  });

  describe("inert where it does not belong", () => {
    it("an outbound call: no note", async () => {
      const res = replyOf(await run(EMAIL_ARGS, { outboundCall: { campaignId: "c1" } }));
      expect(res.next).toBeUndefined();
    });

    it("no assistantSaidThisCall (off the Live front-end): no note", async () => {
      const ctx = { ...LIVE };
      delete ctx.assistantSaidThisCall;
      const res = replyOf(await messages.execute(fc(EMAIL_ARGS), ctx));
      expect(res.next).toBeUndefined();
      const nullWire = replyOf(await run(EMAIL_ARGS, { assistantSaidThisCall: null }));
      expect(nullWire.next).toBeUndefined();
    });
  });

  it("a withheld caller: both notes, the read-back first, and the message is saved", async () => {
    const r = await run({ ...BASE, callback_number: undefined }, { callerPhone: "+266696687" });
    const res = replyOf(r);
    expect(res.success).toBe(true);
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toMatch(/did not come through/);
    expect(res.next.indexOf("did not come through")).toBeGreaterThan(res.next.indexOf(NAME_LETTERS));
    expect(r.stateEffects.capabilityEffects).toEqual([{ capability: "messages", type: "recorded", data: { ...BASE, callback_number: undefined } }]);
  });

  it("with business notes too: read-back, then the number, then the extra questions", async () => {
    const r = await run(
      { ...BASE, callback_number: undefined },
      { callerPhone: "", config: { capabilities: { messages: { notes: "Ask which department." } } } }
    );
    const next = replyOf(r).next;
    const a = next.indexOf(NAME_LETTERS);
    const b = next.indexOf("did not come through");
    const c = next.indexOf("notes list questions");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("the message is saved in every case, never refused", async () => {
    for (const ctx of [{}, { callerSpelled: false }, { outboundCall: { campaignId: "c1" } }, { assistantSaidThisCall: undefined }, { callerPhone: "" }]) {
      const r = await run(EMAIL_ARGS, ctx);
      expect(replyOf(r).success).toBe(true);
      expect(r.stateEffects.toolResult.success).toBe(true);
      expect(r.stateEffects.capabilityEffects).toHaveLength(1);
    }
  });
});

describe("the read-back note follows the caller type and the settings (standard tier)", () => {
  const unspelled = { callerSpelled: false };

  it("a new enquiry who did not spell: the note starts next and spells the saved name", async () => {
    const res = replyOf(await run(BASE, { ...unspelled, callerType: "new_enquiry" }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain(NAME_LETTERS);
  });

  it("a personal call: no note", async () => {
    expect(replyOf(await run(BASE, { ...unspelled, callerType: "personal" })).next).toBeUndefined();
    // Even one who spelled, unless the business asked everyone to spell.
    expect(replyOf(await run(BASE, { callerSpelled: true, callerType: "personal" })).next).toBeUndefined();
  });

  it("a personal caller who spelled, at a business that asks everyone: the note fires", async () => {
    const config = { capabilities: { messages: { spellUpFront: "everyone" } } };
    const res = replyOf(await run(BASE, { callerSpelled: true, callerType: "personal", config }));
    expect(res.next).toContain(NAME_LETTERS);
  });

  it("a type never reported is read as a new enquiry: the note fires", async () => {
    const res = replyOf(await run(BASE, { ...unspelled, callerType: null }));
    expect(res.next).toContain(NAME_LETTERS);
  });

  it('confirmStyle "each": no end note for an unspelled lead', async () => {
    const config = { capabilities: { messages: { confirmStyle: "each" } } };
    expect(replyOf(await run(BASE, { ...unspelled, callerType: "new_enquiry", config })).next).toBeUndefined();
  });

  it("a personal save, then the caller turns out to be a lead: the note fires on the second save", async () => {
    const first = replyOf(await run(BASE, { ...unspelled, callerType: "personal" }));
    expect(first.next).toBeUndefined();
    const second = replyOf(await run({ ...BASE, caller_type: "new_enquiry" }, { ...unspelled, callerType: "personal" }));
    expect(second.next).toContain(NAME_LETTERS);
  });

  it("an email follows the type too: a lead's is read back, a personal caller's is not", async () => {
    expect(replyOf(await run(EMAIL_ARGS, { ...unspelled, callerType: "new_enquiry" })).next).toContain(EMAIL_LETTERS);
    expect(replyOf(await run(EMAIL_ARGS, { ...unspelled, callerType: "personal" })).next).toBeUndefined();
  });

  it("the healthcare tier keeps today's rule: no name letters unless the caller spelled", async () => {
    expect(replyOf(await run(BASE, { ...unspelled, callerType: "new_enquiry", config: HIPAA })).next).toBeUndefined();
    expect(replyOf(await run(BASE, { callerSpelled: true, callerType: "personal", config: HIPAA })).next).toContain(NAME_LETTERS);
  });
});
