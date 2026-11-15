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
const SURNAME_LETTERS = "Raman, R-A-M-A-N";
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
    // An existing client: a lead at a notes business has the read-back deferred to the
    // last answer (fix wave I8, below).
    const r = await run(
      { ...BASE, callback_number: undefined },
      { callerType: "existing_customer", callerPhone: "", config: { capabilities: { messages: { notes: "Ask which department." } } } }
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

  it("a new enquiry who did not spell: the note starts next and spells the saved surname (fix wave I7)", async () => {
    const res = replyOf(await run(BASE, { ...unspelled, callerType: "new_enquiry" }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain(SURNAME_LETTERS);
    expect(res.next).not.toContain("P-R-I-Y-A");
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
    expect(res.next).toContain(SURNAME_LETTERS);
  });

  it('confirmStyle "each": no end note for an unspelled lead', async () => {
    const config = { capabilities: { messages: { confirmStyle: "each" } } };
    expect(replyOf(await run(BASE, { ...unspelled, callerType: "new_enquiry", config })).next).toBeUndefined();
  });

  it("a personal save, then the caller turns out to be a lead: the note fires on the second save", async () => {
    const first = replyOf(await run(BASE, { ...unspelled, callerType: "personal" }));
    expect(first.next).toBeUndefined();
    const second = replyOf(await run({ ...BASE, caller_type: "new_enquiry" }, { ...unspelled, callerType: "personal" }));
    expect(second.next).toContain(SURNAME_LETTERS);
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

// ---------------------------------------------------------------------------
// Fix wave I7 / P27: what the note spells, standard tier only.
// ---------------------------------------------------------------------------
describe("what the read-back note spells (fix wave I7)", () => {
  const unspelled = { callerSpelled: false, callerType: "new_enquiry" };
  const JD = { ...BASE, caller_name: "Jonathan Daniel" };
  const onFile = { callerContext: { upcomingAppointments: [{ client_name: "Jonathan Daniel" }] } };

  it("the caller did not spell: the surname only, not every word", async () => {
    const res = replyOf(await run(JD, unspelled));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain('"Daniel, D-A-N-I-E-L"');
    expect(res.next).not.toContain("J-O-N-A-T-H-A-N");
    expect(res.next).toContain("their surname");
  });

  it("a one-word name is spelled whole", async () => {
    const res = replyOf(await run({ ...BASE, caller_name: "Mike" }, unspelled));
    expect(res.next).toContain('"Mike, M-I-K-E"');
  });

  it("the caller spelled: every word, as before", async () => {
    const res = replyOf(await run(JD, { ...unspelled, callerSpelled: true }));
    expect(res.next).toContain("Jonathan, J-O-N-A-T-H-A-N, Daniel, D-A-N-I-E-L");
  });

  it("a confirmed on-file name the caller did not spell: no name letters at all", async () => {
    expect(replyOf(await run(JD, { ...unspelled, ...onFile })).next).toBeUndefined();
    // An email is still read back; the name is not.
    const withEmail = replyOf(await run({ ...JD, details: EMAIL_ARGS.details }, { ...unspelled, ...onFile }));
    expect(withEmail.next).toContain(EMAIL_LETTERS);
    expect(withEmail.next).not.toContain("D-A-N-I-E-L");
  });

  it("an on-file name the caller DID spell is read back, as before", async () => {
    const res = replyOf(await run(JD, { ...unspelled, ...onFile, callerSpelled: true }));
    expect(res.next).toContain("Jonathan, J-O-N-A-T-H-A-N, Daniel, D-A-N-I-E-L");
  });

  it("a surname already voiced stays quiet (the confirm audit accepts a surname-only voicing)", async () => {
    const said = "So that's Jonathan Daniel, D-A-N-I-E-L, on 2 1 4, 5 5 5, 0 1 2 3 -- passing that on now.";
    expect(replyOf(await run(JD, { ...unspelled, assistantSaidThisCall: said })).next).toBeUndefined();
  });

  it("the healthcare tier is byte-identical: nothing for an unspelled name, every word for a spelled one", async () => {
    expect(replyOf(await run(JD, { ...unspelled, config: HIPAA })).next).toBeUndefined();
    const res = replyOf(await run(JD, { callerSpelled: true, callerType: "new_enquiry", config: HIPAA }));
    expect(res.next).toContain('"Jonathan, J-O-N-A-T-H-A-N, Daniel, D-A-N-I-E-L"');
    expect(res.next).toContain("their name");
    // On file and spelled: still every word on hipaa (the rule did not change there).
    const onFileSpelled = replyOf(await run(JD, { callerSpelled: true, config: HIPAA, ...onFile }));
    expect(onFileSpelled.next).toContain("Jonathan, J-O-N-A-T-H-A-N, Daniel, D-A-N-I-E-L");
  });
});

// ---------------------------------------------------------------------------
// Fix wave I8 / P28: one read-back, at the end, for a lead at a business that
// has its own questions.
// ---------------------------------------------------------------------------
describe("one read-back at the end (fix wave I8)", () => {
  const notesConfig = { capabilities: { messages: { notes: "Ask which company they are with." } } };
  const lead = { callerSpelled: false, callerType: "new_enquiry", config: notesConfig };
  const JD = { ...BASE, caller_name: "Jonathan Daniel" };
  const ANSWERS = [{ label: "Company", answer: "Acme Plumbing" }];

  it("a lead's first save at a notes business: the questions note first, no letters", async () => {
    const res = replyOf(await run(JD, lead));
    expect(res.success).toBe(true);
    expect(res.next).toMatch(/^\[not caller speech\] If this business's notes list questions, ask them now/);
    expect(res.next).not.toMatch(READ_BACK);
    expect(res.next).not.toContain("D-A-N-I-E-L");
    // The note says, in described words, that the one read-back comes after the last answer.
    expect(res.next).toMatch(/read-back[^.]*after the last answer/i);
    expect(/"[^"]+\?"/.test(res.next)).toBe(false);
  });

  it("the later save that carries the answers: the letters", async () => {
    const res = replyOf(await run({ ...JD, details: ANSWERS }, lead));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain('"Daniel, D-A-N-I-E-L"');
  });

  it("the same lead with no notes: the letters at the first save", async () => {
    const res = replyOf(await run(JD, { ...lead, config: {} }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain('"Daniel, D-A-N-I-E-L"');
  });

  it("an existing client at a notes business: the letters at the first save", async () => {
    const res = replyOf(await run(JD, { ...lead, callerType: "existing_customer" }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain('"Daniel, D-A-N-I-E-L"');
  });

  it("a type never reported or unclear is a lead: deferred too", async () => {
    for (const callerType of [null, "other"]) {
      const res = replyOf(await run(JD, { ...lead, callerType }));
      expect(res.next, String(callerType)).not.toMatch(READ_BACK);
      expect(res.next, String(callerType)).toMatch(/after the last answer/i);
    }
  });

  it("confirm_style each reads nothing at the end, so nothing is deferred", async () => {
    const config = { capabilities: { messages: { notes: "Ask which company.", confirmStyle: "each" } } };
    const res = replyOf(await run(JD, { ...lead, config }));
    expect(res.next).not.toMatch(/after the last answer/i);
  });

  it("a withheld number comes FIRST, before the questions note (P32 N3)", async () => {
    const res = replyOf(await run({ ...JD, callback_number: undefined }, { ...lead, callerPhone: "" }));
    expect(res.next.startsWith("[not caller speech] Their message is saved, but there is no number")).toBe(true);
    expect(res.next.indexOf("notes list questions")).toBeGreaterThan(res.next.indexOf("did not come through"));
    // The deferral is scoped to the name, so it does not contradict the number note.
    expect(res.next).toMatch(/Apart from their number, do not read anything back yet/);
    expect(/"[^"]+\?"/.test(res.next)).toBe(false);
  });

  it("only the call's FIRST save is deferred: a correction re-save without details hands the letters (P32 N2)", async () => {
    const first = await run(JD, { ...lead, callerSpelled: true });
    expect(replyOf(first).next).not.toMatch(READ_BACK);
    // The runner threads the effect's capabilityState back into ctx on the next call.
    const state = first.stateEffects.capabilityState;
    const second = replyOf(await run({ ...JD, caller_name: "Jonathan Daniels" }, { ...lead, callerSpelled: true, capabilityState: state }));
    expect(second.next).toMatch(READ_BACK);
    expect(second.next).toContain("D-A-N-I-E-L-S");
    expect(second.next).not.toMatch(/after the last answer/i);
  });

  it("notes that are rules, not questions: the letters at the first save (P32 N2)", async () => {
    for (const notes of ["Promise a same-day call back.", "Calls are returned by the owner."]) {
      const config = { capabilities: { messages: { notes } } };
      const res = replyOf(await run(JD, { ...lead, config }));
      expect(res.next, notes).toMatch(READ_BACK);
    }
  });

  it("notes with a question mark or the word ask still defer (P32 N2)", async () => {
    for (const notes of ["What is your company?", "Always ask for the company."]) {
      const config = { capabilities: { messages: { notes } } };
      expect(replyOf(await run(JD, { ...lead, config })).next, notes).not.toMatch(READ_BACK);
    }
  });

  it("the healthcare tier is byte-identical: its own note, its own read-back rule", async () => {
    const config = { complianceTier: "hipaa", capabilities: { messages: { notes: "Ask which company." } } };
    const res = replyOf(await run(JD, { callerSpelled: true, callerType: "new_enquiry", config }));
    expect(res.next).toMatch(READ_BACK);
    expect(res.next).toContain(
      "If this business's notes list more questions for this caller, ask them now, one at a time, before closing."
    );
    expect(res.next).not.toMatch(/after the last answer/i);
  });

  it("an on-file lead at a notes business: the questions note, and no letters either way", async () => {
    const res = replyOf(
      await run(JD, { ...lead, callerContext: { upcomingAppointments: [{ client_name: "Jonathan Daniel" }] } })
    );
    expect(res.next).not.toContain("D-A-N-I-E-L");
  });
});
