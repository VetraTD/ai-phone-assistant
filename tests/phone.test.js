import { describe, it, expect } from "vitest";
import { normalizePhoneNumber } from "../lib/phone.js";

// ---------------------------------------------------------------------------
// The bug this module exists for: every business row except the one the app
// bought itself had a LEADING NEWLINE inside the phone_number cell —
// "\n+442079460958" rather than "+442079460958". lookupBusinessByPhone matches
// on string equality, so the row was invisible and every call to that number
// fell through to the "our office" default config.
//
// Supabase's table editor renders a text column as a multi-line textarea, so a
// paste carrying a newline is stored verbatim and nothing downstream trims it.
// ---------------------------------------------------------------------------

describe("normalizePhoneNumber — whitespace damage (the actual production bug)", () => {
  it("strips a leading newline", () => {
    expect(normalizePhoneNumber("\n+442079460958")).toBe("+442079460958");
  });

  it("strips a trailing newline and a CRLF pair", () => {
    expect(normalizePhoneNumber("+442079460958\n")).toBe("+442079460958");
    expect(normalizePhoneNumber("\r\n+18176011171\r\n")).toBe("+18176011171");
  });

  it("strips interior spaces, tabs and non-breaking spaces", () => {
    expect(normalizePhoneNumber("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhoneNumber("+1\t817\t601\t1171")).toBe("+18176011171");
    expect(normalizePhoneNumber("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("strips a zero-width space and a BOM", () => {
    expect(normalizePhoneNumber("﻿+442079460958")).toBe("+442079460958");
    expect(normalizePhoneNumber("+4420​79460958")).toBe("+442079460958");
  });
});

describe("normalizePhoneNumber — human formatting", () => {
  it("strips parentheses, dashes and dots", () => {
    expect(normalizePhoneNumber("+1 (817) 601-1171")).toBe("+18176011171");
    expect(normalizePhoneNumber("+1.817.601.1171")).toBe("+18176011171");
  });

  it("strips unicode dashes a word processor may have substituted", () => {
    expect(normalizePhoneNumber("+1‑817–601—1171")).toBe("+18176011171");
    expect(normalizePhoneNumber("+1−817‐6011171")).toBe("+18176011171");
  });

  it("converts a 00 international prefix to +", () => {
    expect(normalizePhoneNumber("00442079460958")).toBe("+442079460958");
    expect(normalizePhoneNumber("00 44 20 7946 0958")).toBe("+442079460958");
  });

  it("is idempotent — a clean E.164 number passes through unchanged", () => {
    expect(normalizePhoneNumber("+442079460958")).toBe("+442079460958");
    expect(normalizePhoneNumber(normalizePhoneNumber("+44 20 7946 0958"))).toBe("+442079460958");
  });
});

describe("normalizePhoneNumber — rejects rather than guesses", () => {
  // Guessing a country code is how a UK number silently becomes a US one.
  // An ambiguous national-format number must fail at the write boundary with a
  // visible error, not be coerced into the wrong country.
  it("rejects national formats with no country code", () => {
    expect(normalizePhoneNumber("020 7946 0958")).toBeNull();
    expect(normalizePhoneNumber("8176011171")).toBeNull();
    expect(normalizePhoneNumber("(817) 601-1171")).toBeNull();
  });

  it("rejects a leading zero after the plus (not valid E.164)", () => {
    expect(normalizePhoneNumber("+0442079460958")).toBeNull();
  });

  it("rejects extensions and letters", () => {
    expect(normalizePhoneNumber("+18176011171x123")).toBeNull();
    expect(normalizePhoneNumber("+1-800-FLOWERS")).toBeNull();
  });

  it("rejects too-short and too-long numbers", () => {
    expect(normalizePhoneNumber("+1")).toBeNull();
    expect(normalizePhoneNumber(`+${"9".repeat(16)}`)).toBeNull();
  });

  it("rejects empty, whitespace-only and non-string input", () => {
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber("   \n\t  ")).toBeNull();
    expect(normalizePhoneNumber(null)).toBeNull();
    expect(normalizePhoneNumber(undefined)).toBeNull();
    expect(normalizePhoneNumber(18176011171)).toBeNull();
    expect(normalizePhoneNumber({})).toBeNull();
  });

  it("rejects a doubled plus", () => {
    expect(normalizePhoneNumber("++442079460958")).toBeNull();
  });

  it("accepts the maximum valid E.164 length (15 digits)", () => {
    expect(normalizePhoneNumber(`+${"9".repeat(15)}`)).toBe(`+${"9".repeat(15)}`);
  });
});
