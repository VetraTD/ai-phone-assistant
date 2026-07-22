/**
 * GOLDEN SNAPSHOT — the safety net for the capability-packs refactor.
 *
 * Step A of the refactor (see docs/superpowers/specs/2026-07-22-capability-packs-design.md)
 * moves appointment/message/transfer behavior out of services/gemini.js and
 * services/tools.js into capabilities/*.js. The rule for that step is
 * BYTE-IDENTICAL OUTPUT: the prompt the model sees and the tools it is offered
 * must not change by a single character.
 *
 * These snapshots are recorded BEFORE any refactoring. If a snapshot moves
 * during Step A, prompt text drifted and call quality is at risk — revert and
 * find the difference. After Step A they keep guarding against accidental
 * prompt edits.
 *
 * Deliberately exhaustive over the (fixture x step x intent) matrix, because
 * buildStepGuidance branches on intent and buildDbAppointmentTools branches on
 * whether an EHR integration is present — a snapshot of one combination would
 * miss exactly the branches the refactor touches.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildCallTools,
  buildIntegrationTools,
  buildDbAppointmentTools,
} from "../services/gemini.js";
import { normalizeAllowedTasks } from "../services/supabase.js";

// A fixed Monday inside business hours. The dynamic tail renders the current
// date/time, so without a frozen clock these snapshots would churn every run.
const FROZEN_NOW = new Date("2026-07-20T15:00:00Z");

const WEEKLY_HOURS = {
  mon: { open: "09:00", close: "17:00", closed: false },
  tue: { open: "09:00", close: "17:00", closed: false },
  wed: { open: "09:00", close: "17:00", closed: false },
  thu: { open: "09:00", close: "17:00", closed: false },
  fri: { open: "09:00", close: "16:00", closed: false },
  sat: { open: null, close: null, closed: true },
  sun: { open: null, close: null, closed: true },
};

/**
 * Fixtures span the distinct shapes the prompt builder can produce. Each pairs
 * a business config with the `extras` bag getReplyStreaming would pass.
 */
const FIXTURES = {
  // Full appointment stack behind an EHR — exercises ATHENA_FUNCTION_DECLARATIONS,
  // the EHR fork in step guidance, and suppression of the DB appointment tools.
  "clinic-athena": {
    config: {
      businessName: "Riverside Family Clinic",
      greeting: "Thanks for calling Riverside Family Clinic.",
      timezone: "America/Chicago",
      businessHours: WEEKLY_HOURS,
      transferPhoneNumber: "+15551230000",
      allowedTasks: normalizeAllowedTasks([
        "book_appointment",
        "check_appointment",
        "cancel_reschedule",
      ]),
      mainPhone: "555-0100",
      generalInfo: "We are a family practice serving the Riverside area since 1998.",
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      languagesSpoken: ["en", "es"],
      customInstructions: "Never quote prices. New patients need a 40-minute slot.",
    },
    extras: {
      knowledge: [
        { question: "Do you take insurance?", answer: "Yes, most major plans.", category: "billing" },
        { question: "Where do I park?", answer: "Free lot behind the building.", category: null },
      ],
      callerContext: {
        callCount: 2,
        lastCallSummary: "booked a cleaning",
        upcomingAppointments: [{ scheduled_at: "2026-08-01T10:00:00Z", client_name: "Jane Doe" }],
      },
      transferAllowed: true,
      integrations: [
        { enabled: true, provider: "athenahealth", name: "athena", config: { practice_id: "195900" } },
      ],
    },
  },

  // Same appointment modules, NO EHR — exercises DB_APPOINTMENT_DECLARATIONS and
  // the non-EHR cancel/reschedule guidance with its identity-check paragraph.
  "appointments-db": {
    config: {
      businessName: "Acme Dental",
      greeting: "Thanks for calling Acme Dental.",
      timezone: "America/Chicago",
      businessHours: { open_time: "09:00", close_time: "17:00" },
      transferPhoneNumber: null,
      allowedTasks: normalizeAllowedTasks(["book_appointment", "cancel_reschedule"]),
      mainPhone: "555-1234",
      generalInfo: null,
      afterHoursPolicy: "offer_callback",
      transferPolicy: "never",
      languagesSpoken: ["en"],
      customInstructions: null,
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: false,
      integrations: [],
    },
  },

  // Intended as "core tasks only, no modules". It is NOT — and the snapshot
  // records that faithfully rather than hiding it.
  //
  // KNOWN DEFECT (pre-existing, captured deliberately): normalizeAllowedTasks
  // (services/supabase.js:61) treats an empty array and an unset value
  // identically, both falling back to DEFAULT_MODULE_TASKS = ["book_appointment"].
  // So this fixture still registers book_appointment, and there is currently NO
  // representable state meaning "this business does not do appointments" —
  // a blocker for any non-appointment SMB. migration 013 sets the column
  // default to '["book_appointment"]' as well.
  //
  // Not fixed here: Step A of the refactor is byte-identical behavior, so the
  // snapshot must capture today's output, defect included. Step B's explicit
  // per-capability `enabled` rows (database/020_business_capabilities.sql)
  // dissolve the unset-vs-empty ambiguity; this snapshot is expected to change
  // at that point, and that change is the fix landing.
  "messages-only": {
    config: {
      businessName: "Dave's Plumbing",
      greeting: "Dave's Plumbing, how can I help?",
      timezone: "America/New_York",
      businessHours: WEEKLY_HOURS,
      transferPhoneNumber: "+15559990000",
      allowedTasks: normalizeAllowedTasks([]),
      mainPhone: null,
      generalInfo: "Emergency callouts available 24/7.",
      afterHoursPolicy: "transfer_if_possible",
      transferPolicy: "always",
      languagesSpoken: ["en"],
      customInstructions: null,
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: true,
      integrations: [],
    },
  },

  // The non-appointment modules plus a custom webhook tool — exercises the
  // remaining CAPABILITIES branches and buildIntegrationTools' webhook path.
  "modules-and-webhook": {
    config: {
      businessName: "Northside Law",
      greeting: "Northside Law, how may I direct your call?",
      timezone: "America/Los_Angeles",
      businessHours: null,
      transferPhoneNumber: "+15557778888",
      allowedTasks: normalizeAllowedTasks([
        "quote_request",
        "directions_location",
        "form_document_request",
      ]),
      mainPhone: "555-4321",
      generalInfo: null,
      afterHoursPolicy: "book_later",
      transferPolicy: "business_hours_only",
      languagesSpoken: ["es"],
      customInstructions: "Never give legal advice. Always route to an attorney.",
    },
    extras: {
      knowledge: [],
      callerContext: null,
      transferAllowed: true,
      integrations: [
        {
          enabled: true,
          provider: "webhook",
          name: "open_case_file",
          config: {
            url: "https://example.test/hook",
            method: "POST",
            description: "Open a new case file in the practice management system.",
            params_schema: {
              type: "object",
              properties: { matter_type: { type: "string" } },
              required: ["matter_type"],
            },
          },
        },
      ],
    },
  },
};

// Every (step, intent) pair buildStepGuidance can branch on.
const STEP_INTENTS = [
  ["identify_intent", null],
  ["gather_details", "book_appointment"],
  ["gather_details", "cancel_reschedule"],
  ["gather_details", "take_message"],
  ["gather_details", "callback_request"],
  ["gather_details", "quote_request"],
  ["gather_details", "general_question"],
  ["confirm", null],
  ["ending", null],
];

const SNAP_DIR = "./__snapshots__/prompts";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("golden prompt snapshots — must not move during the capability-packs refactor", () => {
  for (const [name, { config, extras }] of Object.entries(FIXTURES)) {
    describe(name, () => {
      it("static system prefix is byte-identical", async () => {
        const prefix = buildStaticSystemPrefix(config, extras);
        await expect(prefix).toMatchFileSnapshot(`${SNAP_DIR}/${name}.static.txt`);
      });

      for (const [step, intent] of STEP_INTENTS) {
        const label = intent ? `${step}--${intent}` : step;

        it(`dynamic tail is byte-identical (${label})`, async () => {
          const tail = buildDynamicTail(step, intent, config, extras);
          await expect(tail).toMatchFileSnapshot(`${SNAP_DIR}/${name}.tail.${label}.txt`);
        });
      }

      it("tool declarations are byte-identical", async () => {
        // Assembled exactly as getReplyStreaming does (services/gemini.js:947-955)
        // so the snapshot covers the real merged tool list, not the pieces.
        const declarations = [
          ...(buildCallTools(config.allowedTasks).functionDeclarations || []),
          ...(buildIntegrationTools(extras.integrations).functionDeclarations || []),
          ...(buildDbAppointmentTools(config, extras).functionDeclarations || []),
        ];
        await expect(JSON.stringify(declarations, null, 2)).toMatchFileSnapshot(
          `${SNAP_DIR}/${name}.tools.json`
        );
      });
    });
  }
});

describe("prompt structure invariants the refactor must preserve", () => {
  const { config, extras } = FIXTURES["clinic-athena"];

  it("buildSystemInstruction is exactly prefix + blank line + tail", () => {
    // The capability prompt assembler must not change this join — the whole
    // caching strategy depends on the prefix being a stable leading substring.
    const full = buildSystemInstruction("gather_details", "book_appointment", config, extras);
    const prefix = buildStaticSystemPrefix(config, extras);
    const tail = buildDynamicTail("gather_details", "book_appointment", config, extras);

    expect(full).toBe(`${prefix}\n\n${tail}`);
    expect(full.startsWith(prefix)).toBe(true);
  });

  it("the static prefix is identical across every step and intent", () => {
    // Gemini implicit caching hits on a stable PREFIX. If a capability pack
    // leaks step- or intent-dependent text into the static half, cache hit
    // rate collapses and per-call cost/latency rise without any test failing
    // — so assert it directly.
    const baseline = buildStaticSystemPrefix(config, extras);
    for (const [step, intent] of STEP_INTENTS) {
      expect(buildStaticSystemPrefix(config, extras), `${step}/${intent}`).toBe(baseline);
    }
  });

  it("the static prefix carries no time-varying or step-varying markers", () => {
    const prefix = buildStaticSystemPrefix(config, extras);
    for (const marker of [
      "=== DATE AND TIME ===",
      "=== AFTER-HOURS BEHAVIOR ===",
      "=== CURRENT TASK AND STATE ===",
      "Step:",
      "gather_details",
      "identify_intent",
    ]) {
      expect(prefix, marker).not.toContain(marker);
    }
  });

  it("no fixture renders 'undefined' or 'null' into prompt text", () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const prefix = buildStaticSystemPrefix(fx.config, fx.extras);
      expect(prefix, `${name} prefix`).not.toContain("undefined");
      for (const [step, intent] of STEP_INTENTS) {
        const tail = buildDynamicTail(step, intent, fx.config, fx.extras);
        expect(tail, `${name} tail ${step}/${intent}`).not.toContain("undefined");
      }
    }
  });

  it("every declared tool has a unique name within a fixture", () => {
    // The registry in Step A resolves tool name -> owning capability, so a
    // duplicate name becomes a dispatch ambiguity rather than a harmless
    // shadow. Lock the invariant in now.
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const declarations = [
        ...(buildCallTools(fx.config.allowedTasks).functionDeclarations || []),
        ...(buildIntegrationTools(fx.extras.integrations).functionDeclarations || []),
        ...(buildDbAppointmentTools(fx.config, fx.extras).functionDeclarations || []),
      ];
      const names = declarations.map((d) => d.name);
      expect(new Set(names).size, `${name}: ${names.join(", ")}`).toBe(names.length);
    }
  });
});
