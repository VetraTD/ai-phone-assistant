import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log } from "../lib/logger.js";
import { REDACTED } from "../lib/phiFields.js";

// A1.7's safety net. tests/logPhiLint.test.js is the guard — it fails the build
// when a PHI-typed name appears in a logger call, which is the mechanism that
// matters because it tells the AUTHOR rather than the log sink.
//
// This covers what a source lint cannot see: a field name that arrives through
// a spread of tool arguments, or a computed key. Neither is hypothetical —
// `{ ...fc.args }` is how a model's tool call reaches a log line, and a model
// decides those key names at runtime.

let lines;
let writeSpy;

beforeEach(() => {
  lines = [];
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(JSON.parse(String(chunk)));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
});

describe("the logger redacts PHI-typed fields", () => {
  it.each([
    ["callerPhone", "+15559998888"],
    ["clientName", "Jane Q Patient"],
    ["notes", "chest pain since Tuesday"],
    ["dob", "1970-01-01"],
    ["transcript", "I need to move my echo appointment"],
    ["email", "patient@example.com"],
  ])("replaces %s", (key, value) => {
    log.info("e", { callSid: "CA1", [key]: value });
    expect(lines[0][key]).toBe(REDACTED);
    expect(JSON.stringify(lines[0])).not.toContain(value);
  });

  it("reaches PHI nested inside a spread of tool arguments", () => {
    // The shape that motivated this: a model's tool call, logged wholesale.
    log.info("tool_call", { callSid: "CA1", tool: "book_appointment", args: { clientName: "Jane Q Patient", when: "3pm" } });
    expect(JSON.stringify(lines[0])).not.toContain("Jane Q Patient");
    expect(lines[0].args.when).toBe("3pm");
  });

  it("reaches into arrays", () => {
    log.info("e", { callSid: "CA1", items: [{ notes: "chest pain" }, { ok: true }] });
    expect(JSON.stringify(lines[0])).not.toContain("chest pain");
    expect(lines[0].items[1].ok).toBe(true);
  });

  it("leaves everything else alone", () => {
    log.info("e", { callSid: "CA1", businessPhone: "+15550001111", message: "boom", tool: "x", count: 3 });
    expect(lines[0].businessPhone).toBe("+15550001111");
    expect(lines[0].message).toContain("boom");
    expect(lines[0].tool).toBe("x");
    expect(lines[0].count).toBe(3);
  });

  it("redacts before the human-readable message is built, not after", () => {
    // buildMessage reads fields.message, and an error message is not a PHI-typed
    // field — but if redaction ran after, a redacted value could still be
    // rendered into the message string. Order is asserted rather than assumed.
    log.info("e", { callSid: "CA1", summary: "Caller described their symptoms" });
    expect(JSON.stringify(lines[0])).not.toContain("symptoms");
  });

  it("terminates on a cycle instead of hanging", () => {
    const a = { callSid: "CA1" };
    a.self = a;
    expect(() => log.info("e", a)).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});
