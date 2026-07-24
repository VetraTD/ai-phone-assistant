/**
 * Unit tests for scripts/chatFormat.js's pure helpers — argv parsing and the
 * tool-call line formatter, which is the one piece of scripts/chat.js worth
 * testing in isolation (see scripts/chat.js's header for why the rest isn't).
 */
import { describe, it, expect } from "vitest";
import {
  parseArgs,
  defaultFixtureName,
  truncateValue,
  formatArgs,
  formatToolCallLine,
  formatStatusLine,
  makeSeedAppointments,
} from "../scripts/chatFormat.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

describe("parseArgs", () => {
  it("returns defaults when no flags are given", () => {
    expect(parseArgs([])).toEqual({ fixture: null, listFixtures: false, modelOverrides: {}, seedAppointments: 0 });
  });

  it("parses --list-fixtures as a boolean flag", () => {
    expect(parseArgs(["--list-fixtures"]).listFixtures).toBe(true);
  });

  it("parses --fixture", () => {
    expect(parseArgs(["--fixture", "clinic-athena"]).fixture).toBe("clinic-athena");
  });

  it("collects model knobs into modelOverrides with numeric coercion", () => {
    const opts = parseArgs([
      "--model", "gemini-2.5-pro",
      "--thinking-budget", "128",
      "--max-output-tokens", "500",
      "--temperature", "0.7",
    ]);
    expect(opts.modelOverrides).toEqual({
      model: "gemini-2.5-pro",
      thinkingBudget: 128,
      maxOutputTokens: 500,
      temperature: 0.7,
    });
  });

  it("parses --seed-appointments as a number, ignoring garbage", () => {
    expect(parseArgs(["--seed-appointments", "5"]).seedAppointments).toBe(5);
    expect(parseArgs(["--seed-appointments", "nope"]).seedAppointments).toBe(0);
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--bogus", "x", "--fixture", "messages-only"]).fixture).toBe("messages-only");
  });
});

describe("defaultFixtureName", () => {
  it("picks the first fixture whose allowedTasks include book_appointment", () => {
    expect(defaultFixtureName(FIXTURES)).toBe("clinic-athena");
  });
});

describe("truncateValue", () => {
  it("passes short strings through unchanged", () => {
    expect(truncateValue("hi")).toBe("hi");
  });

  it("truncates long strings to ~60 chars with an ellipsis", () => {
    const long = "a".repeat(90);
    const out = truncateValue(long);
    expect(out).toBe(`${"a".repeat(60)}…`);
    expect(out.length).toBe(61);
  });

  it("JSON-stringifies non-string values", () => {
    expect(truncateValue(42)).toBe("42");
    expect(truncateValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("formatArgs", () => {
  it("renders {} for empty/missing args", () => {
    expect(formatArgs(undefined)).toBe("{}");
    expect(formatArgs({})).toBe("{}");
  });

  it("renders key: value pairs, truncating long values", () => {
    const args = { date: "2026-08-01", notes: "b".repeat(80) };
    expect(formatArgs(args)).toBe(`{date: 2026-08-01, notes: ${"b".repeat(60)}…}`);
  });
});

describe("formatToolCallLine", () => {
  it("renders a successful call", () => {
    const line = formatToolCallLine(
      { name: "book_appointment_db", args: { date: "2026-08-01", time: "10:00" } },
      { success: true, message: "booked" }
    );
    expect(line).toBe("  [tool] book_appointment_db({date: 2026-08-01, time: 10:00}) → success booked");
  });

  it("renders a failed call", () => {
    const line = formatToolCallLine({ name: "cancel_appointment", args: {} }, { success: false, message: "not found" });
    expect(line).toBe("  [tool] cancel_appointment({}) → failure not found");
  });

  it("renders 'pending' when there is no matching result", () => {
    const line = formatToolCallLine({ name: "check_availability", args: {} }, undefined);
    expect(line).toBe("  [tool] check_availability({}) → pending");
  });

  it("truncates a long arg value inline", () => {
    const line = formatToolCallLine({ name: "take_message", args: { notes: "x".repeat(90) } }, { success: true, message: "" });
    expect(line).toBe(`  [tool] take_message({notes: ${"x".repeat(60)}…}) → success`);
  });
});

describe("formatStatusLine", () => {
  it("formats step/intent/seconds", () => {
    expect(formatStatusLine({ step: "gather_details", intent: "book_appointment" }, 1234)).toBe(
      "  (step: gather_details, intent: book_appointment, 1.2s)"
    );
  });

  it("shows 'none' for a null intent", () => {
    expect(formatStatusLine({ step: "identify_intent", intent: null }, 500)).toBe(
      "  (step: identify_intent, intent: none, 0.5s)"
    );
  });
});

describe("makeSeedAppointments", () => {
  it("spreads N rows one per day starting tomorrow, tagged with the given businessId", () => {
    const now = Date.parse("2026-07-24T12:00:00Z");
    const rows = makeSeedAppointments(3, { businessId: "biz-1", now });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.business_id === "biz-1" && r.status === "scheduled")).toBe(true);
    const days = rows.map((r) => new Date(r.scheduled_at).getUTCDate());
    expect(new Set(days).size).toBe(3);
  });

  it("returns an empty array for n=0", () => {
    expect(makeSeedAppointments(0)).toEqual([]);
  });
});
