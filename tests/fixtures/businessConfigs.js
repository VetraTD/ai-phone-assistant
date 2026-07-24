/**
 * Shared business-config fixtures.
 *
 * Extracted verbatim from tests/promptSnapshot.test.js so more than one suite
 * (the golden prompt snapshots, and the text-session/eval harness) can drive the
 * REAL prompt builder and tool dispatch against the same set of representative
 * businesses. The values MUST NOT change: the prompt snapshots are byte-exact,
 * so any edit here would move a snapshot and mask a real prompt regression.
 *
 * FROZEN_NOW deliberately stays in promptSnapshot.test.js — it is a test concern
 * (the fake clock the dynamic tail renders against), not a property of a business.
 */

import { normalizeAllowedTasks } from "../../services/supabase.js";

export const WEEKLY_HOURS = {
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
export const FIXTURES = {
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

  // Core tasks only, no modules — and now it genuinely is.
  //
  // This fixture used to register book_appointment despite asking for nothing:
  // normalizeAllowedTasks treated an empty array and an unset value alike, both
  // defaulting to ["book_appointment"], so a business that does not do
  // appointments was unrepresentable. The snapshot captured that faithfully
  // rather than hiding it, and its change when the fix landed IS the evidence
  // the fix works: no appointment tool, no appointment clause in CAPABILITIES.
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

  // Appointments with availability ON, a built-in DOB requirement, and an
  // operator note — locks the check-first booking guidance, the
  // check_appointment_availability tool, and the CAPABILITY NOTES section.
  "appointments-availability": {
    config: {
      businessName: "Brightwork Family Dental",
      greeting: "Thanks for calling Brightwork Family Dental.",
      timezone: "America/Chicago",
      businessHours: WEEKLY_HOURS,
      transferPhoneNumber: "+15551230000",
      allowedTasks: normalizeAllowedTasks(["book_appointment", "check_appointment", "cancel_reschedule"]),
      mainPhone: "555-0100",
      generalInfo: null,
      afterHoursPolicy: "take_message",
      transferPolicy: "always",
      languagesSpoken: ["en"],
      customInstructions: null,
      capabilities: {
        appointments: {
          enabled: true,
          adapter: "internal",
          availability: { length: 30, capacity: 1 },
          require: { identity: { builtin: ["name", "dob"] } },
          notes: "Ask whether they are a new or existing patient first.",
        },
      },
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
      allowedTasks: normalizeAllowedTasks(["quote_request"]),
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
