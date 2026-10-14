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

  it("states the per-kind rule: message saved at once, booking unless they object, cancel on a clear yes", () => {
    const p = prefix(avail);
    expect(p).toMatch(/read the details back ONCE/);
    expect(p).toMatch(/booking that now/);
    expect(p).toMatch(/unless the caller objects/i);
    expect(p).toMatch(/cancell?ation[^.]*clear "yes"/i);
    expect(p).toMatch(/Never ask for the same yes twice/i);
  });

  it("keeps the contact-detail and email rules", () => {
    const p = prefix(avail);
    expect(p).toMatch(/phone number digit by digit/);
    expect(p).toMatch(/an email with no "@" in it is wrong/);
  });
});

describe("booking steps — one read-back, booked in the same breath", () => {
  for (const [name, f] of [["availability", avail], ["db", db]]) {
    it(`${name}: no "shall I go ahead" question and no wait for a clear confirmation`, () => {
      const t = tail(f, "gather_details", "book_appointment");
      expect(t).toMatch(/book_appointment/);
      expect(t).not.toMatch(/Shall I go ahead and book that\?/);
      expect(t).not.toMatch(/Does that sound right\?/);
      expect(t).not.toMatch(/until the caller clearly confirms/);
      expect(t).toMatch(/booking that now/);
    });
  }

  it("the book_appointment declaration no longer says 'only after confirmation'", () => {
    const d = bookDecl(avail);
    expect(d.description).not.toMatch(/Call this only after confirmation/);
    expect(d.description).toMatch(/booking that now/);
    expect(d.description).toMatch(/unless the caller objects/i);
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
