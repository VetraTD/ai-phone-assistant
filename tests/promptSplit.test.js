import { describe, it, expect } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  getClient,
} from "../services/gemini.js";

const config = {
  businessName: "Acme Dental",
  timezone: "America/Chicago",
  businessHours: { open_time: "09:00", close_time: "17:00" },
  allowedTasks: ["book_appointment", "general_question", "take_message"],
  afterHoursPolicy: "take_message",
  languagesSpoken: ["en", "es"],
  mainPhone: "555-1234",
  generalInfo: "We are open Mon-Fri.",
  customInstructions: "Always mention our summer promo.",
};

const extras = {
  knowledge: [{ question: "Do you take insurance?", answer: "Yes.", category: "billing" }],
  callerContext: {
    callCount: 2,
    lastCallSummary: "booked a cleaning",
    upcomingAppointments: [{ scheduled_at: "2026-08-01T10:00:00", client_name: "Jane" }],
  },
  transferAllowed: true,
  integrations: [{ enabled: true, provider: "athenahealth" }],
};

describe("gemini.js — system prompt split (static prefix + dynamic tail)", () => {
  it("1. buildStaticSystemPrefix contains business name/KB/guardrails and no step names or date/time strings", () => {
    const prefix = buildStaticSystemPrefix(config, extras);

    expect(prefix).toContain("Acme Dental");
    expect(prefix).toContain("=== KNOWLEDGE BASE ===");
    expect(prefix).toContain("Do you take insurance?");
    expect(prefix).toContain("=== GUARDRAILS ===");

    // Receptionist-craft prompt overhaul: message protocol + identity voice rules.
    expect(prefix).toContain("=== MESSAGE PROTOCOL ===");
    expect(prefix).toContain("digit by digit");
    expect(prefix).toContain("1-2 short sentences");

    // Nothing time- or step-dependent belongs in the static prefix.
    expect(prefix).not.toContain("=== DATE AND TIME ===");
    expect(prefix).not.toContain("=== AFTER-HOURS BEHAVIOR ===");
    expect(prefix).not.toContain("=== CURRENT TASK AND STATE ===");
    expect(prefix).not.toContain("Step:");
    expect(prefix).not.toContain("gather_details");
    expect(prefix).not.toContain("identify_intent");
  });

  it("2. buildDynamicTail contains date/time + step guidance, no seconds, and is stable within the same minute", () => {
    const tail1 = buildDynamicTail("gather_details", "book_appointment", config, extras);
    const tail2 = buildDynamicTail("gather_details", "book_appointment", config, extras);

    expect(tail1).toContain("=== DATE AND TIME ===");
    expect(tail1).toContain("=== CURRENT TASK AND STATE ===");
    expect(tail1).toContain("Step: gather_details");
    expect(tail1).toContain("Intent: book_appointment");
    // Step guidance for book_appointment intent should be present.
    expect(tail1).toContain("book_appointment");

    // No seconds: the "Current: <date>, <time> (<tz>)" line's time component
    // must be formatted as h:mm (AM/PM), never h:mm:ss.
    const timeLine = tail1.split("\n").find((l) => l.startsWith("Current:"));
    expect(timeLine).toBeTruthy();
    const timeMatch = timeLine.match(/,\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\s*\(/);
    expect(timeMatch).toBeTruthy();
    expect(timeMatch[1]).not.toMatch(/:\d{2}:\d{2}/); // no h:mm:ss pattern

    // Stable within the same minute — two calls a few ms apart produce
    // identical output (same section structure, same text).
    expect(tail2).toBe(tail1);
  });

  it("3. buildSystemInstruction === buildStaticSystemPrefix + '\\n\\n' + buildDynamicTail", () => {
    const full = buildSystemInstruction("confirm", null, config, extras);
    const prefix = buildStaticSystemPrefix(config, extras);
    const tail = buildDynamicTail("confirm", null, config, extras);

    expect(full).toBe(`${prefix}\n\n${tail}`);
  });

  it("4. getClient returns the same singleton instance across calls", () => {
    const a = getClient();
    const b = getClient();
    expect(a).toBe(b);
  });
});
