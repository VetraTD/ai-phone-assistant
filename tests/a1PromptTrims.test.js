// ---------------------------------------------------------------------------
// Round A1 "say it once" (LVX177 / LVX172 / LVX178), T4 — the prompt text.
//
// Owner, 2026-10-13: "it shouldn't make me say yes twice." The code (S1) now
// saves a message as soon as the model calls it, and a booking or reschedule
// after ONE read-back unless the caller objects. These assertions pin the
// prompt to the same rule, sentence by sentence, so the model is not told to
// ask for a yes the gate no longer needs:
//   - messages and quotes: one summary (number digit by digit INSIDE it), saved
//     straight away; a correction is filed again;
//   - bookings: the slot and name said once as it is booked ("Tuesday at 3 for
//     Jon Doe, booking that now"), booked unless the caller objects;
//   - cancellations: unchanged — still a read-back and a clear yes;
//   - spelling: the letters are read back inside that one read-back, never as
//     a separate "confirm those letters" question;
//   - after the action: no second read-back of the details;
//   - end_call: only after the caller has been asked "anything else?" and said
//     no, or said goodbye themselves.
// The prompt snapshots move with these edits; these name WHY each moved.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildAllDeclarations,
} from "../services/gemini.js";
import { FIXTURES, OUTBOUND_FIXTURES } from "./fixtures/businessConfigs.js";

const avail = FIXTURES["appointments-availability"];
const db = FIXTURES["appointments-db"];
const quotes = FIXTURES["modules-and-webhook"];

const prefix = (f) => buildStaticSystemPrefix(f.config, f.extras);
const tail = (f, step, intent, over = {}) =>
  buildDynamicTail(step, intent, f.config, { ...f.extras, ...over });
const endCall = (f) =>
  buildAllDeclarations(f.config, f.extras).find((d) => d.name === "end_call");
const bookDecl = (f) =>
  buildAllDeclarations(f.config, f.extras).find((d) => d.name === "book_appointment");

describe("non-negotiable rule 3 — read back once, by kind", () => {
  it("no longer asks for a clear yes before EVERY write", () => {
    // Old rule: "Before writing or changing anything (booking, cancellation,
    // message), read the details back and get a clear "yes" from the caller
    // first." That is the second confirmation A1 removes for messages and
    // bookings.
    expect(prefix(avail)).not.toMatch(/Before writing or changing anything \(booking, cancellation, message\)/);
  });

  // LVX179 (owner, 2026-10-16): a booking asks ONE question and books on any
  // answer that is not a no; then only "Done, you're all set".
  it("states the per-kind rule: message saved at once, booking on one question, cancel on a clear yes", () => {
    const p = prefix(avail);
    expect(p).toMatch(/read the details back ONCE/);
    expect(p).not.toMatch(/booking that now/);
    expect(p).toMatch(/So that's Tuesday at 3 p\.m\. for Jon Doe, is that right\?/);
    expect(p).toMatch(/when they answer with anything but a no; then say only "Done, you're all set\."/);
    expect(p).toMatch(/cancell?ation[^.]*clear "yes"/i);
    expect(p).toMatch(/Never ask for the same yes twice/i);
  });

  it("keeps the contact-detail and email rules", () => {
    const p = prefix(avail);
    expect(p).toMatch(/phone number digit by digit/);
    expect(p).toMatch(/an email with no "@" in it is wrong/);
  });
});

describe("booking steps — ONE question, booked on the answer (LVX179)", () => {
  for (const [name, f] of [["availability", avail], ["db", db]]) {
    it(`${name}: no "shall I go ahead" question and no wait for a clear confirmation`, () => {
      const t = tail(f, "gather_details", "book_appointment");
      expect(t).toMatch(/book_appointment/);
      expect(t).not.toMatch(/Shall I go ahead and book that\?/);
      expect(t).not.toMatch(/Does that sound right\?/);
      expect(t).not.toMatch(/until the caller clearly confirms/);
      expect(t).not.toMatch(/booking that now/);
      expect(t).toMatch(/is that right\?/);
      expect(t).toMatch(/do not call book_appointment in that same response/);
      expect(t).toMatch(/Done, you're all set/);
    });
  }

  it("the book_appointment declaration no longer says 'only after confirmation'", () => {
    const d = bookDecl(avail);
    expect(d.description).not.toMatch(/Call this only after confirmation/);
    expect(d.description).not.toMatch(/booking that now/);
    expect(d.description).toMatch(/ONE question/);
    expect(d.description).toMatch(/never in the same response as that question/);
  });

  it("keeps the 'do not re-check availability before booking' rule", () => {
    expect(tail(avail, "gather_details", "book_appointment")).toMatch(/do NOT check availability one last time first/);
  });
});

describe("messages and quotes — one summary, saved straight away", () => {
  it("the message protocol saves in the same breath as its one summary", () => {
    const p = prefix(avail);
    expect(p).not.toMatch(/only AFTER the read-back is confirmed/);
    expect(p).toMatch(/TAKING A MESSAGE/);
    expect(p).toMatch(/record it again with the fix/i);
  });

  it("the number is read back inside the summary, not as its own wait", () => {
    // Old rule: "2. Number: ... Read it back digit by digit to confirm." — a
    // separate confirmation before the summary.
    const p = prefix(avail);
    expect(p).not.toMatch(/Read it back digit by digit to confirm/);
    for (const intent of ["take_message", "callback_request"]) {
      const t = tail(avail, "gather_details", intent);
      expect(t).not.toMatch(/after the read-back is confirmed/);
      expect(t).not.toMatch(/read it back digit by digit to confirm/);
      expect(t).toMatch(/digit by digit/);
    }
  });

  it("the quote guidance records straight away after one summary", () => {
    const t = tail(quotes, "gather_details", "quote_request");
    expect(t).toMatch(/record_quote_request/);
    expect(t).not.toMatch(/read it back digit by digit to confirm/);
    expect(t).toMatch(/straight away/);
  });
});

describe("spelling — read back inside the one read-back, never a separate check", () => {
  it("the tool contract no longer asks the caller to confirm the letters", () => {
    const p = prefix(avail);
    expect(p).not.toMatch(/confirm those letters/);
    // What it protected stays: letters win, used in every tool call.
    expect(p).toMatch(/the letters normally win/i);
    expect(p).toMatch(/in every tool call/i);
  });

  it("the SPELLING NOT YET CONFIRMED block does not ask for a letters read-back of its own", () => {
    const t = tail(avail, "gather_details", "book_appointment", { callerContext: null });
    expect(t).toMatch(/SPELLING NOT YET CONFIRMED/);
    expect(t).not.toMatch(/and read the letters back/);
    expect(t).toMatch(/cannot record a name until they have spelled it/i);
  });
});

// Round A1 part 3 (2026-10-15). F3: the one read-back spelled a surname back
// only when the letters "did not look like a name" or differed by one letter
// (services/gemini.js), and the message summary never did -- call (a)'s row
// holds "Dodole" for D-O-D-L-A. LVX172's agreed design is unconditional. F4
// (owner): a name on file is never asked for; its surname is spelled in the
// read-back instead, as a statement.
describe("round A1 part 3 — the one read-back spells the surname (F3, F4)", () => {
  it("F3: a surname the caller spelled is always said back letter by letter inside the one read-back", () => {
    const p = prefix(avail);
    expect(p).not.toMatch(/does not look like a name, or they differ from what you heard by a single letter/);
    expect(p).toMatch(
      /whenever the caller has spelled a name, say it back one letter at a time inside your one question about the booking/
    );
    // LVX179 (owner): the first name too -- "Maja" and "Maya" sound the same.
    expect(p).toMatch(/for Nithin, N-I-T-H-I-N, Dodla, D-O-D-L-A, is that right\?/);
  });

  // Caller-experience Task 3: the numbered "summarise it ONCE" step is the
  // healthcare tier's protocol (byte-identical); the standard tier's read-back
  // is the described "Confirming" line, which spells the surname.
  it("F3, healthcare tier: the message summary spells a surname they spelled (prefix step 5 and the step guidance)", () => {
    const hipaa = { ...avail, config: { ...avail.config, complianceTier: "hipaa" } };
    expect(prefix(hipaa)).toMatch(/5\. Summarise it ONCE, in one breath — name \(a surname they spelled[^)]*one letter at a time\)/);
    for (const intent of ["take_message", "callback_request"]) {
      expect(tail(hipaa, "gather_details", intent)).toMatch(/\(5\) summarise it once — name \(a surname they spelled[^)]*one letter at a time\)/);
    }
  });

  it("F3, standard tier: the one read-back spells the surname; with confirmStyle each the confirmation does", () => {
    expect(prefix(avail)).toMatch(/Confirming: [^\n]*make one read-back at the end: the surname spelled/);
    for (const intent of ["take_message", "callback_request"]) {
      expect(tail(avail, "gather_details", intent)).toMatch(/Confirming: [^\n]*the surname spelled/);
    }
    const each = { ...avail, config: { ...avail.config, capabilities: { ...avail.config.capabilities, messages: { confirmStyle: "each" } } } };
    expect(prefix(each)).toMatch(/confirm each answer briefly as it is given, spelling the surname back from what you heard/);
  });

  // OLD BEHAVIOUR (part 3, F4): the read-back spelled an on-file surname as a
  // statement. Owner, part 4 (2026-10-15, call d1 "felt weird"): a name on
  // file is SAID, not spelled; only a surname spelled this call gets letters.
  it("part 4: a name on file is never asked for and is said, not spelled, in the one read-back (booking + message)", () => {
    const p = prefix(avail);
    const record = /If a name is on their record from an earlier call[^\n]*/g;
    // Standard tier (Task 3): the messages copy is described ("confirm once"),
    // the booking guardrail copy is untouched.
    const std = p.match(record) || [];
    expect(std.length).toBe(2);
    expect(std.filter((l) => /use it only to confirm once/.test(l)).length).toBe(1);
    expect(std.filter((l) => /ask once "Am I speaking with <name>\?"/.test(l)).length).toBe(1);
    // Healthcare tier: both copies are the old scripted line.
    const hp = prefix({ ...avail, config: { ...avail.config, complianceTier: "hipaa" } });
    const both = hp.match(record) || [];
    // LVX188 (R39): one copy in the messages protocol, one in the booking guardrail.
    expect(both.length).toBe(2);
    expect(p).not.toMatch(/you have it right already/);
    for (const line of both) {
      // LVX180 (d1b CAb3e55): an on-file caller was asked their full name.
      // LVX188: an on-file name is asked once, never assumed.
      expect(line).toMatch(/ask once "Am I speaking with <name>\?" If yes, use it and do not ask them to spell it/);
      expect(line).toMatch(/If no, ask for their name/);
      expect(line).not.toMatch(/one letter at a time/);
    }
    expect(p).toMatch(/just say the name/);
    expect(p).not.toMatch(/or one from their record, one letter at a time/);
    for (const intent of ["take_message", "callback_request"]) {
      expect(tail(avail, "gather_details", intent)).not.toMatch(/or one from their record, one letter at a time/);
    }
  });
});

describe("after the action — no second read-back", () => {
  it("the confirm step says it is done and asks anything else, without re-reading the details", () => {
    const t = tail(avail, "confirm", null);
    expect(t).not.toMatch(/read back key information/);
    expect(t).toMatch(/anything else/);
  });
});

describe("end_call (inbound) — goodbye only after the ask is answered", () => {
  it("says to call it only after asking anything else and hearing no, or a goodbye", () => {
    const d = endCall(avail);
    expect(d.description).toMatch(/anything else/);
    expect(d.description).toMatch(/Never say goodbye before/i);
  });

  it("the inbound closing rule puts the ask before any goodbye (LVX178)", () => {
    const p = prefix(avail);
    expect(p).toMatch(/When a task is done, or the caller starts to wrap up, ask whether there is anything else before any goodbye/);
    expect(p).toMatch(/never a goodbye and then the question/);
    // Still not the scripted sentence (promptConversationTruth's tic rule).
    expect(p).not.toContain("Is there anything else I can help you with?");
  });

  it("outbound's description is untouched", () => {
    const f = Object.values(OUTBOUND_FIXTURES)[0];
    const d = buildAllDeclarations(f.config, f.extras).find((x) => x.name === "end_call");
    if (d) expect(d.description).not.toMatch(/Never say goodbye before/i);
  });
});
