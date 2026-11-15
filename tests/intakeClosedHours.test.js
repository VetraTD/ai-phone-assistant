/**
 * Fix wave I6: the closed-hours section of the dynamic tail on the standard
 * tier points at the message protocol instead of the old name/number
 * checklist. The healthcare tier keeps today's text. Rendered with the clock
 * set to closed hours (the snapshot fixtures render at an open time, which is
 * how this was missed).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildDynamicTail } from "../services/gemini.js";

const HOURS = {
  mon: { open: "08:00", close: "17:00", closed: false },
  tue: { open: "08:00", close: "17:00", closed: false },
  wed: { open: "08:00", close: "17:00", closed: false },
  thu: { open: "08:00", close: "17:00", closed: false },
  fri: { open: "08:00", close: "16:00", closed: false },
  sat: { open: "09:00", close: "13:00", closed: false },
  sun: { open: null, close: null, closed: true },
};

const config = (over = {}) => ({
  businessName: "Testwork Services",
  timezone: "America/Chicago",
  businessHours: HOURS,
  allowedTasks: ["general_question", "take_message", "callback_request"],
  afterHoursPolicy: "take_message",
  capabilities: { messages: { enabled: true } },
  ...over,
});

function tail(over) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T02:00:00Z")); // Thu 21:00 Chicago, shut
  const out = buildDynamicTail("identify_intent", null, config(over), {});
  expect(out).toContain("=== AFTER-HOURS BEHAVIOR ===");
  const from = out.indexOf("=== AFTER-HOURS BEHAVIOR ===");
  const next = out.indexOf("\n===", from + 5);
  return out.slice(from, next === -1 ? undefined : next);
}

describe("closed hours, standard tier (fix wave I6)", () => {
  afterEach(() => vi.useRealTimers());

  it("take_message points at the message protocol, with no name, number checklist", () => {
    const t = tail({});
    expect(t).toContain("record_customer_request");
    expect(t).toContain("message protocol");
    expect(t).not.toMatch(/name, number/i);
    expect(t).not.toMatch(/best number to reach/i);
    expect(t).not.toMatch(/"[^"]+\?"/);
  });

  it("offer_callback points at the message protocol, with no ordered name-then-number asks", () => {
    const t = tail({ afterHoursPolicy: "offer_callback" });
    expect(t).toContain('request_type "callback"');
    expect(t).toContain("message protocol");
    expect(t).not.toMatch(/first their name, then the best number/i);
    expect(t).not.toMatch(/best number to reach/i);
  });
});

describe("closed hours, healthcare tier keeps today's text", () => {
  afterEach(() => vi.useRealTimers());

  it("take_message: the checklist", () => {
    const t = tail({ complianceTier: "hipaa" });
    expect(t).toContain(
      'Offer to take a message using record_customer_request with request_type "message". Collect their name, number, and message.'
    );
    expect(t).not.toContain("message protocol");
  });

  it("offer_callback: the ordered asks", () => {
    const t = tail({ complianceTier: "hipaa", afterHoursPolicy: "offer_callback" });
    expect(t).toContain(
      `Offer to record a callback request using record_customer_request with request_type "callback". Then collect what you need ONE question per turn: first their name, then the best number to reach them, then when they'd like the callback. Never ask for two of those in the same response.`
    );
  });
});
