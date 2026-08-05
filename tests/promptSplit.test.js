import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  getClient,
} from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";
import { resolveProfile } from "../lib/voice/voiceLocale.js";
import { speakableDateTime } from "../lib/capabilities/datetime.js";

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

describe("gemini.js — business hours rendering in prompts (legacy + weekly shapes)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("legacy shape: DATE/TIME section renders the single window unchanged, never 'undefined'", () => {
    const legacyConfig = { ...config, timezone: "UTC", businessHours: { open_time: "09:00", close_time: "17:00" } };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday 15:00 UTC — within window

    const tail = buildDynamicTail("gather_details", "book_appointment", legacyConfig, extras);

    expect(tail).toContain("Business hours: 09:00 – 17:00.");
    expect(tail).toContain("Status: OPEN.");
    expect(tail).not.toContain("undefined");
  });

  it("weekly shape (post-migration-014 / the new business default): DATE/TIME section renders today's hours + closed days, never 'undefined'", () => {
    const weeklyConfig = {
      ...config,
      timezone: "UTC",
      businessHours: {
        mon: { open: "09:00", close: "17:00", closed: false },
        tue: { open: "09:00", close: "17:00", closed: false },
        wed: { open: "09:00", close: "17:00", closed: false },
        thu: { open: "09:00", close: "17:00", closed: false },
        fri: { open: "09:00", close: "17:00", closed: false },
        sat: { open: null, close: null, closed: true },
        sun: { open: null, close: null, closed: true },
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z")); // Monday 15:00 UTC

    const tail = buildDynamicTail("gather_details", "book_appointment", weeklyConfig, extras);

    expect(tail).toContain("Business hours today (Monday): 9:00 AM – 5:00 PM.");
    expect(tail).toContain("Closed Saturday, Sunday.");
    expect(tail).toContain("Status: OPEN.");
    expect(tail).not.toContain("undefined");

    // book_appointment step guidance must also render real hours inline,
    // not "business hours (undefined – undefined)".
    expect(tail).toContain("today's hours, 9:00 AM – 5:00 PM");
  });

  it("weekly shape: closed-today renders 'closed today (Day)' and Status: CLOSED, never 'undefined'", () => {
    const weeklyConfig = {
      ...config,
      timezone: "UTC",
      businessHours: {
        mon: { open: "09:00", close: "17:00", closed: false },
        sat: { open: null, close: null, closed: true },
        sun: { open: null, close: null, closed: true },
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T15:00:00Z")); // Saturday 15:00 UTC

    const tail = buildDynamicTail("gather_details", "book_appointment", weeklyConfig, extras);

    expect(tail).toContain("Business hours: closed today (Saturday).");
    expect(tail).toContain("Status: CLOSED.");
    expect(tail).not.toContain("undefined");
  });

  it("language rules: multi-language configs demand replying in the caller's language; single non-English speaks it by default", () => {
    const multi = buildStaticSystemPrefix({ ...config, languagesSpoken: ["en", "es"] }, extras);
    expect(multi).toContain("You can speak: en, es");
    expect(multi).toContain("language of the caller's most recent message");

    const esOnly = buildStaticSystemPrefix({ ...config, languagesSpoken: ["es"] }, extras);
    expect(esOnly).toContain("Speak es by default");
    expect(esOnly).toContain("If the caller speaks English, switch to English");

    const enOnly = buildStaticSystemPrefix({ ...config, languagesSpoken: ["en"] }, extras);
    expect(enOnly).not.toContain("Speak en by default");
  });

  // Guard added when the dashboard stopped offering "book for later" to
  // non-appointment businesses: a stored book_later policy must not still
  // instruct the model to call book_appointment when that tool was never
  // registered (allowedTasks lacks it). It falls back to take-a-message.
  const closedSaturday = {
    ...config,
    timezone: "UTC",
    afterHoursPolicy: "book_later",
    businessHours: {
      mon: { open: "09:00", close: "17:00", closed: false },
      sat: { open: null, close: null, closed: true },
      sun: { open: null, close: null, closed: true },
    },
  };

  it("after-hours book_later WITH book_appointment enabled instructs the model to book", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T15:00:00Z")); // Saturday = CLOSED
    const tail = buildDynamicTail("gather_details", null, closedSaturday, extras);

    expect(tail).toContain("=== AFTER-HOURS BEHAVIOR ===");
    expect(tail).toContain("book appointments for future business hours using book_appointment");
  });

  it("after-hours book_later WITHOUT book_appointment falls back to take-a-message (no phantom tool)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T15:00:00Z")); // Saturday = CLOSED
    const noBooking = { ...closedSaturday, allowedTasks: ["general_question", "take_message"] };
    const tail = buildDynamicTail("gather_details", null, noBooking, extras);

    expect(tail).toContain("=== AFTER-HOURS BEHAVIOR ===");
    // The dead instruction is gone…
    expect(tail).not.toContain("using book_appointment");
    // …replaced by the take-a-message guidance.
    expect(tail).toContain('record_customer_request with request_type "message"');
  });

  it("AI disclosure rule is present in IDENTITY", () => {
    const prefix = buildStaticSystemPrefix(config, extras);
    expect(prefix).toContain("answer honestly");
    expect(prefix).toContain("Never claim to be human");
  });

  it("system-note guard is present in TOOL CONTRACT (bracketed notes are trusted state, never caller speech)", () => {
    const prefix = buildStaticSystemPrefix(config, extras);
    expect(prefix).toContain("[system note — not the caller speaking:");
    expect(prefix).toContain("never as caller speech");
  });
});

describe("NON-NEGOTIABLE availability rule names the tool that is actually registered", () => {
  it("an EHR (athena) business uses the get_available_slots wording", () => {
    const { config: cfg, extras: ex } = FIXTURES["clinic-athena"];
    const prefix = buildStaticSystemPrefix(cfg, ex);
    expect(prefix).toContain("before checking it with get_available_slots");
    expect(prefix).not.toContain("before checking it with check_appointment_availability");
  });

  it("a built-in-calendar business uses the check_appointment_availability wording", () => {
    const { config: cfg, extras: ex } = FIXTURES["appointments-availability"];
    const prefix = buildStaticSystemPrefix(cfg, ex);
    expect(prefix).toContain("before checking it with check_appointment_availability");
    expect(prefix).not.toContain("before checking it with get_available_slots");
  });
});

// ---------------------------------------------------------------------------
// Cache safety + PHI containment.
//
// The static prefix is the unit of the explicit Gemini context cache
// (services/geminiCache.js). Two properties have to hold, and neither is
// obvious from reading the prompt builder:
//
//   1. It must be byte-identical for every CALLER of a business. If it varies
//      per caller, the cache key varies per caller, and there is effectively no
//      cache at all — every call pays full input price.
//   2. It must contain no caller data. An explicit cache is stored on Google's
//      side for its TTL; caller names, call summaries and appointment times
//      must not be what gets parked there.
//
// CALLER CONTEXT used to live in the prefix and violated both. These tests are
// what stop a future prompt change from quietly putting it (or anything like
// it) back.
// ---------------------------------------------------------------------------
describe("gemini.js — static prefix is cache-safe and caller-free", () => {
  const callerA = {
    callCount: 4,
    lastCallSummary: "asked about a crown replacement",
    upcomingAppointments: [{ scheduled_at: "2026-08-01T10:00:00", client_name: "Jane Okafor" }],
  };
  const callerB = {
    callCount: 1,
    lastCallSummary: "rescheduled a cleaning",
    upcomingAppointments: [{ scheduled_at: "2026-09-14T15:30:00", client_name: "Tomás Ruiz" }],
  };

  it("is byte-identical across different callers of the same business", () => {
    const withA = buildStaticSystemPrefix(config, { ...extras, callerContext: callerA });
    const withB = buildStaticSystemPrefix(config, { ...extras, callerContext: callerB });
    const withNone = buildStaticSystemPrefix(config, { ...extras, callerContext: null });

    expect(withA).toBe(withB);
    expect(withA).toBe(withNone);
  });

  it("contains no caller name, summary, or rendered appointment date", () => {
    const prefix = buildStaticSystemPrefix(config, { ...extras, callerContext: callerA });

    expect(prefix).not.toContain("=== CALLER CONTEXT ===");
    expect(prefix).not.toContain("Jane Okafor");
    expect(prefix).not.toContain("crown replacement");
    expect(prefix).not.toContain("returning caller");
    expect(prefix).not.toMatch(/They have called \d+ time/);
  });

  it("still delivers the caller context — in the dynamic tail, which is never cached", () => {
    const tail = buildDynamicTail("gather_details", "book_appointment", config, {
      ...extras,
      callerContext: callerA,
    });

    expect(tail).toContain("=== CALLER CONTEXT ===");
    expect(tail).toContain("They have called 4 times before");
    expect(tail).toContain("crown replacement");
    expect(tail).toContain("Jane Okafor");
  });

  // -------------------------------------------------------------------------
  // The unprompted read path.
  //
  // This block is what makes the assistant volunteer "I see you have an
  // appointment on..." from the caller's phone number alone, without being
  // asked. It is therefore just as capable of speaking a wrong time as the
  // tool path, and until now nothing asserted the time it renders — the
  // fixture above even uses a NAIVE datetime, which made the rendered output
  // depend on the machine running the suite.
  // -------------------------------------------------------------------------
  describe("renders appointment times in the BUSINESS timezone", () => {
    const ukConfig = { ...config, timezone: "Europe/London" };
    // 12:05Z is 1:05pm in London during BST. This is the reported bug's
    // instant: read back as "2:05 PM" it means the write was corrupted, read
    // back as "1:05 PM" the pipeline is honest.
    const ukCaller = {
      callCount: 2,
      upcomingAppointments: [{ scheduled_at: "2026-08-10T12:05:00.000Z", client_name: "Josh" }],
    };

    it("speaks 12:05Z as 1:05 PM for a Europe/London business, in BST", () => {
      const tail = buildDynamicTail("identify_intent", null, ukConfig, {
        ...extras,
        callerContext: ukCaller,
      });

      expect(tail).toMatch(/1:05\s?PM/);
      expect(tail).not.toMatch(/2:05\s?PM/);
    });

    it("agrees with the appointment tool's own formatter on the same row", () => {
      // Two independent read paths reached the caller, each with its own
      // formatter and its own timezone fallback. They must not be able to
      // disagree about what time an appointment is.
      const tail = buildDynamicTail("identify_intent", null, ukConfig, {
        ...extras,
        callerContext: ukCaller,
      });

      // Both paths take the same locale profile now, so agreement is asserted
      // through it: a Europe/London business says "Monday the 10th of August",
      // and BOTH read paths have to say it that way or the caller hears two
      // different renderings of one row.
      expect(tail).toContain(
        speakableDateTime("2026-08-10T12:05:00.000Z", "Europe/London", resolveProfile(ukConfig))
      );
      expect(tail).toMatch(/the 10th of August/);
    });

    it("falls back to the shared default zone, not the server's, when no timezone is configured", () => {
      // The old hand-rolled formatter passed `timeZone: undefined`, which makes
      // Intl silently use the process zone — so this block's output changed
      // depending on where the server happened to be deployed.
      const noTz = { ...config, timezone: undefined };
      const tail = buildDynamicTail("identify_intent", null, noTz, {
        ...extras,
        callerContext: ukCaller,
      });

      expect(tail).toContain(speakableDateTime("2026-08-10T12:05:00.000Z", undefined, resolveProfile(noTz)));
    });
  });

  it("emits nothing at all when the caller has no history (the empty-case contract)", () => {
    const bare = buildDynamicTail("identify_intent", null, config, { ...extras, callerContext: null });
    expect(bare).not.toContain("=== CALLER CONTEXT ===");

    const zero = buildDynamicTail("identify_intent", null, config, {
      ...extras,
      callerContext: { callCount: 0, upcomingAppointments: [] },
    });
    expect(zero).not.toContain("=== CALLER CONTEXT ===");
  });

  it("keeps buildSystemInstruction's total content unchanged by the move", () => {
    const full = buildSystemInstruction("confirm", null, config, { ...extras, callerContext: callerA });
    expect(full).toContain("=== CALLER CONTEXT ===");
    expect(full).toContain("Jane Okafor");
  });
});

// ---------------------------------------------------------------------------
// The existing-appointment rule must not depend on the model having already
// decided the call is about booking.
//
// Production call 0db83104: the ASSISTANT offered a strategy call while still
// answering a general question. The rule lived in the book_appointment step
// guidance, which is keyed on intent, so at the moment the offer was made
// nothing had told the model to check. It offered, collected a time, and only
// discovered the conflict when the caller pointed it out.
//
// The rule now lives in the CALLER CONTEXT block, which renders whenever the
// caller HAS an upcoming appointment — whatever step or intent the call is in.
// ---------------------------------------------------------------------------
describe("gemini.js — the existing-appointment rule is intent-independent", () => {
  const apptConfig = (existingAppointment) => ({
    businessName: "Acme Dental",
    timezone: "America/Chicago",
    allowedTasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
    capabilities: {
      appointments: { adapter: "internal", ...(existingAppointment ? { existingAppointment } : {}) },
    },
  });

  const withAppt = {
    callerContext: {
      callCount: 2,
      lastCallSummary: "asked about hours",
      upcomingAppointments: [
        { id: "a1", client_name: "Boris Johnson", scheduled_at: "2026-09-10T19:00:00.000Z" },
      ],
    },
  };
  const noAppt = {
    callerContext: { callCount: 2, lastCallSummary: "asked about hours", upcomingAppointments: [] },
  };

  // Specific to the new rule. A looser pattern also matched escalation wording
  // that has always been in the static prefix.
  const OFFER_RULE = /do not offer to book, schedule, or arrange/i;

  it("appears on a general-question turn, which is where the bad offer was made", () => {
    const tail = buildDynamicTail("gather_details", "general_question", apptConfig(), withAppt);
    expect(tail).toMatch(OFFER_RULE);
  });

  it("appears before any intent has been decided", () => {
    const tail = buildDynamicTail("identify_intent", null, apptConfig(), withAppt);
    expect(tail).toMatch(OFFER_RULE);
  });

  it("costs nothing for a returning caller who has no appointment", () => {
    const tail = buildDynamicTail("gather_details", "general_question", apptConfig(), noAppt);
    expect(tail).not.toMatch(OFFER_RULE);
  });

  it("costs nothing for a first-time caller", () => {
    const tail = buildDynamicTail("gather_details", "general_question", apptConfig(), {});
    expect(tail).not.toMatch(OFFER_RULE);
  });

  it("says nothing under allow, which is the opt-out", () => {
    const tail = buildDynamicTail("gather_details", "general_question", apptConfig("allow"), withAppt);
    expect(tail).not.toMatch(OFFER_RULE);
    // ...but the appointment itself is still listed, so the model is not blind.
    expect(tail).toContain("Upcoming appointments:");
  });

  it("tells the model to offer a move, not a second booking, under block", () => {
    const tail = buildDynamicTail("gather_details", "general_question", apptConfig("block"), withAppt);
    expect(tail).toMatch(OFFER_RULE);
    expect(tail).toMatch(/move|reschedule/i);
  });

  it("never reaches the cacheable static prefix", () => {
    const prefix = buildStaticSystemPrefix(apptConfig(), withAppt);
    expect(prefix).not.toMatch(OFFER_RULE);
    expect(prefix).not.toContain("Boris Johnson");
  });
});
