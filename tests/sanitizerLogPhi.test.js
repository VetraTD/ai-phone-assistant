import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { log } from "../lib/logger.js";
import { sanitizeOutbound, stripInternalTerms } from "../lib/voice/speakableText.js";

// ---------------------------------------------------------------------------
// LVX24. Both sanitizers used to log `{ original: text.slice(0, 200) }`, and
// that text is the ASSISTANT's own speech -- which on these calls routinely
// carries the caller's name, phone number and appointment time, because
// reading details back is one of the commonest lines on the line.
//
// Neither guard caught it. lib/logger.js redacts by FIELD NAME from
// PHI_FIELD_NAMES, and tests/logPhiLint.test.js fails the build when one of
// those names appears in a logger call -- so both work on the name, and this
// field was called `original`. The lint's own header says it is aimed at the
// accident of passing along a variable that happens to be in scope. This is
// the other shape: PHI arriving as the VALUE of a field with an innocent name,
// which no name-based rule can see.
//
// What replaces it has to stay useful, or the next person puts the text back.
// The reason anyone reads this line is to find out WHAT tripped the guard, and
// that is answerable without quoting the caller: how much text, and which rule.
// Our own vocabulary -- the internal terms, the tool names -- is ours to log.
// ---------------------------------------------------------------------------

/** Every field of every log.error call, as one string. */
const loggedText = () => JSON.stringify(log.error.mock.calls);

const CTX = {
  toolNames: ["cancel_appointment_db", "book_appointment"],
  toolParamNames: ["scheduled_at", "caller_name"],
  fallback: "Sorry, I could not do that.",
};

describe("the outbound sanitizer's log line", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not carry the caller's details", () => {
    sanitizeOutbound("Calling cancel_appointment_db for Marcus Bell on 07700 900123.", CTX);

    expect(log.error).toHaveBeenCalled();
    expect(loggedText()).not.toContain("Marcus");
    expect(loggedText()).not.toContain("900123");
  });

  it("says how much was there and which rule tripped", () => {
    sanitizeOutbound("Calling cancel_appointment_db for Marcus Bell on 07700 900123.", CTX);

    const fields = log.error.mock.calls.find((c) => c[0] === "outbound_sanitized")?.[1];
    expect(fields.chars).toBe(62);
    expect(fields.rules).toContain("registry");
  });

  it("distinguishes a structural hit from a tool-name hit", () => {
    // A path, not a declared tool name: shape alone gives this one away.
    sanitizeOutbound("I got an error from /var/log/app/bookings.js for Marcus.", CTX);

    const fields = log.error.mock.calls.find((c) => c[0] === "outbound_sanitized")?.[1];
    expect(fields.rules).toContain("structural");
    expect(fields.rules).not.toContain("registry");
  });

  it("stays quiet when there was nothing to sanitize", () => {
    sanitizeOutbound("Thursday at two is fine, Marcus.", CTX);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("the internal-term stripper's log line", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not carry the caller's details", () => {
    stripInternalTerms("Our backend lost Marcus Bell's number 07700 900123.");

    expect(log.error).toHaveBeenCalled();
    expect(loggedText()).not.toContain("Marcus");
    expect(loggedText()).not.toContain("900123");
  });

  it("names OUR vocabulary, which is what anyone reading this needs", () => {
    stripInternalTerms("Our backend could not reach the database.");

    const fields = log.error.mock.calls.find((c) => c[0] === "internal_term_stripped")?.[1];
    expect(fields.terms).toEqual(expect.arrayContaining(["backend", "database"]));
    expect(fields.chars).toBe(41);
  });

  it("stays quiet when there was nothing to strip", () => {
    stripInternalTerms("Thursday at two is fine, Marcus.");
    expect(log.error).not.toHaveBeenCalled();
  });
});
